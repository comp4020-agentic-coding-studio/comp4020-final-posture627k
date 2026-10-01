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
