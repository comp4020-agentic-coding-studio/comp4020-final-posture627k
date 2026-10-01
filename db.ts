import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Schema version for this file, tracked via SQLite's own PRAGMA user_version.
// A fresh/empty data directory starts at 0; this module brings it to
// SCHEMA_VERSION, migrating an existing older database in place rather than
// recreating it. A database from a newer, unknown version fails loudly
// instead of being silently reinterpreted.
const SCHEMA_VERSION = 3;

// The fixed Crit 8 world layout. Defined here, ahead of the schema/migration
// code below, because the v2 -> v3 migration can call generateWorld() (to
// backfill already-started campaigns) while the module is still executing
// top-to-bottom — a `const` isn't usable before its own initializer has run,
// even inside a hoisted function, so this can't live further down the file
// near generateWorld's definition without hitting that temporal-dead-zone
// error the moment a backfill is actually needed.
const WORLD_SIZE = 8;

interface StartingZone {
  seat: 1 | 2;
  tiles: readonly (readonly [number, number])[];
  headquarters: readonly [number, number];
}

const STARTING_ZONES: readonly StartingZone[] = [
  {
    seat: 1,
    tiles: [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ],
    headquarters: [0, 0],
  },
  {
    seat: 2,
    tiles: [
      [6, 6],
      [6, 7],
      [7, 6],
      [7, 7],
    ],
    headquarters: [7, 7],
  },
];

// The container/Fly deployment sets DATA_DIR=/data (the mounted volume).
// Locally, without DATA_DIR set, fall back to a repo-local directory so
// `pnpm check`/dev usage doesn't need any extra setup. This directory is
// gitignored, not committed.
const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, ".data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "app.sqlite"), {
  enableForeignKeyConstraints: true,
  timeout: 5000,
});

db.exec("PRAGMA journal_mode = WAL");

const { user_version: currentVersion } = db.prepare("PRAGMA user_version").get() as {
  user_version: number;
};

if (currentVersion > SCHEMA_VERSION) {
  throw new Error(
    `database schema version ${currentVersion} is newer than this build supports (expected at most ${SCHEMA_VERSION}); refusing to run against it`,
  );
}

// Version 1 base shape. Safe to (re)apply against any existing version,
// fresh (0) included, since every statement is a no-op if already applied.
db.exec(`
  CREATE TABLE IF NOT EXISTS identities (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'configuring',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    identity_id INTEGER NOT NULL REFERENCES identities(id),
    seat INTEGER NOT NULL CHECK (seat IN (1, 2)),
    is_host INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (campaign_id, seat),
    UNIQUE (campaign_id, identity_id)
  );
`);

