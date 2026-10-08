import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// These tests exercise db.ts's schema migration directly, against a
// synthetic pre-existing database file — not through the running app over
// HTTP (unlike every other spec file here). They don't need `baseUrl`.
//
// The strategy-war product's own business-logic functions (getCampaignByCode
// etc.) were removed from db.ts along with its HTTP routes when the project
// pivoted to poker (see docs/poker-final-architecture.md). What must still
// hold is that the v1 -> v2 -> v3 -> v4 migration chain itself keeps
// producing exactly the same schema and data it always did, since an old
// deployment's database must never be silently reinterpreted or lose data.
// Assertions below read the migrated tables with plain SQL instead, so this
// file verifies the migration's actual on-disk effect rather than going
// through application code that no longer exists.

let tempDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "gs-migration-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

// Builds a database exactly as Slice 3 (schema version 2) would have left
// it: no countries/tiles/buildings tables exist at all yet. One campaign is
// still configuring (one seat filled); the other is already `started`,
// which Slice 3's schema allowed even without any world tables existing.
function buildV2Database(dir: string): void {
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE identities (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'configuring',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      resource_preset TEXT NOT NULL DEFAULT 'standard',
      settings_revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      identity_id INTEGER NOT NULL REFERENCES identities(id),
      seat INTEGER NOT NULL CHECK (seat IN (1, 2)),
      is_host INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (campaign_id, seat),
      UNIQUE (campaign_id, identity_id)
    );
    CREATE TABLE approvals (
      id INTEGER PRIMARY KEY,
      participant_id INTEGER NOT NULL REFERENCES participants(id),
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (participant_id, revision)
    );
  `);
  db.exec("PRAGMA user_version = 2");

  const hostA = db.prepare("INSERT INTO identities (token_hash) VALUES (?)").run("hash-a-host")
    .lastInsertRowid;
  db.prepare("INSERT INTO campaigns (code, status) VALUES (?, 'configuring')").run("CFGV2TST");
  const campaignAId = db.prepare("SELECT id FROM campaigns WHERE code = ?").get("CFGV2TST") as {
    id: number;
  };
  db.prepare("INSERT INTO participants (campaign_id, identity_id, seat, is_host) VALUES (?, ?, 1, 1)").run(
    campaignAId.id,
    hostA,
  );

  const hostB = db.prepare("INSERT INTO identities (token_hash) VALUES (?)").run("hash-b-host")
    .lastInsertRowid;
  const joinerB = db.prepare("INSERT INTO identities (token_hash) VALUES (?)").run("hash-b-joiner")
    .lastInsertRowid;
  db.prepare(
    "INSERT INTO campaigns (code, status, resource_preset, settings_revision) VALUES (?, 'started', 'rapid', 2)",
  ).run("STARTEDV2");
  const campaignBId = db.prepare("SELECT id FROM campaigns WHERE code = ?").get("STARTEDV2") as {
    id: number;
  };
  const pHost = db
    .prepare("INSERT INTO participants (campaign_id, identity_id, seat, is_host) VALUES (?, ?, 1, 1)")
    .run(campaignBId.id, hostB).lastInsertRowid;
  const pJoin = db
    .prepare("INSERT INTO participants (campaign_id, identity_id, seat, is_host) VALUES (?, ?, 2, 0)")
    .run(campaignBId.id, joinerB).lastInsertRowid;
  db.prepare("INSERT INTO approvals (participant_id, revision) VALUES (?, 2)").run(pHost);
  db.prepare("INSERT INTO approvals (participant_id, revision) VALUES (?, 2)").run(pJoin);

  db.close();
}

// vi.resetModules() clears Vitest's own module registry so the next dynamic
// import re-evaluates db.ts from scratch (fresh top-level migration run)
// against whatever DATA_DIR is currently set, rather than returning the
// cached instance from an earlier import in this process. The import's
// return value is only ever used for its side effect (running migrations);
// assertions read the resulting file directly, below.
async function runMigrations(): Promise<void> {
  vi.resetModules();
  await import("../db.ts");
}

// Opens a short-lived raw connection to the already-migrated database file
// to read it with plain SQL, independent of any db.ts-exported business
// logic (none of which exists for the strategy-war tables any more).
function openMigratedDb(dir: string): DatabaseSync {
  return new DatabaseSync(join(dir, "app.sqlite"));
}

interface RawCampaign {
  id: number;
  code: string;
  status: string;
  resourcePreset: string;
  settingsRevision: number;
}

function readCampaign(raw: DatabaseSync, code: string): RawCampaign | undefined {
  return raw
    .prepare(
      `SELECT id, code, status, resource_preset AS resourcePreset, settings_revision AS settingsRevision
       FROM campaigns WHERE code = ?`,
    )
    .get(code) as RawCampaign | undefined;
}

interface RawParticipant {
  campaignId: number;
  identityId: number;
  seat: number;
  isHost: number;
}

function readParticipants(raw: DatabaseSync, campaignId: number): RawParticipant[] {
  return raw
    .prepare(
      `SELECT campaign_id AS campaignId, identity_id AS identityId, seat, is_host AS isHost
       FROM participants WHERE campaign_id = ? ORDER BY seat`,
    )
    .all(campaignId) as unknown as RawParticipant[];
}

interface RawCountry {
  id: number;
  seat: number;
  resourceBalance: number;
}

interface RawTile {
  row: number;
  col: number;
  ownerCountryId: number | null;
}

interface RawBuilding {
  countryId: number;
  type: string;
  row: number;
  col: number;
  settlementCursorMs: number | null;
}

interface RawWorld {
  countries: RawCountry[];
  tiles: RawTile[];
  buildings: RawBuilding[];
}

function readWorld(raw: DatabaseSync, campaignId: number): RawWorld {
  const countries = raw
    .prepare(
      "SELECT id, seat, resource_balance AS resourceBalance FROM countries WHERE campaign_id = ? ORDER BY seat",
    )
    .all(campaignId) as unknown as RawCountry[];
  const tiles = raw
    .prepare("SELECT row, col, owner_country_id AS ownerCountryId FROM tiles WHERE campaign_id = ? ORDER BY row, col")
    .all(campaignId) as unknown as RawTile[];
  const buildings = raw
    .prepare(
      `SELECT b.country_id AS countryId, b.type AS type,
              b.settlement_cursor_ms AS settlementCursorMs, t.row AS row, t.col AS col
       FROM buildings b JOIN tiles t ON t.id = b.tile_id WHERE t.campaign_id = ?`,
    )
    .all(campaignId) as unknown as RawBuilding[];
  return { countries, tiles, buildings };
}

it("a v2 campaign still configuring receives no world when migrated to v3", async () => {
  buildV2Database(tempDir);
  await runMigrations();
  const raw = openMigratedDb(tempDir);

  const campaign = readCampaign(raw, "CFGV2TST");
  expect(campaign).toBeTruthy();
  expect(campaign?.status).toBe("configuring");

  const world = readWorld(raw, campaign!.id);
  expect(world.countries).toHaveLength(0);
  expect(world.tiles).toHaveLength(0);
  expect(world.buildings).toHaveLength(0);
  raw.close();
});

it("an already-started v2 campaign is backfilled with the deterministic world on migration to v3, unchanged otherwise", async () => {
  buildV2Database(tempDir);
  await runMigrations();
  const raw = openMigratedDb(tempDir);

  const campaign = readCampaign(raw, "STARTEDV2");
  expect(campaign).toBeTruthy();
  // Untouched by the migration: status, preset and revision are exactly
  // what the v2 database already had.
  expect(campaign?.status).toBe("started");
  expect(campaign?.resourcePreset).toBe("rapid");
  expect(campaign?.settingsRevision).toBe(2);

  const participants = readParticipants(raw, campaign!.id);
  expect(participants).toHaveLength(2);
  expect(participants.find((p) => p.seat === 1)?.isHost).toBe(1);
  expect(participants.find((p) => p.seat === 2)?.isHost).toBe(0);

  const world = readWorld(raw, campaign!.id);
  expect(world.countries).toHaveLength(2);
  expect(world.tiles).toHaveLength(64);
  expect(world.buildings).toHaveLength(2);

  const seatByCountryId = new Map(world.countries.map((c) => [c.id, c.seat]));
  const hq1 = world.buildings.find((b) => seatByCountryId.get(b.countryId) === 1);
  const hq2 = world.buildings.find((b) => seatByCountryId.get(b.countryId) === 2);
  expect(hq1).toMatchObject({ row: 0, col: 0, type: "headquarters" });
  expect(hq2).toMatchObject({ row: 7, col: 7, type: "headquarters" });

  const seat1Tiles = world.tiles.filter(
    (t) => t.ownerCountryId !== null && seatByCountryId.get(t.ownerCountryId) === 1,
  );
  const seat2Tiles = world.tiles.filter(
    (t) => t.ownerCountryId !== null && seatByCountryId.get(t.ownerCountryId) === 2,
  );
  expect(seat1Tiles).toHaveLength(4);
  expect(seat2Tiles).toHaveLength(4);
  raw.close();
});

it("booting an already-migrated v3 database again does not duplicate the backfilled world", async () => {
  buildV2Database(tempDir);

  await runMigrations();
  const firstRaw = openMigratedDb(tempDir);
  const campaignFirst = readCampaign(firstRaw, "STARTEDV2")!;
  const worldFirst = readWorld(firstRaw, campaignFirst.id);
  expect(worldFirst.tiles).toHaveLength(64);
  firstRaw.close();

  // A second, independent import against the same on-disk database: schema
  // is already at version 3 (now 5), so the v2 -> v3 migration block must
  // not run again.
  await runMigrations();
  const secondRaw = openMigratedDb(tempDir);
  const campaignSecond = readCampaign(secondRaw, "STARTEDV2")!;
  const worldSecond = readWorld(secondRaw, campaignSecond.id);

  expect(worldSecond.countries).toHaveLength(2);
  expect(worldSecond.tiles).toHaveLength(64);
  expect(worldSecond.buildings).toHaveLength(2);
  secondRaw.close();
});

// --- Slice 6: schema version 3 -> 4 (resource balance + settlement cursor) --

// Builds a database exactly as Slice 5 (schema version 3) would have left
// it: countries/tiles/buildings exist, but neither `countries.resource_balance`
// nor `buildings.settlement_cursor_ms` do yet. One campaign is still
// configuring with no world at all; the other is `started` with a full 8x8
// world, both headquarters, and one pre-existing resource building whose
// `created_at` is set to a known, fixed, far-past timestamp.
const RESOURCE_BUILDING_CREATED_AT = "2020-01-01T00:00:00.000Z";

function buildV3Database(dir: string): void {
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE identities (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'configuring',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      resource_preset TEXT NOT NULL DEFAULT 'standard',
      settings_revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      identity_id INTEGER NOT NULL REFERENCES identities(id),
      seat INTEGER NOT NULL CHECK (seat IN (1, 2)),
      is_host INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (campaign_id, seat),
      UNIQUE (campaign_id, identity_id)
    );
    CREATE TABLE approvals (
      id INTEGER PRIMARY KEY,
      participant_id INTEGER NOT NULL REFERENCES participants(id),
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (participant_id, revision)
    );
    CREATE TABLE countries (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      seat INTEGER NOT NULL CHECK (seat IN (1, 2)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (campaign_id, seat)
    );
    CREATE TABLE tiles (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      row INTEGER NOT NULL CHECK (row BETWEEN 0 AND 7),
      col INTEGER NOT NULL CHECK (col BETWEEN 0 AND 7),
      owner_country_id INTEGER REFERENCES countries(id),
      UNIQUE (campaign_id, row, col)
    );
    CREATE TABLE buildings (
      id INTEGER PRIMARY KEY,
      tile_id INTEGER NOT NULL UNIQUE REFERENCES tiles(id),
      country_id INTEGER NOT NULL REFERENCES countries(id),
      type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE UNIQUE INDEX one_headquarters_per_country
      ON buildings(country_id)
      WHERE type = 'headquarters';
  `);
  db.exec("PRAGMA user_version = 3");

  // A campaign still configuring: no world at all, nothing to backfill.
  const configHost = db.prepare("INSERT INTO identities (token_hash) VALUES (?)").run("hash-v3-cfg-host")
    .lastInsertRowid;
  db.prepare("INSERT INTO campaigns (code, status) VALUES (?, 'configuring')").run("CFGV3TST");
  const configCampaignId = (
    db.prepare("SELECT id FROM campaigns WHERE code = ?").get("CFGV3TST") as { id: number }
  ).id;
  db.prepare("INSERT INTO participants (campaign_id, identity_id, seat, is_host) VALUES (?, ?, 1, 1)").run(
    configCampaignId,
    configHost,
  );

  // A started campaign with a full world, including one pre-existing
  // resource building with a known, fixed created_at.
  const host = db.prepare("INSERT INTO identities (token_hash) VALUES (?)").run("hash-v3-host")
    .lastInsertRowid;
  const joiner = db.prepare("INSERT INTO identities (token_hash) VALUES (?)").run("hash-v3-joiner")
    .lastInsertRowid;
  db.prepare("INSERT INTO campaigns (code, status) VALUES (?, 'started')").run("STARTEDV3");
  const campaignId = (db.prepare("SELECT id FROM campaigns WHERE code = ?").get("STARTEDV3") as {
    id: number;
  }).id;
  db.prepare("INSERT INTO participants (campaign_id, identity_id, seat, is_host) VALUES (?, ?, 1, 1)").run(
    campaignId,
    host,
  );
  db.prepare("INSERT INTO participants (campaign_id, identity_id, seat, is_host) VALUES (?, ?, 2, 0)").run(
    campaignId,
    joiner,
  );

  const country1Id = (
    db.prepare("INSERT INTO countries (campaign_id, seat) VALUES (?, 1)").run(campaignId) as unknown as {
      lastInsertRowid: number;
    }
  ).lastInsertRowid;
  const country2Id = (
    db.prepare("INSERT INTO countries (campaign_id, seat) VALUES (?, 2)").run(campaignId) as unknown as {
      lastInsertRowid: number;
    }
  ).lastInsertRowid;

  const hqTile1 = (
    db
      .prepare("INSERT INTO tiles (campaign_id, row, col, owner_country_id) VALUES (?, 0, 0, ?)")
      .run(campaignId, country1Id) as unknown as { lastInsertRowid: number }
  ).lastInsertRowid;
  const hqTile2 = (
    db
      .prepare("INSERT INTO tiles (campaign_id, row, col, owner_country_id) VALUES (?, 7, 7, ?)")
      .run(campaignId, country2Id) as unknown as { lastInsertRowid: number }
  ).lastInsertRowid;
  const resourceTile = (
    db
      .prepare("INSERT INTO tiles (campaign_id, row, col, owner_country_id) VALUES (?, 0, 1, ?)")
      .run(campaignId, country1Id) as unknown as { lastInsertRowid: number }
  ).lastInsertRowid;

  db.prepare("INSERT INTO buildings (tile_id, country_id, type) VALUES (?, ?, 'headquarters')").run(
    hqTile1,
    country1Id,
  );
  db.prepare("INSERT INTO buildings (tile_id, country_id, type) VALUES (?, ?, 'headquarters')").run(
    hqTile2,
    country2Id,
  );
  db.prepare(
    "INSERT INTO buildings (tile_id, country_id, type, created_at) VALUES (?, ?, 'resource', ?)",
  ).run(resourceTile, country1Id, RESOURCE_BUILDING_CREATED_AT);

  db.close();
}

