import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// HTTP-level Card Clash room/identity/privacy tests (D3B) — the real Hono
// `app` exercised in-process via app.fetch against a fresh, isolated
// on-disk database per test, exactly like spec/poker-http.test.ts. No
// gameplay action endpoints exist yet — only room lifecycle and read-only
// state views.

let tempDir: string;
let previousDataDir: string | undefined;
let app: typeof import("../server.ts")["app"];

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "card-clash-http-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  vi.resetModules();
  ({ app } = await import("../server.ts"));
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
  return jar.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createRoom(jar: CookieJar, mode: "1v1" | "1v2" | "2v2"): Promise<{ code: string }> {
  const res = await postJson(jar, "/api/card-clash/rooms", { mode });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { code: string };
  return json;
}

it("creates a room with the host seated at seat 1, and rejects an invalid mode", async () => {
  const host = new CookieJar();
  const res = await postJson(host, "/api/card-clash/rooms", { mode: "1v1" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { code: string; mode: string; status: string; ownSeat: number; requiredSeats: number };
  expect(body.mode).toBe("1v1");
  expect(body.status).toBe("waiting");
  expect(body.ownSeat).toBe(1);
  expect(body.requiredSeats).toBe(2);

  const invalid = await postJson(host, "/api/card-clash/rooms", { mode: "3v3" });
  expect(invalid.status).toBe(400);
});

it("a visitor can view public lobby metadata without joining, and it never exposes internal identity values", async () => {
  const host = new CookieJar();
  const { code } = await createRoom(host, "1v1");

  const visitor = new CookieJar();
  const res = await visitor.fetch(`/api/card-clash/rooms/${code}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { mode: string; status: string; requiredSeats: number; seats: unknown[]; viewerSeat: number | null };
  expect(body.mode).toBe("1v1");
  expect(body.status).toBe("waiting");
  expect(body.requiredSeats).toBe(2);
  expect(body.seats).toEqual([{ seatNumber: 1, ready: false }]);
  expect(body.viewerSeat).toBeNull(); // the visitor hasn't joined
  const serialized = JSON.stringify(body);
  expect(serialized).not.toMatch(/identityId|identity_id/i); // no internal identity reference leaks
});

it("joining assigns ascending seat numbers; rejoining the same identity is an idempotent reconnect, not a second seat", async () => {
  const host = new CookieJar();
  const { code } = await createRoom(host, "2v2");

  const guestA = new CookieJar();
  const joinA = await postJson(guestA, `/api/card-clash/rooms/${code}/join`, {});
  expect(joinA.status).toBe(200);
  expect(await joinA.json()).toEqual({ seatNumber: 2, alreadyJoined: false });

  const rejoinA = await postJson(guestA, `/api/card-clash/rooms/${code}/join`, {});
  expect(await rejoinA.json()).toEqual({ seatNumber: 2, alreadyJoined: true });

  const lobby = await (await host.fetch(`/api/card-clash/rooms/${code}`)).json();
  expect((lobby as { seats: unknown[] }).seats).toHaveLength(2); // not 3
});

it("a full room rejects a new identity, and an already-started room rejects a new identity too", async () => {
  const host = new CookieJar();
  const { code } = await createRoom(host, "1v1");
  const guest = new CookieJar();
  await postJson(guest, `/api/card-clash/rooms/${code}/join`, {});

  const stranger = new CookieJar();
  const fullResult = await postJson(stranger, `/api/card-clash/rooms/${code}/join`, {});
  expect(fullResult.status).toBe(409);
  expect(await fullResult.json()).toEqual({ error: "room_full" });

  // A second room, started before a third identity tries to join.
  const host2 = new CookieJar();
  const { code: code2 } = await createRoom(host2, "1v2");
  const guest2 = new CookieJar();
  await postJson(guest2, `/api/card-clash/rooms/${code2}/join`, {});
  const guest3 = new CookieJar();
  await postJson(guest3, `/api/card-clash/rooms/${code2}/join`, {});
  await Promise.all(
    [host2, guest2, guest3].map((jar) => postJson(jar, `/api/card-clash/rooms/${code2}/ready`, { ready: true })),
  );
  const started = await postJson(host2, `/api/card-clash/rooms/${code2}/start`, {});
  expect(started.status).toBe(200);

  const latecomer = new CookieJar();
  const lateJoin = await postJson(latecomer, `/api/card-clash/rooms/${code2}/join`, {});
  expect(lateJoin.status).toBe(409);
  expect(await lateJoin.json()).toEqual({ error: "room_already_started" });
});

it("readiness only ever affects the caller's own seat; a non-seated identity and a malformed body are rejected", async () => {
  const host = new CookieJar();
  const { code } = await createRoom(host, "1v1");
  const guest = new CookieJar();
  await postJson(guest, `/api/card-clash/rooms/${code}/join`, {});

  // The body carries no seat/identity field at all — only `ready` — and
  // even if a client tried to smuggle one in, the route never reads it.
  const readyRes = await postJson(host, `/api/card-clash/rooms/${code}/ready`, { ready: true, seat: 2, identityId: 999999 });
  expect(readyRes.status).toBe(200);

  const lobby = (await (await host.fetch(`/api/card-clash/rooms/${code}`)).json()) as {
    seats: { seatNumber: number; ready: boolean }[];
  };
  expect(lobby.seats.find((s) => s.seatNumber === 1)?.ready).toBe(true);
  expect(lobby.seats.find((s) => s.seatNumber === 2)?.ready).toBe(false); // guest's seat untouched by host's request

  const stranger = new CookieJar();
  const strangerReady = await postJson(stranger, `/api/card-clash/rooms/${code}/ready`, { ready: true });
  expect(strangerReady.status).toBe(403);

  const malformed = await postJson(host, `/api/card-clash/rooms/${code}/ready`, { ready: "yes" });
  expect(malformed.status).toBe(400);
});

it("only the host may start the match, and only once all seats are filled and ready", async () => {
  const host = new CookieJar();
  const { code } = await createRoom(host, "1v2");
  const guest = new CookieJar();
  await postJson(guest, `/api/card-clash/rooms/${code}/join`, {});

  const notFull = await postJson(host, `/api/card-clash/rooms/${code}/start`, {});
  expect(notFull.status).toBe(409);
  expect(await notFull.json()).toEqual({ error: "seats_not_full" });

  const guest2 = new CookieJar();
  await postJson(guest2, `/api/card-clash/rooms/${code}/join`, {});

  const notReady = await postJson(host, `/api/card-clash/rooms/${code}/start`, {});
  expect(await notReady.json()).toEqual({ error: "not_all_ready" });

  await Promise.all([host, guest, guest2].map((jar) => postJson(jar, `/api/card-clash/rooms/${code}/ready`, { ready: true })));

  const notHost = await postJson(guest, `/api/card-clash/rooms/${code}/start`, {});
  expect(notHost.status).toBe(403);
  expect(await notHost.json()).toEqual({ error: "not_the_host" });

  const started = await postJson(host, `/api/card-clash/rooms/${code}/start`, {});
  expect(started.status).toBe(200);
  const body = (await started.json()) as { mode: string; viewerSeat: number; players: { seat: number; hand?: unknown }[] };
  expect(body.mode).toBe("1v2");
  expect(body.viewerSeat).toBe(1);
});

it("a repeated start does not regenerate the deck or hand — the exact same match is returned", async () => {
  const host = new CookieJar();
  const { code } = await createRoom(host, "1v1");
  const guest = new CookieJar();
  await postJson(guest, `/api/card-clash/rooms/${code}/join`, {});
  await postJson(host, `/api/card-clash/rooms/${code}/ready`, { ready: true });
  await postJson(guest, `/api/card-clash/rooms/${code}/ready`, { ready: true });

  const first = (await (await postJson(host, `/api/card-clash/rooms/${code}/start`, {})).json()) as {
    matchId: number;
    version: number;
    players: { seat: number; hand?: { id: string }[] }[];
  };
  const second = (await (await postJson(host, `/api/card-clash/rooms/${code}/start`, {})).json()) as typeof first;
  expect(second.matchId).toBe(first.matchId);
  expect(second.version).toBe(first.version);
  const ownHandFirst = first.players.find((p) => p.hand)!.hand!.map((c) => c.id);
  const ownHandSecond = second.players.find((p) => p.hand)!.hand!.map((c) => c.id);
  expect(ownHandSecond).toEqual(ownHandFirst);
});

it("GET /state rejects a non-player, returns a defined waiting status before start, and never leaks another seat's hand or the raw draw pile", async () => {
  const host = new CookieJar();
  const { code } = await createRoom(host, "1v1");
  const guest = new CookieJar();
  await postJson(guest, `/api/card-clash/rooms/${code}/join`, {});

  const stranger = new CookieJar();
  const strangerAttempt = await stranger.fetch(`/api/card-clash/rooms/${code}/state`);
  expect(strangerAttempt.status).toBe(403);

  const beforeStart = await host.fetch(`/api/card-clash/rooms/${code}/state`);
  expect(beforeStart.status).toBe(409);
  expect(await beforeStart.json()).toEqual({ status: "waiting" });

  await postJson(host, `/api/card-clash/rooms/${code}/ready`, { ready: true });
  await postJson(guest, `/api/card-clash/rooms/${code}/ready`, { ready: true });
  await postJson(host, `/api/card-clash/rooms/${code}/start`, {});

  const hostView = (await (await host.fetch(`/api/card-clash/rooms/${code}/state`)).json()) as {
    viewerSeat: number;
    drawPileCount: number;
    players: { seat: number; handSize: number; hand?: unknown }[];
  };
  expect(hostView.viewerSeat).toBe(1);
  expect(typeof hostView.drawPileCount).toBe("number");
  expect((hostView as unknown as Record<string, unknown>).drawPile).toBeUndefined(); // never the raw pile
  const ownEntry = hostView.players.find((p) => p.seat === 1)!;
  const otherEntry = hostView.players.find((p) => p.seat === 2)!;
  expect(ownEntry.hand).toBeDefined();
  expect(ownEntry.hand).toHaveLength(ownEntry.handSize);
  expect(otherEntry.hand).toBeUndefined(); // opponent's hand contents never included
  expect(otherEntry.handSize).toBeGreaterThan(0);

  const guestView = (await (await guest.fetch(`/api/card-clash/rooms/${code}/state`)).json()) as {
    players: { seat: number; hand?: { id: string }[] }[];
  };
  const guestOwnHand = guestView.players.find((p) => p.seat === 2)!.hand!.map((c) => c.id);
  const hostSeesOfGuest = hostView.players.find((p) => p.seat === 2)!;
  expect(JSON.stringify(hostSeesOfGuest)).not.toMatch(
    new RegExp(guestOwnHand.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")),
  ); // none of the guest's actual card ids appear in the host's view of them
});

it("existing Poker Lab and course-invariant routes remain operational alongside the new Card Clash API", async () => {
  const jar = new CookieJar();
  const home = await jar.fetch("/");
  expect(home.status).toBe(200);
  expect(await home.text()).toContain("Poker Lab");

  const readme = await jar.fetch("/readme/");
  expect(readme.status).toBe(200);

  const oldRoute = await jar.fetch("/campaigns", { method: "POST" });
  expect(oldRoute.status).toBe(404);
});