// Migration: schema version 1 -> 2 (lobby settings, revision and approvals).
// Only runs once per database file: it only touches a database still below
// version 2, and SCHEMA_VERSION is persisted via PRAGMA user_version right
// after this block, so a database already at 2 never re-enters it. Existing
// `campaigns` rows get the defaulted preset/revision below (SQLite requires
// a non-null default for a NOT NULL column added via ALTER TABLE, which is
// exactly what makes this an additive, data-preserving migration rather
// than a table recreation).
if (currentVersion < 2) {
  db.exec("ALTER TABLE campaigns ADD COLUMN resource_preset TEXT NOT NULL DEFAULT 'standard'");
  db.exec("ALTER TABLE campaigns ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 1");
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY,
      participant_id INTEGER NOT NULL REFERENCES participants(id),
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (participant_id, revision)
    );
  `);
}

// Migration: schema version 2 -> 3 (fixed 8x8 world: countries, tiles,
// headquarters). Same once-only guard as the v1 -> v2 block above.
//
// A v2 database can already contain a `started` campaign, since Slice 3
// could start a campaign before these tables existed. Such a campaign is
// backfilled with the same deterministic world it would have received had
// it started under this schema — without touching its identities,
// participants, host role, preset, revision, approvals, or its own
// created_at/status. A `configuring` v2 campaign is left alone here; it
// gets a world only if and when it later actually starts.
if (currentVersion < 3) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS countries (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      seat INTEGER NOT NULL CHECK (seat IN (1, 2)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (campaign_id, seat)
    );

    CREATE TABLE IF NOT EXISTS tiles (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      row INTEGER NOT NULL CHECK (row BETWEEN 0 AND 7),
      col INTEGER NOT NULL CHECK (col BETWEEN 0 AND 7),
      owner_country_id INTEGER REFERENCES countries(id),
      UNIQUE (campaign_id, row, col)
    );

    CREATE TABLE IF NOT EXISTS buildings (
      id INTEGER PRIMARY KEY,
      tile_id INTEGER NOT NULL UNIQUE REFERENCES tiles(id),
      country_id INTEGER NOT NULL REFERENCES countries(id),
      type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_headquarters_per_country
      ON buildings(country_id)
      WHERE type = 'headquarters';
  `);

  const alreadyStarted = db.prepare("SELECT id FROM campaigns WHERE status = 'started'").all() as {
    id: number;
  }[];
  for (const { id } of alreadyStarted) {
    db.exec("BEGIN IMMEDIATE");
    try {
      generateWorld(id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface Identity {
  id: number;
}

export function createIdentity(tokenHash: string): Identity {
  const info = db.prepare("INSERT INTO identities (token_hash) VALUES (?)").run(tokenHash);
  return { id: Number(info.lastInsertRowid) };
}

export function findIdentityByTokenHash(tokenHash: string): Identity | undefined {
  const row = db.prepare("SELECT id FROM identities WHERE token_hash = ?").get(tokenHash) as
    | { id: number }
    | undefined;
  return row ? { id: row.id } : undefined;
}

export type ResourcePreset = "standard" | "rapid";
const DEFAULT_RESOURCE_PRESET: ResourcePreset = "standard";
const INITIAL_SETTINGS_REVISION = 1;

export interface Campaign {
  id: number;
  code: string;
  status: string;
  resourcePreset: ResourcePreset;
  settingsRevision: number;
}

export interface Participant {
  campaignId: number;
  identityId: number;
  seat: number;
  isHost: boolean;
}

// Avoids 0/O/1/I/L, which are easy to misread or mistype when a code is
// shared out loud or copied by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

function generateCampaignCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return code === "ERR_SQLITE_ERROR" && err.message.includes("UNIQUE constraint failed");
}

// Creates the campaign and binds the creator to seat 1 as host atomically.
// The campaign code is generated randomly (not derived from the primary
// key) and retried on the (astronomically unlikely) chance of a collision.
export function createCampaign(hostIdentityId: number): Campaign {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateCampaignCode();
    db.exec("BEGIN IMMEDIATE");
    try {
      const info = db.prepare("INSERT INTO campaigns (code) VALUES (?)").run(code);
      const campaignId = Number(info.lastInsertRowid);
      db.prepare(
        "INSERT INTO participants (campaign_id, identity_id, seat, is_host) VALUES (?, ?, 1, 1)",
      ).run(campaignId, hostIdentityId);
      db.exec("COMMIT");
      return {
        id: campaignId,
        code,
        status: "configuring",
        resourcePreset: DEFAULT_RESOURCE_PRESET,
        settingsRevision: INITIAL_SETTINGS_REVISION,
      };
    } catch (err) {
      db.exec("ROLLBACK");
      if (isUniqueConstraintViolation(err)) continue;
      throw err;
    }
  }
  throw new Error("failed to generate a unique campaign code");
}

function toCampaign(row: {
  id: number;
  code: string;
  status: string;
  resource_preset: string;
  settings_revision: number;
}): Campaign {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    resourcePreset: row.resource_preset as ResourcePreset,
    settingsRevision: row.settings_revision,
  };
}

export function getCampaignByCode(code: string): Campaign | undefined {
  const row = db
    .prepare(
      "SELECT id, code, status, resource_preset, settings_revision FROM campaigns WHERE code = ?",
    )
    .get(code) as
    | { id: number; code: string; status: string; resource_preset: string; settings_revision: number }
    | undefined;
  return row ? toCampaign(row) : undefined;
}

export function getParticipantsForCampaign(campaignId: number): Participant[] {
  const rows = db
    .prepare(
      `SELECT campaign_id, identity_id, seat, is_host
       FROM participants WHERE campaign_id = ? ORDER BY seat`,
    )
    .all(campaignId) as {
    campaign_id: number;
    identity_id: number;
    seat: number;
    is_host: number;
  }[];
  return rows.map((r) => ({
    campaignId: r.campaign_id,
    identityId: r.identity_id,
    seat: r.seat,
    isHost: r.is_host === 1,
  }));
}

