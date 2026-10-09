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
import { nextStreet as computeNextStreet, shouldAdvanceStreet, isReadyForSettlement } from "./poker/hand-lifecycle.ts";
import { settleHand, type SettlementPlan, type SettlementRejectionReason } from "./poker/settlement.ts";
import type { RandomInt } from "./card-clash/deck.ts";
import { initializeMatch as initializeCardClashMatch } from "./card-clash/engine.ts";
import type { GameMode as CardClashMode, MatchState as CardClashMatchState, Seat as CardClashSeatNumber } from "./card-clash/types.ts";
import {
  applyCardClashTimeoutTransition,
  computeNextCardClashDeadline,
  type CardClashDeadlineInfo,
} from "./card-clash/timers.ts";

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
// Version 7 adds the Card Clash domain (rooms/seats/matches/match actions)
// as a further new, independent set of tables — poker's own tables and data
// are untouched; no poker record is ever copied or reinterpreted as a Card
// Clash one. Version 8 adds one more additive Card Clash table (durable
// action/response deadlines for the v2.6 10-second timers, docs/card-clash-
// rules.md §11) — nothing from v1-v7 is touched.
const SCHEMA_VERSION = 8;

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

// Migration: schema version 6 -> 7 (Card Clash domain: rooms, seat
// membership/readiness, persistent match state, applied-action ledger).
// Additive only; v1-v6 (strategy-war and poker) are completely untouched —
// Card Clash is a wholly independent set of tables, exactly like poker was
// when it was added in v5/v6. No poker row is ever copied or reinterpreted
// here.
//
// Design decisions:
//
// - A room is created with exactly one immutable `mode` (docs/card-clash-
//   rules.md §1) — card_clash_seats.seat_number is only bounded 1-4 at the
//   SQL level (the broadest mode allows 4); which seats are actually valid
//   for a given room is enforced in application code against that room's
//   own mode, the same division of responsibility poker_seats already uses
//   (SQL bounds the type, the app enforces the mode-specific count).
// - `card_clash_matches.state_json` holds the ENTIRE serialized
//   card-clash/types.ts MatchState — mode, every player's hp/hand/team,
//   draw/discard piles, deck generation, pending response/rescue/group
//   context, public event log, and match result — as one JSON blob,
//   written in a single UPDATE per transition. This is the same choice
//   poker_hands.betting_json already made for HeadsUpBettingState: public
//   events and game state can never commit independently and drift apart,
//   because they are literally one write. A room has at most one match,
//   ever, in this slice (UNIQUE(room_id)) — no rematch/leave/reseat exists
//   yet (explicitly deferred).
// - Idempotency mirrors poker_actions exactly: `UNIQUE (match_id,
//   request_id)` is the real constraint-backed guarantee, not just an
//   in-memory pre-check, and `UNIQUE (match_id, resulting_version)` stops
//   two different requests from ever being recorded as producing the same
//   resulting version.
if (currentVersion < 7) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_clash_rooms (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN ('1v1', '1v2', '2v2')),
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'complete')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS card_clash_seats (
      id INTEGER PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES card_clash_rooms(id),
      identity_id INTEGER NOT NULL REFERENCES identities(id),
      seat_number INTEGER NOT NULL CHECK (seat_number BETWEEN 1 AND 4),
      ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (room_id, seat_number),
      UNIQUE (room_id, identity_id)
    );

    CREATE TABLE IF NOT EXISTS card_clash_matches (
      id INTEGER PRIMARY KEY,
      room_id INTEGER NOT NULL UNIQUE REFERENCES card_clash_rooms(id),
      version INTEGER NOT NULL CHECK (version > 0),
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS card_clash_match_actions (
      id INTEGER PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES card_clash_matches(id),
      request_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (expected_version > 0),
      resulting_version INTEGER NOT NULL CHECK (resulting_version > 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (match_id, request_id),
      UNIQUE (match_id, resulting_version)
    );
  `);
}

// Migration: schema version 7 -> 8 (Card Clash v2.6 durable action/response
// deadlines, docs/card-clash-rules.md §11, D4C-1). Additive only; v1-v7 are
// completely untouched.
//
// Exactly one row per match, holding whatever deadline currently applies —
// never a history of past deadlines. `version` is the card_clash_matches
// row's own version this deadline was computed for: db.ts only ever acts on
// this row after confirming it still matches the match's CURRENT version,
// which is what makes an obsolete/duplicate timer callback a guaranteed
// no-op (docs §11 "a server restart... must resume and reconcile", "an
// expired action and a valid action... must never both succeed"). `active`
// is the explicit "no timer applies right now" flag — a terminal match or
// an unresolved DISCARD block (see card-clash/timers.ts) still writes a row
// here, just with active = 0 and no expiry/responder, so there is never any
// ambiguity between "no row yet" and "deliberately no timer right now".
// `expires_at` is stored as integer epoch milliseconds (server time only,
// never a client-supplied value) rather than the TEXT timestamps used
// elsewhere in this file, since it is compared numerically against an
// injectable clock far more often than it is read by a human.
if (currentVersion < 8) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_clash_deadlines (
      match_id INTEGER PRIMARY KEY REFERENCES card_clash_matches(id),
      version INTEGER NOT NULL CHECK (version > 0),
      expires_at INTEGER,
      responder_seat INTEGER CHECK (responder_seat IS NULL OR responder_seat BETWEEN 1 AND 4),
      active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      CHECK (
        (active = 1 AND expires_at IS NOT NULL AND responder_seat IS NOT NULL) OR
        (active = 0 AND expires_at IS NULL AND responder_seat IS NULL)
      )
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

// The most recent hand for a table regardless of status — unlike
// getActiveHandForTable, this remains defined after a hand auto-settles
// (status transitions to 'settled' the instant a terminal action commits,
// so "active" alone cannot be used to show a just-finished result, on the
// very same page load or on a later refresh). `hand_number` is unique per
// table and strictly increasing (see createPokerHand), so ordering by it
// deterministically identifies the latest hand without relying on
// `created_at` wall-clock ordering.
export function getLatestHandForTable(tableId: number): PersistedHand | undefined {
  const row = db
    .prepare(`SELECT ${HAND_ROW_COLUMNS} FROM poker_hands WHERE table_id = ? ORDER BY hand_number DESC LIMIT 1`)
    .get(tableId) as HandRow | undefined;
  return row ? toPersistedHand(row) : undefined;
}

export type CreateHandResult =
  | { readonly ok: true; readonly hand: PersistedHand }
  | {
      readonly ok: false;
      readonly reason: "table_not_ready" | "hand_already_active" | "insufficient_chips" | "stale_hand_state";
    };

// Creates a brand-new hand for `tableId`: determines the next hand number
// and button seat (alternating from hand 1 = seat 1, a simple fixed
// rotation — full next-hand orchestration beyond this is a later slice's
// job), seeds each seat's starting stack from poker_seats.chip_stack
// *as it stands right now* (never touched again while this hand is active —
// see the v5 -> v6 migration comment for why), generates a fresh
// cryptographically-secure shuffled deck, and persists the initial betting
// state and each player's hole cards atomically. The partial unique index
// `one_active_hand_per_table` is the actual backstop against two concurrent
// calls both creating a hand for the same table while the first stays
// active — this function catches that constraint violation rather than
// relying only on a pre-check.
//
// `expectedLatestHandNumber`, when given, additionally guards against a
// narrower race the partial index alone cannot catch: if the hand this call
// creates immediately auto-settles within this very transaction (an
// extreme-short-stack blind post can already be a terminal state — see the
// advanceAndSettleIfNeeded call below), the row's status flips to 'settled'
// *before* COMMIT, so `one_active_hand_per_table` no longer blocks a second,
// closely-following call (e.g. a double-submitted "start hand" click) from
// creating a genuine extra hand the user never asked for. Passing the
// caller's own last-observed hand_number (0 if none) closes that window
// with the same optimistic-concurrency idea already used for betting
// actions' expected_version: if the table's actual latest hand_number has
// moved on from what the caller last saw, by the time this call runs,
// something else already created the hand the caller intended to trigger —
// so this call is a no-op, not a second hand. Every existing call site
// (including every test fixture) omits it and gets the previous behavior
// unchanged (no check performed) — only the HTTP route populates it.
// `overrideDeck` exists only so this module's own tests can supply a fixed,
// known deck order for deterministic, reproducible fixtures (e.g. forcing a
// specific showdown outcome or a specific short-all-in scenario) — every
// real caller omits it and gets the secure default
// (shuffleDeck(createDeck())), exactly like poker/deck.ts's own injectable-
// RNG parameter never gets overridden outside that module's tests either.
export function createPokerHand(
  tableId: number,
  overrideDeck?: Card[],
  expectedLatestHandNumber?: number,
): CreateHandResult {
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

    // A new hand can only start if both players retain enough chips to
    // play at all (at minimum, one chip, to post something and have a
    // decision that matters). This is deliberately not "rebuy to 1,000" —
    // a player who has busted stays busted; the match is over for this
    // table until a later slice (if ever) adds a deliberate rebuy feature.
    if (seat1.chip_stack <= 0 || seat2.chip_stack <= 0) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "insufficient_chips" };
    }

    const lastHandNumberRow = db
      .prepare("SELECT MAX(hand_number) AS maxHandNumber FROM poker_hands WHERE table_id = ?")
      .get(tableId) as { maxHandNumber: number | null };
    const currentLatestHandNumber = lastHandNumberRow.maxHandNumber ?? 0;

    if (expectedLatestHandNumber !== undefined && currentLatestHandNumber !== expectedLatestHandNumber) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "stale_hand_state" };
    }

    const handNumber = currentLatestHandNumber + 1;
    const buttonSeat: PokerSeatNumber = handNumber % 2 === 1 ? 1 : 2;

    const deck = overrideDeck ?? shuffleDeck(createDeck());
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

    // An extreme short stack can make the blinds alone already a terminal
    // state — e.g. a small-blind post so short it's already covered by the
    // big blind's own post, leaving literally no decision for either seat
    // (see poker/betting.ts's isSettled). This cascades through the runout
    // and settles automatically, exactly like after any other action — no
    // player should ever have to submit an action that cannot legally
    // exist.
    advanceAndSettleIfNeeded(handId, bettingState);

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
function getCommunityCardsFromRow(row: { street: string; deck_json: string }): Card[] {
  const deck = JSON.parse(row.deck_json) as Card[];
  const count = BOARD_CARD_COUNT_BY_STREET[row.street as Street];
  return deck.slice(BOARD_START_INDEX, BOARD_START_INDEX + count);
}

export function getCommunityCards(handId: number): Card[] {
  const row = db.prepare("SELECT street, deck_json FROM poker_hands WHERE id = ?").get(handId) as
    | { street: string; deck_json: string }
    | undefined;
  return row ? getCommunityCardsFromRow(row) : [];
}

// Internal: both seats' hole cards for a hand, used only by the settlement
// functions below — never exposed as a public per-identity-scoped read,
// since that would hand one player's own query path access to the other
// player's cards. getOwnHoleCards above is the only externally-safe read.
function getHoleCardsForSettlement(handId: number): Record<PokerSeatNumber, readonly [Card, Card]> {
  const rows = db
    .prepare("SELECT seat_number, hole_cards_json FROM poker_hand_players WHERE hand_id = ?")
    .all(handId) as { seat_number: number; hole_cards_json: string }[];
  const result = {} as Record<PokerSeatNumber, readonly [Card, Card]>;
  for (const row of rows) {
    result[row.seat_number as PokerSeatNumber] = JSON.parse(row.hole_cards_json) as [Card, Card];
  }
  return result;
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
    if (!row) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "hand_not_active", hand: undefined };
    }

    // Resolving which seat this identity holds works regardless of the
    // hand's current status — a settled hand keeps its player rows forever,
    // as immutable history — and this must be checked before the
    // duplicate-request and status checks below, since validating a
    // duplicate's content (below) needs to know the seat either way.
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
      //
      // Deliberately checked BEFORE the hand-active check below: a retried
      // request_id for the very action that just completed and settled the
      // hand must still be recognized as an idempotent replay, not rejected
      // as "hand not active" merely because settlement already ran as a
      // consequence of that same original action.
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

    // Only a genuinely NEW request_id reaches this far, so only now does the
    // hand's current status matter: a brand-new action can never be applied
    // to a hand that is no longer active.
    if (row.status !== "active") {
      db.exec("ROLLBACK");
      return { ok: false, reason: "hand_not_active", hand: toPersistedHand(row) };
    }

    const currentState = JSON.parse(row.betting_json) as HeadsUpBettingState;
    const result = applyBettingAction(currentState, seat, action, { expectedVersion });

    if (!result.ok) {
      db.exec("ROLLBACK");
      return { ok: false, reason: result.reason, hand: toPersistedHand(row) };
    }

    // The action record reflects exactly this action's own resulting
    // version, before any automatic street advance or settlement that may
    // follow — those are system-triggered consequences, not a player
    // decision, and are never logged as actions themselves.
    db.prepare(
      `INSERT INTO poker_actions
         (hand_id, seat_number, request_id, expected_version, action_type, amount, resulting_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(handId, seat, requestId, expectedVersion, action.type, action.amount ?? null, result.state.version);

    // Cascades through any further streets that need no additional betting
    // (a completed round, or an all-in runout with nothing left to decide)
    // and settles automatically once terminal — all within this same
    // transaction, so the action that completes a hand and its settlement
    // are one atomic unit, never two independent transactions.
    advanceAndSettleIfNeeded(handId, result.state);

    db.exec("COMMIT");
    return { ok: true, duplicate: false, hand: getHandById(handId)! };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Assumes a BEGIN IMMEDIATE transaction is already open — never opens or
// closes one itself, so it can run as the tail of submitBettingAction's own
// transaction (the normal path) or advanceHandStreet's (a lower-level,
// directly-testable entry point). Persists the fully-advanced state in one
// write, then settles in the same transaction if the hand has become
// terminal.
function advanceAndSettleIfNeeded(handId: number, startingState: HeadsUpBettingState): void {
  let state = startingState;
  while (shouldAdvanceStreet(state)) {
    const next = computeNextStreet(state.street);
    if (!next) break; // unreachable given shouldAdvanceStreet's own check; defensive only
    state = advanceBettingToNextStreet(state, next);
  }

  db.prepare("UPDATE poker_hands SET street = ?, version = ?, betting_json = ? WHERE id = ?").run(
    state.street,
    state.version,
    JSON.stringify(state),
    handId,
  );

  if (isReadyForSettlement(state)) {
    const settled = settleHandInOpenTransaction(handId);
    if (!settled.ok) {
      // isReadyForSettlement and settleHand's own terminal check share the
      // exact same rule (poker/settlement.ts's isHandTerminal), and nothing
      // else could have settled this hand already within this same
      // serialized transaction — reaching here would mean a real bug, not
      // an expected race, so it's surfaced loudly rather than swallowed.
      throw new Error(`hand ${handId} became ready for settlement but settlement failed: ${settled.reason}`);
    }
  }
}

export type AdvanceHandStreetResult =
  | { readonly ok: true; readonly hand: PersistedHand }
  | { readonly ok: false; readonly reason: "hand_not_active" | "betting_not_complete" };

// A lower-level, directly-testable entry point: transactionally advances a
// hand to its next street once betting on the current street is complete,
// resetting the pure engine's own street-specific fields (see poker/
// betting.ts's advanceToNextStreet) while preserving total hand
// contributions. Like submitBettingAction, this then cascades through any
// further streets an all-in runout requires and settles automatically if
// the hand becomes terminal, all in this same transaction — manually
// advancing one street never leaves a runout half-finished. Does not deal
// or reveal any card by itself — community cards remain purely a read-time
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

    const advanced = advanceBettingToNextStreet(currentState, nextStreet);
    advanceAndSettleIfNeeded(handId, advanced);

    db.exec("COMMIT");
    return { ok: true, hand: getHandById(handId)! };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type SettlePersistedHandResult =
  | { readonly ok: true; readonly hand: PersistedHand; readonly plan: SettlementPlan }
  | {
      readonly ok: false;
      readonly reason: SettlementRejectionReason | "hand_not_found" | "already_settled";
    };

// Assumes a BEGIN IMMEDIATE transaction is already open — the caller is
// responsible for COMMIT/ROLLBACK. Never opens or closes one itself, so it
// can run either as the tail of advanceAndSettleIfNeeded's own transaction
// (the normal path: a hand settles in the SAME transaction as the action
// that completed it) or inside settlePersistedHand's own transaction below
// (a standalone entry point, kept for recovery/testing — in normal
// operation a hand always settles automatically and this is never needed).
//
// Re-derives everything fresh from the database rather than trusting any
// state the caller already has in memory, matching this project's existing
// transaction discipline. Exactly-once is enforced by the `WHERE status =
// 'active'` clause on the final UPDATE below: inside a serialized BEGIN
// IMMEDIATE transaction it can only ever match once for a given hand, so a
// second concurrent settlement attempt (whatever triggered it) updates zero
// rows rather than crediting chips twice. This is a real SQLite guarantee,
// not an in-process flag — two processes both attempting to settle the
// same hand serialize on the same exclusive lock, and whichever commits
// second sees status already 'settled' and no-ops.
function settleHandInOpenTransaction(
  handId: number,
): { ok: true; plan: SettlementPlan } | { ok: false; reason: SettlementRejectionReason | "hand_not_found" | "already_settled" } {
  const row = getHandRowById(handId);
  if (!row) return { ok: false, reason: "hand_not_found" };
  if (row.status === "settled") return { ok: false, reason: "already_settled" };

  const state = JSON.parse(row.betting_json) as HeadsUpBettingState;
  const holeCards = getHoleCardsForSettlement(handId);
  const communityCards = getCommunityCardsFromRow(row);

  const settlement = settleHand({ bettingState: state, holeCards, communityCards });
  if (!settlement.ok) {
    return { ok: false, reason: settlement.reason };
  }

  // Defensive, should be unreachable given the pure settlement engine's own
  // guarantees — refuses to ever apply a payout that isn't chip-neutral,
  // rather than silently trusting it.
  if (settlement.plan.totalChipsAfter !== settlement.plan.totalChipsBefore) {
    throw new Error(
      `settlement chip conservation violated for hand ${handId}: before=${settlement.plan.totalChipsBefore} after=${settlement.plan.totalChipsAfter}`,
    );
  }

  db.prepare("UPDATE poker_seats SET chip_stack = ? WHERE table_id = ? AND seat_number = 1").run(
    settlement.plan.finalStacks[1],
    row.table_id,
  );
  db.prepare("UPDATE poker_seats SET chip_stack = ? WHERE table_id = ? AND seat_number = 2").run(
    settlement.plan.finalStacks[2],
    row.table_id,
  );

  const update = db
    .prepare(
      `UPDATE poker_hands SET status = 'settled', settled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1
       WHERE id = ? AND status = 'active'`,
    )
    .run(handId);
  if (update.changes === 0) {
    // Cannot actually happen under BEGIN IMMEDIATE — included so this
    // function never silently claims success if it somehow did.
    return { ok: false, reason: "already_settled" };
  }

  return { ok: true, plan: settlement.plan };
}

// Standalone settlement entry point, for recovery/testing: in normal
// operation, every hand settles automatically in the same transaction as
// the action that completed it (see advanceAndSettleIfNeeded), so this is
// never required for ordinary play. It exists for the case where a hand
// was somehow left terminal-but-unsettled (e.g. exercising the exactly-once
// guarantee directly, or a future recovery sweep).
export function settlePersistedHand(handId: number): SettlePersistedHandResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = settleHandInOpenTransaction(handId);
    if (!result.ok) {
      db.exec("ROLLBACK");
      return result;
    }
    db.exec("COMMIT");
    return { ok: true, hand: getHandById(handId)!, plan: result.plan };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type GetSettlementPlanResult =
  | { readonly ok: true; readonly plan: SettlementPlan }
  | { readonly ok: false; readonly reason: SettlementRejectionReason | "hand_not_found" };

// Deterministically reconstructs the settlement plan for a terminal hand
// (settled or not) from its own already-persisted data. No settlement
// result is separately stored anywhere: betting_json, deck_json, and each
// player's hole_cards_json are already there, and — once a hand is no
// longer active — immutable, so recomputing on demand is simpler and
// avoids a second, independently-stored copy of purely derived information
// that could in principle drift from the data it was derived from. This is
// the "minimal necessary schema" choice: no new column or table was added
// for Slice 4B.
export function getSettlementPlanForHand(handId: number): GetSettlementPlanResult {
  const row = getHandRowById(handId);
  if (!row) return { ok: false, reason: "hand_not_found" };
  const state = JSON.parse(row.betting_json) as HeadsUpBettingState;
  const holeCards = getHoleCardsForSettlement(handId);
  const communityCards = getCommunityCardsFromRow(row);
  const result = settleHand({ bettingState: state, holeCards, communityCards });
  return result.ok ? { ok: true, plan: result.plan } : { ok: false, reason: result.reason };
}

// The one safe way to reveal BOTH players' hole cards for a showdown
// display: returns undefined for anything but an already-settled hand (an
// active hand reveals nothing here, full stop), and even once settled,
// never includes a seat that folded — a fold conceals a player's cards
// forever, win or lose, exactly like at a real table. An uncontested
// (fold) win reveals nobody's cards: there was no showdown to reveal.
// Internal hole_cards_json rows are still only ever read here and in
// getOwnHoleCards/getHoleCardsForSettlement — never returned as raw rows.
export function getShowdownHoleCards(handId: number): Partial<Record<PokerSeatNumber, Card[]>> | undefined {
  const row = getHandRowById(handId);
  if (!row || row.status !== "settled") return undefined;

  const state = JSON.parse(row.betting_json) as HeadsUpBettingState;
  const revealed: Partial<Record<PokerSeatNumber, Card[]>> = {};
  if (state.handOutcome === "uncontested") return revealed; // fold win: nothing to reveal

  const rows = db
    .prepare("SELECT seat_number, hole_cards_json FROM poker_hand_players WHERE hand_id = ?")
    .all(handId) as { seat_number: number; hole_cards_json: string }[];
  for (const r of rows) {
    const seat = r.seat_number as PokerSeatNumber;
    if (!state.seats[seat].folded) {
      revealed[seat] = JSON.parse(r.hole_cards_json) as Card[];
    }
  }
  return revealed;
}

// --- Card Clash domain: rooms, seats, and persistent match state (D3A) ------
// Independent of both the strategy-war and poker tables above: a Card Clash
// room is not a renamed poker table, and this module never implements any
// Card Clash RULE itself — rules live entirely in card-clash/engine.ts,
// card-clash/combat.ts, card-clash/effects.ts, and card-clash/group-
// effects.ts. This section only serializes/deserializes that pure engine's
// own MatchState and enforces the transactional/version/idempotency
// contract around it — exactly poker's own division of responsibility
// between poker/*.ts and this file.

// Exported so the HTTP layer (server.ts) can compute a room's required seat
// count for lobby metadata without duplicating this table.
export const CARD_CLASH_SEAT_COUNT: Readonly<Record<CardClashMode, number>> = { "1v1": 2, "1v2": 3, "2v2": 4 };

// A separate code generator from poker's (not shared code, not a shared
// uniqueness domain) — a Card Clash room is not a renamed poker table, and
// nothing here depends on poker's own generateTableCode.
const CARD_CLASH_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CARD_CLASH_CODE_LENGTH = 8;

function generateCardClashRoomCode(): string {
  const bytes = randomBytes(CARD_CLASH_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CARD_CLASH_CODE_LENGTH; i++) {
    code += CARD_CLASH_CODE_ALPHABET[bytes[i] % CARD_CLASH_CODE_ALPHABET.length];
  }
  return code;
}

export interface CardClashRoom {
  readonly id: number;
  readonly code: string;
  readonly mode: CardClashMode;
  readonly status: "waiting" | "active" | "complete";
}

function toCardClashRoom(row: { id: number; code: string; mode: string; status: string }): CardClashRoom {
  return { id: row.id, code: row.code, mode: row.mode as CardClashMode, status: row.status as CardClashRoom["status"] };
}

// Creates the room and seats the host at seat 1 atomically — the host
// permanently occupies seat 1 for the room's lifetime (docs/card-clash-
// rules.md §1: "The host occupies Seat 1 and acts first"). Mode is
// immutable from this point on: nothing in this module ever updates
// card_clash_rooms.mode.
export function createCardClashRoom(mode: CardClashMode, hostIdentityId: number): CardClashRoom {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateCardClashRoomCode();
    db.exec("BEGIN IMMEDIATE");
    try {
      const info = db.prepare("INSERT INTO card_clash_rooms (code, mode) VALUES (?, ?)").run(code, mode);
      const roomId = Number(info.lastInsertRowid);
      db.prepare("INSERT INTO card_clash_seats (room_id, identity_id, seat_number, ready) VALUES (?, ?, 1, 0)").run(
        roomId,
        hostIdentityId,
      );
      db.exec("COMMIT");
      return { id: roomId, code, mode, status: "waiting" };
    } catch (err) {
      db.exec("ROLLBACK");
      if (isUniqueConstraintViolation(err)) continue;
      throw err;
    }
  }
  throw new Error("failed to generate a unique card clash room code");
}

export function getCardClashRoomByCode(code: string): CardClashRoom | undefined {
  const row = db.prepare("SELECT id, code, mode, status FROM card_clash_rooms WHERE code = ?").get(code) as
    | { id: number; code: string; mode: string; status: string }
    | undefined;
  return row ? toCardClashRoom(row) : undefined;
}

export interface CardClashSeat {
  readonly roomId: number;
  readonly identityId: number;
  readonly seatNumber: number;
  readonly ready: boolean;
}

function toCardClashSeat(row: { room_id: number; identity_id: number; seat_number: number; ready: number }): CardClashSeat {
  return { roomId: row.room_id, identityId: row.identity_id, seatNumber: row.seat_number, ready: row.ready === 1 };
}

// Room/seat metadata only — deliberately never joined with match state
// (getCardClashMatchForRoom below is a separate call): private hands and
// deck order must never be automatically bundled into public room data.
export function getCardClashSeatsForRoom(roomId: number): CardClashSeat[] {
  const rows = db
    .prepare(
      `SELECT room_id AS roomId, identity_id AS identityId, seat_number AS seatNumber, ready
       FROM card_clash_seats WHERE room_id = ? ORDER BY seat_number`,
    )
    .all(roomId) as unknown as { roomId: number; identityId: number; seatNumber: number; ready: number }[];
  return rows.map((r) => ({ roomId: r.roomId, identityId: r.identityId, seatNumber: r.seatNumber, ready: r.ready === 1 }));
}

export function getCardClashSeatForIdentity(roomId: number, identityId: number): CardClashSeat | undefined {
  const row = db
    .prepare(
      `SELECT room_id, identity_id, seat_number, ready
       FROM card_clash_seats WHERE room_id = ? AND identity_id = ?`,
    )
    .get(roomId, identityId) as { room_id: number; identity_id: number; seat_number: number; ready: number } | undefined;
  return row ? toCardClashSeat(row) : undefined;
}

export type JoinCardClashRoomResult =
  | { readonly ok: true; readonly alreadyJoined: boolean; readonly seatNumber: number }
  | { readonly ok: false; readonly reason: "room_not_found" | "room_already_started" | "room_full" };

// Joining an already-claimed seat with the SAME identity is a reconnect
// (idempotent, not a second join — docs §3); concurrency safety for a
// genuinely new seat comes from UNIQUE(room_id, seat_number) and
// UNIQUE(room_id, identity_id), the same pattern poker's joinPokerTable
// already uses — two concurrent joins can both pass the pre-check, but
// only one INSERT can win, and the loser's constraint violation is what
// this function treats as "full".
export function joinCardClashRoom(roomId: number, identityId: number): JoinCardClashRoomResult {
  const existing = getCardClashSeatForIdentity(roomId, identityId);
  if (existing) {
    return { ok: true, alreadyJoined: true, seatNumber: existing.seatNumber };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const room = db.prepare("SELECT mode, status FROM card_clash_rooms WHERE id = ?").get(roomId) as
      | { mode: string; status: string }
      | undefined;
    if (!room) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "room_not_found" };
    }
    if (room.status !== "waiting") {
      db.exec("ROLLBACK");
      return { ok: false, reason: "room_already_started" };
    }

    const seatRows = db.prepare("SELECT seat_number FROM card_clash_seats WHERE room_id = ?").all(roomId) as {
      seat_number: number;
    }[];
    const takenSeats = new Set(seatRows.map((r) => r.seat_number));
    const requiredSeats = CARD_CLASH_SEAT_COUNT[room.mode as CardClashMode];

    let nextSeat: number | undefined;
    for (let s = 1; s <= requiredSeats; s++) {
      if (!takenSeats.has(s)) {
        nextSeat = s;
        break;
      }
    }
    if (nextSeat === undefined) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "room_full" };
    }

    db.prepare("INSERT INTO card_clash_seats (room_id, identity_id, seat_number, ready) VALUES (?, ?, ?, 0)").run(
      roomId,
      identityId,
      nextSeat,
    );
    db.exec("COMMIT");
    return { ok: true, alreadyJoined: false, seatNumber: nextSeat };
  } catch (err) {
    db.exec("ROLLBACK");
    if (isUniqueConstraintViolation(err)) {
      return { ok: false, reason: "room_full" };
    }
    throw err;
  }
}

