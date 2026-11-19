import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DROPSHIP_CATALOG_CODE_VERSION,
  NEW_VERSION_SETTLE_MS,
  OLDER_PROCESS_ALERT_AFTER_MS,
  OLDER_PROCESS_GRACE_MS,
} from "../../domain/catalog-code-version";
import {
  catalogVersionAtLeastSettled,
  catalogVersionSettled,
  deleteStaleProcessHeartbeats,
  hasLiveOlderCatalogProcess,
  listOlderProcessesStillRunning,
  writeProcessHeartbeat,
} from "../../infrastructure/dropship-process-heartbeat.repository";
import { PROCESS_HEARTBEAT_RETENTION_MS } from "../../infrastructure/dropship-process-heartbeat";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { listingPushRunsBaseFixtureSql, listingPushRunsMigrationSql } from "../fixtures/listing-push-runs.fixture";

/**
 * Release readiness against a real PostgreSQL (step 1 plan S2-5 §4.9, §4.13):
 * the heartbeat tables as A's migration creates them and the gates' reads at
 * the grace and settle edges on the database clock. PR B deleted the rules
 * save (PLAN-B v4.1 V10), so its answer to the freeze is gone from here; the
 * freeze is tested on the real B file (dropship-selection-picks-migration) and
 * B's writes gate on these reads in dropship-selection-change.
 */
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository", () => ({
  createAuthorityAwareInventoryAtpService: () => ({}),
}));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const VENDOR = 10;
/** A second either side of an edge: far from the statement's own run time, close to the edge. */
const EDGE_MARGIN_SECONDS = 2;

