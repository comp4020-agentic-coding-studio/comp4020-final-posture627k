import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CardType } from "../card-clash/cards.ts";
import type { MatchState, PendingResponse, Seat } from "../card-clash/types.ts";

// D5B: the playable Card Clash page in jsdom against the real Hono app and
// SQLite. Every action goes browser-JS -> POST /actions -> engine; the test
// only arranges known hands/pending states through the trusted-transition
// interface (as the other Card Clash specs do) and then drives real clicks.
// This is NOT a real-browser playtest (see docs/card-clash-playtest.md).

let tempDir: string;
let previousDataDir: string | undefined;
let app: typeof import("../server.ts")["app"];
let db: typeof import("../db.ts");

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "card-clash-play-"));
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

class Jar {
  #c = new Map<string, string>();
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#c.size) headers.set("cookie", [...this.#c].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await app.fetch(new Request(new URL(path, "http://localhost"), { ...init, headers }));
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";", 1)[0]!;
      const eq = pair.indexOf("=");
      this.#c.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  }
  post(path: string, body: unknown): Promise<Response> {
    return this.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
}

type Mode = "1v1" | "1v2" | "2v2";
async function setup(mode: Mode): Promise<{ code: string; jars: Record<number, Jar>; matchId: number; roomId: number }> {
  const n = { "1v1": 2, "1v2": 3, "2v2": 4 }[mode];
  const jars: Record<number, Jar> = { 1: new Jar() };
  const { code } = (await (await jars[1]!.post("/api/card-clash/rooms", { mode })).json()) as { code: string };
  for (let s = 2; s <= n; s++) {
    jars[s] = new Jar();
    await jars[s]!.post(`/api/card-clash/rooms/${code}/join`, {});
  }
  for (let s = 1; s <= n; s++) await jars[s]!.post(`/api/card-clash/rooms/${code}/ready`, { ready: true });
  await jars[1]!.post(`/api/card-clash/rooms/${code}/start`, {});
  const room = db.getCardClashRoomByCode(code)!;
  return { code, jars, matchId: db.getCardClashMatchForRoom(room.id)!.id, roomId: room.id };
}

let uid = 0;
function cards(types: CardType[]): { id: string; type: CardType }[] {
  return types.map((type) => ({ id: `f${uid++}`, type }));
}
function force(matchId: number, mutate: (s: MatchState) => MatchState): void {
  const m = db.getCardClashMatchById(matchId)!;
  const r = db.applyCardClashTransition({
    matchId, requestId: `force-${uid++}`, expectedVersion: m.version,
    transition: () => ({ ok: true, state: { ...mutate(m.state), version: m.version + 1 } }),
  });
  if (!r.ok) throw new Error("force failed");
}
function withHand(s: MatchState, seat: Seat, types: CardType[], extra: Partial<{ hp: number; eliminated: boolean }> = {}): MatchState {
  const p = s.players.get(seat)!;
  return { ...s, players: new Map(s.players).set(seat, { ...p, ...extra, hand: cards(types) }) };
}
function cur(matchId: number): MatchState { return db.getCardClashMatchById(matchId)!.state; }
function setPending(s: MatchState, pending: PendingResponse | undefined): MatchState { return { ...s, pending }; }

