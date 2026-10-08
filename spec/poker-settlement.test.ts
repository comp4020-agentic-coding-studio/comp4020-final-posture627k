import { describe, expect, it } from "vitest";
import type { Card } from "../poker/cards.ts";
import {
  advanceToNextStreet,
  applyBettingAction,
  initializeHeadsUpBetting,
  type HeadsUpBettingState,
  type Seat,
} from "../poker/betting.ts";
import { evaluateSevenCardHand, HAND_CATEGORY } from "../poker/hand-evaluator.ts";
import { settleHand, type SettlementInput } from "../poker/settlement.ts";

function c(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

// A generic, unused-in-comparison pair of hole cards for each seat, plus a
// generic unused board — valid, non-overlapping, well-formed, but
// deliberately irrelevant to any specific showdown outcome. Used for fold
// tests where no comparison ever happens.
const FILLER_HOLE_CARDS: Record<Seat, readonly [Card, Card]> = {
  1: [c(2, "clubs"), c(3, "clubs")],
  2: [c(4, "diamonds"), c(5, "diamonds")],
};
const FILLER_BOARD: Card[] = [c(6, "hearts"), c(7, "hearts"), c(8, "hearts"), c(9, "spades"), c(10, "spades")];

function standardStart(overrides?: { buttonSeat?: Seat; stacks?: Record<Seat, number> }): HeadsUpBettingState {
  return initializeHeadsUpBetting({
    buttonSeat: overrides?.buttonSeat ?? 1,
    smallBlind: 5,
    bigBlind: 10,
    stacks: overrides?.stacks ?? { 1: 1000, 2: 1000 },
  });
}

// Reaches a genuine river-complete, non-folded, EVEN-commitment terminal
// state through real betting engine actions: both raise/call to `amount`
// preflop, then check through every remaining street.
function playToRiverEvenCommitment(amount: number, stacks?: Record<Seat, number>): HeadsUpBettingState {
  let state = standardStart({ stacks });
  state = applyBettingAction(state, 1, { type: "raise", amount }).state;
  state = applyBettingAction(state, 2, { type: "call" }).state;
  state = advanceToNextStreet(state, "flop");
  state = applyBettingAction(state, 2, { type: "check" }).state;
  state = applyBettingAction(state, 1, { type: "check" }).state;
  state = advanceToNextStreet(state, "turn");
  state = applyBettingAction(state, 2, { type: "check" }).state;
  state = applyBettingAction(state, 1, { type: "check" }).state;
  state = advanceToNextStreet(state, "river");
  state = applyBettingAction(state, 2, { type: "check" }).state;
  state = applyBettingAction(state, 1, { type: "check" }).state;
  return state;
}

function foldState(): HeadsUpBettingState {
  const state = standardStart();
  const result = applyBettingAction(state, 1, { type: "fold" });
  if (!result.ok) throw new Error("setup failed");
  return result.state;
}

// Terminal settlement math only cares about each seat's final stack and
// committedTotal — not how exactly those numbers were reached. Several
// fixtures below specify numbers (see the brief's own worked example) that
// are clearest to express as a direct, hand-built terminal state rather
// than forcing a specific legal betting sequence to land on them exactly.
function buildTerminalState(params: {
  committed: Record<Seat, number>;
  stacks: Record<Seat, number>;
  outcome?: "showdown" | { foldedSeat: Seat };
}): HeadsUpBettingState {
  const base = standardStart({ stacks: { 1: 100000, 2: 100000 } });
  const folded: Record<Seat, boolean> =
    typeof params.outcome === "object"
      ? { 1: params.outcome.foldedSeat === 1, 2: params.outcome.foldedSeat === 2 }
      : { 1: false, 2: false };

  return {
    ...base,
    street: "river",
    isBettingComplete: true,
    actingSeat: null,
    handOutcome: folded[1] || folded[2] ? "uncontested" : "in_progress",
    uncontestedWinner: folded[1] ? 2 : folded[2] ? 1 : null,
    uncalledExcess: null,
    seats: {
      1: {
        ...base.seats[1],
        stack: params.stacks[1],
        committedThisStreet: 0,
        committedTotal: params.committed[1],
        folded: folded[1],
        hasActedThisStreet: true,
      },
      2: {
        ...base.seats[2],
        stack: params.stacks[2],
        committedThisStreet: 0,
        committedTotal: params.committed[2],
        folded: folded[2],
        hasActedThisStreet: true,
      },
    },
  };
}

function settle(input: SettlementInput) {
  return settleHand(input);
}

// --- 1. Fold: Small Blind folds after posting 5; Big Blind posted 10 -------

it("1. small blind folds after posting 5; big blind posted 10 — final SB 995, BB 1005", () => {
  const bettingState = foldState();
  const result = settle({ bettingState, holeCards: FILLER_HOLE_CARDS, communityCards: [] });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.outcome).toBe("fold");
  expect(result.plan.winningSeats).toEqual([2]);
  expect(result.plan.finalStacks).toEqual({ 1: 995, 2: 1005 });
});

