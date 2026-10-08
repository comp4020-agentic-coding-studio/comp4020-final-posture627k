import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cardKey, type Card } from "../poker/cards.ts";
import { createDeck } from "../poker/deck.ts";

// Integration tests for the full Slice 4B hand lifecycle: automatic street
// progression, all-in runouts, and atomic settlement — built on real
// isolated SQLite databases (like spec/poker-persistence.test.ts), with
// deterministic fixed decks (via createPokerHand's test-only overrideDeck
// parameter) wherever a specific showdown outcome needs to be reproducible.

let tempDir: string;
let previousDataDir: string | undefined;
let db: typeof import("../db.ts");

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "poker-lifecycle-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("../db.ts");
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

async function reopen(): Promise<typeof import("../db.ts")> {
  vi.resetModules();
  return import("../db.ts");
}

function c(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

// Places `firstCards` at the front of a full 52-card deck (filling the rest
// with every other card in a fixed order) — every one of the 52 cards is
// still present exactly once, but the dealt portion (hole cards + board,
// per the documented deck-slot convention) is fully deterministic.
function buildFixedDeck(firstCards: Card[]): Card[] {
  const used = new Set(firstCards.map(cardKey));
  const rest = createDeck().filter((card) => !used.has(cardKey(card)));
  return [...firstCards, ...rest];
}

// Seat 1 (button) gets pocket aces; seat 2 gets weak, unpaired cards. The
// board (13c,13d,9h,4s,2c) pairs kings for both, but seat 1's aces make two
// pair (aces up) against seat 2's one pair of kings.
const SEAT1_WINS_DECK = buildFixedDeck([
  c(14, "hearts"),
  c(14, "spades"), // seat 1 hole
  c(7, "clubs"),
  c(6, "diamonds"), // seat 2 hole
  c(13, "clubs"),
  c(13, "diamonds"),
  c(9, "hearts"), // flop
  c(4, "spades"), // turn
  c(2, "clubs"), // river
]);

// Board alone is a royal flush; neither hole pair improves on it, so both
// players tie by playing the board.
const TIE_DECK = buildFixedDeck([
  c(2, "clubs"),
  c(3, "diamonds"), // seat 1 hole (irrelevant)
  c(4, "hearts"),
  c(5, "clubs"), // seat 2 hole (irrelevant)
  c(14, "spades"),
  c(13, "spades"),
  c(12, "spades"), // flop
  c(11, "spades"), // turn
  c(10, "spades"), // river
]);

function setUpReadyTable(
  instance: typeof import("../db.ts"),
): { tableId: number; hostIdentityId: number; guestIdentityId: number } {
  const host = instance.createIdentity(instance.hashToken(`host-${Math.random()}`));
  const guest = instance.createIdentity(instance.hashToken(`guest-${Math.random()}`));
  const table = instance.createPokerTable(host.id);
  const join = instance.joinPokerTable(table.id, guest.id);
  expect(join.ok).toBe(true);
  return { tableId: table.id, hostIdentityId: host.id, guestIdentityId: guest.id };
}

function setChipStack(tableId: number, seatNumber: 1 | 2, amount: number): void {
  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  raw.prepare("UPDATE poker_seats SET chip_stack = ? WHERE table_id = ? AND seat_number = ?").run(
    amount,
    tableId,
    seatNumber,
  );
  raw.close();
}

function totalBankroll(tableId: number, instance: typeof import("../db.ts") = db): number {
  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const rows = raw.prepare("SELECT chip_stack FROM poker_seats WHERE table_id = ?").all(tableId) as {
    chip_stack: number;
  }[];
  raw.close();
  void instance;
  return rows.reduce((sum, r) => sum + r.chip_stack, 0);
}

// --- 1. A full hand can start and finish ------------------------------------

it("1. a full hand can start and finish (fold to settlement)", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const result = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "fold" },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.hand.status).toBe("settled");
});

// --- 2. Preflop completes only after the Big Blind's legitimate option -----

