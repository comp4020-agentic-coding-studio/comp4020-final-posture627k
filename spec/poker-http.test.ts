import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cardKey, type Card } from "../poker/cards.ts";
import { createDeck } from "../poker/deck.ts";
import { getLegalActions, type Seat } from "../poker/betting.ts";

// Slice 5B: HTTP-level tests for the two new gameplay routes
// (POST /t/:code/hand/start, POST /t/:code/hand/action) and the extended
// server-rendered table page, built the same way as spec/poker.test.ts —
// the real Hono `app` exercised in-process via app.fetch against a fresh,
// isolated on-disk database per test. Deterministic outcomes (showdown
// winner, all-in runout) use db.createPokerHand's test-only overrideDeck
// parameter, called directly against the database for setup — never
// through any HTTP route, which accepts no such parameter.

let tempDir: string;
let previousDataDir: string | undefined;
let app: typeof import("../server.ts")["app"];
let db: typeof import("../db.ts");

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "poker-http-"));
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
  return res.headers.get("location")!.split("/").pop() as string;
}

function openEvents(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(`/t/${code}/events`);
}

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

async function setUpReadyTable(): Promise<{ host: CookieJar; guest: CookieJar; code: string; tableId: number }> {
  const host = new CookieJar();
  const code = await createTable(host);
  const guest = new CookieJar();
  const res = await guest.fetch(`/t/${code}/join`, { method: "POST" });
  expect(res.status).toBe(303);
  const table = db.getPokerTableByCode(code)!;
  return { host, guest, code, tableId: table.id };
}

function jarBySeat(host: CookieJar, guest: CookieJar): Record<Seat, CookieJar> {
  // joinPokerTable always seats the joiner in seat 2 and the creator in
  // seat 1 — this is asserted, not merely assumed, by every call site below
  // via identityForSeat's own lookup, so a wrong assumption here would show
  // up as a failing assertion rather than a silently-misattributed action.
  return { 1: host, 2: guest };
}

function identityForSeat(tableId: number, seat: Seat): number {
  return db.getSeatsForTable(tableId).find((s) => s.seatNumber === seat)!.identityId;
}