it("a v3 configuring campaign migrates to v4 without inventing gameplay state", async () => {
  buildV3Database(tempDir);
  await runMigrations();
  const raw = openMigratedDb(tempDir);

  const campaign = readCampaign(raw, "CFGV3TST")!;
  expect(campaign.status).toBe("configuring");

  const world = readWorld(raw, campaign.id);
  expect(world.countries).toHaveLength(0);
  expect(world.tiles).toHaveLength(0);
  expect(world.buildings).toHaveLength(0);
  raw.close();
});

it("a v3 started world migrates to v4 intact: existing resource building gets a cursor from its own created_at, headquarters stay non-producing, country balances start at 0", async () => {
  buildV3Database(tempDir);
  await runMigrations();
  const raw = openMigratedDb(tempDir);

  const campaign = readCampaign(raw, "STARTEDV3")!;
  expect(campaign.status).toBe("started");

  const world = readWorld(raw, campaign.id);
  expect(world.countries).toHaveLength(2);
  for (const country of world.countries) {
    expect(country.resourceBalance).toBe(0);
  }

  const headquarters = world.buildings.filter((b) => b.type === "headquarters");
  expect(headquarters).toHaveLength(2);
  for (const hq of headquarters) {
    expect(hq.settlementCursorMs).toBeNull();
  }

  const resourceBuildings = world.buildings.filter((b) => b.type === "resource");
  expect(resourceBuildings).toHaveLength(1);
  expect(resourceBuildings[0]?.settlementCursorMs).toBe(new Date(RESOURCE_BUILDING_CREATED_AT).getTime());
  raw.close();
});