it("2. preflop completes only after the big blind's legitimate option", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const afterCall = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  expect(afterCall.ok).toBe(true);
  if (!afterCall.ok) return;
  expect(afterCall.hand.street).toBe("preflop"); // not advanced yet: BB still has the option
  expect(afterCall.hand.bettingState.actingSeat).toBe(2);

  const afterCheck = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r2",
    expectedVersion: afterCall.hand.version,
    action: { type: "check" },
  });
  expect(afterCheck.ok).toBe(true);
  if (!afterCheck.ok) return;
  expect(afterCheck.hand.street).toBe("flop"); // now it advances
});

// --- 3/4. Flop/Turn/River reveal expected cards; postflop order ------------

it("3/4. flop/turn/river reveal the expected persisted cards in correct postflop order", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  let hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  expect(hand.ok).toBe(true);
  if (!hand.ok) return;
  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r2",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  expect(hand.ok).toBe(true);
  if (!hand.ok) return;

  expect(hand.hand.street).toBe("flop");
  expect(hand.hand.bettingState.actingSeat).toBe(2); // big blind acts first postflop
  expect(db.getCommunityCards(created.hand.id)).toEqual([c(13, "clubs"), c(13, "diamonds"), c(9, "hearts")]);

  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r3",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  if (!hand.ok) return;
  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r4",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  if (!hand.ok) return;

  expect(hand.hand.street).toBe("turn");
  expect(db.getCommunityCards(created.hand.id)).toEqual([
    c(13, "clubs"),
    c(13, "diamonds"),
    c(9, "hearts"),
    c(4, "spades"),
  ]);

  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r5",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  if (!hand.ok) return;
  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r6",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  if (!hand.ok) return;

  expect(hand.hand.street).toBe("river");
  expect(db.getCommunityCards(created.hand.id)).toEqual([
    c(13, "clubs"),
    c(13, "diamonds"),
    c(9, "hearts"),
    c(4, "spades"),
    c(2, "clubs"),
  ]);
});

// --- 5/6/13. Street transitions preserve commitments; river triggers settlement; showdown A wins ---

it("5/6/13. street transitions preserve total commitments; the final river action triggers settlement; seat 1 wins showdown", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const totalBefore =
    created.hand.bettingState.seats[1].stack +
    created.hand.bettingState.seats[1].committedTotal +
    created.hand.bettingState.seats[2].stack +
    created.hand.bettingState.seats[2].committedTotal;

  let hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  if (!hand.ok) return;
  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r2",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  if (!hand.ok) return;
  const committedAfterPreflop = hand.hand.bettingState.seats[1].committedTotal + hand.hand.bettingState.seats[2].committedTotal;

  for (const [reqA, reqB] of [
    ["r3", "r4"],
    ["r5", "r6"],
    ["r7", "r8"],
  ] as const) {
    hand = db.submitBettingAction({
      handId: created.hand.id,
      identityId: guestIdentityId,
      requestId: reqA,
      expectedVersion: hand.ok ? hand.hand.version : 0,
      action: { type: "check" },
    });
    if (!hand.ok) return;
    hand = db.submitBettingAction({
      handId: created.hand.id,
      identityId: hostIdentityId,
      requestId: reqB,
      expectedVersion: hand.hand.version,
      action: { type: "check" },
    });
    if (!hand.ok) return;
    // Each street adds no new chips when both only check — total
    // commitment is preserved exactly across every transition.
    expect(hand.hand.bettingState.seats[1].committedTotal + hand.hand.bettingState.seats[2].committedTotal).toBe(
      committedAfterPreflop,
    );
  }

  // The final river check triggered showdown and settlement automatically.
  expect(hand.hand.status).toBe("settled");
  const totalAfter =
    hand.hand.bettingState.seats[1].stack +
    hand.hand.bettingState.seats[1].committedTotal +
    hand.hand.bettingState.seats[2].stack +
    hand.hand.bettingState.seats[2].committedTotal;
  expect(totalAfter).toBe(totalBefore);

  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const seats = raw.prepare("SELECT seat_number, chip_stack FROM poker_seats WHERE table_id = ? ORDER BY seat_number").all(
    tableId,
  ) as { seat_number: number; chip_stack: number }[];
  raw.close();
  expect(seats.find((s) => s.seat_number === 1)?.chip_stack).toBeGreaterThan(1000); // seat 1 (aces) won
  expect(seats.find((s) => s.seat_number === 2)?.chip_stack).toBeLessThan(1000);
});

