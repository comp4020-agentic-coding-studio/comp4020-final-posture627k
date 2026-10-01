import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import {
  createCampaign,
  createIdentity,
  findIdentityByTokenHash,
  getCampaignByCode,
  getParticipantsForCampaign,
  hashToken,
  joinCampaign,
  listCampaignsForIdentity,
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
      <p>This is the Crit 8 foundation: campaigns, anonymous identity and
      persistence exist. Lobby settings, approvals, the grid, buildings and
      resources are not implemented yet.</p>
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

app.get("/c/:code", (c) => {
  const code = c.req.param("code");
  const campaign = getCampaignByCode(code);
  if (!campaign) {
    return c.html(pageShell("Campaign not found", "      <h1>Campaign not found</h1>"), 404);
  }

  const identityId = c.get("identityId");
  const participants = getParticipantsForCampaign(campaign.id);
  const self = participants.find((p) => p.identityId === identityId);
  const seat1 = participants.find((p) => p.seat === 1);
  const seat2 = participants.find((p) => p.seat === 2);
  const shareUrl = new URL(`/c/${encodeURIComponent(campaign.code)}`, c.req.url).toString();

  const selfSection = self
    ? `<p>You are seat ${self.seat}${self.isHost ? " (configuration-role host)" : ""}.</p>`
    : seat2
      ? "<p>This campaign is full. You are not a participant.</p>"
      : `      <form method="post" action="/c/${encodeURIComponent(campaign.code)}/join">
        <button type="submit">Join campaign</button>
      </form>`;

  return c.html(
    pageShell(
      `Campaign ${campaign.code}`,
      `      <h1>Campaign ${escapeHtml(campaign.code)}</h1>
      <p>Status: pre-start / foundation state.</p>
      <p>Shareable URL: <code>${escapeHtml(shareUrl)}</code></p>
      <p>Seat 1: ${seat1 ? "occupied" : "open"}</p>
      <p>Seat 2: ${seat2 ? "occupied" : "open"}</p>
      ${selfSection}`,
    ),
  );
});

app.post("/c/:code/join", (c) => {
  const code = c.req.param("code");
  const campaign = getCampaignByCode(code);
  if (!campaign) {
    return c.html(pageShell("Campaign not found", "      <h1>Campaign not found</h1>"), 404);
  }

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

app.get("/readme/", (c) => {
  const readme = readFileSync(readmePath, "utf8");
  return c.html(
    pageShell("About", `      <h1>About</h1>\n      <pre>${escapeHtml(readme)}</pre>`),
  );
});

const port = Number(process.env.PORT) || 8080;

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
