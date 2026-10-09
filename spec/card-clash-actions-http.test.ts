import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Card, CardType } from "../card-clash/cards.ts";
import type { MatchState, Seat } from "../card-clash/types.ts";

// HTTP-to-engine-to-SQLite gameplay-action tests (D4A). Every action goes
// through the real Hono `app` via app.fetch, the real
// applyCardClashTransition, and real SQLite persistence — not a mocked
// handler. `db` is imported directly only to force deterministic hands
// (never to bypass the HTTP/engine path for the assertion itself), the
// same technique spec/card-clash-storage.test.ts already uses.

let tempDir: string;
let previousDataDir: string | undefined;
let app: typeof import("../server.ts")["app"];
let db: typeof import("../db.ts");

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "card-clash-actions-http-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  vi.resetModules();
  ({ app } = await import("../server.ts"));
  db = await import("../db.ts");
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

async function reopen(): Promise<typeof import("../server.ts")["app"]> {
  vi.resetModules();
  ({ app } = await import("../server.ts"));
  return app;
}

class CookieJar {
  #cookies = new Map<string, string>();
  #absorb(response: Response): void {
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#cookies.size > 0) {
      headers.set("cookie", [...this.#cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const response = await app.fetch(new Request(new URL(path, "http://localhost"), { ...init, headers }));
    this.#absorb(response);
    return response;
  }
}

function postJson(jar: CookieJar, path: string, body: unknown): Promise<Response> {
  return jar.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

let requestCounter = 0;
function freshRequestId(): string {
  return `req-${requestCounter++}`;
}

async function createRoom(jar: CookieJar, mode: "1v1" | "1v2" | "2v2"): Promise<string> {
  const res = await postJson(jar, "/api/card-clash/rooms", { mode });
  return ((await res.json()) as { code: string }).code;
}

// Builds a ready, started match: host (seat 1) + N guests, all ready,
// started by the host. Returns the jars indexed by seat (1-based) and the
// room code.
async function setUpStartedMatch(mode: "1v1" | "1v2" | "2v2"): Promise<{ code: string; jars: Record<Seat, CookieJar> }> {
  const seatCount = { "1v1": 2, "1v2": 3, "2v2": 4 }[mode];
  const host = new CookieJar();
  const code = await createRoom(host, mode);
  const jars: CookieJar[] = [host];
  for (let i = 1; i < seatCount; i++) {
    const guest = new CookieJar();
    await postJson(guest, `/api/card-clash/rooms/${code}/join`, {});
    jars.push(guest);
  }
  await Promise.all(jars.map((jar) => postJson(jar, `/api/card-clash/rooms/${code}/ready`, { ready: true })));
  await postJson(host, `/api/card-clash/rooms/${code}/start`, {});
  const byNumber = {} as Record<Seat, CookieJar>;
  jars.forEach((jar, i) => (byNumber[(i + 1) as Seat] = jar));
  return { code, jars: byNumber };
}

// Forces a specific seat's hand directly via the real trusted-transition
// interface (never bypassing applyCardClashTransition) — a legitimate,
// typed state construction for deterministic test setup, matching
// spec/card-clash-storage.test.ts's own established pattern. Never used to
// assert anything by itself; only to arrange a known hand before the real
// HTTP action under test.
function forceHand(roomCode: string, seat: Seat, types: readonly CardType[]): void {
  const room = db.getCardClashRoomByCode(roomCode)!;
  const match = db.getCardClashMatchForRoom(room.id)!;
  const hand: Card[] = types.map((type, i) => ({ id: `forced-${seat}-${i}-${type}`, type }));
  const player = match.state.players.get(seat)!;
  const nextState: MatchState = {
    ...match.state,
    players: new Map(match.state.players).set(seat, { ...player, hand }),
    version: match.state.version + 1,
  };
  const result = db.applyCardClashTransition({
    matchId: match.id,
    requestId: `force-hand-${freshRequestId()}`,
    expectedVersion: match.version,
    transition: () => ({ ok: true, state: nextState }),
  });
  expect(result.ok).toBe(true);
}

function forceHp(roomCode: string, seat: Seat, hp: number): void {
  const room = db.getCardClashRoomByCode(roomCode)!;
  const match = db.getCardClashMatchForRoom(room.id)!;
  const player = match.state.players.get(seat)!;
  const nextState: MatchState = {
    ...match.state,
    players: new Map(match.state.players).set(seat, { ...player, hp }),
    version: match.state.version + 1,
  };
  const result = db.applyCardClashTransition({
    matchId: match.id,
    requestId: `force-hp-${freshRequestId()}`,
    expectedVersion: match.version,
    transition: () => ({ ok: true, state: nextState }),
  });
  expect(result.ok).toBe(true);
}

function currentVersion(roomCode: string): number {
  const room = db.getCardClashRoomByCode(roomCode)!;
  return db.getCardClashMatchForRoom(room.id)!.version;
}

function activeSeat(roomCode: string): Seat {
  const room = db.getCardClashRoomByCode(roomCode)!;
  return db.getCardClashMatchForRoom(room.id)!.state.activeSeat;
}

it("the authenticated active player can Attack through HTTP; the wrong player cannot", async () => {
  const { code, jars } = await setUpStartedMatch("1v1");
  const seat = activeSeat(code);
  const otherSeat: Seat = seat === 1 ? 2 : 1;
  forceHand(code, seat, ["attack"]);

  const wrongPlayer = await postJson(jars[otherSeat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_attack",
    targetSeat: seat,
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(wrongPlayer.status).toBe(409);
  expect((await wrongPlayer.json()).error).toBe("transition_rejected");

  const res = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_attack",
    targetSeat: otherSeat,
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { pending: { kind: string } };
  expect(body.pending).toMatchObject({ kind: "attack_response" });
});

it("the attacked target can Dodge through HTTP; a teammate cannot submit the target's Dodge; declining deals exactly 1 HP", async () => {
  const { code, jars } = await setUpStartedMatch("2v2");
  const seat = activeSeat(code);
  const target: Seat = seat === 1 ? 2 : 1;
  const teammate: Seat = ([1, 2, 3, 4] as Seat[]).find((s) => s !== seat && s !== target)!;
  forceHand(code, seat, ["attack"]);
  forceHand(code, target, ["dodge"]);

  await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_attack",
    targetSeat: target,
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });

  const teammateAttempt = await postJson(jars[teammate], `/api/card-clash/rooms/${code}/actions`, {
    type: "respond_dodge",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(teammateAttempt.status).toBe(409);

  const dodged = await postJson(jars[target], `/api/card-clash/rooms/${code}/actions`, {
    type: "respond_dodge",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(dodged.status).toBe(200);
  const dodgedBody = (await dodged.json()) as { players: { seat: number; hp: number }[] };
  expect(dodgedBody.players.find((p) => p.seat === target)!.hp).toBe(3);

  // A fresh, independent match for the decline path: the normal-Attack
  // limit is 1 per turn, so a second Attack from the SAME seat in the
  // SAME turn as the one above would be legitimately rejected — this
  // needs its own match, not a second attack chained onto the first.
  const second = await setUpStartedMatch("2v2");
  const seat2 = activeSeat(second.code);
  const target2: Seat = seat2 === 1 ? 2 : 1;
  forceHand(second.code, seat2, ["attack"]);
  await postJson(second.jars[seat2], `/api/card-clash/rooms/${second.code}/actions`, {
    type: "play_attack",
    targetSeat: target2,
    expectedVersion: currentVersion(second.code),
    requestId: freshRequestId(),
  });
  const declined = await postJson(second.jars[target2], `/api/card-clash/rooms/${second.code}/actions`, {
    type: "decline_attack_response",
    expectedVersion: currentVersion(second.code),
    requestId: freshRequestId(),
  });
  expect(declined.status).toBe(200);
  const declinedBody = (await declined.json()) as { players: { seat: number; hp: number }[] };
  expect(declinedBody.players.find((p) => p.seat === target2)!.hp).toBe(2);
});

it("dying rescue works end-to-end through HTTP: the approved counterclockwise order is enforced, non-current rescuers are rejected, and a successful rescue persists", async () => {
  const { code, jars } = await setUpStartedMatch("1v2");
  const seat = activeSeat(code); // host, seat 1
  const target: Seat = seat === 1 ? 2 : 1;
  forceHand(code, seat, ["attack"]);
  forceHp(code, target, 1);

  await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_attack",
    targetSeat: target,
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  const declined = await postJson(jars[target], `/api/card-clash/rooms/${code}/actions`, {
    type: "decline_attack_response",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  const declinedBody = (await declined.json()) as { pending: { dyingSeat: Seat; queue: Seat[] } };
  expect(declinedBody.pending.dyingSeat).toBe(target);
  const [firstResponder] = declinedBody.pending.queue;

  const notTheResponder = (([1, 2, 3] as Seat[]).find((s) => s !== firstResponder))!;
  const wrongRescuer = await postJson(jars[notTheResponder], `/api/card-clash/rooms/${code}/actions`, {
    type: "decline_rescue",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(wrongRescuer.status).toBe(409);

  forceHand(code, firstResponder!, ["heal"]);
  const rescued = await postJson(jars[firstResponder!], `/api/card-clash/rooms/${code}/actions`, {
    type: "rescue_heal",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(rescued.status).toBe(200);
  const rescuedBody = (await rescued.json()) as { players: { seat: number; hp: number; eliminated: boolean }[] };
  const targetAfter = rescuedBody.players.find((p) => p.seat === target)!;
  expect(targetAfter.hp).toBe(1);
  expect(targetAfter.eliminated).toBe(false);

  // Persists across a simulated restart.
  await reopen();
  const room = db.getCardClashRoomByCode(code)!;
  const recovered = db.getCardClashMatchForRoom(room.id)!;
  expect(recovered.state.players.get(target)!.hp).toBe(1);
});

it("every rescuer declining eliminates the dying player and returns the correct winner", async () => {
  const { code, jars } = await setUpStartedMatch("1v1");
  const seat = activeSeat(code);
  const target: Seat = seat === 1 ? 2 : 1;
  forceHand(code, seat, ["attack"]);
  forceHand(code, target, []);
  forceHp(code, target, 1);

  await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_attack",
    targetSeat: target,
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  await postJson(jars[target], `/api/card-clash/rooms/${code}/actions`, {
    type: "decline_attack_response",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  // 1v1 rescue queue: [attacker, dyingSeat] — attacker declines first.
  await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "decline_rescue",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  const final = await postJson(jars[target], `/api/card-clash/rooms/${code}/actions`, {
    type: "decline_rescue",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(final.status).toBe(200);
  const body = (await final.json()) as { matchResult: { status: string; winningTeam: string } };
  expect(body.matchResult).toEqual({ status: "complete", winningTeam: seat === 1 ? "A" : "B" });
});

it("War Cry opens the correct group response (Attack required), sequential responses persist, and group rescue suspends/resumes correctly", async () => {
  const { code, jars } = await setUpStartedMatch("1v2");
  const seat = activeSeat(code);
  const others = ([1, 2, 3] as Seat[]).filter((s) => s !== seat);
  forceHand(code, seat, ["war_cry"]);

  const played = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_war_cry",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(played.status).toBe(200);
  const playedBody = (await played.json()) as { pending: { context: { requiredResponseType: string; queue: Seat[] } } };
  expect(playedBody.pending.context.requiredResponseType).toBe("attack");
  const [firstTarget, secondTarget] = playedBody.pending.context.queue;
  expect(new Set([firstTarget, secondTarget])).toEqual(new Set(others));

  // Arrow Volley requires Dodge, not Attack — reject the wrong response type.
  forceHand(code, firstTarget!, ["dodge"]);
  const wrongType = await postJson(jars[firstTarget!], `/api/card-clash/rooms/${code}/actions`, {
    type: "respond_group_dodge",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(wrongType.status).toBe(409);

  forceHand(code, firstTarget!, ["attack"]);
  const firstResp = await postJson(jars[firstTarget!], `/api/card-clash/rooms/${code}/actions`, {
    type: "respond_group_attack",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(firstResp.status).toBe(200);
  expect(((await firstResp.json()) as { pending: { context: { queue: Seat[] } } }).pending.context.queue).toEqual([
    secondTarget,
  ]);

  // Second responder declines and dies, suspending the group queue for rescue.
  forceHp(code, secondTarget!, 1);
  const declined = await postJson(jars[secondTarget!], `/api/card-clash/rooms/${code}/actions`, {
    type: "decline_group_response",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  const declinedBody = (await declined.json()) as { pending: { kind: string; dyingSeat: Seat } };
  expect(declinedBody.pending).toMatchObject({ kind: "dying_rescue", dyingSeat: secondTarget });

  // Decline every rescue opportunity; the group effect must have fully
  // resolved afterward (its queue was empty), control back to the actor.
  for (;;) {
    const fresh = await (await jars[seat].fetch(`/api/card-clash/rooms/${code}/state`)).json();
    const pending = (fresh as { pending: { kind: string; queue?: Seat[] } }).pending;
    if (!pending || pending.kind !== "dying_rescue") break;
    const responder = pending.queue![0]!;
    const res = await postJson(jars[responder], `/api/card-clash/rooms/${code}/actions`, {
      type: "decline_rescue",
      expectedVersion: currentVersion(code),
      requestId: freshRequestId(),
    });
    expect(res.status).toBe(200);
  }

  const room = db.getCardClashRoomByCode(code)!;
  const final = db.getCardClashMatchForRoom(room.id)!;
  expect(final.state.pending).toBeUndefined();
  expect(final.state.activeSeat).toBe(seat);
});

it("Seize transfers one card through HTTP without leaking its identity; Disarm produces the approved public event; Insight draws without exposing hidden cards", async () => {
  const { code, jars } = await setUpStartedMatch("1v1");
  const seat = activeSeat(code);
  const other: Seat = seat === 1 ? 2 : 1;

  forceHand(code, seat, ["seize"]);
  forceHand(code, other, ["dodge"]);
  const seizeRes = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_seize",
    targetSeat: other,
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(seizeRes.status).toBe(200);
  const seizeBody = (await seizeRes.json()) as { publicLog: Record<string, unknown>[]; players: { seat: number; hand?: Card[] }[] };
  expect(seizeBody.publicLog.at(-1)).toEqual({ type: "seize_played", actor: seat, target: other });
  expect(JSON.stringify(seizeBody.publicLog)).not.toContain("dodge"); // stolen card's type never in the public log
  expect(seizeBody.players.find((p) => p.seat === seat)!.hand!.some((c) => c.type === "dodge")).toBe(true); // it IS in the actor's own view

  forceHand(code, seat, ["disarm"]);
  forceHand(code, other, ["heal"]);
  const disarmRes = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_disarm",
    targetSeat: other,
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  const disarmBody = (await disarmRes.json()) as { publicLog: Record<string, unknown>[] };
  expect(disarmBody.publicLog).toContainEqual({ type: "disarm_card_revealed", target: other, cardType: "heal" });

  forceHand(code, seat, ["insight"]);
  const insightRes = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_insight",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  const insightBody = (await insightRes.json()) as { publicLog: Record<string, unknown>[] };
  expect(insightBody.publicLog.at(-1)).toEqual({ type: "insight_played", actor: seat, cardsDrawn: 2 });
  const serializedInsightEvent = JSON.stringify(insightBody.publicLog.at(-1));
  expect(serializedInsightEvent).not.toMatch(/attack|dodge|heal|seize|war_cry|arrow_volley/); // no drawn-card type leaked
});

it("end-turn and manual discard work through HTTP", async () => {
  const { code, jars } = await setUpStartedMatch("1v1");
  const seat = activeSeat(code);
  const room = db.getCardClashRoomByCode(code)!;
  const match = db.getCardClashMatchForRoom(room.id)!;
  const hp = match.state.players.get(seat)!.hp;
  forceHand(code, seat, Array(hp + 1).fill("attack")); // one over the discard limit

  const cardIdToDiscard = db.getCardClashMatchForRoom(room.id)!.state.players.get(seat)!.hand[0]!.id;
  const discardRes = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "discard_cards",
    cardIds: [cardIdToDiscard],
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(discardRes.status).toBe(200);

  const endTurnRes = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "end_turn",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(endTurnRes.status).toBe(200);
  const endTurnBody = (await endTurnRes.json()) as { activeSeat: Seat };
  expect(endTurnBody.activeSeat).not.toBe(seat);
});

it("a stale/invalid action is rejected and a duplicate request ID cannot repeat the same effect twice", async () => {
  const { code, jars } = await setUpStartedMatch("1v1");
  const seat = activeSeat(code);
  const other: Seat = seat === 1 ? 2 : 1;
  forceHand(code, seat, ["attack"]);

  const stale = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_attack",
    targetSeat: other,
    expectedVersion: currentVersion(code) + 999,
    requestId: freshRequestId(),
  });
  expect(stale.status).toBe(409);

  const malformed = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "not_a_real_action",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(malformed.status).toBe(400);

  const requestId = freshRequestId();
  const first = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_attack",
    targetSeat: other,
    expectedVersion: currentVersion(code),
    requestId,
  });
  expect(first.status).toBe(200);
  const versionAfterFirst = currentVersion(code);

  const duplicate = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_attack",
    targetSeat: other,
    expectedVersion: versionAfterFirst - 1, // the version the client last saw before its first (successful) send
    requestId,
  });
  expect(duplicate.status).toBe(200);
  const duplicateBody = (await duplicate.json()) as { duplicate: boolean; version: number };
  expect(duplicateBody.duplicate).toBe(true);
  expect(currentVersion(code)).toBe(versionAfterFirst); // not advanced a second time
});

it("an eliminated player cannot act, and a non-seated viewer cannot act", async () => {
  const { code, jars } = await setUpStartedMatch("1v1");
  const seat = activeSeat(code);
  const other: Seat = seat === 1 ? 2 : 1;

  const stranger = new CookieJar();
  const strangerAttempt = await postJson(stranger, `/api/card-clash/rooms/${code}/actions`, {
    type: "end_turn",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(strangerAttempt.status).toBe(403);

  // Force the other seat eliminated directly (legitimate typed state
  // construction) and confirm they can no longer act even though they
  // still hold a seat.
  const room = db.getCardClashRoomByCode(code)!;
  const match = db.getCardClashMatchForRoom(room.id)!;
  const player = match.state.players.get(other)!;
  const eliminatedState: MatchState = {
    ...match.state,
    players: new Map(match.state.players).set(other, { ...player, eliminated: true, hp: 0 }),
    version: match.state.version + 1,
  };
  db.applyCardClashTransition({
    matchId: match.id,
    requestId: "force-eliminate",
    expectedVersion: match.version,
    transition: () => ({ ok: true, state: eliminatedState }),
  });

  const eliminatedAttempt = await postJson(jars[other], `/api/card-clash/rooms/${code}/actions`, {
    type: "end_turn",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(eliminatedAttempt.status).toBe(403);
  expect((await eliminatedAttempt.json()).error).toBe("eliminated");
});

it("the public action-result JSON never contains an opponent's private hand or the raw draw-pile order", async () => {
  const { code, jars } = await setUpStartedMatch("1v1");
  const seat = activeSeat(code);
  const other: Seat = seat === 1 ? 2 : 1;
  forceHand(code, seat, ["attack"]);

  const res = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_attack",
    targetSeat: other,
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  const body = (await res.json()) as Record<string, unknown> & { players: { seat: number; hand?: unknown }[] };
  expect(body.drawPile).toBeUndefined();
  expect(body.drawPileCount).toBeTypeOf("number");
  expect(body.players.find((p) => p.seat === other)!.hand).toBeUndefined();
});
