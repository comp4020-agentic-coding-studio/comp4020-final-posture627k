import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import {
  approveCurrentSettings,
  buildResourceBuilding,
  createCampaign,
  createIdentity,
  findIdentityByTokenHash,
  getCampaignByCode,
  getLobbyStatus,
  getWorldForCampaign,
  hashToken,
  joinCampaign,
  listCampaignsForIdentity,
  settleAndGetOwnCountryResources,
  setResourcePreset,
  startCampaign,
  type Campaign,
  type Participant,
  type ResourcePreset,
  type WorldState,
} from "./db.ts";

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
      table.world {
        border-collapse: collapse;
        table-layout: fixed;
        width: 100%;
        max-width: 640px;
        margin: 0.75rem 0;
      }
      @media (min-width: 640px) {
        table.world { width: min(70vw, 640px); }
      }
      table.world td {
        border: 1px solid #94a3b8;
        text-align: center;
        vertical-align: middle;
        font-size: 1rem;
        padding: 0;
        aspect-ratio: 1 / 1;
        background: #f8fafc;
      }
      table.world td.tile-hq { background: #fde68a; }
      table.world td.tile-resource { background: #bbf7d0; }
      table.world td.tile-owned-empty { background: #e0f2fe; }
      table.world td.tile-enemy { background: #fecaca; }
      table.world td.tile-mine { box-shadow: inset 0 0 0 3px #2563eb; font-weight: 700; }
      table.world .build-form { margin: 0; width: 100%; height: 100%; }
      table.world .build-form button {
        width: 100%;
        height: 100%;
        border: 0;
        border-radius: 0;
        background: transparent;
        font-size: 1.4rem;
        font-weight: 700;
        line-height: 1;
        color: #15803d;
        cursor: pointer;
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
  const identityId = c.get("identityId");
  const campaigns = listCampaignsForIdentity(identityId);

  const campaignList =
    campaigns.length === 0
      ? "<p>No campaigns yet.</p>"
      : `<ul>
${campaigns
  .map(
    (m) =>
      `        <li><a href="/c/${encodeURIComponent(m.code)}">${escapeHtml(m.code)}</a> — seat ${m.seat}${m.isHost ? ", host" : ""}</li>`,
  )
  .join("\n")}
      </ul>`;

  return c.html(
    pageShell(
      "Grid Strategy",
      `      <h1>Grid Strategy (working title)</h1>
      <p>This is the Crit 8 foundation: campaigns, anonymous identity,
      persistence, lobby settings, approval, match start, the fixed 8×8
      world, headquarters/resource-building construction, and server-side
      resource production all exist. Armies, combat and victory conditions
      are not implemented yet.</p>
      <p><a href="/readme/">About this project</a></p>

      <h2>Create campaign</h2>
      <form method="post" action="/campaigns">
        <button type="submit">Create campaign</button>
      </form>

      <h2>Your campaigns</h2>
      ${campaignList}`,
    ),
  );
});

app.post("/campaigns", (c) => {
  const identityId = c.get("identityId");
  const campaign = createCampaign(identityId);
  return c.redirect(`/c/${encodeURIComponent(campaign.code)}`, 303);
});

function notFoundPage(c: Context) {
  return c.html(pageShell("Campaign not found", "      <h1>Campaign not found</h1>"), 404);
}

const PRESET_LABELS: Record<ResourcePreset, string> = {
  standard: "Standard (10 resources / building / 10s interval)",
  rapid: "Rapid (20 resources / building / 10s interval)",
};

function renderSeatLine(seatNumber: 1 | 2, participant: Participant | undefined, approvedSeats: number[]): string {
  if (!participant) return `<p class="meta">Seat ${seatNumber}: open</p>`;
  const approved = approvedSeats.includes(seatNumber);
  const statusClass = approved ? "status-line" : "meta";
  return `<p class="${statusClass}">Seat ${seatNumber}: occupied${participant.isHost ? " (host)" : ""} — ${approved ? "approved" : "not approved"} current settings</p>`;
}

const WORLD_SIZE = 8;

// Renders the persisted world exactly as stored — no client-side
// interpretation of ownership, nothing calculated in the browser. Every
// cell carries visible text (not colour alone) identifying HQ/resource/
// country/neutral, for accessibility; the "mine" highlight is a visual-only
// extra. A build control is only ever rendered for an owned, empty tile
// belonging to selfSeat — authorization is still re-checked server-side by
// the route this form posts to, this is convenience only.
function renderWorldGrid(world: WorldState, selfSeat: number | undefined, campaignCode: string): string {
  const seatByCountryId = new Map<number, number>();
  for (const country of world.countries) seatByCountryId.set(country.id, country.seat);

  const tileByCoord = new Map<string, { ownerCountryId: number | null }>();
  for (const tile of world.tiles) tileByCoord.set(`${tile.row},${tile.col}`, tile);

  const buildingByCoord = new Map<string, { type: string; seat: number | undefined }>();
  for (const building of world.buildings) {
    buildingByCoord.set(`${building.row},${building.col}`, {
      type: building.type,
      seat: seatByCountryId.get(building.countryId),
    });
  }

  let rows = "";
  for (let row = 0; row < WORLD_SIZE; row++) {
    rows += "          <tr>\n";
    for (let col = 0; col < WORLD_SIZE; col++) {
      const key = `${row},${col}`;
      const tile = tileByCoord.get(key);
      const ownerSeat =
        tile?.ownerCountryId !== null && tile?.ownerCountryId !== undefined
          ? seatByCountryId.get(tile.ownerCountryId)
          : undefined;
      const building = buildingByCoord.get(key);

      let label: string;
      let description: string;
      if (building && building.seat !== undefined) {
        const kind = building.type === "headquarters" ? "HQ" : "R";
        const kindDescription = building.type === "headquarters" ? "headquarters" : "resource building";
        label = `${kind}${building.seat}`;
        description = `row ${row}, column ${col}: ${kindDescription}, country ${building.seat}`;
      } else if (ownerSeat !== undefined) {
        label = `C${ownerSeat}`;
        description = `row ${row}, column ${col}: owned by country ${ownerSeat}`;
      } else {
        label = "·";
        description = `row ${row}, column ${col}: neutral`;
      }

      const mine = ownerSeat !== undefined && ownerSeat === selfSeat;
      const buildable = mine && !building;

      // One of five categories, purely for background colour — the visible
      // label/aria-label/title above remain the authoritative, text-based
      // identification; colour is a supplementary cue only.
      let categoryClass: string;
      if (building?.type === "headquarters") categoryClass = "tile-hq";
      else if (building) categoryClass = "tile-resource";
      else if (mine) categoryClass = "tile-owned-empty";
      else if (ownerSeat !== undefined) categoryClass = "tile-enemy";
      else categoryClass = "";

      const cellContent = buildable
        ? `<form method="post" action="/c/${encodeURIComponent(campaignCode)}/build" class="build-form">
              <input type="hidden" name="row" value="${row}" />
              <input type="hidden" name="col" value="${col}" />
              <button type="submit" aria-label="Build resource building at row ${row}, column ${col}" title="Build resource building">+</button>
            </form>`
        : escapeHtml(label);

      const classes = ["tile", categoryClass, mine ? "tile-mine" : ""].filter(Boolean).join(" ");
      rows += `            <td class="${classes}" aria-label="${escapeHtml(description)}" title="${escapeHtml(description)}">${cellContent}</td>\n`;
    }
    rows += "          </tr>\n";
  }

  return `      <table class="world">
        <caption>Match world (8×8)</caption>
        <tbody>
${rows}        </tbody>
      </table>`;
}

function renderCampaignPage(c: Context, campaign: Campaign): Response {
  const identityId = c.get("identityId");
  const { participants, approvedSeats, ready } = getLobbyStatus(campaign);
  const self = participants.find((p) => p.identityId === identityId);
  const seat1 = participants.find((p) => p.seat === 1);
  const seat2 = participants.find((p) => p.seat === 2);
  const shareUrl = new URL(`/c/${encodeURIComponent(campaign.code)}`, c.req.url).toString();
  const presetLabel = PRESET_LABELS[campaign.resourcePreset];
  const started = campaign.status === "started";

  let body: string;

  if (started) {
    const selfLine = self
      ? `<p class="status-line">You are seat ${self.seat}${self.isHost ? " (configuration-role host)" : ""}.</p>`
      : "<p>You are not a participant.</p>";

    // Settlement only ever runs for the viewer's own country, and only when
    // they actually are a participant — a non-participant never triggers or
    // sees anyone's balance here.
    const resourcesLine = self
      ? (() => {
          const settlement = settleAndGetOwnCountryResources(campaign.id, identityId);
          return settlement.ok
            ? `<p class="status-line">Resources: ${settlement.balance}</p>
      <p class="meta">Resource buildings produce every 10 seconds.</p>`
            : "";
        })()
      : "";

    const world = getWorldForCampaign(campaign.id);
    const gridHtml = renderWorldGrid(world, self?.seat, campaign.code);

    body = `      <header class="panel">
        <h1>Campaign ${escapeHtml(campaign.code)}</h1>
        <p class="status-line">Status: started.</p>
        ${selfLine}
      </header>

      <section class="panel">
        <h2>Match</h2>
        ${resourcesLine}
        <p>Resource-production preset (locked): ${escapeHtml(presetLabel)}</p>
        <p class="meta">Settings are locked and cannot change after start.</p>
        <p class="meta">Seat 1: ${seat1 ? `occupied${seat1.isHost ? " (host)" : ""}` : "open"}</p>
        <p class="meta">Seat 2: ${seat2 ? `occupied${seat2.isHost ? " (host)" : ""}` : "open"}</p>
      </section>

      <section class="panel">
        <h2>World</h2>
${gridHtml}
      </section>`;
  } else {
    const selfSection = self
      ? `<p class="status-line">You are seat ${self.seat}${self.isHost ? " (configuration-role host)" : ""}.</p>`
      : seat2
        ? "<p>This campaign is full. You are not a participant.</p>"
        : `      <form method="post" action="/c/${encodeURIComponent(campaign.code)}/join">
        <button type="submit">Join campaign</button>
      </form>`;

    const approveControls = self
      ? approvedSeats.includes(self.seat)
        ? `<p class="meta">You have approved settings revision ${campaign.settingsRevision}.</p>`
        : `      <form method="post" action="/c/${encodeURIComponent(campaign.code)}/approve">
        <button type="submit">Approve current settings</button>
      </form>`
      : "";

    const settingsControls = self?.isHost
      ? `      <form method="post" action="/c/${encodeURIComponent(campaign.code)}/settings">
        <label>
          <input type="radio" name="preset" value="standard" ${campaign.resourcePreset === "standard" ? "checked" : ""} />
          ${escapeHtml(PRESET_LABELS.standard)}
        </label><br />
        <label>
          <input type="radio" name="preset" value="rapid" ${campaign.resourcePreset === "rapid" ? "checked" : ""} />
          ${escapeHtml(PRESET_LABELS.rapid)}
        </label><br />
        <button type="submit">Update setting</button>
      </form>`
      : "";

    const startControls = self?.isHost
      ? ready
        ? `<form method="post" action="/c/${encodeURIComponent(campaign.code)}/start">
        <button type="submit">Start match</button>
      </form>`
        : "<p class=\"meta\">Not ready: both seats must be filled and both participants must approve the current settings.</p>"
      : "";

    body = `      <header class="panel">
        <h1>Campaign ${escapeHtml(campaign.code)}</h1>
        <p class="status-line">Status: pre-start (configuring).</p>
        ${selfSection}
        <p class="meta">Other players' changes appear after you refresh this page.</p>
      </header>

      <section class="panel invite">
        <strong>Invite link</strong> — send this to Player 2:
        <code>${escapeHtml(shareUrl)}</code>
      </section>

      <section class="panel">
        <h2>Players</h2>
        ${renderSeatLine(1, seat1, approvedSeats)}
        ${renderSeatLine(2, seat2, approvedSeats)}
      </section>

      <section class="panel">
        <h2>Match settings</h2>
        <p>Resource-production preset: ${escapeHtml(presetLabel)}</p>
        <p class="meta">Settings revision: ${campaign.settingsRevision}</p>
        ${settingsControls}
      </section>

      <section class="panel">
        <h2>Approval</h2>
        <p class="status-line">Ready to start: ${ready ? "yes" : "no"}</p>
        ${approveControls}
        ${startControls}
      </section>`;
  }

  return c.html(pageShell(`Campaign ${campaign.code}`, body));
}

app.get("/c/:code", (c) => {
  const campaign = getCampaignByCode(c.req.param("code"));
  if (!campaign) return notFoundPage(c);
  return renderCampaignPage(c, campaign);
});

app.post("/c/:code/join", (c) => {
  const campaign = getCampaignByCode(c.req.param("code"));
  if (!campaign) return notFoundPage(c);

  const identityId = c.get("identityId");
  const result = joinCampaign(campaign.id, identityId);

  if (!result.ok) {
    return c.html(
      pageShell(
        "Campaign full",
        `      <h1>This campaign is already full</h1>
      <p><a href="/c/${encodeURIComponent(campaign.code)}">Back to the campaign</a></p>`,
      ),
      409,
    );
  }

  return c.redirect(`/c/${encodeURIComponent(campaign.code)}`, 303);
});

app.post("/c/:code/settings", async (c) => {
  const campaign = getCampaignByCode(c.req.param("code"));
  if (!campaign) return notFoundPage(c);

  const body = await c.req.parseBody();
  const submitted = body["preset"];
  const preset: ResourcePreset | undefined =
    submitted === "standard" || submitted === "rapid" ? submitted : undefined;

  if (!preset) {
    return c.html(
      pageShell("Invalid setting", "      <h1>Invalid resource-production preset</h1>"),
      400,
    );
  }

  const identityId = c.get("identityId");
  const result = setResourcePreset(campaign.id, identityId, preset);

  if (!result.ok) {
    const [message, status] =
      result.reason === "not_host"
        ? (["Only the host can change settings.", 403] as const)
        : (["Settings cannot change after the match has started.", 409] as const);
    return c.html(pageShell("Cannot change settings", `      <h1>${escapeHtml(message)}</h1>`), status);
  }

  return c.redirect(`/c/${encodeURIComponent(campaign.code)}`, 303);
});

app.post("/c/:code/approve", (c) => {
  const campaign = getCampaignByCode(c.req.param("code"));
  if (!campaign) return notFoundPage(c);

  const identityId = c.get("identityId");
  const result = approveCurrentSettings(campaign.id, identityId);

  if (!result.ok) {
    const [message, status] =
      result.reason === "not_participant"
        ? (["Only a participant in this campaign can approve.", 403] as const)
        : (["Approval is only possible before the match starts.", 409] as const);
    return c.html(pageShell("Cannot approve", `      <h1>${escapeHtml(message)}</h1>`), status);
  }

  return c.redirect(`/c/${encodeURIComponent(campaign.code)}`, 303);
});

app.post("/c/:code/start", (c) => {
  const campaign = getCampaignByCode(c.req.param("code"));
  if (!campaign) return notFoundPage(c);

  const identityId = c.get("identityId");
  const result = startCampaign(campaign.id, identityId);

  if (!result.ok) {
    const [message, status] =
      result.reason === "not_host"
        ? (["Only the host can start the match.", 403] as const)
        : result.reason === "already_started"
          ? (["This match has already started.", 409] as const)
          : ([
              "The match cannot start yet: both seats must be filled and both participants must approve the current settings.",
              409,
            ] as const);
    return c.html(pageShell("Cannot start", `      <h1>${escapeHtml(message)}</h1>`), status);
  }

  return c.redirect(`/c/${encodeURIComponent(campaign.code)}`, 303);
});

app.post("/c/:code/build", async (c) => {
  const campaign = getCampaignByCode(c.req.param("code"));
  if (!campaign) return notFoundPage(c);

  const body = await c.req.parseBody();
  const row = Number(body["row"]);
  const col = Number(body["col"]);

  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    return c.html(pageShell("Invalid tile", "      <h1>Invalid tile coordinate</h1>"), 400);
  }

  const identityId = c.get("identityId");
  const result = buildResourceBuilding(campaign.id, identityId, row, col);

  if (!result.ok) {
    const [message, status] =
      result.reason === "not_started"
        ? (["Construction is only possible after the match has started.", 409] as const)
        : result.reason === "not_participant"
          ? (["Only a participant in this campaign can construct.", 403] as const)
          : result.reason === "invalid_coordinate"
            ? (["That tile is outside the 8×8 world.", 400] as const)
            : result.reason === "not_owned"
              ? (["You can only build on an empty tile your own country owns.", 403] as const)
              : (["That tile already has a building.", 409] as const);
    return c.html(pageShell("Cannot build", `      <h1>${escapeHtml(message)}</h1>`), status);
  }

  return c.redirect(`/c/${encodeURIComponent(campaign.code)}`, 303);
});

app.get("/readme/", (c) => {
  const readme = readFileSync(readmePath, "utf8");
  return c.html(
    pageShell("About", `      <h1>About</h1>\n      <pre>${escapeHtml(readme)}</pre>`),
  );
});

const port = Number(process.env.PORT) || 8080;

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