// --- 7/8. Fold settles immediately on any street ----------------------------

it("7. fold on preflop settles immediately", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  if (!created.ok) return;
  const result = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "fold" },
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.hand.status).toBe("settled");
});

it("8. fold on the flop settles immediately", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  if (!created.ok) return;
  let hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  if (!hand.ok) return;
  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r2",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  if (!hand.ok) return;
  expect(hand.hand.street).toBe("flop");

  const folded = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r3",
    expectedVersion: hand.hand.version,
    action: { type: "fold" },
  });
  expect(folded.ok).toBe(true);
  if (folded.ok) {
    expect(folded.hand.status).toBe("settled");
    expect(folded.hand.bettingState.uncontestedWinner).toBe(1);
  }
});

// --- 9. Initial short-stack blind all-in reaches settlement with no action ---

it("9. an initial short-stack blind all-in reaches settlement without requiring an impossible action", () => {
  const { tableId } = setUpReadyTable(db);
  // Seat 1 (button/small blind) can only post 3 of the 5-chip small blind;
  // seat 2's full 10-chip big blind already exceeds that, so there is
  // nothing left for either seat to decide.
  setChipStack(tableId, 1, 3);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.hand.status).toBe("settled");
  expect(created.hand.street).toBe("river");
  expect(created.hand.bettingState.actingSeat).toBeNull();
});

// --- 10/11/12. All-in runouts at every street -------------------------------

it("10. a preflop all-in automatically runs out all five board cards", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  if (!created.ok) return;

  let hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "all_in" },
  });
  expect(hand.ok).toBe(true);
  if (!hand.ok) return;

  const final = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r2",
    expectedVersion: hand.hand.version,
    action: { type: "all_in" },
  });
  expect(final.ok).toBe(true);
  if (!final.ok) return;
  expect(final.hand.street).toBe("river");
  expect(final.hand.status).toBe("settled");
  expect(db.getCommunityCards(created.hand.id)).toHaveLength(5);
});

it("11. a flop all-in automatically runs out the turn and river", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  if (!created.ok) return;

  let hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  if (!hand.ok) return;
  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r2",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  if (!hand.ok) return;
  expect(hand.hand.street).toBe("flop");

  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r3",
    expectedVersion: hand.hand.version,
    action: { type: "all_in" },
  });
  if (!hand.ok) return;
  const final = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r4",
    expectedVersion: hand.hand.version,
    action: { type: "all_in" },
  });
  expect(final.ok).toBe(true);
  if (!final.ok) return;
  expect(final.hand.street).toBe("river");
  expect(final.hand.status).toBe("settled");
});

it("12. a turn all-in automatically runs out the river", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  if (!created.ok) return;

  let hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  if (!hand.ok) return;
  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r2",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  if (!hand.ok) return;
  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r3",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  if (!hand.ok) return;
  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r4",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  if (!hand.ok) return;
  expect(hand.hand.street).toBe("turn");

  hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r5",
    expectedVersion: hand.hand.version,
    action: { type: "all_in" },
  });
  if (!hand.ok) return;
  const final = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r6",
    expectedVersion: hand.hand.version,
    action: { type: "all_in" },
  });
  expect(final.ok).toBe(true);
  if (!final.ok) return;
  expect(final.hand.street).toBe("river");
  expect(final.hand.status).toBe("settled");
});

// --- 14/15. Showdown B wins / exact tie -------------------------------------

