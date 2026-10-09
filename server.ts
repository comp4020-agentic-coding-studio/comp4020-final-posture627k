import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import {
  createIdentity,
  createPokerHand,
  createPokerTable,
  findIdentityByTokenHash,
  getActiveHandForTable,
  getCommunityCards,
  getHandById,
  getLatestHandForTable,
  getOwnHoleCards,
  getPokerTableByCode,
  getSeatForIdentity,
  getSeatNumberForIdentityInHand,
  getSeatsForTable,
  getSettlementPlanForHand,
  getShowdownHoleCards,
  hashToken,
  joinPokerTable,
  submitBettingAction,
  type PersistedHand,
  type PokerSeat,
  type PokerTable,
} from "./db.ts";
import type { Card } from "./poker/cards.ts";
import { getLegalActions, type BettingActionType, type Seat } from "./poker/betting.ts";
import { publish, subscribe as subscribeToRealtimeUpdates } from "./realtime.ts";
import {
  applyCardClashTransition,
  CARD_CLASH_SEAT_COUNT,
  createCardClashRoom,
  getCardClashDeadline,
  getCardClashMatchForRoom,
  getCardClashRoomByCode,
  getCardClashSeatForIdentity,
  getCardClashSeatsForRoom,
  joinCardClashRoom,
  setCardClashSeatReady,
  startCardClashMatch,
  type PersistedCardClashDeadline,
  type PersistedCardClashMatch,
} from "./db.ts";
import type { GameMode as CardClashMode, Seat as CardClashSeatNumber } from "./card-clash/types.ts";
import { buildCardClashTransition, parseCardClashActionEnvelope } from "./card-clash/action-http.ts";
import { renderCardClashPage } from "./card-clash/ui.ts";
import { publishCardClashRoomEvent, subscribeToCardClashRoom } from "./card-clash/realtime.ts";
import {
  reconcileAllCardClashMatchesOnStartup,
  reconcileCardClashMatchIfOverdue,
  rescheduleCardClashTimer,
} from "./card-clash/scheduler.ts";

// Co-located with this file so it resolves the same way locally and in the
// Docker image, regardless of the process's working directory.
const readmePath = new URL("./README.md", import.meta.url);

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const pageShell = (title: string, body: string): string => `<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: #0b1220;
        --panel-bg: #141e30;
        --panel-border: #263249;
        --felt: #123524;
        --felt-border: #1e5c42;
        --text: #e7ecf3;
        --text-muted: #93a1b8;
        --accent: #22c55e;
        --accent-contrast: #052e16;
        --fold: #ef4444;
        --focus-ring: #7dd3fc;
        --card-bg: #f8fafc;
        --card-text: #111827;
        --card-red: #dc2626;
        --card-back-bg: #27405f;
        --card-back-border: #3d577a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        line-height: 1.5;
        color: var(--text);
        background: var(--bg);
      }
      main { max-width: 56rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; overflow-wrap: anywhere; }
      h1 { margin: 0 0 0.25rem; font-size: 1.4rem; color: var(--text); }
      h2 { margin: 0 0 0.75rem; font-size: 1rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
      p { margin: 0.4rem 0; }
      a { color: #7dd3fc; }
      code { overflow-wrap: anywhere; }
      label { display: block; margin: 0.4rem 0; }
      input[type="text"], input[type="number"] {
        font: inherit;
        padding: 0.5rem 0.6rem;
        border: 1px solid var(--panel-border);
        border-radius: 0.375rem;
        margin-top: 0.25rem;
        width: 100%;
        max-width: 10rem;
        min-height: 2.75rem;
        background: #0f1828;
        color: var(--text);
      }
      button {
        font: inherit;
        font-weight: 600;
        padding: 0.65rem 1.1rem;
        min-height: 44px;
        min-width: 44px;
        border: 1px solid var(--panel-border);
        border-radius: 0.5rem;
        background: #1c2a42;
        color: var(--text);
        cursor: pointer;
      }
      button:hover { background: #24344f; }
      a:focus-visible, button:focus-visible, input:focus-visible {
        outline: 3px solid var(--focus-ring);
        outline-offset: 2px;
      }
      .panel {
        background: var(--panel-bg);
        border: 1px solid var(--panel-border);
        border-radius: 0.75rem;
        padding: 1rem 1.25rem;
        margin: 1rem 0;
      }
      .status-line { font-size: 1.05rem; font-weight: 600; margin: 0.3rem 0; color: var(--text); }
      .meta { color: var(--text-muted); font-size: 0.85rem; }
      .invite {
        background: #0f1e33;
        border: 1px dashed #2f5578;
        border-radius: 0.75rem;
        padding: 0.75rem 1rem;
      }
      .invite code {
        display: block;
        margin-top: 0.35rem;
        padding: 0.4rem 0.5rem;
        background: #0a1526;
        border: 1px solid var(--panel-border);
        border-radius: 0.3rem;
        font-size: 0.9rem;
        word-break: break-all;
      }

      /* --- Poker table ------------------------------------------------- */
      .table-felt {
        background: linear-gradient(180deg, var(--felt), #0e2a1e);
        border: 1px solid var(--felt-border);
        border-radius: 1rem;
        padding: 1rem;
        margin: 1rem 0;
      }
      .seat-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem 1rem;
        padding: 0.6rem 0.25rem;
        border-radius: 0.6rem;
      }
      .seat-row.acting { background: rgba(34, 197, 94, 0.12); box-shadow: inset 0 0 0 1px rgba(34, 197, 94, 0.5); }
      .seat-identity { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; min-width: 0; }
      .seat-name { font-weight: 700; }
      .seat-stack { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .badge {
        display: inline-block;
        font-size: 0.7rem;
        font-weight: 700;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        letter-spacing: 0.03em;
      }
      .badge-dealer { background: #fbbf24; color: #3b2600; }
      .badge-blind { background: #334155; color: var(--text); }
      .badge-turn { background: var(--accent); color: var(--accent-contrast); }
      .badge-folded { background: #4b5563; color: var(--text); }
      .badge-allin { background: #7c3aed; color: #fff; }
      .hole-cards, .community-cards { display: flex; gap: 0.3rem; flex-wrap: wrap; }
      .board-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 0.5rem 1.25rem;
        padding: 0.75rem 0.25rem;
        margin: 0.25rem 0;
        text-align: center;
      }
      .street-label {
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-size: 0.8rem;
        color: var(--text-muted);
      }
      .pot-amount { font-weight: 700; font-size: 1.1rem; }
      .bet-to-match { color: var(--text-muted); font-size: 0.9rem; }
      .turn-banner {
        text-align: center;
        font-weight: 700;
        padding: 0.5rem;
        margin-top: 0.25rem;
        border-top: 1px solid var(--felt-border);
      }
      .turn-banner.mine { color: var(--accent); }
      .turn-banner.theirs { color: var(--text-muted); font-weight: 500; }

      /* --- Cards -------------------------------------------------------- */
      .card {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: clamp(2rem, 6vw, 2.75rem);
        height: clamp(2.6rem, 8vw, 3.5rem);
        padding: 0.15rem 0.3rem;
        border: 1px solid #cbd5e1;
        border-radius: 0.35rem;
        background: var(--card-bg);
        color: var(--card-text);
        font-weight: 800;
        font-size: clamp(0.95rem, 3.2vw, 1.2rem);
        text-align: center;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
      }
      .card-red { color: var(--card-red); }
      .card-hidden {
        background: repeating-linear-gradient(135deg, var(--card-back-bg), var(--card-back-bg) 6px, var(--card-back-border) 6px, var(--card-back-border) 12px);
        color: transparent;
        border-color: var(--card-back-border);
      }

      /* --- Action palette ------------------------------------------------ */
      .action-palette {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: flex-end;
        margin-top: 0.75rem;
      }
      .inline-form { display: inline-block; }
      .action-btn {
        min-height: 44px;
        min-width: 44px;
      }
      .action-btn.fold { border-color: var(--fold); }
      .action-btn.primary { background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); }
      .action-btn.primary:hover { background: #16a34a; }
      .action-btn[disabled], .action-btn[disabled]:hover {
        background: #1a2235;
        color: var(--text-muted);
        border-color: var(--panel-border);
        cursor: not-allowed;
        opacity: 0.7;
      }
      .amount-group { display: flex; flex-direction: column; gap: 0.2rem; }
      .amount-group input[type="number"] { width: 7rem; }

      /* --- Hand result ---------------------------------------------------- */
      .hand-result {
        border: 1px solid var(--felt-border);
        background: linear-gradient(180deg, #16211a, var(--panel-bg));
      }
      .hand-result .status-line { color: var(--accent); }

      @media (max-width: 600px) {
        main { padding: 0.85rem 0.6rem 2rem; }
        .panel, .table-felt { padding: 0.75rem 0.65rem; }
        .seat-row { flex-direction: column; align-items: flex-start; }
        input[type="text"], input[type="number"] { max-width: 100%; }
      }
    </style>
  </head>
  <body>
    <main>
${body}
    </main>
  </body>
</html>
`;

