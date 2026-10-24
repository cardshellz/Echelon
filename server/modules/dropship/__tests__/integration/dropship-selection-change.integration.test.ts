import { createHash } from "node:crypto";
import pg, { type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executeMigrationWithRetry } from "../../../../../migrations/migration-executor";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipSelectionChangeService,
  SELECTION_SAVE_ATTEMPTS,
  seededJitterSource,
  type DropshipSelectionChangeRepository,
  type DropshipSelectionChangeTransaction,
} from "../../application/dropship-selection-change-service";
import { DropshipError } from "../../domain/errors";
import { writeProcessHeartbeat } from "../../infrastructure/dropship-process-heartbeat.repository";
import { PgDropshipSelectionChangeRepository } from "../../infrastructure/dropship-selection-change.repository";
import { LISTING_SELECTION_LOCK_SQL } from "../../infrastructure/dropship-listing-setting-writes.repository";
import { createInventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { LISTING_PUSH_RUNS_MIGRATION_FILE, listingPushRunsMigrationSql, seedPicks } from "../fixtures/listing-push-runs.fixture";
import {
  PICKS_PRODUCTION_INDEXES_SQL,
  PUBLICATION_SELECTION_GATE_LOCK_SQL,
  SELECTED_VARIANTS_MIGRATION_FILE,
  installPicksMigrationPrerequisites,
  picksMigrationSchemaSql,
  publicationSelectionGateHoldMs,
  samplePublicationSelectionGate,
  selectedVariantsMigrationSql,
} from "../fixtures/selection-picks-migration.fixture";
import type { SelectionChangeAnswer, SelectionChangePreviewAnswer } from "../../../../../shared/dropship/vendor-selection-changes";

/**
 * Step 1's picks save against a real PostgreSQL (PLAN-B v4.1 §8.3, §10, §15.3): the real schema path (the
 * listing-push-runs base, the real 0743, PR A's runs migration with the heartbeat tables, then the real B
 * file through the release executor) and the real service and repository. Cases: two tabs, rollback, the
 * publication gate held and released between attempts, the pre-lock waiting before the gate, a no-op save,
 * a deadlock with an ungated multi-product writer (R7), the writes readiness gate, the SHARE-lock statements,
 * a size deleted between the plan and the pre-lock (SAFETY-9), a catalog change between the plan's own reads
 * (SRV-1), and 10,000 picks on two stores with budgets.
 *
 * Every functional case uses a vendor of its own on one shared catalog, so no case cleans up after another
 * (the B file's freeze is never touched: nothing here deletes a vendor or a revision; V7).
 */
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const NOW = new Date("2026-10-24T12:00:00.000Z");
const CASE_TIMEOUT_MS = 60_000;
/** §15.3 scale case (TESTS-15): explicit timeout; budgets save < 20 s, gate hold < 5 s. */
const SCALE_CASE_TIMEOUT_MS = 180_000;
const SAVE_BUDGET_MS = 20_000;
const GATE_HOLD_BUDGET_MS = 5_000;

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * The functional catalog: products 1001-1010 with two sellable sizes each (2001-2020), all exposed by one
 * admin rule and each with an active mapping head (so 0743 invalidates its product); vendors 10-29, each with
 * one connected live eBay store 1xx; version 2 first seen ten minutes ago with one fresh version-2 process.
 */
const FUNCTIONAL_SEED_SQL = `
  INSERT INTO catalog.products (id, sku, name, category, is_active, status, product_type, ebay_listing_excluded)
    SELECT g, 'P-' || g, 'Product ' || g, 'Supplies', true, 'active', 'sleeves', false FROM generate_series(1001, 1010) g;
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded)
    SELECT g, 1001 + (g - 2001) / 2, 'S-' || g, 'Size ' || g, 'pack', true, true, true, 'sellable', false FROM generate_series(2001, 2020) g;
  INSERT INTO dropship.dropship_catalog_rules (scope_type, action, is_active, priority) VALUES ('catalog', 'include', true, 0);
  INSERT INTO inventory.publication_variant_mapping_heads (publication_target_id, product_variant_id, active_mapping_id)
    SELECT 1, id, id FROM catalog.product_variants;
  INSERT INTO dropship.dropship_vendors (id, member_id) SELECT g, 'member-' || g FROM generate_series(10, 29) g;
  INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, external_account_id, provider_environment,
    external_display_name)
    SELECT 100 + g, g, 'ebay', 'connected', 'seller-' || g, 'production', 'Store ' || g FROM generate_series(10, 29) g;
  INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, inventory_mode, is_active)
    SELECT 100 + g, 'ebay', 'live', 'managed_quantity_sync', true FROM generate_series(10, 29) g;
`;

interface ChangeDatabase {
  pool: Pool;
  close: () => Promise<void>;
}

/** A database of its own: the schema, the reduced owners, the real 0743, PR A's runs migration, the B file. */
async function createChangeDatabase(seed: string): Promise<ChangeDatabase> {
  const database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, picksMigrationSchemaSql);
  let pool: pg.Pool | undefined;
  try {
    await installPicksMigrationPrerequisites(database.pool);
    pool = new pg.Pool({ connectionString: database.connectionString, max: 10 });
    const client = await pool.connect();
    try {
      for (const [file, sql] of [[LISTING_PUSH_RUNS_MIGRATION_FILE, listingPushRunsMigrationSql()],
        [SELECTED_VARIANTS_MIGRATION_FILE, selectedVariantsMigrationSql()]] as const) {
        await executeMigrationWithRetry({
          client, file, sql, contentHash: createHash("sha256").update(sql).digest("hex"),
          options: { maxAttempts: 1, retryBaseDelayMs: 1, retryMaxDelayMs: 1, lockTimeoutMs: 15_000 },
          onRetry: () => undefined, sleep: async () => undefined,
        });
      }
    } finally {
      client.release();
    }
    await pool.query(PICKS_PRODUCTION_INDEXES_SQL);
    await pool.query(seed);
    // Version 2 settled, no older process: picks writes are open unless a case closes them.
    await writeProcessHeartbeat(pool, { processKey: "web.1:b", catalogCodeVersion: 2 });
    await pool.query(`UPDATE dropship.dropship_catalog_code_versions SET first_seen_at = clock_timestamp() - interval '10 minutes'
      WHERE catalog_code_version = 2`);
    const opened = pool;
    return { pool: opened, close: async () => { await opened.end(); await database.close(); } };
  } catch (error) {
    await pool?.end();
    await database.close();
    throw error;
  }
}

