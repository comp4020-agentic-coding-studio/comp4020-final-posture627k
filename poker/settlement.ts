// Pure heads-up settlement engine (Slice 4A). Computes a settlement PLAN
// from an authoritative terminal hand state — it never writes to SQLite,
// never publishes anything, and never mutates its input. Applying a plan
// exactly once, atomically, inside a database transaction is Slice 4B's
// job, not this module's.
//
// This module duplicates no rule: fold-vs-showdown determination comes
// entirely from the betting engine's own `handOutcome`/`uncontestedWinner`
// (poker/betting.ts), and showdown strength comes entirely from the
// existing seven-card evaluator and comparator (poker/hand-evaluator.ts).
// A client-declared winning hand is never accepted — the evaluator always
// recomputes it from the hole and community cards supplied.

import { assertValidCards, type Card } from "./cards.ts";
import type { HeadsUpBettingState, Seat } from "./betting.ts";
import { compareHands, evaluateSevenCardHand, type HandCategory } from "./hand-evaluator.ts";

export type SettlementOutcome = "fold" | "showdown";

export interface ShowdownDetail {
  readonly categoryBySeat: Readonly<Record<Seat, HandCategory>>;
  readonly categoryNameBySeat: Readonly<Record<Seat, string>>;
  // compareHands(seat 1's hand, seat 2's hand): positive = seat 1 wins,
  // negative = seat 2 wins, zero = tie. Suits are never consulted — see
  // poker/hand-evaluator.ts.
  readonly comparison: number;
}

export interface SettlementPlan {
  readonly outcome: SettlementOutcome;
  // One seat for a clear winner (fold or showdown), both seats for a tie.
  readonly winningSeats: readonly Seat[];
  // Each seat's own unmatched excess, returned to them — never awarded to
  // the opponent. Zero for a seat that didn't over-commit relative to the
  // other.
  readonly refunds: Readonly<Record<Seat, number>>;
  // The matched portion both seats actually contested: 2 * min(committedTotal).
  readonly contestedPot: number;
  // Amount of the contested pot paid to each seat (0 for a seat that won
  // none of it).
  readonly payouts: Readonly<Record<Seat, number>>;
  // = that seat's remaining (uncommitted) stack + their own refund + their
  // own payout. Never includes the opponent's refund.
  readonly finalStacks: Readonly<Record<Seat, number>>;
  readonly totalChipsBefore: number;
  readonly totalChipsAfter: number;
  readonly showdown?: ShowdownDetail;
}

export interface SettlementInput {
  readonly bettingState: HeadsUpBettingState;
  readonly holeCards: Readonly<Record<Seat, readonly [Card, Card]>>;
  // Exactly 5 for a showdown; ignored (but still validated as well-formed,
  // if present) for an uncontested fold, where no comparison ever happens.
  readonly communityCards: readonly Card[];
}

export type SettlementRejectionReason = "hand_not_terminal" | "invalid_cards" | "inconsistent_state";

export type SettleHandResult =
  | { readonly ok: true; readonly plan: SettlementPlan }
  | { readonly ok: false; readonly reason: SettlementRejectionReason };

// A hand is ready for settlement only once no further betting can ever
// happen: either someone has already folded (handOutcome "uncontested"),
// or betting is complete and the river has actually been reached — not
// merely "runout_required" with earlier streets never dealt out, which is
// Slice 4B's job (running out remaining streets), not this one's.
function isTerminal(state: HeadsUpBettingState): boolean {
  return state.handOutcome === "uncontested" || (state.isBettingComplete && state.street === "river");
}

export function settleHand(input: SettlementInput): SettleHandResult {
  const { bettingState, holeCards, communityCards } = input;

  if (!isTerminal(bettingState)) {
    return { ok: false, reason: "hand_not_terminal" };
  }

  const seat1 = bettingState.seats[1];
  const seat2 = bettingState.seats[2];

  if (seat1.stack < 0 || seat2.stack < 0 || seat1.committedTotal < 0 || seat2.committedTotal < 0) {
    return { ok: false, reason: "inconsistent_state" };
  }

  if (bettingState.handOutcome === "uncontested") {
    const exactlyOneFolded = seat1.folded !== seat2.folded;
    if (!exactlyOneFolded || bettingState.uncontestedWinner === null) {
      return { ok: false, reason: "inconsistent_state" };
    }
  }

  // Validate every card supplied in one pass: each hole-card pair must have
  // exactly 2 cards, each card must be well-formed, and no card may repeat
  // across either hole-card pair or the board — whether or not a showdown
  // actually happens, malformed input is refused rather than silently
  // tolerated because "it wasn't needed this time."
  if (holeCards[1].length !== 2 || holeCards[2].length !== 2) {
    return { ok: false, reason: "invalid_cards" };
  }
  const allSuppliedCards: unknown[] = [...holeCards[1], ...holeCards[2], ...communityCards];
  try {
    assertValidCards(allSuppliedCards, allSuppliedCards.length);
  } catch {
    return { ok: false, reason: "invalid_cards" };
  }

  const totalChipsBefore = seat1.stack + seat1.committedTotal + seat2.stack + seat2.committedTotal;

  const contestedPot = 2 * Math.min(seat1.committedTotal, seat2.committedTotal);
  const refunds: Record<Seat, number> = { 1: 0, 2: 0 };
  if (seat1.committedTotal > seat2.committedTotal) {
    refunds[1] = seat1.committedTotal - seat2.committedTotal;
  } else if (seat2.committedTotal > seat1.committedTotal) {
    refunds[2] = seat2.committedTotal - seat1.committedTotal;
  }

  const payouts: Record<Seat, number> = { 1: 0, 2: 0 };
  let outcome: SettlementOutcome;
  let winningSeats: Seat[];
  let showdown: ShowdownDetail | undefined;

  if (bettingState.handOutcome === "uncontested") {
    outcome = "fold";
    const winner = bettingState.uncontestedWinner as Seat;
    winningSeats = [winner];
    payouts[winner] = contestedPot;
  } else {
    if (communityCards.length !== 5) {
      return { ok: false, reason: "invalid_cards" };
    }
    outcome = "showdown";
    const hand1 = evaluateSevenCardHand([...holeCards[1], ...communityCards]);
    const hand2 = evaluateSevenCardHand([...holeCards[2], ...communityCards]);
    const comparison = compareHands(hand1, hand2);
    showdown = {
      categoryBySeat: { 1: hand1.category, 2: hand2.category },
      categoryNameBySeat: { 1: hand1.categoryName, 2: hand2.categoryName },
      comparison,
    };

    if (comparison > 0) {
      winningSeats = [1];
      payouts[1] = contestedPot;
    } else if (comparison < 0) {
      winningSeats = [2];
      payouts[2] = contestedPot;
    } else {
      winningSeats = [1, 2];
      // contestedPot = 2 * min(...) is always even by construction, so
      // this split is always an exact integer in heads-up — odd-chip
      // multiway splitting remains explicitly out of scope (P1).
      const half = contestedPot / 2;
      payouts[1] = half;
      payouts[2] = half;
    }
  }

  const finalStacks: Record<Seat, number> = {
    1: seat1.stack + refunds[1] + payouts[1],
    2: seat2.stack + refunds[2] + payouts[2],
  };
  const totalChipsAfter = finalStacks[1] + finalStacks[2];

  return {
    ok: true,
    plan: { outcome, winningSeats, refunds, contestedPot, payouts, finalStacks, totalChipsBefore, totalChipsAfter, showdown },
  };
}