type Env = { Variables: { identityId: number } };

const app = new Hono<Env>();

const IDENTITY_COOKIE = "gs_identity";
const IDENTITY_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // one year, in seconds

function isHttpsRequest(c: Context): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) return forwardedProto.split(",")[0]?.trim() === "https";
  return new URL(c.req.url).protocol === "https:";
}

// Resolves the caller's anonymous identity from an HttpOnly cookie, issuing
// a fresh one if it's missing or doesn't resolve to a known identity. This
// is the only place identity is established; route handlers below only ever
// read c.get("identityId") and never trust client-submitted identity data.
// Unchanged from the strategy-war product: poker reuses this exactly.
//
// Security note (Slice 5B review): this cookie is set SameSite=Lax, which
// is what actually protects every POST route in this app (including the
// two new ones below) from cross-site request forgery — browsers withhold
// a Lax cookie on a cross-site POST, so a third-party page cannot forge an
// authenticated mutation here. This is pre-existing, unchanged behavior,
// re-verified as sufficient for these new routes rather than assumed.
app.use("*", async (c, next) => {
  const token = getCookie(c, IDENTITY_COOKIE);
  let identityId: number | undefined;

  if (token) {
    identityId = findIdentityByTokenHash(hashToken(token))?.id;
  }

  if (identityId === undefined) {
    const freshToken = randomBytes(32).toString("base64url");
    identityId = createIdentity(hashToken(freshToken)).id;
    setCookie(c, IDENTITY_COOKIE, freshToken, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttpsRequest(c),
      maxAge: IDENTITY_COOKIE_MAX_AGE,
    });
  }

  c.set("identityId", identityId);
  await next();
});

// Legacy Poker Lab landing, kept reachable at a direct URL only (D5C).
app.get("/poker", (c) => {
  return c.html(
    pageShell(
      "Poker Lab",
      `      <h1>Poker Lab</h1>
      <p>Multiplayer Texas Hold'em, played with non-cash virtual chips only.
      No real money, no purchases, no prizes, no cash-out.</p>
      <p><a href="/readme/">About this project</a></p>

      <h2>Create a table</h2>
      <form method="post" action="/tables">
        <button type="submit">Create poker table</button>
      </form>

      <h2>Join a table</h2>
      <form method="post" action="/tables/find">
        <label>
          Table code
          <input type="text" name="code" required autocomplete="off" autocapitalize="characters" />
        </label>
        <button type="submit">Go to table</button>
      </form>`,
    ),
  );
});

app.post("/tables", (c) => {
  const identityId = c.get("identityId");
  const table = createPokerTable(identityId);
  return c.redirect(`/t/${encodeURIComponent(table.code)}`, 303);
});

// Looks a code up by navigating to the table page — it does not itself claim
// a seat. Seating happens from the table page's own "Join table" action
// (POST /t/:code/join), exactly as the strategy-war product separated
// viewing a campaign from joining it.
app.post("/tables/find", async (c) => {
  const body = await c.req.parseBody();
  const submitted = body["code"];
  const code = typeof submitted === "string" ? submitted.trim().toUpperCase() : "";

  if (!code) {
    return c.html(
      pageShell(
        "Enter a table code",
        '      <h1>Enter a table code</h1>\n      <p><a href="/">Back</a></p>',
      ),
      400,
    );
  }

  return c.redirect(`/t/${encodeURIComponent(code)}`, 303);
});

function notFoundPage(c: Context) {
  return c.html(pageShell("Table not found", "      <h1>Table not found</h1>"), 404);
}

function renderSeatLine(seatNumber: 1 | 2, seat: PokerSeat | undefined): string {
  if (!seat) return `<p class="meta">Seat ${seatNumber}: vacant</p>`;
  return `<p class="status-line">Seat ${seatNumber}: occupied — ${seat.chipStack} chips</p>`;
}

// --- Card rendering -----------------------------------------------------
// Pure presentation only: every card shown here was already selected by
// getOwnHoleCards/getCommunityCards/getShowdownHoleCards, each of which
// enforces its own privacy rule before a single Card value ever reaches
// this function. Nothing here decides *whether* a card may be shown.

const RANK_LABELS: Record<number, string> = { 14: "A", 13: "K", 12: "Q", 11: "J" };
const SUIT_SYMBOLS: Record<Card["suit"], string> = { clubs: "♣", diamonds: "♦", hearts: "♥", spades: "♠" };

function renderCard(card: Card): string {
  const isRed = card.suit === "hearts" || card.suit === "diamonds";
  const rankLabel = RANK_LABELS[card.rank] ?? String(card.rank);
  const label = `${rankLabel} of ${card.suit}`;
  return `<span class="card${isRed ? " card-red" : ""}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${escapeHtml(rankLabel)}${SUIT_SYMBOLS[card.suit]}</span>`;
}

function renderHiddenCard(): string {
  return `<span class="card card-hidden" aria-label="hidden card">??</span>`;
}

function renderCards(cards: readonly Card[]): string {
  return cards.map(renderCard).join(" ");
}

// --- Betting controls -----------------------------------------------------

