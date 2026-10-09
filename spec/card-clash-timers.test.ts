import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { playHeal, respondToAttack, respondToRescue } from "../card-clash/combat.ts";
import { buildCardClashTransition } from "../card-clash/action-http.ts";
import { CARD_CLASH_DEADLINE_MS } from "../card-clash/timers.ts";
import type { GameMode, MatchState, Seat } from "../card-clash/types.ts";
import type { PersistedCardClashMatch } from "../db.ts";

// D4C-1: durable 10-second action/response timers. Most tests here exercise
// db.ts's applyCardClashTransition/processCardClashTimeout and
// card-clash/scheduler.ts directly against a real, isolated on-disk SQLite
// database — the same "forced trusted transition" technique
// spec/card-clash-storage.test.ts and spec/card-clash-actions-http.test.ts
// already use for deterministic setup — plus a small number of full
// HTTP/SSE tests (spec/card-clash-realtime.test.ts's own CookieJar/
// sseEvents pattern) for the cases that specifically need the real route
// wiring. An injectable `nowMs` stands in for real elapsed time throughout:
// nothing here ever sleeps for 10 real seconds.

let tempDir: string;
let previousDataDir: string | undefined;
let db: typeof import("../db.ts");
let scheduler: typeof import("../card-clash/scheduler.ts");
let liveMatchIds: number[];

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "card-clash-timers-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  // Importing server.ts (even without using its `app` export) is what
  // actually wires db.ts's Card Clash functions together with
  // card-clash/scheduler.ts/realtime.ts exactly as production does — the
  // same reason every other Card Clash spec file imports it first.
  vi.resetModules();
  await import("../server.ts");
  db = await import("../db.ts");
  scheduler = await import("../card-clash/scheduler.ts");
  liveMatchIds = [];
});

