import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipSelectionAtpService } from "../../application/dropship-selection-atp-service";
import { DropshipError } from "../../domain/errors";
import {
  DROPSHIP_CATALOG_CODE_VERSION,
  NEW_VERSION_SETTLE_MS,
  OLDER_PROCESS_ALERT_AFTER_MS,
  OLDER_PROCESS_GRACE_MS,
} from "../../domain/catalog-code-version";
import {
  catalogVersionSettled,
  deleteStaleProcessHeartbeats,
  hasLiveOlderCatalogProcess,
  listOlderProcessesStillRunning,
  writeProcessHeartbeat,
} from "../../infrastructure/dropship-process-heartbeat.repository";
import { PROCESS_HEARTBEAT_RETENTION_MS } from "../../infrastructure/dropship-process-heartbeat";
import {
  PgDropshipSelectionAtpRepository,
  SELECTION_RULES_RETIRED_DB_MESSAGE,
} from "../../infrastructure/dropship-selection-atp.repository";
import { statusForDropshipVendorCatalogError } from "../../interfaces/http/dropship-vendor-catalog.routes";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { listingPushRunsBaseFixtureSql, listingPushRunsMigrationSql } from "../fixtures/listing-push-runs.fixture";

/**
 * Release readiness against a real PostgreSQL (step 1 plan S2-5 §4.9, §4.13):
 * the heartbeat tables as A's migration creates them, the gates' reads at the
 * grace and settle edges on the database clock, and the rules save answering
 * B's freeze contract through a fixture trigger that raises it.
 */
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository", () => ({
  createAuthorityAwareInventoryAtpService: () => ({}),
}));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const VENDOR = 10;
const NOW = new Date("2026-10-20T12:00:00.000Z");
/** A second either side of an edge: far from the statement's own run time, close to the edge. */
const EDGE_MARGIN_SECONDS = 2;

describeDatabase.sequential("release readiness (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, listingPushRunsBaseFixtureSql);
    pool = database.pool;
    await pool.query(listingPushRunsMigrationSql());
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await pool.query(`DROP TRIGGER IF EXISTS aa_selection_rules_retired ON dropship.dropship_vendor_selection_rules`);
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
    expect(DROPSHIP_CATALOG_CODE_VERSION).toBe(1);
  });

  describe("the rules save and B's freeze (§4.9 item 2)", () => {
    const repository = () => new PgDropshipSelectionAtpRepository(pool);
    const save = (key: string) => repository().replaceSelectionRules({
      vendorId: VENDOR, idempotencyKey: key, requestHash: createHash("sha256").update(key).digest("hex"),
      actor: { actorType: "vendor", actorId: "member-10" }, now: NOW,
      rules: [{ scopeType: "catalog", action: "include", productLineId: null, productId: null, productVariantId: null,
        category: null, autoConnectNewSkus: true, autoListNewSkus: false, priority: 0, metadata: {} }],
    });

    /** B's freeze, as its migration will raise it (§5.2 step 8), on the rules table. */
    async function freeze(message: string): Promise<void> {
      await pool.query(`CREATE OR REPLACE FUNCTION dropship.aa_selection_rules_retired_fixture() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${message}' USING ERRCODE = 'P0001'; END $$`);
      await pool.query(`CREATE TRIGGER aa_selection_rules_retired BEFORE INSERT OR UPDATE OR DELETE
        ON dropship.dropship_vendor_selection_rules FOR EACH STATEMENT
        EXECUTE FUNCTION dropship.aa_selection_rules_retired_fixture()`);
    }

    async function revisionCount(): Promise<number> {
      return (await pool.query(`SELECT count(*)::int AS n FROM dropship.dropship_vendor_selection_rule_set_revisions`)).rows[0].n;
    }

    it("answers the freeze with the retired refusal (410) and leaves no revision row", async () => {
      await freeze(SELECTION_RULES_RETIRED_DB_MESSAGE);

      const error = await save("save-after-freeze").then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(DropshipError);
      expect(error).toMatchObject({ code: "DROPSHIP_SELECTION_RULES_RETIRED", context: { retryable: false } });
      expect(statusForDropshipVendorCatalogError((error as DropshipError).code)).toBe(410);
      expect(await revisionCount()).toBe(0);
      expect((await pool.query(`SELECT count(*)::int AS n FROM dropship.dropship_audit_events`)).rows[0].n).toBe(0);
    });

    it("keeps today's answer for another P0001, and saves as before with no trigger", async () => {
      await freeze("SOMETHING_ELSE");
      await expect(save("save-other-raise")).rejects.toMatchObject({ code: "P0001", message: "SOMETHING_ELSE" });
      expect(await revisionCount()).toBe(0);

      await pool.query(`DROP TRIGGER aa_selection_rules_retired ON dropship.dropship_vendor_selection_rules`);
      const saved = await save("save-unfrozen");
      expect(saved).toMatchObject({ idempotentReplay: false, rules: [expect.objectContaining({ scopeType: "catalog" })] });
      expect(await revisionCount()).toBe(1);
    });

    it("refuses a legacy-picks- key before any write (CHK10)", async () => {
      const service = new DropshipSelectionAtpService({
        clock: { now: () => NOW },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        repository: repository(),
        atp: { getVariantAtp: async () => ({ authority: "canonical", quantities: new Map() }) },
        listingTiers: { resolveForVendor: async () => { throw new Error("not used"); } },
      });

      await expect(service.replaceSelectionRules({
        vendorId: VENDOR, idempotencyKey: `legacy-picks-backfill:${VENDOR}`, actor: { actorType: "vendor", actorId: "member-10" }, rules: [],
      })).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_KEY_RESERVED" });
      expect(await revisionCount()).toBe(0);
    });
  });
});