// Every control here is derived entirely from getLegalActions' own result —
// no betting rule (what's legal, minimum sizes, available amount) is
// reimplemented here. hand_id/request_id/expected_version are embedded as
// hidden fields at render time: hand_id lets a retried submission still
// reach the correct (possibly since-settled) hand; expected_version is the
// version this render reflects, not necessarily the hand's current one by
// the time the form is submitted.
//
// Each form gets its OWN freshly-generated request_id, not one shared
// across every button in this render: these are genuinely different
// intended actions (fold vs. call vs. raise), and submitBettingAction's
// idempotency check treats a reused request_id as a claim that a retry is
// the *same* action restated — sharing one id across distinct buttons would
// make every button after the first fail as a spurious request_id_conflict
// the moment any one of them was actually submitted. A real retry (double-
// click, back-button resubmit of the same already-rendered form) still
// naturally reuses that form's own id, which is exactly the case this
// mechanism is for.
// Renders ALL of fold/check/call/all-in as a persistent 4-slot palette (plus
// a 5th bet-or-raise slot) regardless of which are currently legal — not
// just the legal subset — so the player can see at a glance which actions
// exist and which are unavailable right now, rather than only ever seeing
// whatever happens to be legal this instant. An illegal slot renders as a
// genuinely inert `<button type="button" disabled>` with no enclosing
// `<form>` at all, so "disabled" is never merely decorative: there is no
// POST target for it to submit even if the disabled attribute were somehow
// bypassed client-side. Every legal slot is still derived entirely from
// getLegalActions' own result — no betting rule is reimplemented here.
function renderBettingControls(table: PokerTable, hand: PersistedHand, mySeat: Seat): string {
  const legal = getLegalActions(hand.bettingState, mySeat);
  if (!legal.canAct) return "";

  const code = encodeURIComponent(table.code);
  // Each legal slot gets its OWN freshly-generated request_id, not one
  // shared across every button in this render — see the idempotency note
  // in the module header for why reusing one id across distinct intended
  // actions would be wrong.
  const hiddenFields = (): string => `<input type="hidden" name="hand_id" value="${hand.id}" />
        <input type="hidden" name="request_id" value="${escapeHtml(randomBytes(16).toString("hex"))}" />
        <input type="hidden" name="expected_version" value="${hand.version}" />`;

  function actionSlot(
    action: Exclude<BettingActionType, "bet" | "raise">,
    label: string,
    extraClass: string,
  ): string {
    if (!legal.actions.includes(action)) {
      return `<button type="button" class="action-btn ${extraClass}" disabled aria-disabled="true" title="Not available right now">${escapeHtml(label)}</button>`;
    }
    return `      <form class="inline-form" method="post" action="/t/${code}/hand/action">
        ${hiddenFields()}
        <input type="hidden" name="action" value="${action}" />
        <button type="submit" class="action-btn ${extraClass}">${escapeHtml(label)}</button>
      </form>`;
  }

  const foldHtml = actionSlot("fold", "Fold", "fold");
  const checkHtml = actionSlot("check", "Check", "");
  // The dynamic amount is only meaningful (and only shown) when the action
  // is actually legal right now — a disabled slot's amountToCall/
  // maxCommitment may reflect an irrelevant state (e.g. amountToCall is 0
  // whenever Check applies instead of Call), so showing it on a disabled
  // button would be confusing rather than clarifying.
  const callHtml = actionSlot(
    "call",
    legal.actions.includes("call") ? `Call ${legal.amountToCall}` : "Call",
    "primary",
  );
  const allInHtml = actionSlot(
    "all_in",
    legal.actions.includes("all_in") ? `All-in (${legal.maxCommitment})` : "All-in",
    "",
  );

  // Bet and raise are mutually exclusive under the engine's own rules
  // (raise only ever applies once a bet already exists this street), so
  // they share one slot — whichever applies, or a disabled placeholder
  // naming both if neither currently does (e.g. a stack too short to make
  // any legal raise beyond all-in).
  const amountAction: "bet" | "raise" | undefined = legal.actions.includes("raise")
    ? "raise"
    : legal.actions.includes("bet")
      ? "bet"
      : undefined;
  const amountLabel = amountAction === "raise" ? "Raise to" : "Bet to";
  const minAmount = amountAction === "raise" ? legal.minRaiseTo : legal.minBet;
  // The amount is always the player's TARGET TOTAL commitment for this
  // street (matching poker/betting.ts's own BettingAction contract), never
  // an incremental add-on — "Raise to" / "Bet to" makes this explicit
  // rather than leaving an ambiguous bare number.
  const amountHtml = amountAction
    ? `      <form class="inline-form amount-group" method="post" action="/t/${code}/hand/action">
        ${hiddenFields()}
        <input type="hidden" name="action" value="${amountAction}" />
        <label for="amount-input-${hand.version}">${escapeHtml(amountLabel)} (total for this street, min ${minAmount}, max ${legal.maxCommitment})</label>
        <input id="amount-input-${hand.version}" type="number" inputmode="numeric" pattern="[0-9]*" name="amount"
               min="${minAmount}" max="${legal.maxCommitment}" step="1" required
               placeholder="${minAmount}–${legal.maxCommitment}" />
        <button type="submit" class="action-btn primary">${escapeHtml(amountLabel)}…</button>
      </form>`
    : `<button type="button" class="action-btn" disabled aria-disabled="true" title="No bet or raise is currently legal">Bet / Raise</button>`;

  return `      <div class="action-palette" role="group" aria-label="Your action">
${foldHtml}
${checkHtml}
${callHtml}
${amountHtml}
${allInHtml}
      </div>`;
}

// --- Active-hand and settlement rendering -----------------------------------

// The heads-up table: opponent row (far side), community cards + pot
// (center), then the current user's own row (near side) — in that fixed
// document order regardless of which seat number the viewer actually holds,
// so the same markup reads correctly as "opponent, board, me" top-to-bottom
// on both a narrow mobile stack and a wider desktop view, with no separate
// desktop/mobile markup needed (see the .table-felt/.seat-row CSS for the
// purely visual responsiveness).
function renderActiveHand(table: PokerTable, hand: PersistedHand, identityId: number): string {
  const mySeat = getSeatNumberForIdentityInHand(hand.id, identityId);
  const community = getCommunityCards(hand.id);
  const seats = hand.bettingState.seats;
  const pot = seats[1].committedTotal + seats[2].committedTotal;
  const actingSeat = hand.bettingState.actingSeat;
  const buttonSeat = hand.bettingState.buttonSeat;

  const communityHtml =
    community.length > 0 ? renderCards(community) : `<span class="meta">(no community cards yet)</span>`;

  const myHoleCards = mySeat ? (getOwnHoleCards(hand.id, identityId) ?? []) : [];

  function seatBadges(seatNumber: Seat): string {
    const seat = seats[seatNumber];
    const isButton = buttonSeat === seatNumber;
    const badges: string[] = [];
    if (isButton) badges.push(`<span class="badge badge-dealer" title="Dealer button">D</span>`);
    badges.push(
      isButton
        ? `<span class="badge badge-blind" title="Small blind">SB</span>`
        : `<span class="badge badge-blind" title="Big blind">BB</span>`,
    );
    if (actingSeat === seatNumber) badges.push(`<span class="badge badge-turn">ACTING</span>`);
    if (seat.folded) badges.push(`<span class="badge badge-folded">FOLDED</span>`);
    else if (seat.allIn) badges.push(`<span class="badge badge-allin">ALL-IN</span>`);
    return badges.join(" ");
  }

  function seatRow(seatNumber: Seat): string {
    const seat = seats[seatNumber];
    const isMe = mySeat === seatNumber;
    // An opponent's hole cards are NEVER rendered during an active hand,
    // regardless of anything else about this request — the only path that
    // can ever reveal them is the settled-hand summary below, via
    // getShowdownHoleCards, which itself refuses to return anything for a
    // hand that isn't settled.
    const cardsHtml = isMe
      ? myHoleCards.length > 0
        ? renderCards(myHoleCards)
        : `<span class="meta">(none)</span>`
      : `${renderHiddenCard()}${renderHiddenCard()}`;
    const rowClass = actingSeat === seatNumber ? "seat-row acting" : "seat-row";
    return `        <div class="${rowClass}">
          <div class="seat-identity">
            <span class="seat-name">Seat ${seatNumber}${isMe ? " (you)" : ""}</span>
            ${seatBadges(seatNumber)}
          </div>
          <div class="seat-stack">${seat.stack} chips <span class="meta">· committed ${seat.committedThisStreet} this street</span></div>
          <div class="hole-cards">${cardsHtml}</div>
        </div>`;
  }

  // Opponent (far side) always rendered first, the current user (near side)
  // always last, regardless of which literal seat number either holds — see
  // this function's own header comment. Falls back to a fixed 2/1 order in
  // the practically-unreachable case mySeat is somehow undefined for a
  // participant (every seated player is always dealt into every hand).
  const selfSeat: Seat = mySeat ?? 1;
  const opponentSeat: Seat = selfSeat === 1 ? 2 : 1;

  const turnBannerHtml = !actingSeat
    ? ""
    : mySeat === actingSeat
      ? `<p class="turn-banner mine">Your turn — amount to call: ${getLegalActions(hand.bettingState, actingSeat).amountToCall}</p>`
      : `<p class="turn-banner theirs">Waiting for the other player to act…</p>`;

  const controlsHtml = mySeat && actingSeat === mySeat ? renderBettingControls(table, hand, mySeat) : "";

  return `      <section class="table-felt" aria-label="Poker table">
        <h2>Hand #${hand.handNumber} — ${escapeHtml(hand.street)}</h2>
${seatRow(opponentSeat)}
        <div class="board-row">
          <span class="street-label">${escapeHtml(hand.street)}</span>
          <div class="community-cards">${communityHtml}</div>
          <span class="pot-amount">Pot: ${pot}</span>
          <span class="bet-to-match">Current bet to match: ${hand.bettingState.currentBet}</span>
        </div>
${seatRow(selfSeat)}
        ${turnBannerHtml}
      </section>
${controlsHtml}`;
}