export function getParticipantForIdentity(
  campaignId: number,
  identityId: number,
): Participant | undefined {
  const row = db
    .prepare(
      `SELECT campaign_id, identity_id, seat, is_host
       FROM participants WHERE campaign_id = ? AND identity_id = ?`,
    )
    .get(campaignId, identityId) as
    | { campaign_id: number; identity_id: number; seat: number; is_host: number }
    | undefined;
  if (!row) return undefined;
  return {
    campaignId: row.campaign_id,
    identityId: row.identity_id,
    seat: row.seat,
    isHost: row.is_host === 1,
  };
}

export type JoinResult =
  | { ok: true; alreadyJoined: boolean; seat: number }
  | { ok: false; reason: "full" };

// The only open seat for Crit 8's fixed 1v1 shape is seat 2. Concurrency
// safety comes from the UNIQUE(campaign_id, seat) constraint, not from the
// pre-check below: two concurrent joins can both pass the pre-check, but
// only one INSERT can win, and the loser's constraint violation is what
// this function treats as "full" (not corrupted state).
export function joinCampaign(campaignId: number, identityId: number): JoinResult {
  const existing = getParticipantForIdentity(campaignId, identityId);
  if (existing) {
    return { ok: true, alreadyJoined: true, seat: existing.seat };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO participants (campaign_id, identity_id, seat, is_host) VALUES (?, ?, 2, 0)",
    ).run(campaignId, identityId);
    db.exec("COMMIT");
    return { ok: true, alreadyJoined: false, seat: 2 };
  } catch (err) {
    db.exec("ROLLBACK");
    if (isUniqueConstraintViolation(err)) {
      return { ok: false, reason: "full" };
    }
    throw err;
  }
}

export interface CampaignMembership extends Campaign {
  seat: number;
  isHost: boolean;
}

export function listCampaignsForIdentity(identityId: number): CampaignMembership[] {
  const rows = db
    .prepare(
      `SELECT c.id AS id, c.code AS code, c.status AS status,
              c.resource_preset AS resource_preset, c.settings_revision AS settings_revision,
              p.seat AS seat, p.is_host AS is_host
       FROM campaigns c
       JOIN participants p ON p.campaign_id = c.id
       WHERE p.identity_id = ?
       ORDER BY c.created_at DESC`,
    )
    .all(identityId) as {
    id: number;
    code: string;
    status: string;
    resource_preset: string;
    settings_revision: number;
    seat: number;
    is_host: number;
  }[];
  return rows.map((r) => ({
    ...toCampaign(r),
    seat: r.seat,
    isHost: r.is_host === 1,
  }));
}

// --- Slice 3: lobby settings, approvals, start ------------------------------

export type SetPresetResult =
  | { ok: true; changed: boolean; revision: number }
  | { ok: false; reason: "not_host" | "not_pre_start" };

// Only the host may change the setting, and only pre-start. Submitting the
// preset that's already active is a no-op: it doesn't advance the revision
// or touch existing approvals, so a host re-submitting the same choice
// doesn't gratuitously invalidate anyone's approval.
export function setResourcePreset(
  campaignId: number,
  identityId: number,
  preset: ResourcePreset,
): SetPresetResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const participant = db
      .prepare("SELECT is_host FROM participants WHERE campaign_id = ? AND identity_id = ?")
      .get(campaignId, identityId) as { is_host: number } | undefined;

    if (!participant || participant.is_host !== 1) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_host" };
    }

    const campaign = db
      .prepare("SELECT status, resource_preset, settings_revision FROM campaigns WHERE id = ?")
      .get(campaignId) as
      | { status: string; resource_preset: string; settings_revision: number }
      | undefined;

    if (!campaign || campaign.status !== "configuring") {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_pre_start" };
    }

    if (campaign.resource_preset === preset) {
      db.exec("COMMIT");
      return { ok: true, changed: false, revision: campaign.settings_revision };
    }

    const revision = campaign.settings_revision + 1;
    db.prepare("UPDATE campaigns SET resource_preset = ?, settings_revision = ? WHERE id = ?").run(
      preset,
      revision,
      campaignId,
    );
    db.exec("COMMIT");
    return { ok: true, changed: true, revision };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type ApproveResult =
  | { ok: true; revision: number }
  | { ok: false; reason: "not_participant" | "not_pre_start" };

