import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cardKey, type Card } from "../poker/cards.ts";
import { createDeck } from "../poker/deck.ts";

// Isolated-database, db.ts-direct tests — like spec/migration.test.ts and
// the original spec/settlement.test.ts, these exercise the persistence
// layer against a real on-disk SQLite file, not through HTTP. A "restart"
// is simulated the same way spec/poker.test.ts's restart test does: a
// vi.resetModules() + fresh dynamic import against the same DATA_DIR.

let tempDir: string;
let previousDataDir: string | undefined;
let db: typeof import("../db.ts");

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "poker-persistence-"));
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

function openRaw(): DatabaseSync {
  return new DatabaseSync(join(tempDir, "app.sqlite"));
}

// Builds a ready-to-deal table: two joined identities, both seated.
function setUpReadyTable(instance: typeof import("../db.ts")): {
  tableId: number;
  hostIdentityId: number;
  guestIdentityId: number;
} {
  const host = instance.createIdentity(instance.hashToken("host-token"));
  const guest = instance.createIdentity(instance.hashToken("guest-token"));
  const table = instance.createPokerTable(host.id);
  const join = instance.joinPokerTable(table.id, guest.id);
  expect(join.ok).toBe(true);
  return { tableId: table.id, hostIdentityId: host.id, guestIdentityId: guest.id };
}

it("1. the v5 -> v6 migration succeeds: hand/hand-player/action tables exist", () => {
  // db was already freshly imported in beforeEach, which runs every
  // migration up to the current SCHEMA_VERSION against a brand-new file.
  const raw = openRaw();
  const tables = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('poker_hands', 'poker_hand_players', 'poker_actions')",
    )
    .all() as { name: string }[];
  expect(tables.map((t) => t.name).sort()).toEqual(["poker_actions", "poker_hand_players", "poker_hands"]);
  const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
  // 7, not 6: schema version 7 (card-clash/ rooms/matches, D3A) is additive
  // on top of poker's own v6 — poker's tables/behavior above are unchanged.
  expect(version.user_version).toBe(7);
  raw.close();
});

it("2. re-running the migration changes nothing", async () => {
  const { tableId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);

  const reopened = await reopen();
  const stillActive = reopened.getActiveHandForTable(tableId);
  expect(stillActive).toBeTruthy();
  if (created.ok) expect(stillActive?.id).toBe(created.hand.id);
  expect(stillActive?.version).toBe(created.ok ? created.hand.version : -1);
});

it("3. the old migration chain remains valid: a pure v1 database migrates all the way through to the current schema version", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  // beforeEach's own fresh import already created and fully migrated a
  // brand-new database at this path; this test specifically wants to start
  // from a pure, un-migrated v1 shape instead, so that file (and its WAL
  // siblings) must be cleared first.
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });

  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec(`
    CREATE TABLE identities (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'configuring',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      identity_id INTEGER NOT NULL REFERENCES identities(id),
      seat INTEGER NOT NULL CHECK (seat IN (1, 2)),
      is_host INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (campaign_id, seat),
      UNIQUE (campaign_id, identity_id)
    );
  `);
  raw.exec("PRAGMA user_version = 1");
  raw.close();

  const fresh = await reopen();
  const rawAfter = openRaw();
  const version = rawAfter.prepare("PRAGMA user_version").get() as { user_version: number };
  // 7, not 6: the chain now continues on through the additive v7 (Card
  // Clash) migration too — the v1->v6 portion being exercised here is
  // otherwise unchanged.
  expect(version.user_version).toBe(7);
  const pokerTables = rawAfter
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'poker_hands'")
    .get() as { n: number };
  expect(pokerTables.n).toBe(1);
  rawAfter.close();
  // The import's module instance is usable immediately afterward too.
  expect(fresh.getPokerTableByCode("NOPE")).toBeUndefined();
});

it("4. two active hands cannot exist for one table", () => {
  const { tableId } = setUpReadyTable(db);
  const first = db.createPokerHand(tableId);
  expect(first.ok).toBe(true);

  const second = db.createPokerHand(tableId);
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.reason).toBe("hand_already_active");
});

