import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import {
  createIdentity,
  createPokerTable,
  findIdentityByTokenHash,
  getPokerTableByCode,
  getSeatForIdentity,
  getSeatsForTable,
  hashToken,
  joinPokerTable,
  type PokerSeat,
  type PokerTable,
} from "./db.ts";
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
      input[type="text"] {
        font: inherit;
        padding: 0.4rem 0.6rem;
        border: 1px solid #cbd5e1;
        border-radius: 0.375rem;
        margin-top: 0.25rem;
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
      <p>This is an early foundation slice: creating and joining a table,
      seating, and each player's chip stack. Dealing cards, betting and
      hands are not implemented yet.</p>
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

// Computes the dynamic table HTML for the current requester's identity. This
// is the one shared rendering seam the realtime refresh needs: GET /t/:code
// wraps its result in the full page shell plus the realtime wrapper/script,
// and GET /t/:code/live (below) returns exactly the same string as a bare
// fragment. There is no separate copy of this rendering logic anywhere else.
//
// Deliberately shows no cards, no betting actions and no hand state: none of
// that exists yet in this foundation slice, and CLAUDE.md's rule against
// implying unimplemented behaviour applies here same as everywhere else.
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
      ? `<p class="status-line">Both seats are filled.</p>
      <p class="meta">Hand play is not implemented yet in this foundation slice.</p>`
      : `<p class="status-line">Waiting for a second player.</p>`;

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
      </section>`;
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

// SSE transport, reused unchanged in mechanism from the strategy-war
// product: participant-gated (403/404 before the stream opens), a single
// content-free "table_changed" event, and a 20s heartbeat so intermediate
// proxies don't treat an otherwise-quiet connection as dead.
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
