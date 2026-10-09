import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MatchState, Seat } from "../card-clash/types.ts";

// D4B room-scoped SSE tests — the real Hono `app` exercised in-process via
// app.fetch (needed so the test and the open SSE stream share the SAME
// in-memory card-clash/realtime.ts registry, exactly like the existing
// poker SSE tests do against realtime.ts), against a fresh isolated
// on-disk database per test.

let tempDir: string;
let previousDataDir: string | undefined;
let app: typeof import("../server.ts")["app"];
let db: typeof import("../db.ts");
let cardClashSubscriberCount: typeof import("../card-clash/realtime.ts")["cardClashSubscriberCount"];

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "card-clash-realtime-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  vi.resetModules();
  ({ app } = await import("../server.ts"));
  db = await import("../db.ts");
  // Imported dynamically, AFTER vi.resetModules(), for the same reason as
  // `app`/`db` above: a static top-level import would bind to the module
  // instance that existed when this test FILE first loaded, not the fresh
  // instance server.ts pulls in for each test — so it would always report
  // stale (empty) subscriber counts regardless of what the test just did.
  ({ cardClashSubscriberCount } = await import("../card-clash/realtime.ts"));
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

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

function activeSeat(roomCode: string): Seat {
  const room = db.getCardClashRoomByCode(roomCode)!;
  return db.getCardClashMatchForRoom(room.id)!.state.activeSeat;
}

function currentVersion(roomCode: string): number {
  const room = db.getCardClashRoomByCode(roomCode)!;
  return db.getCardClashMatchForRoom(room.id)!.version;
}

function roomIdForCode(roomCode: string): number {
  return db.getCardClashRoomByCode(roomCode)!.id;
}

function openEvents(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(`/api/card-clash/rooms/${code}/events`);
}

// Same SSE wire-format parser spec/poker.test.ts already uses: each call
// returns the next complete event block, racing a bounded per-call
// timeout so a test fails fast rather than hanging.
function sseEvents(response: Response): {
  nextEvent: (timeoutMs?: number) => Promise<{ event: string; data: string }>;
  cancel: () => Promise<void>;
} {
  const body = response.body;
  if (!body) throw new Error("SSE response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // A read that times out must NOT be abandoned: a ReadableStreamDefaultReader
  // only ever fulfills its read() calls in FIFO order, so a later real event
  // would otherwise be delivered to this orphaned, nobody's-awaiting-it
  // promise instead of to the next nextEvent() call's own read() — making a
  // genuine event silently vanish. Keeping the same in-flight read() across
  // calls (until it actually resolves) means a timed-out call's data still
  // reaches whichever later call is awaiting it.
  let pendingRead: ReturnType<typeof reader.read> | null = null;

  async function nextEvent(timeoutMs = 2000): Promise<{ event: string; data: string }> {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice("event: ".length);
          else if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
        }
        return { event, data: dataLines.join("\n") };
      }
      if (!pendingRead) pendingRead = reader.read();
      const readPromise = pendingRead;
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`no SSE event arrived within ${timeoutMs}ms`)), timeoutMs);
      });
      try {
        const chunk = await Promise.race([readPromise, timeout]);
        pendingRead = null;
        if (chunk.done) throw new Error("SSE stream ended before the expected event arrived");
        buffer += decoder.decode(chunk.value, { stream: true });
      } finally {
        clearTimeout(timeoutHandle!);
      }
    }
  }

  async function cancel(): Promise<void> {
    await reader.cancel();
  }

  return { nextEvent, cancel };
}

it("a seated player can establish SSE and receives the initial ready signal; a non-seated identity cannot subscribe at all", async () => {
  const host = new CookieJar();
  const code = await createRoom(host, "1v1");

  const res = await openEvents(host, code);
  expect(res.status).toBe(200);
  const stream = sseEvents(res);
  const ready = await stream.nextEvent();
  expect(ready.event).toBe("ready");
  await stream.cancel();

  const stranger = new CookieJar();
  const rejected = await openEvents(stranger, code);
  expect(rejected.status).toBe(403);
});