it("booting an already-migrated v4 database again changes nothing", async () => {
  buildV3Database(tempDir);

  await runMigrations();
  const raw1 = openMigratedDb(tempDir);
  const campaign1 = readCampaign(raw1, "STARTEDV3")!;
  const world1 = readWorld(raw1, campaign1.id);
  raw1.close();

  await runMigrations();
  const raw2 = openMigratedDb(tempDir);
  const campaign2 = readCampaign(raw2, "STARTEDV3")!;
  const world2 = readWorld(raw2, campaign2.id);

  expect(world2.countries).toHaveLength(world1.countries.length);
  expect(world2.countries.map((c) => c.resourceBalance)).toEqual(world1.countries.map((c) => c.resourceBalance));
  expect(world2.buildings).toHaveLength(world1.buildings.length);
  expect(world2.buildings.map((b) => b.settlementCursorMs)).toEqual(
    world1.buildings.map((b) => b.settlementCursorMs),
  );
  raw2.close();
});

it("the existing v2-chain campaigns still reach schema v4 correctly (balance 0, no resource buildings to backfill)", async () => {
  buildV2Database(tempDir);
  await runMigrations();
  const raw = openMigratedDb(tempDir);

  const configuring = readCampaign(raw, "CFGV2TST")!;
  const configuringWorld = readWorld(raw, configuring.id);
  expect(configuringWorld.countries).toHaveLength(0);

  const started = readCampaign(raw, "STARTEDV2")!;
  const startedWorld = readWorld(raw, started.id);
  expect(startedWorld.countries).toHaveLength(2);
  for (const country of startedWorld.countries) {
    expect(country.resourceBalance).toBe(0);
  }
  expect(startedWorld.buildings.filter((b) => b.type === "resource")).toHaveLength(0);
  for (const hq of startedWorld.buildings) {
    expect(hq.settlementCursorMs).toBeNull();
  }
  raw.close();
});

