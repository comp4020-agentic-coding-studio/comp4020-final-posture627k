import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Schema version for this file, tracked via SQLite's own PRAGMA user_version.
// A fresh/empty data directory starts at 0; this module brings it to
// SCHEMA_VERSION. A future, incompatible schema change should bump this and
// add an explicit upgrade step rather than silently reinterpreting old rows.
const SCHEMA_VERSION = 1;

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

if (currentVersion !== 0 && currentVersion !== SCHEMA_VERSION) {
  throw new Error(
    `database schema version ${currentVersion} is not supported by this build (expected ${SCHEMA_VERSION}); no migration path exists yet`,
  );
}

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

export interface Campaign {
  id: number;
  code: string;
  status: string;
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
      return { id: campaignId, code, status: "configuring" };
    } catch (err) {
      db.exec("ROLLBACK");
      if (isUniqueConstraintViolation(err)) continue;
      throw err;
    }
  }
  throw new Error("failed to generate a unique campaign code");
}

export function getCampaignByCode(code: string): Campaign | undefined {
  const row = db.prepare("SELECT id, code, status FROM campaigns WHERE code = ?").get(code) as
    | { id: number; code: string; status: string }
    | undefined;
  return row;
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
      `SELECT c.id AS id, c.code AS code, c.status AS status, p.seat AS seat, p.is_host AS is_host
       FROM campaigns c
       JOIN participants p ON p.campaign_id = c.id
       WHERE p.identity_id = ?
       ORDER BY c.created_at DESC`,
    )
    .all(identityId) as {
    id: number;
    code: string;
    status: string;
    seat: number;
    is_host: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    status: r.status,
    seat: r.seat,
    isHost: r.is_host === 1,
  }));
}