export type SetCardClashReadyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_a_player" | "room_already_started" };

// Every seated player, including the host, may freely toggle their own
// readiness while the room is still waiting (docs §4) — there is no
// separate "ready" concept once the match has started.
export function setCardClashSeatReady(roomId: number, identityId: number, ready: boolean): SetCardClashReadyResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const room = db.prepare("SELECT status FROM card_clash_rooms WHERE id = ?").get(roomId) as
      | { status: string }
      | undefined;
    if (!room || room.status !== "waiting") {
      db.exec("ROLLBACK");
      return { ok: false, reason: "room_already_started" };
    }
    const seat = db.prepare("SELECT id FROM card_clash_seats WHERE room_id = ? AND identity_id = ?").get(
      roomId,
      identityId,
    ) as { id: number } | undefined;
    if (!seat) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_a_player" };
    }
    db.prepare("UPDATE card_clash_seats SET ready = ? WHERE id = ?").run(ready ? 1 : 0, seat.id);
    db.exec("COMMIT");
    return { ok: true };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface PersistedCardClashMatch {
  readonly id: number;
  readonly roomId: number;
  readonly version: number;
  readonly state: CardClashMatchState;
}

interface CardClashMatchRow {
  id: number;
  room_id: number;
  version: number;
  state_json: string;
}