it("5. a completed hand can coexist with a later active hand", () => {
  const { tableId } = setUpReadyTable(db);
  const first = db.createPokerHand(tableId);
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  // Settlement itself isn't implemented yet (Slice 3 scope); mark the hand
  // settled directly via raw SQL purely to exercise the "one active hand"
  // constraint's intended lifecycle, not to claim a settlement feature.
  const raw = openRaw();
  raw.prepare("UPDATE poker_hands SET status = 'settled' WHERE id = ?").run(first.hand.id);
  raw.close();

  const second = db.createPokerHand(tableId);
  expect(second.ok).toBe(true);
  if (second.ok) {
    expect(second.hand.handNumber).toBe(2);
    expect(second.hand.id).not.toBe(first.hand.id);
  }
});

it("6. initial hand state persists correctly", () => {
  const { tableId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  expect(created.hand.handNumber).toBe(1);
  expect(created.hand.buttonSeat).toBe(1); // hand 1 -> seat 1
  expect(created.hand.street).toBe("preflop");
  expect(created.hand.status).toBe("active");
  expect(created.hand.bettingState.currentBet).toBe(10); // default 5/10 blinds
  expect(created.hand.bettingState.seats[1].committedThisStreet).toBe(5);
  expect(created.hand.bettingState.seats[2].committedThisStreet).toBe(10);

  const loaded = db.getHandById(created.hand.id);
  expect(loaded).toEqual(created.hand);
});

it("7. private hole cards persist correctly and never overlap between players", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const hostCards = db.getOwnHoleCards(created.hand.id, hostIdentityId);
  const guestCards = db.getOwnHoleCards(created.hand.id, guestIdentityId);
  expect(hostCards).toHaveLength(2);
  expect(guestCards).toHaveLength(2);

  const key = (c: Card) => `${c.rank}:${c.suit}`;
  const allFour = [...hostCards!, ...guestCards!].map(key);
  expect(new Set(allFour).size).toBe(4); // no duplicate/overlapping card

  // A non-player identity gets nothing.
  const stranger = db.createIdentity(db.hashToken("stranger-token"));
  expect(db.getOwnHoleCards(created.hand.id, stranger.id)).toBeUndefined();
});

it("8. deck order survives database reopening", async () => {
  const { tableId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const rawBefore = openRaw();
  const before = (rawBefore.prepare("SELECT deck_json FROM poker_hands WHERE id = ?").get(created.hand.id) as {
    deck_json: string;
  }).deck_json;
  rawBefore.close();

  await reopen();
  const rawAfter = openRaw();
  const after = (rawAfter.prepare("SELECT deck_json FROM poker_hands WHERE id = ?").get(created.hand.id) as {
    deck_json: string;
  }).deck_json;
  rawAfter.close();

  expect(after).toBe(before); // byte-identical: no reshuffle on restart
});

it("9. community-card / deal position survives reopening", async () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  expect(db.getCommunityCards(created.hand.id)).toHaveLength(0); // preflop: no board yet

  // Complete preflop (small blind calls, big blind checks) then advance.
  const afterCall = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId, // seat 1, the button/small blind, acts first
    requestId: "req-call",
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  expect(afterCall.ok).toBe(true);
  if (!afterCall.ok) return;

  const afterCheck = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId, // seat 2, big blind option
    requestId: "req-check",
    expectedVersion: afterCall.hand.version,
    action: { type: "check" },
  });
  expect(afterCheck.ok).toBe(true);
  if (!afterCheck.ok) return;

  // Betting just completed, so the hand has already auto-advanced to the
  // flop as a direct consequence of that same action — no separate
  // advanceHandStreet call is needed (Slice 4B's automatic progression).
  expect(afterCheck.hand.street).toBe("flop");

  const flopCards = db.getCommunityCards(created.hand.id);
  expect(flopCards).toHaveLength(3);

  const reopened = await reopen();
  const flopCardsAfterRestart = reopened.getCommunityCards(created.hand.id);
  expect(flopCardsAfterRestart).toEqual(flopCards);
  const reopenedHand = reopened.getHandById(created.hand.id);
  expect(reopenedHand?.street).toBe("flop");
});

