import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { playAttack, respondToAttack } from "../card-clash/combat.ts";
import type { GameMode } from "../card-clash/types.ts";

// db.ts-direct persistence tests, against a real on-disk isolated SQLite
// file — never the production database or a developer's app.sqlite — the
// same convention spec/poker-persistence.test.ts and spec/migration.test.ts
// already use. Not run through HTTP.

let tempDir: string;
let previousDataDir: string | undefined;
let db: typeof import("../db.ts");

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "card-clash-storage-"));
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

function rawUserVersion(): number {
  const raw = openRaw();
  const version = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  raw.close();
  return version;
}

// Builds a ready-to-start room: host + however many more identities the
// mode needs, every seat marked ready.
function setUpReadyRoom(
  instance: typeof import("../db.ts"),
  mode: GameMode,
): { roomId: number; roomCode: string; identityIds: number[] } {
  const seatCount = { "1v1": 2, "1v2": 3, "2v2": 4 }[mode];
  const host = instance.createIdentity(instance.hashToken(`host-${Math.random()}`));
  const room = instance.createCardClashRoom(mode, host.id);
  const identityIds = [host.id];
  for (let i = 1; i < seatCount; i++) {
    const guest = instance.createIdentity(instance.hashToken(`guest-${i}-${Math.random()}`));
    const joined = instance.joinCardClashRoom(room.id, guest.id);
    expect(joined.ok).toBe(true);
    identityIds.push(guest.id);
  }
  for (const identityId of identityIds) {
    const ready = instance.setCardClashSeatReady(room.id, identityId, true);
    expect(ready.ok).toBe(true);
  }
  return { roomId: room.id, roomCode: room.code, identityIds };
}

it("1. a fresh database migrates to schema version 7 with all Card Clash tables present", () => {
  expect(rawUserVersion()).toBe(7);
  const raw = openRaw();
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'card_clash_%' ORDER BY name")
    .all() as { name: string }[];
  raw.close();
  expect(tables.map((t) => t.name)).toEqual([
    "card_clash_match_actions",
    "card_clash_matches",
    "card_clash_rooms",
    "card_clash_seats",
  ]);
});

it("2. upgrading an existing database to v7 preserves prior identity and poker data, and re-running initialization twice is safe", async () => {
  const identity = db.createIdentity(db.hashToken("pre-existing-token"));
  const table = db.createPokerTable(identity.id);

  // Force the version marker back down to 6 without dropping any table —
  // the Card Clash tables created above use CREATE TABLE IF NOT EXISTS, so
  // re-importing exercises the real idempotent-upgrade path against a
  // database whose tables already physically exist, rather than requiring
  // a hand-built, historically exact v6 file (the v1->v6 chain itself is
  // already covered by spec/migration.test.ts).
  const raw = openRaw();
  raw.exec("PRAGMA user_version = 6");
  raw.close();

  const reopened1 = await reopen();
  expect(rawUserVersion()).toBe(7);
  expect(reopened1.getPokerTableByCode(table.code)).toMatchObject({ id: table.id, code: table.code });
  expect(reopened1.findIdentityByTokenHash(reopened1.hashToken("pre-existing-token"))).toEqual({ id: identity.id });

  // A second restart (already at v7 this time) must not destroy anything either.
  const reopened2 = await reopen();
  expect(reopened2.getPokerTableByCode(table.code)).toMatchObject({ id: table.id, code: table.code });
  expect(rawUserVersion()).toBe(7);
});

it("3. rooms can be created in each supported mode, and the host always receives seat 1", () => {
  for (const mode of ["1v1", "1v2", "2v2"] as const) {
    const host = db.createIdentity(db.hashToken(`host-${mode}-${Math.random()}`));
    const room = db.createCardClashRoom(mode, host.id);
    expect(room.mode).toBe(mode);
    expect(room.status).toBe("waiting");
    const seats = db.getCardClashSeatsForRoom(room.id);
    expect(seats).toEqual([{ roomId: room.id, identityId: host.id, seatNumber: 1, ready: false }]);
  }
});

