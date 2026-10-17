import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CardType } from "../card-clash/cards.ts";
import type { MatchState, Seat } from "../card-clash/types.ts";

// D5A: the Card Clash page, exercised in jsdom against the real Hono app
// (fetch is bridged to app.fetch with a cookie jar, EventSource is a fake
// the test drives explicitly) — no network, no real timers beyond bounded
// waits for DOM updates.

let tempDir: string;
let previousDataDir: string | undefined;
let app: typeof import("../server.ts")["app"];
let db: typeof import("../db.ts");

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "card-clash-ui-"));
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

it("serves the page with HTTP 200 at / and /card-clash (same app, no redirect), keeps legacy Poker at /poker, and never uses innerHTML", async () => {
  const jar = new CookieJar();
  const res = await jar.fetch("/card-clash");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain("Card Clash");
  expect(html).not.toContain("innerHTML");
  expect(html).toContain("/api/card-clash/rooms");
  const homeRes = await jar.fetch("/", { redirect: "manual" });
  expect(homeRes.status).toBe(200);
  const home = await homeRes.text();
  expect(home).toBe(html);
  expect(await (await jar.fetch("/?room=ABCD1234")).text()).toBe(html); // invites work on / too
  expect(await (await jar.fetch("/readme/")).text()).toContain("Card Clash");
  expect(home).toContain("<title>Card Clash</title>");
  expect(home).not.toContain("Poker Lab");
  const legacy = await (await jar.fetch("/poker")).text();
  expect(legacy).toContain("Poker Lab");
  expect((await jar.fetch("/t/ZZZZZZZZ")).status).toBe(404); // legacy table routes still answer
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

// P4: event-driven combat animation. Each case uses the same trusted-
// transition fixture helpers as spec/card-clash-play.test.ts's `force()` —
// a hand or pending state set directly through db.applyCardClashTransition
// rather than relying on whatever initializeMatch dealt — so the exact
// publicLog entry under test is always explicit and never incidental.
let fxUid = 0;
function fxCards(types: CardType[]): { id: string; type: CardType }[] {
  return types.map((type) => ({ id: `fx${fxUid++}`, type }));
}
function fxForce(matchId: number, mutate: (s: MatchState) => MatchState): void {
  const m = db.getCardClashMatchById(matchId)!;
  const r = db.applyCardClashTransition({
    matchId,
    requestId: `fx-force-${fxUid++}`,
    expectedVersion: m.version,
    transition: () => ({ ok: true, state: { ...mutate(m.state), version: m.version + 1 } }),
  });
  if (!r.ok) throw new Error("fxForce failed");
}
function fxWithHand(s: MatchState, seat: Seat, types: CardType[]): MatchState {
  const p = s.players.get(seat)!;
  return { ...s, players: new Map(s.players).set(seat, { ...p, hand: fxCards(types) }) };
}

it("P4: a confirmed attack_played event preserves the gauntlet pair and shows a VFX sprite on the target's station, then clears on its own, and a plain page refresh never replays it", async () => {
  const hostJar = new CookieJar();
  const { code } = (await (await hostJar.post("/api/card-clash/rooms", { mode: "1v1" })).json()) as { code: string };
  const guestJar = new CookieJar();
  await guestJar.post(`/api/card-clash/rooms/${code}/join`, {});
  for (const j of [hostJar, guestJar]) await j.post(`/api/card-clash/rooms/${code}/ready`, { ready: true });
  await hostJar.post(`/api/card-clash/rooms/${code}/start`, {});
  const room = db.getCardClashRoomByCode(code)!;
  const matchId = db.getCardClashMatchForRoom(room.id)!.id;

  fxForce(matchId, (s) => fxWithHand(s, 1, ["attack"]));
  const dom = await openPage(hostJar, `?room=${code}`);
  const doc = dom.window.document;
  await waitFor(() => !!doc.getElementById("hand"), "board");

  // No flash on first load even though the match already exists — only
  // entries added AFTER the page is open are "new" (brief's "no replay of
  // historical events on refresh").
  expect(doc.querySelector(".vfx-flash")).toBeNull();
  expect(doc.querySelector(".grip-fx")).toBeNull();
  expect(doc.querySelector(".grip-left")!.getAttribute("src")).toBe("/card-clash/hands/gauntlet_left");
  expect(doc.querySelector(".grip-right")!.getAttribute("src")).toBe("/card-clash/hands/gauntlet_right");

  const state = (await (await hostJar.fetch(`/api/card-clash/rooms/${code}/state`)).json()) as { version: number };
  await hostJar.post(`/api/card-clash/rooms/${code}/actions`, { type: "play_attack", targetSeat: 2, expectedVersion: state.version, requestId: "fx-attack-1" });
  FakeEventSource.instances.at(-1)!.emit("invalidate");

  await waitFor(() => !!doc.querySelector(".vfx-flash"), "sword_slash flash");
  expect(doc.querySelector(".vfx-flash")!.getAttribute("src")).toBe("/card-clash/fx/sword_slash");
  // The battlefield flash belongs to target seat 2, not the attacker HUD.
  const ownSeat = doc.getElementById("hand")!.closest(".hand-dock")!.querySelector(".self-hud .seat")!;
  expect(ownSeat.querySelector(".vfx-flash")).toBeNull(); // the flash is on the TARGET (seat 2), not the attacker
  // Combat feedback must never replace the fan's pair with a composite arm/leg pose.
  expect(doc.querySelector(".grip-fx")).toBeNull();
  expect(doc.querySelectorAll("#hand .grip-hand")).toHaveLength(2);
  expect(doc.querySelector(".grip-left")!.getAttribute("src")).toBe("/card-clash/hands/gauntlet_left");

  await waitFor(() => doc.querySelector(".vfx-flash") === null, "flash auto-clears");
  expect(doc.querySelector(".grip-fx")).toBeNull();
  expect(doc.querySelector(".grip-left")!.getAttribute("src")).toBe("/card-clash/hands/gauntlet_left");
  dom.window.close();
});

it("P4: from the target's own point of view, the same confirmed attack_played event poses the attacker's knight and anchors the VFX sprite on the target's own station", async () => {
  const hostJar = new CookieJar();
  const { code } = (await (await hostJar.post("/api/card-clash/rooms", { mode: "1v1" })).json()) as { code: string };
  const guestJar = new CookieJar();
  await guestJar.post(`/api/card-clash/rooms/${code}/join`, {});
  for (const j of [hostJar, guestJar]) await j.post(`/api/card-clash/rooms/${code}/ready`, { ready: true });
  await hostJar.post(`/api/card-clash/rooms/${code}/start`, {});
  const room = db.getCardClashRoomByCode(code)!;
  const matchId = db.getCardClashMatchForRoom(room.id)!.id;

  fxForce(matchId, (s) => fxWithHand(s, 1, ["attack"]));
  const dom = await openPage(guestJar, `?room=${code}`); // seat 2's own view
  const doc = dom.window.document;
  await waitFor(() => !!doc.getElementById("hand"), "board");

  const state = (await (await hostJar.fetch(`/api/card-clash/rooms/${code}/state`)).json()) as { version: number };
  await hostJar.post(`/api/card-clash/rooms/${code}/actions`, { type: "play_attack", targetSeat: 2, expectedVersion: state.version, requestId: "fx-attack-1b" });
  FakeEventSource.instances.at(-1)!.emit("invalidate");

  // Seat 1 (the attacker) is the only opponent from seat 2's point of view,
  // and briefly poses "attack" — public info only, derived from the
  // confirmed event, never a guess at what's about to happen.
  await waitFor(() => doc.querySelector(".knight-fig")?.getAttribute("src") === "/card-clash/knight/red/attack", "attacker pose");
  // The VFX lands on the target's own station (seat 2, this viewer).
  const ownSeat = doc.getElementById("hand")!.closest(".hand-dock")!.querySelector(".self-hud .seat")!;
  expect(ownSeat.querySelector(".vfx-flash")).not.toBeNull();
  // Seat 2 did not attack, so their own first-person hand never swaps.
  expect(doc.querySelector(".grip-fx")).toBeNull();
  expect(doc.querySelector(".grip-left")!.getAttribute("src")).toBe("/card-clash/hands/gauntlet_left");

  await waitFor(() => doc.querySelector(".knight-fig")!.getAttribute("src") !== "/card-clash/knight/red/attack", "pose clears");
  dom.window.close();
});

it("P4: respects prefers-reduced-motion — a confirmed event never produces a flash or a first-person pose swap when the viewer has that preference", async () => {
  const hostJar = new CookieJar();
  const { code } = (await (await hostJar.post("/api/card-clash/rooms", { mode: "1v1" })).json()) as { code: string };
  const guestJar = new CookieJar();
  await guestJar.post(`/api/card-clash/rooms/${code}/join`, {});
  for (const j of [hostJar, guestJar]) await j.post(`/api/card-clash/rooms/${code}/ready`, { ready: true });
  await hostJar.post(`/api/card-clash/rooms/${code}/start`, {});
  const room = db.getCardClashRoomByCode(code)!;
  const matchId = db.getCardClashMatchForRoom(room.id)!.id;
  fxForce(matchId, (s) => fxWithHand(s, 1, ["attack"]));

  const html = await (await hostJar.fetch("/card-clash")).text();
  FakeEventSource.instances = [];
  const dom = new JSDOM(html, {
    url: `http://localhost/card-clash?room=${code}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      (window as unknown as { fetch: unknown }).fetch = (path: string, init?: RequestInit) => hostJar.fetch(path, init);
      (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
      (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      });
    },
  });
  const doc = dom.window.document;
  await waitFor(() => !!doc.getElementById("hand"), "board");

  const state = (await (await hostJar.fetch(`/api/card-clash/rooms/${code}/state`)).json()) as { version: number };
  await hostJar.post(`/api/card-clash/rooms/${code}/actions`, { type: "play_attack", targetSeat: 2, expectedVersion: state.version, requestId: "fx-attack-2" });
  FakeEventSource.instances.at(-1)!.emit("invalidate");
  await waitFor(() => doc.getElementById("log")!.textContent!.includes("Seat 1 attacked"), "chronicle updated");

  expect(doc.querySelector(".vfx-flash")).toBeNull();
  expect(doc.querySelector(".grip-fx")).toBeNull();
  expect(doc.querySelector(".grip-left")!.getAttribute("src")).toBe("/card-clash/hands/gauntlet_left");
  dom.window.close();
});

it("P5.3: the same fan and independent gauntlets survive waiting, targeting, discard, defence, group response and rescue for both viewers in every mode", async () => {
  for (const mode of ["1v1", "1v2", "2v2"] as const) {
    const jars = [new CookieJar(), new CookieJar()];
    if (mode !== "1v1") jars.push(new CookieJar());
    if (mode === "2v2") jars.push(new CookieJar());
    const { code } = await (await jars[0]!.post("/api/card-clash/rooms", { mode })).json() as { code: string };
    for (const jar of jars.slice(1)) await jar.post(`/api/card-clash/rooms/${code}/join`, {});
    for (const jar of jars) await jar.post(`/api/card-clash/rooms/${code}/ready`, { ready: true });
    await jars[0]!.post(`/api/card-clash/rooms/${code}/start`, {});
    const matchId = db.getCardClashMatchForRoom(db.getCardClashRoomByCode(code)!.id)!.id;
    for (const seat of [1, 2] as const) {
      const foe = seat === 1 ? 2 : 1;
      fxForce(matchId, (s) => ({ ...fxWithHand(s, seat, ["attack", "dodge", "heal", "insight", "seize", "arrow_volley"]), activeSeat: seat, turnPhase: undefined, pending: undefined }));
      const dom = await openPage(jars[seat - 1]!, `?room=${code}`);
      const doc = dom.window.document;
      const assertFan = () => {
        expect(doc.querySelectorAll("#hand")).toHaveLength(1);
        expect(doc.querySelectorAll("#hand .card")).toHaveLength(6);
        expect(doc.querySelectorAll("#hand .grip-hand")).toHaveLength(2);
        expect(doc.querySelector(".grip-fx")).toBeNull();
        expect(doc.querySelector(".self-hud .seat")).not.toBeNull();
      };
      await waitFor(() => !!doc.getElementById("hand"), "main fan");
      assertFan();
      (doc.querySelector(".card-attack button") as HTMLButtonElement).click();
      expect(doc.querySelector(".card-attack.targeting")).not.toBeNull();
      assertFan();
      async function change(mutate: (s: MatchState) => MatchState, ready: () => boolean) {
        fxForce(matchId, mutate);
        FakeEventSource.instances.at(-1)!.emit("invalidate");
        await waitFor(ready, "phase transition");
        assertFan();
      }
      await change(s => ({ ...s, activeSeat: foe }), () => !!doc.getElementById("waiting"));
      await change(s => ({ ...s, activeSeat: seat, turnPhase: "discard" }), () => !!doc.getElementById("discard-note"));
      const discard = doc.querySelector("#hand button") as HTMLButtonElement;
      discard.focus(); discard.click();
      const selected = doc.querySelector('#hand button[aria-pressed="true"]');
      expect(selected).not.toBeNull();
      expect(doc.activeElement).toBe(selected);
      await change(s => ({ ...s, turnPhase: undefined, pending: { kind: "attack_response", attacker: foe, target: seat } }), () => !!doc.getElementById("act-respond_dodge"));
      expect(doc.getElementById("act-respond_dodge")!.closest(".zone")).not.toBeNull();
      await change(s => ({ ...s, pending: { kind: "group_response", context: { actor: foe, cardType: "war_cry", requiredResponseType: "attack", queue: [seat] } } }), () => !!doc.getElementById("act-respond_group_attack"));
      await change(s => ({ ...s, pending: { kind: "dying_rescue", dyingSeat: foe, queue: [seat, foe], resumeActiveSeat: seat } }), () => !!doc.getElementById("act-rescue_heal"));
      expect(doc.getElementById("act-rescue_heal")!.closest(".zone")).not.toBeNull();
      dom.window.close();
    }
  }
});