it("10. betting state survives reopening", async () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const afterRaise = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "req-raise",
    expectedVersion: created.hand.version,
    action: { type: "raise", amount: 30 },
  });
  expect(afterRaise.ok).toBe(true);
  if (!afterRaise.ok) return;

  const reopened = await reopen();
  const reloaded = reopened.getHandById(created.hand.id);
  expect(reloaded?.bettingState).toEqual(afterRaise.hand.bettingState);
  expect(reloaded?.version).toBe(afterRaise.hand.version);
});

it("11. a legal action persists with an increased version", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const startVersion = created.hand.version;
  const result = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "req-1",
    expectedVersion: startVersion,
    action: { type: "call" },
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.duplicate).toBe(false);
    expect(result.hand.version).toBe(startVersion + 1);
  }
});

it("12. a stale version is rejected", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const result = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "req-stale",
    expectedVersion: created.hand.version + 1, // wrong on purpose
    action: { type: "call" },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("stale_version");

  const stillUnchanged = db.getHandById(created.hand.id);
  expect(stillUnchanged?.version).toBe(created.hand.version);
});

it("13. a duplicate request id does not double-charge chips", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const requestId = "req-duplicate";
  const first = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId,
    expectedVersion: created.hand.version,
    action: { type: "raise", amount: 30 },
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.duplicate).toBe(false);

  // Retried with the SAME request id and the SAME (now stale) expected
  // version, as a real network-retry client would.
  const retried = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId,
    expectedVersion: created.hand.version, // the original, pre-action version
    action: { type: "raise", amount: 30 },
  });
  expect(retried.ok).toBe(true);
  if (!retried.ok) return;
  expect(retried.duplicate).toBe(true);
  expect(retried.hand.version).toBe(first.hand.version); // nothing re-applied
  expect(retried.hand.bettingState.seats[1].committedTotal).toBe(
    first.hand.bettingState.seats[1].committedTotal,
  );

  const history = db.getActionHistory(created.hand.id);
  expect(history).toHaveLength(1); // exactly one action record, not two
});

// --- Slice 3 final audit: request-id content-awareness (A2) ----------------
// A repeated request_id must be accepted as an idempotent no-op ONLY when
// every piece of semantic content matches the original exactly. Any
// difference is a genuine conflict (most plausibly a request-id collision
// or a bug), not a harmless retry, and must be rejected outright rather
// than silently approved as "already done."

it("A2.1 an identical retry is a true idempotent duplicate: no new action, no new debit", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const params = {
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "req-a2-identical",
    expectedVersion: created.hand.version,
    action: { type: "raise" as const, amount: 30 },
  };
  const first = db.submitBettingAction(params);
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  const retried = db.submitBettingAction(params);
  expect(retried.ok).toBe(true);
  if (!retried.ok) return;
  expect(retried.duplicate).toBe(true);
  expect(retried.hand).toEqual(first.hand);
  expect(db.getActionHistory(created.hand.id)).toHaveLength(1);
});

it("A2.2 the same request id with a different amount is rejected as a conflict, not a duplicate", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const requestId = "req-a2-amount";
  const first = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId,
    expectedVersion: created.hand.version,
    action: { type: "raise", amount: 30 },
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  const conflicting = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId,
    expectedVersion: created.hand.version,
    action: { type: "raise", amount: 40 }, // different amount, same id
  });
  expect(conflicting.ok).toBe(false);
  if (!conflicting.ok) expect(conflicting.reason).toBe("request_id_conflict");

  expect(db.getHandById(created.hand.id)).toEqual(first.hand); // unchanged
  expect(db.getActionHistory(created.hand.id)).toHaveLength(1);
});