// MatchState.players is a Map, which JSON.stringify silently turns into
// "{}" — serialized here as an ordered array of [seat, PlayerState] tuples
// instead, so every field (including nested pending/rescue/group contexts,
// the public event log, and each card's own stable id) round-trips through
// JSON exactly, with no loss of card identity or order.
function serializeCardClashMatchState(state: CardClashMatchState): string {
  return JSON.stringify({ ...state, players: [...state.players.entries()] });
}

function deserializeCardClashMatchState(json: string): CardClashMatchState {
  const raw = JSON.parse(json) as Omit<CardClashMatchState, "players"> & { players: readonly [number, unknown][] };
  return { ...raw, players: new Map(raw.players) } as CardClashMatchState;
}

function toPersistedCardClashMatch(row: CardClashMatchRow): PersistedCardClashMatch {
  return { id: row.id, roomId: row.room_id, version: row.version, state: deserializeCardClashMatchState(row.state_json) };
}

function getCardClashMatchRowById(matchId: number): CardClashMatchRow | undefined {
  return db.prepare("SELECT id, room_id, version, state_json FROM card_clash_matches WHERE id = ?").get(matchId) as
    | CardClashMatchRow
    | undefined;
}

export function getCardClashMatchById(matchId: number): PersistedCardClashMatch | undefined {
  const row = getCardClashMatchRowById(matchId);
  return row ? toPersistedCardClashMatch(row) : undefined;
}

