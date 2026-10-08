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
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        line-height: 1.5;
        color: #1e293b;
        background: #f1f5f9;
      }
      main { max-width: 52rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
      h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
      h2 { margin: 0 0 0.75rem; font-size: 1.05rem; color: #334155; }
      p { margin: 0.4rem 0; }
      a { color: #2563eb; }
      code { overflow-wrap: anywhere; }
      label { display: block; margin: 0.4rem 0; }
      input[type="text"], input[type="number"] {
        font: inherit;
        padding: 0.4rem 0.6rem;
        border: 1px solid #cbd5e1;
        border-radius: 0.375rem;
        margin-top: 0.25rem;
        width: 8rem;
      }
      button {
        font: inherit;
        padding: 0.5rem 1.1rem;
        border: 1px solid #cbd5e1;
        border-radius: 0.375rem;
        background: #fff;
        cursor: pointer;
      }
      button:hover { background: #f8fafc; }
      .panel {
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 0.5rem;
        padding: 1rem 1.25rem;
        margin: 1rem 0;
      }
      .status-line { font-size: 1.05rem; font-weight: 600; margin: 0.3rem 0; }
      .meta { color: #64748b; font-size: 0.85rem; }
      .invite {
        background: #eff6ff;
        border: 1px dashed #93c5fd;
        border-radius: 0.5rem;
        padding: 0.75rem 1rem;
      }
      .invite code {
        display: block;
        margin-top: 0.35rem;
        padding: 0.4rem 0.5rem;
        background: #fff;
        border: 1px solid #bfdbfe;
        border-radius: 0.3rem;
        font-size: 0.95rem;
      }
      .card {
        display: inline-block;
        min-width: 2rem;
        padding: 0.15rem 0.4rem;
        margin: 0.1rem;
        border: 1px solid #94a3b8;
        border-radius: 0.3rem;
        background: #fff;
        font-weight: 700;
        text-align: center;
      }
      .card-red { color: #b91c1c; }
      .card-hidden { background: #cbd5e1; color: #cbd5e1; }
      .inline-form { display: inline-block; margin: 0.2rem 0.4rem 0.2rem 0; }
      @media (max-width: 480px) {
        main { padding: 1rem 0.75rem 2rem; }
        .panel { padding: 0.85rem 1rem; }
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

app.get("/", (c) => {
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

const BETTING_ACTION_LABELS: Record<BettingActionType, string> = {
  fold: "Fold",
  check: "Check",
  call: "Call",
  bet: "Bet",
  raise: "Raise",
  all_in: "All-in",
};

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
function renderBettingControls(table: PokerTable, hand: PersistedHand, mySeat: Seat): string {
  const legal = getLegalActions(hand.bettingState, mySeat);
  if (!legal.canAct) return "";

  const code = encodeURIComponent(table.code);
  const hiddenFields = (): string => `<input type="hidden" name="hand_id" value="${hand.id}" />
        <input type="hidden" name="request_id" value="${escapeHtml(randomBytes(16).toString("hex"))}" />
        <input type="hidden" name="expected_version" value="${hand.version}" />`;

  const simpleButtons = legal.actions
    .filter((action): action is Exclude<BettingActionType, "bet" | "raise"> => action !== "bet" && action !== "raise")
    .map((action) => {
      const extra = action === "call" ? ` (${legal.amountToCall})` : action === "all_in" ? ` (${legal.maxCommitment})` : "";
      return `      <form class="inline-form" method="post" action="/t/${code}/hand/action">
        ${hiddenFields()}
        <input type="hidden" name="action" value="${action}" />
        <button type="submit">${escapeHtml(BETTING_ACTION_LABELS[action])}${escapeHtml(extra)}</button>
      </form>`;
    })
    .join("\n");

  const amountAction: "bet" | "raise" | undefined = legal.actions.includes("raise")
    ? "raise"
    : legal.actions.includes("bet")
      ? "bet"
      : undefined;
  const minAmount = amountAction === "raise" ? legal.minRaiseTo : legal.minBet;
  const amountControl = amountAction
    ? `      <form class="inline-form" method="post" action="/t/${code}/hand/action">
        ${hiddenFields()}
        <input type="hidden" name="action" value="${amountAction}" />
        <label>${escapeHtml(BETTING_ACTION_LABELS[amountAction])} to
          <input type="number" name="amount" min="${minAmount}" max="${legal.maxCommitment}" step="1" required />
        </label>
        <button type="submit">${escapeHtml(BETTING_ACTION_LABELS[amountAction])}</button>
      </form>`
    : "";

  return `      <div class="panel">
        <p class="status-line">Your turn.</p>
${simpleButtons}
${amountControl}
      </div>`;
}

// --- Active-hand and settlement rendering -----------------------------------

function renderActiveHand(table: PokerTable, hand: PersistedHand, identityId: number): string {
  const mySeat = getSeatNumberForIdentityInHand(hand.id, identityId);
  const community = getCommunityCards(hand.id);
  const seats = hand.bettingState.seats;
  const pot = seats[1].committedTotal + seats[2].committedTotal;

  const communityHtml = community.length > 0 ? renderCards(community) : `<span class="meta">(none yet)</span>`;

  const myHoleCards = mySeat ? (getOwnHoleCards(hand.id, identityId) ?? []) : [];

  function seatLine(seatNumber: Seat): string {
    const seat = seats[seatNumber];
    const isButton = hand.bettingState.buttonSeat === seatNumber;
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
    const flags = [isButton ? "button" : "", isMe ? "you" : "", seat.folded ? "folded" : "", seat.allIn ? "all-in" : ""]
      .filter(Boolean)
      .join(", ");
    return `<p class="status-line">Seat ${seatNumber}${flags ? ` (${escapeHtml(flags)})` : ""}: ${seat.stack} chips
        — committed ${seat.committedThisStreet} this street</p>
      <p class="meta">${cardsHtml}</p>`;
  }

  const actingSeat = hand.bettingState.actingSeat;
  const turnLine = !actingSeat
    ? ""
    : mySeat === actingSeat
      ? ""
      : `<p class="meta">Waiting for the other player to act...</p>`;

  const controlsHtml = mySeat && actingSeat === mySeat ? renderBettingControls(table, hand, mySeat) : "";

  return `      <section class="panel">
        <h2>Hand #${hand.handNumber} — ${escapeHtml(hand.street)}</h2>
        <p>Blinds: ${hand.bettingState.smallBlind} / ${hand.bettingState.bigBlind}. Pot: ${pot}.</p>
        <p>Community cards: ${communityHtml}</p>
        ${seatLine(1)}
        ${seatLine(2)}
        ${turnLine}
      </section>
${controlsHtml}`;
}

function renderSettlementSummary(hand: PersistedHand): string {
  if (hand.status !== "settled") return "";
  const planResult = getSettlementPlanForHand(hand.id);
  if (!planResult.ok) return "";
  const plan = planResult.plan;
  const showdownCards = getShowdownHoleCards(hand.id) ?? {};

  const resultLine =
    plan.outcome === "fold"
      ? `Seat ${plan.winningSeats[0]} won hand #${hand.handNumber} uncontested (the other player folded).`
      : plan.winningSeats.length === 2
        ? `Hand #${hand.handNumber} was a split pot — a tie (${plan.showdown?.categoryNameBySeat[1] ?? "equal hands"}).`
        : `Seat ${plan.winningSeats[0]} won hand #${hand.handNumber} at showdown with ${plan.showdown?.categoryNameBySeat[plan.winningSeats[0]!] ?? "the stronger hand"}.`;

  const revealedHtml = ([1, 2] as const)
    .map((seat) => {
      const cards = showdownCards[seat];
      return cards && cards.length > 0 ? `<p class="meta">Seat ${seat}: ${renderCards(cards)}</p>` : "";
    })
    .join("");

  return `      <section class="panel">
        <p class="status-line">${escapeHtml(resultLine)}</p>
        ${revealedHtml}
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
          <button type="submit">${latestHand ? "Start next hand" : "Start hand"}</button>
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
        <button type="submit">Join table</button>
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
// port a real running instance might already hold.
if (import.meta.filename === process.argv[1]) {
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
}