it("A2.3 the same request id with a different action type is rejected as a conflict", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const requestId = "req-a2-action-type";
  const first = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId,
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  const conflicting = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId,
    expectedVersion: created.hand.version,
    action: { type: "fold" }, // different action, same id
  });
  expect(conflicting.ok).toBe(false);
  if (!conflicting.ok) expect(conflicting.reason).toBe("request_id_conflict");

  expect(db.getHandById(created.hand.id)).toEqual(first.hand);
  expect(db.getActionHistory(created.hand.id)).toHaveLength(1);
});

it("A2.4 the same request id with a different expected version is rejected as a conflict", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const requestId = "req-a2-version";
  const first = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId,
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  const conflicting = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId,
    expectedVersion: created.hand.version + 1, // different expected version, same id
    action: { type: "call" },
  });
  expect(conflicting.ok).toBe(false);
  if (!conflicting.ok) expect(conflicting.reason).toBe("request_id_conflict");

  expect(db.getHandById(created.hand.id)).toEqual(first.hand);
  expect(db.getActionHistory(created.hand.id)).toHaveLength(1);
});

it("A2.5 the same request id submitted by a different authenticated player is rejected as a conflict", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const requestId = "req-a2-player";
  const first = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId, // seat 1, correctly acts first
    requestId,
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  // Seat 2 (a different authenticated player) reuses the exact same
  // request id for what would otherwise be their own legal action.
  const conflicting = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId,
    expectedVersion: first.hand.version,
    action: { type: "check" },
  });
  expect(conflicting.ok).toBe(false);
  if (!conflicting.ok) expect(conflicting.reason).toBe("request_id_conflict");

  expect(db.getHandById(created.hand.id)).toEqual(first.hand);
  expect(db.getActionHistory(created.hand.id)).toHaveLength(1);
});

it("14. an unauthorized (non-player) identity cannot act", () => {
  const { tableId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const stranger = db.createIdentity(db.hashToken("stranger-token-2"));
  const result = db.submitBettingAction({
    handId: created.hand.id,
    identityId: stranger.id,
    requestId: "req-stranger",
    expectedVersion: created.hand.version,
    action: { type: "call" },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("not_a_player");

  expect(db.getHandById(created.hand.id)?.version).toBe(created.hand.version);
});

it("15. an out-of-turn action cannot persist", () => {
  const { tableId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  // Seat 1 (the button/small blind) acts first preflop; seat 2 (the guest,
  // big blind) tries to act out of turn.
  const result = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "req-out-of-turn",
    expectedVersion: created.hand.version,
    action: { type: "check" },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("not_your_turn");

  expect(db.getHandById(created.hand.id)?.version).toBe(created.hand.version);
  expect(db.getActionHistory(created.hand.id)).toHaveLength(0);
});

it("16. an invalid raise does not alter persisted state", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const result = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "req-bad-raise",
    expectedVersion: created.hand.version,
    action: { type: "raise", amount: 15 }, // below the 20 minimum, not all-in
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("raise_below_minimum");

  const unchanged = db.getHandById(created.hand.id);
  expect(unchanged).toEqual(created.hand);
  expect(db.getActionHistory(created.hand.id)).toHaveLength(0);
});

it("17. chip conservation holds after each individually committed action", () => {
  const { tableId, hostIdentityId, guestIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  function sumChips(hand: import("../db.ts").PersistedHand): number {
    return (
      hand.bettingState.seats[1].stack +
      hand.bettingState.seats[1].committedTotal +
      hand.bettingState.seats[2].stack +
      hand.bettingState.seats[2].committedTotal
    );
  }

  expect(sumChips(created.hand)).toBe(2000); // default 1,000-chip starting stack per seat

  const afterRaise = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "req-17-a",
    expectedVersion: created.hand.version,
    action: { type: "raise", amount: 30 },
  });
  expect(afterRaise.ok).toBe(true);
  if (!afterRaise.ok) return;
  expect(sumChips(afterRaise.hand)).toBe(2000);

  const afterCall = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId,
    requestId: "req-17-b",
    expectedVersion: afterRaise.hand.version,
    action: { type: "call" },
  });
  expect(afterCall.ok).toBe(true);
  if (!afterCall.ok) return;
  expect(sumChips(afterCall.hand)).toBe(2000);
  // Betting just completed, so the hand has already auto-advanced to the
  // flop as a direct consequence of this same call (Slice 4B's automatic
  // progression) — no separate advanceHandStreet call is needed.
  expect(afterCall.hand.street).toBe("flop");

  const afterBet = db.submitBettingAction({
    handId: created.hand.id,
    identityId: guestIdentityId, // big blind acts first postflop
    requestId: "req-17-c",
    expectedVersion: afterCall.hand.version,
    action: { type: "bet", amount: 50 },
  });
  expect(afterBet.ok).toBe(true);
  if (!afterBet.ok) return;
  expect(sumChips(afterBet.hand)).toBe(2000);

  const afterFold = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "req-17-d",
    expectedVersion: afterBet.hand.version,
    action: { type: "fold" },
  });
  expect(afterFold.ok).toBe(true);
  if (!afterFold.ok) return;
  expect(sumChips(afterFold.hand)).toBe(2000);
  expect(afterFold.hand.bettingState.handOutcome).toBe("uncontested");
});