// Every value shown here is read straight off the already-computed
// SettlementPlan (contestedPot/refunds/payouts/finalStacks) or
// getShowdownHoleCards — nothing is calculated or invented client-side, and
// a fold conceals both players' cards forever, exactly like
// getShowdownHoleCards' own contract guarantees.
function renderSettlementSummary(hand: PersistedHand): string {
  if (hand.status !== "settled") return "";
  const planResult = getSettlementPlanForHand(hand.id);
  if (!planResult.ok) return "";
  const plan = planResult.plan;
  const showdownCards = getShowdownHoleCards(hand.id) ?? {};

  const outcomeLabel = plan.outcome === "fold" ? "Fold" : "Showdown";
  const resultLine =
    plan.outcome === "fold"
      ? `Seat ${plan.winningSeats[0]} won hand #${hand.handNumber} uncontested — the other player folded.`
      : plan.winningSeats.length === 2
        ? `Hand #${hand.handNumber} was a split pot — a tie (${plan.showdown?.categoryNameBySeat[1] ?? "equal hands"}).`
        : `Seat ${plan.winningSeats[0]} won hand #${hand.handNumber} at showdown with ${plan.showdown?.categoryNameBySeat[plan.winningSeats[0]!] ?? "the stronger hand"}.`;

  const revealedHtml = ([1, 2] as const)
    .map((seat) => {
      const cards = showdownCards[seat];
      return cards && cards.length > 0
        ? `<p class="meta">Seat ${seat}: ${renderCards(cards)}</p>`
        : "";
    })
    .join("");

  const refundNotes = ([1, 2] as const)
    .map((seat) => (plan.refunds[seat] > 0 ? `Seat ${seat} had ${plan.refunds[seat]} returned uncalled.` : ""))
    .filter(Boolean)
    .join(" ");

  return `      <section class="panel hand-result">
        <p class="meta">Hand complete — resolved by ${escapeHtml(outcomeLabel)}</p>
        <p class="status-line">${escapeHtml(resultLine)}</p>
        ${revealedHtml}
        <p class="meta">Contested pot: ${plan.contestedPot}.${refundNotes ? ` ${escapeHtml(refundNotes)}` : ""}</p>
        <p class="meta">Stacks after this hand — seat 1: ${plan.finalStacks[1]}, seat 2: ${plan.finalStacks[2]}.</p>
      </section>`;
}

function renderHandSection(table: PokerTable, identityId: number): string {
  if (table.status !== "ready") return "";

  const activeHand = getActiveHandForTable(table.id);
  if (activeHand) {
    return renderActiveHand(table, activeHand, identityId);
  }

  const latestHand = getLatestHandForTable(table.id);
  const summaryHtml = latestHand ? renderSettlementSummary(latestHand) : "";

  const seats = getSeatsForTable(table.id);
  const bothHaveChips = seats.length === 2 && seats.every((s) => s.chipStack > 0);
  // after_hand_number records the latest hand_number this render observed
  // (0 if none yet) — createPokerHand rejects the request as a no-op
  // (reason "stale_hand_state") if the table's actual latest hand_number
  // has since moved on, the same optimistic-concurrency idea the betting
  // controls already use via expected_version. This closes a real race: a
  // double-submitted "start hand" click can otherwise create a genuine
  // extra hand when the first hand it created happened to auto-settle
  // immediately (an extreme-short-stack blind post with no decision left
  // for either seat) — see createPokerHand's own comment for the full
  // explanation.
  const afterHandNumber = latestHand?.handNumber ?? 0;
  const startHtml = bothHaveChips
    ? `      <section class="panel">
        <h2>Hand</h2>
        <form method="post" action="/t/${encodeURIComponent(table.code)}/hand/start">
          <input type="hidden" name="after_hand_number" value="${afterHandNumber}" />
          <button type="submit" class="action-btn primary">${latestHand ? "Start next hand" : "Start hand"}</button>
        </form>
      </section>`
    : `      <section class="panel">
        <p class="status-line">Match over: a player has no chips remaining.</p>
      </section>`;

  return `${summaryHtml}
${startHtml}`;
}

// Computes the dynamic table HTML for the current requester's identity. This
// is the one shared rendering seam the realtime refresh needs: GET /t/:code
// wraps its result in the full page shell plus the realtime wrapper/script,
// and GET /t/:code/live (below) returns exactly the same string as a bare
// fragment. There is no separate copy of this rendering logic anywhere else
// — which is also what makes the privacy rules in renderHandSection/
// renderActiveHand/renderSettlementSummary apply identically to both.
function renderTableBody(c: Context, table: PokerTable): string {
  const identityId = c.get("identityId");
  const seats = getSeatsForTable(table.id);
  const self = seats.find((s) => s.identityId === identityId);
  const seat1 = seats.find((s) => s.seatNumber === 1);
  const seat2 = seats.find((s) => s.seatNumber === 2);
  const shareUrl = new URL(`/t/${encodeURIComponent(table.code)}`, c.req.url).toString();

  const selfSection = self
    ? `<p class="status-line">You are seat ${self.seatNumber} — ${self.chipStack} chips.</p>`
    : seat2
      ? "<p>This table is full. You are not a participant.</p>"
      : `      <form method="post" action="/t/${encodeURIComponent(table.code)}/join">
        <button type="submit" class="action-btn primary">Join table</button>
      </form>`;

  const statusLine =
    table.status === "ready"
      ? `<p class="status-line">Both seats are filled.</p>`
      : `<p class="status-line">Waiting for a second player.</p>`;

  const handHtml = self ? renderHandSection(table, identityId) : "";

  return `      <header class="panel">
        <h1>Table ${escapeHtml(table.code)}</h1>
        ${statusLine}
        ${selfSection}
        <p class="meta">Other players' committed changes appear automatically while this page is open.</p>
      </header>

      <section class="panel invite">
        <strong>Invite link</strong> — send this to the other player:
        <code>${escapeHtml(shareUrl)}</code>
      </section>

      <section class="panel">
        <h2>Seats</h2>
        ${renderSeatLine(1, seat1)}
        ${renderSeatLine(2, seat2)}
      </section>

      <section class="panel">
        <h2>Table settings</h2>
        <p>Blinds: ${table.smallBlind} / ${table.bigBlind}. Starting stack:
        ${table.startingStack} virtual chips per seat.</p>
        <p class="meta">Development defaults, not yet an approved permanent
        configuration. Non-cash virtual chips only — no real money, no
        purchases, no cash-out.</p>
      </section>
${handHtml}`;
}