export function getCardClashMatchForRoom(roomId: number): PersistedCardClashMatch | undefined {
  const row = db.prepare("SELECT id, room_id, version, state_json FROM card_clash_matches WHERE room_id = ?").get(
    roomId,
  ) as CardClashMatchRow | undefined;
  return row ? toPersistedCardClashMatch(row) : undefined;
}

// --- v2.6 action/response deadlines (D4C-1, docs/card-clash-rules.md §11) --

export interface PersistedCardClashDeadline {
  readonly matchId: number;
  readonly version: number;
  readonly expiresAt: number;
  readonly responderSeat: CardClashSeatNumber;
}

interface CardClashDeadlineRow {
  match_id: number;
  version: number;
  expires_at: number | null;
  responder_seat: number | null;
  active: number;
}

function getCardClashDeadlineRow(matchId: number): CardClashDeadlineRow | undefined {
  return db
    .prepare("SELECT match_id, version, expires_at, responder_seat, active FROM card_clash_deadlines WHERE match_id = ?")
    .get(matchId) as CardClashDeadlineRow | undefined;
}

function toPersistedCardClashDeadline(row: CardClashDeadlineRow | undefined): PersistedCardClashDeadline | undefined {
  if (!row || !row.active) return undefined;
  return {
    matchId: row.match_id,
    version: row.version,
    expiresAt: row.expires_at!,
    responderSeat: row.responder_seat as CardClashSeatNumber,
  };
}

