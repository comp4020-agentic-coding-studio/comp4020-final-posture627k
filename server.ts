import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import {
  approveCurrentSettings,
  createCampaign,
  createIdentity,
  findIdentityByTokenHash,
  getCampaignByCode,
  getLobbyStatus,
  getWorldForCampaign,
  hashToken,
  joinCampaign,
  listCampaignsForIdentity,
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
      table.world { border-collapse: collapse; width: 100%; max-width: 22rem; margin: 0.5rem 0; }
      table.world td { border: 1px solid #999; text-align: center; vertical-align: middle;
        font-size: 0.7rem; padding: 0; aspect-ratio: 1 / 1; }
      table.world td.tile-mine { background: #dbeafe; font-weight: bold; }
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
      persistence, lobby settings, approval and match start exist. The grid,
      buildings and resources are not implemented yet.</p>
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
  if (!participant) return `<p>Seat ${seatNumber}: open</p>`;
  const approved = approvedSeats.includes(seatNumber);
  return `<p>Seat ${seatNumber}: occupied${participant.isHost ? " (host)" : ""} — ${approved ? "approved" : "not approved"} current settings</p>`;
}

const WORLD_SIZE = 8;

// Renders the persisted world exactly as stored — no client-side
// interpretation of ownership, nothing calculated in the browser. Every
// cell carries visible text (not colour alone) identifying HQ/country/
// neutral, for accessibility; the "mine" highlight is a visual-only extra.
function renderWorldGrid(world: WorldState, selfSeat: number | undefined): string {
  const seatByCountryId = new Map<number, number>();
  for (const country of world.countries) seatByCountryId.set(country.id, country.seat);

  const tileByCoord = new Map<string, { ownerCountryId: number | null }>();
  for (const tile of world.tiles) tileByCoord.set(`${tile.row},${tile.col}`, tile);

  const hqSeatByCoord = new Map<string, number>();
  for (const building of world.buildings) {
    if (building.type === "headquarters") {
      const seat = seatByCountryId.get(building.countryId);
      if (seat !== undefined) hqSeatByCoord.set(`${building.row},${building.col}`, seat);
    }
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
      const isHq = hqSeatByCoord.has(key);

      let label: string;
      let description: string;
      if (isHq && ownerSeat !== undefined) {
        label = `HQ${ownerSeat}`;
        description = `row ${row}, column ${col}: headquarters, country ${ownerSeat}`;
      } else if (ownerSeat !== undefined) {
        label = `C${ownerSeat}`;
        description = `row ${row}, column ${col}: owned by country ${ownerSeat}`;
      } else {
        label = "·";
        description = `row ${row}, column ${col}: neutral`;
      }

      const mine = ownerSeat !== undefined && ownerSeat === selfSeat;
      rows += `            <td class="tile${mine ? " tile-mine" : ""}" aria-label="${escapeHtml(description)}" title="${escapeHtml(description)}">${escapeHtml(label)}</td>\n`;
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
      ? `<p>You are seat ${self.seat}${self.isHost ? " (configuration-role host)" : ""}.</p>`
      : "<p>You are not a participant.</p>";

    const world = getWorldForCampaign(campaign.id);
    const gridHtml = renderWorldGrid(world, self?.seat);

    body = `      <h1>Campaign ${escapeHtml(campaign.code)}</h1>
      <p>Status: started.</p>
      <p>Resource-production preset (locked): ${escapeHtml(presetLabel)}</p>
      <p>Settings are locked and cannot change after start.</p>
      <p>Seat 1: ${seat1 ? `occupied${seat1.isHost ? " (host)" : ""}` : "open"}</p>
      <p>Seat 2: ${seat2 ? `occupied${seat2.isHost ? " (host)" : ""}` : "open"}</p>
      ${selfLine}
${gridHtml}`;
  } else {
    const selfSection = self
      ? `<p>You are seat ${self.seat}${self.isHost ? " (configuration-role host)" : ""}.</p>`
      : seat2
        ? "<p>This campaign is full. You are not a participant.</p>"
        : `      <form method="post" action="/c/${encodeURIComponent(campaign.code)}/join">
        <button type="submit">Join campaign</button>
      </form>`;

    const approveControls = self
      ? approvedSeats.includes(self.seat)
        ? `<p>You have approved settings revision ${campaign.settingsRevision}.</p>`
        : `      <form method="post" action="/c/${encodeURIComponent(campaign.code)}/approve">
        <button type="submit">Approve current settings</button>
      </form>`
      : "";

    const hostControls = self?.isHost
      ? `      <h2>Host: resource-production preset</h2>
      <form method="post" action="/c/${encodeURIComponent(campaign.code)}/settings">
        <label>
          <input type="radio" name="preset" value="standard" ${campaign.resourcePreset === "standard" ? "checked" : ""} />
          ${escapeHtml(PRESET_LABELS.standard)}
        </label><br />
        <label>
          <input type="radio" name="preset" value="rapid" ${campaign.resourcePreset === "rapid" ? "checked" : ""} />
          ${escapeHtml(PRESET_LABELS.rapid)}
        </label><br />
        <button type="submit">Update setting</button>
      </form>

      <h2>Host: start match</h2>
      ${
        ready
          ? `<form method="post" action="/c/${encodeURIComponent(campaign.code)}/start">
        <button type="submit">Start match</button>
      </form>`
          : "<p>Not ready: both seats must be filled and both participants must approve the current settings.</p>"
      }`
      : "";

    body = `      <h1>Campaign ${escapeHtml(campaign.code)}</h1>
      <p>Status: pre-start (configuring).</p>
      <p>Shareable URL: <code>${escapeHtml(shareUrl)}</code></p>
      <p>Resource-production preset: ${escapeHtml(presetLabel)}</p>
      <p>Settings revision: ${campaign.settingsRevision}</p>
      ${renderSeatLine(1, seat1, approvedSeats)}
      ${renderSeatLine(2, seat2, approvedSeats)}
      <p>Ready to start: ${ready ? "yes" : "no"}</p>
      ${selfSection}
      ${approveControls}
      ${hostControls}`;
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

app.get("/readme/", (c) => {
  const readme = readFileSync(readmePath, "utf8");
  return c.html(
    pageShell("About", `      <h1>About</h1>\n      <pre>${escapeHtml(readme)}</pre>`),
  );
});

const port = Number(process.env.PORT) || 8080;

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