// The table-live wrapper's id, shared between the full page (below) and the
// realtime client script's refresh target — exactly one element with this id
// exists per table page load.
const TABLE_LIVE_WRAPPER_ID = "poker-table-live";

// Builds the inline realtime client script for a seated player only. Listens
// for exactly "ready" (covers first connection and every native reconnect —
// the server sends one per stream) and "table_changed"; heartbeat is
// deliberately never listened for, so it can never trigger a refresh. The
// refresh itself is serialized/coalesced: at most one /live fetch is ever in
// flight, a refresh requested mid-fetch is merely queued, and finishing a
// fetch runs exactly one queued catch-up refresh rather than one per missed
// event. A failed fetch (network error or non-OK status) only logs a
// warning — it never clears or replaces the currently-rendered table UI, and
// a later ready/table_changed event gets another chance. Unchanged in
// mechanism from the strategy-war product's realtime script; only the event
// name and wrapper id are poker-specific.
function renderRealtimeScript(eventsUrl: string, liveUrl: string): string {
  return `      <script>
        (function () {
          var fetchInFlight = false;
          var refreshQueued = false;

          function refreshTableLive() {
            if (fetchInFlight) {
              refreshQueued = true;
              return;
            }
            fetchInFlight = true;
            fetch(${JSON.stringify(liveUrl)}, { credentials: "same-origin" })
              .then(function (res) {
                if (!res.ok) throw new Error("live fragment fetch failed: " + res.status);
                return res.text();
              })
              .then(function (html) {
                var el = document.getElementById(${JSON.stringify(TABLE_LIVE_WRAPPER_ID)});
                if (el) el.innerHTML = html;
              })
              .catch(function (err) {
                console.warn("table live refresh failed", err);
              })
              .finally(function () {
                fetchInFlight = false;
                if (refreshQueued) {
                  refreshQueued = false;
                  refreshTableLive();
                }
              });
          }

          var source = new EventSource(${JSON.stringify(eventsUrl)});
          source.addEventListener("ready", refreshTableLive);
          source.addEventListener("table_changed", refreshTableLive);
        })();
      </script>`;
}

function renderTablePage(c: Context, table: PokerTable): Response {
  const identityId = c.get("identityId");
  const isParticipant = getSeatForIdentity(table.id, identityId) !== undefined;
  const bodyHtml = renderTableBody(c, table);
  const code = encodeURIComponent(table.code);

  // Only a seated player ever opens the realtime connection — a non-
  // participant may already view this page, so this script, and the SSE
  // connection it opens, simply doesn't exist for them at all.
  const realtimeScript = isParticipant ? renderRealtimeScript(`/t/${code}/events`, `/t/${code}/live`) : "";

  return c.html(
    pageShell(
      `Table ${table.code}`,
      `      <div id="${TABLE_LIVE_WRAPPER_ID}">
${bodyHtml}
      </div>
${realtimeScript}`,
    ),
  );
}

app.get("/t/:code", (c) => {
  const table = getPokerTableByCode(c.req.param("code"));
  if (!table) return notFoundPage(c);
  return renderTablePage(c, table);
});

// The authoritative live fragment the realtime client script refetches.
// Identity-specific, so it must never be cached or stored by a shared/
// intermediate cache. No JSON, no client-submitted identity/seat — exactly
// the same renderTableBody() output GET /t/:code itself embeds, just
// without the page shell around it (no <!doctype html>, no <html> wrapper).
app.get("/t/:code/live", (c) => {
  const table = getPokerTableByCode(c.req.param("code"));
  if (!table) return notFoundPage(c);

  c.header("Cache-Control", "no-store, private");
  return c.html(renderTableBody(c, table));
});

app.post("/t/:code/join", (c) => {
  const table = getPokerTableByCode(c.req.param("code"));
  if (!table) return notFoundPage(c);

  const identityId = c.get("identityId");
  const result = joinPokerTable(table.id, identityId);

  if (!result.ok) {
    return c.html(
      pageShell(
        "Table full",
        `      <h1>This table is already full</h1>
      <p><a href="/t/${encodeURIComponent(table.code)}">Back to the table</a></p>`,
      ),
      409,
    );
  }

  // Only a genuinely new seat is a shared state change worth telling anyone
  // else about — the same identity idempotently re-joining (already seated,
  // nothing new) must not publish.
  if (!result.alreadyJoined) publish(table.id);

  return c.redirect(`/t/${encodeURIComponent(table.code)}`, 303);
});

function tableErrorPage(c: Context, table: PokerTable, title: string, message: string, status: 200 | 400 | 403 | 409) {
  return c.html(
    pageShell(
      title,
      `      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <p><a href="/t/${encodeURIComponent(table.code)}">Back to the table</a></p>`,
    ),
    status,
  );
}

