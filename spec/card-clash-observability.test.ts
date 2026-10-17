import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { JSDOM } from "jsdom";

let dataDir: string;
let previousDataDir: string | undefined;
let app: typeof import("../server.ts")["app"];
let db: typeof import("../db.ts");
let scheduler: typeof import("../card-clash/scheduler.ts");
let output: MockInstance<typeof console.info>;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "card-clash-observability-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  ({ app } = await import("../server.ts"));
  db = await import("../db.ts");
  scheduler = await import("../card-clash/scheduler.ts");
  output = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  for (const { matchId } of db.listActiveCardClashDeadlineMatches()) scheduler.cancelCardClashTimer(matchId);
  vi.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

class Player {
  cookie = "";
  async post(path: string, body: unknown): Promise<Response> {
    const response = await app.fetch(new Request("http://localhost" + path, {
      method: "POST", headers: { "content-type": "application/json", cookie: this.cookie }, body: JSON.stringify(body),
    }));
    const cookie = response.headers.getSetCookie()[0];
    if (cookie) this.cookie = cookie.split(";")[0]!;
    return response;
  }
}

type RecordLine = { actor: string; participant: string | null; room: string | null; roomId: number | null; seat: number | null; action: string; outcome: string; versionBefore: number | null; versionAfter: number | null; source: string; ready: boolean | null };
function records(): RecordLine[] {
  return output.mock.calls.map((call) => JSON.parse(String(call[0])) as RecordLine);
}
async function setup(start = false) {
  const host = new Player(), guest = new Player();
  const created = await host.post("/api/card-clash/rooms", { mode: "1v1" });
  const { code } = await created.json() as { code: string };
  const path = `/api/card-clash/rooms/${code}`;
  await guest.post(path + "/join", {});
  if (start) {
    await host.post(path + "/ready", { ready: true });
    await guest.post(path + "/ready", { ready: true });
    expect((await host.post(path + "/start", {})).status).toBe(200);
  }
  const room = db.getCardClashRoomByCode(code)!;
  return { host, guest, code, path, room };
}

it("attributes create/join/ready/start to server identities and distinguishes a duplicate join", async () => {
  const { host, guest, path, room } = await setup();
  // Extra client seat/identity fields must not control log attribution.
  await guest.post(path + "/ready", { ready: true, seat: 1, identityId: 9999 });
  await host.post(path + "/ready", { ready: true });
  await guest.post(path + "/join", {});
  await host.post(path + "/start", {});
  const events = records();
  expect(events.map((e) => e.action)).toEqual(["create_room", "join_room", "set_ready", "set_ready", "join_room", "start_match"]);
  expect(events.map((e) => e.seat)).toEqual([1, 2, 2, 1, 2, 1]);
  expect(events[0]!.participant).not.toBe(events[1]!.participant);
  expect(events[2]!.participant).toBe(events[1]!.participant);
  expect(events[4]!.outcome).toBe("duplicate");
  expect(events.every((e) => e.roomId === room.id && e.room === room.code)).toBe(true);
  expect(events[5]!.versionAfter).toBe(db.getCardClashMatchForRoom(room.id)!.version);
});

it("records rejected, committed and duplicate actions without double-applying or leaking discard card IDs", async () => {
  const { host, guest, path, room } = await setup(true);
  const before = db.getCardClashMatchForRoom(room.id)!;
  const rejected = await guest.post(path + "/actions", { type: "end_turn", requestId: "wrong-turn", expectedVersion: before.version });
  expect(rejected.status).toBe(409);
  expect(db.getCardClashMatchForRoom(room.id)!.version).toBe(before.version);
  const action = { type: "end_turn", requestId: "end-once", expectedVersion: before.version };
  expect((await host.post(path + "/actions", action)).status).toBe(200);
  const after = db.getCardClashMatchForRoom(room.id)!;
  expect(after.version).toBeGreaterThan(before.version);
  expect((await host.post(path + "/actions", action)).status).toBe(200);
  expect(db.getCardClashMatchForRoom(room.id)!.version).toBe(after.version);
  const hand = after.state.players.get(1)!.hand;
  const cardIds = hand.slice(0, hand.length - after.state.players.get(1)!.hp).map((c) => c.id);
  expect((await host.post(path + "/actions", { type: "discard_cards", cardIds, requestId: "discard-once", expectedVersion: after.version })).status).toBe(200);
  const actions = records().filter((e) => ["end_turn", "discard_cards"].includes(e.action));
  expect(actions.map((e) => e.outcome)).toEqual(["rejected", "accepted", "duplicate", "accepted"]);
  expect(actions[1]).toMatchObject({ seat: 1, versionBefore: before.version, versionAfter: after.version });
  const lines = JSON.stringify(records());
  for (const id of cardIds) expect(lines).not.toContain(id);
  expect(lines).not.toContain(host.cookie.split("=")[1]!);
  expect(lines).not.toContain(guest.cookie.split("=")[1]!);
  expect(lines).not.toContain("drawPile");
});