function playCheckdownToSettlement(
  instance: typeof import("../db.ts"),
  handId: number,
  startVersion: number,
  hostIdentityId: number,
  guestIdentityId: number,
) {
  let hand = instance.submitBettingAction({
    handId,
    identityId: hostIdentityId,
    requestId: "cr1",
    expectedVersion: startVersion,
    action: { type: "call" },
  });
  if (!hand.ok) throw new Error("setup failed");
  hand = instance.submitBettingAction({
    handId,
    identityId: guestIdentityId,
    requestId: "cr2",
    expectedVersion: hand.hand.version,
    action: { type: "check" },
  });
  if (!hand.ok) throw new Error("setup failed");
  for (const [a, b] of [
    ["cr3", "cr4"],
    ["cr5", "cr6"],
    ["cr7", "cr8"],
  ] as const) {
    hand = instance.submitBettingAction({
      handId,
      identityId: guestIdentityId,
      requestId: a,
      expectedVersion: hand.hand.version,
      action: { type: "check" },
    });
    if (!hand.ok) throw new Error("setup failed");
    hand = instance.submitBettingAction({
      handId,
      identityId: hostIdentityId,
      requestId: b,
      expectedVersion: hand.hand.version,
      action: { type: "check" },
    });
    if (!hand.ok) throw new Error("setup failed");
  }
  return hand;
}

it("14. showdown: seat 2 wins when dealt the stronger cards", () => {
  // Swap which hole-card slot gets the winning cards relative to SEAT1_WINS_DECK.
  const seat2WinsDeck = buildFixedDeck([
    c(7, "clubs"),
    c(6, "diamonds"), // seat 1 hole (weak)
    c(14, "hearts"),
    c(14, "spades"), // seat 2 hole (aces)
    c(13, "clubs"),
    c(13, "diamonds"),
    c(9, "hearts"),
    c(4, "spades"),
    c(2, "clubs"),
  ]);
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId, seat2WinsDeck);
  if (!created.ok) return;

  const final = playCheckdownToSettlement(db, created.hand.id, created.hand.version, hostIdentityId, guestIdentityId);
  expect(final.ok).toBe(true);
  if (!final.ok) return;
  expect(final.hand.status).toBe("settled");

  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const seats = raw.prepare("SELECT seat_number, chip_stack FROM poker_seats WHERE table_id = ?").all(tableId) as {
    seat_number: number;
    chip_stack: number;
  }[];
  raw.close();
  expect(seats.find((s) => s.seat_number === 2)?.chip_stack).toBeGreaterThan(1000);
  expect(seats.find((s) => s.seat_number === 1)?.chip_stack).toBeLessThan(1000);
});

it("15. showdown: an exact tie splits the contested pot evenly", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId, TIE_DECK);
  if (!created.ok) return;

  const final = playCheckdownToSettlement(db, created.hand.id, created.hand.version, hostIdentityId, guestIdentityId);
  expect(final.ok).toBe(true);
  if (!final.ok) return;

  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const seats = raw.prepare("SELECT seat_number, chip_stack FROM poker_seats WHERE table_id = ?").all(tableId) as {
    seat_number: number;
    chip_stack: number;
  }[];
  raw.close();
  expect(seats.find((s) => s.seat_number === 1)?.chip_stack).toBe(1000);
  expect(seats.find((s) => s.seat_number === 2)?.chip_stack).toBe(1000);
});

// --- 16/17/18. Refund, final stacks match pure settlement, bankroll conserved ---