it("18. a rejected action leaves no partial update: version, betting state and action history are all untouched", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const before = db.getHandById(created.hand.id);
  const rejected = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "req-rejected",
    expectedVersion: created.hand.version,
    action: { type: "raise", amount: 1_000_000 }, // exceeds available chips
  });
  expect(rejected.ok).toBe(false);

  const after = db.getHandById(created.hand.id);
  expect(after).toEqual(before); // byte-for-byte identical: no partial write
  expect(db.getActionHistory(created.hand.id)).toHaveLength(0);
});

it("19. an action history record corresponds exactly to the committed state transition", () => {
  const { tableId, hostIdentityId } = setUpReadyTable(db);
  const created = db.createPokerHand(tableId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const result = db.submitBettingAction({
    handId: created.hand.id,
    identityId: hostIdentityId,
    requestId: "req-history",
    expectedVersion: created.hand.version,
    action: { type: "raise", amount: 25 },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const history = db.getActionHistory(created.hand.id);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    handId: created.hand.id,
    seatNumber: 1,
    requestId: "req-history",
    expectedVersion: created.hand.version,
    actionType: "raise",
    amount: 25,
    resultingVersion: result.hand.version,
  });
});

// --- B1: createPokerHand's expectedLatestHandNumber guard (Slice 5B audit) --
//
// Found during the Slice 5B independent audit: a hand created by
// createPokerHand can auto-settle within its own creation transaction (an
// extreme-short-stack blind post can already leave no decision for either
// seat — see poker/betting.ts's isSettled). The moment that happens, the
// row's status flips from 'active' to 'settled' *before* COMMIT, so the
// `one_active_hand_per_table` partial unique index (WHERE status='active')
// no longer blocks a second, closely-following createPokerHand call for the
// same table — a double-submitted "start hand" click could silently create
// a second, genuinely distinct hand the user never intended. These tests
// reproduce that exact scenario and confirm expectedLatestHandNumber closes
// it without blocking a legitimate subsequent hand.

function buildFixedDeck(firstCards: Card[]): Card[] {
  const used = new Set(firstCards.map(cardKey));
  const rest = createDeck().filter((card) => !used.has(cardKey(card)));
  return [...firstCards, ...rest];
}

// Seat 1 (button, posts the small blind) gets pocket aces and wins outright
// — chosen deliberately so seat 1's stack survives the forced short all-in
// at a positive balance (6, not 0), which is exactly the condition under
// which the pre-fix code could create a second hand.
const SHORT_STACK_SEAT1_WINS_DECK = buildFixedDeck([
  { rank: 14, suit: "hearts" },
  { rank: 14, suit: "spades" }, // seat 1 hole
  { rank: 7, suit: "clubs" },
  { rank: 6, suit: "diamonds" }, // seat 2 hole
  { rank: 13, suit: "clubs" },
  { rank: 13, suit: "diamonds" },
  { rank: 9, suit: "hearts" }, // flop
  { rank: 4, suit: "spades" }, // turn
  { rank: 2, suit: "clubs" }, // river
]);

function setSeatStack(tableId: number, seatNumber: 1 | 2, chipStack: number): void {
  const raw = openRaw();
  raw.prepare("UPDATE poker_seats SET chip_stack = ? WHERE table_id = ? AND seat_number = ?").run(
    chipStack,
    tableId,
    seatNumber,
  );
  raw.close();
}

it("B1.1 a hand whose own creation immediately auto-settles can still leave the short stack with a positive balance", () => {
  const { tableId } = setUpReadyTable(db);
  setSeatStack(tableId, 1, 3); // below the table's small blind (5): forced all-in on the blind post alone
  setSeatStack(tableId, 2, 1997);

  const created = db.createPokerHand(tableId, SHORT_STACK_SEAT1_WINS_DECK);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.hand.status).toBe("settled"); // settled within its own creation transaction

  const seats = db.getSeatsForTable(tableId);
  expect(seats.find((s) => s.seatNumber === 1)?.chipStack).toBeGreaterThan(0); // survived, didn't bust to 0
});