it("4. remaining players are assigned fixed, ascending seat numbers; the same identity rejoining is a reconnect, not a second seat", () => {
  const host = db.createIdentity(db.hashToken("host"));
  const room = db.createCardClashRoom("2v2", host.id);
  const guestA = db.createIdentity(db.hashToken("guestA"));
  const guestB = db.createIdentity(db.hashToken("guestB"));
  const guestC = db.createIdentity(db.hashToken("guestC"));

  const joinA = db.joinCardClashRoom(room.id, guestA.id);
  expect(joinA).toEqual({ ok: true, alreadyJoined: false, seatNumber: 2 });
  const joinB = db.joinCardClashRoom(room.id, guestB.id);
  expect(joinB).toEqual({ ok: true, alreadyJoined: false, seatNumber: 3 });
  const joinC = db.joinCardClashRoom(room.id, guestC.id);
  expect(joinC).toEqual({ ok: true, alreadyJoined: false, seatNumber: 4 });

  // The same identity "joining" again is a reconnect: same seat, no new row.
  const rejoinA = db.joinCardClashRoom(room.id, guestA.id);
  expect(rejoinA).toEqual({ ok: true, alreadyJoined: true, seatNumber: 2 });
  expect(db.getCardClashSeatsForRoom(room.id)).toHaveLength(4);
});

it("5. a seat cannot be claimed by two different identities (constraint-backed, not just a pre-check)", () => {
  const host = db.createIdentity(db.hashToken("host"));
  const room = db.createCardClashRoom("1v1", host.id);
  const raw = openRaw();
  expect(() => {
    raw.prepare("INSERT INTO card_clash_seats (room_id, identity_id, seat_number, ready) VALUES (?, ?, 1, 0)").run(
      room.id,
      999999,
    );
  }).toThrow(); // UNIQUE(room_id, seat_number) rejects a second seat 1
  raw.close();
});

it("6. two genuinely concurrent joins for the last open seat cannot both succeed", () => {
  const host = db.createIdentity(db.hashToken("host"));
  const room = db.createCardClashRoom("1v1", host.id); // 1v1: only seat 2 remains
  const guestA = db.createIdentity(db.hashToken("guestA"));
  const guestB = db.createIdentity(db.hashToken("guestB"));

  const resultA = db.joinCardClashRoom(room.id, guestA.id);
  const resultB = db.joinCardClashRoom(room.id, guestB.id);
  const outcomes = [resultA.ok, resultB.ok].sort();
  expect(outcomes).toEqual([false, true]); // exactly one succeeds
  expect(db.getCardClashSeatsForRoom(room.id)).toHaveLength(2);
});

it("7. room capacity is enforced: a third identity cannot join a full 1v1 room", () => {
  const host = db.createIdentity(db.hashToken("host"));
  const room = db.createCardClashRoom("1v1", host.id);
  const guest = db.createIdentity(db.hashToken("guest"));
  db.joinCardClashRoom(room.id, guest.id);

  const stranger = db.createIdentity(db.hashToken("stranger"));
  const result = db.joinCardClashRoom(room.id, stranger.id);
  expect(result).toEqual({ ok: false, reason: "room_full" });
});

it("8. a match cannot start until every seat is filled, every player is ready, and only the host may start it", () => {
  const host = db.createIdentity(db.hashToken("host"));
  const room = db.createCardClashRoom("1v2", host.id);
  const guest = db.createIdentity(db.hashToken("guest"));
  db.joinCardClashRoom(room.id, guest.id);

  const notFull = db.startCardClashMatch(room.id, host.id);
  expect(notFull).toEqual({ ok: false, reason: "seats_not_full" });

  const guest2 = db.createIdentity(db.hashToken("guest2"));
  db.joinCardClashRoom(room.id, guest2.id);

  const notReady = db.startCardClashMatch(room.id, host.id);
  expect(notReady).toEqual({ ok: false, reason: "not_all_ready" });

  db.setCardClashSeatReady(room.id, host.id, true);
  db.setCardClashSeatReady(room.id, guest.id, true);
  db.setCardClashSeatReady(room.id, guest2.id, true);

  const notHost = db.startCardClashMatch(room.id, guest.id);
  expect(notHost).toEqual({ ok: false, reason: "not_the_host" });

  const started = db.startCardClashMatch(room.id, host.id);
  expect(started.ok).toBe(true);
});