it("16/17/18. uncalled excess is refunded, final stacks match the pure settlement result, and total bankroll is conserved", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  // Seat 1 (button/SB) keeps the default 1,000; seat 2 (big blind) is
  // short-stacked at 100, so seat 1's all-in cannot possibly be fully
  // matched — a genuine uncalled excess results.
  setChipStack(tableId, 2, 100);
  const before = totalBankroll(tableId);

  const created = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  // Seat 1 shoves their full 1,000; seat 2 can only call all-in for their
  // own remaining 100 total, leaving seat 1's excess uncalled.
  let hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "all_in" },
  });
  if (!hand.ok) return;
  const final = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r2",
    expectedVersion: hand.hand.version,
    action: { type: "call" },
  });
  expect(final.ok).toBe(true);
  if (!final.ok) return;
  expect(final.hand.bettingState.uncalledExcess).toEqual({ seat: 1, amount: 900 });

  const planResult = db.getSettlementPlanForHand(created.hand.id);
  expect(planResult.ok).toBe(true);
  if (!planResult.ok) return;

  const after = totalBankroll(tableId);
  expect(after).toBe(before); // bankroll conserved

  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const seats = raw.prepare("SELECT seat_number, chip_stack FROM poker_seats WHERE table_id = ?").all(tableId) as {
    seat_number: number;
    chip_stack: number;
  }[];
  raw.close();
  expect(seats.find((s) => s.seat_number === 1)?.chip_stack).toBe(planResult.plan.finalStacks[1]);
  expect(seats.find((s) => s.seat_number === 2)?.chip_stack).toBe(planResult.plan.finalStacks[2]);
});

// --- 19/20. Settlement is idempotent; cannot double-pay ---------------------

it("19/20. settlement is idempotent and cannot double-pay, even via a direct repeated call", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  if (!created.ok) return;
  const settled = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "fold" },
  });
  expect(settled.ok).toBe(true);
  if (!settled.ok) return;

  const stackAfterFirst = totalBankroll(tableId);

  // A direct repeated settlement attempt against the same hand must not
  // transfer additional chips.
  const second = db.settlePersistedHand(created.hand.id);
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.reason).toBe("already_settled");
  expect(totalBankroll(tableId)).toBe(stackAfterFirst);

  const third = db.settlePersistedHand(created.hand.id);
  expect(third.ok).toBe(false);
  expect(totalBankroll(tableId)).toBe(stackAfterFirst);
});

// --- 21. Rollback cannot leave a partially settled hand ---------------------

it("21. a failed settlement attempt leaves no partial state (status and chip_stack never disagree)", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  if (!created.ok) return;

  // Attempting settlement on a hand that is not yet terminal must fail
  // cleanly, touching neither status nor chip_stack.
  const before = totalBankroll(tableId);
  const attempt = db.settlePersistedHand(created.hand.id);
  expect(attempt.ok).toBe(false);
  if (!attempt.ok) expect(attempt.reason).toBe("hand_not_terminal");
  expect(totalBankroll(tableId)).toBe(before);
  expect(db.getHandById(created.hand.id)?.status).toBe("active");
});

// --- 22/23. Hand state survives reopen; restart before/after settlement consistent ---

it("22/23. hand state survives reopen, and restart before/after settlement is consistent", async () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  if (!created.ok) return;

  let hand = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  if (!hand.ok) return;

  // Restart BEFORE settlement: in-progress state must survive exactly.
  const reopenedMidHand = await reopen();
  const midHandReloaded = reopenedMidHand.getHandById(created.hand.id);
  expect(midHandReloaded?.street).toBe("preflop");
  expect(midHandReloaded?.status).toBe("active");

  hand = reopenedMidHand.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "r2",
    expectedVersion: midHandReloaded!.version,
    action: { type: "check" },
  });
  if (!hand.ok) return;
  expect(hand.hand.street).toBe("flop"); // preflop already complete; auto-advanced

  // Check down flop, turn, and river to reach showdown/settlement.
  for (const [reqA, reqB] of [
    ["r3", "r4"],
    ["r5", "r6"],
    ["r7", "r8"],
  ] as const) {
    hand = reopenedMidHand.submitBettingAction({
      handId: created.hand.id,
      identityId: guestIdentityId,
      requestId: reqA,
      expectedVersion: hand.hand.version,
      action: { type: "check" },
    });
    if (!hand.ok) return;
    hand = reopenedMidHand.submitBettingAction({
      handId: created.hand.id,
      identityId: hostIdentityId,
      requestId: reqB,
      expectedVersion: hand.hand.version,
      action: { type: "check" },
    });
    if (!hand.ok) return;
  }
  expect(hand.hand.status).toBe("settled");

  // Restart AFTER settlement: settled status and final chip_stack survive.
  const reopenedAfterSettlement = await reopen();
  const afterReloaded = reopenedAfterSettlement.getHandById(created.hand.id);
  expect(afterReloaded?.status).toBe("settled");
  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const seats = raw.prepare("SELECT seat_number, chip_stack FROM poker_seats WHERE table_id = ?").all(tableId) as {
    seat_number: number;
    chip_stack: number;
  }[];
  raw.close();
  expect(seats.find((s) => s.seat_number === 1)?.chip_stack).toBeGreaterThan(1000);
});