// Only ever called from inside an already-open transaction (startCardClash-
// Match/applyCardClashTransition/processCardClashTimeout) — one row per
// match, replaced in place every time, never a growing history.
function upsertCardClashDeadlineInTx(matchId: number, version: number, deadline: CardClashDeadlineInfo | null): void {
  db.prepare(
    `INSERT INTO card_clash_deadlines (match_id, version, expires_at, responder_seat, active)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (match_id) DO UPDATE SET
       version = excluded.version,
       expires_at = excluded.expires_at,
       responder_seat = excluded.responder_seat,
       active = excluded.active`,
  ).run(matchId, version, deadline?.expiresAt ?? null, deadline?.responderSeat ?? null, deadline ? 1 : 0);
}

// Public read used by the scheduler (card-clash/scheduler.ts), tests, and
// read-only HTTP projections — undefined means "no timer currently applies"
// (terminal match, or the unresolved DISCARD block), never a real row with
// stale/garbage data.
export function getCardClashDeadline(matchId: number): PersistedCardClashDeadline | undefined {
  return toPersistedCardClashDeadline(getCardClashDeadlineRow(matchId));
}

// Startup-reconciliation support only: every match whose deadline row is
// currently marked active, paired with its room id (the scheduler needs
// both to re-arm a real timer and to publish to the right SSE room). Scoped
// to a small, bounded set — only matches with a live timer, never every
// match ever played.
export function listActiveCardClashDeadlineMatches(): { readonly matchId: number; readonly roomId: number }[] {
  const rows = db
    .prepare(
      `SELECT d.match_id AS match_id, m.room_id AS room_id
       FROM card_clash_deadlines d
       JOIN card_clash_matches m ON m.id = d.match_id
       WHERE d.active = 1`,
    )
    .all() as { match_id: number; room_id: number }[];
  return rows.map((r) => ({ matchId: r.match_id, roomId: r.room_id }));
}