// Simulates a real browser submitting the real rendered form: after_hand_number
// is now a mandatory field (the HTTP route rejects a request missing it —
// see server.ts's requireAfterHandNumber), so every generic test helper
// call must supply the value the real page would have rendered at this
// moment — the table's current latest hand_number (0 if none yet),
// computed synchronously, before the request is sent, exactly like reading
// a hidden form field off an already-rendered page.
async function startHand(jar: CookieJar, code: string): Promise<Response> {
  const table = db.getPokerTableByCode(code)!;
  const afterHandNumber = db.getLatestHandForTable(table.id)?.handNumber ?? 0;
  return jar.fetch(`/t/${code}/hand/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `after_hand_number=${afterHandNumber}`,
  });
}

async function postAction(
  jar: CookieJar,
  code: string,
  body: { hand_id: string | number; request_id: string; expected_version: string | number; action: string; amount?: string | number },
): Promise<Response> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return jar.fetch(`/t/${code}/hand/action`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

let autoRequestId = 0;
function freshRequestId(): string {
  autoRequestId += 1;
  return `req-${autoRequestId}-${Math.random().toString(36).slice(2)}`;
}

// Checks or calls down every street automatically until the hand is no
// longer active (settled) or no seat can act, driving every action through
// the real HTTP route — used by tests that only need to reach a terminal
// state, not to control exactly how.
async function checkOrCallDown(code: string, seats: Record<Seat, CookieJar>): Promise<void> {
  const tableId = db.getPokerTableByCode(code)!.id;
  for (let i = 0; i < 20; i++) {
    const hand = db.getActiveHandForTable(tableId);
    if (!hand) return;
    const actingSeat = hand.bettingState.actingSeat;
    if (!actingSeat) return;
    const legal = getLegalActions(hand.bettingState, actingSeat);
    const action = legal.actions.includes("check") ? "check" : "call";
    const res = await postAction(seats[actingSeat], code, {
      hand_id: hand.id,
      request_id: freshRequestId(),
      expected_version: hand.version,
      action,
    });
    expect(res.status).toBe(303);
  }
  throw new Error("hand did not settle within 20 automatic actions");
}

function c(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

// Same technique as spec/poker-hand-lifecycle.test.ts: places the given
// cards at the front of a full 52-card deck, filling the rest with every
// remaining card in a fixed order.
function buildFixedDeck(firstCards: Card[]): Card[] {
  const used = new Set(firstCards.map(cardKey));
  const rest = createDeck().filter((card) => !used.has(cardKey(card)));
  return [...firstCards, ...rest];
}

// Seat 1 (button) gets pocket aces; seat 2 gets a weak unpaired hand. The
// board pairs kings for both, but seat 1's aces make two pair (aces up)
// against seat 2's one pair of kings — an unambiguous, reproducible
// showdown winner.
const SEAT1_WINS_DECK = buildFixedDeck([
  c(14, "hearts"),
  c(14, "spades"), // seat 1 hole
  c(7, "clubs"),
  c(6, "diamonds"), // seat 2 hole
  c(13, "clubs"),
  c(13, "diamonds"),
  c(9, "hearts"), // flop
  c(4, "spades"), // turn
  c(2, "clubs"), // river
]);

// --- 1. Ready-table requirement: cannot start a hand before both seated ---

it("starting a hand before the table is ready is rejected", async () => {
  const host = new CookieJar();
  const code = await createTable(host);

  const res = await startHand(host, code);
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("Both seats must be filled");

  const table = db.getPokerTableByCode(code)!;
  expect(db.getActiveHandForTable(table.id)).toBeUndefined();
});

// --- 2. Non-player cannot start a hand ------------------------------------

it("a non-player cannot start a hand even once the table is ready", async () => {
  const { code, tableId } = await setUpReadyTable();

  const stranger = new CookieJar();
  const res = await startHand(stranger, code);
  expect(res.status).toBe(403);
  expect(await res.text()).toContain("Only a seated player");
  expect(db.getActiveHandForTable(tableId)).toBeUndefined();
});

// --- 3. Valid hand start by a seated player -------------------------------

it("a seated player can start a hand once the table is ready, publishing exactly one notification (Scenario A)", async () => {
  const { host, code, tableId } = await setUpReadyTable();

  const streamRes = await openEvents(host, code);
  const stream = sseEvents(streamRes);
  await stream.nextEvent(); // ready

  const res = await startHand(host, code);
  expect(res.status).toBe(303);

  const hand = db.getActiveHandForTable(tableId);
  expect(hand).toBeTruthy();
  expect(hand?.status).toBe("active");
  expect(hand?.handNumber).toBe(1);
  expect(hand?.buttonSeat).toBe(1);

  const event = await stream.nextEvent();
  expect(event.event).toBe("table_changed");
  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/); // exactly one
  await stream.cancel();
});

// --- 4. Second active-hand start is rejected without error ----------------

it("starting a hand while one is already active is a no-op, not an error, and publishes no second notification (Scenario B)", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const firstHand = db.getActiveHandForTable(tableId)!;
  const totalBefore = db.getSeatsForTable(tableId).reduce((sum, s) => sum + s.chipStack, 0);

  const streamRes = await openEvents(host, code);
  const stream = sseEvents(streamRes);
  await stream.nextEvent(); // ready

  // The identical start request repeated (same after_hand_number, since
  // startHand recomputes it fresh each call and the first call hasn't
  // changed the table's latest hand_number as observed before either ran).
  const res = await startHand(guest, code);
  expect(res.status).toBe(303); // redirected to view the already-active hand, not an error

  const seats = db.getSeatsForTable(tableId);
  expect(seats.every((s) => s.chipStack >= 0)).toBe(true);
  const stillActive = db.getActiveHandForTable(tableId)!;
  expect(stillActive.id).toBe(firstHand.id); // no second hand was created
  const totalAfter = seats.reduce((sum, s) => sum + s.chipStack, 0);
  expect(totalAfter).toBe(totalBefore); // no chip mutation from the repeated request

  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/); // no second notification
  await stream.cancel();
});

// --- 5. Private-card isolation during active play -------------------------

it("each player's own view reveals only their own hole cards, never the opponent's", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;

  const hostIdentityId = identityForSeat(tableId, 1);
  const guestIdentityId = identityForSeat(tableId, 2);
  const hostCards = db.getOwnHoleCards(hand.id, hostIdentityId)!;
  const guestCards = db.getOwnHoleCards(hand.id, guestIdentityId)!;

  const hostHtml = await (await host.fetch(`/t/${code}/live`)).text();
  const guestHtml = await (await guest.fetch(`/t/${code}/live`)).text();

  // Each player's page shows exactly its own two cards...
  for (const card of hostCards) {
    expect(hostHtml).toContain(`title="${rankLabel(card.rank)} of ${card.suit}"`);
  }
  for (const card of guestCards) {
    expect(guestHtml).toContain(`title="${rankLabel(card.rank)} of ${card.suit}"`);
  }
  // ...and never the opponent's.
  for (const card of guestCards) {
    expect(hostHtml).not.toContain(`title="${rankLabel(card.rank)} of ${card.suit}"`);
  }
  for (const card of hostCards) {
    expect(guestHtml).not.toContain(`title="${rankLabel(card.rank)} of ${card.suit}"`);
  }
  // Exactly two hidden-card placeholders shown for the opponent on each view.
  expect((hostHtml.match(/card-hidden/g) ?? []).length).toBe(2);
  expect((guestHtml.match(/card-hidden/g) ?? []).length).toBe(2);
});

function rankLabel(rank: Card["rank"]): string {
  const labels: Record<number, string> = { 14: "A", 13: "K", 12: "Q", 11: "J" };
  return labels[rank] ?? String(rank);
}

// --- 6. A legal action is accepted and advances the hand -------------------

it("a legal action is accepted and updates the hand", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);

  const actingSeat = hand.bettingState.actingSeat!;
  const legal = getLegalActions(hand.bettingState, actingSeat);
  expect(legal.actions).toContain("call");

  const res = await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "call",
  });
  expect(res.status).toBe(303);

  const updated = db.getHandById(hand.id)!;
  expect(updated.version).toBeGreaterThan(hand.version);
});

// --- 7. An illegal action is rejected with the engine's own reason --------

it("an illegal action (e.g. checking while facing a bet) is rejected with action_not_legal", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const legal = getLegalActions(hand.bettingState, actingSeat);
  expect(legal.actions).not.toContain("check"); // button is facing the big blind preflop

  const res = await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "check",
  });
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("action_not_legal");
});

// --- 8. An out-of-turn action is rejected ----------------------------------

it("an out-of-turn action is rejected with not_your_turn", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const otherSeat: Seat = actingSeat === 1 ? 2 : 1;

  const res = await postAction(seats[otherSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "call",
  });
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("not_your_turn");
});

// --- 9. A stale-version action is rejected ---------------------------------

it("an action submitted against a stale version is rejected with stale_version", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;

  const res = await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version + 999,
    action: "call",
  });
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("stale_version");
});

// --- 10. An identical retry is idempotent, not reapplied -------------------

it("retrying the exact same request_id/action/version is an idempotent no-op", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const requestId = freshRequestId();
  const body = { hand_id: hand.id, request_id: requestId, expected_version: hand.version, action: "call" };

  const first = await postAction(seats[actingSeat], code, body);
  expect(first.status).toBe(303);
  const afterFirst = db.getHandById(hand.id)!;

  const second = await postAction(seats[actingSeat], code, body);
  expect(second.status).toBe(303); // idempotent replay, not an error

  const afterSecond = db.getHandById(hand.id)!;
  expect(afterSecond.version).toBe(afterFirst.version); // not re-applied a second time
});

// --- 11. A conflicting request_id (same id, different content) is rejected -

it("reusing a request_id with different content is rejected with request_id_conflict", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const requestId = freshRequestId();

  const first = await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: requestId,
    expected_version: hand.version,
    action: "call",
  });
  expect(first.status).toBe(303);

  // Same request_id, but now claiming "fold" instead of the original "call".
  const second = await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: requestId,
    expected_version: hand.version,
    action: "fold",
  });
  expect(second.status).toBe(409);
  expect(await second.text()).toContain("request_id_conflict");
});

// --- 12. hand_id must actually belong to the table in the URL (Correction B)

it("an action's hand_id must belong to the table named in the URL", async () => {
  const tableA = await setUpReadyTable();
  await startHand(tableA.host, tableA.code);
  const handA = db.getActiveHandForTable(tableA.tableId)!;

  const tableB = await setUpReadyTable();

  const res = await postAction(tableB.host, tableB.code, {
    hand_id: handA.id,
    request_id: freshRequestId(),
    expected_version: handA.version,
    action: "call",
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("does not belong to this table");
});

// --- 13. Automatic street advancement over HTTP ----------------------------

it("the hand automatically advances to the next street once a round of betting closes", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const seats = jarBySeat(host, guest);
  let hand = db.getActiveHandForTable(tableId)!;
  expect(hand.street).toBe("preflop");

  // Button calls, big blind checks: preflop betting closes, flop deals.
  let actingSeat = hand.bettingState.actingSeat!;
  await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "call",
  });
  hand = db.getActiveHandForTable(tableId)!;
  actingSeat = hand.bettingState.actingSeat!;
  const res = await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "check",
  });
  expect(res.status).toBe(303);

  hand = db.getActiveHandForTable(tableId)!;
  expect(hand.street).toBe("flop");
  expect(db.getCommunityCards(hand.id)).toHaveLength(3);
});

// --- 14. All-in runout over HTTP -------------------------------------------

it("an all-in call runs the hand out to the river and settles automatically over HTTP", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  const createResult = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  expect(createResult.ok).toBe(true);
  const seats = jarBySeat(host, guest);

  let hand = db.getActiveHandForTable(tableId)!;
  let actingSeat = hand.bettingState.actingSeat!;
  const allInRes = await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "all_in",
  });
  expect(allInRes.status).toBe(303);

  hand = db.getHandById(hand.id)!;
  actingSeat = hand.bettingState.actingSeat!;
  const legal = getLegalActions(hand.bettingState, actingSeat);
  const callAction = legal.actions.includes("call") ? "call" : "all_in";
  const callRes = await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: callAction,
  });
  expect(callRes.status).toBe(303);

  const settled = db.getHandById(hand.id)!;
  expect(settled.status).toBe("settled");
  expect(db.getCommunityCards(settled.id)).toHaveLength(5); // full runout to the river

  const planResult = db.getSettlementPlanForHand(settled.id);
  expect(planResult.ok).toBe(true);
  if (planResult.ok) {
    expect(planResult.plan.outcome).toBe("showdown");
    expect(planResult.plan.winningSeats).toEqual([1]); // seat 1's pocket aces per the fixed deck
  }
});

// --- 15. Fold settlement over HTTP, including retry-after-settlement ------

it("folding settles the hand uncontested over HTTP, and retrying that same action afterward is still idempotent", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const seats = jarBySeat(host, guest);
  const hand = db.getActiveHandForTable(tableId)!;
  const actingSeat = hand.bettingState.actingSeat!;
  const otherSeat: Seat = actingSeat === 1 ? 2 : 1;

  const requestId = freshRequestId();
  const body = { hand_id: hand.id, request_id: requestId, expected_version: hand.version, action: "fold" };

  const res = await postAction(seats[actingSeat], code, body);
  expect(res.status).toBe(303);

  const settled = db.getHandById(hand.id)!;
  expect(settled.status).toBe("settled");

  const planResult = db.getSettlementPlanForHand(settled.id);
  expect(planResult.ok).toBe(true);
  if (planResult.ok) {
    expect(planResult.plan.outcome).toBe("fold");
    expect(planResult.plan.winningSeats).toEqual([otherSeat]);
  }

  // Correction B: retrying the exact hand-completing request after
  // settlement must still succeed as an idempotent replay, not fail merely
  // because getActiveHandForTable no longer finds an "active" hand.
  const retry = await postAction(seats[actingSeat], code, body);
  expect(retry.status).toBe(303);
  expect(db.getHandById(hand.id)!.status).toBe("settled"); // unchanged

  // A fold conceals both players' cards forever, even after settlement.
  const revealed = db.getShowdownHoleCards(settled.id);
  expect(revealed).toEqual({});
});

// --- 16. Showdown settlement over HTTP -------------------------------------

it("a full check-down reaches showdown and settles with the correct winner over HTTP", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  const createResult = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  expect(createResult.ok).toBe(true);
  const seats = jarBySeat(host, guest);

  await checkOrCallDown(code, seats);

  const hand = db.getLatestHandForTable(tableId)!;
  expect(hand.status).toBe("settled");

  const planResult = db.getSettlementPlanForHand(hand.id);
  expect(planResult.ok).toBe(true);
  if (planResult.ok) {
    expect(planResult.plan.outcome).toBe("showdown");
    expect(planResult.plan.winningSeats).toEqual([1]);
  }

  // Showdown reveals both non-folded seats' hole cards.
  const revealed = db.getShowdownHoleCards(hand.id)!;
  expect(revealed[1]).toBeTruthy();
  expect(revealed[2]).toBeTruthy();
});

// --- 17. Latest settled hand remains visible after a page refresh ---------

it("the settled hand's result remains visible on a later page refresh (Correction A)", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const seats = jarBySeat(host, guest);
  const hand = db.getActiveHandForTable(tableId)!;
  const actingSeat = hand.bettingState.actingSeat!;
  await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "fold",
  });

  expect(db.getActiveHandForTable(tableId)).toBeUndefined(); // no longer "active"

  const firstView = await (await host.fetch(`/t/${code}/live`)).text();
  expect(firstView).toContain("won");

  // Simulate a second, independent page load/refresh.
  const secondView = await (await host.fetch(`/t/${code}/live`)).text();
  expect(secondView).toContain("won");
});

// --- 18. Chip conservation --------------------------------------------------

it("total chips across both seats are conserved after settlement", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  const table = db.getPokerTableByCode(code)!;
  const totalBefore = table.startingStack * 2;

  const createResult = db.createPokerHand(tableId, SEAT1_WINS_DECK);
  expect(createResult.ok).toBe(true);
  const seats = jarBySeat(host, guest);
  await checkOrCallDown(code, seats);

  const finalSeats = db.getSeatsForTable(tableId);
  const totalAfter = finalSeats.reduce((sum, s) => sum + s.chipStack, 0);
  expect(totalAfter).toBe(totalBefore);
});

// --- 19. Exactly one SSE publish per genuine mutation ----------------------

it("a genuine legal action publishes exactly one table_changed event", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;

  const streamRes = await openEvents(host, code);
  const stream = sseEvents(streamRes);
  await stream.nextEvent(); // ready

  const res = await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "call",
  });
  expect(res.status).toBe(303);

  const event = await stream.nextEvent();
  expect(event.event).toBe("table_changed");
  expect(event.data).toBe(""); // content-free, same as every other table_changed event
  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/);

  await stream.cancel();
});

// --- 20. No publish on a duplicate (idempotent no-op) action ---------------

it("an idempotent duplicate action publishes no additional notification", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const requestId = freshRequestId();
  const body = { hand_id: hand.id, request_id: requestId, expected_version: hand.version, action: "call" };

  await postAction(seats[actingSeat], code, body); // first (real) application

  const streamRes = await openEvents(host, code);
  const stream = sseEvents(streamRes);
  await stream.nextEvent(); // ready

  const retry = await postAction(seats[actingSeat], code, body);
  expect(retry.status).toBe(303);

  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/);
  await stream.cancel();
});

// --- 21. No publish on a rejected action ------------------------------------

it("a rejected action (out of turn) publishes no notification", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const otherSeat: Seat = actingSeat === 1 ? 2 : 1;

  const streamRes = await openEvents(host, code);
  const stream = sseEvents(streamRes);
  await stream.nextEvent(); // ready

  const res = await postAction(seats[otherSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "call",
  });
  expect(res.status).toBe(409);

  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/);
  await stream.cancel();
});

// --- 22. Double-submitted hand-start cannot create a second hand -----------
//
// Found during the Slice 5B independent audit: if the hand a /hand/start
// request creates happens to auto-settle within its own creation
// transaction (an extreme-short-stack blind post can already be a terminal
// state with no decision for either seat), the row's status flips to
// 'settled' before COMMIT — so the one_active_hand_per_table partial index
// no longer blocks a second, closely-following /hand/start request from
// creating a genuine extra hand. Fixed via an after_hand_number hidden
// field + createPokerHand's expectedLatestHandNumber guard (optimistic
// concurrency, the same idea as expected_version for betting actions). This
// reproduces the exact HTTP-level scenario end to end.

function setSeatStack(tableId: number, seatNumber: 1 | 2, chipStack: number): void {
  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  raw.prepare("UPDATE poker_seats SET chip_stack = ? WHERE table_id = ? AND seat_number = ?").run(
    chipStack,
    tableId,
    seatNumber,
  );
  raw.close();
}

// Seat 1 (button, posts the small blind) gets pocket aces and wins outright
// — chosen so seat 1's stack survives the forced short all-in at a positive
// balance, which is exactly the condition under which the bug could create
// a second hand (a stack that busts to zero is independently blocked by
// the "insufficient_chips" check either way).
const SHORT_STACK_SEAT1_WINS_DECK = buildFixedDeck([
  c(14, "hearts"),
  c(14, "spades"), // seat 1 hole
  c(7, "clubs"),
  c(6, "diamonds"), // seat 2 hole
  c(13, "clubs"),
  c(13, "diamonds"),
  c(9, "hearts"), // flop
  c(4, "spades"), // turn
  c(2, "clubs"), // river
]);

it("a double-submitted hand-start request cannot create a second hand even when the first auto-settles instantly (Scenario C)", async () => {
  const { host, code, tableId } = await setUpReadyTable();
  setSeatStack(tableId, 1, 3); // below the table's small blind: forced all-in on the blind post alone
  setSeatStack(tableId, 2, 1997);

  // The real page, rendered before any hand exists, carries after_hand_number=0.
  const liveHtml = await (await host.fetch(`/t/${code}/live`)).text();
  const match = liveHtml.match(/name="after_hand_number" value="(\d+)"/);
  expect(match).toBeTruthy();
  expect(match![1]).toBe("0");

  // Simulates the first of two racing submissions of that same rendered
  // form actually winning the race and completing (deterministically, via
  // the test-only overrideDeck hook — never reachable through HTTP itself).
  const first = db.createPokerHand(tableId, SHORT_STACK_SEAT1_WINS_DECK, 0);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.hand.status).toBe("settled");
  expect(db.getSeatsForTable(tableId).find((s) => s.seatNumber === 1)?.chipStack).toBeGreaterThan(0);
  const totalBeforeRetry = db.getSeatsForTable(tableId).reduce((sum, s) => sum + s.chipStack, 0);

  // This stream is used ONLY to confirm the retry below publishes nothing,
  // then discarded — never reused afterward. (A single stream object's
  // nextEvent(timeoutMs) leaves its underlying reader.read() call pending
  // when the timeout wins the race; reusing the same stream for a LATER
  // real event would risk that real event's chunk being silently consumed
  // by the earlier, already-abandoned read() instead of a fresh call. Using
  // a separate, short-lived stream per assertion avoids that entirely.)
  const retryStreamRes = await openEvents(host, code);
  const retryStream = sseEvents(retryStreamRes);
  await retryStream.nextEvent(); // ready

  // The second (real, HTTP-level) submission of the SAME double-clicked
  // form — same after_hand_number=0 — must not create a second hand.
  const retryRes = await host.fetch(`/t/${code}/hand/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "after_hand_number=0",
  });
  expect(retryRes.status).toBe(303); // idempotent no-op, not an error

  let raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  let rows = raw.prepare("SELECT hand_number, status, button_seat FROM poker_hands WHERE table_id = ?").all(
    tableId,
  ) as { hand_number: number; status: string; button_seat: number }[];
  raw.close();
  expect(rows).toHaveLength(1); // still only the one hand
  expect(rows[0]).toMatchObject({ hand_number: 1, status: "settled", button_seat: 1 }); // unchanged by the retry

  const totalAfterRetry = db.getSeatsForTable(tableId).reduce((sum, s) => sum + s.chipStack, 0);
  expect(totalAfterRetry).toBe(totalBeforeRetry); // chip conservation: the retry moved nothing

  // The retry is a no-op from the route's point of view (like
  // hand_already_active), so it must not publish a second time.
  await expect(retryStream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/);
  await retryStream.cancel();

  // A fresh stream for the legitimate next-hand request, so its nextEvent()
  // call has a clean reader with no dangling prior read.
  const nextStreamRes = await openEvents(host, code);
  const nextStream = sseEvents(nextStreamRes);
  await nextStream.nextEvent(); // ready

  // A genuinely new "start next hand" submission — rendered after observing
  // hand #1's settlement — correctly carries after_hand_number=1 and must
  // still succeed.
  const nextRes = await host.fetch(`/t/${code}/hand/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "after_hand_number=1",
  });
  expect(nextRes.status).toBe(303);

  const nextEvent = await nextStream.nextEvent();
  expect(nextEvent.event).toBe("table_changed"); // the legitimate next hand DOES publish

  raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  rows = raw
    .prepare("SELECT hand_number, status, button_seat FROM poker_hands WHERE table_id = ? ORDER BY hand_number")
    .all(tableId) as { hand_number: number; status: string; button_seat: number }[];
  raw.close();
  expect(rows.map((r) => r.hand_number)).toEqual([1, 2]); // legitimate next hand still created
  expect(rows[1].button_seat).toBe(2); // button rotates to the other seat for hand #2

  await nextStream.cancel();
});

// --- 23. Genuinely concurrent HTTP hand-start requests create one hand ----

it("two real, concurrent HTTP hand-start requests for a fresh table create exactly one hand", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();

  const [resA, resB] = await Promise.all([startHand(host, code), startHand(guest, code)]);
  const statuses = [resA.status, resB.status].sort();
  expect(statuses).toEqual([303, 303]); // neither is a hard error

  const hands = db.getSeatsForTable(tableId); // sanity: table still has exactly 2 seats
  expect(hands).toHaveLength(2);

  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const rows = raw.prepare("SELECT hand_number FROM poker_hands WHERE table_id = ?").all(tableId) as {
    hand_number: number;
  }[];
  raw.close();
  expect(rows).toHaveLength(1); // exactly one hand, not two, from the simultaneous clicks
});

// --- 24. Audit B: malformed/boundary input never mutates state --------------
//
// Exercises /t/:code/hand/action with a battery of malformed and boundary
// field values directly over HTTP. For every case: the request must not be
// treated as a legal, applied action (no 303 redirect), the hand's
// persisted version must be completely unchanged, and no SSE notification
// may fire. This does not duplicate poker/betting.ts's own rules (a
// genuinely legal action with a huge-but-available amount is not tested
// here) — it only checks that malformed HTTP input is rejected before ever
// reaching, or without being incorrectly accepted by, the engine.

it("malformed or boundary action fields never mutate persisted state or publish", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const validHandId = String(hand.id);
  const validVersion = String(hand.version);

  const streamRes = await openEvents(host, code);
  const stream = sseEvents(streamRes);
  await stream.nextEvent(); // ready

  const malformedBodies: Record<string, string> = {
    "missing hand_id": `request_id=${freshRequestId()}&expected_version=${validVersion}&action=call`,
    "missing request_id": `hand_id=${validHandId}&expected_version=${validVersion}&action=call`,
    "missing expected_version": `hand_id=${validHandId}&request_id=${freshRequestId()}&action=call`,
    "missing action": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=${validVersion}`,
    "empty hand_id": `hand_id=&request_id=${freshRequestId()}&expected_version=${validVersion}&action=call`,
    "empty request_id": `hand_id=${validHandId}&request_id=&expected_version=${validVersion}&action=call`,
    "empty expected_version": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=&action=call`,
    "empty action": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=${validVersion}&action=`,
    "invalid action string": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=${validVersion}&action=super_fold`,
    "negative hand_id": `hand_id=-1&request_id=${freshRequestId()}&expected_version=${validVersion}&action=call`,
    "negative expected_version": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=-1&action=call`,
    "negative amount on raise": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=${validVersion}&action=raise&amount=-20`,
    "fractional expected_version": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=1.5&action=call`,
    "fractional amount": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=${validVersion}&action=raise&amount=20.5`,
    "NaN expected_version": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=NaN&action=call`,
    "NaN amount": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=${validVersion}&action=raise&amount=NaN`,
    "Infinity amount": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=${validVersion}&action=raise&amount=Infinity`,
    "hex hand_id": `hand_id=0x1&request_id=${freshRequestId()}&expected_version=${validVersion}&action=call`,
    "scientific-notation amount": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=${validVersion}&action=raise&amount=2e1`,
    "whitespace-only hand_id": `hand_id=%20%20&request_id=${freshRequestId()}&expected_version=${validVersion}&action=call`,
    "leading-plus expected_version": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=%2B1&action=call`,
    "amount required but missing for raise": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=${validVersion}&action=raise`,
    "extremely large expected_version": `hand_id=${validHandId}&request_id=${freshRequestId()}&expected_version=999999999999999999999999&action=call`,
  };

  for (const [label, body] of Object.entries(malformedBodies)) {
    const res = await seats[actingSeat].fetch(`/t/${code}/hand/action`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status, `case "${label}" status`).not.toBe(303);
    expect([400, 409]).toContain(res.status);

    const current = db.getHandById(hand.id)!;
    expect(current.version, `case "${label}" version unchanged`).toBe(hand.version);
  }

  // No SSE notification should have fired for any of the above.
  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/);
  await stream.cancel();
});

// An extraneous `amount` field on fold/check/call/all_in is NOT a malformed
// request: poker/betting.ts's own BettingAction contract documents amount
// as unused for those action types, and applyBettingAction never reads it
// for them (confirmed by inspection) — so a stray amount is harmlessly
// ignored, not a validation gap. This is intentionally a positive
// assertion, not part of the must-reject battery above, to avoid
// duplicating or contradicting the engine's own rules.
it("a stray amount field on a fold is harmlessly ignored, not rejected", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;

  const res = await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "fold",
    amount: "10",
  });
  expect(res.status).toBe(303);

  const updated = db.getHandById(hand.id)!;
  expect(updated.bettingState.seats[actingSeat].folded).toBe(true);
});

it("an action amount so large it cannot possibly be legal is rejected by the engine, not silently accepted", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;

  const res = await postAction(seats[actingSeat], code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "raise",
    amount: "999999999999999999999999",
  });
  expect(res.status).toBe(409);
  expect(await res.text()).not.toContain("303");

  const current = db.getHandById(hand.id)!;
  expect(current.version).toBe(hand.version); // no mutation
});

// --- 25. Audit A: identity is never accepted from the request body ---------

it("spoofed identity/seat fields in the action body are ignored; only the cookie-resolved identity is ever used", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const otherSeat: Seat = actingSeat === 1 ? 2 : 1;
  const notActingIdentityId = identityForSeat(tableId, otherSeat);

  // The seat that is NOT entitled to act submits a request that also
  // attempts to claim the acting seat's identity via extra body fields —
  // these are not fields the route even reads, but this confirms there is
  // no path by which they could override the trusted cookie identity.
  const res = await seats[otherSeat].fetch(`/t/${code}/hand/action`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      hand_id: String(hand.id),
      request_id: freshRequestId(),
      expected_version: String(hand.version),
      action: "call",
      identityId: String(identityForSeat(tableId, actingSeat)),
      seat: String(actingSeat),
      seatNumber: String(actingSeat),
    }).toString(),
  });
  // Still rejected as out-of-turn: the spoofed identityId/seat fields had
  // no effect, because the route never reads them — identity comes solely
  // from c.get("identityId"), itself resolved only from the trusted cookie.
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("not_your_turn");
  expect(notActingIdentityId).not.toBe(identityForSeat(tableId, actingSeat));

  const current = db.getHandById(hand.id)!;
  expect(current.version).toBe(hand.version);
});

// --- 26. CSRF-relevant cookie attribute assertions --------------------------

it("the identity cookie is issued with HttpOnly, SameSite=Lax, and a Path scoping it to the whole app", async () => {
  const jar = new CookieJar();
  const res = await jar.fetch("/");
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("gs_identity="));
  expect(setCookie).toBeTruthy();
  expect(setCookie!.toLowerCase()).toContain("httponly");
  expect(setCookie!.toLowerCase()).toContain("samesite=lax");
  expect(setCookie!).toContain("Path=/");
});

// Backs the CSRF reasoning in the audit report: no Domain attribute means
// this is a host-only cookie, scoped to the exact hostname that issued it —
// not shared with any other subdomain or origin, even one that is
// "same-site" by the public-suffix-list definition SameSite itself relies
// on. Combined with fly.dev being a listed public suffix (so a different
// Fly app under fly.dev is a genuinely different "site", not merely a
// different origin on the same site) and this deployment exposing exactly
// one hostname over HTTPS only (fly.toml's force_https, no alternate port
// or subdomain), there is no other origin within this app's own trust
// boundary that could receive this cookie and mount a same-site-but-
// cross-origin attack.
it("the identity cookie carries no Domain attribute (host-only, not shared across subdomains/origins)", async () => {
  const jar = new CookieJar();
  const res = await jar.fetch("/");
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("gs_identity="));
  expect(setCookie).toBeTruthy();
  expect(setCookie!.toLowerCase()).not.toContain("domain=");
});

it("a request bearing no identity cookie at all cannot act as, or be confused with, an already-seated player", async () => {
  const { host, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;

  // A fresh jar with no cookie history at all — simulates a request from
  // someone who has never visited this app before (e.g. a forged
  // cross-site request that, per SameSite=Lax, would arrive with no
  // cookie), attempting to act as whichever seat is currently to act.
  const stranger = new CookieJar();
  const res = await postAction(stranger, code, {
    hand_id: hand.id,
    request_id: freshRequestId(),
    expected_version: hand.version,
    action: "call",
  });
  // Rejected as not_a_player (a brand-new identity has no seat in this
  // hand), never silently treated as the acting seat.
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("not_a_player");

  const current = db.getHandById(hand.id)!;
  expect(current.version).toBe(hand.version);
});

// --- 27. Audit C: genuinely concurrent HTTP requests (Promise.all, not ----
// sequential awaits dressed up as concurrency) ------------------------------

it("C1: two genuinely concurrent identical action requests apply exactly once", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const requestId = freshRequestId();
  const body = { hand_id: hand.id, request_id: requestId, expected_version: hand.version, action: "call" };

  const streamRes = await openEvents(host, code);
  const stream = sseEvents(streamRes);
  await stream.nextEvent(); // ready

  const [resA, resB] = await Promise.all([
    postAction(seats[actingSeat], code, body),
    postAction(seats[actingSeat], code, body),
  ]);
  expect([resA.status, resB.status]).toEqual([303, 303]); // neither is a hard error

  const history = db.getActionHistory(hand.id).filter((a) => a.requestId === requestId);
  expect(history).toHaveLength(1); // applied exactly once, regardless of interleaving

  const event = await stream.nextEvent();
  expect(event.event).toBe("table_changed");
  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/); // only one publish, not two
  await stream.cancel();
});

it("C2: two genuinely concurrent requests for the hand-completing action settle exactly once", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const requestId = freshRequestId();
  const body = { hand_id: hand.id, request_id: requestId, expected_version: hand.version, action: "fold" };

  const streamRes = await openEvents(host, code);
  const stream = sseEvents(streamRes);
  await stream.nextEvent(); // ready

  const [resA, resB] = await Promise.all([
    postAction(seats[actingSeat], code, body),
    postAction(seats[actingSeat], code, body),
  ]);
  expect([resA.status, resB.status]).toEqual([303, 303]);

  const settled = db.getHandById(hand.id)!;
  expect(settled.status).toBe("settled");
  const planResult = db.getSettlementPlanForHand(settled.id);
  expect(planResult.ok).toBe(true);

  const seatsAfter = db.getSeatsForTable(tableId);
  const total = seatsAfter.reduce((sum, s) => sum + s.chipStack, 0);
  expect(total).toBe(2000); // no chips were double-moved

  const event = await stream.nextEvent();
  expect(event.event).toBe("table_changed");
  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/); // exactly one publish
  await stream.cancel();
});

it("C3: two genuinely concurrent requests reusing a request_id with different content — at most one succeeds, state stays consistent", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const requestId = freshRequestId();

  const [resCall, resFold] = await Promise.all([
    postAction(seats[actingSeat], code, {
      hand_id: hand.id,
      request_id: requestId,
      expected_version: hand.version,
      action: "call",
    }),
    postAction(seats[actingSeat], code, {
      hand_id: hand.id,
      request_id: requestId,
      expected_version: hand.version,
      action: "fold",
    }),
  ]);

  // Not both can have been genuinely applied as written: at most one of the
  // two conflicting submissions may have succeeded.
  const statuses = [resCall.status, resFold.status];
  expect(statuses.filter((s) => s === 303).length).toBeLessThanOrEqual(1);

  const history = db.getActionHistory(hand.id).filter((a) => a.requestId === requestId);
  expect(history.length).toBeLessThanOrEqual(1); // never both recorded under the same request_id
});

it("C4: genuinely concurrent requests from both seats — the out-of-turn seat's request never succeeds", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const seats = jarBySeat(host, guest);
  const actingSeat = hand.bettingState.actingSeat!;
  const otherSeat: Seat = actingSeat === 1 ? 2 : 1;

  const [resActing, resOther] = await Promise.all([
    postAction(seats[actingSeat], code, {
      hand_id: hand.id,
      request_id: freshRequestId(),
      expected_version: hand.version,
      action: "call",
    }),
    postAction(seats[otherSeat], code, {
      hand_id: hand.id,
      request_id: freshRequestId(),
      expected_version: hand.version,
      action: "call",
    }),
  ]);

  expect(resActing.status).toBe(303);
  // The out-of-turn seat's request must never succeed, regardless of
  // interleaving. Its exact rejection reason depends on ordering (if the
  // acting seat's request is applied first, the version has already moved
  // on, so applyBettingAction's own check order reports stale_version
  // before it would even reach not_your_turn — both are legitimate
  // rejections; what must never happen is a 303).
  expect(resOther.status).toBe(409);
  const otherText = await resOther.text();
  expect(otherText).toMatch(/not_your_turn|stale_version/);

  // While a hand is active, poker_seats.chip_stack is not yet authoritative
  // (it's only updated between hands) — the hand's own betting state is,
  // via each seat's remaining `stack` plus what it has already committed.
  const after = db.getHandById(hand.id)!;
  const total =
    after.bettingState.seats[1].stack +
    after.bettingState.seats[1].committedTotal +
    after.bettingState.seats[2].stack +
    after.bettingState.seats[2].committedTotal;
  expect(total).toBe(2000); // chip conservation holds regardless of interleaving
});

// --- 28. Audit E: an unseated visitor sees no private information ----------

it("an unseated visitor viewing a ready table's active hand sees no hole cards at all, only hidden placeholders", async () => {
  const { host, code } = await setUpReadyTable();
  await startHand(host, code);

  const stranger = new CookieJar();
  const html = await (await stranger.fetch(`/t/${code}/live`)).text();

  // A non-participant gets no hand section at all (renderHandSection is
  // only reached when `self` — the seat lookup for the caller's own
  // identity — is truthy in renderTableBody).
  expect(html).not.toContain("card-hidden");
  expect(html).not.toContain("Hand #");
  expect(html).toContain("This table is full");
});

// --- 29. Audit F: latest-hand selection across multiple settled hands -----

it("getLatestHandForTable always returns the truly most recent hand, across many settled hands and across tables", async () => {
  const { tableId } = await setUpReadyTable();

  // Play three full hands to settlement via fold.
  for (let i = 0; i < 3; i++) {
    const created = db.createPokerHand(tableId);
    expect(created.ok).toBe(true);
    if (!created.ok) continue;
    const actingSeat = created.hand.bettingState.actingSeat!;
    const identityId = identityForSeat(tableId, actingSeat);
    const result = db.submitBettingAction({
      handId: created.hand.id,
      identityId,
      requestId: `fold-${i}`,
      expectedVersion: created.hand.version,
      action: { type: "fold" },
    });
    expect(result.ok).toBe(true);
  }

  const latest = db.getLatestHandForTable(tableId)!;
  expect(latest.handNumber).toBe(3); // the third hand, not the first or second by insertion/row order

  // A second, independent table has its own, unrelated hand history.
  const other = await setUpReadyTable();
  expect(db.getLatestHandForTable(other.tableId)).toBeUndefined(); // no hand started there at all
  const otherCreated = db.createPokerHand(other.tableId);
  expect(otherCreated.ok).toBe(true);
  if (otherCreated.ok) {
    expect(db.getLatestHandForTable(other.tableId)!.handNumber).toBe(1);
  }
  // The original table's latest hand is unaffected by the second table's history.
  expect(db.getLatestHandForTable(tableId)!.handNumber).toBe(3);
});

// --- 30. Mandatory after_hand_number at the HTTP boundary -------------------
//
// Follow-up fix: the previous guard (expectedLatestHandNumber in
// createPokerHand) was correct, but the HTTP route treated a missing or
// malformed after_hand_number as "no expectation", silently disabling the
// guard for any request that simply omitted the field — not just the
// real rendered UI's double-submits. requireAfterHandNumber in server.ts
// now makes the field mandatory and strictly validated at the boundary.

it("Scenario D: a hand-start request missing after_hand_number is rejected with 400 and mutates nothing, on both a hand-less and a settled table", async () => {
  const { host, code, tableId } = await setUpReadyTable();

  // Case 1: table has never had a hand.
  const res1 = await host.fetch(`/t/${code}/hand/start`, { method: "POST" });
  expect(res1.status).toBe(400);
  expect(db.getActiveHandForTable(tableId)).toBeUndefined();
  expect(db.getLatestHandForTable(tableId)).toBeUndefined();

  // Case 2: table's latest hand is settled.
  await startHand(host, code);
  const hand = db.getActiveHandForTable(tableId)!;
  const actingSeat = hand.bettingState.actingSeat!;
  const identityId = identityForSeat(tableId, actingSeat);
  const foldResult = db.submitBettingAction({
    handId: hand.id,
    identityId,
    requestId: freshRequestId(),
    expectedVersion: hand.version,
    action: { type: "fold" },
  });
  expect(foldResult.ok).toBe(true);
  expect(db.getLatestHandForTable(tableId)!.status).toBe("settled");

  const streamRes = await openEvents(host, code);
  const stream = sseEvents(streamRes);
  await stream.nextEvent(); // ready

  const res2 = await host.fetch(`/t/${code}/hand/start`, { method: "POST" });
  expect(res2.status).toBe(400);

  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const rows = raw.prepare("SELECT hand_number FROM poker_hands WHERE table_id = ?").all(tableId) as {
    hand_number: number;
  }[];
  raw.close();
  expect(rows).toHaveLength(1); // still just the one (settled) hand — no new hand created

  await expect(stream.nextEvent(300)).rejects.toThrow(/no SSE event arrived/); // no notification
  await stream.cancel();
});

it("Scenario E: malformed after_hand_number values are all rejected with 400 and mutate nothing", async () => {
  const { host, code, tableId } = await setUpReadyTable();

  const malformedValues = ["", "%20%20", "-1", "1.5", "NaN", "Infinity", "abc", "9007199254740992"];

  for (const value of malformedValues) {
    const res = await host.fetch(`/t/${code}/hand/start`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `after_hand_number=${value}`,
    });
    expect(res.status, `value "${value}" status`).toBe(400);
    expect(db.getActiveHandForTable(tableId), `value "${value}" no hand created`).toBeUndefined();
  }

  // Sanity: the one value right at the safe-integer boundary (2^53 - 1)
  // that is NOT itself malformed is still correctly treated as merely
  // stale (not a parse error), confirming the rejection above is really
  // about validity, not about every large number being refused outright.
  const boundaryRes = await host.fetch(`/t/${code}/hand/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "after_hand_number=9007199254740991",
  });
  expect(boundaryRes.status).toBe(303); // well-formed, but stale (no hand exists yet, so this is wrong) -> no-op, not a 400
  expect(db.getActiveHandForTable(tableId)).toBeUndefined();
});