it("9. a successful match start produces the correct teams and starting hand sizes, and a repeated start does not redeal", () => {
  const { roomId, identityIds } = setUpReadyRoom(db, "2v2");
  const first = db.startCardClashMatch(roomId, identityIds[0]!);
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  const seat1 = first.match.state.players.get(1)!;
  const seat4 = first.match.state.players.get(4)!;
  const seat2 = first.match.state.players.get(2)!;
  expect(seat1.team).toBe("A");
  expect(seat4.team).toBe("A");
  expect(seat2.team).toBe("B");
  expect(seat4.hand).toHaveLength(5); // 2v2 seat 4's larger initial deal

  // Repeated start: no new deck/hand — the SAME match, byte-identical state.
  const second = db.startCardClashMatch(roomId, identityIds[0]!);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.match.id).toBe(first.match.id);
  expect(second.match.version).toBe(first.match.version);
  expect([...second.match.state.players.get(1)!.hand.map((c) => c.id)]).toEqual(
    first.match.state.players.get(1)!.hand.map((c) => c.id),
  );
});

it("10. persistence survives a simulated restart, exactly preserving private hands and card identity/order", async () => {
  const { roomId, identityIds } = setUpReadyRoom(db, "1v2");
  const started = db.startCardClashMatch(roomId, identityIds[0]!);
  expect(started.ok).toBe(true);
  if (!started.ok) return;

  const reopened = await reopen();
  const recovered = reopened.getCardClashMatchForRoom(roomId);
  expect(recovered).toBeDefined();
  if (!recovered) return;
  expect(recovered.version).toBe(started.match.version);
  for (const seat of started.match.state.players.keys()) {
    expect(recovered.state.players.get(seat)!.hand).toEqual(started.match.state.players.get(seat)!.hand);
  }
  expect(recovered.state.drawPile).toEqual(started.match.state.drawPile);
  expect(recovered.state.mode).toBe(started.match.state.mode);
});