export type StartCardClashMatchResult =
  | { readonly ok: true; readonly match: PersistedCardClashMatch; readonly deadline: PersistedCardClashDeadline | undefined }
  | {
      readonly ok: false;
      readonly reason: "room_not_found" | "not_the_host" | "seats_not_full" | "not_all_ready";
    };

// Atomically validates and starts a room's match: every required seat
// filled, every seated player ready, and only the host (always seat 1) may
// trigger it (docs §4). Calls the existing pure initializeMatch exactly
// once and persists its result — a repeated start attempt (room already
// 'active'/'complete') is treated as an idempotent no-op that returns the
// EXISTING match rather than erroring or generating a second hand/deck,
// mirroring poker's own createPokerHand "hand_already_active" precedent.
// `randomSource` exists only so this module's own tests can supply
// deterministic shuffling — every real caller omits it.
export function startCardClashMatch(
  roomId: number,
  hostIdentityId: number,
  randomSource?: RandomInt,
  nowMs: number = Date.now(),
): StartCardClashMatchResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const room = db.prepare("SELECT mode, status FROM card_clash_rooms WHERE id = ?").get(roomId) as
      | { mode: string; status: string }
      | undefined;
    if (!room) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "room_not_found" };
    }

    if (room.status !== "waiting") {
      const existingRow = db
        .prepare("SELECT id, room_id, version, state_json FROM card_clash_matches WHERE room_id = ?")
        .get(roomId) as CardClashMatchRow | undefined;
      if (!existingRow) {
        db.exec("ROLLBACK");
        throw new Error(`card clash room ${roomId} is marked started but has no persisted match`);
      }
      const existingDeadline = toPersistedCardClashDeadline(getCardClashDeadlineRow(existingRow.id));
      db.exec("ROLLBACK"); // read-only path: nothing was written
      return { ok: true, match: toPersistedCardClashMatch(existingRow), deadline: existingDeadline };
    }

    const seatRows = db.prepare("SELECT seat_number, identity_id, ready FROM card_clash_seats WHERE room_id = ?").all(
      roomId,
    ) as { seat_number: number; identity_id: number; ready: number }[];

    const requiredSeats = CARD_CLASH_SEAT_COUNT[room.mode as CardClashMode];
    if (seatRows.length < requiredSeats) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "seats_not_full" };
    }

    const hostSeat = seatRows.find((s) => s.seat_number === 1);
    if (!hostSeat || hostSeat.identity_id !== hostIdentityId) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_the_host" };
    }

    if (!seatRows.every((s) => s.ready === 1)) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_all_ready" };
    }

    const initialState = initializeCardClashMatch({ mode: room.mode as CardClashMode, randomSource });
    const info = db
      .prepare("INSERT INTO card_clash_matches (room_id, version, state_json) VALUES (?, ?, ?)")
      .run(roomId, initialState.version, serializeCardClashMatchState(initialState));
    const matchId = Number(info.lastInsertRowid);
    db.prepare("UPDATE card_clash_rooms SET status = 'active' WHERE id = ?").run(roomId);

    // Starting a match always creates its first actionable deadline too
    // (docs §11/D4C-1 task spec) — seat 1's own first 10-second MAIN
    // window, computed the same way every subsequent one is.
    const initialDeadline = computeNextCardClashDeadline(initialState, nowMs);
    upsertCardClashDeadlineInTx(matchId, initialState.version, initialDeadline);

    db.exec("COMMIT");
    return {
      ok: true,
      match: { id: matchId, roomId, version: initialState.version, state: initialState },
      deadline: initialDeadline ? { matchId, version: initialState.version, ...initialDeadline } : undefined,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type ApplyCardClashTransitionResult =
  | { readonly ok: true; readonly duplicate: true; readonly match: PersistedCardClashMatch }
  | {
      readonly ok: true;
      readonly duplicate: false;
      readonly match: PersistedCardClashMatch;
      // The deadline now in effect for the resulting state — already
      // persisted atomically alongside it (D4C-1). null means no timer
      // currently applies (terminal match, or an unresolved DISCARD block).
      // Never present on a duplicate reply: nothing changed, so there is no
      // "new" deadline to report.
      readonly nextDeadline: CardClashDeadlineInfo | null;
    }
  | {
      readonly ok: false;
      readonly reason: "match_not_found" | "stale_version" | "request_id_conflict" | "transition_rejected" | "deadline_expired";
      readonly detail?: unknown;
    };

export interface ApplyCardClashTransitionParams {
  readonly matchId: number;
  readonly requestId: string;
  readonly expectedVersion: number;
  // Server-captured wall-clock time this transition is committing at — used
  // only to compute the resulting deadline (never trusted from a client).
  // Defaults to the real clock; tests may inject a fixed value.
  readonly nowMs?: number;
  // A TRUSTED pure-engine transition — e.g. `(state) => playAttack(state,
  // seat, target, expectedVersion)` from card-clash/combat.ts. This module
  // never inspects or validates what kind of action is being taken; that is
  // entirely the pure engine's job. It only guarantees the transaction/
  // version/idempotency contract around whatever transition the caller
  // supplies, and never accepts a raw client-supplied MatchState as the new
  // authoritative state — the new state can only ever come from calling
  // this function against the state this module itself just read from the
  // database.
  readonly transition: (
    state: CardClashMatchState,
  ) => { readonly ok: true; readonly state: CardClashMatchState } | { readonly ok: false; readonly reason: unknown };
}

// The full exactly-once, transactional transition contract for Card Clash,
// mirroring poker's submitBettingAction: re-reads the authoritative state
// fresh inside the transaction, treats a repeated request_id as an
// idempotent no-op (returning the current persisted match rather than
// reapplying), and — only if every check passes — writes the entire new
// state atomically in one UPDATE, so public events and game state can never
// commit independently and drift apart.
//
// This generic layer has no visibility into what a specific transition
// actually does, so its "conflict" detection is necessarily version-based
// (the same request_id reused with a different expectedVersion), not
// content-aware the way poker's seat/action/amount comparison is — a
// documented, deliberate limitation of this intentionally action-agnostic
// interface, not an oversight.
export function applyCardClashTransition(params: ApplyCardClashTransitionParams): ApplyCardClashTransitionResult {
  const { matchId, requestId, expectedVersion, transition } = params;

  db.exec("BEGIN IMMEDIATE");
  try {
    // Decision time is read only AFTER the write lock is held (production),
    // so no earlier HTTP-request timestamp can make an expired action look
    // valid. `params.nowMs` exists solely for deterministic test clocks.
    const nowMs = params.nowMs ?? Date.now();
    const row = getCardClashMatchRowById(matchId);
    if (!row) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "match_not_found" };
    }

    const existingAction = db
      .prepare("SELECT expected_version FROM card_clash_match_actions WHERE match_id = ? AND request_id = ?")
      .get(matchId, requestId) as { expected_version: number } | undefined;
    if (existingAction) {
      db.exec("ROLLBACK"); // read-only path either way: duplicate or conflict, nothing to write
      if (existingAction.expected_version !== expectedVersion) {
        return { ok: false, reason: "request_id_conflict" };
      }
      return { ok: true, duplicate: true, match: toPersistedCardClashMatch(row) };
    }

    if (row.version !== expectedVersion) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "stale_version" };
    }

    // Authoritative deadline recheck inside this same transaction, BEFORE
    // the pure transition runs: an active deadline for this exact version
    // that has already passed (now >= expires_at) rejects the action with
    // no mutation. An inactive row (terminal match / manual DISCARD block)
    // never blocks.
    const activeDeadline = toPersistedCardClashDeadline(getCardClashDeadlineRow(matchId));
    if (activeDeadline && activeDeadline.version === row.version && nowMs >= activeDeadline.expiresAt) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "deadline_expired" };
    }

    const currentState = deserializeCardClashMatchState(row.state_json);
    const result = transition(currentState);
    if (!result.ok) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "transition_rejected", detail: result.reason };
    }

    const newStateJson = serializeCardClashMatchState(result.state);
    db.prepare(
      `UPDATE card_clash_matches SET version = ?, state_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND version = ?`,
    ).run(result.state.version, newStateJson, matchId, expectedVersion);
    db.prepare(
      "INSERT INTO card_clash_match_actions (match_id, request_id, expected_version, resulting_version) VALUES (?, ?, ?, ?)",
    ).run(matchId, requestId, expectedVersion, result.state.version);

    if (result.state.matchResult.status === "complete") {
      db.prepare("UPDATE card_clash_rooms SET status = 'complete' WHERE id = ?").run(row.room_id);
    }

    // Deadline and match state commit atomically, in the same transaction —
    // a successful gameplay transition always either persists the next
    // applicable deadline or explicitly records that none applies right now
    // (D4C-1 task spec §4).
    // A DISCARD phase continuing across a partial manual discard keeps its
    // ORIGINAL absolute deadline (one 10 s window for the whole phase).
    const preserve =
      currentState.turnPhase === "discard" && result.state.turnPhase === "discard" && activeDeadline
        ? { responderSeat: activeDeadline.responderSeat, expiresAt: activeDeadline.expiresAt }
        : undefined;
    const nextDeadline = computeNextCardClashDeadline(result.state, nowMs, preserve);
    upsertCardClashDeadlineInTx(matchId, result.state.version, nextDeadline);

    db.exec("COMMIT");
    return {
      ok: true,
      duplicate: false,
      match: { id: matchId, roomId: row.room_id, version: result.state.version, state: result.state },
      nextDeadline,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface ProcessCardClashTimeoutResult {
  // True only if the pure engine's own MatchState actually changed (an
  // end-turn or a decline really applied). False for every no-op: match not
  // found, the persisted deadline no longer matches `expectedVersion` (it
  // was superseded by a real action or an earlier timeout — docs §11 "an
  // expired action and a valid action... must never both succeed"), the
  // deadline isn't actually due yet as of `nowMs`, or the one legal timeout
  // transition for this phase was itself a no-op (the DISCARD-block case).
  // Never broadcast a `changed: false` result as if something happened.
  readonly applied: boolean;
  readonly match: PersistedCardClashMatch | undefined;
  // Whatever the database now says is current for this match — present
  // even when `applied` is false, so a caller (the scheduler) can always
  // re-arm its real timer against the authoritative row rather than
  // guessing.
  readonly nextDeadline: CardClashDeadlineInfo | null;
}

// The one entry point that ever applies an AUTOMATIC timeout transition —
// never a client-authorized action (docs §9 "do not expose a client
// endpoint that allows players to force another player's timeout"). Shares
// the exact same re-read-inside-the-transaction/version-check/atomic-commit
// discipline as applyCardClashTransition above, but keyed on "is the
// persisted deadline for this exact version still due as of `nowMs`"
// instead of a client requestId — `expectedVersion` here is whatever
// version the deadline was scheduled against (captured by the caller at
// schedule time), so an obsolete or duplicate callback for a version that
// has since moved on is guaranteed to find a mismatch and do nothing.
export function processCardClashTimeout(
  matchId: number,
  expectedVersion: number,
  nowMs: number,
  randomSource?: RandomInt,
): ProcessCardClashTimeoutResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = getCardClashMatchRowById(matchId);
    if (!row) {
      db.exec("ROLLBACK");
      return { applied: false, match: undefined, nextDeadline: null };
    }

    const deadlineRow = getCardClashDeadlineRow(matchId);
    const currentDeadline = toPersistedCardClashDeadline(deadlineRow);
    const isDue =
      currentDeadline !== undefined &&
      currentDeadline.version === row.version &&
      currentDeadline.version === expectedVersion &&
      currentDeadline.expiresAt <= nowMs;

    if (!isDue) {
      db.exec("ROLLBACK"); // read-only path: stale, not-yet-due, or already superseded
      return {
        applied: false,
        match: toPersistedCardClashMatch(row),
        nextDeadline: currentDeadline ? { responderSeat: currentDeadline.responderSeat, expiresAt: currentDeadline.expiresAt } : null,
      };
    }

    const currentState = deserializeCardClashMatchState(row.state_json);
    const outcome = applyCardClashTimeoutTransition(currentState, currentDeadline!.responderSeat, randomSource);

    let finalState = currentState;
    if (outcome.changed) {
      finalState = outcome.state;
      db.prepare(
        `UPDATE card_clash_matches SET version = ?, state_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND version = ?`,
      ).run(finalState.version, serializeCardClashMatchState(finalState), matchId, row.version);

      if (finalState.matchResult.status === "complete") {
        db.prepare("UPDATE card_clash_rooms SET status = 'complete' WHERE id = ?").run(row.room_id);
      }
    }

    // Always re-persist the deadline row, even when the transition was a
    // no-op: an unresolved DISCARD block must flip to inactive so this same
    // obsolete callback (and the scheduler's own next wake-up) stops seeing
    // it as due forever — see computeNextCardClashDeadline.
    const nextDeadline = computeNextCardClashDeadline(finalState, nowMs);
    upsertCardClashDeadlineInTx(matchId, finalState.version, nextDeadline);

    db.exec("COMMIT");
    return {
      applied: outcome.changed,
      match: { id: matchId, roomId: row.room_id, version: finalState.version, state: finalState },
      nextDeadline,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
