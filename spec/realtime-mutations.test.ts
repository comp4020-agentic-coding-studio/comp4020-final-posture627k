import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

// Crit 9 Slice 3: proves real gameplay mutations publish exactly when
// (and only when) they produce an effective shared state change, and that
// an already-open participant's SSE stream + /live refetch together reflect
// the new authoritative state. This needs the test and the SSE stream to
// share the same in-memory realtime.ts registry, which isn't possible
// against a separate process — so, like spec/realtime.test.ts, this file
// imports the real Hono `app` in-process (via app.fetch) rather than using
// `inject("baseUrl")`.

let app: typeof import("../server.ts")["app"];
let tempDir: string;
let previousDataDir: string | undefined;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "gs-realtime-mutations-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  ({ app } = await import("../server.ts"));
});

afterAll(() => {
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

async function createCampaign(jar: CookieJar): Promise<string> {
  const res = await jar.fetch("/campaigns", { method: "POST" });
  expect(res.status).toBe(303);
  const code = res.headers.get("location")?.split("/").pop();
  expect(code).toBeTruthy();
  return code as string;
}

function joinCampaign(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(`/c/${code}/join`, { method: "POST" });
}

function setPreset(jar: CookieJar, code: string, preset: string): Promise<Response> {
  return jar.fetch(`/c/${code}/settings`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `preset=${preset}`,
  });
}

function approve(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(`/c/${code}/approve`, { method: "POST" });
}

function start(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(`/c/${code}/start`, { method: "POST" });
}

function build(jar: CookieJar, code: string, row: number, col: number): Promise<Response> {
  return jar.fetch(`/c/${code}/build`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `row=${row}&col=${col}`,
  });
}

async function liveText(jar: CookieJar, code: string): Promise<string> {
  return (await jar.fetch(`/c/${code}/live`)).text();
}

async function pageText(jar: CookieJar, code: string): Promise<string> {
  return (await jar.fetch(`/c/${code}`)).text();
}

function openEvents(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(`/c/${code}/events`);
}

// Same SSE wire-format parser as spec/realtime.test.ts, plus a
// no-event-within-window counterpart for asserting absence.
function sseEvents(response: Response): {
  nextEvent: (timeoutMs?: number) => Promise<{ event: string; data: string }>;
  expectNoEventWithin: (timeoutMs?: number) => Promise<void>;
  cancel: () => Promise<void>;
} {
  const body = response.body;
  if (!body) throw new Error("SSE response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function parseOne(): { event: string; data: string } | undefined {
    const boundary = buffer.indexOf("\n\n");
    if (boundary === -1) return undefined;
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

  // Reads one more chunk, bounded by timeoutMs. Returns false on timeout
  // (no more data arrived in the window) rather than throwing, so callers
  // deciding "did anything show up" don't need to catch.
  async function pump(timeoutMs: number): Promise<boolean> {
    const result = await Promise.race([
      reader.read(),
      new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs)),
    ]);
    if ("timedOut" in result) return false;
    if (result.done) return false;
    buffer += decoder.decode(result.value, { stream: true });
    return true;
  }

  async function nextEvent(timeoutMs = 2000): Promise<{ event: string; data: string }> {
    for (;;) {
      const parsed = parseOne();
      if (parsed) return parsed;
      const more = await pump(timeoutMs);
      if (!more) throw new Error(`no SSE event arrived within ${timeoutMs}ms`);
    }
  }

  // Succeeds only if no complete event appears within timeoutMs — used to
  // prove a no-op mutation did NOT publish. 300ms is generous for a purely
  // in-process pub/sub with no network hop; nothing here ever needs a real
  // multi-second sleep.
  async function expectNoEventWithin(timeoutMs = 300): Promise<void> {
    const already = parseOne();
    if (already) throw new Error(`expected no event but one was already buffered: ${already.event}`);
    await pump(timeoutMs);
    const parsed = parseOne();
    if (parsed) throw new Error(`expected no event but got: ${parsed.event}`);
  }

  async function cancel(): Promise<void> {
    await reader.cancel();
  }

  return { nextEvent, expectNoEventWithin, cancel };
}

async function setUpOpenHostStream(): Promise<{
  host: CookieJar;
  code: string;
  stream: ReturnType<typeof sseEvents>;
}> {
  const host = new CookieJar();
  const code = await createCampaign(host);
  const res = await openEvents(host, code);
  const stream = sseEvents(res);
  await stream.nextEvent(); // discard the initial "ready" signal
  return { host, code, stream };
}

// --- 1-2: join -----------------------------------------------------------