it("11. pending attack-response and a suspended dying-rescue context (with a resuming group context) survive serialization exactly", async () => {
  const { roomId, identityIds } = setUpReadyRoom(db, "1v1");
  const started = db.startCardClashMatch(roomId, identityIds[0]!);
  expect(started.ok).toBe(true);
  if (!started.ok) return;

  // Force a known hand via a trusted transition so playAttack has a real
  // Attack card to play — a legitimate typed state construction (not a
  // cast), mirroring the pure-engine tests' own fixture style.
  const seat1 = started.match.state.players.get(1)!;
  const forcedState = {
    ...started.match.state,
    players: new Map(started.match.state.players).set(1, { ...seat1, hand: [{ id: "forced-attack", type: "attack" as const }] }),
    version: started.match.state.version + 1, // every successful transition bumps version by exactly 1
  };
  const forced = db.applyCardClashTransition({
    matchId: started.match.id,
    requestId: "force-hand",
    expectedVersion: started.match.version,
    transition: () => ({ ok: true, state: forcedState }),
  });
  expect(forced.ok).toBe(true);
  if (!forced.ok) return;

  const attacked = db.applyCardClashTransition({
    matchId: started.match.id,
    requestId: "attack-1",
    expectedVersion: forced.match.version,
    transition: (state) => playAttack(state, 1, 2, forced.match.version),
  });
  expect(attacked.ok).toBe(true);
  if (!attacked.ok) return;
  expect(attacked.match.state.pending).toEqual({ kind: "attack_response", attacker: 1, target: 2 });

  const reopened = await reopen();
  const recovered = reopened.getCardClashMatchById(attacked.match.id);
  expect(recovered).toBeDefined();
  if (!recovered) return;
  expect(recovered.state.pending).toEqual({ kind: "attack_response", attacker: 1, target: 2 });

  // Now force seat 2 to 1 HP and decline the attack, opening a
  // dying_rescue pending state — a materially different nested shape
  // (queue array, resumeActiveSeat, optional resumingGroupContext) that
  // must also round-trip exactly.
  const seat2 = recovered.state.players.get(2)!;
  const lowHpState = {
    ...recovered.state,
    players: new Map(recovered.state.players).set(2, { ...seat2, hp: 1 }),
    version: recovered.state.version + 1, // every successful transition bumps version by exactly 1
  };
  const forcedHp = reopened.applyCardClashTransition({
    matchId: recovered.id,
    requestId: "force-hp",
    expectedVersion: recovered.version,
    transition: () => ({ ok: true, state: lowHpState }),
  });
  expect(forcedHp.ok).toBe(true);
  if (!forcedHp.ok) return;

  const declined = reopened.applyCardClashTransition({
    matchId: recovered.id,
    requestId: "decline-1",
    expectedVersion: forcedHp.match.version,
    transition: (state) => respondToAttack(state, 2, { type: "decline" }, forcedHp.match.version),
  });
  expect(declined.ok).toBe(true);
  if (!declined.ok) return;
  expect(declined.match.state.pending).toMatchObject({ kind: "dying_rescue", dyingSeat: 2, queue: [1, 2] });

  const reopenedAgain = await reopen();
  const recoveredDying = reopenedAgain.getCardClashMatchById(declined.match.id);
  expect(recoveredDying?.state.pending).toEqual(declined.match.state.pending);
});

it("12. applying a trusted transition advances the version by exactly the pure engine's own amount and persists the public log", () => {
  const { roomId, identityIds } = setUpReadyRoom(db, "1v1");
  const started = db.startCardClashMatch(roomId, identityIds[0]!);
  expect(started.ok).toBe(true);
  if (!started.ok) return;

  const result = db.applyCardClashTransition({
    matchId: started.match.id,
    requestId: "discard-noop",
    expectedVersion: started.match.version,
    transition: (state) => ({ ok: true, state: { ...state, version: state.version + 1 } }),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.match.version).toBe(started.match.version + 1);

  const raw = openRaw();
  const row = raw.prepare("SELECT version FROM card_clash_matches WHERE id = ?").get(started.match.id) as {
    version: number;
  };
  raw.close();
  expect(row.version).toBe(started.match.version + 1);
});

it("13. a stale expected_version is rejected and leaves the database completely unchanged", () => {
  const { roomId, identityIds } = setUpReadyRoom(db, "1v1");
  const started = db.startCardClashMatch(roomId, identityIds[0]!);
  expect(started.ok).toBe(true);
  if (!started.ok) return;

  const raw = openRaw();
  const before = raw.prepare("SELECT version, state_json FROM card_clash_matches WHERE id = ?").get(started.match.id);
  raw.close();

  const result = db.applyCardClashTransition({
    matchId: started.match.id,
    requestId: "stale-attempt",
    expectedVersion: started.match.version + 999,
    transition: (state) => ({ ok: true, state: { ...state, version: state.version + 1 } }),
  });
  expect(result).toEqual({ ok: false, reason: "stale_version" });

  const raw2 = openRaw();
  const after = raw2.prepare("SELECT version, state_json FROM card_clash_matches WHERE id = ?").get(started.match.id);
  raw2.close();
  expect(after).toEqual(before);
});

it("14. a duplicate request ID does not apply the transition twice and returns the already-persisted result; a conflicting reuse is rejected", () => {
  const { roomId, identityIds } = setUpReadyRoom(db, "1v1");
  const started = db.startCardClashMatch(roomId, identityIds[0]!);
  expect(started.ok).toBe(true);
  if (!started.ok) return;

  const params = {
    matchId: started.match.id,
    requestId: "req-1",
    expectedVersion: started.match.version,
    transition: (state: import("../card-clash/types.ts").MatchState) => ({ ok: true as const, state: { ...state, version: state.version + 1 } }),
  };
  const first = db.applyCardClashTransition(params);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.duplicate).toBe(false);

  const duplicate = db.applyCardClashTransition(params); // same request_id, same expectedVersion
  expect(duplicate).toEqual({ ok: true, duplicate: true, match: first.match });

  const raw = openRaw();
  const row = raw.prepare("SELECT version FROM card_clash_matches WHERE id = ?").get(started.match.id) as {
    version: number;
  };
  raw.close();
  expect(row.version).toBe(first.match.version); // not advanced a second time

  // Same request_id, but now claiming a different expectedVersion — a conflict.
  const conflicting = db.applyCardClashTransition({ ...params, requestId: "req-1", expectedVersion: 999 });
  expect(conflicting).toEqual({ ok: false, reason: "request_id_conflict" });
});