it("a second player joining a waiting room triggers a room-scope invalidation for the existing subscriber", async () => {
  const host = new CookieJar();
  const code = await createRoom(host, "1v1");
  const res = await openEvents(host, code);
  const stream = sseEvents(res);
  await stream.nextEvent(); // ready

  const guest = new CookieJar();
  await postJson(guest, `/api/card-clash/rooms/${code}/join`, {});

  const event = await stream.nextEvent();
  expect(event.event).toBe("invalidate");
  expect(JSON.parse(event.data)).toEqual({ scope: "room" });
  await stream.cancel();
});

it("a readiness change triggers a room-scope notification, and match start triggers a match-scope notification", async () => {
  const host = new CookieJar();
  const code = await createRoom(host, "1v1");
  const guest = new CookieJar();
  await postJson(guest, `/api/card-clash/rooms/${code}/join`, {});

  const res = await openEvents(host, code);
  const stream = sseEvents(res);
  await stream.nextEvent(); // ready

  await postJson(guest, `/api/card-clash/rooms/${code}/ready`, { ready: true });
  const readyEvent = await stream.nextEvent();
  expect(readyEvent).toEqual({ event: "invalidate", data: JSON.stringify({ scope: "room" }) });

  await postJson(host, `/api/card-clash/rooms/${code}/ready`, { ready: true });
  await stream.nextEvent(); // host's own readiness change, also "room"

  const startRes = await postJson(host, `/api/card-clash/rooms/${code}/start`, {});
  expect(startRes.status).toBe(200);
  const matchEvent = await stream.nextEvent();
  expect(matchEvent).toEqual({ event: "invalidate", data: JSON.stringify({ scope: "match" }) });

  await stream.cancel();
});

it("a successful gameplay action notifies a DIFFERENT seated browser (cross-browser, not just self), while a rejected action notifies nobody", async () => {
  const { code, jars } = await setUpStartedMatch("1v1");
  const seat = activeSeat(code);
  const other: Seat = seat === 1 ? 2 : 1;

  // Force a known hand so the Attack is guaranteed legal.
  const room = db.getCardClashRoomByCode(code)!;
  const match = db.getCardClashMatchForRoom(room.id)!;
  const player = match.state.players.get(seat)!;
  const forced: MatchState = {
    ...match.state,
    players: new Map(match.state.players).set(seat, { ...player, hand: [{ id: "forced-attack", type: "attack" }] }),
    version: match.state.version + 1,
  };
  db.applyCardClashTransition({ matchId: match.id, requestId: "force", expectedVersion: match.version, transition: () => ({ ok: true, state: forced }) });

  // The OTHER (non-acting) browser subscribes.
  const res = await openEvents(jars[other], code);
  const stream = sseEvents(res);
  await stream.nextEvent(); // ready

  // A rejected action (wrong actor) must notify nobody.
  const rejected = await postJson(jars[other], `/api/card-clash/rooms/${code}/actions`, {
    type: "end_turn",
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(rejected.status).toBe(409);
  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/);

  // A genuine successful action by the ACTIVE seat notifies the other browser.
  const attacked = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_attack",
    targetSeat: other,
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  expect(attacked.status).toBe(200);
  const event = await stream.nextEvent();
  expect(event).toEqual({ event: "invalidate", data: JSON.stringify({ scope: "match" }) });

  await stream.cancel();
});

it("room X subscribers never receive room Y's events, and an idempotent duplicate request does not publish again", async () => {
  const hostX = new CookieJar();
  const codeX = await createRoom(hostX, "1v1");
  const hostY = new CookieJar();
  const codeY = await createRoom(hostY, "1v1");

  const resX = await openEvents(hostX, codeX);
  const streamX = sseEvents(resX);
  await streamX.nextEvent(); // ready

  const guestY = new CookieJar();
  await postJson(guestY, `/api/card-clash/rooms/${codeY}/join`, {}); // mutates room Y only

  await expect(streamX.nextEvent(300)).rejects.toThrow(/no SSE event arrived/); // room X heard nothing
  await streamX.cancel();

  // Idempotent duplicate: same request_id resubmitted produces no second publish.
  const { code, jars } = await setUpStartedMatch("1v1");
  const seat = activeSeat(code);
  const other: Seat = seat === 1 ? 2 : 1;
  const room = db.getCardClashRoomByCode(code)!;
  const match = db.getCardClashMatchForRoom(room.id)!;
  const player = match.state.players.get(seat)!;
  const forced: MatchState = {
    ...match.state,
    players: new Map(match.state.players).set(seat, { ...player, hand: [{ id: "forced-attack", type: "attack" }] }),
    version: match.state.version + 1,
  };
  db.applyCardClashTransition({ matchId: match.id, requestId: "force", expectedVersion: match.version, transition: () => ({ ok: true, state: forced }) });

  const res = await openEvents(jars[seat], code);
  const stream = sseEvents(res);
  await stream.nextEvent(); // ready

  const requestId = freshRequestId();
  const body = { type: "play_attack", targetSeat: other, expectedVersion: currentVersion(code), requestId };
  const first = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, body);
  expect(first.status).toBe(200);
  await stream.nextEvent(); // the one genuine publish

  const duplicate = await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, { ...body, expectedVersion: currentVersion(code) - 1 });
  expect((await duplicate.json()).duplicate).toBe(true);
  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/); // no second publish

  await stream.cancel();
});