it("B1.2 without expectedLatestHandNumber, a closely-following call creates a real second hand (confirms the race is reachable)", () => {
  const { tableId } = setUpReadyTable(db);
  setSeatStack(tableId, 1, 3);
  setSeatStack(tableId, 2, 1997);

  const first = db.createPokerHand(tableId, SHORT_STACK_SEAT1_WINS_DECK);
  expect(first.ok).toBe(true);

  // No expectedLatestHandNumber passed: the partial unique index alone
  // cannot catch this, because the first hand is already 'settled' by the
  // time this second call runs.
  const second = db.createPokerHand(tableId);
  expect(second.ok).toBe(true); // demonstrates the pre-guard behavior

  const raw = openRaw();
  const rows = raw.prepare("SELECT hand_number FROM poker_hands WHERE table_id = ? ORDER BY hand_number").all(
    tableId,
  ) as { hand_number: number }[];
  raw.close();
  expect(rows.map((r) => r.hand_number)).toEqual([1, 2]); // two hands from what should be one intended start
});

it("B1.3 expectedLatestHandNumber rejects a stale (double-submitted) hand-start request as a no-op", () => {
  const { tableId } = setUpReadyTable(db);
  setSeatStack(tableId, 1, 3);
  setSeatStack(tableId, 2, 1997);

  // Simulates the real UI: the page was rendered with no hand yet existing,
  // so the hidden after_hand_number field says 0.
  const first = db.createPokerHand(tableId, SHORT_STACK_SEAT1_WINS_DECK, 0);
  expect(first.ok).toBe(true);

  // A double-submit of the exact same original request still claims
  // after_hand_number=0 (it's the same stale render).
  const retry = db.createPokerHand(tableId, undefined, 0);
  expect(retry.ok).toBe(false);
  if (retry.ok) return;
  expect(retry.reason).toBe("stale_hand_state");

  const raw = openRaw();
  const rows = raw.prepare("SELECT hand_number FROM poker_hands WHERE table_id = ?").all(tableId) as {
    hand_number: number;
  }[];
  raw.close();
  expect(rows).toHaveLength(1); // no second hand was created
});

it("B1.4 a legitimate next-hand start (correct expectedLatestHandNumber) still succeeds after the guard rejects a stale retry", () => {
  const { tableId } = setUpReadyTable(db);
  setSeatStack(tableId, 1, 3);
  setSeatStack(tableId, 2, 1997);

  const first = db.createPokerHand(tableId, SHORT_STACK_SEAT1_WINS_DECK, 0);
  expect(first.ok).toBe(true);

  const staleRetry = db.createPokerHand(tableId, undefined, 0);
  expect(staleRetry.ok).toBe(false);

  // A genuinely new "start next hand" click, rendered after observing hand
  // #1's settlement, correctly claims after_hand_number=1.
  const legitimate = db.createPokerHand(tableId, undefined, 1);
  expect(legitimate.ok).toBe(true);
  if (!legitimate.ok) return;
  expect(legitimate.hand.handNumber).toBe(2);
  expect(legitimate.hand.status).toBe("active");
});