interface Harness {
  service: DropshipSelectionChangeService;
  logs: Array<{ level: string } & DropshipLogEvent>;
  sleeps: number[];
}

function harness(pool: Pool, options: {
  repository?: DropshipSelectionChangeRepository;
  sleep?: (delayMs: number) => Promise<void>;
  disabled?: boolean;
} = {}): Harness {
  const logs: Harness["logs"] = [];
  const sleeps: number[] = [];
  const service = new DropshipSelectionChangeService({
    repository: options.repository ?? new PgDropshipSelectionChangeRepository(pool),
    clock: { now: () => NOW },
    logger: {
      debug: (event) => logs.push({ level: "debug", ...event }),
      info: (event) => logs.push({ level: "info", ...event }),
      warn: (event) => logs.push({ level: "warn", ...event }),
      error: (event) => logs.push({ level: "error", ...event }),
    },
    sleep: async (delayMs) => { sleeps.push(delayMs); await (options.sleep ? options.sleep(delayMs) : delay(delayMs)); },
    random: seededJitterSource(11),
    picksWritesDisabled: () => options.disabled === true,
  });
  return { service, logs, sleeps };
}

interface ChangeRequest { vendorId: number; add?: number[]; remove?: number[]; key?: string }

async function previewOf(h: Harness, request: ChangeRequest): Promise<SelectionChangePreviewAnswer> {
  const head = await headRevision(request.vendorId);
  return h.service.preview({ vendorId: request.vendorId, body: {
    clientVersion: 2, expectedRevisionId: head, add: { productVariantIds: request.add ?? [] }, remove: { productVariantIds: request.remove ?? [] },
  } });
}

/** A press of Save as the page makes it: the preview's head and effects, then the change with a fresh key. */
async function saveOf(h: Harness, request: ChangeRequest, confirmed?: SelectionChangePreviewAnswer): Promise<{
  answer: SelectionChangeAnswer; idempotentReplay: boolean;
}> {
  const preview = confirmed ?? await previewOf(h, request);
  return h.service.applyChange({ vendorId: request.vendorId, actor: { actorType: "vendor", actorId: `member-${request.vendorId}` }, body: {
    clientVersion: 2, expectedRevisionId: preview.headRevisionId, add: { productVariantIds: request.add ?? [] },
    remove: { productVariantIds: request.remove ?? [] }, idempotencyKey: request.key ?? `catalog-selection:${request.vendorId}:${keySeq += 1}`,
    expectedEffectsHash: preview.effectsHash,
  } });
}
let keySeq = 0;

let activePool: Pool;
async function headRevision(vendorId: number): Promise<number | null> {
  return (await activePool.query<{ id: number | null }>(
    "SELECT max(id) AS id FROM dropship.dropship_vendor_selection_rule_set_revisions WHERE vendor_id = $1", [vendorId])).rows[0]?.id ?? null;
}

async function counts(pool: Pool, vendorId: number): Promise<{ revisions: number; audits: number; picks: number[] }> {
  const revisions = (await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM dropship.dropship_vendor_selection_rule_set_revisions WHERE vendor_id = $1", [vendorId])).rows[0]!.n;
  const audits = (await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM dropship.dropship_audit_events WHERE vendor_id = $1 AND event_type = 'vendor_selection_picks_changed'",
    [vendorId])).rows[0]!.n;
  const picks = (await pool.query<{ id: number }>(
    "SELECT product_variant_id AS id FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = $1 ORDER BY 1", [vendorId])).rows
    .map((row) => row.id);
  return { revisions, audits, picks };
}