// --- 24/25. Identical retry / conflicting reuse of the FINAL action ---------

it("24. an identical retry of the final (hand-completing) action does not re-charge chips", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  if (!created.ok) return;

  const params = {
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "final-action",
    expectedVersion: created.hand.version,
    action: { type: "fold" as const },
  };
  const first = db.submitBettingAction(params);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.hand.status).toBe("settled");
  const stackAfterFirst = totalBankroll(tableId);

  // Retried with the exact same request — even though the hand is now
  // settled, this must be recognized as an idempotent replay.
  const retried = db.submitBettingAction(params);
  expect(retried.ok).toBe(true);
  if (!retried.ok) return;
  expect(retried.duplicate).toBe(true);
  expect(totalBankroll(tableId)).toBe(stackAfterFirst);
});

it("25. a conflicting reuse of the same request id (against the settled hand) is still rejected", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  if (!created.ok) return;

  const requestId = "final-action-2";
  const first = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId,
    expectedVersion: created.hand.version,
    action: { type: "fold" },
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  const conflicting = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId,
    expectedVersion: created.hand.version,
    action: { type: "check" }, // different action, same id
  });
  expect(conflicting.ok).toBe(false);
  if (!conflicting.ok) expect(conflicting.reason).toBe("request_id_conflict");
});

// --- 26/27. Next hand uses settled balances; button rotates -----------------

it("26/27. a new hand uses the previous hand's settled balances, and the button rotates", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const hand1 = db.createPokerHand(tableId);
  if (!hand1.ok) return;
  expect(hand1.hand.buttonSeat).toBe(1);

  const settled1 = db.submitBettingAction({
    handId: hand1.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: hand1.hand.version,
    action: { type: "fold" },
  });
  expect(settled1.ok).toBe(true);
  if (!settled1.ok) return;

  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const seatsAfter1 = raw.prepare("SELECT seat_number, chip_stack FROM poker_seats WHERE table_id = ?").all(tableId) as {
    seat_number: number;
    chip_stack: number;
  }[];
  raw.close();
  const stack1 = seatsAfter1.find((s) => s.seat_number === 1)!.chip_stack;
  const stack2 = seatsAfter1.find((s) => s.seat_number === 2)!.chip_stack;

  const hand2 = db.createPokerHand(tableId);
  expect(hand2.ok).toBe(true);
  if (!hand2.ok) return;
  expect(hand2.hand.buttonSeat).toBe(2); // rotated
  // Starting stacks for hand 2 reflect hand 1's settled outcome, not the
  // table's original 1,000/1,000 defaults.
  expect(hand2.hand.bettingState.seats[1].stack + hand2.hand.bettingState.seats[1].committedTotal).toBe(stack1);
  expect(hand2.hand.bettingState.seats[2].stack + hand2.hand.bettingState.seats[2].committedTotal).toBe(stack2);
});

// --- 28/29. New hand cannot start before settlement; two active hands impossible ---

it("28/29. a new hand cannot start while the previous one is still active", () => {
  const { tableId } = setUpReadyTable(db);
  const hand1 = db.createPokerHand(tableId);
  expect(hand1.ok).toBe(true);

  const hand2 = db.createPokerHand(tableId);
  expect(hand2.ok).toBe(false);
  if (!hand2.ok) expect(hand2.reason).toBe("hand_already_active");
});

