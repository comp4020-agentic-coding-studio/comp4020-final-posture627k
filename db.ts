import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Card } from "./poker/cards.ts";
import { createDeck, shuffleDeck } from "./poker/deck.ts";
import {
  advanceToNextStreet as advanceBettingToNextStreet,
  applyBettingAction,
  initializeHeadsUpBetting,
  type BettingAction,
  type BettingActionRejectionReason,
  type HeadsUpBettingState,
  type Seat as PokerSeatNumber,
  type Street,
} from "./poker/betting.ts";

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
// domain (tables/seats) as a new, independent set of tables. Version 6
// adds persistent hand state (hands/hand players/actions) on top of it.
const SCHEMA_VERSION = 6;

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
// persistence (deck, hole cards, streets, actions) is added by the v6
// migration below.
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

// Migration: schema version 5 -> 6 (persistent hand state: deck, hole cards,
// betting state, action history). Additive only; v1-v5 are untouched.
//
// Design decisions, explained in full in the final Slice 3 report:
//
// - The full shuffled deck order (`deck_json`) and the live betting engine
//   state (`betting_json`, a serialized HeadsUpBettingState from
//   poker/betting.ts) are each stored as a single JSON blob per hand. Street
//   is also stored as its own column — duplicated with betting_json's own
//   `street` field, but kept in sync by always writing both from the same
//   update, and used for the one query (community-card visibility) that
//   would otherwise require parsing betting_json just to find the street.
// - Community cards are NOT stored separately: they are always reconstructed
//   from `deck_json` sliced according to `street` (preflop: none; flop: the
//   first 3 board slots; turn: +1; river: +1), which is the "reconstructable
//   deal cursor" the brief allows as an alternative to a stored board. This
//   avoids a second place board state could drift from the deck/street.
// - `poker_hand_players.hole_cards_json` IS a deliberate, write-once
//   duplication of 2 cards already present in the parent hand's deck_json —
//   not a second source of truth in the harmful sense (it is written
//   exactly once, at hand creation, and never updated again), but a
//   privacy-scoping convenience: a query for "this player's own hole cards"
//   never has to touch, deserialize, or risk logging the other 50 cards in
//   the full deck_json. Chip ledgers (B4) are a different, mutable case —
//   see poker_seats below.
// - `poker_seats.chip_stack` (v5) remains the authoritative bankroll
//   *between* hands and is not read or written while a hand is active —
//   betting_json's own per-seat `stack`/`committedThisStreet`/
//   `committedTotal` are the sole authoritative chip state *during* a hand.
//   A hand's starting stacks are seeded from poker_seats.chip_stack exactly
//   once at hand creation; writing the settled outcome back to
//   poker_seats.chip_stack is a later (settlement) slice's job, not this
//   one's — chip_stack is simply never touched while any hand referencing
//   it is active, so the two are never simultaneously mutable.
// - Exactly one active hand per table is enforced by the database itself,
//   not just application logic: a partial unique index on
//   `poker_hands(table_id) WHERE status = 'active'`, the same technique
//   `one_headquarters_per_country` already uses above for an analogous
//   one-row invariant.
// - Idempotency (the same request_id submitted twice must never double-
//   apply) is enforced by `UNIQUE (hand_id, request_id)` on poker_actions —
//   a constraint, not merely a pre-check — exactly the project's existing
//   pattern of using a database constraint as the real backstop against a
//   race, not an in-memory or pre-transaction check alone.
if (currentVersion < 6) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS poker_hands (
      id INTEGER PRIMARY KEY,
      table_id INTEGER NOT NULL REFERENCES poker_tables(id),
      hand_number INTEGER NOT NULL CHECK (hand_number > 0),
      button_seat INTEGER NOT NULL CHECK (button_seat IN (1, 2)),
      small_blind INTEGER NOT NULL CHECK (small_blind > 0),
      big_blind INTEGER NOT NULL CHECK (big_blind > small_blind),
      street TEXT NOT NULL CHECK (street IN ('preflop', 'flop', 'turn', 'river')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled')),
      version INTEGER NOT NULL CHECK (version > 0),
      deck_json TEXT NOT NULL,
      betting_json TEXT NOT NULL,
      settled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (table_id, hand_number)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_hand_per_table
      ON poker_hands(table_id)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS poker_hand_players (
      id INTEGER PRIMARY KEY,
      hand_id INTEGER NOT NULL REFERENCES poker_hands(id),
      seat_number INTEGER NOT NULL CHECK (seat_number IN (1, 2)),
      identity_id INTEGER NOT NULL REFERENCES identities(id),
      hole_cards_json TEXT NOT NULL,
      UNIQUE (hand_id, seat_number),
      UNIQUE (hand_id, identity_id)
    );

    CREATE TABLE IF NOT EXISTS poker_actions (
      id INTEGER PRIMARY KEY,
      hand_id INTEGER NOT NULL REFERENCES poker_hands(id),
      seat_number INTEGER NOT NULL CHECK (seat_number IN (1, 2)),
      request_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (expected_version > 0),
      action_type TEXT NOT NULL CHECK (action_type IN ('fold', 'check', 'call', 'bet', 'raise', 'all_in')),
      amount INTEGER CHECK (amount IS NULL OR amount >= 0),
      resulting_version INTEGER NOT NULL CHECK (resulting_version > 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (hand_id, request_id),
      UNIQUE (hand_id, resulting_version)
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

// --- Poker domain: persistent hand state (Slice 3) ---------------------------
// Builds on the pure engine in poker/betting.ts and the card primitives in
// poker/cards.ts and poker/deck.ts. This module never implements any poker
// rule itself — it only serializes/deserializes that engine's own state and
// enforces the transactional/authorization/idempotency contract around it.

// Fixed deck-slot convention for a heads-up hand: the first 4 cards of the
// shuffled deck are hole cards (button's pair, then the other seat's pair);
// the next cards are the community cards, revealed progressively by street.
// This is a simplification — real dealing interleaves single cards and uses
// burn cards — justified because the full order is already hidden server-
// side only; which fixed slots are "whose" has no gameplay consequence and
// burn cards exist purely to protect a *physical* deck from being tracked.
const HOLE_CARD_SLOTS: Readonly<Record<PokerSeatNumber, readonly [number, number]>> = {
  1: [0, 1],
  2: [2, 3],
};
const BOARD_START_INDEX = 4;
const BOARD_CARD_COUNT_BY_STREET: Readonly<Record<Street, number>> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

export interface PersistedHand {
  readonly id: number;
  readonly tableId: number;
  readonly handNumber: number;
  readonly buttonSeat: PokerSeatNumber;
  readonly street: Street;
  readonly status: "active" | "settled";
  readonly version: number;
  readonly bettingState: HeadsUpBettingState;
}

interface HandRow {
  id: number;
  table_id: number;
  hand_number: number;
  button_seat: number;
  street: string;
  status: string;
  version: number;
  deck_json: string;
  betting_json: string;
}

function toPersistedHand(row: HandRow): PersistedHand {
  return {
    id: row.id,
    tableId: row.table_id,
    handNumber: row.hand_number,
    buttonSeat: row.button_seat as PokerSeatNumber,
    street: row.street as Street,
    status: row.status as "active" | "settled",
    version: row.version,
    bettingState: JSON.parse(row.betting_json) as HeadsUpBettingState,
  };
}

const HAND_ROW_COLUMNS =
  "id, table_id, hand_number, button_seat, street, status, version, deck_json, betting_json";

function getHandRowById(handId: number): HandRow | undefined {
  return db.prepare(`SELECT ${HAND_ROW_COLUMNS} FROM poker_hands WHERE id = ?`).get(handId) as
    | HandRow
    | undefined;
}

export function getHandById(handId: number): PersistedHand | undefined {
  const row = getHandRowById(handId);
  return row ? toPersistedHand(row) : undefined;
}

export function getActiveHandForTable(tableId: number): PersistedHand | undefined {
  const row = db
    .prepare(`SELECT ${HAND_ROW_COLUMNS} FROM poker_hands WHERE table_id = ? AND status = 'active'`)
    .get(tableId) as HandRow | undefined;
  return row ? toPersistedHand(row) : undefined;
}

export type CreateHandResult =
  | { readonly ok: true; readonly hand: PersistedHand }
  | { readonly ok: false; readonly reason: "table_not_ready" | "hand_already_active" };

// Creates a brand-new hand for `tableId`: determines the next hand number
// and button seat (alternating from hand 1 = seat 1, a simple fixed
// rotation — full next-hand orchestration beyond this is a later slice's
// job), seeds each seat's starting stack from poker_seats.chip_stack
// *as it stands right now* (never touched again while this hand is active —
// see the v5 -> v6 migration comment for why), generates a fresh
// cryptographically-secure shuffled deck, and persists the initial betting
// state and each player's hole cards atomically. The partial unique index
// `one_active_hand_per_table` is the actual backstop against two concurrent
// calls both creating a hand for the same table — this function catches
// that constraint violation rather than relying only on a pre-check.
export function createPokerHand(tableId: number): CreateHandResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const table = db
      .prepare("SELECT status, small_blind, big_blind FROM poker_tables WHERE id = ?")
      .get(tableId) as { status: string; small_blind: number; big_blind: number } | undefined;

    if (!table || table.status !== "ready") {
      db.exec("ROLLBACK");
      return { ok: false, reason: "table_not_ready" };
    }

    const seatRows = db
      .prepare("SELECT seat_number, identity_id, chip_stack FROM poker_seats WHERE table_id = ?")
      .all(tableId) as { seat_number: number; identity_id: number; chip_stack: number }[];
    const seat1 = seatRows.find((s) => s.seat_number === 1);
    const seat2 = seatRows.find((s) => s.seat_number === 2);
    if (!seat1 || !seat2) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "table_not_ready" };
    }

    const lastHandNumberRow = db
      .prepare("SELECT MAX(hand_number) AS maxHandNumber FROM poker_hands WHERE table_id = ?")
      .get(tableId) as { maxHandNumber: number | null };
    const handNumber = (lastHandNumberRow.maxHandNumber ?? 0) + 1;
    const buttonSeat: PokerSeatNumber = handNumber % 2 === 1 ? 1 : 2;

    const deck = shuffleDeck(createDeck());
    const bettingState = initializeHeadsUpBetting({
      buttonSeat,
      smallBlind: table.small_blind,
      bigBlind: table.big_blind,
      stacks: { 1: seat1.chip_stack, 2: seat2.chip_stack },
    });

    const info = db
      .prepare(
        `INSERT INTO poker_hands
           (table_id, hand_number, button_seat, small_blind, big_blind, street, status, version, deck_json, betting_json)
         VALUES (?, ?, ?, ?, ?, 'preflop', 'active', ?, ?, ?)`,
      )
      .run(
        tableId,
        handNumber,
        buttonSeat,
        table.small_blind,
        table.big_blind,
        bettingState.version,
        JSON.stringify(deck),
        JSON.stringify(bettingState),
      );
    const handId = Number(info.lastInsertRowid);

    const insertHandPlayer = db.prepare(
      "INSERT INTO poker_hand_players (hand_id, seat_number, identity_id, hole_cards_json) VALUES (?, ?, ?, ?)",
    );
    for (const seat of [seat1, seat2]) {
      const [a, b] = HOLE_CARD_SLOTS[seat.seat_number as PokerSeatNumber];
      const holeCards = [deck[a], deck[b]];
      insertHandPlayer.run(handId, seat.seat_number, seat.identity_id, JSON.stringify(holeCards));
    }

    db.exec("COMMIT");
    return { ok: true, hand: getHandById(handId)! };
  } catch (err) {
    db.exec("ROLLBACK");
    if (isUniqueConstraintViolation(err)) {
      return { ok: false, reason: "hand_already_active" };
    }
    throw err;
  }
}