it("does not echo arbitrary invalid body fields, and logging explicitly drops extra fields", async () => {
  const { host, path, room } = await setup(true);
  const match = db.getCardClashMatchForRoom(room.id)!;
  const response = await host.post(path + "/actions", { type: "end_turn", requestId: "invalid-body", expectedVersion: match.version, privateHand: "NEVER_LOG_THIS" });
  expect(response.status).toBe(400);
  expect(records().at(-1)).toMatchObject({ outcome: "rejected", action: "action", seat: 1 });
  const { logCardClashEvent } = await import("../card-clash/observability.ts");
  const extra = { actor: "system", action: "timeout", outcome: "accepted", privateHand: "NEVER_LOG_THIS", cookie: "NEVER_LOG_COOKIE" } as const;
  logCardClashEvent(extra);
  expect(JSON.stringify(records())).not.toContain("NEVER_LOG");
  expect(Object.keys(records().at(-1)!)).toEqual(["event", "at", "actor", "participant", "room", "roomId", "matchId", "seat", "action", "outcome", "status", "reason", "versionBefore", "versionAfter", "ready", "source"]);
});

it("logs each applied timer/recovery transition once and ignores stale callbacks", async () => {
  const { room } = await setup(true);
  const match = db.getCardClashMatchForRoom(room.id)!;
  const deadline = db.getCardClashDeadline(match.id)!;
  expect(scheduler.runCardClashTimeoutCheck(match.id, room.id, deadline.version, deadline.expiresAt)).toBe(true);
  expect(scheduler.runCardClashTimeoutCheck(match.id, room.id, deadline.version, deadline.expiresAt)).toBe(false);
  const next = db.getCardClashDeadline(match.id)!;
  expect(scheduler.reconcileCardClashMatchIfOverdue(match.id, room.id, next.expiresAt).applied).toBe(true);
  const timeouts = records().filter((e) => e.actor === "system");
  expect(timeouts).toHaveLength(2);
  expect(timeouts.map((e) => e.source)).toEqual(["timer", "reconcile"]);
  expect(timeouts[0]).toMatchObject({ seat: deadline.responderSeat, roomId: room.id, versionBefore: match.version });
  expect(timeouts.every((e) => e.participant === null && e.action === "timeout" && e.outcome === "accepted")).toBe(true);
});

it("a failed log sink cannot fail or roll back a committed gameplay request", async () => {
  const { host, path, room } = await setup(true);
  const before = db.getCardClashMatchForRoom(room.id)!;
  output.mockImplementation(() => { throw new Error("test sink failure"); });
  const response = await host.post(path + "/actions", { type: "end_turn", requestId: "sink-failure", expectedVersion: before.version });
  expect(response.status).toBe(200);
  expect(db.getCardClashMatchForRoom(room.id)!.version).toBeGreaterThan(before.version);
});

it("a newcomer can navigate from /readme/ to the running game without guessing its URL", async () => {
  const response = await app.fetch(new Request("http://localhost/readme/"));
  const document = new JSDOM(await response.text()).window.document;
  const entry = Array.from(document.querySelectorAll("a")).find((link) => /play card clash/i.test(link.textContent ?? ""));
  expect(entry).toBeDefined();
  const destination = new URL(entry!.getAttribute("href")!, "http://localhost");
  const game = await app.fetch(new Request(destination));
  expect(game.status).toBe(200);
  expect(await game.text()).toContain("<title>Card Clash</title>");
});