it("reconnecting emits a fresh initial synchronization notification, and closing a connection unregisters its subscriber", async () => {
  const host = new CookieJar();
  const code = await createRoom(host, "1v1");
  const roomId = roomIdForCode(code);
  expect(cardClashSubscriberCount(roomId)).toBe(0);

  const first = await openEvents(host, code);
  const firstStream = sseEvents(first);
  await firstStream.nextEvent(); // ready
  expect(cardClashSubscriberCount(roomId)).toBe(1);

  await firstStream.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10)); // let onAbort's cleanup run
  expect(cardClashSubscriberCount(roomId)).toBe(0);

  // Reconnect: a brand-new connection gets its own fresh "ready".
  const second = await openEvents(host, code);
  const secondStream = sseEvents(second);
  const readyAgain = await secondStream.nextEvent();
  expect(readyAgain.event).toBe("ready");
  expect(cardClashSubscriberCount(roomId)).toBe(1);
  await secondStream.cancel();
});

it("an eliminated player still retains read-only SSE access as a spectator", async () => {
  const { code, jars } = await setUpStartedMatch("1v1");
  const seat = activeSeat(code);
  const other: Seat = seat === 1 ? 2 : 1;

  const room = db.getCardClashRoomByCode(code)!;
  const match = db.getCardClashMatchForRoom(room.id)!;
  const player = match.state.players.get(other)!;
  const eliminated: MatchState = {
    ...match.state,
    players: new Map(match.state.players).set(other, { ...player, eliminated: true, hp: 0 }),
    version: match.state.version + 1,
  };
  db.applyCardClashTransition({ matchId: match.id, requestId: "eliminate", expectedVersion: match.version, transition: () => ({ ok: true, state: eliminated }) });

  const res = await openEvents(jars[other], code);
  expect(res.status).toBe(200);
  const stream = sseEvents(res);
  const ready = await stream.nextEvent();
  expect(ready.event).toBe("ready");
  await stream.cancel();
});

it("the SSE payload itself never carries a hand, draw-pile order, or raw MatchState — only a scope tag", async () => {
  const { code, jars } = await setUpStartedMatch("1v1");
  const seat = activeSeat(code);
  const other: Seat = seat === 1 ? 2 : 1;
  const room = db.getCardClashRoomByCode(code)!;
  const match = db.getCardClashMatchForRoom(room.id)!;
  const player = match.state.players.get(seat)!;
  const forced: MatchState = {
    ...match.state,
    players: new Map(match.state.players).set(seat, { ...player, hand: [{ id: "forced-attack", type: "attack" }] }),
    version: match.state.version + 1,
  };
  db.applyCardClashTransition({ matchId: match.id, requestId: "force", expectedVersion: match.version, transition: () => ({ ok: true, state: forced }) });

  const res = await openEvents(jars[other], code);
  const stream = sseEvents(res);
  await stream.nextEvent(); // ready

  await postJson(jars[seat], `/api/card-clash/rooms/${code}/actions`, {
    type: "play_attack",
    targetSeat: other,
    expectedVersion: currentVersion(code),
    requestId: freshRequestId(),
  });
  const event = await stream.nextEvent();
  expect(Object.keys(JSON.parse(event.data))).toEqual(["scope"]); // nothing beyond the scope tag
  expect(event.data).not.toMatch(/hand|drawPile|pending|players/i);

  await stream.cancel();
});