// --- 30. A player with zero chips cannot silently restart -------------------

it("30. a player with zero chips cannot start a new hand with a silently reset bankroll", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  // Seat 2 (big blind) has exactly the big blind amount: a full, un-short
  // blind that happens to exhaust their stack, so seat 1 (small blind)
  // still has a completely normal decision to make (call the extra 5).
  setChipStack(tableId, 2, 10);
  // SEAT1_WINS_DECK deterministically gives the button (seat 1, the
  // winner once seat 1 calls) pocket aces against seat 2's weak cards, so
  // seat 2 busts to exactly 0, deterministically.
  const hand1 = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  expect(hand1.ok).toBe(true);
  if (!hand1.ok) return;
  expect(hand1.hand.status).toBe("active"); // seat 1 still owes a real decision

  const afterCall = db.submitBettingAction({
    handId: hand1.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: hand1.hand.version,
    action: { type: "call" },
  });
  expect(afterCall.ok).toBe(true);
  if (!afterCall.ok) return;
  // Seat 2 was already all-in; seat 1's call completes the round and
  // cascades straight to settlement with no further action possible.
  expect(afterCall.hand.status).toBe("settled");

  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const seat2 = raw.prepare("SELECT chip_stack FROM poker_seats WHERE table_id = ? AND seat_number = 2").get(
    tableId,
  ) as { chip_stack: number };
  raw.close();
  expect(seat2.chip_stack).toBe(0);

  const hand2 = db.createPokerHand(tableId);
  expect(hand2.ok).toBe(false);
  if (!hand2.ok) expect(hand2.reason).toBe("insufficient_chips");
});

// --- 31. Old completed hands are immutable ----------------------------------

it("31. an old completed hand's persisted data never changes after a later hand is played", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const hand1 = db.createPokerHand(tableId);
  if (!hand1.ok) return;
  const settled1 = db.submitBettingAction({
    handId: hand1.hand.id,
    identityId: hostIdentityId,
    requestId: "r1",
    expectedVersion: hand1.hand.version,
    action: { type: "fold" },
  });
  if (!settled1.ok) return;
  const snapshot = db.getHandById(hand1.hand.id);

  const hand2 = db.createPokerHand(tableId);
  expect(hand2.ok).toBe(true);
  if (!hand2.ok) return;
  db.submitBettingAction({
    handId: hand2.hand.id,
    identityId: guestIdentityId,
    requestId: "r2",
    expectedVersion: hand2.hand.version,
    action: { type: "fold" },
  });

  expect(db.getHandById(hand1.hand.id)).toEqual(snapshot);
});

// --- 32. No private deck or hole-card data exposed via existing HTTP routes ---

it("32. existing HTTP routes never expose the deck or either player's hole cards", async () => {
  const { tableId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  // There is no hand/card HTTP surface at all yet in this slice (by
  // design — Slice 4B adds no public gameplay routes); this confirms the
  // existing table routes carry nothing hand-related regardless, even
  // with an active hand (holding known Ace hole cards) underneath them.
  const { app } = await import("../server.ts");
  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const tableRow = raw.prepare("SELECT code FROM poker_tables WHERE id = ?").get(tableId) as { code: string };
  raw.close();

  const pageRes = await app.fetch(new Request(`http://localhost/t/${tableRow.code}`));
  const pageHtml = await pageRes.text();
  const liveRes = await app.fetch(new Request(`http://localhost/t/${tableRow.code}/live`));
  const liveHtml = await liveRes.text();

  for (const html of [pageHtml, liveHtml]) {
    expect(html).not.toContain("hole_cards");
    expect(html).not.toContain("deck_json");
    expect(html).not.toContain('"rank":14'); // no serialized Card JSON of any kind
    expect(html.toLowerCase()).not.toContain("spades");
    expect(html.toLowerCase()).not.toContain("hearts");
  }
});