// Resolves which seat (if any) `identityId` holds in this specific hand —
// captured at hand creation, so this is authoritative for the hand even if
// table seating were ever to change later. Used both for authorization (is
// this identity even a player in this hand) and to look up their own hole
// cards, never anyone else's.
export function getSeatNumberForIdentityInHand(handId: number, identityId: number): PokerSeatNumber | undefined {
  const row = db
    .prepare("SELECT seat_number FROM poker_hand_players WHERE hand_id = ? AND identity_id = ?")
    .get(handId, identityId) as { seat_number: number } | undefined;
  return row ? (row.seat_number as PokerSeatNumber) : undefined;
}

// Returns only the calling identity's own hole cards for this hand — never
// the deck, never the other seat's cards. There is no function in this
// module that returns another player's hole cards or the raw deck_json to
// anything outside this file.
export function getOwnHoleCards(handId: number, identityId: number): Card[] | undefined {
  const row = db
    .prepare("SELECT hole_cards_json FROM poker_hand_players WHERE hand_id = ? AND identity_id = ?")
    .get(handId, identityId) as { hole_cards_json: string } | undefined;
  return row ? (JSON.parse(row.hole_cards_json) as Card[]) : undefined;
}

// Community cards are always public once dealt and are reconstructed from
// the deck order and the hand's current street — there is no separately
// stored board that could drift from either.
export function getCommunityCards(handId: number): Card[] {
  const row = db.prepare("SELECT street, deck_json FROM poker_hands WHERE id = ?").get(handId) as
    | { street: string; deck_json: string }
    | undefined;
  if (!row) return [];
  const deck = JSON.parse(row.deck_json) as Card[];
  const count = BOARD_CARD_COUNT_BY_STREET[row.street as Street];
  return deck.slice(BOARD_START_INDEX, BOARD_START_INDEX + count);
}

