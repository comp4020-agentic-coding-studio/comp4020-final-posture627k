import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { publish, subscribe, subscriberCount } from "../realtime.ts";

// Crit 9 Slice 1: SSE transport only (see docs/crit-9-architecture.md). Two
// independent groups of tests below:
//
// 1. Hub-direct tests exercise realtime.ts's exported functions with no HTTP
//    and no database at all — the module has none of its own.
//
// 2. HTTP/SSE boundary tests exercise the real Hono `app` (exported from
//    server.ts for exactly this purpose) in-process, via app.fetch — the
//    same way spec/migration.test.ts and spec/settlement.test.ts import
//    db.ts directly rather than going through an externally-running
//    instance. This is necessary here specifically because verifying that a
//    direct realtime.publish() call reaches an open SSE stream requires the
//    test and the stream to share the same in-memory subscriber registry,
//    which isn't possible against a separate process (the Docker container
//    the other spec files test against over `baseUrl`). This file does not
//    use `inject("baseUrl")` and does not need the externally-running app.

// --- 1. Hub-direct tests ----------------------------------------------------

let nextCampaignId = 900_000;
function freshCampaignId(): number {
  return nextCampaignId++;
}

it("publishing to a campaign with no subscribers is a safe no-op", () => {
  expect(() => publish(freshCampaignId())).not.toThrow();
});

it("a single subscriber receives exactly one notification per publish", () => {
  const campaignId = freshCampaignId();
  let calls = 0;
  subscribe(campaignId, () => {
    calls++;
  });

  publish(campaignId);

  expect(calls).toBe(1);
});

it("two subscribers to the same campaign both receive the publish", () => {
  const campaignId = freshCampaignId();
  let callsA = 0;
  let callsB = 0;
  subscribe(campaignId, () => {
    callsA++;
  });
  subscribe(campaignId, () => {
    callsB++;
  });

  publish(campaignId);

  expect(callsA).toBe(1);
  expect(callsB).toBe(1);
});

it("a publish for one campaign never reaches a subscriber of a different campaign", () => {
  const campaignA = freshCampaignId();
  const campaignB = freshCampaignId();
  let calls = 0;
  subscribe(campaignA, () => {
    calls++;
  });

  publish(campaignB);

  expect(calls).toBe(0);
});

it("unsubscribing prevents future delivery", () => {
  const campaignId = freshCampaignId();
  let calls = 0;
  const unsubscribe = subscribe(campaignId, () => {
    calls++;
  });

  unsubscribe();
  publish(campaignId);

  expect(calls).toBe(0);
});

it("a synchronously-throwing subscriber does not prevent another subscriber from receiving the same publish", () => {
  const campaignId = freshCampaignId();
  let callsB = 0;
  subscribe(campaignId, () => {
    throw new Error("subscriber A is broken");
  });
  subscribe(campaignId, () => {
    callsB++;
  });

  expect(() => publish(campaignId)).not.toThrow();
  expect(callsB).toBe(1);
});

it("a subscriber whose promise rejects does not prevent another subscriber from receiving the same publish", () => {
  const campaignId = freshCampaignId();
  let callsB = 0;
  subscribe(campaignId, async () => {
    throw new Error("subscriber A fails asynchronously");
  });
  subscribe(campaignId, () => {
    callsB++;
  });

  expect(() => publish(campaignId)).not.toThrow();
  expect(callsB).toBe(1);
});

it("a synchronously-throwing subscriber is removed from the registry", () => {
  const campaignId = freshCampaignId();
  subscribe(campaignId, () => {
    throw new Error("broken");
  });
  subscribe(campaignId, () => {});
  expect(subscriberCount(campaignId)).toBe(2);

  publish(campaignId);

  expect(subscriberCount(campaignId)).toBe(1);
});

it("a subscriber whose promise rejects is removed from the registry, with no unhandled rejection", async () => {
  const campaignId = freshCampaignId();
  subscribe(campaignId, async () => {
    throw new Error("async failure");
  });
  subscribe(campaignId, () => {});
  expect(subscriberCount(campaignId)).toBe(2);

  publish(campaignId);
  // The rejection is caught asynchronously (a microtask); give it one tick
  // to settle rather than asserting immediately or sleeping for real time.
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(subscriberCount(campaignId)).toBe(1);
});