// Approving is scoped to "the current revision", read fresh inside this same
// transaction — never a revision number supplied by the client. Approval
// rows for past revisions are kept (not deleted) but are simply never
// selected by anything that only looks at the current revision.
export function approveCurrentSettings(campaignId: number, identityId: number): ApproveResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const participant = db
      .prepare("SELECT id FROM participants WHERE campaign_id = ? AND identity_id = ?")
      .get(campaignId, identityId) as { id: number } | undefined;

    if (!participant) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_participant" };
    }

    const campaign = db
      .prepare("SELECT status, settings_revision FROM campaigns WHERE id = ?")
      .get(campaignId) as { status: string; settings_revision: number } | undefined;

    if (!campaign || campaign.status !== "configuring") {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_pre_start" };
    }

    db.prepare(
      "INSERT INTO approvals (participant_id, revision) VALUES (?, ?) ON CONFLICT (participant_id, revision) DO NOTHING",
    ).run(participant.id, campaign.settings_revision);

    db.exec("COMMIT");
    return { ok: true, revision: campaign.settings_revision };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface LobbyStatus {
  participants: Participant[];
  approvedSeats: number[];
  ready: boolean;
}

// Readiness is never stored: every call recomputes it from the participants
// and approvals that exist right now, against the campaign's current
// revision passed in by the caller (always freshly read, never cached).
export function getLobbyStatus(campaign: Campaign): LobbyStatus {
  const participants = getParticipantsForCampaign(campaign.id);
  const approvalRows = db
    .prepare(
      `SELECT p.seat AS seat FROM approvals a
       JOIN participants p ON p.id = a.participant_id
       WHERE p.campaign_id = ? AND a.revision = ?`,
    )
    .all(campaign.id, campaign.settingsRevision) as { seat: number }[];
  const approvedSeats = approvalRows.map((r) => r.seat);

  const hasSeat1 = participants.some((p) => p.seat === 1);
  const hasSeat2 = participants.some((p) => p.seat === 2);
  const ready =
    campaign.status === "configuring" &&
    hasSeat1 &&
    hasSeat2 &&
    approvedSeats.includes(1) &&
    approvedSeats.includes(2);

  return { participants, approvedSeats, ready };
}

export type StartResult =
  | { ok: true }
  | { ok: false; reason: "not_host" | "already_started" | "not_ready" };

// Every precondition is re-read inside this one transaction, including the
// settings revision approvals are checked against — so a settings change or
// a second start request racing this one can't produce a start based on
// stale data. The UPDATE's own WHERE clause is a second, redundant guard
// against a double transition.
export function startCampaign(campaignId: number, identityId: number): StartResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const participant = db
      .prepare("SELECT is_host FROM participants WHERE campaign_id = ? AND identity_id = ?")
      .get(campaignId, identityId) as { is_host: number } | undefined;

    if (!participant || participant.is_host !== 1) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_host" };
    }

    const campaign = db
      .prepare("SELECT status, settings_revision FROM campaigns WHERE id = ?")
      .get(campaignId) as { status: string; settings_revision: number } | undefined;

    if (!campaign || campaign.status !== "configuring") {
      db.exec("ROLLBACK");
      return { ok: false, reason: "already_started" };
    }

    const seatRows = db.prepare("SELECT seat FROM participants WHERE campaign_id = ?").all(
      campaignId,
    ) as { seat: number }[];
    const seats = new Set(seatRows.map((r) => r.seat));

    const approvalRows = db
      .prepare(
        `SELECT p.seat AS seat FROM approvals a
         JOIN participants p ON p.id = a.participant_id
         WHERE p.campaign_id = ? AND a.revision = ?`,
      )
      .all(campaignId, campaign.settings_revision) as { seat: number }[];
    const approvedSeats = new Set(approvalRows.map((r) => r.seat));

    if (!seats.has(1) || !seats.has(2) || !approvedSeats.has(1) || !approvedSeats.has(2)) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_ready" };
    }

    generateWorld(campaignId);

    db.prepare("UPDATE campaigns SET status = 'started' WHERE id = ? AND status = 'configuring'").run(
      campaignId,
    );
    db.exec("COMMIT");
    return { ok: true };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// --- Slice 4: fixed world, countries, tiles, headquarters -------------------
// (WORLD_SIZE and STARTING_ZONES are defined near the top of this file,
// ahead of the schema/migration code that can call generateWorld() early.)

