import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// These tests exercise db.ts's settlement math directly, against an isolated
// database file — not through the running app over HTTP (like
// migration.test.ts). They don't need `baseUrl`.
//
// Vitest's fake timers control Date.now() for the whole test, so both
// buildResourceBuilding's real construction-time cursor and
// settleAndGetOwnCountryResources's real settlement-time Date.now() land on
// one fully deterministic clock — no real sleeping, and no separate
// "synthetic settlement time" that could drift from "real construction
// time". settleCountryProductionAt's own explicit `now` parameter (the
// brief's sanctioned internal test hook) is used only where a test needs to
// settle at a moment that isn't simply "the current fake time".

let tempDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "gs-settlement-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

async function freshDb(): Promise<typeof import("../db.ts")> {
  vi.resetModules();
  return import("../db.ts");
}

type Db = Awaited<ReturnType<typeof freshDb>>;

async function setUpStartedCampaign(preset: "standard" | "rapid" = "standard") {
  const db = await freshDb();
  const host = db.createIdentity(db.hashToken("settlement-host"));
  const joiner = db.createIdentity(db.hashToken("settlement-joiner"));
  const campaign = db.createCampaign(host.id);
  db.joinCampaign(campaign.id, joiner.id);
  if (preset === "rapid") {
    db.setResourcePreset(campaign.id, host.id, "rapid");
  }
  db.approveCurrentSettings(campaign.id, host.id);
  db.approveCurrentSettings(campaign.id, joiner.id);
  const start = db.startCampaign(campaign.id, host.id);
  expect(start.ok).toBe(true);

  const world = db.getWorldForCampaign(campaign.id);
  const country1 = world.countries.find((c) => c.seat === 1)!;
  const country2 = world.countries.find((c) => c.seat === 2)!;
  return { db, campaign, host, joiner, country1, country2 };
}

function cursorAt(db: Db, campaignId: number, row: number, col: number): number {
  const building = db.getWorldForCampaign(campaignId).buildings.find((b) => b.row === row && b.col === col);
  expect(building?.settlementCursorMs).not.toBeNull();
  return building!.settlementCursorMs as number;
}

it("a country starts with resource balance 0", async () => {
  const { db, country1 } = await setUpStartedCampaign();
  const balance = db.settleCountryProductionAt(country1.id, "standard", Date.now());
  expect(balance).toBe(0);
});

it("headquarters produce nothing even after a long elapsed time", async () => {
  const { db, country1 } = await setUpStartedCampaign();
  const balance = db.settleCountryProductionAt(country1.id, "standard", Date.now() + 1_000_000);
  expect(balance).toBe(0);
});

it("a resource building with less than 10 seconds elapsed produces 0", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign();
  db.buildResourceBuilding(campaign.id, host.id, 0, 1);
  const cursor = cursorAt(db, campaign.id, 0, 1);

  const balance = db.settleCountryProductionAt(country1.id, "standard", cursor + 5_000);
  expect(balance).toBe(0);
});

it("Standard preset credits +10 for one building after exactly 10 seconds", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign("standard");
  db.buildResourceBuilding(campaign.id, host.id, 0, 1);
  const cursor = cursorAt(db, campaign.id, 0, 1);

  const balance = db.settleCountryProductionAt(country1.id, "standard", cursor + 10_000);
  expect(balance).toBe(10);
});

it("Rapid preset credits +20 for one building after exactly 10 seconds", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign("rapid");
  db.buildResourceBuilding(campaign.id, host.id, 0, 1);
  const cursor = cursorAt(db, campaign.id, 0, 1);

  const balance = db.settleCountryProductionAt(country1.id, "rapid", cursor + 10_000);
  expect(balance).toBe(20);
});

it("25 seconds elapsed under Standard credits +20 and preserves a 5-second remainder", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign("standard");
  db.buildResourceBuilding(campaign.id, host.id, 0, 1);
  const cursor = cursorAt(db, campaign.id, 0, 1);

  const balance = db.settleCountryProductionAt(country1.id, "standard", cursor + 25_000);
  expect(balance).toBe(20);

  const newCursor = cursorAt(db, campaign.id, 0, 1);
  expect(newCursor).toBe(cursor + 20_000); // advanced by 2 whole intervals, not to cursor+25_000
});

it("25 seconds elapsed under Rapid credits +40 and preserves the same 5-second remainder behaviour", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign("rapid");
  db.buildResourceBuilding(campaign.id, host.id, 0, 1);
  const cursor = cursorAt(db, campaign.id, 0, 1);

  const balance = db.settleCountryProductionAt(country1.id, "rapid", cursor + 25_000);
  expect(balance).toBe(40);

  const newCursor = cursorAt(db, campaign.id, 0, 1);
  expect(newCursor).toBe(cursor + 20_000);
});

it("repeated settlement at the same authoritative time does not double-credit", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign();
  db.buildResourceBuilding(campaign.id, host.id, 0, 1);
  const cursor = cursorAt(db, campaign.id, 0, 1);
  const now = cursor + 10_000;

  const first = db.settleCountryProductionAt(country1.id, "standard", now);
  const second = db.settleCountryProductionAt(country1.id, "standard", now);
  expect(first).toBe(10);
  expect(second).toBe(10);
});