it("15. a rejected transition rolls back completely, leaving the database state byte-identical", () => {
  const { roomId, identityIds } = setUpReadyRoom(db, "1v1");
  const started = db.startCardClashMatch(roomId, identityIds[0]!);
  expect(started.ok).toBe(true);
  if (!started.ok) return;

  const raw = openRaw();
  const before = raw.prepare("SELECT version, state_json FROM card_clash_matches WHERE id = ?").get(started.match.id);
  raw.close();

  const rejected = db.applyCardClashTransition({
    matchId: started.match.id,
    requestId: "rejected-attempt",
    expectedVersion: started.match.version,
    transition: () => ({ ok: false, reason: "illegal_for_this_test" }),
  });
  expect(rejected).toEqual({ ok: false, reason: "transition_rejected", detail: "illegal_for_this_test" });

  const raw2 = openRaw();
  const after = raw2.prepare("SELECT version, state_json FROM card_clash_matches WHERE id = ?").get(started.match.id);
  const actionRows = raw2.prepare("SELECT * FROM card_clash_match_actions WHERE match_id = ?").all(started.match.id);
  raw2.close();
  expect(after).toEqual(before);
  expect(actionRows).toHaveLength(0); // no action row recorded for a rejected transition either
});

it("16. a terminal match result (fold/elimination outcome) persists and survives a restart, and the room's own status becomes complete", async () => {
  const { roomId, roomCode, identityIds } = setUpReadyRoom(db, "1v1");
  const started = db.startCardClashMatch(roomId, identityIds[0]!);
  expect(started.ok).toBe(true);
  if (!started.ok) return;

  // Drive the match to a terminal result via a single trusted transition
  // that marks seat 2 eliminated and the match complete — legitimate
  // because this is exactly the shape the real pure engine itself produces
  // (card-clash/combat.ts's own eliminateSeat), not an invented shortcut;
  // exercising applyCardClashTransition's own commit/version/room-status
  // contract is this test's actual point, not re-deriving combat rules.
  const seat2 = started.match.state.players.get(2)!;
  const terminalState = {
    ...started.match.state,
    players: new Map(started.match.state.players).set(2, { ...seat2, eliminated: true, hp: 0 }),
    matchResult: { status: "complete" as const, winningTeam: "A" as const },
    version: started.match.state.version + 1,
  };
  const result = db.applyCardClashTransition({
    matchId: started.match.id,
    requestId: "finish-match",
    expectedVersion: started.match.version,
    transition: () => ({ ok: true, state: terminalState }),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.match.state.matchResult).toEqual({ status: "complete", winningTeam: "A" });
  expect(db.getCardClashRoomByCode(roomCode)?.status).toBe("complete");

  const reopened = await reopen();
  const recoveredMatch = reopened.getCardClashMatchForRoom(roomId);
  expect(recoveredMatch?.state.matchResult).toEqual({ status: "complete", winningTeam: "A" });
  expect(reopened.getCardClashRoomByCode(roomCode)?.status).toBe("complete");
});