it("B actually joining publishes exactly one campaign_changed to already-connected A", async () => {
  const { host, code, stream } = await setUpOpenHostStream();
  const b = new CookieJar();

  const res = await joinCampaign(b, code);
  expect(res.status).toBe(303);

  const event = await stream.nextEvent();
  expect(event.event).toBe("campaign_changed");

  await stream.cancel();
  void host;
});

it("the same identity re-joining idempotently does not publish an additional campaign_changed", async () => {
  const { host, code, stream } = await setUpOpenHostStream();
  const b = new CookieJar();

  await joinCampaign(b, code);
  await stream.nextEvent(); // the real join's event

  const repeat = await joinCampaign(b, code);
  expect(repeat.status).toBe(303); // still a successful, idempotent no-op

  await stream.expectNoEventWithin();
  await stream.cancel();
  void host;
});

// --- 3-4: settings ---------------------------------------------------------

it("changing the preset from Standard to Rapid publishes exactly one event", async () => {
  const { host, code, stream } = await setUpOpenHostStream();

  const res = await setPreset(host, code, "rapid");
  expect(res.status).toBe(303);

  const event = await stream.nextEvent();
  expect(event.event).toBe("campaign_changed");

  await stream.cancel();
});

it("resubmitting the already-active preset does not publish", async () => {
  const { host, code, stream } = await setUpOpenHostStream();

  await setPreset(host, code, "rapid");
  await stream.nextEvent(); // the real change's event

  const repeat = await setPreset(host, code, "rapid");
  expect(repeat.status).toBe(303); // still a successful no-op

  await stream.expectNoEventWithin();
  await stream.cancel();
});

// --- 5-7: approval ----------------------------------------------------------

it("A approving the current revision publishes exactly one event", async () => {
  const { host, code, stream } = await setUpOpenHostStream();

  const res = await approve(host, code);
  expect(res.status).toBe(303);

  const event = await stream.nextEvent();
  expect(event.event).toBe("campaign_changed");

  await stream.cancel();
});

it("A approving the same revision again does not publish an additional event", async () => {
  const { host, code, stream } = await setUpOpenHostStream();

  await approve(host, code);
  await stream.nextEvent(); // the real approval's event

  const repeat = await approve(host, code);
  expect(repeat.status).toBe(303); // still a successful, idempotent no-op

  await stream.expectNoEventWithin();
  await stream.cancel();
});

it("B's approval publishes exactly one event, and A's immediate /live refetch already shows Ready to start: yes (full SSE -> /live chain, join+approval variant)", async () => {
  const { host, code, stream } = await setUpOpenHostStream();
  const b = new CookieJar();
  await joinCampaign(b, code);
  await stream.nextEvent(); // join's event

  await approve(host, code);
  await stream.nextEvent(); // A's own approval event

  const res = await approve(b, code);
  expect(res.status).toBe(303);

  const event = await stream.nextEvent();
  expect(event.event).toBe("campaign_changed");

  // Commit-before-notification evidence: fetching /live immediately upon
  // receiving the event already shows the committed change, not a stale
  // snapshot from before B's approval.
  const fragment = await liveText(host, code);
  expect(fragment).toContain("Ready to start: yes");

  await stream.cancel();
});

// --- 8: unauthorized settings -----------------------------------------------

it("a non-host's settings attempt does not publish", async () => {
  const { host, code, stream } = await setUpOpenHostStream();
  const b = new CookieJar();
  await joinCampaign(b, code);
  await stream.nextEvent(); // join's event

  const res = await setPreset(b, code, "rapid");
  expect(res.status).toBe(403);

  await stream.expectNoEventWithin();
  await stream.cancel();
});

// --- 9: start preconditions ---------------------------------------------------

it("a start attempt before the campaign is ready 409s and does not publish", async () => {
  const { host, code, stream } = await setUpOpenHostStream();

  const res = await start(host, code);
  expect(res.status).toBe(409); // only one seat filled, nobody has approved

  await stream.expectNoEventWithin();
  await stream.cancel();
});

// --- 10: successful start ----------------------------------------------------

it("a successful start publishes exactly one event, and B's immediate /live refetch already shows the started world", async () => {
  const { host, code, stream } = await setUpOpenHostStream();
  const b = new CookieJar();
  await joinCampaign(b, code);
  await stream.nextEvent();
  await approve(host, code);
  await stream.nextEvent();
  await approve(b, code);
  await stream.nextEvent();

  const res = await start(host, code);
  expect(res.status).toBe(303);

  const event = await stream.nextEvent();
  expect(event.event).toBe("campaign_changed");

  const fragment = await liveText(b, code);
  expect(fragment).toContain("Status: started.");

  await stream.cancel();
});