it("Scenario E (continued): after_hand_number=0 remains valid for a table that has never had a hand", async () => {
  const { host, code, tableId } = await setUpReadyTable();

  const res = await host.fetch(`/t/${code}/hand/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "after_hand_number=0",
  });
  expect(res.status).toBe(303);
  const hand = db.getActiveHandForTable(tableId);
  expect(hand).toBeTruthy();
  expect(hand?.handNumber).toBe(1);
});

it("Scenario F: a legitimate next hand, started using the value from the actual rendered form, reflects the previous settlement and rotates the button", async () => {
  const { host, code, tableId } = await setUpReadyTable();
  await startHand(host, code);
  const hand1 = db.getActiveHandForTable(tableId)!;
  expect(hand1.buttonSeat).toBe(1);
  const actingSeat = hand1.bettingState.actingSeat!;
  const identityId = identityForSeat(tableId, actingSeat);
  const foldResult = db.submitBettingAction({
    handId: hand1.id,
    identityId,
    requestId: freshRequestId(),
    expectedVersion: hand1.version,
    action: { type: "fold" },
  });
  expect(foldResult.ok).toBe(true);
  const settlementPlan = db.getSettlementPlanForHand(hand1.id);
  expect(settlementPlan.ok).toBe(true);
  const expectedStacks = settlementPlan.ok ? settlementPlan.plan.finalStacks : undefined;

  // Render a fresh page and read the actual current expected hand number
  // from the real rendered form — not a hard-coded value.
  const liveHtml = await (await host.fetch(`/t/${code}/live`)).text();
  const match = liveHtml.match(/name="after_hand_number" value="(\d+)"/);
  expect(match).toBeTruthy();
  const renderedAfterHandNumber = match![1];
  expect(renderedAfterHandNumber).toBe("1"); // reflects hand #1 having settled

  const res = await host.fetch(`/t/${code}/hand/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `after_hand_number=${renderedAfterHandNumber}`,
  });
  expect(res.status).toBe(303);

  const hand2 = db.getActiveHandForTable(tableId)!;
  expect(hand2.handNumber).toBe(2);
  expect(hand2.buttonSeat).toBe(2); // rotated from seat 1

  // Starting stacks for hand #2 reflect hand #1's settlement, not the
  // original 1000/1000.
  expect(hand2.bettingState.seats[1].stack + hand2.bettingState.seats[1].committedTotal).toBe(
    expectedStacks![1],
  );
  expect(hand2.bettingState.seats[2].stack + hand2.bettingState.seats[2].committedTotal).toBe(
    expectedStacks![2],
  );
});

