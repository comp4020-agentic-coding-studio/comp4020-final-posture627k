import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Poker foundation-slice tests. Like spec/migration.test.ts and the old
// realtime.test.ts's HTTP section, these run the real Hono `app` in-process
// (via app.fetch) against a fresh, isolated on-disk database per test,
// rather than against an externally-running instance — needed both for
// test isolation (table-code uniqueness and concurrent-join races must not
// see other tests' data) and because verifying an SSE notification requires
// the test and the stream to share the same in-memory realtime.ts registry.

let tempDir: string;
let previousDataDir: string | undefined;
let app: typeof import("../server.ts")["app"];
let db: typeof import("../db.ts");

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "poker-"));
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

// Minimal in-process cookie jar: calls app.fetch directly rather than a real
// network fetch, so independent "browsers" in these tests are genuinely
// independent without needing an externally-running server.
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

async function createTable(jar: CookieJar): Promise<string> {
  const res = await jar.fetch("/tables", { method: "POST" });
  expect(res.status).toBe(303);
  const code = res.headers.get("location")?.split("/").pop();
  expect(code).toBeTruthy();
  return code as string;
}

function openEvents(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(`/t/${code}/events`);
}

// Parses the SSE wire format off a real, incrementally-arriving stream (no
// fixed sleeps): each call either returns the next complete event block
// already buffered, or awaits more chunks, racing a bounded per-call timeout
// so a test fails fast and clearly — or, for the "no event arrived" case,
// deliberately expects that timeout.
function sseEvents(response: Response): {
  nextEvent: (timeoutMs?: number) => Promise<{ event: string; data: string }>;
  cancel: () => Promise<void>;
} {
  const body = response.body;
  if (!body) throw new Error("SSE response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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

      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`no SSE event arrived within ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
      if (chunk.done) throw new Error("SSE stream ended before the expected event arrived");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  async function cancel(): Promise<void> {
    await reader.cancel();
  }

  return { nextEvent, cancel };
}

// --- 1. Poker landing page -----------------------------------------------

it("the poker landing page returns 200 and describes Poker Lab", async () => {
  const jar = new CookieJar();
  const res = await jar.fetch("/");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Poker Lab");
});

// --- 2. /readme/ remains functional -----------------------------------------

it("/readme/ remains functional", async () => {
  const jar = new CookieJar();
  const res = await jar.fetch("/readme/");
  expect(res.status).toBe(200);
});

// --- 3. Table creation persists a real table --------------------------------

it("creating a table persists a real, readable table", async () => {
  const jar = new CookieJar();
  const code = await createTable(jar);

  const table = db.getPokerTableByCode(code);
  expect(table).toBeTruthy();
  expect(table?.status).toBe("waiting_for_players");
  expect(table?.startingStack).toBe(1000);
  expect(table?.smallBlind).toBe(5);
  expect(table?.bigBlind).toBe(10);

  const seats = db.getSeatsForTable(table!.id);
  expect(seats).toHaveLength(1);
  expect(seats[0]).toMatchObject({ seatNumber: 1, chipStack: 1000 });
});

// --- 4. Table codes are unique ----------------------------------------------

it("table codes are unique", async () => {
  const jar = new CookieJar();
  const codes = new Set<string>();
  for (let i = 0; i < 25; i++) {
    codes.add(await createTable(jar));
  }
  expect(codes.size).toBe(25);
});

// --- 5. Another identity joins the second seat ------------------------------

it("a second identity joins the second seat", async () => {
  const host = new CookieJar();
  const code = await createTable(host);

  const guest = new CookieJar();
  const res = await guest.fetch(`/t/${code}/join`, { method: "POST" });
  expect(res.status).toBe(303);

  const liveRes = await guest.fetch(`/t/${code}/live`);
  const html = await liveRes.text();
  expect(html).toContain("You are seat 2");
});

// --- 6. An identity cannot occupy both seats --------------------------------

it("the same identity cannot occupy both seats", async () => {
  const host = new CookieJar();
  const code = await createTable(host);

  const res = await host.fetch(`/t/${code}/join`, { method: "POST" });
  expect(res.status).toBe(303); // idempotent, not an error

  const table = db.getPokerTableByCode(code)!;
  const seats = db.getSeatsForTable(table.id);
  expect(seats).toHaveLength(1);
  expect(seats[0]?.seatNumber).toBe(1);
});

// --- 7. A third identity cannot join a full table ---------------------------

it("a third identity cannot join a full table", async () => {
  const host = new CookieJar();
  const code = await createTable(host);
  const guest = new CookieJar();
  await guest.fetch(`/t/${code}/join`, { method: "POST" });

  const stranger = new CookieJar();
  const res = await stranger.fetch(`/t/${code}/join`, { method: "POST" });
  expect(res.status).toBe(409);

  const table = db.getPokerTableByCode(code)!;
  expect(db.getSeatsForTable(table.id)).toHaveLength(2);
});

// --- 8. Idempotent rejoin does not create another seat ----------------------

it("an idempotent rejoin does not create another seat", async () => {
  const host = new CookieJar();
  const code = await createTable(host);
  const guest = new CookieJar();
  await guest.fetch(`/t/${code}/join`, { method: "POST" });

  const res = await guest.fetch(`/t/${code}/join`, { method: "POST" });
  expect(res.status).toBe(303);

  const table = db.getPokerTableByCode(code)!;
  expect(db.getSeatsForTable(table.id)).toHaveLength(2);
});

// --- 9. Unauthorized identity cannot modify another player's seat ----------

it("a join request ignores spoofed identity/seat fields and only ever seats the caller's own trusted identity", async () => {
  const host = new CookieJar();
  const code = await createTable(host);

  const stranger = new CookieJar();
  // The join route takes no body at all — identity comes solely from the
  // trusted session cookie. Submitting fields that look like an attempt to
  // claim another seat or another identity must have no effect: the
  // stranger can only ever end up seated as themselves, in the one open
  // seat, never as or instead of the host.
  const res = await stranger.fetch(`/t/${code}/join`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identityId=1&seat=1&seatNumber=1&chipStack=999999",
  });
  expect(res.status).toBe(303);

  const table = db.getPokerTableByCode(code)!;
  const seats = db.getSeatsForTable(table.id);
  const seat1 = seats.find((s) => s.seatNumber === 1)!;
  const seat2 = seats.find((s) => s.seatNumber === 2)!;
  expect(seat1.chipStack).toBe(1000); // untouched by the stranger's request
  expect(seat2.chipStack).toBe(1000); // not the spoofed 999999
  expect(seat1.identityId).not.toBe(seat2.identityId);
});

// --- 10. Table state survives database reopen -------------------------------

it("table state survives a fresh module reimport against the same data directory (simulated restart)", async () => {
  const host = new CookieJar();
  const code = await createTable(host);
  const guest = new CookieJar();
  await guest.fetch(`/t/${code}/join`, { method: "POST" });

  // Simulates a process restart: a completely fresh import of db.ts against
  // the same on-disk database, with nothing carried over in memory.
  vi.resetModules();
  const reopened: typeof import("../db.ts") = await import("../db.ts");

  const table = reopened.getPokerTableByCode(code);
  expect(table).toBeTruthy();
  expect(table?.status).toBe("ready");

  const seats = reopened.getSeatsForTable(table!.id);
  expect(seats).toHaveLength(2);
  expect(seats.map((s) => s.chipStack)).toEqual([1000, 1000]);
});

// --- 11. Two concurrent joins cannot overfill the table ---------------------

it("two concurrent joins for the last seat cannot both succeed", async () => {
  const host = new CookieJar();
  const code = await createTable(host);

  const guestA = new CookieJar();
  const guestB = new CookieJar();

  const [resA, resB] = await Promise.all([
    guestA.fetch(`/t/${code}/join`, { method: "POST" }),
    guestB.fetch(`/t/${code}/join`, { method: "POST" }),
  ]);

  const statuses = [resA.status, resB.status].sort();
  expect(statuses).toEqual([303, 409]);

  const table = db.getPokerTableByCode(code)!;
  expect(db.getSeatsForTable(table.id)).toHaveLength(2);
});

// --- 12. No negative initial chip balance -----------------------------------

it("no seat can ever hold a negative chip balance", async () => {
  const host = new CookieJar();
  const code = await createTable(host);
  const table = db.getPokerTableByCode(code)!;
  const seats = db.getSeatsForTable(table.id);
  expect(seats[0]?.chipStack).toBeGreaterThan(0);

  // The CHECK constraint itself, not just the application's own happy path,
  // is what prevents a negative balance from ever being persisted.
  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  expect(() => {
    raw
      .prepare("INSERT INTO poker_seats (table_id, identity_id, seat_number, chip_stack) VALUES (?, ?, 2, -1)")
      .run(table.id, 999999);
  }).toThrow();
  raw.close();
});

// --- 13. No old strategy-game endpoints expose gameplay ---------------------

it("old strategy-game endpoints no longer expose gameplay", async () => {
  const jar = new CookieJar();

  const createCampaign = await jar.fetch("/campaigns", { method: "POST" });
  expect(createCampaign.status).toBe(404);

  const viewCampaign = await jar.fetch("/c/ANYCODE1");
  expect(viewCampaign.status).toBe(404);

  const liveCampaign = await jar.fetch("/c/ANYCODE1/live");
  expect(liveCampaign.status).toBe(404);

  const eventsCampaign = await jar.fetch("/c/ANYCODE1/events");
  expect(eventsCampaign.status).toBe(404);

  const landing = await (await jar.fetch("/")).text();
  expect(landing.toLowerCase()).not.toContain("campaign");
  expect(landing.toLowerCase()).not.toContain("territory");
});

// --- 14. Poker-table SSE does not leak private state ------------------------

it("the table-change SSE event is content-free", async () => {
  const host = new CookieJar();
  const code = await createTable(host);
  const guest = new CookieJar();

  const res = await openEvents(host, code);
  const stream = sseEvents(res);
  await stream.nextEvent(); // discard "ready"

  await guest.fetch(`/t/${code}/join`, { method: "POST" });

  const event = await stream.nextEvent();
  expect(event.event).toBe("table_changed");
  expect(event.data).toBe(""); // content-free: no seat, no chip stack, no identity

  await stream.cancel();
});

// Also: a non-participant cannot subscribe at all, consistent with the
// strategy-war product's SSE gating.
it("a non-participant cannot open a table's events subscription", async () => {
  const host = new CookieJar();
  const code = await createTable(host);

  const stranger = new CookieJar();
  const res = await openEvents(stranger, code);
  expect(res.status).toBe(403);
});

// --- 15. Successful join creates exactly one notification ------------------

it("a successful join publishes exactly one notification", async () => {
  const host = new CookieJar();
  const code = await createTable(host);
  const guest = new CookieJar();

  const res = await openEvents(host, code);
  const stream = sseEvents(res);
  await stream.nextEvent(); // ready

  await guest.fetch(`/t/${code}/join`, { method: "POST" });

  const first = await stream.nextEvent();
  expect(first.event).toBe("table_changed");

  // No second table_changed should follow from the same single join.
  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/);

  await stream.cancel();
});

// --- 16. Idempotent/no-op join creates no notification ----------------------

it("an idempotent rejoin publishes no notification", async () => {
  const host = new CookieJar();
  const code = await createTable(host);
  const guest = new CookieJar();
  await guest.fetch(`/t/${code}/join`, { method: "POST" });

  const res = await openEvents(host, code);
  const stream = sseEvents(res);
  await stream.nextEvent(); // ready

  // Guest rejoins a seat they already hold: a no-op, must not publish.
  await guest.fetch(`/t/${code}/join`, { method: "POST" });

  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/);

  await stream.cancel();
});