async function refusalOf(work: Promise<unknown>): Promise<DropshipError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DropshipError) return error;
    throw error;
  }
  throw new Error("Expected a refusal.");
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(5);
  }
}

/** The backend running a statement that starts with `prefix` and waits on a heavyweight lock, if any. */
async function waitingBackend(pool: Pool, prefix: string): Promise<number | null> {
  const row = (await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
    WHERE state = 'active' AND wait_event_type = 'Lock' AND left(ltrim(query), $2) = $1 AND pid <> pg_backend_pid()
    ORDER BY query_start LIMIT 1`, [prefix, prefix.length])).rows[0];
  return row?.pid ?? null;
}

async function holdsGate(pool: Pool, pid: number): Promise<boolean> {
  return (await pool.query<{ held: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'
    AND ${PUBLICATION_SELECTION_GATE_LOCK_SQL} AND granted) AS held`, [pid])).rows[0]!.held;
}

/** A session holding the gate's shared side, as a stock publication does while it sends quantities (0743). */
async function holdGateShared(pool: Pool): Promise<{ release: () => Promise<void> }> {
  const client = await pool.connect();
  await client.query("SELECT pg_advisory_lock_shared(918419, 0)");
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try { await client.query("SELECT pg_advisory_unlock_shared(918419, 0)"); } finally { client.release(); }
    },
  };
}

