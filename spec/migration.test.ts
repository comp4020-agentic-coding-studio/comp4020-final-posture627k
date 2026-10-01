import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// These tests exercise db.ts's schema migration directly, against a
// synthetic pre-existing database file — not through the running app over
// HTTP (unlike every other spec file here). They don't need `baseUrl`.

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
// cached instance from an earlier import in this process.
async function importFreshDb(): Promise<typeof import("../db.ts")> {
  vi.resetModules();
  return import("../db.ts");
}

it("a v2 campaign still configuring receives no world when migrated to v3", async () => {
  buildV2Database(tempDir);
  const db = await importFreshDb();

  const campaign = db.getCampaignByCode("CFGV2TST");
  expect(campaign).toBeTruthy();
  expect(campaign?.status).toBe("configuring");

  const world = db.getWorldForCampaign(campaign!.id);
  expect(world.countries).toHaveLength(0);
  expect(world.tiles).toHaveLength(0);
  expect(world.buildings).toHaveLength(0);
});

it("an already-started v2 campaign is backfilled with the deterministic world on migration to v3, unchanged otherwise", async () => {
  buildV2Database(tempDir);
  const db = await importFreshDb();

  const campaign = db.getCampaignByCode("STARTEDV2");
  expect(campaign).toBeTruthy();
  // Untouched by the migration: status, preset and revision are exactly
  // what the v2 database already had.
  expect(campaign?.status).toBe("started");
  expect(campaign?.resourcePreset).toBe("rapid");
  expect(campaign?.settingsRevision).toBe(2);

  const participants = db.getParticipantsForCampaign(campaign!.id);
  expect(participants).toHaveLength(2);
  expect(participants.find((p) => p.seat === 1)?.isHost).toBe(true);
  expect(participants.find((p) => p.seat === 2)?.isHost).toBe(false);

  const world = db.getWorldForCampaign(campaign!.id);
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
});

it("booting an already-migrated v3 database again does not duplicate the backfilled world", async () => {
  buildV2Database(tempDir);

  const first = await importFreshDb();
  const campaignFirst = first.getCampaignByCode("STARTEDV2")!;
  const worldFirst = first.getWorldForCampaign(campaignFirst.id);
  expect(worldFirst.tiles).toHaveLength(64);

  // A second, independent import against the same on-disk database: schema
  // is already at version 3, so the migration block must not run again.
  const second = await importFreshDb();
  const campaignSecond = second.getCampaignByCode("STARTEDV2")!;
  const worldSecond = second.getWorldForCampaign(campaignSecond.id);

  expect(worldSecond.countries).toHaveLength(2);
  expect(worldSecond.tiles).toHaveLength(64);
  expect(worldSecond.buildings).toHaveLength(2);
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
  const db = await importFreshDb();

  const campaign = db.getCampaignByCode("CFGV3TST")!;
  expect(campaign.status).toBe("configuring");

  const world = db.getWorldForCampaign(campaign.id);
  expect(world.countries).toHaveLength(0);
  expect(world.tiles).toHaveLength(0);
  expect(world.buildings).toHaveLength(0);
});

it("a v3 started world migrates to v4 intact: existing resource building gets a cursor from its own created_at, headquarters stay non-producing, country balances start at 0", async () => {
  buildV3Database(tempDir);
  const db = await importFreshDb();

  const campaign = db.getCampaignByCode("STARTEDV3")!;
  expect(campaign.status).toBe("started");

  const world = db.getWorldForCampaign(campaign.id);
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
});

it("booting an already-migrated v4 database again changes nothing", async () => {
  buildV3Database(tempDir);

  const first = await importFreshDb();
  const campaign1 = first.getCampaignByCode("STARTEDV3")!;
  const world1 = first.getWorldForCampaign(campaign1.id);

  const second = await importFreshDb();
  const campaign2 = second.getCampaignByCode("STARTEDV3")!;
  const world2 = second.getWorldForCampaign(campaign2.id);

  expect(world2.countries).toHaveLength(world1.countries.length);
  expect(world2.countries.map((c) => c.resourceBalance)).toEqual(world1.countries.map((c) => c.resourceBalance));
  expect(world2.buildings).toHaveLength(world1.buildings.length);
  expect(world2.buildings.map((b) => b.settlementCursorMs)).toEqual(
    world1.buildings.map((b) => b.settlementCursorMs),
  );
});

it("the existing v2-chain campaigns still reach schema v4 correctly (balance 0, no resource buildings to backfill)", async () => {
  buildV2Database(tempDir);
  const db = await importFreshDb();

  const configuring = db.getCampaignByCode("CFGV2TST")!;
  const configuringWorld = db.getWorldForCampaign(configuring.id);
  expect(configuringWorld.countries).toHaveLength(0);

  const started = db.getCampaignByCode("STARTEDV2")!;
  const startedWorld = db.getWorldForCampaign(started.id);
  expect(startedWorld.countries).toHaveLength(2);
  for (const country of startedWorld.countries) {
    expect(country.resourceBalance).toBe(0);
  }
  expect(startedWorld.buildings.filter((b) => b.type === "resource")).toHaveLength(0);
  for (const hq of startedWorld.buildings) {
    expect(hq.settlementCursorMs).toBeNull();
  }
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

it("a pure schema v1 database migrates through v2 -> v3 -> v4 successfully", async () => {
  buildV1Database(tempDir);
  const db = await importFreshDb();

  const campaign = db.getCampaignByCode("V1CHAIN1")!;
  expect(campaign.status).toBe("configuring");
  expect(campaign.resourcePreset).toBe("standard"); // v1 -> v2 default applied
  expect(campaign.settingsRevision).toBe(1);

  const participants = db.getParticipantsForCampaign(campaign.id);
  expect(participants).toHaveLength(1);
  expect(participants[0]?.isHost).toBe(true);

  // Still configuring the whole way through: no world invented by any
  // migration step along the v1 -> v2 -> v3 -> v4 chain.
  const world = db.getWorldForCampaign(campaign.id);
  expect(world.countries).toHaveLength(0);
  expect(world.tiles).toHaveLength(0);
  expect(world.buildings).toHaveLength(0);
});

it("a schema version newer than this build supports fails clearly", async () => {
  const freshDbPath = join(tempDir, "app.sqlite");
  const raw = new DatabaseSync(freshDbPath);
  raw.exec("PRAGMA user_version = 99");
  raw.close();

  await expect(importFreshDb()).rejects.toThrow(/newer than this build supports/);
});