// --- 2. HTTP/SSE boundary tests ----------------------------------------------

let app: typeof import("../server.ts")["app"];
let getCampaignByCode: typeof import("../db.ts")["getCampaignByCode"];
let tempDir: string;
let previousDataDir: string | undefined;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "gs-realtime-http-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  ({ app } = await import("../server.ts"));
  // Dynamically imported after server.ts, so this resolves to the exact same
  // already-loaded db.ts module instance (Node's module cache is keyed by
  // resolved file path) — i.e. the same on-disk database `app`'s routes use,
  // needed only to look up a campaign's numeric id from its code for the
  // direct-hub-publish test below.
  ({ getCampaignByCode } = await import("../db.ts"));
});

afterAll(() => {
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

async function createCampaign(jar: CookieJar): Promise<string> {
  const res = await jar.fetch("/campaigns", { method: "POST" });
  expect(res.status).toBe(303);
  const code = res.headers.get("location")?.split("/").pop();
  expect(code).toBeTruthy();
  return code as string;
}

function openEvents(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(`/c/${code}/events`);
}

// Parses the SSE wire format off a real, incrementally-arriving stream (no
// fixed sleeps): each call either returns the next complete "event: ...\n
// data: ...\n\n" block already buffered, or awaits more chunks, racing a
// bounded per-call timeout so a test fails fast and clearly if an expected
// event never arrives, instead of hanging.
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

it("an events subscription for an unknown campaign code 404s", async () => {
  const jar = new CookieJar();
  const res = await openEvents(jar, "NOSUCHCODE");
  expect(res.status).toBe(404);
});

it("a non-participant cannot open an events subscription", async () => {
  const host = new CookieJar();
  const stranger = new CookieJar();
  const code = await createCampaign(host);

  const res = await openEvents(stranger, code);
  expect(res.status).toBe(403);
});

it("a participant's events subscription returns a text/event-stream response", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);

  const res = await openEvents(host, code);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  await res.body?.getReader().cancel();
});

it("a participant's stream receives an initial transport-only ready signal", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);

  const res = await openEvents(host, code);
  const stream = sseEvents(res);

  const first = await stream.nextEvent();
  expect(first.event).toBe("ready");

  await stream.cancel();
});

it("a direct hub publish for that campaign's numeric id reaches its open HTTP stream as campaign_changed", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);
  const campaign = getCampaignByCode(code);
  expect(campaign).toBeTruthy();

  const res = await openEvents(host, code);
  const stream = sseEvents(res);
  await stream.nextEvent(); // discard the initial "ready" signal

  publish(campaign!.id);

  const event = await stream.nextEvent();
  expect(event.event).toBe("campaign_changed");
  expect(event.data).toBe(""); // content-free, per the architecture doc

  await stream.cancel();
});

it("closing the client connection removes the subscription from the hub", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);
  const campaign = getCampaignByCode(code);
  expect(campaign).toBeTruthy();

  const res = await openEvents(host, code);
  const stream = sseEvents(res);
  await stream.nextEvent(); // ready

  expect(subscriberCount(campaign!.id)).toBe(1);

  await stream.cancel();
  // Cleanup runs from the stream's abort callback asynchronously; give it
  // one tick rather than asserting immediately or sleeping for real time.
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(subscriberCount(campaign!.id)).toBe(0);
});

it("cancelling the connection before the first event is ever read still cleans up", async () => {
  // Regression test for a registration-ordering race found during the
  // Slice 1 lifecycle audit: the route used to register stream.onAbort()
  // only after its first `await` (the "ready" write). Hono's abort() is
  // single-shot and only invokes listeners already present at the moment it
  // fires, so a client disconnecting in that window could abort before
  // cleanup was ever registered, leaking the subscription (and the
  // heartbeat interval) for the process's lifetime. Cancelling as early as
  // possible here — before reading anything at all — exercises the
  // tightest version of that window available from outside the handler.
  const host = new CookieJar();
  const code = await createCampaign(host);
  const campaign = getCampaignByCode(code);
  expect(campaign).toBeTruthy();

  const res = await openEvents(host, code);
  await res.body?.getReader().cancel();

  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(subscriberCount(campaign!.id)).toBe(0);
});