export interface PersistedAction {
  readonly handId: number;
  readonly seatNumber: PokerSeatNumber;
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly actionType: BettingAction["type"];
  readonly amount: number | null;
  readonly resultingVersion: number;
  readonly createdAt: string;
}

export function getActionHistory(handId: number): PersistedAction[] {
  const rows = db
    .prepare(
      `SELECT hand_id AS handId, seat_number AS seatNumber, request_id AS requestId,
              expected_version AS expectedVersion, action_type AS actionType, amount,
              resulting_version AS resultingVersion, created_at AS createdAt
       FROM poker_actions WHERE hand_id = ? ORDER BY resulting_version ASC`,
    )
    .all(handId) as unknown as PersistedAction[];
  return rows;
}

export type ApplyPersistedActionResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly hand: PersistedHand }
  | {
      readonly ok: false;
      readonly reason: BettingActionRejectionReason | "hand_not_active" | "not_a_player" | "request_id_conflict";
      readonly hand: PersistedHand | undefined;
    };

export interface SubmitBettingActionParams {
  readonly handId: number;
  readonly identityId: number;
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly action: BettingAction;
}

// The full exactly-once, transactional action contract: resolves identity ->
// seat from the trusted server-side identity, re-checks authorization and
// turn order fresh inside the transaction, treats a repeated request_id as
// an idempotent no-op rather than re-applying or erroring, validates and
// applies the action through the pure betting engine (never reimplementing
// its rules here), and — only if every check passes — updates the hand row
// and appends exactly one action record atomically. A rejection at any
// step rolls back with no partial chip deduction and no action row.
//
// Deliberately does not publish any realtime notification — that is the
// HTTP route layer's job, after this transaction has already committed, per
// this project's existing publish-after-commit discipline.
export function submitBettingAction(params: SubmitBettingActionParams): ApplyPersistedActionResult {
  const { handId, identityId, requestId, expectedVersion, action } = params;

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = getHandRowById(handId);
    if (!row || row.status !== "active") {
      db.exec("ROLLBACK");
      return { ok: false, reason: "hand_not_active", hand: row ? toPersistedHand(row) : undefined };
    }

    const seat = getSeatNumberForIdentityInHand(handId, identityId);
    if (seat === undefined) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_a_player", hand: toPersistedHand(row) };
    }

    const existingAction = db
      .prepare(
        `SELECT seat_number, expected_version, action_type, amount, resulting_version
         FROM poker_actions WHERE hand_id = ? AND request_id = ?`,
      )
      .get(handId, requestId) as
      | { seat_number: number; expected_version: number; action_type: string; amount: number | null; resulting_version: number }
      | undefined;
    if (existingAction) {
      // A request_id is only ever an idempotent replay of the EXACT same
      // request: same hand (implicit in the query), same authenticated
      // player, same action type/amount, and the same expected_version it
      // was originally submitted with. Any difference means this request_id
      // was reused for genuinely different semantic content — a conflict to
      // reject outright, not a harmless duplicate to silently approve. This
      // is what stops a reused id from masking, say, a different player's
      // action or a different wager amount as "already applied, no-op."
      const sameContent =
        existingAction.seat_number === seat &&
        existingAction.action_type === action.type &&
        existingAction.amount === (action.amount ?? null) &&
        existingAction.expected_version === expectedVersion;

      db.exec("ROLLBACK");
      if (!sameContent) {
        return { ok: false, reason: "request_id_conflict", hand: toPersistedHand(row) };
      }
      // A true idempotent replay: the same request was already applied
      // exactly once before. Return the current truth, apply nothing new,
      // and never charge chips a second time for the same request.
      return { ok: true, duplicate: true, hand: toPersistedHand(row) };
    }

    const currentState = JSON.parse(row.betting_json) as HeadsUpBettingState;
    const result = applyBettingAction(currentState, seat, action, { expectedVersion });

    if (!result.ok) {
      db.exec("ROLLBACK");
      return { ok: false, reason: result.reason, hand: toPersistedHand(row) };
    }

    db.prepare(
      `UPDATE poker_hands SET street = ?, version = ?, betting_json = ?
       WHERE id = ? AND version = ?`,
    ).run(result.state.street, result.state.version, JSON.stringify(result.state), handId, row.version);

    db.prepare(
      `INSERT INTO poker_actions
         (hand_id, seat_number, request_id, expected_version, action_type, amount, resulting_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(handId, seat, requestId, expectedVersion, action.type, action.amount ?? null, result.state.version);

    db.exec("COMMIT");
    return { ok: true, duplicate: false, hand: getHandById(handId)! };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type AdvanceHandStreetResult =
  | { readonly ok: true; readonly hand: PersistedHand }
  | { readonly ok: false; readonly reason: "hand_not_active" | "betting_not_complete" };

// Transactionally advances a hand to its next street once betting on the
// current street is complete, resetting the pure engine's own street-
// specific fields (see poker/betting.ts's advanceToNextStreet) while
// preserving total hand contributions. This does not deal or reveal any
// card by itself — community cards remain purely a read-time
// reconstruction from deck_json + street (see getCommunityCards above).
export function advanceHandStreet(handId: number, nextStreet: Street): AdvanceHandStreetResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = getHandRowById(handId);
    if (!row || row.status !== "active") {
      db.exec("ROLLBACK");
      return { ok: false, reason: "hand_not_active" };
    }

    const currentState = JSON.parse(row.betting_json) as HeadsUpBettingState;
    if (!currentState.isBettingComplete) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "betting_not_complete" };
    }

    const newState = advanceBettingToNextStreet(currentState, nextStreet);
    db.prepare(
      `UPDATE poker_hands SET street = ?, version = ?, betting_json = ?
       WHERE id = ? AND version = ?`,
    ).run(newState.street, newState.version, JSON.stringify(newState), handId, row.version);

    db.exec("COMMIT");
    return { ok: true, hand: getHandById(handId)! };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
