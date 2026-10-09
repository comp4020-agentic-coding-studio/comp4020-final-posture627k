import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// D5A: the Card Clash page, exercised in jsdom against the real Hono app
// (fetch is bridged to app.fetch with a cookie jar, EventSource is a fake
// the test drives explicitly) — no network, no real timers beyond bounded
// waits for DOM updates.

let tempDir: string;
let previousDataDir: string | undefined;
let app: typeof import("../server.ts")["app"];

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "card-clash-ui-"));
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
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#cookies.size > 0) headers.set("cookie", [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await app.fetch(new Request(new URL(path, "http://localhost"), { ...init, headers }));
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";", 1)[0]!;
      const eq = pair.indexOf("=");
      this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  }
  post(path: string, body: unknown): Promise<Response> {
    return this.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  #listeners = new Map<string, (() => void)[]>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: () => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string): void {
    for (const fn of this.#listeners.get(type) ?? []) fn();
  }
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function openPage(jar: CookieJar, search = ""): Promise<JSDOM> {
  const html = await (await jar.fetch("/card-clash")).text();
  FakeEventSource.instances = [];
  return new JSDOM(html, {
    url: `http://localhost/card-clash${search}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      (window as unknown as { fetch: unknown }).fetch = (path: string, init?: RequestInit) => jar.fetch(path, init);
      (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
    },
  });
}

it("serves the page with HTTP 200, leaves the Poker Lab homepage alone, and never uses innerHTML", async () => {
  const jar = new CookieJar();
  const res = await jar.fetch("/card-clash");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain("Card Clash");
  expect(html).not.toContain("innerHTML");
  expect(html).toContain("/api/card-clash/rooms");
  const home = await (await jar.fetch("/")).text();
  expect(home).toContain("Poker Lab");
  expect(home).not.toContain("Card Clash");
});

it("state projection exposes a public turnPhase: main, then discard after ending a turn with excess cards", async () => {
  const host = new CookieJar();
  const guest = new CookieJar();
  const { code } = (await (await host.post("/api/card-clash/rooms", { mode: "1v1" })).json()) as { code: string };
  await guest.post(`/api/card-clash/rooms/${code}/join`, {});
  for (const j of [host, guest]) await j.post(`/api/card-clash/rooms/${code}/ready`, { ready: true });
  const started = (await (await host.post(`/api/card-clash/rooms/${code}/start`, {})).json()) as { turnPhase: string; version: number };
  expect(started.turnPhase).toBe("main");
  const after = (await (
    await host.post(`/api/card-clash/rooms/${code}/actions`, { type: "end_turn", expectedVersion: started.version, requestId: "ui-1" })
  ).json()) as { turnPhase: string };
  expect(after.turnPhase).toBe("discard");
});

it("lobby: create shows seats/teams/invite link; second player + readiness arrive via SSE refresh; host starts; board shows own hand, hidden opponent, deadline, and DISCARD phase", async () => {
  const hostJar = new CookieJar();
  const dom = await openPage(hostJar);
  const doc = dom.window.document;
  const appText = (): string => doc.getElementById("app")!.textContent ?? "";
  await waitFor(() => !!doc.getElementById("create"), "lobby entry");
  expect(appText()).toContain("Create Room");
  expect(appText()).toContain("Join Room");

  doc.getElementById("create")!.click();
  await waitFor(() => !!doc.getElementById("invite"), "room lobby");
  const code = dom.window.location.search.replace("?room=", "");
  expect(code).toHaveLength(8);
  expect((doc.getElementById("invite") as HTMLInputElement).value).toBe(`http://localhost/card-clash?room=${code}`);
  expect(appText()).toContain("Seat 1");
  expect(appText()).toContain("Seat 2");
  expect(appText()).toContain("Team A");
  expect(appText()).toContain("Team B");
  expect(appText()).toContain("Empty");
  expect((doc.getElementById("start") as HTMLButtonElement).disabled).toBe(true);
  expect(FakeEventSource.instances.at(-1)!.url).toBe(`/api/card-clash/rooms/${code}/events`);

  const guestJar = new CookieJar();
  await guestJar.post(`/api/card-clash/rooms/${code}/join`, {});
  await guestJar.post(`/api/card-clash/rooms/${code}/ready`, { ready: true });
  FakeEventSource.instances.at(-1)!.emit("invalidate");
  await waitFor(() => !appText().includes("Empty"), "second seat to appear");

  doc.getElementById("ready")!.click();
  await waitFor(() => doc.getElementById("ready")!.textContent === "Not ready", "own ready");
  await waitFor(() => !(doc.getElementById("start") as HTMLButtonElement).disabled, "start enabled");
  doc.getElementById("start")!.click();
  await waitFor(() => !!doc.getElementById("hand"), "board");

  const state = (await (await hostJar.fetch(`/api/card-clash/rooms/${code}/state`)).json()) as {
    deadline: { expiresAt: number }; version: number; players: { seat: number; handSize: number }[];
  };
  expect(doc.querySelectorAll("#hand .card")).toHaveLength(state.players[0]!.handSize); // own hand, readable
  expect(doc.querySelectorAll(".back")).toHaveLength(state.players[1]!.handSize); // opponent: backs only
  expect(doc.getElementById("phase")!.textContent).toBe("MAIN");
  expect(doc.getElementById("countdown")!.getAttribute("data-expires")).toBe(String(state.deadline.expiresAt));
  expect(doc.getElementById("countdown")!.textContent).toMatch(/^\d+\.\ds$/);

  // Opponent's actual hand never reaches the page.
  const guestState = (await (await guestJar.fetch(`/api/card-clash/rooms/${code}/state`)).json()) as {
    players: { seat: number; hand?: { type: string }[] }[];
  };
  const guestCards = guestState.players.find((p) => p.seat === 2)!.hand!.length;
  expect(guestCards).toBe(state.players[1]!.handSize);
  expect(doc.querySelectorAll("#hand .card")).toHaveLength(state.players[0]!.handSize);

  // SSE-driven refresh: an action changes the phase, the invalidate shows it.
  await hostJar.post(`/api/card-clash/rooms/${code}/actions`, { type: "end_turn", expectedVersion: state.version, requestId: "ui-2" });
  FakeEventSource.instances.at(-1)!.emit("invalidate");
  await waitFor(() => doc.getElementById("phase")!.textContent === "DISCARD", "DISCARD phase");
  dom.window.close();
});

it("join by invite link shows the room and a join button for a non-member; names are rendered as text", async () => {
  const hostJar = new CookieJar();
  const { code } = (await (await hostJar.post("/api/card-clash/rooms", { mode: "2v2" })).json()) as { code: string };
  const dom = await openPage(new CookieJar(), `?room=${code}`);
  const doc = dom.window.document;
  const appText = (): string => doc.getElementById("app")!.textContent ?? "";
  await waitFor(() => !!doc.getElementById("join-here"), "join button");
  expect(appText()).toContain(`Room ${code} (2v2)`);
  expect(doc.querySelectorAll(".seat")).toHaveLength(4);
  expect(FakeEventSource.instances).toHaveLength(0); // non-members do not subscribe
  dom.window.close();
});