it("Scenario G: two genuinely concurrent hand-start requests with the same expected hand number create at most one hand, even when it immediately settles", async () => {
  const { host, guest, code, tableId } = await setUpReadyTable();
  setSeatStack(tableId, 1, 3);
  setSeatStack(tableId, 2, 1997);

  // Both "requests" read the same after_hand_number (0) from the same
  // prior state, exactly like two browser tabs rendered before any hand
  // existed — one of them, deterministically, is the one that actually
  // creates and immediately settles the hand (overrideDeck is a test-only
  // hook, not reachable through HTTP, so the real concurrency being tested
  // here is the SECOND request racing against that already-committed
  // transaction).
  const first = db.createPokerHand(tableId, SHORT_STACK_SEAT1_WINS_DECK, 0);
  expect(first.ok).toBe(true);

  const [resA, resB] = await Promise.all([
    host.fetch(`/t/${code}/hand/start`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "after_hand_number=0",
    }),
    guest.fetch(`/t/${code}/hand/start`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "after_hand_number=0",
    }),
  ]);
  expect([resA.status, resB.status]).toEqual([303, 303]); // neither is a hard error

  const raw = new DatabaseSync(join(tempDir, "app.sqlite"));
  const rows = raw.prepare("SELECT hand_number FROM poker_hands WHERE table_id = ?").all(tableId) as {
    hand_number: number;
  }[];
  raw.close();
  expect(rows).toHaveLength(1); // exactly one hand total, despite three racing creation attempts
});