// --- 11: successful construction (also the full SSE -> /live chain for a
//          started-world mutation, and commit-before-notification evidence) --

async function startFullyApprovedCampaignWithOpenHostStream(): Promise<{
  host: CookieJar;
  b: CookieJar;
  code: string;
  stream: ReturnType<typeof sseEvents>;
}> {
  const { host, code, stream } = await setUpOpenHostStream();
  const b = new CookieJar();
  await joinCampaign(b, code);
  await stream.nextEvent();
  await approve(host, code);
  await stream.nextEvent();
  await approve(b, code);
  await stream.nextEvent();
  await start(host, code);
  await stream.nextEvent();
  return { host, b, code, stream };
}

it("a successful resource-building construction publishes exactly one event, and the other participant's immediate /live refetch already shows the building", async () => {
  const { host, b, code, stream } = await startFullyApprovedCampaignWithOpenHostStream();

  const res = await build(b, code, 6, 6);
  expect(res.status).toBe(303);

  const event = await stream.nextEvent();
  expect(event.event).toBe("campaign_changed");

  // host (A) never built anything, but immediately refetching /live already
  // shows B's committed building — proving publish happens strictly after
  // the commit is already visible to a fresh authoritative read, not before.
  const fragment = await liveText(host, code);
  expect(fragment).toContain(">R2</td>");

  await stream.cancel();
});

// --- 12: failed construction --------------------------------------------------

it("a failed construction attempt (occupied tile) does not publish", async () => {
  const { host, code, stream } = await startFullyApprovedCampaignWithOpenHostStream();

  await build(host, code, 0, 1);
  await stream.nextEvent(); // the real construction's event

  const repeat = await build(host, code, 0, 1); // same tile, now occupied
  expect(repeat.status).toBe(409);

  await stream.expectNoEventWithin();
  await stream.cancel();
});

// --- 13: concurrent same-tile race --------------------------------------------

it("a concurrent same-tile build race publishes exactly one event (the winner only)", async () => {
  const { host, code, stream } = await startFullyApprovedCampaignWithOpenHostStream();

  const [first, second] = await Promise.all([build(host, code, 0, 1), build(host, code, 0, 1)]);
  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual([303, 409]);

  const event = await stream.nextEvent();
  expect(event.event).toBe("campaign_changed");
  await stream.expectNoEventWithin(); // the loser must not have published too

  await stream.cancel();
});

// --- 14-15: settlement never publishes ----------------------------------------

it("a plain GET /c/:code that settles the caller's own resources does not publish", async () => {
  const { host, b, code, stream } = await startFullyApprovedCampaignWithOpenHostStream();
  await build(b, code, 6, 6);
  await stream.nextEvent(); // the construction's own event

  await pageText(host, code); // triggers host's own settle-on-read

  await stream.expectNoEventWithin();
  await stream.cancel();
});

it("a GET /c/:code/live that settles the caller's own resources does not publish", async () => {
  const { host, b, code, stream } = await startFullyApprovedCampaignWithOpenHostStream();
  await build(b, code, 6, 6);
  await stream.nextEvent(); // the construction's own event

  await liveText(host, code); // triggers host's own settle-on-read

  await stream.expectNoEventWithin();
  await stream.cancel();
});

// --- 16-17: cross-campaign isolation and multi-subscriber fan-out ------------

it("a mutation in campaign A is never delivered to a subscriber of campaign B", async () => {
  const { code: codeA, stream: streamA } = await setUpOpenHostStream();
  const hostB = new CookieJar();
  const codeB = await createCampaign(hostB);
  const resB = await openEvents(hostB, codeB);
  const streamB = sseEvents(resB);
  await streamB.nextEvent(); // ready

  const joinerA = new CookieJar();
  await joinCampaign(joinerA, codeA);
  await streamA.nextEvent(); // A's own subscriber does receive it

  await streamB.expectNoEventWithin();

  await streamA.cancel();
  await streamB.cancel();
});

it("a successful mutation with two subscribers on the same campaign delivers to both", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);

  const resHost = await openEvents(host, code);
  const streamHost = sseEvents(resHost);
  await streamHost.nextEvent(); // ready

  const b = new CookieJar();
  await joinCampaign(b, code);
  const resB = await openEvents(b, code);
  const streamB = sseEvents(resB);
  await streamB.nextEvent(); // ready

  const res = await approve(host, code);
  expect(res.status).toBe(303);

  const eventHost = await streamHost.nextEvent();
  const eventB = await streamB.nextEvent();
  expect(eventHost.event).toBe("campaign_changed");
  expect(eventB.event).toBe("campaign_changed");

  await streamHost.cancel();
  await streamB.cancel();
});