// Strictly requires a well-formed, safe-integer after_hand_number: unlike
// createPokerHand's own optional third parameter (which exists so every
// pre-existing direct caller — including every test fixture — can keep
// omitting it with no behavior change), the HTTP route itself must never
// silently treat a missing or malformed value as "no expectation", since
// that would quietly disable the optimistic-concurrency guard the real
// rendered UI relies on. parseNonNegativeInteger already rejects empty/
// whitespace-only/negative/fractional/NaN/Infinity/non-digit input; this
// adds the one thing it doesn't check — IEEE-754 double precision stops
// being able to distinguish every integer once a value exceeds
// Number.MAX_SAFE_INTEGER (2^53 - 1), so e.g. 9007199254740992 (2^53) must
// also be refused here even though it technically passes
// Number.isInteger().
function requireAfterHandNumber(value: unknown): number | undefined {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

app.post("/t/:code/hand/start", async (c) => {
  const table = getPokerTableByCode(c.req.param("code"));
  if (!table) return notFoundPage(c);

  const identityId = c.get("identityId");
  if (!getSeatForIdentity(table.id, identityId)) {
    return tableErrorPage(c, table, "Cannot start hand", "Only a seated player can start a hand.", 403);
  }

  const body = await c.req.parseBody();
  const afterHandNumber = requireAfterHandNumber(body["after_hand_number"]);
  if (afterHandNumber === undefined) {
    return tableErrorPage(
      c,
      table,
      "Invalid request",
      "The submitted form was missing or had an invalid after_hand_number.",
      400,
    );
  }

  const result = createPokerHand(table.id, undefined, afterHandNumber);

  if (!result.ok) {
    if (result.reason === "hand_already_active" || result.reason === "stale_hand_state") {
      // Not an error from this route's point of view: a hand already
      // exists (very plausibly because the other player's own request won
      // a race to start it a moment earlier, or because this exact request
      // was itself double-submitted) — just show the current state rather
      // than creating a second hand the user never asked for.
      return c.redirect(`/t/${encodeURIComponent(table.code)}`, 303);
    }
    if (result.reason === "insufficient_chips") {
      return tableErrorPage(
        c,
        table,
        "Match over",
        "A player has no chips remaining; no further hands can be played at this table.",
        200,
      );
    }
    return tableErrorPage(c, table, "Cannot start hand", "Both seats must be filled before a hand can start.", 409);
  }

  publish(table.id);
  return c.redirect(`/t/${encodeURIComponent(table.code)}`, 303);
});

const VALID_BETTING_ACTION_TYPES: ReadonlySet<string> = new Set([
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "all_in",
]);

function parseBettingActionType(value: unknown): BettingActionType | undefined {
  return typeof value === "string" && VALID_BETTING_ACTION_TYPES.has(value) ? (value as BettingActionType) : undefined;
}

// Strict non-negative integer parsing: the trimmed input must be composed
// only of ASCII digits. This deliberately rejects anything Number()'s own
// lenient coercion would otherwise accept or mishandle — a leading '+'/'-',
// a decimal point, exponent notation, hex, internal/leading/trailing
// whitespace beyond a single outer trim, or a non-finite result — so a
// malformed, fractional, negative, or non-numeric submission is refused
// before it ever reaches the betting engine, rather than silently coerced
// into some other legal-looking number.
function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

app.post("/t/:code/hand/action", async (c) => {
  const table = getPokerTableByCode(c.req.param("code"));
  if (!table) return notFoundPage(c);

  const body = await c.req.parseBody();

  const handId = parseNonNegativeInteger(body["hand_id"]);
  const expectedVersion = parseNonNegativeInteger(body["expected_version"]);
  const actionType = parseBettingActionType(body["action"]);
  const rawRequestId = body["request_id"];
  const requestId = typeof rawRequestId === "string" && rawRequestId.trim() !== "" ? rawRequestId : undefined;
  const rawAmount = body["amount"];
  const amount =
    rawAmount === undefined || rawAmount === "" ? undefined : parseNonNegativeInteger(rawAmount);

  if (handId === undefined || expectedVersion === undefined || actionType === undefined || requestId === undefined) {
    return tableErrorPage(c, table, "Invalid request", "The submitted form was missing or malformed.", 400);
  }
  if ((actionType === "bet" || actionType === "raise") && amount === undefined) {
    return tableErrorPage(c, table, "Invalid amount", "A bet or raise requires a valid whole-number amount.", 400);
  }

  // hand_id comes from a hidden form field (embedded at render time), not
  // re-derived from "whatever the table's current active hand is" —
  // deliberately, so a retried submission of the action that just settled
  // a hand can still reach that exact hand and its real idempotency check,
  // instead of 404ing merely because the hand is no longer "active" by the
  // time the retry arrives. It is still never trusted blindly: it must
  // actually belong to the table named in the URL before anything else
  // happens, exactly like every other identifier this app resolves fresh
  // from the database rather than from client say-so.
  const hand = getHandById(handId);
  if (!hand || hand.tableId !== table.id) {
    return tableErrorPage(c, table, "Invalid hand", "That hand does not belong to this table.", 400);
  }

  const identityId = c.get("identityId");
  const result = submitBettingAction({
    handId,
    identityId,
    requestId,
    expectedVersion,
    action: amount === undefined ? { type: actionType } : { type: actionType, amount },
  });

  if (!result.ok) {
    // result.reason is the engine's own real rejection value (e.g.
    // "not_your_turn", "stale_version", "request_id_conflict") — shown
    // as-is, never replaced with an invented identifier.
    return tableErrorPage(c, table, "Action rejected", `Your action could not be applied: ${result.reason}.`, 409);
  }

  // Only a genuinely new, effective action is worth telling anyone else
  // about — an idempotent replay of an already-applied action (including a
  // retry of the action that completed and settled the hand) must not
  // publish again.
  if (!result.duplicate) publish(table.id);

  return c.redirect(`/t/${encodeURIComponent(table.code)}`, 303);
});

// SSE transport, reused unchanged in mechanism from the strategy-war
// product: participant-gated (403/404 before the stream opens), a single
// content-free "table_changed" event, and a 20s heartbeat so intermediate
// proxies don't treat an otherwise-quiet connection as dead. Carries no
// hand/card/betting payload of any kind — exactly like before, it means
// only "your authoritative view may be stale; re-fetch it."
const HEARTBEAT_INTERVAL_MS = 20_000;

app.get("/t/:code/events", (c) => {
  const table = getPokerTableByCode(c.req.param("code"));
  if (!table) return notFoundPage(c);

  const identityId = c.get("identityId");
  const seat = getSeatForIdentity(table.id, identityId);
  if (!seat) {
    return c.html(
      pageShell(
        "Cannot subscribe",
        "      <h1>Only a seated player at this table can subscribe to its live updates.</h1>",
      ),
      403,
    );
  }

  return streamSSE(c, async (stream) => {
    const unsubscribe = subscribeToRealtimeUpdates(table.id, async () => {
      await stream.writeSSE({ event: "table_changed", data: "" });
    });

    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);

    // Hono's write() swallows every transport-level write error internally
    // (see node_modules/hono/dist/utils/stream.js), so a dead connection is
    // never surfaced to us as a rejected writeSSE() — stream.onAbort() is the
    // only real signal we get. abort() is single-shot and only invokes
    // listeners already present in its list at the moment it fires, so this
    // listener MUST be registered before this callback's first `await` —
    // otherwise a client that disconnects before the "ready" write below
    // completes could trigger abort() first, and this cleanup would be
    // registered too late and silently never run (leaking the heartbeat
    // interval and the realtime.ts subscription for the process's lifetime).
    // cleanedUp guards idempotency explicitly, rather than relying only on
    // the primitives it calls happening to be safe to repeat.
    let cleanedUp = false;
    function cleanup(): void {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      unsubscribe();
    }

    const aborted = new Promise<void>((resolve) => {
      stream.onAbort(() => {
        cleanup();
        resolve();
      });
    });

    // Transport-only signal: confirms the stream opened. Not a gameplay
    // event, and must never be treated as one by a future client. Issued
    // only now, since onAbort is already registered above — no suspension
    // point has occurred yet that could let an abort race ahead of it.
    await stream.writeSSE({ event: "ready", data: "" });

    // streamSSE closes the stream as soon as this callback returns, so it
    // stays pending until the connection aborts (client disconnect, network
    // failure, etc.), at which point cleanup runs exactly once.
    await aborted;
  });
});

// --- Card Clash: HTTP rooms, identity, and private state views (D3B) -------
// A minimal JSON API under /api/card-clash, built on the SAME identity
// middleware/cookie as every route above — no second identity system, no
// client-supplied identity ever trusted. Every room-membership/authorization
// decision below is derived solely from c.get("identityId"). No gameplay
// ACTION endpoints exist yet (no Attack/Heal/Seize/etc. routes) — only room
// lifecycle (create/join/ready/start) and read-only state views, per this
// slice's explicit scope. No SSE, no timers, no UI.

const CARD_CLASH_MODES: ReadonlySet<string> = new Set(["1v1", "1v2", "2v2"]);

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

// Shapes one viewer's own authorized view of a match: every seat's public
// info (team/HP/eliminated/hand SIZE), but actual hole-card contents only
// for the viewer's own seat — never another seat's hand, and never the raw
// draw pile (only its remaining count). `pending`/`matchResult`/`publicLog`
// are safe to include for every viewer as-is: by construction (card-clash/
// combat.ts, group-effects.ts, effects.ts) they never carry hidden card
// identities or deck order. `deadline` (D4C-1) is likewise safe for every
// viewer: only an absolute timestamp and a seat number, already implied by
// the public `pending`/`activeSeat` fields above — never private hand or
// draw-pile contents, and never the internal scheduler/timer objects.
function projectCardClashMatchForViewer(
  match: PersistedCardClashMatch,
  viewerSeat: CardClashSeatNumber | undefined,
  deadline: PersistedCardClashDeadline | undefined,
) {
  const state = match.state;
  const players = [...state.players.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seatNumber, player]) => ({
      seat: seatNumber,
      team: player.team,
      maxHp: player.maxHp,
      hp: player.hp,
      eliminated: player.eliminated,
      handSize: player.hand.length,
      ...(seatNumber === viewerSeat ? { hand: player.hand } : {}),
    }));

  return {
    matchId: match.id,
    roomId: match.roomId,
    version: match.version,
    mode: state.mode,
    activeSeat: state.activeSeat,
    normalAttacksUsedThisTurn: state.normalAttacksUsedThisTurn,
    drawPileCount: state.drawPile.length,
    discardPile: state.discardPile,
    pending: state.pending,
    // Public-safe phase marker so the UI never has to infer DISCARD from hand size.
    turnPhase: state.turnPhase ?? "main",
    matchResult: state.matchResult,
    publicLog: state.publicLog,
    players,
    viewerSeat: viewerSeat ?? null,
    deadline: deadline ? { expiresAt: deadline.expiresAt, responderSeat: deadline.responderSeat } : null,
  };
}