// Builds a pure schema-version-1 database: no resource_preset/settings_revision
// columns, no approvals table, no world tables at all — the very first shape,
// predating every migration added since.
function buildV1Database(dir: string): void {
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE identities (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'configuring',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE participants (
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
  db.exec("PRAGMA user_version = 1");

  const hostId = db.prepare("INSERT INTO identities (token_hash) VALUES (?)").run("hash-v1-host")
    .lastInsertRowid;
  db.prepare("INSERT INTO campaigns (code) VALUES (?)").run("V1CHAIN1");
  const campaignId = (db.prepare("SELECT id FROM campaigns WHERE code = ?").get("V1CHAIN1") as {
    id: number;
  }).id;
  db.prepare("INSERT INTO participants (campaign_id, identity_id, seat, is_host) VALUES (?, ?, 1, 1)").run(
    campaignId,
    hostId,
  );

  db.close();
}

it("a pure schema v1 database migrates through v2 -> v3 -> v4 -> v5 successfully", async () => {
  buildV1Database(tempDir);
  await runMigrations();
  const raw = openMigratedDb(tempDir);

  const campaign = readCampaign(raw, "V1CHAIN1")!;
  expect(campaign.status).toBe("configuring");
  expect(campaign.resourcePreset).toBe("standard"); // v1 -> v2 default applied
  expect(campaign.settingsRevision).toBe(1);

  const participants = readParticipants(raw, campaign.id);
  expect(participants).toHaveLength(1);
  expect(participants[0]?.isHost).toBe(1);

  // Still configuring the whole way through: no world invented by any
  // migration step along the v1 -> v2 -> v3 -> v4 chain.
  const world = readWorld(raw, campaign.id);
  expect(world.countries).toHaveLength(0);
  expect(world.tiles).toHaveLength(0);
  expect(world.buildings).toHaveLength(0);

  // And the v4 -> v5 poker migration also ran: the new tables exist and are
  // empty, having nothing to do with this pre-existing campaign data.
  const pokerTableCount = raw.prepare("SELECT COUNT(*) AS n FROM poker_tables").get() as { n: number };
  expect(pokerTableCount.n).toBe(0);
  raw.close();
});

it("a schema version newer than this build supports fails clearly", async () => {
  const freshDbPath = join(tempDir, "app.sqlite");
  const raw = new DatabaseSync(freshDbPath);
  raw.exec("PRAGMA user_version = 99");
  raw.close();

  await expect(runMigrations()).rejects.toThrow(/newer than this build supports/);
});

it("a v4 database migrates to v5 by adding the poker tables, empty and ready", async () => {
  // A v4 database is exactly a v3 database (see buildV3Database) with the
  // two v3 -> v4 columns already applied and no resource buildings — the
  // easiest way to produce one here is to run the real v1 -> v4 chain via
  // runMigrations() first with SCHEMA_VERSION temporarily capped, which this
  // file has no hook for. Instead this test starts from a pure v4 shape
  // built the same explicit way the other fixtures above are: a superset of
  // buildV3Database's tables with the v3 -> v4 columns already present.
  const db = new DatabaseSync(join(tempDir, "app.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE identities (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'configuring',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      resource_preset TEXT NOT NULL DEFAULT 'standard',
      settings_revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      identity_id INTEGER NOT NULL REFERENCES identities(id),
      seat INTEGER NOT NULL CHECK (seat IN (1, 2)),
      is_host INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (campaign_id, seat),
      UNIQUE (campaign_id, identity_id)
    );
    CREATE TABLE approvals (
      id INTEGER PRIMARY KEY,
      participant_id INTEGER NOT NULL REFERENCES participants(id),
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (participant_id, revision)
    );
    CREATE TABLE countries (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      seat INTEGER NOT NULL CHECK (seat IN (1, 2)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      resource_balance INTEGER NOT NULL DEFAULT 0 CHECK (resource_balance >= 0),
      UNIQUE (campaign_id, seat)
    );
    CREATE TABLE tiles (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      row INTEGER NOT NULL CHECK (row BETWEEN 0 AND 7),
      col INTEGER NOT NULL CHECK (col BETWEEN 0 AND 7),
      owner_country_id INTEGER REFERENCES countries(id),
      UNIQUE (campaign_id, row, col)
    );
    CREATE TABLE buildings (
      id INTEGER PRIMARY KEY,
      tile_id INTEGER NOT NULL UNIQUE REFERENCES tiles(id),
      country_id INTEGER NOT NULL REFERENCES countries(id),
      type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      settlement_cursor_ms INTEGER CHECK (settlement_cursor_ms IS NULL OR settlement_cursor_ms >= 0)
    );
    CREATE UNIQUE INDEX one_headquarters_per_country
      ON buildings(country_id)
      WHERE type = 'headquarters';
  `);
  db.exec("PRAGMA user_version = 4");
  db.close();

  await runMigrations();
  const raw = openMigratedDb(tempDir);

  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('poker_tables', 'poker_seats')")
    .all() as { name: string }[];
  expect(tables.map((t) => t.name).sort()).toEqual(["poker_seats", "poker_tables"]);

  const tableCount = raw.prepare("SELECT COUNT(*) AS n FROM poker_tables").get() as { n: number };
  const seatCount = raw.prepare("SELECT COUNT(*) AS n FROM poker_seats").get() as { n: number };
  expect(tableCount.n).toBe(0);
  expect(seatCount.n).toBe(0);

  // The pre-existing v4 campaign data is completely untouched by the v5
  // poker migration.
  const campaignCount = raw.prepare("SELECT COUNT(*) AS n FROM campaigns").get() as { n: number };
  expect(campaignCount.n).toBe(0); // none were inserted into this fixture, confirming no backfill invented one
  raw.close();
});

it("booting an already-migrated v5 database again does not duplicate or alter the poker tables", async () => {
  await runMigrations();
  const firstRaw = openMigratedDb(tempDir);
  firstRaw.prepare("INSERT INTO poker_tables (code) VALUES ('REALTBL1')").run();
  const tableRow = firstRaw.prepare("SELECT id FROM poker_tables WHERE code = 'REALTBL1'").get() as {
    id: number;
  };
  firstRaw.close();

  await runMigrations();
  const secondRaw = openMigratedDb(tempDir);
  const stillThere = secondRaw.prepare("SELECT id, code FROM poker_tables WHERE id = ?").get(tableRow.id) as
    | { id: number; code: string }
    | undefined;
  expect(stillThere?.code).toBe("REALTBL1");

  const tableCount = secondRaw.prepare("SELECT COUNT(*) AS n FROM poker_tables").get() as { n: number };
  expect(tableCount.n).toBe(1);
  secondRaw.close();
});