// --- 2/3/4. Even 100/100 commitment, showdown win/win/tie ------------------

// Board makes nothing; seat 1's pocket pair of aces plus the board's kings
// gives seat 1 two pair, aces up — stronger than seat 2's unpaired hand.
const EVEN_BOARD: Card[] = [c(13, "clubs"), c(13, "diamonds"), c(9, "hearts"), c(4, "spades"), c(2, "clubs")];
const SEAT1_WINS_HOLE: Record<Seat, readonly [Card, Card]> = {
  1: [c(14, "hearts"), c(14, "spades")], // pocket aces -> two pair, aces and kings
  2: [c(7, "clubs"), c(6, "diamonds")], // no pair -> kings up, high card only
};

it("2. both commit 100; A (seat 1) wins showdown — final A 1100, B 900", () => {
  const bettingState = playToRiverEvenCommitment(100);
  const result = settle({ bettingState, holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.outcome).toBe("showdown");
  expect(result.plan.winningSeats).toEqual([1]);
  expect(result.plan.finalStacks).toEqual({ 1: 1100, 2: 900 });
});

it("3. both commit 100; B (seat 2) wins showdown — final A 900, B 1100", () => {
  const bettingState = playToRiverEvenCommitment(100);
  // Swap which seat holds the winning cards.
  const holeCards: Record<Seat, readonly [Card, Card]> = {
    1: SEAT1_WINS_HOLE[2],
    2: SEAT1_WINS_HOLE[1],
  };
  const result = settle({ bettingState, holeCards, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.outcome).toBe("showdown");
  expect(result.plan.winningSeats).toEqual([2]);
  expect(result.plan.finalStacks).toEqual({ 1: 900, 2: 1100 });
});

it("4. both commit 100; exact showdown tie — final A 1000, B 1000", () => {
  const bettingState = playToRiverEvenCommitment(100);
  // Board plays as a straight for both; neither hole card improves it, and
  // the hole cards themselves share no rank with each other or the board.
  const tieBoard: Card[] = [c(14, "spades"), c(13, "spades"), c(12, "spades"), c(11, "spades"), c(10, "spades")];
  const holeCards: Record<Seat, readonly [Card, Card]> = {
    1: [c(2, "clubs"), c(3, "diamonds")],
    2: [c(4, "hearts"), c(5, "clubs")],
  };
  const result = settle({ bettingState, holeCards, communityCards: tieBoard });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.outcome).toBe("showdown");
  expect(result.plan.winningSeats).toEqual([1, 2]);
  expect(result.plan.finalStacks).toEqual({ 1: 1000, 2: 1000 });
  expect(result.plan.showdown?.comparison).toBe(0);
});

// --- 5/6. Uneven 100/300 commitment ------------------------------------

it("5. A commits 100, B commits 300; A wins — B refunded 200, contested 200, final A 1100, B 900", () => {
  const bettingState = buildTerminalState({
    committed: { 1: 100, 2: 300 },
    stacks: { 1: 900, 2: 700 },
    outcome: "showdown",
  });
  const result = settle({ bettingState, holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.refunds).toEqual({ 1: 0, 2: 200 });
  expect(result.plan.contestedPot).toBe(200);
  expect(result.plan.winningSeats).toEqual([1]);
  expect(result.plan.finalStacks).toEqual({ 1: 1100, 2: 900 });
});

it("6. same commitments (100/300); B wins — B refunded 200 plus 200 contested, final A 900, B 1100", () => {
  const bettingState = buildTerminalState({
    committed: { 1: 100, 2: 300 },
    stacks: { 1: 900, 2: 700 },
    outcome: "showdown",
  });
  const holeCards: Record<Seat, readonly [Card, Card]> = {
    1: SEAT1_WINS_HOLE[2],
    2: SEAT1_WINS_HOLE[1],
  };
  const result = settle({ bettingState, holeCards, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.refunds).toEqual({ 1: 0, 2: 200 });
  expect(result.plan.payouts).toEqual({ 1: 0, 2: 200 });
  expect(result.plan.finalStacks).toEqual({ 1: 900, 2: 1100 });
});

// --- 7. Uneven commitment accumulated across multiple streets --------------

it("7. uneven final commitments from a multi-street sequence: refund reflects the TOTAL, not just the last street", () => {
  // Seat 1 is short-stacked (50 chips) and ends up all-in on the turn for
  // less than seat 2's full bet; seat 2's excess accumulates across
  // preflop + flop + turn, not just the turn bet alone.
  let state = standardStart({ stacks: { 1: 50, 2: 1000 } });
  state = applyBettingAction(state, 1, { type: "call" }).state; // seat 1 to 10 total
  state = applyBettingAction(state, 2, { type: "check" }).state; // preflop complete, both at 10
  let flop = advanceToNextStreet(state, "flop");
  state = applyBettingAction(flop, 2, { type: "bet", amount: 20 }).state; // seat 2 to 30 total
  state = applyBettingAction(state, 1, { type: "call" }).state; // seat 1 to 30 total, flop complete
  const turn = advanceToNextStreet(state, "turn");
  state = applyBettingAction(turn, 2, { type: "bet", amount: 30 }).state; // seat 2 to 60 total
  const shortCall = applyBettingAction(state, 1, { type: "all_in" }); // seat 1 can only go to 50 total
  expect(shortCall.ok).toBe(true);
  if (!shortCall.ok) return;
  state = shortCall.state;

  expect(state.seats[1].committedTotal).toBe(50);
  expect(state.seats[2].committedTotal).toBe(60);
  expect(state.handOutcome).toBe("runout_required");

  // Force the street pointer to the river (Slice 4B's job in reality; here
  // only to exercise settlement's own terminal-state acceptance).
  const river = advanceToNextStreet(state, "river");

  const result = settle({ bettingState: river, holeCards: FILLER_HOLE_CARDS, communityCards: FILLER_BOARD });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.refunds).toEqual({ 1: 0, 2: 10 }); // 60 - 50, not just the turn's 30 vs 20
  expect(result.plan.contestedPot).toBe(100); // 2 * min(50, 60)
});

// --- 8. Fold: no hand comparison required -----------------------------------

it("8. winner by fold requires no hand comparison", () => {
  const bettingState = foldState();
  const result = settle({ bettingState, holeCards: FILLER_HOLE_CARDS, communityCards: [] });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.outcome).toBe("fold");
  expect(result.plan.showdown).toBeUndefined();
});

// --- 9. Both players play the board and tie ---------------------------------

it("9. both players play the board and tie", () => {
  const bettingState = playToRiverEvenCommitment(100);
  const board: Card[] = [c(14, "spades"), c(13, "spades"), c(12, "spades"), c(11, "spades"), c(10, "spades")]; // royal flush on board
  const holeCards: Record<Seat, readonly [Card, Card]> = {
    1: [c(2, "clubs"), c(3, "diamonds")],
    2: [c(4, "hearts"), c(5, "clubs")],
  };
  const result = settle({ bettingState, holeCards, communityCards: board });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.showdown?.categoryBySeat).toEqual({
    1: HAND_CATEGORY.STRAIGHT_FLUSH,
    2: HAND_CATEGORY.STRAIGHT_FLUSH,
  });
  expect(result.plan.winningSeats).toEqual([1, 2]);
});