// Called only from inside an already-open BEGIN IMMEDIATE transaction —
// either startCampaign's own transaction, or the v2 -> v3 migration's
// per-campaign backfill transaction. It never opens or closes a transaction
// itself. A `function` declaration (not a const arrow function) so it's
// hoisted and callable from the migration code above, which runs earlier in
// this file's top-level execution than this definition appears.
function generateWorld(campaignId: number): void {
  const countryIdBySeat = new Map<number, number>();
  const insertCountry = db.prepare("INSERT INTO countries (campaign_id, seat) VALUES (?, ?)");
  for (const zone of STARTING_ZONES) {
    const info = insertCountry.run(campaignId, zone.seat);
    countryIdBySeat.set(zone.seat, Number(info.lastInsertRowid));
  }

  const ownerSeatByCoord = new Map<string, number>();
  for (const zone of STARTING_ZONES) {
    for (const [row, col] of zone.tiles) {
      ownerSeatByCoord.set(`${row},${col}`, zone.seat);
    }
  }

  const insertTile = db.prepare(
    "INSERT INTO tiles (campaign_id, row, col, owner_country_id) VALUES (?, ?, ?, ?)",
  );
  const tileIdByCoord = new Map<string, number>();
  for (let row = 0; row < WORLD_SIZE; row++) {
    for (let col = 0; col < WORLD_SIZE; col++) {
      const key = `${row},${col}`;
      const ownerSeat = ownerSeatByCoord.get(key);
      const ownerCountryId = ownerSeat !== undefined ? (countryIdBySeat.get(ownerSeat) ?? null) : null;
      const info = insertTile.run(campaignId, row, col, ownerCountryId);
      tileIdByCoord.set(key, Number(info.lastInsertRowid));
    }
  }

  const insertHeadquarters = db.prepare(
    "INSERT INTO buildings (tile_id, country_id, type) VALUES (?, ?, 'headquarters')",
  );
  for (const zone of STARTING_ZONES) {
    const [hqRow, hqCol] = zone.headquarters;
    const tileId = tileIdByCoord.get(`${hqRow},${hqCol}`);
    const countryId = countryIdBySeat.get(zone.seat);
    if (tileId === undefined || countryId === undefined) {
      throw new Error("world generation produced an incomplete layout");
    }
    insertHeadquarters.run(tileId, countryId);
  }
}

export interface Country {
  id: number;
  campaignId: number;
  seat: number;
}

export interface Tile {
  row: number;
  col: number;
  ownerCountryId: number | null;
}

export interface Building {
  tileId: number;
  countryId: number;
  type: string;
  row: number;
  col: number;
}

export interface WorldState {
  countries: Country[];
  tiles: Tile[];
  buildings: Building[];
}

// Returns the persisted world exactly as it exists right now — there is no
// cached or in-memory "world" anywhere. A campaign with no world yet
// (pre-start) comes back with all three lists empty.
export function getWorldForCampaign(campaignId: number): WorldState {
  const countryRows = db
    .prepare("SELECT id, campaign_id, seat FROM countries WHERE campaign_id = ? ORDER BY seat")
    .all(campaignId) as { id: number; campaign_id: number; seat: number }[];

  const tileRows = db
    .prepare("SELECT row, col, owner_country_id FROM tiles WHERE campaign_id = ? ORDER BY row, col")
    .all(campaignId) as { row: number; col: number; owner_country_id: number | null }[];

  const buildingRows = db
    .prepare(
      `SELECT b.tile_id AS tile_id, b.country_id AS country_id, b.type AS type, t.row AS row, t.col AS col
       FROM buildings b
       JOIN tiles t ON t.id = b.tile_id
       WHERE t.campaign_id = ?`,
    )
    .all(campaignId) as {
    tile_id: number;
    country_id: number;
    type: string;
    row: number;
    col: number;
  }[];

  return {
    countries: countryRows.map((r) => ({ id: r.id, campaignId: r.campaign_id, seat: r.seat })),
    tiles: tileRows.map((r) => ({ row: r.row, col: r.col, ownerCountryId: r.owner_country_id })),
    buildings: buildingRows.map((r) => ({
      tileId: r.tile_id,
      countryId: r.country_id,
      type: r.type,
      row: r.row,
      col: r.col,
    })),
  };
}