// One shared handler: Card Clash is the primary site at / (HTTP 200, no
// redirect, as the course invariant requires) and stays at /card-clash.
const cardClashHome = (c: Context) => c.html(renderCardClashPage());
app.get("/", cardClashHome);
app.get("/card-clash", cardClashHome);

app.post("/api/card-clash/rooms", async (c) => {
  const identityId = c.get("identityId");
  const body = await readJsonBody(c);
  const mode = typeof (body as { mode?: unknown } | undefined)?.mode === "string" ? (body as { mode: string }).mode : undefined;
  if (!mode || !CARD_CLASH_MODES.has(mode)) {
    return c.json({ error: "invalid_mode" }, 400);
  }

  const room = createCardClashRoom(mode as CardClashMode, identityId);
  // Harmless with zero listeners (nobody could have subscribed to a room
  // that didn't exist a moment ago) — published anyway for consistency.
  publishCardClashRoomEvent(room.id, "room");
  return c.json(
    { code: room.code, mode: room.mode, status: room.status, ownSeat: 1, requiredSeats: CARD_CLASH_SEAT_COUNT[room.mode] },
    201,
  );
});

app.get("/api/card-clash/rooms/:code", (c) => {
  const room = getCardClashRoomByCode(c.req.param("code"));
  if (!room) return c.json({ error: "room_not_found" }, 404);

  const identityId = c.get("identityId");
  const seats = getCardClashSeatsForRoom(room.id);
  const viewerSeat = seats.find((s) => s.identityId === identityId)?.seatNumber;

  return c.json({
    code: room.code,
    mode: room.mode,
    status: room.status,
    requiredSeats: CARD_CLASH_SEAT_COUNT[room.mode],
    hostSeat: 1,
    // Never identityId — an internal server-side reference, not for other
    // players to see — only seat number and readiness.
    seats: seats.map((s) => ({ seatNumber: s.seatNumber, ready: s.ready })),
    viewerSeat: viewerSeat ?? null,
  });
});

app.post("/api/card-clash/rooms/:code/join", (c) => {
  const room = getCardClashRoomByCode(c.req.param("code"));
  if (!room) return c.json({ error: "room_not_found" }, 404);

  const identityId = c.get("identityId");
  const result = joinCardClashRoom(room.id, identityId);
  if (!result.ok) {
    const status = result.reason === "room_not_found" ? 404 : 409;
    return c.json({ error: result.reason }, status);
  }
  // Only a genuinely new seat is a shared state change worth telling
  // anyone else about — the same identity idempotently reconnecting must
  // not publish (matches poker's own established join-notification rule).
  if (!result.alreadyJoined) publishCardClashRoomEvent(room.id, "room");
  return c.json({ seatNumber: result.seatNumber, alreadyJoined: result.alreadyJoined });
});

app.post("/api/card-clash/rooms/:code/ready", async (c) => {
  const room = getCardClashRoomByCode(c.req.param("code"));
  if (!room) return c.json({ error: "room_not_found" }, 404);

  // Only `ready` is ever read from the body — no target seat, no identity
  // field of any kind is accepted from the client; the acting seat is
  // always c.get("identityId")'s own seat.
  const body = await readJsonBody(c);
  const ready = (body as { ready?: unknown } | undefined)?.ready;
  if (typeof ready !== "boolean") {
    return c.json({ error: "invalid_request" }, 400);
  }

  const identityId = c.get("identityId");
  const result = setCardClashSeatReady(room.id, identityId, ready);
  if (!result.ok) {
    const status = result.reason === "not_a_player" ? 403 : 409;
    return c.json({ error: result.reason }, status);
  }
  publishCardClashRoomEvent(room.id, "room");
  return c.json({ ready });
});

app.post("/api/card-clash/rooms/:code/start", (c) => {
  const room = getCardClashRoomByCode(c.req.param("code"));
  if (!room) return c.json({ error: "room_not_found" }, 404);

  // Captured BEFORE calling startCardClashMatch: only a room that was
  // genuinely still 'waiting' at the start of this request can have this
  // specific call be the one that truly started the match — a repeated
  // start (room already 'active'/'complete') returns the same existing
  // match idempotently and must not publish again. startCardClashMatch's
  // own result type carries no such flag, so this is the smallest reliable
  // way to tell the two cases apart without any storage-layer change.
  const wasWaiting = room.status === "waiting";

  const identityId = c.get("identityId");
  const result = startCardClashMatch(room.id, identityId);
  if (!result.ok) {
    const status = result.reason === "not_the_host" ? 403 : result.reason === "room_not_found" ? 404 : 409;
    return c.json({ error: result.reason }, status);
  }

  if (wasWaiting) {
    publishCardClashRoomEvent(room.id, "match");
  }
  // Starting a match always creates its first actionable deadline (D4C-1) —
  // arm the real wake-up timer for it regardless of which branch returned
  // (a genuine start or an idempotent repeat), since either way this is a
  // live request touching this match right now.
  rescheduleCardClashTimer(
    result.match.id,
    room.id,
    result.deadline ? { version: result.deadline.version, expiresAt: result.deadline.expiresAt, responderSeat: result.deadline.responderSeat } : null,
    Date.now(),
  );

  const viewerSeat = getCardClashSeatForIdentity(room.id, identityId)?.seatNumber as CardClashSeatNumber | undefined;
  return c.json(projectCardClashMatchForViewer(result.match, viewerSeat, result.deadline));
});

app.get("/api/card-clash/rooms/:code/state", (c) => {
  const room = getCardClashRoomByCode(c.req.param("code"));
  if (!room) return c.json({ error: "room_not_found" }, 404);

  const identityId = c.get("identityId");
  const seat = getCardClashSeatForIdentity(room.id, identityId);
  if (!seat) return c.json({ error: "not_a_player" }, 403);

  if (room.status === "waiting") {
    return c.json({ status: "waiting" }, 409); // defined, non-leaking: no match exists to view yet
  }

  const match = getCardClashMatchForRoom(room.id);
  if (!match) return c.json({ error: "match_not_found" }, 404);

  // Reconcile any deadline that is already overdue before returning a
  // snapshot (D4C-1 docs §11/§6): a client fetching state is itself an
  // "authorized access" point, and the real wall-clock timer may not have
  // fired yet (e.g. the Fly machine had been stopped). This never sets a
  // NEW deadline just because someone fetched — it only ever applies a
  // deadline that was already genuinely due.
  const reconciled = reconcileCardClashMatchIfOverdue(match.id, room.id, Date.now());
  const deadline = getCardClashDeadline(match.id);

  return c.json(projectCardClashMatchForViewer(reconciled.match, seat.seatNumber as CardClashSeatNumber, deadline));
});