// --- 10. Ace-low straight vs higher straight --------------------------------

it("10. an ace-low straight loses to a higher straight", () => {
  const bettingState = playToRiverEvenCommitment(100);
  // Board: 3,4,5 plus two isolated kickers that extend no straight further.
  // Seat 1 (A,2) makes the wheel (A-2-3-4-5, 5-high); seat 2 (6,7) makes
  // 3-4-5-6-7 (7-high) — the highest straight available to either hand.
  const board: Card[] = [c(3, "clubs"), c(4, "diamonds"), c(5, "hearts"), c(11, "spades"), c(12, "clubs")];
  const holeCards: Record<Seat, readonly [Card, Card]> = {
    1: [c(14, "hearts"), c(2, "spades")], // wheel: A-2-3-4-5, 5-high
    2: [c(6, "diamonds"), c(7, "hearts")], // 3-4-5-6-7, 7-high
  };
  const result = settle({ bettingState, holeCards, communityCards: board });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.showdown?.categoryBySeat[1]).toBe(HAND_CATEGORY.STRAIGHT);
  expect(result.plan.showdown?.categoryBySeat[2]).toBe(HAND_CATEGORY.STRAIGHT);
  expect(result.plan.winningSeats).toEqual([2]);
});

// --- 11. Flush beats straight ------------------------------------------------