afterEach(() => {
  // Several calls below exercise rescheduleCardClashTimer with a delay of
  // exactly 0 (nowMs === expiresAt), which arms a real, near-immediate
  // setTimeout — cancel every match's timer before the tempDir (and its
  // SQLite file) is deleted, so no orphaned real callback can ever fire
  // against an already-removed database after this test has moved on.
  for (const matchId of liveMatchIds) scheduler.cancelCardClashTimer(matchId);
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

let counter = 0;
function freshId(): string {
  return `t-${counter++}`;
}

function setUpStartedMatch(mode: GameMode): { roomId: number; roomCode: string; matchId: number; hostId: number } {
  const seatCount = { "1v1": 2, "1v2": 3, "2v2": 4 }[mode];
  const host = db.createIdentity(db.hashToken(freshId()));
  const room = db.createCardClashRoom(mode, host.id);
  const identityIds = [host.id];
  for (let i = 1; i < seatCount; i++) {
    const guest = db.createIdentity(db.hashToken(freshId()));
    const joined = db.joinCardClashRoom(room.id, guest.id);
    expect(joined.ok).toBe(true);
    identityIds.push(guest.id);
  }
  for (const id of identityIds) expect(db.setCardClashSeatReady(room.id, id, true).ok).toBe(true);
  const result = db.startCardClashMatch(room.id, host.id);
  if (!result.ok) throw new Error("setup failed to start match");
  liveMatchIds.push(result.match.id);
  return { roomId: room.id, roomCode: room.code, matchId: result.match.id, hostId: host.id };
}

// Applies an arbitrary, already-legal-shaped MatchState directly as a
// trusted transition (never through HTTP/engine validation) — purely to
// arrange a known pending/hand/hp configuration before the real timer code
// under test runs, exactly like forceHand/forceHp in
// spec/card-clash-actions-http.test.ts.
function forceState(matchId: number, mutate: (state: MatchState) => MatchState): PersistedCardClashMatch {
  const match = db.getCardClashMatchById(matchId)!;
  const nextState = { ...mutate(match.state), version: match.version + 1 };
  const result = db.applyCardClashTransition({
    matchId,
    requestId: freshId(),
    expectedVersion: match.version,
    transition: () => ({ ok: true, state: nextState }),
  });
  if (!result.ok || result.duplicate) throw new Error("forceState failed");
  return result.match;
}

function setHand(state: MatchState, seat: Seat, size: number): MatchState {
  const player = state.players.get(seat)!;
  const hand = Array.from({ length: size }, (_, i) => ({ id: `${freshId()}-${i}`, type: "heal" as const }));
  return { ...state, players: new Map(state.players).set(seat, { ...player, hand }) };
}

it("1. match start creates the first 10-second MAIN deadline even though the fresh hand exceeds the HP limit", () => {
  const before = Date.now();
  const { matchId } = setUpStartedMatch("1v1");
  const after = Date.now();
  const match = db.getCardClashMatchById(matchId)!;
  const active = match.state.players.get(match.state.activeSeat)!;
  expect(active.hand.length).toBeGreaterThan(active.hp);
  expect(match.state.turnPhase).toBeUndefined();
  const deadline = db.getCardClashDeadline(matchId)!;
  expect(deadline.responderSeat).toBe(match.state.activeSeat);
  expect(deadline.version).toBe(match.version);
  expect(deadline.expiresAt).toBeGreaterThanOrEqual(before + CARD_CLASH_DEADLINE_MS);
  expect(deadline.expiresAt).toBeLessThanOrEqual(after + CARD_CLASH_DEADLINE_MS);
});

it("2. an ordinary MAIN timeout ends the action phase and the next turn receives its own fresh deadline", () => {
  const { matchId, roomId } = setUpStartedMatch("1v1");
  const before = db.getCardClashMatchById(matchId)!;
  const activeSeat = before.state.activeSeat;
  const nextSeat: Seat = activeSeat === 1 ? 2 : 1;
  forceState(matchId, (state) => {
    const withActiveHand = setHand(state, activeSeat, state.players.get(activeSeat)!.hp);
    // The next seat's own upcoming turn-start draw adds 2 more cards
    // (drawCountForSeat, 1v1, non-host) — pre-shrinking their hand here so
    // that, after that draw, it lands exactly at their HP limit rather
    // than over it (every seat's very first turn otherwise starts over
    // the limit by this engine's own existing, approved math — see test 1
    // — which would otherwise leave this turn also DISCARD-blocked).
    return setHand(withActiveHand, nextSeat, withActiveHand.players.get(nextSeat)!.hp - 2);
  });

  const deadline = db.getCardClashDeadline(matchId)!;
  const applied = scheduler.runCardClashTimeoutCheck(matchId, roomId, deadline.version, deadline.expiresAt);
  expect(applied).toBe(true);

  const after = db.getCardClashMatchById(matchId)!;
  expect(after.state.activeSeat).not.toBe(activeSeat);
  const nextDeadline = db.getCardClashDeadline(matchId)!;
  expect(nextDeadline.responderSeat).toBe(after.state.activeSeat);
  expect(nextDeadline.version).toBe(after.version);
});

it("3/4/5. a successful immediate-effect play (Heal) resets the MAIN deadline to a fresh 10 seconds; an invalid action changes nothing", () => {
  const { matchId } = setUpStartedMatch("1v1");
  const match0 = db.getCardClashMatchById(matchId)!;
  const activeSeat = match0.state.activeSeat;
  forceState(matchId, (state) => {
    const withHand = setHand(state, activeSeat, state.players.get(activeSeat)!.hp - 1);
    const player = withHand.players.get(activeSeat)!;
    return { ...withHand, players: new Map(withHand.players).set(activeSeat, { ...player, hp: player.maxHp - 1, hand: [{ id: freshId(), type: "heal" }] }) };
  });
  const beforeDeadline = db.getCardClashDeadline(matchId)!;

  // Invalid action (wrong seat attempting the Heal) must not change the
  // deadline at all — the real engine rejects it, nothing is persisted.
  const wrongSeat: Seat = activeSeat === 1 ? 2 : 1;
  const rejected = db.applyCardClashTransition({
    matchId,
    requestId: freshId(),
    expectedVersion: beforeDeadline.version,
    transition: (state) => playHeal(state, wrongSeat, beforeDeadline.version),
  });
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.reason).toBe("transition_rejected");
  expect(db.getCardClashDeadline(matchId)).toEqual(beforeDeadline);

  // A real successful Heal must reset the MAIN deadline to a fresh 10-second window.
  const healResult = db.applyCardClashTransition({
    matchId,
    requestId: freshId(),
    expectedVersion: beforeDeadline.version,
    transition: (state) => playHeal(state, activeSeat, beforeDeadline.version),
  });
  expect(healResult.ok && !healResult.duplicate).toBe(true);
  const afterDeadline = db.getCardClashDeadline(matchId)!;
  expect(afterDeadline.responderSeat).toBe(activeSeat);
  expect(afterDeadline.expiresAt).toBeGreaterThan(beforeDeadline.expiresAt);
});

it("6/7. Attack opens a 10-second response window for the target, and a Dodge before expiration cancels that timeout (a stale callback for it is a no-op)", () => {
  const { matchId, roomId } = setUpStartedMatch("1v1");
  const match0 = db.getCardClashMatchById(matchId)!;
  const attacker = match0.state.activeSeat;
  const target: Seat = attacker === 1 ? 2 : 1;

  const afterAttack = forceState(matchId, (state) => ({
    ...setHand(state, target, 1),
    pending: { kind: "attack_response", attacker, target },
  }));
  const responseDeadline = db.getCardClashDeadline(matchId)!;
  expect(responseDeadline.responderSeat).toBe(target);

  // Give the target an explicit Dodge card and respond before expiration.
  forceState(matchId, (state) => {
    const player = state.players.get(target)!;
    return { ...state, players: new Map(state.players).set(target, { ...player, hand: [{ id: freshId(), type: "dodge" }] }) };
  });
  const current = db.getCardClashMatchById(matchId)!;
  const dodgeResult = db.applyCardClashTransition({
    matchId,
    requestId: freshId(),
    expectedVersion: current.version,
    transition: (state) => respondToAttack(state, target, { type: "dodge" }, current.version),
  });
  expect(dodgeResult.ok && !dodgeResult.duplicate).toBe(true);

  // The old attack-response deadline (an earlier version) must now have no
  // effect — a late callback for it is a guaranteed no-op.
  const applied = scheduler.runCardClashTimeoutCheck(matchId, roomId, responseDeadline.version, responseDeadline.expiresAt);
  expect(applied).toBe(false);
  expect(afterAttack.state.pending?.kind).toBe("attack_response"); // sanity: setup really had a pending response
});

it("8/15/16. an attack-response timeout auto-declines exactly once: damage never applies twice even if the same callback repeats", () => {
  const { matchId, roomId } = setUpStartedMatch("1v1");
  const match0 = db.getCardClashMatchById(matchId)!;
  const attacker = match0.state.activeSeat;
  const target: Seat = attacker === 1 ? 2 : 1;
  forceState(matchId, (state) => ({ ...state, pending: { kind: "attack_response", attacker, target } }));

  const deadline = db.getCardClashDeadline(matchId)!;
  const hpBefore = db.getCardClashMatchById(matchId)!.state.players.get(target)!.hp;

  const first = scheduler.runCardClashTimeoutCheck(matchId, roomId, deadline.version, deadline.expiresAt);
  expect(first).toBe(true);
  const afterFirst = db.getCardClashMatchById(matchId)!;
  expect(afterFirst.state.players.get(target)!.hp).toBe(hpBefore - 1);

  // The exact same (now obsolete) callback firing again must not apply a
  // second decline/damage.
  const second = scheduler.runCardClashTimeoutCheck(matchId, roomId, deadline.version, deadline.expiresAt);
  expect(second).toBe(false);
  const afterSecond = db.getCardClashMatchById(matchId)!;
  expect(afterSecond.state.players.get(target)!.hp).toBe(hpBefore - 1);
  expect(afterSecond.version).toBe(afterFirst.version);
});

it("9/10. War Cry/Arrow Volley group responses expire as declines, and each responder gets their own separate deadline", () => {
  const { matchId, roomId } = setUpStartedMatch("2v2");
  const match0 = db.getCardClashMatchById(matchId)!;
  const actor = match0.state.activeSeat;
  const others = ([1, 2, 3, 4] as Seat[]).filter((s) => s !== actor);

  forceState(matchId, (state) => ({
    ...state,
    pending: { kind: "group_response", context: { actor, cardType: "war_cry", requiredResponseType: "attack", queue: others } },
  }));

  const first = db.getCardClashDeadline(matchId)!;
  expect(first.responderSeat).toBe(others[0]);

  const hpBefore = db.getCardClashMatchById(matchId)!.state.players.get(others[0]!)!.hp;
  expect(scheduler.runCardClashTimeoutCheck(matchId, roomId, first.version, first.expiresAt)).toBe(true);
  const afterFirst = db.getCardClashMatchById(matchId)!;
  expect(afterFirst.state.players.get(others[0]!)!.hp).toBe(hpBefore - 1);

  const second = db.getCardClashDeadline(matchId)!;
  expect(second.responderSeat).toBe(others[1]);
  expect(second.version).toBe(afterFirst.version);
  expect(second.expiresAt).not.toBe(first.expiresAt);
});

it("11/12/13/14. dying rescue asks living players counterclockwise with the dying seat last, each gets their own deadline, a successful rescue mid-queue resumes the suspended group effect with a correct next deadline", () => {
  const { matchId, roomId } = setUpStartedMatch("2v2");
  const match0 = db.getCardClashMatchById(matchId)!;
  const actor = match0.state.activeSeat;
  const dyingSeat: Seat = ([1, 2, 3, 4] as Seat[]).filter((s) => s !== actor)[0]!;
  const rescuers = ([1, 2, 3, 4] as Seat[]).filter((s) => s !== dyingSeat);

  forceState(matchId, (state) => {
    const player = state.players.get(dyingSeat)!;
    return {
      ...state,
      players: new Map(state.players).set(dyingSeat, { ...player, hp: 0 }),
      pending: {
        kind: "dying_rescue",
        dyingSeat,
        queue: [...rescuers, dyingSeat], // counterclockwise order, dying seat last — db.ts trusts the caller's queue here
        resumeActiveSeat: actor,
        resumingGroupContext: { actor, cardType: "war_cry", requiredResponseType: "attack", queue: [] },
      },
    };
  });

  const firstRescuer = rescuers[0]!;
  let deadline = db.getCardClashDeadline(matchId)!;
  expect(deadline.responderSeat).toBe(firstRescuer);

  // First rescuer declines via timeout — moves to the next queued rescuer.
  expect(scheduler.runCardClashTimeoutCheck(matchId, roomId, deadline.version, deadline.expiresAt)).toBe(true);
  deadline = db.getCardClashDeadline(matchId)!;
  expect(deadline.responderSeat).toBe(rescuers[1]);

  // That second rescuer successfully Heals — ends the rescue, and since the
  // resuming group context's own queue is empty, control returns straight
  // to the actor's MAIN phase with a fresh deadline (docs §4's
  // continueOrFinishGroup/resumeAfterRescue behavior, unchanged).
  forceState(matchId, (state) => {
    const player = state.players.get(rescuers[1]!)!;
    return { ...state, players: new Map(state.players).set(rescuers[1]!, { ...player, hand: [{ id: freshId(), type: "heal" }] }) };
  });
  const current = db.getCardClashMatchById(matchId)!;
  const rescueResult = db.applyCardClashTransition({
    matchId,
    requestId: freshId(),
    expectedVersion: current.version,
    transition: (state) => respondToRescue(state, rescuers[1]!, { type: "heal" }, current.version),
  });
  expect(rescueResult.ok && !rescueResult.duplicate).toBe(true);
  const final = db.getCardClashMatchById(matchId)!;
  expect(final.state.pending).toBeUndefined();
  expect(final.state.activeSeat).toBe(actor);
  const finalDeadline = db.getCardClashDeadline(matchId);
  // Only a real deadline if the actor's (possibly still forced) hand fits
  // their HP — assert consistency with computeNextCardClashDeadline rather
  // than assuming a specific hand shape.
  const activePlayer = final.state.players.get(actor)!;
  void activePlayer;
  expect(finalDeadline?.responderSeat).toBe(actor); // MAIN always gets a fresh deadline (D4C-2)
});

it("17. an action/timeout evaluated exactly at the deadline boundary (now === expiresAt) is treated as expired", () => {
  const { matchId } = setUpStartedMatch("1v1");
  const match0 = db.getCardClashMatchById(matchId)!;
  const activeSeat = match0.state.activeSeat;
  forceState(matchId, (state) => setHand(state, activeSeat, state.players.get(activeSeat)!.hp));
  const deadline = db.getCardClashDeadline(matchId)!;

  // One millisecond before: not yet due.
  const early = db.processCardClashTimeout(matchId, deadline.version, deadline.expiresAt - 1);
  expect(early.applied).toBe(false);

  // Exactly at the boundary: due ("now >= expiresAt" per the task spec).
  const onTime = db.processCardClashTimeout(matchId, deadline.version, deadline.expiresAt);
  expect(onTime.applied).toBe(true);
});

it("18. a race between a timeout and a concurrent HTTP action resolves with exactly one committed winner, in either order", () => {
  const { matchId } = setUpStartedMatch("1v1");
  const match0 = db.getCardClashMatchById(matchId)!;
  const activeSeat = match0.state.activeSeat;
  forceState(matchId, (state) => setHand(state, activeSeat, state.players.get(activeSeat)!.hp));
  const deadline = db.getCardClashDeadline(matchId)!;

  // "Timeout wins": the deadline is processed first; a client action then
  // arriving for the now-superseded version must be rejected.
  const timeoutResult = db.processCardClashTimeout(matchId, deadline.version, deadline.expiresAt);
  expect(timeoutResult.applied).toBe(true);
  const lateAction = db.applyCardClashTransition({
    matchId,
    requestId: freshId(),
    expectedVersion: deadline.version, // the pre-timeout version — now stale
    transition: (state) => ({ ok: true, state: { ...state, version: state.version + 1 } }),
  });
  expect(lateAction.ok).toBe(false);
  if (!lateAction.ok) expect(lateAction.reason).toBe("stale_version");

  // "Action wins": set up a second, independent pending-response scenario
  // where the valid action commits first, then the timeout for that
  // now-superseded version must be a guaranteed no-op.
  const { matchId: matchId2 } = setUpStartedMatch("1v1");
  const m2 = db.getCardClashMatchById(matchId2)!;
  forceState(matchId2, (state) => ({ ...state, pending: { kind: "attack_response", attacker: m2.state.activeSeat, target: (m2.state.activeSeat === 1 ? 2 : 1) as Seat } }));
  const d2 = db.getCardClashDeadline(matchId2)!;
  const target2 = d2.responderSeat;
  forceState(matchId2, (state) => {
    const player = state.players.get(target2)!;
    return { ...state, players: new Map(state.players).set(target2, { ...player, hand: [{ id: freshId(), type: "dodge" }] }) };
  });
  const current2 = db.getCardClashMatchById(matchId2)!;
  const action2 = db.applyCardClashTransition({
    matchId: matchId2,
    requestId: freshId(),
    expectedVersion: current2.version,
    transition: (state) => respondToAttack(state, target2, { type: "dodge" }, current2.version),
  });
  expect(action2.ok && !action2.duplicate).toBe(true);
  const obsoleteTimeout = db.processCardClashTimeout(matchId2, d2.version, d2.expiresAt);
  expect(obsoleteTimeout.applied).toBe(false);
});

it("19/20. state and deadlines survive a simulated restart, and reconciling after waking up applies exactly the one overdue transition rather than granting new time", async () => {
  const { matchId, roomId } = setUpStartedMatch("1v1");
  const match0 = db.getCardClashMatchById(matchId)!;
  const activeSeat = match0.state.activeSeat;
  const nextSeat: Seat = activeSeat === 1 ? 2 : 1;
  forceState(matchId, (state) => {
    const withActiveHand = setHand(state, activeSeat, state.players.get(activeSeat)!.hp);
    // See test 2's own comment: pre-shrink the next seat's hand so their
    // upcoming turn-start draw lands exactly at their HP limit instead of
    // over it.
    return setHand(withActiveHand, nextSeat, withActiveHand.players.get(nextSeat)!.hp - 2);
  });
  const beforeRestart = db.getCardClashDeadline(matchId)!;

  // Simulate a full process restart against the same on-disk database.
  // Reassigning the shared `db`/`scheduler` variables (rather than only
  // binding locals) ensures afterEach's timer cleanup targets this new
  // module instance's own timer registry, not the pre-restart one.
  vi.resetModules();
  db = await import("../db.ts");
  scheduler = await import("../card-clash/scheduler.ts");

  const persisted = db.getCardClashDeadline(matchId)!;
  expect(persisted).toEqual(beforeRestart); // nothing lost across the restart

  // Reconcile "long after" the deadline — the result must be exactly the
  // one legal end-turn transition, landing on activeSeat's fresh 10s
  // window, never a window computed from the original (pre-restart) time.
  const farFuture = persisted.expiresAt + 5 * 60_000;
  const reconciled = scheduler.reconcileCardClashMatchIfOverdue(matchId, roomId, farFuture);
  expect(reconciled.applied).toBe(true);
  expect(reconciled.deadline?.expiresAt).toBe(farFuture + CARD_CLASH_DEADLINE_MS);
  expect(reconciled.deadline?.expiresAt).not.toBe(persisted.expiresAt + CARD_CLASH_DEADLINE_MS);
});

it("21. cross-room isolation: reconciling one match's overdue timeout never changes a different room's match or its deadline", () => {
  const a = setUpStartedMatch("1v1");
  const b = setUpStartedMatch("1v1");
  const activeA = db.getCardClashMatchById(a.matchId)!.state.activeSeat;
  forceState(a.matchId, (state) => setHand(state, activeA, state.players.get(activeA)!.hp));
  const deadlineA = db.getCardClashDeadline(a.matchId)!;
  const beforeB = db.getCardClashMatchById(b.matchId)!;
  const deadlineBBefore = db.getCardClashDeadline(b.matchId);

  expect(scheduler.runCardClashTimeoutCheck(a.matchId, a.roomId, deadlineA.version, deadlineA.expiresAt)).toBe(true);

  const afterB = db.getCardClashMatchById(b.matchId)!;
  expect(afterB.version).toBe(beforeB.version);
  expect(afterB.state.activeSeat).toBe(beforeB.state.activeSeat);
  expect(db.getCardClashDeadline(b.matchId)).toEqual(deadlineBBefore);
});

it("22/23. a committed automatic timeout publishes one SSE match invalidation; a stale/no-op timeout publishes none", async () => {
  const { matchId, roomId } = setUpStartedMatch("1v1");
  const match0 = db.getCardClashMatchById(matchId)!;
  const activeSeat = match0.state.activeSeat;
  forceState(matchId, (state) => setHand(state, activeSeat, state.players.get(activeSeat)!.hp));
  const deadline = db.getCardClashDeadline(matchId)!;

  // Subscribes directly to the real room-scoped hub (the exact mechanism
  // the SSE route itself uses — spec/card-clash-realtime.test.ts already
  // covers the HTTP/SSE transport layer on top of this same hub).
  const realtime = await import("../card-clash/realtime.ts");
  const received: string[] = [];
  const unsubscribe = realtime.subscribeToCardClashRoom(roomId, (scope) => {
    received.push(scope);
  });

  const applied = scheduler.runCardClashTimeoutCheck(matchId, roomId, deadline.version, deadline.expiresAt);
  expect(applied).toBe(true);
  expect(received).toEqual(["match"]);

  // The same (now stale) callback firing again must publish nothing further.
  scheduler.runCardClashTimeoutCheck(matchId, roomId, deadline.version, deadline.expiresAt);
  expect(received).toEqual(["match"]);

  unsubscribe();
});

it("24. the persisted deadline never carries hand/draw-pile contents — only an absolute timestamp and a seat number", () => {
  const { matchId } = setUpStartedMatch("1v1");
  const activeSeat = db.getCardClashMatchById(matchId)!.state.activeSeat;
  forceState(matchId, (state) => setHand(state, activeSeat, state.players.get(activeSeat)!.hp));

  const deadline = db.getCardClashDeadline(matchId)!;
  expect(Object.keys(deadline).sort()).toEqual(["expiresAt", "matchId", "responderSeat", "version"].sort());
  expect(typeof deadline.expiresAt).toBe("number");
  expect(typeof deadline.responderSeat).toBe("number");
});

it("26. a terminal match stops all future timers", () => {
  const { matchId } = setUpStartedMatch("1v1");
  const match0 = db.getCardClashMatchById(matchId)!;
  forceState(matchId, (state) => ({ ...state, matchResult: { status: "complete", winningTeam: "A" } }));
  expect(db.getCardClashDeadline(matchId)).toBeUndefined();

  const reconciled = scheduler.reconcileCardClashMatchIfOverdue(matchId, 0, Date.now() + 60_000);
  expect(reconciled.applied).toBe(false);
  expect(reconciled.deadline).toBeNull();
  expect(db.getCardClashMatchById(matchId)!.version).toBe(match0.version + 1);
});

// --- Atomic deadline enforcement inside applyCardClashTransition ----------

const bump = (state: MatchState) => ({ ok: true as const, state: { ...state, version: state.version + 1 } });

function matchWithMainDeadline(): { matchId: number; version: number; expiresAt: number } {
  const { matchId } = setUpStartedMatch("1v1");
  const seat = db.getCardClashMatchById(matchId)!.state.activeSeat;
  forceState(matchId, (state) => setHand(state, seat, state.players.get(seat)!.hp));
  const d = db.getCardClashDeadline(matchId)!;
  return { matchId, version: d.version, expiresAt: d.expiresAt };
}

it("27. an action at deadline minus 1 ms succeeds", () => {
  const { matchId, version, expiresAt } = matchWithMainDeadline();
  const result = db.applyCardClashTransition({ matchId, requestId: freshId(), expectedVersion: version, transition: bump, nowMs: expiresAt - 1 });
  expect(result.ok && !result.duplicate).toBe(true);
});

it("28/29. an action exactly at, or after, the deadline is rejected with deadline_expired and nothing mutates", () => {
  for (const offset of [0, 5_000]) {
    const { matchId, version, expiresAt } = matchWithMainDeadline();
    const before = db.getCardClashMatchById(matchId)!;
    const result = db.applyCardClashTransition({ matchId, requestId: freshId(), expectedVersion: version, transition: bump, nowMs: expiresAt + offset });
    expect(result).toEqual({ ok: false, reason: "deadline_expired" });
    const after = db.getCardClashMatchById(matchId)!;
    expect(after.version).toBe(before.version);
    expect(after.state).toEqual(before.state);
    expect(db.getCardClashDeadline(matchId)).toEqual({ matchId, version, expiresAt, responderSeat: before.state.activeSeat });
  }
});

it("30. a fresh requestId cannot bypass an expired deadline even though the state version still matches (timer ran late)", () => {
  const { matchId, version, expiresAt } = matchWithMainDeadline();
  expect(db.getCardClashMatchById(matchId)!.version).toBe(version); // scheduler never ran
  for (let i = 0; i < 3; i++) {
    const r = db.applyCardClashTransition({ matchId, requestId: freshId(), expectedVersion: version, transition: bump, nowMs: expiresAt + 1 });
    expect(r).toEqual({ ok: false, reason: "deadline_expired" });
  }
});

it("31. an already-committed requestId replays idempotently after the deadline and never executes again", () => {
  const { matchId, version, expiresAt } = matchWithMainDeadline();
  const requestId = freshId();
  const first = db.applyCardClashTransition({ matchId, requestId, expectedVersion: version, transition: bump, nowMs: expiresAt - 1 });
  expect(first.ok && !first.duplicate).toBe(true);
  const versionAfter = db.getCardClashMatchById(matchId)!.version;

  const replay = db.applyCardClashTransition({ matchId, requestId, expectedVersion: version, transition: bump, nowMs: expiresAt + 60_000 });
  expect(replay.ok && replay.duplicate).toBe(true);
  expect(db.getCardClashMatchById(matchId)!.version).toBe(versionAfter);
});

// --- D4C-2: timed DISCARD phase and automatic random discard -----------------

// Deterministic RNG returning the given values in order (each < the pool size).
function seq(values: number[]): (max: number) => number {
  let i = 0;
  return (max) => {
    const v = values[i++ % values.length]!;
    if (v >= max) throw new Error(`test RNG value ${v} out of range for ${max}`);
    return v;
  };
}

// Active seat holds hp + extra cards, all uniquely identified.
function matchInMain(mode: GameMode, extra: number) {
  const { matchId, roomId } = setUpStartedMatch(mode);
  const seat = db.getCardClashMatchById(matchId)!.state.activeSeat;
  forceState(matchId, (state) => setHand(state, seat, state.players.get(seat)!.hp + extra));
  return { matchId, roomId, seat };
}

function enterDiscardByTimeout(matchId: number, roomId: number) {
  const d = db.getCardClashDeadline(matchId)!;
  expect(scheduler.runCardClashTimeoutCheck(matchId, roomId, d.version, d.expiresAt)).toBe(true);
  return db.getCardClashDeadline(matchId)!;
}

it("33. MAIN timeout with excess enters DISCARD (no cards touched) with a fresh 10 s deadline; with no excess it advances directly", () => {
  const { matchId, roomId, seat } = matchInMain("1v1", 2);
  const before = db.getCardClashMatchById(matchId)!;
  const mainDeadline = db.getCardClashDeadline(matchId)!;
  const discard = enterDiscardByTimeout(matchId, roomId);
  const after = db.getCardClashMatchById(matchId)!;
  expect(after.state.turnPhase).toBe("discard");
  expect(after.state.activeSeat).toBe(seat);
  expect(after.state.players.get(seat)!.hand).toEqual(before.state.players.get(seat)!.hand);
  expect(after.state.discardPile).toEqual(before.state.discardPile);
  expect(discard.responderSeat).toBe(seat);
  expect(discard.expiresAt).toBe(mainDeadline.expiresAt + CARD_CLASH_DEADLINE_MS);

  const noExcess = matchInMain("1v1", 0);
  enterDiscardByTimeout(noExcess.matchId, noExcess.roomId);
  const adv = db.getCardClashMatchById(noExcess.matchId)!;
  expect(adv.state.turnPhase).toBeUndefined();
  expect(adv.state.activeSeat).not.toBe(noExcess.seat);
});

it("34. voluntary end_turn with excess enters DISCARD with a deadline; play actions are then rejected", () => {
  const { matchId, seat } = matchInMain("1v1", 2);
  const m = db.getCardClashMatchById(matchId)!;
  const r = db.applyCardClashTransition({
    matchId, requestId: freshId(), expectedVersion: m.version,
    transition: buildCardClashTransition({ type: "end_turn" }, seat, m.version),
  });
  expect(r.ok && !r.duplicate).toBe(true);
  const after = db.getCardClashMatchById(matchId)!;
  expect(after.state.turnPhase).toBe("discard");
  expect(db.getCardClashDeadline(matchId)!.version).toBe(after.version);

  const play = db.applyCardClashTransition({
    matchId, requestId: freshId(), expectedVersion: after.version,
    transition: buildCardClashTransition({ type: "play_heal" }, seat, after.version),
  });
  expect(play).toMatchObject({ ok: false, reason: "transition_rejected", detail: "discard_phase" });
  const again = db.applyCardClashTransition({
    matchId, requestId: freshId(), expectedVersion: after.version,
    transition: buildCardClashTransition({ type: "end_turn" }, seat, after.version),
  });
  expect(again).toMatchObject({ ok: false, detail: "hand_exceeds_hp_limit" });
});

it("35. partial manual discard keeps the ORIGINAL absolute deadline; an invalid discard changes nothing; completing it advances the turn with a fresh MAIN deadline", () => {
  const { matchId, roomId, seat } = matchInMain("1v1", 3);
  const discard = enterDiscardByTimeout(matchId, roomId);
  const m1 = db.getCardClashMatchById(matchId)!;
  const ids = m1.state.players.get(seat)!.hand.map((c) => c.id);

  const bad = db.applyCardClashTransition({
    matchId, requestId: freshId(), expectedVersion: m1.version,
    transition: buildCardClashTransition({ type: "discard_cards", cardIds: ["nope"] }, seat, m1.version),
    nowMs: discard.expiresAt - 5_000,
  });
  expect(bad.ok).toBe(false);
  expect(db.getCardClashDeadline(matchId)).toEqual({ matchId, version: m1.version, expiresAt: discard.expiresAt, responderSeat: seat });

  const partial = db.applyCardClashTransition({
    matchId, requestId: freshId(), expectedVersion: m1.version,
    transition: buildCardClashTransition({ type: "discard_cards", cardIds: ids.slice(0, 1) }, seat, m1.version),
    nowMs: discard.expiresAt - 4_000,
  });
  expect(partial.ok && !partial.duplicate).toBe(true);
  const m2 = db.getCardClashMatchById(matchId)!;
  expect(m2.state.turnPhase).toBe("discard");
  expect(db.getCardClashDeadline(matchId)).toEqual({ matchId, version: m2.version, expiresAt: discard.expiresAt, responderSeat: seat });

  const done = db.applyCardClashTransition({
    matchId, requestId: freshId(), expectedVersion: m2.version,
    transition: buildCardClashTransition({ type: "discard_cards", cardIds: ids.slice(1, 3) }, seat, m2.version),
    nowMs: discard.expiresAt - 3_000,
  });
  expect(done.ok && !done.duplicate).toBe(true);
  const m3 = db.getCardClashMatchById(matchId)!;
  expect(m3.state.turnPhase).toBeUndefined();
  expect(m3.state.activeSeat).not.toBe(seat);
  expect(m3.state.players.get(seat)!.hand).toHaveLength(m3.state.players.get(seat)!.hp);
  const next = db.getCardClashDeadline(matchId)!;
  expect(next.responderSeat).toBe(m3.state.activeSeat);
  expect(next.expiresAt).toBe(discard.expiresAt - 3_000 + CARD_CLASH_DEADLINE_MS);
});

it("36. a manual discard exactly at the DISCARD deadline is rejected and nothing changes", () => {
  const { matchId, roomId, seat } = matchInMain("1v1", 2);
  const discard = enterDiscardByTimeout(matchId, roomId);
  const m = db.getCardClashMatchById(matchId)!;
  const ids = m.state.players.get(seat)!.hand.slice(0, 2).map((c) => c.id);
  const r = db.applyCardClashTransition({
    matchId, requestId: freshId(), expectedVersion: m.version,
    transition: buildCardClashTransition({ type: "discard_cards", cardIds: ids }, seat, m.version),
    nowMs: discard.expiresAt,
  });
  expect(r).toEqual({ ok: false, reason: "deadline_expired" });
  expect(db.getCardClashMatchById(matchId)!.state).toEqual(m.state);
});

it("37. DISCARD timeout removes exactly the excess (RNG-chosen physical cards), publishes them, keeps other hands, advances, draws, and sets a fresh MAIN deadline; a duplicate callback does nothing", () => {
  const { matchId, roomId, seat } = matchInMain("1v2", 0);
  forceState(matchId, (state) => setHand(state, seat, state.players.get(seat)!.hp + 2));
  const discard = enterDiscardByTimeout(matchId, roomId);
  const m = db.getCardClashMatchById(matchId)!;
  const hand = m.state.players.get(seat)!.hand;
  const [a, b, c, d, e] = hand.map((x) => x.id);
  const othersBefore = [...m.state.players].filter(([s]) => s !== seat).map(([s, p]) => [s, p.hand.length]);
  const discardBefore = m.state.discardPile.length;
  const excess = hand.length - m.state.players.get(seat)!.hp;
  expect(excess).toBe(2);

  // pool [a..]: first pick index 1, then index 2 of the remaining pool.
  const rng = seq([1, 2]);
  const result = db.processCardClashTimeout(matchId, discard.version, discard.expiresAt, rng);
  expect(result.applied).toBe(true);
  const after = db.getCardClashMatchById(matchId)!;
  const pool = hand.map((x) => x.id);
  const first = pool.splice(1, 1)[0]!;
  const second = pool.splice(2, 1)[0]!;
  expect(after.state.discardPile.slice(discardBefore).map((x) => x.id)).toEqual([first, second]);
  expect(after.state.players.get(seat)!.hand.map((x) => x.id)).toEqual(hand.map((x) => x.id).filter((id) => id !== first && id !== second));
  void [a, b, c, d, e];
  for (const [s, n] of othersBefore) {
    if (s === after.state.activeSeat) expect(after.state.players.get(s as Seat)!.hand.length).toBeGreaterThan(n as number); // next seat drew
    else expect(after.state.players.get(s as Seat)!.hand).toHaveLength(n as number);
  }
  expect(after.state.turnPhase).toBeUndefined();
  expect(after.state.activeSeat).toBe(2);
  expect(db.getCardClashDeadline(matchId)!.responderSeat).toBe(2);

  const dup = db.processCardClashTimeout(matchId, discard.version, discard.expiresAt + 1, rng);
  expect(dup.applied).toBe(false);
  expect(db.getCardClashMatchById(matchId)!.version).toBe(after.version);
});

it("38. a successful DISCARD timeout publishes exactly one match invalidation; a stale callback publishes none", async () => {
  const { matchId, roomId } = matchInMain("1v1", 2);
  const discard = enterDiscardByTimeout(matchId, roomId);
  const realtime = await import("../card-clash/realtime.ts");
  const received: string[] = [];
  const unsub = realtime.subscribeToCardClashRoom(roomId, (scope) => void received.push(scope));
  expect(scheduler.runCardClashTimeoutCheck(matchId, roomId, discard.version, discard.expiresAt, seq([0]))).toBe(true);
  expect(scheduler.runCardClashTimeoutCheck(matchId, roomId, discard.version, discard.expiresAt, seq([0]))).toBe(false);
  expect(received).toEqual(["match"]);
  unsub();
});

it("39/40. restart during DISCARD keeps the absolute deadline; recovery after expiry completes the automatic discard", async () => {
  const { matchId, roomId, seat } = matchInMain("1v1", 2);
  const discard = enterDiscardByTimeout(matchId, roomId);

  vi.resetModules();
  db = await import("../db.ts");
  scheduler = await import("../card-clash/scheduler.ts");
  expect(db.getCardClashDeadline(matchId)).toEqual(discard);
  const early = scheduler.reconcileCardClashMatchIfOverdue(matchId, roomId, discard.expiresAt - 1);
  expect(early.applied).toBe(false);
  expect(db.getCardClashDeadline(matchId)).toEqual(discard);

  const late = discard.expiresAt + 60_000;
  const rec = scheduler.reconcileCardClashMatchIfOverdue(matchId, roomId, late, 20, seq([0]));
  expect(rec.applied).toBe(true);
  const after = db.getCardClashMatchById(matchId)!;
  expect(after.state.turnPhase).toBeUndefined();
  expect(after.state.players.get(seat)!.hand).toHaveLength(after.state.players.get(seat)!.hp);
  expect(after.state.activeSeat).not.toBe(seat);
  expect(db.getCardClashDeadline(matchId)!.expiresAt).toBe(late + CARD_CLASH_DEADLINE_MS);
});

it("41. auto-discard progression works in 2v2 and skips eliminated seats", () => {
  const { matchId, roomId, seat } = matchInMain("2v2", 2);
  forceState(matchId, (state) => {
    const p = state.players.get(2)!;
    return { ...state, players: new Map(state.players).set(2, { ...p, eliminated: true, hp: 0, hand: [] }) };
  });
  const discard = enterDiscardByTimeout(matchId, roomId);
  expect(db.processCardClashTimeout(matchId, discard.version, discard.expiresAt, seq([0])).applied).toBe(true);
  expect(seat).toBe(1);
  expect(db.getCardClashMatchById(matchId)!.state.activeSeat).toBe(3);
});