function makeES() {
  return class ES {
    static instances: ES[] = [];
    ls = new Map<string, (() => void)[]>();
    constructor(public url: string) { ES.instances.push(this); }
    addEventListener(t: string, f: () => void) { this.ls.set(t, [...(this.ls.get(t) ?? []), f]); }
    close() {}
    emit(t: string) { for (const f of this.ls.get(t) ?? []) f(); }
  };
}
interface Page { dom: JSDOM; doc: Document; posts: Record<string, unknown>[]; emit: () => void }
async function open(jar: Jar, code: string, readyId = "controls"): Promise<Page> {
  const html = await (await jar.fetch("/card-clash")).text();
  const ES = makeES();
  const posts: Record<string, unknown>[] = [];
  const dom = new JSDOM(html, {
    url: `http://localhost/card-clash?room=${code}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      const win = w as unknown as Record<string, unknown>;
      win.fetch = (path: string, init?: RequestInit) => {
        if (init?.method === "POST" && path.endsWith("/actions")) posts.push(JSON.parse(String(init.body)));
        return jar.fetch(path, init);
      };
      win.EventSource = ES;
    },
  });
  const doc = dom.window.document;
  await waitFor(() => !!doc.getElementById(readyId), readyId);
  return { dom, doc, posts, emit: () => ES.instances.at(-1)!.emit("invalidate") };
}
async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("timed out waiting for " + what);
}
const q = (p: Page, id: string) => p.doc.getElementById(id) as HTMLButtonElement | null;
async function click(p: Page, id: string): Promise<void> {
  await waitFor(() => !!q(p, id) && !q(p, id)!.disabled, id + " enabled");
  q(p, id)!.click();
}

it("Attack with target selection sends a flat action; the target sees Dodge/Decline (via SSE, no reload), a bystander only waits; Dodge cancels, Decline costs 1 HP", async () => {
  const { code, jars, matchId } = await setup("1v1");
  force(matchId, (s) => withHand(withHand(s, 1, ["attack", "attack"]), 2, ["dodge"]));
  const p1 = await open(jars[1]!, code);
  const p2 = await open(jars[2]!, code);
  expect(q(p2, "act-play_attack")).toBeNull(); // not seat 2's turn
  expect(p2.doc.getElementById("waiting")!.textContent).toContain("Waiting for seat 1");

  await click(p1, "act-play_attack");
  await click(p1, "target-2");
  await waitFor(() => cur(matchId).pending?.kind === "attack_response", "pending attack");
  const body = p1.posts[0]!;
  expect(Object.keys(body).sort()).toEqual(["expectedVersion", "requestId", "targetSeat", "type"]);
  expect(body).toMatchObject({ type: "play_attack", targetSeat: 2 });
  expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/);

  p2.emit(); // SSE invalidate -> refetch
  await waitFor(() => !!q(p2, "act-respond_dodge"), "dodge control");
  expect(q(p2, "act-decline_attack_response")).not.toBeNull();
  p1.emit();
  await waitFor(() => !!p1.doc.getElementById("waiting"), "attacker waits");
  expect(q(p1, "act-respond_dodge")).toBeNull();

  await click(p2, "act-respond_dodge");
  await waitFor(() => cur(matchId).pending === undefined, "dodged");
  expect(cur(matchId).players.get(2)!.hp).toBe(3);

  force(matchId, (s) => setPending(withHand(s, 2, []), { kind: "attack_response", attacker: 1, target: 2 }));
  p2.emit();
  await waitFor(() => q(p2, "act-respond_dodge")?.disabled === true, "dodge disabled without a Dodge card");
  await click(p2, "act-decline_attack_response");
  await waitFor(() => cur(matchId).players.get(2)!.hp === 2, "damage applied");
});

it("Heal, Seize, Disarm, Insight, War Cry and Arrow Volley are playable from the page", async () => {
  const cases: { card: CardType; type: string; target?: boolean; check: (s: MatchState) => boolean }[] = [
    { card: "heal", type: "play_heal", check: (s) => s.players.get(1)!.hp === 3 },
    { card: "seize", type: "play_seize", target: true, check: (s) => s.publicLog.some((e) => e.type === "seize_played") },
    { card: "disarm", type: "play_disarm", target: true, check: (s) => s.publicLog.some((e) => e.type === "disarm_card_revealed") },
    { card: "insight", type: "play_insight", check: (s) => s.publicLog.some((e) => e.type === "insight_played") },
    { card: "war_cry", type: "play_war_cry", check: (s) => s.pending?.kind === "group_response" },
    { card: "arrow_volley", type: "play_arrow_volley", check: (s) => s.pending?.kind === "group_response" },
  ];
  for (const c of cases) {
    const { code, jars, matchId } = await setup("1v1");
    force(matchId, (s) => withHand(withHand(s, 1, [c.card], c.card === "heal" ? { hp: 2 } : {}), 2, ["attack"]));
    const p = await open(jars[1]!, code);
    await click(p, "act-" + c.type);
    if (c.target) await click(p, "target-2");
    await waitFor(() => c.check(cur(matchId)), c.type);
    expect(p.posts[0]).not.toHaveProperty("cardId");
    p.dom.window.close();
  }
});

it("group responses (Attack / Dodge / Decline) and dying rescue (Heal / Decline, dying seat shown) show only the right controls", async () => {
  const { code, jars, matchId } = await setup("1v1");
  force(matchId, (s) =>
    setPending(withHand(withHand(s, 1, []), 2, ["attack", "dodge"]), { kind: "group_response", context: { actor: 1, cardType: "war_cry", requiredResponseType: "attack", queue: [2] } }));
  const p2 = await open(jars[2]!, code);
  const p1 = await open(jars[1]!, code);
  expect(q(p2, "act-respond_group_attack")).not.toBeNull();
  expect(q(p2, "act-respond_group_dodge")).toBeNull(); // war cry wants an Attack, not a Dodge
  expect(q(p2, "act-respond_dodge")).toBeNull();
  expect(q(p1, "act-respond_group_attack")).toBeNull();
  await click(p2, "act-respond_group_attack");
  await waitFor(() => cur(matchId).pending === undefined, "war cry answered");

  force(matchId, (s) =>
    setPending(withHand(s, 2, ["dodge"]), { kind: "group_response", context: { actor: 1, cardType: "arrow_volley", requiredResponseType: "dodge", queue: [2] } }));
  p2.emit();
  await click(p2, "act-respond_group_dodge");
  await waitFor(() => cur(matchId).pending === undefined, "volley dodged");
  force(matchId, (s) =>
    setPending(s, { kind: "group_response", context: { actor: 1, cardType: "arrow_volley", requiredResponseType: "dodge", queue: [2] } }));
  p2.emit();
  await click(p2, "act-decline_group_response");
  await waitFor(() => cur(matchId).players.get(2)!.hp === 2, "volley damage");

  force(matchId, (s) =>
    setPending(withHand(withHand(s, 2, [], { hp: 0 }), 1, ["heal"]), { kind: "dying_rescue", dyingSeat: 2, queue: [1, 2], resumeActiveSeat: 1 }));
  p1.emit();
  p2.emit();
  await waitFor(() => !!q(p1, "act-rescue_heal"), "rescue controls");
  expect(p1.doc.getElementById("rescue-note")!.textContent).toContain("Seat 2 is dying");
  expect(q(p2, "act-rescue_heal")).toBeNull();
  expect(p2.doc.getElementById("waiting")!.textContent).toContain("Seat 2 is dying");
  await click(p1, "act-decline_rescue");
  await waitFor(() => (cur(matchId).pending as unknown as { queue: Seat[] }).queue.length === 1, "next rescuer");
  p2.emit();
  await waitFor(() => !!q(p2, "act-decline_rescue"), "dying seat's own chance");
  expect(p2.doc.getElementById("rescue-note")!.textContent).toContain("(you)");

  force(matchId, (s) => withHand(s, 1, ["heal"]));
  force(matchId, (s) => setPending(s, { kind: "dying_rescue", dyingSeat: 2, queue: [1, 2], resumeActiveSeat: 1 }));
  p1.emit();
  await click(p1, "act-rescue_heal");
  await waitFor(() => cur(matchId).players.get(2)!.hp === 1 && cur(matchId).pending === undefined, "rescued");
});

it("End Turn with excess enters DISCARD (no End Turn shortcut), multi-select sends real cardIds, and the turn then advances", async () => {
  const { code, jars, matchId } = await setup("1v1");
  force(matchId, (s) => withHand(s, 1, ["heal", "heal", "heal", "attack", "dodge"]));
  const p = await open(jars[1]!, code);
  await click(p, "act-end_turn");
  await waitFor(() => cur(matchId).turnPhase === "discard", "discard phase");
  await waitFor(() => !!q(p, "act-discard_cards"), "discard controls");
  expect(q(p, "act-end_turn")).toBeNull();
  expect(p.doc.getElementById("discard-note")!.textContent).toContain("choose 2");
  expect(q(p, "act-discard_cards")!.disabled).toBe(true);
  const hand = cur(matchId).players.get(1)!.hand;
  await click(p, "card-" + hand[0]!.id);
  await click(p, "card-" + hand[3]!.id);
  await click(p, "act-discard_cards");
  await waitFor(() => cur(matchId).activeSeat === 2, "turn advanced");
  expect(p.posts.at(-1)).toMatchObject({ type: "discard_cards", cardIds: [hand[0]!.id, hand[3]!.id] });
  expect(cur(matchId).players.get(1)!.hand).toHaveLength(3);
});

it("double-click sends one request; a stale version and an expired deadline both refresh the board with an explanation and never retry", async () => {
  const { code, jars, matchId } = await setup("1v1");
  force(matchId, (s) => withHand(s, 1, ["heal"]));
  const p = await open(jars[1]!, code);
  q(p, "act-end_turn")!.click();
  q(p, "act-end_turn")!.click();
  await waitFor(() => p.posts.length >= 1, "request");
  await new Promise((r) => setTimeout(r, 150));
  expect(p.posts).toHaveLength(1);

  // Stale: the board changed behind the page's back (no SSE yet).
  const { code: code2, jars: jars2, matchId: m2 } = await setup("1v1");
  const ps = await open(jars2[1]!, code2);
  force(m2, (s) => withHand(s, 1, ["heal"]));
  await click(ps, "act-end_turn");
  await waitFor(() => (ps.doc.getElementById("message")?.textContent ?? "").includes("action window has passed"), "stale message");
  expect(ps.posts).toHaveLength(1);

  // Expired: deadline lapses in SQLite while the page still shows time left.
  const { code: code3, jars: jars3, matchId: m3 } = await setup("1v1");
  force(m3, (s) => withHand(s, 1, ["heal"]));
  const pe = await open(jars3[1]!, code3);
  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  raw.exec("UPDATE card_clash_deadlines SET expires_at = 1");
  raw.close();
  await click(pe, "act-end_turn");
  await waitFor(() => (pe.doc.getElementById("message")?.textContent ?? "").includes("action window has passed"), "expired message");
  expect(pe.posts).toHaveLength(1);
  expect(cur(m3).activeSeat).toBe(2); // the server's own timeout applied
});

it("shows the winner, an eliminated player is a read-only spectator, and opponent cards never reach the page", async () => {
  const { code, jars, matchId } = await setup("2v2");
  force(matchId, (s) => withHand(withHand(s, 3, ["attack"], { hp: 0, eliminated: true }), 2, ["attack", "dodge"]));
  const p3 = await open(jars[3]!, code);
  expect(p3.doc.getElementById("spectating")).not.toBeNull();
  expect(p3.doc.querySelectorAll("#controls button")).toHaveLength(0);
  const p1 = await open(jars[1]!, code);
  const secretIds = cur(matchId).players.get(2)!.hand.map((c) => c.id);
  for (const id of secretIds) expect(p1.doc.documentElement.outerHTML).not.toContain(id);

  force(matchId, (s) => ({ ...s, matchResult: { status: "complete", winningTeam: "A" } }));
  p1.emit();
  await waitFor(() => (p1.doc.getElementById("winner")?.textContent ?? "").includes("Team A"), "winner");
  expect(p1.doc.querySelectorAll("#controls button")).toHaveLength(0);
});