describeDatabase.sequential("the picks save (PostgreSQL)", () => {
  let db: ChangeDatabase;

  beforeAll(async () => {
    db = await createChangeDatabase(FUNCTIONAL_SEED_SQL);
    activePool = db.pool;
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("writes the picks, the revision, the audit row and the invalidations, and replays the key with the same answer", async () => {
    const h = harness(db.pool);
    const before = (await db.pool.query<{ product_id: number; revision: string }>(
      "SELECT product_id, revision::text AS revision FROM inventory.publication_selection_work ORDER BY 1")).rows;
    const preview = await previewOf(h, { vendorId: 10, add: [2001, 2003] });
    expect(preview).toMatchObject({ headRevisionId: null, toAdd: 2, selectedBefore: 0, selectedAfter: 2,
      effects: [{ storeConnectionId: 110, storeName: "Store 10", platform: "ebay", goesToZero: 0, startsSelling: 0 }] });
    const request = { vendorId: 10, add: [2001, 2003], key: "catalog-selection:10:replay" };
    const first = await saveOf(h, request, preview);
    expect(first).toMatchObject({ idempotentReplay: false, answer: { toAdd: 2, selectedAfter: 2, drifted: false } });
    expect(await counts(db.pool, 10)).toEqual({ revisions: 1, audits: 1, picks: [2001, 2003] });
    const revision = (await db.pool.query(`SELECT request_kind, rule_count, pick_count, actor_type, actor_id, result
      FROM dropship.dropship_vendor_selection_rule_set_revisions WHERE id = $1`, [first.answer.revisionId])).rows[0];
    expect(revision).toMatchObject({ request_kind: "picks_change", rule_count: 0, pick_count: 2, actor_type: "vendor", actor_id: "member-10" });
    const picks = (await db.pool.query(`SELECT source, revision_id FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = 10`)).rows;
    expect(picks).toEqual([{ source: "vendor", revision_id: first.answer.revisionId }, { source: "vendor", revision_id: first.answer.revisionId }]);
    const audit = (await db.pool.query(`SELECT entity_type, entity_id, actor_type, payload FROM dropship.dropship_audit_events
      WHERE vendor_id = 10 AND event_type = 'vendor_selection_picks_changed'`)).rows[0];
    expect(audit).toMatchObject({ entity_type: "dropship_vendor_selection_ruleset", entity_id: String(first.answer.revisionId),
      actor_type: "vendor", payload: { addedVariantIds: [2001, 2003], removedVariantIds: [], idempotencyKey: request.key } });
    // 0743's 'variant' invalidation bumped exactly the two products.
    const after = (await db.pool.query<{ product_id: number; revision: string }>(
      "SELECT product_id, revision::text AS revision FROM inventory.publication_selection_work ORDER BY 1")).rows;
    const bumped = after.filter((row) => before.find((old) => old.product_id === row.product_id)?.revision !== row.revision)
      .map((row) => row.product_id);
    expect(bumped).toEqual([1001, 1002]);

    // The same key and request: the stored answer, no second write, even while writes are paused.
    const paused = harness(db.pool, { disabled: true });
    const replay = await saveOf(paused, request, preview);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.answer).toEqual(first.answer);
    expect(await counts(db.pool, 10)).toEqual({ revisions: 1, audits: 1, picks: [2001, 2003] });
    // The same key with another request is a conflict.
    await expect(refusalOf(saveOf(paused, { ...request, add: [2001] }, preview)))
      .resolves.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
  }, CASE_TIMEOUT_MS);

  it("two tabs saving from one revision: one commits, the other is told the selection changed (409)", async () => {
    const h = harness(db.pool);
    const tabOne = await previewOf(h, { vendorId: 11, add: [2001] });
    const tabTwo = await previewOf(h, { vendorId: 11, add: [2005] });
    const results = await Promise.allSettled([saveOf(h, { vendorId: 11, add: [2001] }, tabOne), saveOf(h, { vendorId: 11, add: [2005] }, tabTwo)]);
    const committed = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(committed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: "DROPSHIP_SELECTION_REVISION_CONFLICT", context: { expectedRevisionId: null } });
    expect((await counts(db.pool, 11)).revisions).toBe(1);
    expect((await counts(db.pool, 11)).picks).toHaveLength(1);
  }, CASE_TIMEOUT_MS);

  it("answers busy while the gate's shared side is held through every attempt, and rolls back every row", async () => {
    const holder = await holdGateShared(db.pool);
    try {
      const h = harness(db.pool, { sleep: async () => undefined });
      const before = await counts(db.pool, 12);
      const error = await refusalOf(saveOf(h, { vendorId: 12, add: [2007] }));
      expect(error).toMatchObject({ code: "PUBLICATION_SELECTION_BUSY", context: { classification: "transient", attempts: SELECTION_SAVE_ATTEMPTS,
        lastErrorCode: "55P03" } });
      expect(h.sleeps).toHaveLength(SELECTION_SAVE_ATTEMPTS - 1);
      expect(h.logs.filter((line) => line.level === "warn").map((line) => line.code)).toEqual(["dropship.selection.change_busy"]);
      // Rollback: no revision, no audit row, no pick.
      expect(await counts(db.pool, 12)).toEqual(before);
    } finally {
      await holder.release();
    }
  }, CASE_TIMEOUT_MS);

  it("succeeds on the server's retry once the gate is released between attempts", async () => {
    const holder = await holdGateShared(db.pool);
    const h = harness(db.pool, { sleep: async () => { await holder.release(); } });
    const { answer } = await saveOf(h, { vendorId: 13, add: [2009] });
    expect(answer.toAdd).toBe(1);
    expect(h.sleeps).toHaveLength(1);
    expect(h.logs.filter((line) => line.code === "dropship.selection.change_retry")).toEqual([
      expect.objectContaining({ context: expect.objectContaining({ error_code: "55P03", attempt: 1 }) })]);
    expect(await counts(db.pool, 13)).toEqual({ revisions: 1, audits: 1, picks: [2009] });
  }, CASE_TIMEOUT_MS);

  it("waits on a size's row lock at the pre-lock, before the gate: a stock publication can take the gate meanwhile", async () => {
    const rowHolder = await db.pool.connect();
    let probe: PoolClient | undefined;
    try {
      await rowHolder.query("BEGIN");
      await rowHolder.query("SELECT id FROM catalog.product_variants WHERE id = 2011 FOR UPDATE");
      const h = harness(db.pool);
      const preview = await previewOf(h, { vendorId: 14, add: [2011] });
      const saving = saveOf(h, { vendorId: 14, add: [2011] }, preview);
      let pid: number | null = null;
      await waitFor(async () => (pid = await waitingBackend(db.pool, "SELECT id FROM catalog.product_variants")) !== null, "the pre-lock wait");
      expect(await holdsGate(db.pool, pid!)).toBe(false);
      probe = await db.pool.connect();
      expect((await probe.query<{ ok: boolean }>("SELECT pg_try_advisory_lock_shared(918419, 0) AS ok")).rows[0]!.ok).toBe(true);
      await probe.query("SELECT pg_advisory_unlock_shared(918419, 0)");
      await rowHolder.query("COMMIT");
      const { answer } = await saving;
      expect(answer.toAdd).toBe(1);
      expect(h.sleeps).toEqual([]);
      expect((await counts(db.pool, 14)).picks).toEqual([2011]);
    } finally {
      await rowHolder.query("ROLLBACK").catch(() => undefined);
      rowHolder.release();
      probe?.release();
    }
  }, CASE_TIMEOUT_MS);

  it("takes no gate for a no-op change: it saves its revision and audit while a stock publication holds the gate", async () => {
    await seedPicks(db.pool, 15, [2013]);
    const holder = await holdGateShared(db.pool);
    try {
      const h = harness(db.pool, { sleep: async () => { throw new Error("a no-op save must not retry"); } });
      const { answer } = await saveOf(h, { vendorId: 15, add: [2013], remove: [2015] });
      expect(answer).toMatchObject({ toAdd: 0, toRemove: 0, alreadySelected: 1, alreadyNotSelected: 1 });
      expect(await counts(db.pool, 15)).toEqual({ revisions: 2, audits: 1, picks: [2013] });
    } finally {
      await holder.release();
    }
  }, CASE_TIMEOUT_MS);

  it("R7: a deadlock with an ungated multi-product writer in the other order is retried, never a 500", async () => {
    // Work rows for both products exist, so each side locks rows (the upsert's update path).
    await db.pool.query("SELECT inventory.invalidate_publication_selection_product(1009), inventory.invalidate_publication_selection_product(1010)");
    const writer = await db.pool.connect();
    try {
      await writer.query("BEGIN");
      // The save waits first, so its deadlock check runs first and it is the one rolled back.
      await writer.query("SET LOCAL deadlock_timeout = '10s'");
      await writer.query("SELECT inventory.invalidate_publication_selection_product(1010)");
      const h = harness(db.pool);
      // 2017 is product 1009 (P1), 2019 is product 1010 (P2): the picks' invalidation runs in product order, P1 then P2.
      const preview = await previewOf(h, { vendorId: 16, add: [2017, 2019] });
      const saving = saveOf(h, { vendorId: 16, add: [2017, 2019] }, preview);
      await waitFor(async () => (await waitingBackend(db.pool, "INSERT INTO dropship.dropship_vendor_selected_variants")) !== null,
        "the save to wait on P2's work row");
      // P1 now: the cycle closes; PostgreSQL rolls back the save, which retries after the writer commits.
      await writer.query("SELECT inventory.invalidate_publication_selection_product(1009)");
      await writer.query("COMMIT");
      const { answer } = await saving;
      expect(answer.toAdd).toBe(2);
      expect(h.logs.filter((line) => line.code === "dropship.selection.change_retry")).toEqual([
        expect.objectContaining({ context: expect.objectContaining({ error_code: "40P01" }) })]);
      expect(h.logs.filter((line) => line.level === "error")).toEqual([]);
      expect((await counts(db.pool, 16)).picks).toEqual([2017, 2019]);
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
  }, CASE_TIMEOUT_MS);

  it("keeps writes closed while a version-1 process is fresh and until version 2 is five minutes old, then opens (CHK10)", async () => {
    const h = harness(db.pool);
    try {
      await writeProcessHeartbeat(db.pool, { processKey: "web.9:a", catalogCodeVersion: 1 });
      const fresh = await refusalOf(saveOf(h, { vendorId: 17, add: [2001] }));
      expect(fresh).toMatchObject({ code: "DROPSHIP_SELECTION_WRITES_PAUSED", context: { reason: "older_version_running",
        olderVersionLive: true, versionSettled: true } });
      expect(await counts(db.pool, 17)).toEqual({ revisions: 0, audits: 0, picks: [] });

      await db.pool.query(`UPDATE dropship.dropship_process_heartbeats SET last_seen_at = clock_timestamp() - interval '130 seconds'
        WHERE process_key = 'web.9:a'`);
      await db.pool.query(`UPDATE dropship.dropship_catalog_code_versions SET first_seen_at = clock_timestamp() - interval '60 seconds'
        WHERE catalog_code_version = 2`);
      const settling = await refusalOf(saveOf(h, { vendorId: 17, add: [2001] }));
      expect(settling).toMatchObject({ code: "DROPSHIP_SELECTION_WRITES_PAUSED", context: { reason: "older_version_running",
        olderVersionLive: false, versionSettled: false } });
      expect(await counts(db.pool, 17)).toEqual({ revisions: 0, audits: 0, picks: [] });

      await db.pool.query(`UPDATE dropship.dropship_catalog_code_versions SET first_seen_at = clock_timestamp() - interval '310 seconds'
        WHERE catalog_code_version = 2`);
      const { answer } = await saveOf(h, { vendorId: 17, add: [2001] });
      expect(answer.toAdd).toBe(1);
      // No server retry for a closed gate: it is minutes, so the page retries on its own schedule.
      expect(h.sleeps).toEqual([]);
    } finally {
      await db.pool.query("DELETE FROM dropship.dropship_process_heartbeats WHERE process_key = 'web.9:a'");
      await db.pool.query(`UPDATE dropship.dropship_catalog_code_versions SET first_seen_at = clock_timestamp() - interval '10 minutes'
        WHERE catalog_code_version = 2`);
    }
  }, CASE_TIMEOUT_MS);

  it("waits for the SHARE-lock statements (settings writes, sync-back's lockListing) before a pick delete, without holding the gate", async () => {
    await seedPicks(db.pool, 18, [2003]);
    const settings = await db.pool.connect();
    try {
      await settings.query("BEGIN");
      await settings.query(LISTING_SELECTION_LOCK_SQL);
      const h = harness(db.pool);
      const preview = await previewOf(h, { vendorId: 18, remove: [2003] });
      const saving = saveOf(h, { vendorId: 18, remove: [2003] }, preview);
      let pid: number | null = null;
      await waitFor(async () => (pid = await waitingBackend(db.pool, "DELETE FROM dropship.dropship_vendor_selected_variants")) !== null,
        "the pick delete to wait");
      expect(await holdsGate(db.pool, pid!)).toBe(false);
      expect((await counts(db.pool, 18)).picks).toEqual([2003]);
      await delay(200);
      const committedAt = performance.now();
      await settings.query("COMMIT");
      const { answer } = await saving;
      expect(performance.now()).toBeGreaterThan(committedAt);
      expect(answer.toRemove).toBe(1);
      expect((await counts(db.pool, 18)).picks).toEqual([]);
    } finally {
      await settings.query("ROLLBACK").catch(() => undefined);
      settings.release();
    }
  }, CASE_TIMEOUT_MS);

  it("SAFETY-9: a size deleted between the plan and the pre-lock is retried, skipped as not offered, and never claimed", async () => {
    let deleted = false;
    const real = new PgDropshipSelectionChangeRepository(db.pool);
    const repository: DropshipSelectionChangeRepository = {
      runPreview: (work) => real.runPreview(work),
      runChange: (input, work) => real.runChange(input, (tx) => work({
        ...tx,
        preLockVariants: async (lock) => {
          if (!deleted) {
            deleted = true;
            // The catalog's hard delete takes no vendor lock (catalog.routes.ts): it lands between the plan and the pre-lock.
            await db.pool.query("DELETE FROM inventory.publication_variant_mapping_heads WHERE product_variant_id = 2020");
            await db.pool.query("DELETE FROM catalog.product_variants WHERE id = 2020");
          }
          return tx.preLockVariants(lock);
        },
      } satisfies DropshipSelectionChangeTransaction)),
    };
    const h = harness(db.pool, { repository });
    const { answer } = await saveOf(h, { vendorId: 19, add: [2019, 2020] });
    expect(deleted).toBe(true);
    expect(answer).toMatchObject({ toAdd: 1, skipped: { count: 1, first: [2020] } });
    expect(h.logs.filter((line) => line.code === "dropship.selection.change_retry")).toEqual([
      expect.objectContaining({ context: expect.objectContaining({ error_code: "DROPSHIP_SELECTION_CHANGE_PLAN_MOVED" }) })]);
    expect(await counts(db.pool, 19)).toEqual({ revisions: 1, audits: 1, picks: [2019] });
    const audit = (await db.pool.query(`SELECT payload FROM dropship.dropship_audit_events
      WHERE vendor_id = 19 AND event_type = 'vendor_selection_picks_changed'`)).rows[0]!.payload;
    expect(audit).toMatchObject({ addedVariantIds: [2019], skippedVariantIds: [2020] });
  }, CASE_TIMEOUT_MS);

  // SRV-1: the save reads its plan one statement at a time (READ COMMITTED), and a catalog change takes no vendor lock.
  it("SRV-1: a removed size the catalog stops offering between the plan's offer read and its selected count keeps both counts right", async () => {
    const plain = harness(db.pool);
    await saveOf(plain, { vendorId: 20, add: [2017, 2018] });
    const preview = await previewOf(plain, { vendorId: 20, remove: [2017] });
    expect(preview).toMatchObject({ toRemove: 1, selectedBefore: 2, selectedAfter: 1 });
    let raced = 0;
    const hooked = harness(db.pool, { repository: new PgDropshipSelectionChangeRepository(poolRunningBefore(db.pool,
      SELECTED_KEYSET_STATEMENT, async () => {
        if (raced > 0) return;
        raced += 1;
        // Committed on another connection after the offer read saw 2017 offered, before the keyset counts the selection.
        await db.pool.query("UPDATE catalog.product_variants SET sales_eligibility = 'internal_only' WHERE id = 2017");
      })) });
    try {
      const { answer } = await saveOf(hooked, { vendorId: 20, remove: [2017] }, preview);
      expect(raced).toBe(1);
      // 2018 stays selected: the count after is 1, never 0 (the keyset alone no longer counts 2017).
      expect(answer).toMatchObject({ toRemove: 1, selectedBefore: 2, selectedAfter: 1 });
      expect(hooked.logs.filter((line) => line.level !== "info")).toEqual([]);
      expect(await counts(db.pool, 20)).toEqual({ revisions: 2, audits: 2, picks: [2018] });
      const audit = (await db.pool.query(`SELECT payload FROM dropship.dropship_audit_events
        WHERE vendor_id = 20 AND entity_id = $1`, [String(answer.revisionId)])).rows[0]!.payload;
      expect(audit).toMatchObject({ removedVariantIds: [2017], selectedBefore: 2, selectedAfter: 1 });
      expect(await revisionPickCount(answer.revisionId)).toBe(1);
    } finally {
      await db.pool.query("UPDATE catalog.product_variants SET sales_eligibility = 'sellable' WHERE id = 2017");
    }
  }, CASE_TIMEOUT_MS);

  it("SRV-1: a removed size the catalog deletes between the plan's offer read and its selected count is re-planned, never a 500", async () => {
    const plain = harness(db.pool);
    await saveOf(plain, { vendorId: 21, add: [2016] });
    const preview = await previewOf(plain, { vendorId: 21, remove: [2016] });
    expect(preview).toMatchObject({ toRemove: 1, selectedBefore: 1, selectedAfter: 0 });
    let raced = 0;
    const hooked = harness(db.pool, { sleep: async () => undefined, repository: new PgDropshipSelectionChangeRepository(
      poolRunningBefore(db.pool, SELECTED_KEYSET_STATEMENT, async () => {
        if (raced > 0) return;
        raced += 1;
        // The catalog's hard delete (catalog.routes.ts) cascades the vendor's pick of 2016 and takes no vendor lock.
        await db.pool.query("DELETE FROM inventory.publication_variant_mapping_heads WHERE product_variant_id = 2016");
        await db.pool.query("DELETE FROM catalog.product_variants WHERE id = 2016");
      })) });
    const { answer } = await saveOf(hooked, { vendorId: 21, remove: [2016] }, preview);
    expect(raced).toBe(1);
    // The delete finds no row (the cascade took it): PLAN_MOVED, and the re-plan finds nothing left to remove.
    expect(answer).toMatchObject({ toRemove: 0, alreadyNotSelected: 1, selectedBefore: 0, selectedAfter: 0 });
    expect(hooked.logs.filter((line) => line.level !== "info")).toEqual([
      expect.objectContaining({ level: "debug", code: "dropship.selection.change_retry",
        context: expect.objectContaining({ error_code: "DROPSHIP_SELECTION_CHANGE_PLAN_MOVED", error_class: "transient" }) })]);
    expect(await counts(db.pool, 21)).toEqual({ revisions: 2, audits: 2, picks: [] });
    // The touched pick is counted from the plan's own read, so the cascade never made the pick count negative (23514).
    expect(await revisionPickCount(answer.revisionId)).toBe(0);
  }, CASE_TIMEOUT_MS);
});

async function revisionPickCount(revisionId: number): Promise<number | null> {
  return (await activePool.query<{ pick_count: number | null }>(
    "SELECT pick_count FROM dropship.dropship_vendor_selection_rule_set_revisions WHERE id = $1", [revisionId])).rows[0]?.pick_count ?? null;
}

/** The selected-catalog keyset over a vendor's picks (dropship-selected-catalog.reader.ts `listVariantIds`). */
const SELECTED_KEYSET_STATEMENT = /FROM dropship\.dropship_vendor_selected_variants s\s+INNER JOIN catalog\.product_variants pv/;

/**
 * A pool whose clients await `before` ahead of every statement that matches `statement`: a test runs a catalog
 * write on another connection between two statements of one save, as a concurrent admin request would (SRV-1).
 */
function poolRunningBefore(pool: Pool, statement: RegExp, before: () => Promise<void>): Pick<Pool, "connect"> {
  return {
    connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return async (...args: unknown[]) => {
              if (typeof args[0] === "string" && statement.test(args[0])) await before();
              return query(...args);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pick<Pool, "connect">;
}

/**
 * The scale fixture: 2,000 products with five sizes each (10,000 sizes, 100001-110000), each with an active
 * mapping head, listed live on both of vendor 50's eBay stores (20,000 listing rows), plus 500 unrelated
 * products (110001-110500) with mapping heads that the save must not invalidate.
 */
const SCALE_SEED_SQL = `
  INSERT INTO catalog.products (id, sku, name, category, is_active, status, product_type, ebay_listing_excluded)
    SELECT g, 'P-' || g, 'Product ' || g, 'Supplies', true, 'active', 'sleeves', false FROM generate_series(10001, 12500) g;
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded)
    SELECT g, 10001 + (g - 100001) / 5, 'S-' || g, 'Size ' || g, 'pack', true, true, true, 'sellable', false
    FROM generate_series(100001, 110000) g;
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded)
    SELECT g, 12001 + (g - 110001), 'S-' || g, 'Size ' || g, 'pack', true, true, true, 'sellable', false
    FROM generate_series(110001, 110500) g;
  INSERT INTO dropship.dropship_catalog_rules (scope_type, action, is_active, priority) VALUES ('catalog', 'include', true, 0);
  INSERT INTO inventory.publication_variant_mapping_heads (publication_target_id, product_variant_id, active_mapping_id)
    SELECT 1, id, id FROM catalog.product_variants;
  INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (50, 'member-50');
  INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, external_account_id, provider_environment,
    external_display_name) VALUES (150, 50, 'ebay', 'connected', 'seller-150', 'production', 'Store A'),
    (151, 50, 'ebay', 'connected', 'seller-151', 'production', 'Store B');
  INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, inventory_mode, is_active) VALUES
    (150, 'ebay', 'live', 'managed_quantity_sync', true), (151, 'ebay', 'live', 'managed_quantity_sync', true);
  INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id,
    external_offer_id, status)
    SELECT 50, s.id, v.id, 'ebay', 'L-' || s.id || '-' || v.id, 'O-' || s.id || '-' || v.id, 'active'
    FROM generate_series(100001, 110000) v(id) CROSS JOIN (VALUES (150), (151)) s(id);
  ANALYZE;
`;

async function workRevisions(pool: Pool): Promise<Map<number, string>> {
  return new Map((await pool.query<{ product_id: number; revision: string }>(
    "SELECT product_id, revision::text AS revision FROM inventory.publication_selection_work")).rows.map((row) => [row.product_id, row.revision]));
}

describeDatabase.sequential("the picks save at 10,000 picks (PostgreSQL)", () => {
  let db: ChangeDatabase;

  beforeAll(async () => {
    db = await createChangeDatabase(SCALE_SEED_SQL);
    activePool = db.pool;
  }, SCALE_CASE_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  it(`adds and then removes 10,000 picks on two stores within ${SAVE_BUDGET_MS} ms per save and ${GATE_HOLD_BUDGET_MS} ms of gate`, async () => {
    const sizes = Array.from({ length: 10_000 }, (_, index) => 100_001 + index);
    const h = harness(db.pool);
    const measured: Record<string, number> = {};

    let started = performance.now();
    const addPreview = await previewOf(h, { vendorId: 50, add: sizes });
    measured.previewAddMs = performance.now() - started;
    expect(addPreview).toMatchObject({ toAdd: 10_000, selectedBefore: 0, selectedAfter: 10_000, refused: null,
      effects: [{ storeConnectionId: 150, startsSelling: 10_000, goesToZero: 0 }, { storeConnectionId: 151, startsSelling: 10_000, goesToZero: 0 }] });

    // The seed's mapping heads invalidated every product once; the save must bump only its own.
    const workBefore = await workRevisions(db.pool);
    let sampler = samplePublicationSelectionGate(db.pool);
    started = performance.now();
    const added = await saveOf(h, { vendorId: 50, add: sizes }, addPreview);
    measured.saveAddMs = performance.now() - started;
    measured.gateHoldAddMs = publicationSelectionGateHoldMs(await sampler.stop());
    expect(added.answer).toMatchObject({ toAdd: 10_000, selectedAfter: 10_000 });
    expect((await counts(db.pool, 50)).picks).toHaveLength(10_000);

    // Only the 2,000 products the picks name were invalidated; the 500 unrelated mapping heads were not.
    const workAfter = await workRevisions(db.pool);
    const bumped = [...workAfter].filter(([productId, revision]) => workBefore.get(productId) !== revision).map(([productId]) => productId);
    expect({ low: Math.min(...bumped), high: Math.max(...bumped), n: bumped.length }).toEqual({ low: 10_001, high: 12_000, n: 2_000 });

    started = performance.now();
    const removePreview = await previewOf(h, { vendorId: 50, remove: sizes });
    measured.previewRemoveMs = performance.now() - started;
    expect(removePreview).toMatchObject({ toRemove: 10_000, selectedAfter: 0,
      effects: [{ storeConnectionId: 150, goesToZero: 10_000 }, { storeConnectionId: 151, goesToZero: 10_000 }] });

    sampler = samplePublicationSelectionGate(db.pool);
    started = performance.now();
    const removed = await saveOf(h, { vendorId: 50, remove: sizes }, removePreview);
    measured.saveRemoveMs = performance.now() - started;
    measured.gateHoldRemoveMs = publicationSelectionGateHoldMs(await sampler.stop());
    expect(removed.answer).toMatchObject({ toRemove: 10_000, selectedAfter: 0 });
    expect((await counts(db.pool, 50)).picks).toEqual([]);

    const busyRetries = h.logs.filter((line) => line.code === "dropship.selection.change_retry").length;
    // Recorded for BUILD-NOTES (§15.3), as the picks migration suite records its lock windows.
    process.stdout.write(`[pg-record] picks save at scale: ${JSON.stringify({
      ...Object.fromEntries(Object.entries(measured).map(([key, value]) => [key, Math.round(value)])), busyRetries })}\n`);
    expect(measured.saveAddMs).toBeLessThan(SAVE_BUDGET_MS);
    expect(measured.saveRemoveMs).toBeLessThan(SAVE_BUDGET_MS);
    expect(measured.gateHoldAddMs).toBeLessThan(GATE_HOLD_BUDGET_MS);
    expect(measured.gateHoldRemoveMs).toBeLessThan(GATE_HOLD_BUDGET_MS);
    expect(measured.gateHoldAddMs).toBeGreaterThan(0);
  }, SCALE_CASE_TIMEOUT_MS);
});