it("11. a flush beats a straight", () => {
  const bettingState = playToRiverEvenCommitment(100);
  const board: Card[] = [c(2, "hearts"), c(4, "hearts"), c(9, "hearts"), c(5, "clubs"), c(7, "clubs")];
  const holeCards: Record<Seat, readonly [Card, Card]> = {
    1: [c(10, "hearts"), c(13, "hearts")], // flush: 2,4,9,10,13 of hearts
    2: [c(6, "diamonds"), c(8, "spades")], // straight: 4-5-6-7-8... wait uses board 4,5,7 + 6,8
  };
  const result = settle({ bettingState, holeCards, communityCards: board });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.showdown?.categoryBySeat[1]).toBe(HAND_CATEGORY.FLUSH);
  expect(result.plan.showdown?.categoryBySeat[2]).toBe(HAND_CATEGORY.STRAIGHT);
  expect(result.plan.winningSeats).toEqual([1]);
});

// --- 12. Full House vs Full House, correct triplet comparison ---------------

it("12. full house vs full house: the higher triplet wins", () => {
  const bettingState = playToRiverEvenCommitment(100);
  // Board gives one pair of each of two ranks; seat 1 trips up nines using
  // the board's pair of fives, seat 2 trips up fives using the board's
  // pair of nines — each player's triplet comes from a different rank.
  const board: Card[] = [c(9, "clubs"), c(9, "diamonds"), c(5, "hearts"), c(5, "spades"), c(2, "clubs")];
  const holeCards: Record<Seat, readonly [Card, Card]> = {
    1: [c(9, "hearts"), c(3, "clubs")], // nines full of fives
    2: [c(5, "clubs"), c(4, "diamonds")], // fives full of nines
  };
  const result = settle({ bettingState, holeCards, communityCards: board });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.showdown?.categoryBySeat[1]).toBe(HAND_CATEGORY.FULL_HOUSE);
  expect(result.plan.showdown?.categoryBySeat[2]).toBe(HAND_CATEGORY.FULL_HOUSE);
  expect(result.plan.winningSeats).toEqual([1]); // nines full beats fives full
});

// --- 13. Zero unmatched excess ----------------------------------------------