// Invalidation-only SSE (D4B): never a game snapshot, just "something in
// this room changed, go refetch it" — a client refetches the already
// privacy-filtered GET /rooms/:code (scope "room") or GET
// /rooms/:code/state (scope "match"). Mirrors the existing poker SSE
// route's own structure exactly (participant-gated before the stream
// opens, onAbort registered before any await, a heartbeat so intermediate
// proxies don't treat a quiet connection as dead), against the SEPARATE
// card-clash/realtime.ts hub — never realtime.ts itself, so there is no
// risk of a poker table id and a Card Clash room id cross-notifying each
// other. An eliminated player still holds their seat row, so they pass the
// same participant check as everyone else — exactly the intended
// read-only spectator access (docs/card-clash-rules.md §7).
app.get("/api/card-clash/rooms/:code/events", (c) => {
  const room = getCardClashRoomByCode(c.req.param("code"));
  if (!room) return notFoundPage(c);

  const identityId = c.get("identityId");
  const seat = getCardClashSeatForIdentity(room.id, identityId);
  if (!seat) {
    return c.json({ error: "not_a_player" }, 403);
  }

  return streamSSE(c, async (stream) => {
    const unsubscribe = subscribeToCardClashRoom(room.id, async (scope) => {
      await stream.writeSSE({ event: "invalidate", data: JSON.stringify({ scope }) });
    });

    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);

    // Registered before any await, for the same reason the poker SSE route
    // above does this: a client that disconnects before the "ready" write
    // completes could otherwise trigger abort() before this listener
    // exists, leaking the heartbeat interval and the hub subscription for
    // the process's lifetime.
    let cleanedUp = false;
    function cleanup(): void {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      unsubscribe();
    }

    const aborted = new Promise<void>((resolve) => {
      stream.onAbort(() => {
        cleanup();
        resolve();
      });
    });

    // Transport-open signal, not a gameplay event — a reconnecting client
    // treats this exactly like an "invalidate" (refetch both room and
    // match views) since it may have missed updates while disconnected.
    await stream.writeSSE({ event: "ready", data: "" });

    await aborted;
  });
});

// Defense-in-depth beyond SameSite=Lax, scoped to this new mutation route
// only (the existing D3B room routes are left exactly as they were —
// widening this to every route would be the kind of unrelated refactor
// this slice avoids). Compares the browser-supplied Origin against this
// SAME request's own Host header — never a separately configured "public
// origin" value, which would be wrong for local dev and fragile behind a
// proxy. A request with no Origin header at all is not rejected here (many
// legitimate same-origin and non-browser requests omit it); only a
// present-but-mismatched Origin is. This never trusts a forwarded-host
// header for the comparison, only the request's own Host.
function isAllowedCardClashActionOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    const requestHost = c.req.header("host");
    return requestHost !== undefined && new URL(origin).host === requestHost;
  } catch {
    return false;
  }
}

const CARD_CLASH_ACTION_MAX_BODY_BYTES = 4096;

// The one gameplay-action endpoint (D4A): every existing engine action —
// Attack, Dodge/decline, proactive Heal, Seize, Disarm, Insight, War Cry,
// Arrow Volley, group responses, dying-rescue Heal/decline, end-turn, and
// manual discard — dispatched through card-clash/action-http.ts's single
// typed adapter onto the SAME trusted-transition contract D3A's
// applyCardClashTransition already enforces (version check, idempotent
// request_id, atomic commit). No SSE, no timers — the acting browser gets
// its own updated viewer-filtered state back in the response; cross-
// browser live updates are a later slice.
app.post("/api/card-clash/rooms/:code/actions", async (c) => {
  if (!isAllowedCardClashActionOrigin(c)) {
    return c.json({ error: "invalid_origin" }, 403);
  }

  const room = getCardClashRoomByCode(c.req.param("code"));
  if (!room) return c.json({ error: "room_not_found" }, 404);

  const identityId = c.get("identityId");
  const seat = getCardClashSeatForIdentity(room.id, identityId);
  if (!seat) return c.json({ error: "not_a_player" }, 403);

  // Covers both "not started yet" and "already finished" in one check —
  // room.status leaves 'active' in exactly those two cases.
  if (room.status !== "active") {
    return c.json({ error: "match_not_active" }, 409);
  }

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return c.json({ error: "invalid_content_type" }, 400);
  }

  const rawBody = await c.req.text();
  if (rawBody.length > CARD_CLASH_ACTION_MAX_BODY_BYTES) {
    return c.json({ error: "request_too_large" }, 400);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const envelope = parseCardClashActionEnvelope(parsedBody);
  if (!envelope) return c.json({ error: "invalid_request" }, 400);

  const seatNumber = seat.seatNumber as CardClashSeatNumber;
  let match = getCardClashMatchForRoom(room.id);
  if (!match) return c.json({ error: "match_not_found" }, 404); // defensive; unreachable given room.status === "active"

  // Reconcile any already-overdue deadline FIRST (D4C-1 docs §11 "an
  // expired action and a valid action for the same phase must never both
  // succeed"). If a timeout genuinely applies, this advances the match past
  // it — the client's own action below is then checked against the NEW
  // version, so an action that arrived too late is correctly rejected by
  // the existing stale_version check rather than racing the real timer.
  const reconciled = reconcileCardClashMatchIfOverdue(match.id, room.id, Date.now());
  match = reconciled.match;

  if (match.state.players.get(seatNumber)?.eliminated) {
    return c.json({ error: "eliminated" }, 403);
  }

  const result = applyCardClashTransition({
    matchId: match.id,
    requestId: envelope.requestId,
    expectedVersion: envelope.expectedVersion,
    transition: buildCardClashTransition(envelope.action, seatNumber, envelope.expectedVersion),
  });

  if (!result.ok) {
    // result.reason is always one of the trusted layers' own typed
    // rejection values (storage-level: match_not_found/stale_version/
    // request_id_conflict/transition_rejected; or, nested in `detail` for
    // transition_rejected, the pure engine's own reason, e.g.
    // not_your_turn/card_not_in_hand/wrong_response_type) — never a raw
    // SQL error, stack trace, or internal secret.
    const status = result.reason === "match_not_found" ? 404 : 409;
    return c.json(
      { error: result.reason, detail: "detail" in result ? result.detail : undefined },
      status,
    );
  }

  // Only a genuinely new, effective action is worth telling anyone else
  // about — an idempotent replay of an already-applied request must not
  // publish again (reuses the existing `duplicate` flag already returned
  // by applyCardClashTransition — no new storage-layer work needed).
  if (!result.duplicate) {
    publishCardClashRoomEvent(room.id, "match");
    rescheduleCardClashTimer(
      result.match.id,
      room.id,
      result.nextDeadline ? { version: result.match.version, ...result.nextDeadline } : null,
      Date.now(),
    );
  }
  const deadline = getCardClashDeadline(result.match.id);

  return c.json({
    duplicate: result.duplicate,
    ...projectCardClashMatchForViewer(result.match, seatNumber, deadline),
  });
});

app.get("/readme/", (c) => {
  const readme = readFileSync(readmePath, "utf8");
  return c.html(
    pageShell("About", `      <h1>About</h1>\n      <pre>${escapeHtml(readme)}</pre>`),
  );
});

// Exported so spec files can exercise the real Hono app in-process (via
// app.fetch) — needed because verifying that a direct realtime.ts publish()
// reaches an open SSE stream requires the test and the stream to share the
// same in-memory subscriber registry, which isn't possible against a
// separate process (e.g. the Docker container the other spec files test
// against over baseUrl).
export { app };

const port = Number(process.env.PORT) || 8080;

// Only bind a real port when this file is actually run as the application
// entrypoint (`node server.ts`, including under Docker/Fly) — not merely
// imported for its `app` export, which would otherwise try to bind the same
// port a real running instance might already hold. Reconciling and re-
// arming every live Card Clash deadline is gated the same way: a plain
// import (every spec file) must never start background real-wall-clock
// timers, only an actual running server process.
if (import.meta.filename === process.argv[1]) {
  reconcileAllCardClashMatchesOnStartup();
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
}
