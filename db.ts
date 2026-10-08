import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Schema version for this file, tracked via SQLite's own PRAGMA user_version.
// A fresh/empty data directory starts at 0; this module brings it to
// SCHEMA_VERSION, migrating an existing older database in place rather than
// recreating it. A database from a newer, unknown version fails loudly
// instead of being silently reinterpreted.
//
// Versions 1-4 are the strategy-war product (Crit 8/9). That product is
// cancelled (see docs/poker-final-architecture.md) and its HTTP routes and
// business logic have been removed below, but its schema and migrations are
// kept byte-for-byte: the old tables may still physically exist in an
// existing database file, and the migration chain that produces them must
// keep working exactly as it always did, so an old deployment's data is
// never silently reinterpreted or destroyed. Version 5 adds the poker
// domain as a new, independent set of tables.
const SCHEMA_VERSION = 5;

// The fixed Crit 8 world layout. Defined here, ahead of the schema/migration
// code below, because the v2 -> v3 migration can call generateWorld() (to
// backfill already-started campaigns) while the module is still executing
// top-to-bottom — a `const` isn't usable before its own initializer has run,
// even inside a hoisted function, so this can't live further down the file
// near generateWorld's definition without hitting that temporal-dead-zone
// error the moment a backfill is actually needed.
//
// generateWorld() and this layout are retained solely because the v2 -> v3
// migration below still calls them against a real pre-existing v2 database.
// Nothing in the current (poker) application calls either any more.
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