describeDatabase.sequential("release readiness (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, listingPushRunsBaseFixtureSql());
    pool = database.pool;
    await pool.query(listingPushRunsMigrationSql());
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE dropship.dropship_process_heartbeats, dropship.dropship_catalog_code_versions,
      dropship.dropship_vendor_selection_rules, dropship.dropship_vendor_selection_rule_set_revisions,
      dropship.dropship_audit_events, dropship.dropship_vendors RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (${VENDOR}, 'member-10')`);
  });

  /** Moves a row's last beat to `seconds` before the database's now. */
  async function lastSeenAgo(processKey: string, seconds: number): Promise<void> {
    await pool.query(`UPDATE dropship.dropship_process_heartbeats
      SET last_seen_at = clock_timestamp() - make_interval(secs => $2) WHERE process_key = $1`, [processKey, seconds]);
  }

  async function firstSeenAgo(version: number, seconds: number): Promise<void> {
    await pool.query(`UPDATE dropship.dropship_catalog_code_versions
      SET first_seen_at = clock_timestamp() - make_interval(secs => $2) WHERE catalog_code_version = $1`, [version, seconds]);
  }

  it("upserts one row per process, keeps its start, and records each version's first run once", async () => {
    await writeProcessHeartbeat(pool, { processKey: "web.1:boot-a", catalogCodeVersion: 1 });
    const first = (await pool.query(`SELECT started_at, last_seen_at FROM dropship.dropship_process_heartbeats`)).rows[0];
    const firstSeen = (await pool.query(`SELECT first_seen_at FROM dropship.dropship_catalog_code_versions`)).rows[0];
    await lastSeenAgo("web.1:boot-a", 60);
    await writeProcessHeartbeat(pool, { processKey: "web.1:boot-a", catalogCodeVersion: 1 });
    await writeProcessHeartbeat(pool, { processKey: "web.2:boot-b", catalogCodeVersion: 1 });

    const rows = (await pool.query(`SELECT process_key, catalog_code_version, started_at, last_seen_at
      FROM dropship.dropship_process_heartbeats ORDER BY process_key`)).rows;
    expect(rows.map((row) => [row.process_key, row.catalog_code_version])).toEqual([["web.1:boot-a", 1], ["web.2:boot-b", 1]]);
    expect(rows[0].started_at.toISOString()).toBe(first.started_at.toISOString());
    expect(rows[0].last_seen_at.getTime()).toBeGreaterThanOrEqual(first.last_seen_at.getTime());
    const versions = (await pool.query(`SELECT catalog_code_version, first_seen_at FROM dropship.dropship_catalog_code_versions`)).rows;
    expect(versions).toHaveLength(1);
    expect(versions[0].first_seen_at.toISOString()).toBe(firstSeen.first_seen_at.toISOString());
  });

  it("refuses a blank process key and a version below 1 (the migration's CHECKs)", async () => {
    await expect(writeProcessHeartbeat(pool, { processKey: "  ", catalogCodeVersion: 1 })).rejects.toMatchObject({ code: "23514" });
    await expect(writeProcessHeartbeat(pool, { processKey: "web.1:boot-a", catalogCodeVersion: 0 })).rejects.toMatchObject({ code: "23514" });
    // One statement: a refused beat writes neither row.
    expect((await pool.query(`SELECT count(*)::int AS n FROM dropship.dropship_catalog_code_versions`)).rows[0].n).toBe(0);
  });

  it(`sees an older process as live just inside the ${OLDER_PROCESS_GRACE_MS} ms grace and gone just outside it`, async () => {
    const graceSeconds = OLDER_PROCESS_GRACE_MS / 1000;
    await writeProcessHeartbeat(pool, { processKey: "web.1:boot-old", catalogCodeVersion: 1 });
    await writeProcessHeartbeat(pool, { processKey: "web.2:boot-new", catalogCodeVersion: 2 });
    const older = () => hasLiveOlderCatalogProcess(pool, { belowVersion: 2, graceMs: OLDER_PROCESS_GRACE_MS });

    expect(await older()).toBe(true);
    await lastSeenAgo("web.1:boot-old", graceSeconds - EDGE_MARGIN_SECONDS);
    expect(await older()).toBe(true);
    await lastSeenAgo("web.1:boot-old", graceSeconds + EDGE_MARGIN_SECONDS);
    expect(await older()).toBe(false);
    // The version-2 process itself is never "older" than 2, and nothing is older than 1.
    expect(await hasLiveOlderCatalogProcess(pool, { belowVersion: 1, graceMs: OLDER_PROCESS_GRACE_MS })).toBe(false);
    // Its next beat brings it back (a process after SIGTERM keeps beating, CHK2).
    await writeProcessHeartbeat(pool, { processKey: "web.1:boot-old", catalogCodeVersion: 1 });
    expect(await older()).toBe(true);
  });

  it(`settles a version ${NEW_VERSION_SETTLE_MS} ms after it first ran, never with no row, and never moved by later beats (CHK10)`, async () => {
    const settleSeconds = NEW_VERSION_SETTLE_MS / 1000;
    const settled = () => catalogVersionSettled(pool, { version: 2, settleMs: NEW_VERSION_SETTLE_MS });

    expect(await settled()).toBe(false);
    await writeProcessHeartbeat(pool, { processKey: "web.2:boot-new", catalogCodeVersion: 2 });
    expect(await settled()).toBe(false);
    await firstSeenAgo(2, settleSeconds - EDGE_MARGIN_SECONDS);
    expect(await settled()).toBe(false);
    await firstSeenAgo(2, settleSeconds + EDGE_MARGIN_SECONDS);
    expect(await settled()).toBe(true);
    await writeProcessHeartbeat(pool, { processKey: "web.3:boot-new", catalogCodeVersion: 2 });
    await writeProcessHeartbeat(pool, { processKey: "web.2:boot-new", catalogCodeVersion: 2 });
    expect(await settled()).toBe(true);
    // Another version's row says nothing about version 2.
    expect(await catalogVersionSettled(pool, { version: 3, settleMs: NEW_VERSION_SETTLE_MS })).toBe(false);
  });

  it("settles picks writes on version 2 or any later one: a database where only version 3 ran opens once 3 settles (review SAV-1)", async () => {
    const settleSeconds = NEW_VERSION_SETTLE_MS / 1000;
    const atLeastTwo = () => catalogVersionAtLeastSettled(pool, { minVersion: 2, settleMs: NEW_VERSION_SETTLE_MS });
    expect(await atLeastTwo()).toBe(false);
    await writeProcessHeartbeat(pool, { processKey: "web.3:boot-c", catalogCodeVersion: 3 });
    await firstSeenAgo(3, settleSeconds - EDGE_MARGIN_SECONDS);
    expect(await atLeastTwo()).toBe(false);
    await firstSeenAgo(3, settleSeconds + EDGE_MARGIN_SECONDS);
    expect(await atLeastTwo()).toBe(true);
    // The exact check is unchanged (the end worker's gate on version 3 itself), and a version below never counts.
    expect(await catalogVersionSettled(pool, { version: 2, settleMs: NEW_VERSION_SETTLE_MS })).toBe(false);
    expect(await catalogVersionAtLeastSettled(pool, { minVersion: 4, settleMs: NEW_VERSION_SETTLE_MS })).toBe(false);
  });

  it("lists an older process still reporting 30 minutes after the newest version first ran, and nothing before", async () => {
    const alertSeconds = OLDER_PROCESS_ALERT_AFTER_MS / 1000;
    await writeProcessHeartbeat(pool, { processKey: "web.1:boot-old", catalogCodeVersion: 1 });
    await writeProcessHeartbeat(pool, { processKey: "web.2:boot-new", catalogCodeVersion: 2 });
    const list = () => listOlderProcessesStillRunning(pool, {
      version: 2, graceMs: OLDER_PROCESS_GRACE_MS, alertAfterMs: OLDER_PROCESS_ALERT_AFTER_MS,
    });

    await firstSeenAgo(2, alertSeconds - EDGE_MARGIN_SECONDS);
    expect(await list()).toEqual([]);
    await firstSeenAgo(2, alertSeconds + EDGE_MARGIN_SECONDS);
    expect((await list()).map((row) => [row.processKey, row.catalogCodeVersion])).toEqual([["web.1:boot-old", 1]]);
    await lastSeenAgo("web.1:boot-old", OLDER_PROCESS_GRACE_MS / 1000 + EDGE_MARGIN_SECONDS);
    expect(await list()).toEqual([]);
    // The older process itself never alerts about the newer one.
    expect(await listOlderProcessesStillRunning(pool, {
      version: 1, graceMs: OLDER_PROCESS_GRACE_MS, alertAfterMs: 0,
    })).toEqual([]);
  });

  it("deletes only rows not seen for a day and never a version's first-seen row", async () => {
    await writeProcessHeartbeat(pool, { processKey: "web.1:gone", catalogCodeVersion: 1 });
    await writeProcessHeartbeat(pool, { processKey: "web.2:recent", catalogCodeVersion: 1 });
    const daySeconds = PROCESS_HEARTBEAT_RETENTION_MS / 1000;
    await lastSeenAgo("web.1:gone", daySeconds + 60);
    await lastSeenAgo("web.2:recent", daySeconds - 60);

    expect(await deleteStaleProcessHeartbeats(pool, { olderThanMs: PROCESS_HEARTBEAT_RETENTION_MS })).toBe(1);
    expect((await pool.query(`SELECT process_key FROM dropship.dropship_process_heartbeats`)).rows)
      .toEqual([{ process_key: "web.2:recent" }]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM dropship.dropship_catalog_code_versions`)).rows[0].n).toBe(1);
    expect(DROPSHIP_CATALOG_CODE_VERSION).toBe(3);
  });
});