it("settling again after only a partial additional interval credits nothing more", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign();
  db.buildResourceBuilding(campaign.id, host.id, 0, 1);
  const cursor = cursorAt(db, campaign.id, 0, 1);

  db.settleCountryProductionAt(country1.id, "standard", cursor + 10_000); // +10
  const balance = db.settleCountryProductionAt(country1.id, "standard", cursor + 14_000); // +4s, still partial
  expect(balance).toBe(10);
});

it("settling once the remainder completes the next interval credits exactly one more", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign();
  db.buildResourceBuilding(campaign.id, host.id, 0, 1);
  const cursor = cursorAt(db, campaign.id, 0, 1);

  db.settleCountryProductionAt(country1.id, "standard", cursor + 10_000); // +10
  const balance = db.settleCountryProductionAt(country1.id, "standard", cursor + 20_000); // one more full interval
  expect(balance).toBe(20);
});

it("two resource buildings are settled independently and their production is pooled once into the country balance", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign();
  db.buildResourceBuilding(campaign.id, host.id, 0, 1);
  db.buildResourceBuilding(campaign.id, host.id, 1, 0);

  const cursorA = cursorAt(db, campaign.id, 0, 1);
  const cursorB = cursorAt(db, campaign.id, 1, 0);
  expect(cursorA).toBe(cursorB); // built at the same (fake) instant, no real-clock drift

  const balance = db.settleCountryProductionAt(country1.id, "standard", cursorA + 10_000);
  expect(balance).toBe(20); // +10 from each building, summed once into one pooled balance
});

it("buildings created at different times do not share a cursor, and a later building gets no retroactive credit", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign();

  db.buildResourceBuilding(campaign.id, host.id, 0, 1); // building A
  const cursorA = cursorAt(db, campaign.id, 0, 1);

  // Advance the fake clock by a full interval before B is ever built, and
  // settle A so its own cursor catches up.
  vi.setSystemTime(cursorA + 10_000);
  const afterFirstInterval = db.settleCountryProductionAt(country1.id, "standard", Date.now());
  expect(afterFirstInterval).toBe(10);

  db.buildResourceBuilding(campaign.id, host.id, 1, 0); // B, constructed strictly later
  const cursorB = cursorAt(db, campaign.id, 1, 0);
  expect(cursorB).toBe(cursorA + 10_000); // B's cursor reflects its own later construction time
  expect(cursorB).toBeGreaterThan(cursorA);

  // Advance only 1ms more: not a full interval for either building. Balance
  // must stay exactly 10 — B inherited none of A's already-elapsed time.
  const balance = db.settleCountryProductionAt(country1.id, "standard", cursorB + 1);
  expect(balance).toBe(10);
});

it("a stored cursor ahead of the authoritative clock never produces negative resources or moves the cursor backwards", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign();
  db.buildResourceBuilding(campaign.id, host.id, 0, 1);
  const cursor = cursorAt(db, campaign.id, 0, 1);

  // Simulate the clock appearing to have gone backwards relative to the
  // stored cursor.
  const balance = db.settleCountryProductionAt(country1.id, "standard", cursor - 5_000);
  expect(balance).toBe(0);

  const cursorAfter = cursorAt(db, campaign.id, 0, 1);
  expect(cursorAfter).toBe(cursor); // unchanged, never moved backwards
});

it("the production rate is taken from the persisted frozen campaign preset, not a hardcoded/client value", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign("rapid");
  db.buildResourceBuilding(campaign.id, host.id, 0, 1);

  // Read the preset back from storage — exactly what
  // settleAndGetOwnCountryResources does internally before picking a rate.
  const storedCampaign = db.getCampaignByCode(campaign.code)!;
  expect(storedCampaign.resourcePreset).toBe("rapid");

  // Advance the fake clock by one real interval and use the actual
  // HTTP-facing function (real Date.now(), now under our control), proving
  // the live rate-resolution path — not just the lower-level test hook.
  vi.advanceTimersByTime(10_000);
  const result = db.settleAndGetOwnCountryResources(campaign.id, host.id);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.balance).toBe(20); // Rapid rate, not Standard, taken from storage
  }
  void country1;
});

it("settleAndGetOwnCountryResources resolves the caller's own country from their identity and rejects a non-participant", async () => {
  const { db, campaign, host, country1 } = await setUpStartedCampaign();
  const stranger = db.createIdentity(db.hashToken("settlement-stranger"));

  const ownResult = db.settleAndGetOwnCountryResources(campaign.id, host.id);
  expect(ownResult.ok).toBe(true);
  if (ownResult.ok) {
    expect(ownResult.seat).toBe(1);
    expect(ownResult.balance).toBe(0);
  }
  void country1;

  const strangerResult = db.settleAndGetOwnCountryResources(campaign.id, stranger.id);
  expect(strangerResult.ok).toBe(false);
  if (!strangerResult.ok) {
    expect(strangerResult.reason).toBe("not_participant");
  }
});

it("settlement is rejected before the match has started", async () => {
  const db = await freshDb();
  const host = db.createIdentity(db.hashToken("pre-start-host"));
  const campaign = db.createCampaign(host.id);

  const result = db.settleAndGetOwnCountryResources(campaign.id, host.id);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("not_started");
  }
});