it("13. zero unmatched excess when commitments are equal", () => {
  const bettingState = playToRiverEvenCommitment(250);
  const result = settle({ bettingState, holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.refunds).toEqual({ 1: 0, 2: 0 });
});

// --- 14. One player has zero remaining stack (all-in) -----------------------

it("14. a player with zero remaining stack (all-in) settles correctly", () => {
  let state = standardStart({ stacks: { 1: 150, 2: 150 } });
  state = applyBettingAction(state, 1, { type: "all_in" }).state; // seat 1 all-in for 150
  const result1 = applyBettingAction(state, 2, { type: "all_in" }); // seat 2 all-in for 150
  expect(result1.ok).toBe(true);
  if (!result1.ok) return;
  state = result1.state;
  expect(state.seats[1].stack).toBe(0);
  expect(state.seats[2].stack).toBe(0);
  const river = advanceToNextStreet(state, "river");

  const result = settle({ bettingState: river, holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.finalStacks[1]).toBe(300); // won the whole 300-chip contested pot
  expect(result.plan.finalStacks[2]).toBe(0);
});

// --- 15/16. Chip conservation and non-negative stacks -----------------------

it("15. no chip is created or destroyed across every fixture above", () => {
  const fixtures: SettlementInput[] = [
    { bettingState: foldState(), holeCards: FILLER_HOLE_CARDS, communityCards: [] },
    { bettingState: playToRiverEvenCommitment(100), holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD },
    {
      bettingState: buildTerminalState({ committed: { 1: 100, 2: 300 }, stacks: { 1: 900, 2: 700 }, outcome: "showdown" }),
      holeCards: SEAT1_WINS_HOLE,
      communityCards: EVEN_BOARD,
    },
  ];
  for (const input of fixtures) {
    const result = settle(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.totalChipsAfter).toBe(result.plan.totalChipsBefore);
    }
  }
});

it("16. no final stack is ever negative", () => {
  const bettingState = buildTerminalState({
    committed: { 1: 1000, 2: 1000 },
    stacks: { 1: 0, 2: 0 },
    outcome: "showdown",
  });
  const result = settle({ bettingState, holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.finalStacks[1]).toBeGreaterThanOrEqual(0);
  expect(result.plan.finalStacks[2]).toBeGreaterThanOrEqual(0);
});

// --- 17/18. Invalid input rejected ------------------------------------------

it("17. an invalid card count is rejected", () => {
  const bettingState = playToRiverEvenCommitment(100);
  const result = settle({
    bettingState,
    holeCards: SEAT1_WINS_HOLE,
    communityCards: EVEN_BOARD.slice(0, 4), // only 4 community cards, not 5
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("invalid_cards");
});

it("18. a duplicate card across hole cards and the board is rejected", () => {
  const bettingState = playToRiverEvenCommitment(100);
  const dupHoleCards: Record<Seat, readonly [Card, Card]> = {
    1: [c(13, "clubs"), c(14, "hearts")], // 13 clubs collides with the board
    2: [c(7, "clubs"), c(6, "diamonds")],
  };
  const result = settle({ bettingState, holeCards: dupHoleCards, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("invalid_cards");
});

// --- 19. Nonterminal hand rejected -------------------------------------------

it("19. a nonterminal hand is rejected", () => {
  const bettingState = standardStart(); // preflop, nobody has acted yet
  const result = settle({ bettingState, holeCards: FILLER_HOLE_CARDS, communityCards: [] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("hand_not_terminal");
});

// --- 20/21. Purity ------------------------------------------------------------

it("20. settlement does not mutate its input", () => {
  const bettingState = playToRiverEvenCommitment(100);
  const input: SettlementInput = { bettingState, holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD };
  const before = JSON.parse(JSON.stringify(input));
  settle(input);
  expect(JSON.parse(JSON.stringify(input))).toEqual(before);
});

it("21. repeated calculation of the same input produces the same plan", () => {
  const bettingState = playToRiverEvenCommitment(100);
  const input: SettlementInput = { bettingState, holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD };
  const first = settle(input);
  const second = settle(input);
  expect(first).toEqual(second);
});

// --- 22. Consistency with the existing evaluator ----------------------------

it("22. settlement's showdown category matches an independent call to the evaluator", () => {
  const bettingState = playToRiverEvenCommitment(100);
  const result = settle({ bettingState, holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const independent1 = evaluateSevenCardHand([...SEAT1_WINS_HOLE[1], ...EVEN_BOARD]);
  const independent2 = evaluateSevenCardHand([...SEAT1_WINS_HOLE[2], ...EVEN_BOARD]);
  expect(result.plan.showdown?.categoryBySeat[1]).toBe(independent1.category);
  expect(result.plan.showdown?.categoryBySeat[2]).toBe(independent2.category);
});

// --- Final audit regressions (Phase A) --------------------------------------

it("audit: an unresolved all-in runout (board not yet fully dealt) is rejected as nonterminal", () => {
  // Both players are all-in, so no further betting is possible, but the
  // street is still "flop" — the remaining board has not been run out yet.
  // Settlement must refuse this, not confuse "no more betting possible"
  // with "the hand is actually over."
  let state = standardStart({ stacks: { 1: 150, 2: 150 } });
  state = applyBettingAction(state, 1, { type: "all_in" }).state;
  const result1 = applyBettingAction(state, 2, { type: "all_in" });
  expect(result1.ok).toBe(true);
  if (!result1.ok) return;
  state = advanceToNextStreet(result1.state, "flop");
  expect(state.handOutcome).toBe("runout_required");
  expect(state.street).toBe("flop"); // NOT river yet

  const result = settle({ bettingState: state, holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("hand_not_terminal");
});

it("audit: a duplicate hole card between the two players (not involving the board) is rejected", () => {
  const bettingState = playToRiverEvenCommitment(100);
  const collidingHoleCards: Record<Seat, readonly [Card, Card]> = {
    1: [c(14, "hearts"), c(14, "spades")],
    2: [c(14, "hearts"), c(6, "diamonds")], // 14 hearts also held by seat 1
  };
  // Each player's own 7-card set (hole + board) is individually well-formed
  // (no internal duplicate within either player's own cards), but the two
  // hole-card pairs collide with each other — this must still be rejected.
  const result = settle({ bettingState, holeCards: collidingHoleCards, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("invalid_cards");
});

it("audit: finalStacks sum exactly equals remainingStacks sum plus committedTotal sum", () => {
  const bettingState = buildTerminalState({
    committed: { 1: 100, 2: 300 },
    stacks: { 1: 900, 2: 700 },
    outcome: "showdown",
  });
  const result = settle({ bettingState, holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const remainingStacksSum = bettingState.seats[1].stack + bettingState.seats[2].stack;
  const committedTotalSum = bettingState.seats[1].committedTotal + bettingState.seats[2].committedTotal;
  const finalStacksSum = result.plan.finalStacks[1] + result.plan.finalStacks[2];
  expect(finalStacksSum).toBe(remainingStacksSum + committedTotalSum);
});

it("audit: every final stack is a nonnegative integer", () => {
  const fixtures: SettlementInput[] = [
    { bettingState: foldState(), holeCards: FILLER_HOLE_CARDS, communityCards: [] },
    { bettingState: playToRiverEvenCommitment(100), holeCards: SEAT1_WINS_HOLE, communityCards: EVEN_BOARD },
    {
      bettingState: buildTerminalState({ committed: { 1: 100, 2: 300 }, stacks: { 1: 900, 2: 700 }, outcome: "showdown" }),
      holeCards: SEAT1_WINS_HOLE,
      communityCards: EVEN_BOARD,
    },
  ];
  for (const input of fixtures) {
    const result = settle(input);
    expect(result.ok).toBe(true);
    if (!result.ok) continue;
    for (const seat of [1, 2] as const) {
      expect(Number.isInteger(result.plan.finalStacks[seat])).toBe(true);
      expect(result.plan.finalStacks[seat]).toBeGreaterThanOrEqual(0);
    }
  }
});