// Migration: schema version 3 -> 4 (country pooled resource balance, per-
// resource-building settlement cursor). Same once-only guard as earlier
// blocks.
//
// A v3 database can already contain resource buildings (Slice 5 predates
// this column). Backfilling their cursor from migration time would silently
// grant them free production for all the time between their real
// construction and whenever this migration happens to run. Instead each
// one's cursor is seeded from its own `created_at`, so it starts producing
// exactly where it would have if this column had existed when it was built.
// Headquarters are untouched and stay NULL (ALTER TABLE ADD COLUMN with no
// DEFAULT leaves existing rows NULL; generateWorld never sets this column
// for headquarters either).
if (currentVersion < 4) {
  db.exec(
    "ALTER TABLE countries ADD COLUMN resource_balance INTEGER NOT NULL DEFAULT 0 CHECK (resource_balance >= 0)",
  );
  db.exec(
    "ALTER TABLE buildings ADD COLUMN settlement_cursor_ms INTEGER CHECK (settlement_cursor_ms IS NULL OR settlement_cursor_ms >= 0)",
  );

  const existingResourceBuildings = db
    .prepare("SELECT id, created_at FROM buildings WHERE type = 'resource'")
    .all() as { id: number; created_at: string }[];

  db.exec("BEGIN IMMEDIATE");
  try {
    const seedCursor = db.prepare("UPDATE buildings SET settlement_cursor_ms = ? WHERE id = ?");
    for (const building of existingResourceBuildings) {
      seedCursor.run(new Date(building.created_at).getTime(), building.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Migration: schema version 4 -> 5 (poker domain foundation). Additive only,
// like every migration above: the strategy-war tables (campaigns,
// participants, approvals, countries, tiles, buildings) are untouched and
// keep whatever data they already had. Poker is a wholly independent set of
// tables — a poker table is not a renamed campaign, and nothing here reads
// from or writes to any war-game table.
//
// This is the minimum persistence the poker foundation slice needs: create a
// table, seat exactly two players, give each an initial chip stack, and
// track whether the table is still waiting for a second player. Hand/betting
// persistence (deck, hole cards, streets, pots, settlement) is deliberately
// not introduced yet — see docs/poker-final-architecture.md section 6 for
// the full proposed shape, most of which has a concrete dependency only once
// hand play itself is implemented.
if (currentVersion < 5) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS poker_tables (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'waiting_for_players'
        CHECK (status IN ('waiting_for_players', 'ready')),
      small_blind INTEGER NOT NULL DEFAULT 5 CHECK (small_blind > 0),
      big_blind INTEGER NOT NULL DEFAULT 10 CHECK (big_blind > small_blind),
      starting_stack INTEGER NOT NULL DEFAULT 1000 CHECK (starting_stack > 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS poker_seats (
      id INTEGER PRIMARY KEY,
      table_id INTEGER NOT NULL REFERENCES poker_tables(id),
      identity_id INTEGER NOT NULL REFERENCES identities(id),
      seat_number INTEGER NOT NULL CHECK (seat_number IN (1, 2)),
      chip_stack INTEGER NOT NULL CHECK (chip_stack >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (table_id, seat_number),
      UNIQUE (table_id, identity_id)
    );
  `);
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

function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return code === "ERR_SQLITE_ERROR" && err.message.includes("UNIQUE constraint failed");
}

// --- Strategy-war world generation (migration-only) -------------------------
// Retained solely because the v2 -> v3 migration above can still call this
// against a real pre-existing v2 database. The poker application never calls
// it. Kept exactly as it behaved in the strategy-war product so an old
// database migrates identically to how it always did.

// Called only from inside an already-open BEGIN IMMEDIATE transaction — the
// v2 -> v3 migration's per-campaign backfill transaction. It never opens or
// closes a transaction itself. A `function` declaration (not a const arrow
// function) so it's hoisted and callable from the migration code above,
// which runs earlier in this file's top-level execution than this
// definition appears.
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

// --- Poker domain: tables and seats (foundation slice) -----------------------
// Independent of the strategy-war tables above: a poker table is not a
// renamed campaign, and a poker seat is not a renamed participant. Hand and
// betting state do not exist yet — this is deliberately only enough to
// create a table, seat two players, and show each their own chip stack.

export type PokerTableStatus = "waiting_for_players" | "ready";

export interface PokerTable {
  id: number;
  code: string;
  status: PokerTableStatus;
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
}

export interface PokerSeat {
  tableId: number;
  identityId: number;
  seatNumber: number;
  chipStack: number;
}

// Avoids 0/O/1/I/L, which are easy to misread or mistype when a code is
// shared out loud or copied by hand. Shared shape with the retired
// generateCampaignCode, not shared code — poker has its own table and no
// dependency on anything campaign-specific.
const TABLE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TABLE_CODE_LENGTH = 8;

function generateTableCode(): string {
  const bytes = randomBytes(TABLE_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < TABLE_CODE_LENGTH; i++) {
    code += TABLE_CODE_ALPHABET[bytes[i] % TABLE_CODE_ALPHABET.length];
  }
  return code;
}

function toPokerTable(row: {
  id: number;
  code: string;
  status: string;
  small_blind: number;
  big_blind: number;
  starting_stack: number;
}): PokerTable {
  return {
    id: row.id,
    code: row.code,
    status: row.status as PokerTableStatus,
    smallBlind: row.small_blind,
    bigBlind: row.big_blind,
    startingStack: row.starting_stack,
  };
}

// Creates the table and seats the creator at seat 1 atomically, with the
// table's own starting stack. The table code is generated randomly (not
// derived from the primary key) and retried on the (astronomically
// unlikely) chance of a collision — same approach the strategy-war product
// used for campaign codes.
//
// Blinds and starting stack are development defaults for the foundation
// slice (5/10 blinds, 1,000 chips — see docs/poker-final-architecture.md
// section 9), not yet an approved, permanent product configuration; they
// are columns, not hard-coded constants scattered through the code, so a
// later slice can make them configurable without a schema change.
export function createPokerTable(hostIdentityId: number): PokerTable {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateTableCode();
    db.exec("BEGIN IMMEDIATE");
    try {
      const info = db.prepare("INSERT INTO poker_tables (code) VALUES (?)").run(code);
      const tableId = Number(info.lastInsertRowid);
      const table = db
        .prepare("SELECT id, code, status, small_blind, big_blind, starting_stack FROM poker_tables WHERE id = ?")
        .get(tableId) as {
        id: number;
        code: string;
        status: string;
        small_blind: number;
        big_blind: number;
        starting_stack: number;
      };
      db.prepare(
        "INSERT INTO poker_seats (table_id, identity_id, seat_number, chip_stack) VALUES (?, ?, 1, ?)",
      ).run(tableId, hostIdentityId, table.starting_stack);
      db.exec("COMMIT");
      return toPokerTable(table);
    } catch (err) {
      db.exec("ROLLBACK");
      if (isUniqueConstraintViolation(err)) continue;
      throw err;
    }
  }
  throw new Error("failed to generate a unique poker table code");
}

export function getPokerTableByCode(code: string): PokerTable | undefined {
  const row = db
    .prepare("SELECT id, code, status, small_blind, big_blind, starting_stack FROM poker_tables WHERE code = ?")
    .get(code) as
    | { id: number; code: string; status: string; small_blind: number; big_blind: number; starting_stack: number }
    | undefined;
  return row ? toPokerTable(row) : undefined;
}

export function getSeatsForTable(tableId: number): PokerSeat[] {
  const rows = db
    .prepare(
      `SELECT table_id AS tableId, identity_id AS identityId, seat_number AS seatNumber, chip_stack AS chipStack
       FROM poker_seats WHERE table_id = ? ORDER BY seat_number`,
    )
    .all(tableId) as unknown as PokerSeat[];
  return rows;
}

export function getSeatForIdentity(tableId: number, identityId: number): PokerSeat | undefined {
  const row = db
    .prepare(
      `SELECT table_id AS tableId, identity_id AS identityId, seat_number AS seatNumber, chip_stack AS chipStack
       FROM poker_seats WHERE table_id = ? AND identity_id = ?`,
    )
    .get(tableId, identityId) as PokerSeat | undefined;
  return row;
}

export type JoinPokerTableResult =
  | { ok: true; alreadyJoined: boolean; seatNumber: number }
  | { ok: false; reason: "full" };

// The only open seat for this heads-up foundation slice is seat 2.
// Concurrency safety comes from the UNIQUE(table_id, seat_number) and
// UNIQUE(table_id, identity_id) constraints, not from the pre-check below:
// two concurrent joins can both pass the pre-check, but only one INSERT can
// win, and the loser's constraint violation is what this function treats as
// "full" — the same pattern the strategy-war product used for campaign
// seating. A table that reaches two seated players transitions to "ready"
// in the same transaction as the seat that filled it.
export function joinPokerTable(tableId: number, identityId: number): JoinPokerTableResult {
  const existing = getSeatForIdentity(tableId, identityId);
  if (existing) {
    return { ok: true, alreadyJoined: true, seatNumber: existing.seatNumber };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const table = db.prepare("SELECT starting_stack FROM poker_tables WHERE id = ?").get(tableId) as
      | { starting_stack: number }
      | undefined;
    if (!table) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "full" };
    }

    db.prepare(
      "INSERT INTO poker_seats (table_id, identity_id, seat_number, chip_stack) VALUES (?, ?, 2, ?)",
    ).run(tableId, identityId, table.starting_stack);
    db.prepare("UPDATE poker_tables SET status = 'ready' WHERE id = ?").run(tableId);
    db.exec("COMMIT");
    return { ok: true, alreadyJoined: false, seatNumber: 2 };
  } catch (err) {
    db.exec("ROLLBACK");
    if (isUniqueConstraintViolation(err)) {
      return { ok: false, reason: "full" };
    }
    throw err;
  }
}
