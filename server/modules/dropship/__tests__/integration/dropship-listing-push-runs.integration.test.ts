import { createHash } from "node:crypto";
import pg, { type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executeMigrationWithRetry, type MigrationRetryNotice } from "../../../../../migrations/migration-executor";
import type { DropshipCostChangePolicyInForce } from "../../application/dropship-cost-change-policy-service";
import { DropshipListingPushOpsService } from "../../application/dropship-listing-push-ops-service";
import {
  DropshipListingPushRunService,
} from "../../application/dropship-listing-push-run-service";
import {
  DropshipListingPushRunSweepService,
  type ListingPushRunPriceCheck,
} from "../../application/dropship-listing-push-run-sweep";
import {
  hashListingPushJobRequest,
  type DropshipListingPreviewResult,
  type DropshipListingPreviewRow,
} from "../../application/dropship-listing-preview-service";
import { refreshQueuedListingIntent } from "../../application/dropship-listing-intent-refresh";
import { DropshipListingPushWorkerService } from "../../application/dropship-listing-push-worker-service";
import type { DropshipLogEvent, DropshipNotificationSenderInput } from "../../application/dropship-ports";
import {
  createListingPushJobInputSchema,
  type CreateListingPushJobInput,
  type GenerateVendorListingPreviewInput,
} from "../../application/dropship-use-case-dtos";
import { evaluateDropshipCatalogExposure } from "../../domain/catalog-exposure";
import { evaluateDropshipVendorCatalogSelection } from "../../domain/vendor-selection";
import { DropshipError } from "../../domain/errors";
import { QuantityPublicationAdmissionError } from "../../../inventory-planning/domain/quantity-publication-admission";
import { runTargetOutcomeForItem } from "../../domain/listing-push-run";
import { PgDropshipListingPreviewRepository } from "../../infrastructure/dropship-listing-preview.repository";
import {
  PgDropshipListingPushJobQueueRepository,
  runDropshipListingPushSweep,
} from "../../infrastructure/dropship-listing-push-job-runner";
import { PgDropshipListingPushOpsRepository } from "../../infrastructure/dropship-listing-push-ops.repository";
import { DropshipListingPushRecoveryService } from "../../application/dropship-listing-push-recovery-service";
import { PgDropshipListingLiveStatusRepairRepository } from "../../infrastructure/dropship-listing-live-status-repair.repository";
import { PgDropshipListingPushRunRepository } from "../../infrastructure/dropship-listing-push-run.repository";
import {
  PgDropshipListingPushRunSweepRepository,
  targetOutcomeFromItemSql,
} from "../../infrastructure/dropship-listing-push-run-sweep.repository";
import { PgDropshipListingPushWorkerRepository } from "../../infrastructure/dropship-listing-push-worker.repository";
import { lockVendorSelection } from "../../infrastructure/dropship-vendor-selection-lock";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import {
  LISTING_PUSH_RUNS_MIGRATION_FILE,
  listingPushRunsBaseFixtureSql,
  listingPushRunsMigrationSql,
  removePicks,
} from "../fixtures/listing-push-runs.fixture";
import { ebaySyncBackListingColumnsSql } from "../fixtures/ebay-sync-back.fixture";

/**
 * Publish runs against a real PostgreSQL (step 1 plan S2-5, PR A, §4.13): the
 * migration through the release executor, run creation under the vendor's
 * selection lock, expansion through the real job queue writer, the real item
 * worker with a stubbed marketplace, reconcile and finish, stop, pause and
 * backoff, and the price review pre-filter on real cost rows.
 */
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const PRESS = new Date("2026-10-20T12:00:00.000Z");
const VENDOR = 10;
const MEMBER = "member-10";
const STORE = 22;
const OTHER_VENDOR = 11;
const OTHER_STORE = 23;
const FIRST_SIZE = 1001;
const WORKER_ID = "pg-run-worker";

const REPLAY_TIMEOUT_MS = 120_000;

describeDatabase.sequential("publish runs (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;
  let wide: pg.Pool;
  let now = PRESS;
  const clock = { now: () => now };
  const logs: Array<DropshipLogEvent & { level: string }> = [];
  const logger = {
    info: (event: DropshipLogEvent) => { logs.push({ ...event, level: "info" }); },
    warn: (event: DropshipLogEvent) => { logs.push({ ...event, level: "warn" }); },
    error: (event: DropshipLogEvent) => { logs.push({ ...event, level: "error" }); },
  };
  const notices: DropshipNotificationSenderInput[] = [];
  const notificationSender = { send: async (input: DropshipNotificationSenderInput) => { notices.push(input); } };
  const migrationNotices: MigrationRetryNotice[] = [];
  const migrationEvidence: { relationsBeforeRetry: unknown[]; attempts: number } = { relationsBeforeRetry: [], attempts: 0 };
  let policy: DropshipCostChangePolicyInForce["settings"]["rulePricedListings"] = "reprice_automatically";
  let priceCheckCalls: number[][] = [];
  let rulePricedIds = new Set<number>();
  let providerCalls: number[] = [];
  let providerHook: ((productVariantId: number, call: number) => Promise<void>) | null = null;
  let providerError: ((productVariantId: number, call: number) => Error | null) | null = null;
  // The store saves drafts instead of publishing (a listing mode that is not live): the provider answers published false.
  let providerDrafts = false;

  type ChunkJobWriter = (input: CreateListingPushJobInput) => Promise<{ job: { jobId: number } }>;
  function services(options: {
    afterChunkJob?: (input: CreateListingPushJobInput) => Promise<void>;
    beforeChunkJob?: (input: CreateListingPushJobInput) => Promise<void>;
    /**
     * The worker rebuilds each queued intent at push time (refreshQueuedListingIntent, as the worker factory wires it),
     * from a preview whose selection is decided as the preview service decides it (PS generatePreviewForContext: the
     * real catalog, exposure, picks and override readers, the real evaluator, the `selection:<reason>` blocker of
     * buildListingPreviewRow); every other preview fact is the queued row's. Off by default: the other cases push the
     * queued intent as before.
     */
    pushTimeSelection?: boolean;
  } = {}) {
    const runRepository = new PgDropshipListingPushRunRepository(pool);
    const runService = new DropshipListingPushRunService({
      repository: runRepository,
      pushAccess: { assertListingPushAccess: async () => undefined },
      clock, logger,
    });
    const previewRepository = new PgDropshipListingPreviewRepository(pool);
    const createChunkJob = async (input: CreateListingPushJobInput) => {
      const parsed = createListingPushJobInputSchema.parse(input);
      const ids = [...new Set(parsed.productVariantIds)].sort((left, right) => left - right);
      const sizes = await pool.query<{ id: number; product_id: number; sku: string }>(
        "SELECT id, product_id, sku FROM catalog.product_variants WHERE id = ANY($1::int[]) ORDER BY id", [ids]);
      const rows = sizes.rows.map((size) => previewRow(size.id, size.product_id, size.sku));
      return previewRepository.createListingPushJob({
        vendorId: parsed.vendorId, storeConnectionId: parsed.storeConnectionId, platform: "ebay",
        productVariantIds: ids, requestedRetailPricesByVariantId: {}, idempotencyKey: parsed.idempotencyKey,
        requestHash: hashListingPushJobRequest({ reviewMode: "current_preview", vendorId: parsed.vendorId,
          storeConnectionId: parsed.storeConnectionId, productVariantIds: ids, requestedRetailPriceCents: null }),
        requestedBy: parsed.requestedBy,
        preview: { vendorId: parsed.vendorId, storeConnectionId: parsed.storeConnectionId, platform: "ebay", generatedAt: now,
          rows, summary: { total: rows.length, ready: rows.length, blocked: 0, warning: 0 } },
        now: clock.now(),
        ...(parsed.run ? { run: parsed.run } : {}),
      });
    };
    const priceCheck: ListingPushRunPriceCheck = async (input) => {
      priceCheckCalls.push([...input.productVariantIds]);
      return input.productVariantIds.map((productVariantId) => ({ productVariantId, rulePriced: rulePricedIds.has(productVariantId) }));
    };
    let tick = 0;
    const chunkJobWriter: ChunkJobWriter = async (input) => {
      await options.beforeChunkJob?.(input);
      const created = await createChunkJob(input);
      await options.afterChunkJob?.(input);
      return created;
    };
    const sweepService = new DropshipListingPushRunSweepService({
      repository: new PgDropshipListingPushRunSweepRepository(pool),
      createChunkJob: chunkJobWriter,
      priceCheck,
      resolveCostChangePolicy: async () => ({ policyId: 1, settings: { rulePricedListings: policy } as DropshipCostChangePolicyInForce["settings"] }),
      notificationSender,
      clock,
      timer: () => (tick += 1),
      logger,
    });
    const pushTimePreview = async (input: GenerateVendorListingPreviewInput): Promise<DropshipListingPreviewResult> => {
      const ids = [...input.productVariantIds];
      // One after another, as the preview repository's pool allows.
      const candidates = await previewRepository.listCatalogCandidates(ids);
      const adminRules = await previewRepository.listCatalogExposureRules();
      const pickedIds = await previewRepository.listPickedVariantIds(input.vendorId, ids);
      const overrides = await previewRepository.listVariantOverrides({ vendorId: input.vendorId, productVariantIds: ids });
      const rows = candidates.map((candidate): DropshipListingPreviewRow => {
        const row = previewRow(candidate.productVariantId, candidate.productId, candidate.sku ?? `S-${candidate.productVariantId}`);
        const selection = evaluateDropshipVendorCatalogSelection({
          candidate, adminExposureDecision: evaluateDropshipCatalogExposure(candidate, adminRules, clock.now()),
          picked: pickedIds.has(candidate.productVariantId), rawAtpUnits: 3,
          override: overrides.find((override) => override.productVariantId === candidate.productVariantId) ?? null,
        });
        return selection.selected ? row
          : { ...row, previewStatus: "blocked", blockers: [`selection:${selection.reason}`], listingIntent: null } as DropshipListingPreviewRow;
      });
      const blocked = rows.filter((row) => row.previewStatus === "blocked").length;
      return { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, platform: "ebay", generatedAt: clock.now(), rows,
        summary: { total: rows.length, ready: rows.length - blocked, blocked, warning: 0 } };
    };
    const worker = new DropshipListingPushWorkerService({
      repository: new PgDropshipListingPushWorkerRepository(pool),
      ...(options.pushTimeSelection ? {
        refreshListingIntent: (input) => refreshQueuedListingIntent({
          generatePreview: pushTimePreview,
          resolveCostChangePolicy: async () => ({ policyId: 1, settings: { rulePricedListings: policy } as DropshipCostChangePolicyInForce["settings"] }),
          logger,
        }, input),
      } : {}),
      marketplacePush: {
        pushListing: async (input) => {
          providerCalls.push(input.productVariantId);
          const call = providerCalls.length;
          const error = providerError?.(input.productVariantId, call) ?? null;
          if (error) throw error;
          await providerHook?.(input.productVariantId, call);
          return { status: "created" as const, externalListingId: `EBAY-${input.productVariantId}`,
            externalOfferId: `OFFER-${input.productVariantId}`,
            rawResult: { provider: "ebay", ...(providerDrafts ? { published: false } : {}) } };
        },
      },
      notificationSender,
      clock,
      logger,
    });
    const queueRepository = new PgDropshipListingPushJobQueueRepository(pool);
    const sweep = () => runDropshipListingPushSweep({
      repository: queueRepository,
      processJob: async (input) => { await worker.processJob(input); },
      runs: sweepService,
      batchSize: 10,
      staleProcessingMinutes: 30,
      now: clock.now(),
      workerId: WORKER_ID,
    });
    return { runRepository, runService, sweepService, worker, queueRepository, sweep, createChunkJob, previewRepository };
  }

  function previewRow(productVariantId: number, productId: number, sku: string): DropshipListingPreviewRow {
    return {
      productVariantId, productId, sku, title: `Size ${productVariantId}`, platform: "ebay", listingMode: "live",
      currentListingStatus: null, previewStatus: "ready", blockers: [], warnings: [], marketplaceQuantity: 3,
      priceCents: 1299, previewHash: `preview-${productVariantId}`, businessPolicySelection: null,
      listingIntent: { platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync", priceMode: "vendor_defined",
        productVariantId, sku, title: `Size ${productVariantId}`, priceCents: 1299, quantity: 3, marketplaceConfig: {} },
    } as unknown as DropshipListingPreviewRow;
  }

  beforeAll(async () => {
    // Plus the eBay sync-back listing columns a completed push writes (plan v4 §5 step 7), from the real migration.
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable,
      `${listingPushRunsBaseFixtureSql()}\n${ebaySyncBackListingColumnsSql()}`);
    pool = database.pool;
    wide = new pg.Pool({ connectionString: database.connectionString, max: 8 });

    // The release executor applies the file; a writer of the Card Shellz sizes holds them on the first attempt, so
    // the file's foreign key to them times out after its first tables were created (a 55P03 mid-file).
    const blocker = await wide.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE catalog.product_variants IN ROW EXCLUSIVE MODE");
    const migrationClient = await wide.connect();
    const sql = listingPushRunsMigrationSql();
    try {
      const result = await executeMigrationWithRetry({
        client: migrationClient, file: LISTING_PUSH_RUNS_MIGRATION_FILE, sql,
        contentHash: createHash("sha256").update(sql).digest("hex"),
        options: { maxAttempts: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 1, lockTimeoutMs: 300 },
        onRetry: (notice) => { migrationNotices.push(notice); },
        sleep: async () => {
          const relations = await wide.query(`SELECT to_regclass('dropship.dropship_listing_push_runs') AS runs,
            to_regclass('dropship.dropship_process_heartbeats') AS heartbeats,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'dropship'
              AND table_name = 'dropship_listing_push_jobs' AND column_name = 'run_id') AS run_column,
            (SELECT count(*)::int FROM public._migrations) AS applied`);
          migrationEvidence.relationsBeforeRetry.push(relations.rows[0]);
          await blocker.query("COMMIT");
        },
      });
      migrationEvidence.attempts = result.attempts;
    } finally {
      migrationClient.release();
      blocker.release();
    }
  }, REPLAY_TIMEOUT_MS);

  afterAll(async () => {
    await wide?.end();
    await database?.close();
  });

  beforeEach(async () => {
    now = PRESS;
    logs.length = 0;
    notices.length = 0;
    policy = "reprice_automatically";
    priceCheckCalls = [];
    rulePricedIds = new Set();
    providerCalls = [];
    providerHook = null;
    providerError = null;
    providerDrafts = false;
    await pool.query(`TRUNCATE dropship.dropship_listing_push_run_targets, dropship.dropship_listing_push_runs,
      dropship.dropship_listing_sync_events, dropship.dropship_listing_push_job_items, dropship.dropship_listing_push_jobs,
      dropship.dropship_vendor_listings, dropship.dropship_audit_events, dropship.dropship_vendor_selected_variants,
      dropship.dropship_vendor_selection_rules, dropship.dropship_vendor_selection_rule_set_revisions, dropship.dropship_catalog_rules,
      dropship.dropship_vendor_variant_overrides, dropship.dropship_cost_schedule_entries,
      dropship.dropship_listing_price_revisions, dropship.dropship_pricing_profile_revisions,
      dropship.dropship_product_listing_setting_revisions, dropship.dropship_category_listing_setting_revisions,
      dropship.dropship_store_listing_configs, dropship.dropship_store_connections, dropship.dropship_vendors,
      catalog.product_variants, catalog.products RESTART IDENTITY CASCADE`);
    await pool.query(`
      INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (${VENDOR}, '${MEMBER}'), (${OTHER_VENDOR}, 'member-11');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, access_token_ref, refresh_token_ref)
        VALUES (${STORE}, ${VENDOR}, 'ebay', 'vault:a', 'vault:r'), (${OTHER_STORE}, ${OTHER_VENDOR}, 'ebay', 'vault:a', 'vault:r');
      INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode)
        VALUES (${STORE}, 'ebay', 'live'), (${OTHER_STORE}, 'ebay', 'live');
      INSERT INTO dropship.dropship_catalog_rules (scope_type, action) VALUES ('catalog', 'include');
    `);
  });

  async function seedSizes(count: number): Promise<number[]> {
    await pool.query(`INSERT INTO catalog.products (id, sku, name)
      SELECT p, 'P' || p, 'Product ' || p FROM generate_series(1, ($1::int + 9) / 10) AS p`, [count]);
    await pool.query(`INSERT INTO catalog.product_variants (id, product_id, sku, name)
      SELECT ${FIRST_SIZE - 1} + g, 1 + (g - 1) / 10, 'SKU-' || (${FIRST_SIZE - 1} + g), 'Size ' || g
      FROM generate_series(1, $1::int) AS g`, [count]);
    return Array.from({ length: count }, (_, index) => FIRST_SIZE + index);
  }

  /**
   * The vendor's selection, saved as a step 1 save does (PLAN-B v4.1 §8.3): under the vendor lock, one revision
   * with the key and the picks replaced by `picks` ("every size": every catalog size now; at main a `catalog` include).
   */
  async function saveSelection(picks: "every size" | readonly number[], key: string): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockVendorSelection(client, VENDOR);
      const revision = await client.query<{ id: number }>(`INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions
        (vendor_id, idempotency_key, request_hash, actor_type, actor_id, rule_count) VALUES ($1, $2, $3, 'vendor', $4, 0) RETURNING id`,
      [VENDOR, key, createHash("sha256").update(key).digest("hex"), MEMBER]);
      const ids = picks === "every size"
        ? (await client.query<{ id: number }>("SELECT id FROM catalog.product_variants ORDER BY id")).rows.map((row) => row.id)
        : [...picks];
      await client.query("DELETE FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = $1 AND NOT product_variant_id = ANY($2::int[])",
        [VENDOR, ids]);
      await client.query(`INSERT INTO dropship.dropship_vendor_selected_variants (vendor_id, product_variant_id, revision_id, source, selected_at)
        SELECT $1, id, $2, 'vendor', $3 FROM unnest($4::int[]) id ON CONFLICT DO NOTHING`, [VENDOR, revision.rows[0].id, clock.now(), ids]);
      await client.query("COMMIT");
      return revision.rows[0].id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function createRun(input: { key: string; scope?: "not_live" | "all"; expected: number | null }) {
    return services().runService.createRunForMember(MEMBER, {
      storeConnectionId: STORE, scope: input.scope ?? "all", idempotencyKey: input.key, expectedSelectionRevisionId: input.expected,
    });
  }

  async function targetsOf(runId: number) {
    return (await pool.query<{ product_variant_id: number; chunk_index: number; outcome: string; code: string | null;
      retryable: boolean | null; job_item_id: number | null }>(
      `SELECT product_variant_id, chunk_index, outcome, code, retryable, job_item_id
       FROM dropship.dropship_listing_push_run_targets WHERE run_id = $1 ORDER BY product_variant_id`, [runId])).rows;
  }

  async function outcomeCounts(runId: number): Promise<Record<string, number>> {
    const rows = (await pool.query<{ outcome: string; count: number }>(
      `SELECT outcome, count(*)::int AS count FROM dropship.dropship_listing_push_run_targets WHERE run_id = $1
       GROUP BY outcome ORDER BY outcome`, [runId])).rows;
    return Object.fromEntries(rows.map((row) => [row.outcome, row.count]));
  }

  async function runRow(runId: number) {
    return (await pool.query(`SELECT status, stop_reason, cancel_requested_at, completed_at, next_chunk_index, chunk_attempts
      FROM dropship.dropship_listing_push_runs WHERE id = $1`, [runId])).rows[0];
  }

  async function expectSqlState(operation: () => Promise<unknown>, code: string, constraint?: string): Promise<void> {
    const error = await operation().then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code, ...(constraint ? { constraint } : {}) });
  }

  describe("the migration", () => {
    it("applies once through the release executor; a lock timeout mid-file left nothing behind and the retry succeeded", async () => {
      expect(migrationNotices).toHaveLength(1);
      expect(migrationNotices[0]).toMatchObject({ file: LISTING_PUSH_RUNS_MIGRATION_FILE, attempt: 1, sqlState: "55P03" });
      expect(migrationEvidence.relationsBeforeRetry).toEqual([{ runs: null, heartbeats: null, run_column: false, applied: 0 }]);
      expect(migrationEvidence.attempts).toBe(2);
      const applied = await pool.query("SELECT filename FROM public._migrations");
      expect(applied.rows).toEqual([{ filename: LISTING_PUSH_RUNS_MIGRATION_FILE }]);
      const relations = await pool.query(`SELECT to_regclass('dropship.dropship_listing_push_runs') IS NOT NULL AS runs,
        to_regclass('dropship.dropship_listing_push_run_targets') IS NOT NULL AS targets,
        to_regclass('dropship.dropship_process_heartbeats') IS NOT NULL AS heartbeats,
        to_regclass('dropship.dropship_catalog_code_versions') IS NOT NULL AS versions`);
      expect(relations.rows[0]).toEqual({ runs: true, targets: true, heartbeats: true, versions: true });
      // Not written to be re-run: a second application fails loudly and changes nothing.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await expectSqlState(() => client.query(listingPushRunsMigrationSql()), "42P07");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("adds the job columns with values that keep every existing job as it was, and no index on job items", async () => {
      await pool.query(`INSERT INTO dropship.dropship_listing_push_jobs (vendor_id, store_connection_id, status) VALUES (${VENDOR}, ${STORE}, 'queued')`);
      const job = await pool.query("SELECT run_id, run_chunk_index, next_attempt_at, consecutive_pause_count FROM dropship.dropship_listing_push_jobs");
      expect(job.rows).toEqual([{ run_id: null, run_chunk_index: null, next_attempt_at: null, consecutive_pause_count: 0 }]);
      const itemIndexes = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'dropship'
        AND tablename = 'dropship_listing_push_job_items' ORDER BY indexname`);
      expect(itemIndexes.rows.map((row) => row.indexname)).toEqual([
        "dropship_listing_job_item_idem_idx", "dropship_listing_job_item_job_variant_idx", "dropship_listing_push_job_items_pkey",
      ]);
    });

    it("refuses bad runs, targets, jobs and heartbeats by constraint", async () => {
      await seedSizes(2);
      const base = `INSERT INTO dropship.dropship_listing_push_runs (vendor_id, store_connection_id, scope, status, idempotency_key,
        request_hash, target_count, chunk_size, chunk_count, actor_type, created_at, updated_at, completed_at, cancel_requested_at, stop_reason)`;
      const hash = "a".repeat(64);
      const row = (overrides: Partial<Record<string, string>>) => {
        const value = { scope: "'all'", status: "'processing'", key: "'run-key-01'", hash: `'${hash}'`, targets: "1", size: "500",
          chunks: "1", completed: "NULL", cancel: "NULL", stop: "NULL", ...overrides };
        return `${base} VALUES (${VENDOR}, ${STORE}, ${value.scope}, ${value.status}, ${value.key}, ${value.hash}, ${value.targets},
          ${value.size}, ${value.chunks}, 'vendor', now(), now(), ${value.completed}, ${value.cancel}, ${value.stop})`;
      };
      // No run without a target (whichever of the count checks PostgreSQL meets first).
      await expectSqlState(() => pool.query(row({ targets: "0", chunks: "1" })), "23514");
      await expectSqlState(() => pool.query(row({ targets: "10001", chunks: "21" })), "23514", "dropship_push_run_target_count_chk");
      await expectSqlState(() => pool.query(row({ size: "501" })), "23514", "dropship_push_run_chunk_size_chk");
      await expectSqlState(() => pool.query(row({ targets: "1200", chunks: "2" })), "23514", "dropship_push_run_chunk_math_chk");
      await expectSqlState(() => pool.query(row({ scope: "'everything'" })), "23514", "dropship_push_run_scope_chk");
      await expectSqlState(() => pool.query(row({ hash: "'not-a-hash'" })), "23514", "dropship_push_run_hash_chk");
      await expectSqlState(() => pool.query(row({ status: "'completed'" })), "23514", "dropship_push_run_finished_chk");
      await expectSqlState(() => pool.query(row({ status: "'cancelled'", completed: "now()" })), "23514", "dropship_push_run_cancel_chk");
      await expectSqlState(() => pool.query(row({ cancel: "now()" })), "23514", "dropship_push_run_cancel_chk");
      await expectSqlState(() => pool.query(row({ stop: "'tired'" })), "23514", "dropship_push_run_stop_reason_chk");
      // A store that another vendor owns.
      await expectSqlState(() => pool.query(`${base} VALUES (${VENDOR}, ${OTHER_STORE}, 'all', 'processing', 'run-key-09', '${hash}', 1,
        500, 1, 'vendor', now(), now(), NULL, NULL, NULL)`), "23503", "dropship_push_run_store_owner_fk");
      const run = await pool.query<{ id: string }>(row({}) + " RETURNING id");
      const runId = Number(run.rows[0].id);
      // One unfinished run per store.
      await expectSqlState(() => pool.query(row({ key: "'run-key-02'" })), "23505", "dropship_push_run_one_active_idx");
      await expectSqlState(() => pool.query(row({ key: "'run-key-01'", status: "'failed'", completed: "now()" })), "23505", "dropship_push_run_vendor_key");
      await expectSqlState(() => pool.query(`INSERT INTO dropship.dropship_listing_push_run_targets
        (run_id, product_variant_id, chunk_index, outcome, decided_at) VALUES ($1, ${FIRST_SIZE}, 0, 'pending', now())`, [runId]),
      "23514", "dropship_push_run_target_decided_chk");
      await expectSqlState(() => pool.query(`INSERT INTO dropship.dropship_listing_push_run_targets
        (run_id, product_variant_id, chunk_index, outcome, decided_at) VALUES ($1, ${FIRST_SIZE}, 0, 'done', now())`, [runId]),
      "23514", "dropship_push_run_target_outcome_chk");
      await expectSqlState(() => pool.query(`INSERT INTO dropship.dropship_listing_push_jobs (vendor_id, store_connection_id, run_id)
        VALUES (${VENDOR}, ${STORE}, $1)`, [runId]), "23514", "dropship_listing_job_run_pair_chk");
      await pool.query(`INSERT INTO dropship.dropship_listing_push_jobs (vendor_id, store_connection_id, run_id, run_chunk_index)
        VALUES (${VENDOR}, ${STORE}, $1, 0)`, [runId]);
      await expectSqlState(() => pool.query(`INSERT INTO dropship.dropship_listing_push_jobs (vendor_id, store_connection_id, run_id, run_chunk_index)
        VALUES (${VENDOR}, ${STORE}, $1, 0)`, [runId]), "23505", "dropship_listing_job_run_chunk_idx");
      await expectSqlState(() => pool.query(`UPDATE dropship.dropship_listing_push_jobs SET consecutive_pause_count = -1`),
        "23514", "dropship_listing_job_pause_count_chk");
      await expectSqlState(() => pool.query(`INSERT INTO dropship.dropship_process_heartbeats VALUES (' ', 1, now(), now())`),
        "23514", "dropship_process_heartbeat_key_chk");
      await expectSqlState(() => pool.query(`INSERT INTO dropship.dropship_catalog_code_versions VALUES (0, now())`),
        "23514", "dropship_catalog_code_version_chk");
      // A deleted Card Shellz size takes its targets with it; it never blocks the catalog's delete.
      await pool.query(`INSERT INTO dropship.dropship_listing_push_run_targets (run_id, product_variant_id, chunk_index, outcome)
        VALUES ($1, ${FIRST_SIZE + 1}, 0, 'pending')`, [runId]);
      await pool.query(`DELETE FROM catalog.product_variants WHERE id = ${FIRST_SIZE + 1}`);
      expect((await targetsOf(runId))).toEqual([]);
    });

    it("maps every job item state to the same target outcome in SQL as in TypeScript", async () => {
      const cases = [
        ["queued", null], ["processing", null], ["completed", null], ["blocked", "DROPSHIP_LISTING_PREVIEW_BLOCKED"],
        ["blocked", "DROPSHIP_LISTING_NOT_SELECTED"], ["failed", "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR"],
        ["failed", "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW"], ["cancelled", "DROPSHIP_LISTING_PUSH_RUN_STOPPED"],
      ] as const;
      const result = await pool.query<{ status: string; error_code: string | null; outcome: string }>(
        `SELECT i.status, i.error_code, ${targetOutcomeFromItemSql("i")} AS outcome
         FROM unnest($1::text[], $2::text[]) AS i(status, error_code)`,
        [cases.map(([status]) => status), cases.map(([, code]) => code)]);
      expect(result.rows.map((row) => row.outcome)).toEqual(cases.map(([status, errorCode]) => runTargetOutcomeForItem({ status, errorCode })));
    });
  });

  describe("run creation", () => {
    it("snapshots 10,000 selected sizes into 20 chunks in one transaction, in id order", async () => {
      await seedSizes(10_000);
      const revision = await saveSelection("every size", "save-all-0001");
      const started = performance.now();
      const created = await createRun({ key: "run-10k-0001", expected: revision });
      const elapsedMs = Math.round(performance.now() - started);
      process.stdout.write(`[pg-record] 10,000-target run snapshot: ${elapsedMs} ms\n`);
      expect(created.idempotentReplay).toBe(false);
      expect(created.run).toMatchObject({ targetCount: 10_000, chunkSize: 500, chunkCount: 20, status: "processing",
        selectionRevisionId: revision, scope: "all", nextChunkIndex: 0 });
      const chunks = await pool.query<{ chunk_index: number; count: number; first: number; last: number }>(
        `SELECT chunk_index, count(*)::int AS count, min(product_variant_id) AS first, max(product_variant_id) AS last
         FROM dropship.dropship_listing_push_run_targets WHERE run_id = $1 GROUP BY chunk_index ORDER BY chunk_index`, [created.run.runId]);
      expect(chunks.rows).toHaveLength(20);
      chunks.rows.forEach((row, index) => {
        expect(row).toEqual({ chunk_index: index, count: 500, first: FIRST_SIZE + index * 500, last: FIRST_SIZE + index * 500 + 499 });
      });
      const audit = await pool.query(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_run_created'`);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].payload).toMatchObject({ runId: created.run.runId, targetCount: 10_000, chunkCount: 20, scope: "all",
        selectionRevisionId: revision });
      expect(audit.rows[0].payload.targetIds).toHaveLength(10_000);
    }, REPLAY_TIMEOUT_MS);

    it("refuses 10,001 selected sizes and writes nothing", async () => {
      await seedSizes(10_001);
      const revision = await saveSelection("every size", "save-all-0002");
      await expect(createRun({ key: "run-big-0001", expected: revision })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_TOO_LARGE" });
      expect((await pool.query("SELECT count(*)::int AS count FROM dropship.dropship_listing_push_runs")).rows[0].count).toBe(0);
    }, REPLAY_TIMEOUT_MS);

    it("replays the same key and request; two concurrent presses make one run", async () => {
      await seedSizes(30);
      const revision = await saveSelection("every size", "save-all-0003");
      const [first, second] = await Promise.all([
        createRun({ key: "run-same-0001", expected: revision }),
        createRun({ key: "run-same-0001", expected: revision }),
      ]);
      expect(first.run.runId).toBe(second.run.runId);
      expect([first.idempotentReplay, second.idempotentReplay].sort()).toEqual([false, true]);
      expect((await pool.query("SELECT count(*)::int AS count FROM dropship.dropship_listing_push_runs")).rows[0].count).toBe(1);
      await expect(createRun({ key: "run-same-0001", scope: "not_live", expected: revision }))
        .rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
      // A second press with a new key while the first runs names the run to show.
      await expect(createRun({ key: "run-other-001", expected: revision }))
        .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_ACTIVE", context: { runId: first.run.runId } });
    });

    it("waits for a selection save on the vendor lock, refuses a moved revision, and snapshots the saved selection", async () => {
      await seedSizes(20);
      const firstRevision = await saveSelection("every size", "save-all-0004");
      const saver = await wide.connect();
      let secondRevision = 0;
      try {
        await saver.query("BEGIN");
        await saver.query("SELECT pg_advisory_xact_lock(hashtext('dropship_vendor_selection_rules'), $1::integer)", [VENDOR]);
        const pending = createRun({ key: "run-race-0001", expected: firstRevision });
        // Polled, not a fixed sleep (review round 2 CT9): the create is waiting on the vendor lock within 5 s.
        let waitingCount = 0;
        for (let poll = 0; poll < 100 && waitingCount === 0; poll += 1) {
          const waiting = await wide.query(`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
          waitingCount = waiting.rows[0].count;
          if (waitingCount === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(waitingCount).toBe(1);
        // The save in progress: the picks narrow to two sizes, under the same lock, then commit.
        const revision = await saver.query<{ id: number }>(`INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions
          (vendor_id, idempotency_key, request_hash, actor_type, rule_count) VALUES ($1, 'save-two-0001', 'h', 'vendor', 0) RETURNING id`, [VENDOR]);
        secondRevision = revision.rows[0].id;
        await saver.query(`DELETE FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = $1
          AND product_variant_id NOT IN (${FIRST_SIZE}, ${FIRST_SIZE + 5})`, [VENDOR]);
        await saver.query("COMMIT");
        await expect(pending).rejects.toMatchObject({ code: "DROPSHIP_SELECTION_REVISION_CONFLICT",
          context: { expectedSelectionRevisionId: firstRevision, currentSelectionRevisionId: secondRevision } });
      } finally {
        saver.release();
      }
      expect((await pool.query("SELECT count(*)::int AS count FROM dropship.dropship_listing_push_runs")).rows[0].count).toBe(0);
      const created = await createRun({ key: "run-race-0002", expected: secondRevision });
      expect(created.run.selectionRevisionId).toBe(secondRevision);
      expect((await targetsOf(created.run.runId)).map((row) => row.product_variant_id)).toEqual([FIRST_SIZE, FIRST_SIZE + 5]);
    });

    it("answers busy, retryable, when a selection save holds the vendor lock past the timeout", async () => {
      await seedSizes(3);
      const revision = await saveSelection("every size", "save-all-0005");
      const saver = await wide.connect();
      try {
        await saver.query("BEGIN");
        await saver.query("SELECT pg_advisory_xact_lock(hashtext('dropship_vendor_selection_rules'), $1::integer)", [VENDOR]);
        await expect(createRun({ key: "run-busy-0001", expected: revision }))
          .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_BUSY", context: { retryable: true } });
      } finally {
        await saver.query("ROLLBACK");
        saver.release();
      }
      expect((await pool.query("SELECT count(*)::int AS count FROM dropship.dropship_listing_push_runs")).rows[0].count).toBe(0);
    }, 30_000);

    it("'not_live' leaves out only sizes live on this store; an empty result names the live count", async () => {
      await seedSizes(10);
      const revision = await saveSelection("every size", "save-all-0006");
      const listings: Array<[number, string, string | null]> = [
        [FIRST_SIZE, "active", "EBAY-1"], [FIRST_SIZE + 1, "paused", "EBAY-2"], [FIRST_SIZE + 2, "drift_detected", "EBAY-3"],
        [FIRST_SIZE + 3, "active", null], [FIRST_SIZE + 4, "queued", "EBAY-5"], [FIRST_SIZE + 5, "failed", "EBAY-6"],
        [FIRST_SIZE + 6, "blocked", "EBAY-7"], [FIRST_SIZE + 7, "ended", "EBAY-8"], [FIRST_SIZE + 8, "active", " "],
      ];
      for (const [id, status, external] of listings) {
        await pool.query(`INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id)
          VALUES ($1, $2, $3, 'ebay', $4, $5)`, [VENDOR, STORE, id, status, external]);
      }
      // The same size live on another vendor's store does not count.
      await pool.query(`INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id)
        VALUES ($1, $2, $3, 'ebay', 'active', 'EBAY-OTHER')`, [OTHER_VENDOR, OTHER_STORE, FIRST_SIZE + 9]);
      const created = await createRun({ key: "run-new-00001", scope: "not_live", expected: revision });
      expect((await targetsOf(created.run.runId)).map((row) => row.product_variant_id))
        .toEqual([FIRST_SIZE + 3, FIRST_SIZE + 4, FIRST_SIZE + 5, FIRST_SIZE + 6, FIRST_SIZE + 7, FIRST_SIZE + 8, FIRST_SIZE + 9]);
      await pool.query("UPDATE dropship.dropship_listing_push_runs SET status = 'cancelled', cancel_requested_at = now(), stop_reason = 'vendor_stop', completed_at = now()");
      await pool.query("UPDATE dropship.dropship_vendor_listings SET status = 'active', external_listing_id = 'EBAY-' || product_variant_id");
      await pool.query(`INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id)
        VALUES ($1, $2, $3, 'ebay', 'active', 'EBAY-X')`, [VENDOR, STORE, FIRST_SIZE + 9]);
      await expect(createRun({ key: "run-new-00002", scope: "not_live", expected: revision }))
        .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_EMPTY", context: { scope: "not_live", liveCount: 10 } });
    });
  });

  describe("expansion, the worker and reconcile", () => {
    it("publishes 3,000 sizes as six child jobs, one at a time, and finishes completed", async () => {
      await seedSizes(3_000);
      const revision = await saveSelection("every size", "save-all-0007");
      const created = await createRun({ key: "run-3000-0001", expected: revision });
      const { sweep } = services();
      const jobCounts: number[] = [];
      let firstExpansionMs = 0;
      for (let index = 0; index < 7; index += 1) {
        now = new Date(PRESS.getTime() + (index + 1) * 60_000);
        const started = performance.now();
        await sweep();
        if (index === 0) firstExpansionMs = Math.round(performance.now() - started);
        const jobs = await pool.query<{ count: number; active: number }>(`SELECT count(*)::int AS count,
          count(*) FILTER (WHERE status IN ('queued', 'processing'))::int AS active
          FROM dropship.dropship_listing_push_jobs WHERE run_id = $1`, [created.run.runId]);
        jobCounts.push(jobs.rows[0].count);
        expect(jobs.rows[0].active).toBe(0);
      }
      process.stdout.write(`[pg-record] one sweep that expands and pushes a 500-size chunk: ${firstExpansionMs} ms\n`);
      expect(jobCounts).toEqual([1, 2, 3, 4, 5, 6, 6]);
      expect(providerCalls).toHaveLength(3_000);
      expect(new Set(providerCalls).size).toBe(3_000);
      // Every size is in exactly one job item of the run.
      const perSize = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM (
        SELECT i.product_variant_id FROM dropship.dropship_listing_push_job_items i
        JOIN dropship.dropship_listing_push_jobs j ON j.id = i.job_id WHERE j.run_id = $1
        GROUP BY i.product_variant_id HAVING count(*) > 1) duplicated`, [created.run.runId]);
      expect(perSize.rows[0].count).toBe(0);
      expect(await outcomeCounts(created.run.runId)).toEqual({ completed: 3_000 });
      expect(await runRow(created.run.runId)).toMatchObject({ status: "completed", next_chunk_index: 6 });
      const jobKeys = await pool.query(`SELECT idempotency_key, run_chunk_index FROM dropship.dropship_listing_push_jobs
        WHERE run_id = $1 ORDER BY run_chunk_index`, [created.run.runId]);
      expect(jobKeys.rows.map((row) => row.idempotency_key)).toEqual(
        [0, 1, 2, 3, 4, 5].map((chunk) => `dropship-run:${VENDOR}:${created.run.runId}:${chunk}`));
      // A completed run sends no email, and its chunk jobs never send one of their own.
      expect(notices).toEqual([]);
    }, REPLAY_TIMEOUT_MS);

    it("adopts a chunk job a crash left unrecorded, by (run, chunk) and never by key", async () => {
      await seedSizes(5);
      const revision = await saveSelection("every size", "save-all-0008");
      const created = await createRun({ key: "run-crash-001", expected: revision });
      const { createChunkJob, sweepService } = services();
      const ids = [FIRST_SIZE, FIRST_SIZE + 1, FIRST_SIZE + 2, FIRST_SIZE + 3, FIRST_SIZE + 4];
      // A look-alike job under another vendor's key space and a job with the chunk key but no run are not adopted.
      await createChunkJob({ vendorId: VENDOR, storeConnectionId: STORE, productVariantIds: [FIRST_SIZE], reviewMode: "current_preview",
        idempotencyKey: "vendor-look-alike-key", requestedBy: { actorType: "vendor", actorId: MEMBER } });
      const crashed = await createChunkJob({ vendorId: VENDOR, storeConnectionId: STORE, productVariantIds: ids, reviewMode: "current_preview",
        idempotencyKey: `dropship-run:${VENDOR}:${created.run.runId}:0`, requestedBy: { actorType: "vendor", actorId: MEMBER },
        run: { runId: created.run.runId, chunkIndex: 0 } });
      expect(await outcomeCounts(created.run.runId)).toEqual({ pending: 5 });
      await sweepService.expandRuns();
      const targets = await targetsOf(created.run.runId);
      expect(targets.every((row) => row.outcome === "queued")).toBe(true);
      const itemJobs = await pool.query(`SELECT DISTINCT i.job_id FROM dropship.dropship_listing_push_run_targets t
        JOIN dropship.dropship_listing_push_job_items i ON i.id = t.job_item_id WHERE t.run_id = $1`, [created.run.runId]);
      expect(itemJobs.rows).toEqual([{ job_id: crashed.job.jobId }]);
      expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_RUN_CHUNK_QUEUED")?.context).toMatchObject({ how: "adopted" });
    });

    it("a second expansion of a chunk another sweep already queued adopts that job, failing nothing (review MC5, CT2)", async () => {
      await seedSizes(5);
      const revision = await saveSelection("every size", "save-all-0019");
      const created = await createRun({ key: "run-twice-001", expected: revision });
      const competitor = services();
      // Between this sweep's pre-filter and its queue, another sweep pre-filtered the chunk (the fifth size had become
      // live) and queued the chunk's job with the other four: the same key, another request hash.
      const { sweepService } = services({ beforeChunkJob: async () => {
        await pool.query(`UPDATE dropship.dropship_listing_push_run_targets SET outcome = 'skipped',
          code = 'DROPSHIP_LISTING_ALREADY_LIVE', retryable = false, decided_at = $3 WHERE run_id = $1 AND product_variant_id = $2`,
        [created.run.runId, FIRST_SIZE + 4, now]);
        await competitor.createChunkJob({ vendorId: VENDOR, storeConnectionId: STORE, productVariantIds: [FIRST_SIZE, FIRST_SIZE + 1,
          FIRST_SIZE + 2, FIRST_SIZE + 3], reviewMode: "current_preview", idempotencyKey: `dropship-run:${VENDOR}:${created.run.runId}:0`,
        requestedBy: { actorType: "vendor", actorId: MEMBER }, run: { runId: created.run.runId, chunkIndex: 0 } });
      } });
      await sweepService.expandRuns();
      // Not a key conflict: nothing failed, nothing for a human; the chunk's job is adopted at the next sweep.
      expect(await outcomeCounts(created.run.runId)).toEqual({ pending: 4, skipped: 1 });
      expect(logs.filter((event) => event.level === "error")).toEqual([]);
      // Never claimed before its chunk is recorded (review MC10).
      const jobs = await pool.query<{ id: number }>("SELECT id FROM dropship.dropship_listing_push_jobs WHERE run_id = $1", [created.run.runId]);
      expect(jobs.rows).toHaveLength(1);
      const queue = new PgDropshipListingPushJobQueueRepository(pool);
      expect(await queue.listClaimableJobIds({ limit: 10, now, staleAfterMinutes: 30 })).toEqual([]);
      await services().sweepService.expandRuns();
      expect(await outcomeCounts(created.run.runId)).toEqual({ queued: 4, skipped: 1 });
      expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_RUN_CHUNK_QUEUED")?.context).toMatchObject({ how: "adopted", notQueued: 0 });
      expect(await queue.listClaimableJobIds({ limit: 10, now, staleAfterMinutes: 30 })).toEqual([jobs.rows[0].id]);
    });

    it("refuses, for good, a chunk whose key another job already holds", async () => {
      await seedSizes(2);
      const revision = await saveSelection("every size", "save-all-0009");
      const created = await createRun({ key: "run-forge-001", expected: revision });
      const { createChunkJob, sweepService } = services();
      // A forged job with the chunk's key but no run (written before the vendor route refused the prefix).
      await createChunkJob({ vendorId: VENDOR, storeConnectionId: STORE, productVariantIds: [FIRST_SIZE], reviewMode: "current_preview",
        idempotencyKey: `dropship-run:${VENDOR}:${created.run.runId}:0`, requestedBy: { actorType: "vendor", actorId: MEMBER } });
      await sweepService.expandRuns();
      const targets = await targetsOf(created.run.runId);
      expect(targets.map((row) => [row.outcome, row.code, row.retryable])).toEqual([
        ["failed", "DROPSHIP_LISTING_PUSH_RUN_KEY_CONFLICT", false], ["failed", "DROPSHIP_LISTING_PUSH_RUN_KEY_CONFLICT", false],
      ]);
      expect(logs.find((event) => event.level === "error")?.code).toBe("DROPSHIP_LISTING_PUSH_RUN_KEY_CONFLICT");
    });

    it("counts the sizes a draft-first store saved unpublished, apart from those live (review DUX7)", async () => {
      await seedSizes(3);
      const revision = await saveSelection("every size", "save-all-0020");
      const created = await createRun({ key: "run-drafts-001", expected: revision });
      const { sweep, runService } = services();
      providerDrafts = true;
      await sweep();
      now = new Date(PRESS.getTime() + 60_000);
      await sweep();
      const detail = await runService.getRunForMember(MEMBER, { runId: created.run.runId });
      expect(detail.counts.completed).toBe(3);
      expect(detail.drafts).toBe(3);
    });

    it("reconciles from real items, finishes partial, and copies a later staff retry into the finished run", async () => {
      await seedSizes(4);
      const revision = await saveSelection("every size", "save-all-0010");
      const created = await createRun({ key: "run-retry-001", expected: revision });
      const { sweep } = services();
      providerError = (productVariantId) => productVariantId === FIRST_SIZE + 2
        ? new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "eBay listing push failed with HTTP 400.", { retryable: true, status: 400, method: "PUT" })
        : null;
      await sweep();
      now = new Date(PRESS.getTime() + 60_000);
      await sweep();
      expect(await outcomeCounts(created.run.runId)).toEqual({ completed: 3, failed: 1 });
      expect(await runRow(created.run.runId)).toMatchObject({ status: "partial" });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ idempotencyKey: `listing-push-run:${created.run.runId}:finished`, critical: true,
        title: "Some listings didn't publish", payload: { counts: { completed: 3, failed: 1 }, problems: [{ productVariantId: FIRST_SIZE + 2 }] } });

      // Card Shellz staff retry the failed chunk job; the item completes; the finished run's target follows.
      providerError = null;
      now = new Date(PRESS.getTime() + 3_600_000);
      const job = await pool.query<{ id: number }>("SELECT id FROM dropship.dropship_listing_push_jobs WHERE run_id = $1", [created.run.runId]);
      await new DropshipListingPushOpsService({ repository: new PgDropshipListingPushOpsRepository(pool), logger, clock })
        .retryJob({ jobId: job.rows[0].id, idempotencyKey: "staff-retry-0001", actor: { actorType: "admin", actorId: "staff-1" } });
      await sweep();
      now = new Date(PRESS.getTime() + 3_660_000);
      await sweep();
      expect(await outcomeCounts(created.run.runId)).toEqual({ completed: 4 });
      expect(await runRow(created.run.runId)).toMatchObject({ status: "partial" });
      const changed = await pool.query(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_run_target_changed'`);
      expect(changed.rows).toHaveLength(1);
      expect(changed.rows[0].payload.changes).toEqual([{ productVariantId: FIRST_SIZE + 2,
        before: { outcome: "failed", code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR" }, after: { outcome: "completed", code: null } }]);
      // Idempotent: another reconcile changes nothing and writes no audit row.
      await services().sweepService.reconcileAndFinish();
      expect((await pool.query(`SELECT count(*)::int AS count FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_run_target_changed'`)).rows[0].count).toBe(1);
    });

    it("logs one WARN at the finish counting sizes a passing stock link condition failed, which the run never re-queues (merge review ADV-RB2-1)", async () => {
      await seedSizes(6);
      const revision = await saveSelection("every size", "save-all-0011");
      const created = await createRun({ key: "run-stock-link-01", expected: revision });
      const { sweep, sweepService } = services();
      // The stock link's refusals as the gate and the admission raise them: no HTTP status, so no pause (PR A's pause
      // takes only eBay's own answers); a 400 from eBay; and two sizes that publish.
      const stockLink = (code: string) => new DropshipError(code, "Stock link refusal.", { retryable: true, source: "dropship_stock_link" });
      providerError = (productVariantId) => {
        switch (productVariantId - FIRST_SIZE) {
          case 0: case 1: return stockLink("DROPSHIP_STOCK_LINK_BUSY");
          case 2: return stockLink("DROPSHIP_STOCK_UPDATES_PAUSED");
          case 3: return new QuantityPublicationAdmissionError("PUBLICATION_SCOPE_BUSY", "Another exact-scope publisher is running.");
          case 4: return new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "eBay listing push failed with HTTP 400.", { retryable: false, status: 400, method: "PUT" });
          default: return null;
        }
      };
      await sweep();
      now = new Date(PRESS.getTime() + 60_000);
      await sweep();
      expect(await outcomeCounts(created.run.runId)).toEqual({ completed: 1, failed: 5 });
      expect(await runRow(created.run.runId)).toMatchObject({ status: "partial" });
      const failures = [
        { code: "DROPSHIP_STOCK_LINK_BUSY", count: 2 },
        { code: "DROPSHIP_STOCK_UPDATES_PAUSED", count: 1 },
        { code: "PUBLICATION_SCOPE_BUSY", count: 1 },
      ];
      const warned = () => logs.filter((event) => event.code === "DROPSHIP_LISTING_PUSH_RUN_STOCK_LINK_NOT_REQUEUED");
      expect(warned()).toEqual([expect.objectContaining({ level: "warn", context: {
        action: "finish_publish_run", outcome: "not_requeued", runId: created.run.runId, vendorId: VENDOR, storeConnectionId: STORE,
        status: "partial", failedSizes: 4, failures } })]);
      // The finish logged it once; another sweep finishes nothing and logs nothing.
      now = new Date(PRESS.getTime() + 120_000);
      await sweep();
      expect(warned()).toHaveLength(1);

      // A process that died after the finish committed leaves the notice step open: the recovered notice reads the
      // same counts from the run's targets and logs the line again, once.
      await pool.query("UPDATE dropship.dropship_listing_push_runs SET notified_at = NULL WHERE id = $1", [created.run.runId]);
      await sweepService.reconcileAndFinish();
      expect(warned()).toHaveLength(2);
      expect(warned()[1].context).toEqual(warned()[0].context);
      await sweepService.reconcileAndFinish();
      expect(warned()).toHaveLength(2);
    });

    it("refuses a staff retry of a job whose run the vendor stopped, requeueing nothing (review round 2 MC5)", async () => {
      await seedSizes(3);
      const revision = await saveSelection("every size", "save-all-0020");
      const created = await createRun({ key: "run-retry-stop", expected: revision });
      const { sweep, runService } = services();
      // The vendor stops while the first size is sent, and eBay refuses that send (retryable).
      providerHook = async (_id, call) => {
        if (call !== 1) return;
        await runService.stopRunForMember(MEMBER, created.run.runId);
        throw new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "eBay listing push failed with HTTP 400.", { retryable: true, status: 400, method: "PUT" });
      };
      await sweep();
      providerHook = null;
      const job = await pool.query<{ id: number; status: string }>("SELECT id, status FROM dropship.dropship_listing_push_jobs WHERE run_id = $1", [created.run.runId]);
      expect(job.rows[0].status).toBe("failed");
      now = new Date(PRESS.getTime() + 3_600_000);
      await expect(new DropshipListingPushOpsService({ repository: new PgDropshipListingPushOpsRepository(pool), logger, clock })
        .retryJob({ jobId: job.rows[0].id, idempotencyKey: "staff-retry-stop", actor: { actorType: "admin", actorId: "staff-1" } }))
        .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_OPS_RUN_STOPPED", context: { jobId: job.rows[0].id, runId: created.run.runId } });
      const items = await pool.query(`SELECT status FROM dropship.dropship_listing_push_job_items WHERE job_id = $1 ORDER BY id`, [job.rows[0].id]);
      expect(items.rows.map((row) => row.status)).toEqual(["failed", "cancelled", "cancelled"]);
      await sweep();
      expect(providerCalls).toEqual([FIRST_SIZE]);
      expect((await pool.query(`SELECT count(*)::int AS count FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_job_retry_requested'`)).rows[0].count).toBe(0);
    }, REPLAY_TIMEOUT_MS);

    it("pauses on a 429, writes the backoff, and the sweep skips the job until it is due", async () => {
      await seedSizes(3);
      const revision = await saveSelection("every size", "save-all-0011");
      const created = await createRun({ key: "run-pause-001", expected: revision });
      const { sweep, queueRepository } = services();
      providerError = (_id, call) => call === 2
        ? new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "eBay listing push failed with HTTP 429.", { retryable: true, status: 429, method: "PUT" })
        : null;
      await sweep();
      const job = await pool.query(`SELECT id, status, next_attempt_at, consecutive_pause_count FROM dropship.dropship_listing_push_jobs WHERE run_id = $1`, [created.run.runId]);
      expect(job.rows[0]).toMatchObject({ status: "queued", consecutive_pause_count: 1, next_attempt_at: new Date(PRESS.getTime() + 60_000) });
      const items = await pool.query(`SELECT status, result->'transientPauses' AS pauses FROM dropship.dropship_listing_push_job_items
        WHERE job_id = $1 ORDER BY id`, [job.rows[0].id]);
      expect(items.rows).toEqual([{ status: "completed", pauses: null }, { status: "queued", pauses: 1 }, { status: "queued", pauses: null }]);
      const paused = await pool.query(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_job_paused'`);
      expect(paused.rows[0].payload).toMatchObject({ runId: created.run.runId, code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
        reason: "rate_limited", consecutivePauseCount: 1 });
      // The page says when it goes on instead of looking frozen (review DUX5).
      const { runService } = services();
      expect((await runService.getRunForMember(MEMBER, { runId: created.run.runId })).waitingUntil)
        .toBe(new Date(PRESS.getTime() + 60_000).toISOString());
      expect(await queueRepository.listClaimableJobIds({ limit: 10, now: new Date(PRESS.getTime() + 59_000), staleAfterMinutes: 30 })).toEqual([]);
      expect(await queueRepository.listClaimableJobIds({ limit: 10, now: new Date(PRESS.getTime() + 60_000), staleAfterMinutes: 30 }))
        .toEqual([job.rows[0].id]);
      // Due: the job runs again, the paused item completes and the count resets.
      providerError = null;
      now = new Date(PRESS.getTime() + 61_000);
      await sweep();
      now = new Date(PRESS.getTime() + 62_000);
      await sweep();
      expect(await outcomeCounts(created.run.runId)).toEqual({ completed: 3 });
      expect((await pool.query(`SELECT consecutive_pause_count FROM dropship.dropship_listing_push_jobs WHERE id = $1`, [job.rows[0].id])).rows[0])
        .toEqual({ consecutive_pause_count: 0 });
      expect(await runService.getRunForMember(MEMBER, { runId: created.run.runId })).toMatchObject({ waitingUntil: null, drafts: 0 });
    });

    it("a size eBay refuses with a definite answer ends the job's run of pauses, in the same write (review round 2 MC4)", async () => {
      await seedSizes(2);
      const revision = await saveSelection("every size", "save-all-0019");
      const created = await createRun({ key: "run-pause-400", expected: revision });
      const { sweep } = services();
      const http = (status: number) => new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", `eBay listing push failed with HTTP ${status}.`,
        { retryable: status === 429, status, method: "PUT" });
      // The first size waits on a 429, then eBay refuses it with a 400 (it answered); the second size then waits on a 429.
      providerError = (_id, call) => (call === 1 || call === 3 ? http(429) : call === 2 ? http(400) : null);
      await sweep();
      const pauses = async () => (await pool.query(`SELECT consecutive_pause_count FROM dropship.dropship_listing_push_jobs WHERE run_id = $1`,
        [created.run.runId])).rows[0].consecutive_pause_count;
      expect(await pauses()).toBe(1);
      now = new Date(PRESS.getTime() + 61_000);
      await sweep();
      expect(providerCalls).toEqual([FIRST_SIZE, FIRST_SIZE, FIRST_SIZE + 1]);
      // Reset by the 400, then one pause: never 2, which would count toward the "eBay isn't answering" breaker.
      expect(await pauses()).toBe(1);
    }, REPLAY_TIMEOUT_MS);

    it("stops: pending sizes and queued items are cancelled, the item being sent finishes, and nothing else is sent", async () => {
      await seedSizes(1_200);
      const revision = await saveSelection("every size", "save-all-0012");
      const created = await createRun({ key: "run-stop-0001", expected: revision });
      const { sweep, runService } = services();
      let stoppedCounts: unknown = null;
      providerHook = async (_id, call) => {
        if (call !== 3) return;
        stoppedCounts = (await runService.stopRunForMember(MEMBER, created.run.runId)).counts;
      };
      await sweep();
      // The two sizes already sent count as published at the stop (verify V1: each target follows its item at once);
      // only the one being sent is still queued.
      expect(stoppedCounts).toMatchObject({ cancelled: 1_197, completed: 2, queued: 1 });
      expect(providerCalls).toHaveLength(3);
      // The run finishes right after its job, in the same sweep, not at the next one (verify V1).
      expect(await runRow(created.run.runId)).toMatchObject({ status: "cancelled", stop_reason: "vendor_stop" });
      now = new Date(PRESS.getTime() + 60_000);
      await sweep();
      now = new Date(PRESS.getTime() + 120_000);
      await sweep();
      expect(providerCalls).toHaveLength(3);
      expect(await outcomeCounts(created.run.runId)).toEqual({ cancelled: 1_197, completed: 3 });
      expect(await runRow(created.run.runId)).toMatchObject({ status: "cancelled", stop_reason: "vendor_stop" });
      expect((await pool.query(`SELECT count(*)::int AS count FROM dropship.dropship_listing_push_jobs WHERE run_id = $1`, [created.run.runId])).rows[0].count).toBe(1);
      // A second Stop answers the run as it is.
      const again = await runService.stopRunForMember(MEMBER, created.run.runId);
      expect(again.run.status).toBe("cancelled");
      // Another vendor's member cannot stop or read it.
      await expect(runService.stopRunForMember("member-11", created.run.runId)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_NOT_FOUND" });
    }, REPLAY_TIMEOUT_MS);

    it("an item eBay answers 429 for after a Stop is cancelled, never sent again (review MC4)", async () => {
      await seedSizes(5);
      const revision = await saveSelection("every size", "save-all-0017");
      const created = await createRun({ key: "run-stop-pause1", expected: revision });
      const { sweep, runService } = services();
      providerHook = async (_id, call) => {
        if (call !== 2) return;
        // The vendor stops while the second size is being sent, and eBay answers that send with 429 (nothing was done).
        await runService.stopRunForMember(MEMBER, created.run.runId);
        throw new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "eBay listing push failed with HTTP 429.",
          { retryable: true, status: 429, method: "PUT" });
      };
      await sweep();
      expect(providerCalls).toEqual([FIRST_SIZE, FIRST_SIZE + 1]);
      // Past every backoff the pause would have asked for: nothing more is sent.
      for (const minutes of [2, 5, 40]) {
        now = new Date(PRESS.getTime() + minutes * 60_000);
        await sweep();
      }
      expect(providerCalls).toEqual([FIRST_SIZE, FIRST_SIZE + 1]);
      const item = await pool.query(`SELECT i.status, i.error_code FROM dropship.dropship_listing_push_job_items i
        JOIN dropship.dropship_listing_push_jobs j ON j.id = i.job_id WHERE j.run_id = $1 AND i.product_variant_id = $2`,
      [created.run.runId, FIRST_SIZE + 1]);
      expect(item.rows).toEqual([{ status: "cancelled", error_code: "DROPSHIP_LISTING_PUSH_RUN_STOPPED" }]);
      expect(await outcomeCounts(created.run.runId)).toEqual({ completed: 1, cancelled: 4 });
      // Nothing reached eBay for the stopped sizes: their listings are back as they were before the queue, never left
      // reading as a push in flight (verify V7).
      const listings = await pool.query(`SELECT product_variant_id, status FROM dropship.dropship_vendor_listings
        WHERE store_connection_id = $1 ORDER BY product_variant_id`, [STORE]);
      expect(listings.rows).toEqual([{ product_variant_id: FIRST_SIZE, status: "active" },
        ...[1, 2, 3, 4].map((offset) => ({ product_variant_id: FIRST_SIZE + offset, status: "not_listed" }))]);
      expect(await runRow(created.run.runId)).toMatchObject({ status: "cancelled", stop_reason: "vendor_stop" });
      expect((await pool.query(`SELECT count(*)::int AS count FROM dropship.dropship_audit_events
        WHERE event_type = 'listing_push_job_item_cancelled_after_stop'`)).rows[0].count).toBe(1);
    }, REPLAY_TIMEOUT_MS);

    it("an item a dead worker left processing when the vendor stopped is sent once more on recovery, so eBay's outcome is known; nothing else starts (review MC1)", async () => {
      await seedSizes(3);
      const revision = await saveSelection("every size", "save-all-0018");
      const created = await createRun({ key: "run-stop-stale1", expected: revision });
      const { sweep, sweepService, runService } = services();
      await sweepService.expandRuns();
      // A worker claimed the job and was sending the first size when it died: eBay may already hold the listing.
      await pool.query(`UPDATE dropship.dropship_listing_push_jobs SET status = 'processing', updated_at = $2 WHERE run_id = $1`,
        [created.run.runId, PRESS]);
      await pool.query(`UPDATE dropship.dropship_listing_push_job_items i SET status = 'processing' FROM dropship.dropship_listing_push_jobs j
        WHERE j.id = i.job_id AND j.run_id = $1 AND i.product_variant_id = $2`, [created.run.runId, FIRST_SIZE]);
      const stopped = await runService.stopRunForMember(MEMBER, created.run.runId);
      expect(stopped.counts).toMatchObject({ queued: 1, cancelled: 2 });
      // 31 minutes on, the sweep takes the job for stale and puts the size back in the queue. It was the size in
      // flight at the stop, so it is sent again once (the connector adopts or flags what eBay holds); its first try
      // answers 429, which did nothing, so it waits instead of being cancelled.
      providerError = (_id, call) => (call === 1
        ? new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "eBay listing push failed with HTTP 429.", { retryable: true, status: 429, method: "GET" })
        : null);
      now = new Date(PRESS.getTime() + 31 * 60_000);
      await sweep();
      expect(providerCalls).toEqual([FIRST_SIZE]);
      now = new Date(PRESS.getTime() + 33 * 60_000);
      await sweep();
      now = new Date(PRESS.getTime() + 34 * 60_000);
      await sweep();
      expect(providerCalls).toEqual([FIRST_SIZE, FIRST_SIZE]);
      expect(await outcomeCounts(created.run.runId)).toEqual({ completed: 1, cancelled: 2 });
      expect(await runRow(created.run.runId)).toMatchObject({ status: "cancelled", stop_reason: "vendor_stop" });
      const finishing = await pool.query(`SELECT payload FROM dropship.dropship_audit_events
        WHERE event_type = 'listing_push_job_item_finishing_after_stop' ORDER BY id`);
      expect(finishing.rows.map((row) => row.payload.at)).toEqual(["start", "pause", "start"]);
    }, REPLAY_TIMEOUT_MS);

    it("a stop that lands between the chunk's queue and its record cancels the new job's items before any is sent", async () => {
      await seedSizes(4);
      const revision = await saveSelection("every size", "save-all-0016");
      const created = await createRun({ key: "run-race-stop1", expected: revision });
      const { runService } = services();
      const { sweep } = services({ afterChunkJob: async () => { await runService.stopRunForMember(MEMBER, created.run.runId); } });
      await sweep();
      expect(providerCalls).toEqual([]);
      const items = await pool.query(`SELECT i.status, i.error_code FROM dropship.dropship_listing_push_job_items i
        JOIN dropship.dropship_listing_push_jobs j ON j.id = i.job_id WHERE j.run_id = $1`, [created.run.runId]);
      expect(items.rows).toEqual(Array(4).fill({ status: "cancelled", error_code: "DROPSHIP_LISTING_PUSH_RUN_STOPPED" }));
      expect(await outcomeCounts(created.run.runId)).toEqual({ cancelled: 4 });
      expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_RUN_CHUNK_CANCELLED")).toBeDefined();
      now = new Date(PRESS.getTime() + 60_000);
      await sweep();
      expect(await runRow(created.run.runId)).toMatchObject({ status: "cancelled", stop_reason: "vendor_stop" });
    });

    it("trips the job breaker after six pauses: queued items fail retryable and the run stops for eBay", async () => {
      await seedSizes(600);
      const revision = await saveSelection("every size", "save-all-0013");
      const created = await createRun({ key: "run-down-0001", expected: revision });
      const { sweep } = services();
      providerError = () => new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_NETWORK_ERROR", "eBay did not answer.",
        { retryable: true, network: true, method: "GET" });
      let minutes = 0;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await sweep();
        minutes += 31;
        now = new Date(PRESS.getTime() + minutes * 60_000);
      }
      // Item 1 pauses five times and then fails as before; item 2 pauses (the job's sixth in a row); its next
      // pausable error trips the job breaker. Eight calls in about 83 minutes of backoff.
      expect(providerCalls).toEqual([...Array(6).fill(FIRST_SIZE), FIRST_SIZE + 1, FIRST_SIZE + 1]);
      expect(await runRow(created.run.runId)).toMatchObject({ status: "failed", stop_reason: "provider_unavailable" });
      expect(await outcomeCounts(created.run.runId)).toEqual({ failed: 600 });
      const codes = await pool.query(`SELECT code, retryable, count(*)::int AS count FROM dropship.dropship_listing_push_run_targets
        WHERE run_id = $1 GROUP BY code, retryable ORDER BY code`, [created.run.runId]);
      expect(codes.rows).toEqual([
        { code: "DROPSHIP_EBAY_LISTING_PUSH_NETWORK_ERROR", retryable: true, count: 1 },
        { code: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE", retryable: true, count: 599 },
      ]);
      const job = await pool.query(`SELECT status, consecutive_pause_count FROM dropship.dropship_listing_push_jobs WHERE run_id = $1`, [created.run.runId]);
      expect(job.rows).toEqual([{ status: "failed", consecutive_pause_count: 0 }]);
      // The trip's own decisions on the run's sizes not yet in a job are in its audit row, before -> after (review MC8).
      const tripped = await pool.query(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_job_breaker_tripped'`);
      expect(tripped.rows).toHaveLength(1);
      expect(tripped.rows[0].payload.failedTargets).toEqual({ before: "pending", after: "failed",
        productVariantIds: Array.from({ length: 100 }, (_, index) => FIRST_SIZE + 500 + index) });
      expect(notices).toHaveLength(1);
      expect(notices[0].message).toContain("eBay wasn't answering");
    }, REPLAY_TIMEOUT_MS);
  });

  describe("the price review pre-filter", () => {
    it("holds live rule-priced sizes whose cost took effect after the press under 'wait for review'", async () => {
      await seedSizes(7);
      const revision = await saveSelection("every size", "save-all-0014");
      for (let index = 0; index < 6; index += 1) {
        await pool.query(`INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id)
          VALUES ($1, $2, $3, 'ebay', 'active', $4)`, [VENDOR, STORE, FIRST_SIZE + index, `EBAY-${index}`]);
      }
      const created = await createRun({ key: "run-price-001", expected: revision });
      const minutes = (value: number) => new Date(PRESS.getTime() + value * 60_000);
      // Recorded when observed (an entry takes effect at or after its reading, 0711); an announced one before the press.
      const entry = (id: number, effectiveAt: Date, withdrawnAt: Date | null, createdAt: Date = effectiveAt) => pool.query(
        `INSERT INTO dropship.dropship_cost_schedule_entries
        (vendor_id, product_variant_id, kind, unit_cost_cents, effective_at, withdrawn_at, created_at) VALUES ($1, $2, 'increase', 500, $3, $4, $5)`,
        [VENDOR, id, effectiveAt, withdrawnAt, createdAt]);
      await entry(FIRST_SIZE, minutes(10), null); // took effect after the press: held
      await entry(FIRST_SIZE + 1, minutes(-10), null); // before the press: sent
      await entry(FIRST_SIZE + 2, minutes(10), minutes(20)); // withdrawn: sent
      await entry(FIRST_SIZE + 3, minutes(120), null, minutes(-30)); // announced, not yet in effect: sent
      await pool.query(`INSERT INTO dropship.dropship_listing_price_revisions (vendor_id, store_connection_id, product_variant_id, created_at)
        VALUES ($1, $2, $3, $4)`, [VENDOR, STORE, FIRST_SIZE + 4, minutes(5)]); // a vendor price save after the press: checked
      await entry(FIRST_SIZE + 6, minutes(10), null); // not live: sent
      rulePricedIds = new Set([FIRST_SIZE, FIRST_SIZE + 1, FIRST_SIZE + 2, FIRST_SIZE + 3, FIRST_SIZE + 6]); // FIRST+4 has a fixed price
      policy = "wait_for_review";
      now = minutes(60);
      await services().sweepService.expandRuns();
      expect(priceCheckCalls).toEqual([[FIRST_SIZE, FIRST_SIZE + 4]]);
      const targets = await targetsOf(created.run.runId);
      expect(targets.map((row) => [row.product_variant_id, row.outcome, row.code])).toEqual([
        [FIRST_SIZE, "price_review", "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW"],
        [FIRST_SIZE + 1, "queued", null], [FIRST_SIZE + 2, "queued", null], [FIRST_SIZE + 3, "queued", null],
        [FIRST_SIZE + 4, "queued", null], [FIRST_SIZE + 5, "queued", null], [FIRST_SIZE + 6, "queued", null],
      ]);
      const audit = await pool.query(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_run_chunk_prefiltered'`);
      expect(audit.rows[0].payload).toMatchObject({ chunkIndex: 0, priceReview: [FIRST_SIZE], notSelected: [], alreadyLive: [] });
    });

    it("holds sizes whose price recipe or late-recorded cost moved after the press, and listed re-sent sizes too (review MC2, MC3, MC6)", async () => {
      await seedSizes(7);
      // One product per size here, so a product's recipe moves one size only.
      await pool.query("INSERT INTO catalog.products (id, sku, name) SELECT p, 'P' || p, 'Product ' || p FROM generate_series(2, 7) AS p");
      await pool.query(`UPDATE catalog.product_variants SET product_id = id - ${FIRST_SIZE} + 1`);
      const revision = await saveSelection("every size", "save-all-0016");
      const minutes = (value: number) => new Date(PRESS.getTime() + value * 60_000);
      const listed = [
        [FIRST_SIZE, "active"], [FIRST_SIZE + 1, "active"], [FIRST_SIZE + 2, "active"], [FIRST_SIZE + 3, "active"],
        [FIRST_SIZE + 4, "failed"], [FIRST_SIZE + 5, "queued"], [FIRST_SIZE + 6, "failed"],
      ] as const;
      for (const [id, status] of listed) {
        await pool.query(`INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id)
          VALUES ($1, $2, $3, 'ebay', $4, $5)`, [VENDOR, STORE, id, status, id === FIRST_SIZE + 6 ? null : `EBAY-${id}`]);
      }
      const productOf = async (id: number) => (await pool.query<{ product_id: number }>(
        "SELECT product_id FROM catalog.product_variants WHERE id = $1", [id])).rows[0].product_id;
      await pool.query("UPDATE catalog.products SET category_id = 77 WHERE id = $1", [await productOf(FIRST_SIZE + 1)]);
      const created = await createRun({ key: "run-price-003", expected: revision });
      const recipe = (table: string, owner: string, ownerId: number, markupBps: number, previous: number | null, createdAt: Date, text = "") =>
        pool.query<{ id: number }>(`INSERT INTO dropship.${table} (vendor_id, store_connection_id, ${owner}, previous_revision_id,
          price_basis, price_markup_bps, price_flat_cents, price_rounding, text_above, created_at)
          VALUES ($1, $2, $3, $4, 'product_cost', $5, 0, 'cent', $6, $7) RETURNING id`,
        [VENDOR, STORE, ownerId, previous, markupBps, text, createdAt]);
      // FIRST: a product markup saved before the press, then raised after it: held.
      const before = await recipe("dropship_product_listing_setting_revisions", "product_id", await productOf(FIRST_SIZE), 3000, null, minutes(-60));
      await recipe("dropship_product_listing_setting_revisions", "product_id", await productOf(FIRST_SIZE), 4000, before.rows[0].id, minutes(5));
      // FIRST+1: its category's markup raised after the press: held.
      await recipe("dropship_category_listing_setting_revisions", "category_id", 77, 2500, null, minutes(7));
      // FIRST+2: a product revision after the press that changed only its text, not the price: sent.
      const textOnly = await recipe("dropship_product_listing_setting_revisions", "product_id", await productOf(FIRST_SIZE + 2), 3000, null, minutes(-60));
      await recipe("dropship_product_listing_setting_revisions", "product_id", await productOf(FIRST_SIZE + 2), 3000, textOnly.rows[0].id, minutes(5), "New text");
      // FIRST+3: a cost reading observed before the press but recorded after it, now in force: held (MC6).
      await pool.query(`INSERT INTO dropship.dropship_cost_schedule_entries
        (vendor_id, product_variant_id, kind, unit_cost_cents, effective_at, withdrawn_at, created_at) VALUES ($1, $2, 'increase', 500, $3, NULL, $4)`,
      [VENDOR, FIRST_SIZE + 3, minutes(-2), minutes(3)]);
      // FIRST+4 (failed, with its eBay id) and FIRST+5 (queued, with its id): eBay still lists them; a cost after the press: held (MC3).
      // FIRST+6 (failed, never listed): nothing on eBay to protect, sent at today's price.
      for (const id of [FIRST_SIZE + 4, FIRST_SIZE + 5, FIRST_SIZE + 6]) {
        await pool.query(`INSERT INTO dropship.dropship_cost_schedule_entries
          (vendor_id, product_variant_id, kind, unit_cost_cents, effective_at, withdrawn_at, created_at) VALUES ($1, $2, 'increase', 500, $3, NULL, $3)`,
        [VENDOR, id, minutes(10)]);
      }
      rulePricedIds = new Set(listed.map(([id]) => id));
      policy = "wait_for_review";
      now = minutes(60);
      await services().sweepService.expandRuns();
      expect(priceCheckCalls).toEqual([[FIRST_SIZE, FIRST_SIZE + 1, FIRST_SIZE + 3, FIRST_SIZE + 4, FIRST_SIZE + 5]]);
      expect((await targetsOf(created.run.runId)).map((row) => [row.product_variant_id, row.outcome])).toEqual([
        [FIRST_SIZE, "price_review"], [FIRST_SIZE + 1, "price_review"], [FIRST_SIZE + 2, "queued"], [FIRST_SIZE + 3, "price_review"],
        [FIRST_SIZE + 4, "price_review"], [FIRST_SIZE + 5, "price_review"], [FIRST_SIZE + 6, "queued"],
      ]);
    });

    it("sends everything when the policy reprices by itself, and leaves out a size no longer selected", async () => {
      await seedSizes(3);
      const revision = await saveSelection("every size", "save-all-0015");
      await pool.query(`INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id)
        VALUES ($1, $2, $3, 'ebay', 'active', 'EBAY-0')`, [VENDOR, STORE, FIRST_SIZE]);
      const created = await createRun({ key: "run-price-002", expected: revision });
      await pool.query(`INSERT INTO dropship.dropship_pricing_profile_revisions (vendor_id, store_connection_id, created_at) VALUES ($1, $2, $3)`,
        [VENDOR, STORE, new Date(PRESS.getTime() + 60_000)]);
      // The vendor removes size 3 after the press (at main a variant exclude rule).
      await removePicks(pool, VENDOR, [FIRST_SIZE + 2]);
      rulePricedIds = new Set([FIRST_SIZE]);
      now = new Date(PRESS.getTime() + 120_000);
      await services().sweepService.expandRuns();
      expect(priceCheckCalls).toEqual([]);
      expect((await targetsOf(created.run.runId)).map((row) => [row.outcome, row.code])).toEqual([
        ["queued", null], ["queued", null], ["skipped", "DROPSHIP_LISTING_NOT_SELECTED"],
      ]);
    });
  });

  describe("verify round (V1-V10)", () => {
    const http = (status: number, method = "PUT") => new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      `eBay listing push failed with HTTP ${status}.`, { retryable: status === 429, status, method });

    it("counts each size as it is decided while its chunk's job runs, and finishes the run right after the job (verify V1)", async () => {
      await seedSizes(6);
      const revision = await saveSelection("every size", "save-all-v1-001");
      const created = await createRun({ key: "run-progress-v1", expected: revision });
      const { sweep, runService, sweepService } = services();
      const seen: string[] = [];
      providerError = (productVariantId) => (productVariantId === FIRST_SIZE + 3 ? http(400) : null);
      providerHook = async () => {
        const detail = await runService.getRunForMember(MEMBER, { runId: created.run.runId });
        seen.push(`${detail.counts.completed}/${detail.counts.failed}/${detail.counts.queued}`);
      };
      await sweep();
      // Read from inside the job, before each size eBay accepted: the counts moved with every size (the fourth failed).
      expect(seen).toEqual(["0/0/6", "1/0/5", "2/0/4", "3/1/2", "4/1/1"]);
      expect(await outcomeCounts(created.run.runId)).toEqual({ completed: 5, failed: 1 });
      // Finished in the same sweep, with its one email.
      expect(await runRow(created.run.runId)).toMatchObject({ status: "partial" });
      expect(notices).toHaveLength(1);
      // The reconcile finds nothing the worker did not already write.
      expect(await sweepService.reconcileAndFinish()).toEqual({ changed: 0, finished: 0 });
    }, REPLAY_TIMEOUT_MS);

    it("a size stale recovery queued again before a Stop, and that then paused, is sent once more after the Stop, never cancelled blind (verify V2)", async () => {
      await seedSizes(3);
      const revision = await saveSelection("every size", "save-all-v2-001");
      const created = await createRun({ key: "run-recovered-v2", expected: revision });
      const { sweep, sweepService, runService } = services();
      await sweepService.expandRuns();
      const job = (await pool.query<{ id: number }>("SELECT id FROM dropship.dropship_listing_push_jobs WHERE run_id = $1", [created.run.runId])).rows[0];
      // A worker started the first size 31 minutes ago and died mid-push: eBay may already hold the listing.
      const died = new Date(PRESS.getTime() - 31 * 60_000);
      await pool.query(`UPDATE dropship.dropship_listing_push_job_items SET status = 'processing', updated_at = $2
        WHERE job_id = $1 AND product_variant_id = $3`, [job.id, died, FIRST_SIZE]);
      await pool.query("UPDATE dropship.dropship_listing_push_jobs SET status = 'processing', updated_at = $2 WHERE id = $1", [job.id, died]);
      // The sweep recovers it and sends it again; eBay's first read answers 429, so it pauses for a minute.
      providerError = (_id, call) => (call === 1 ? http(429, "GET") : null);
      await sweep();
      const paused = await pool.query(`SELECT status, result->'staleRecovery'->>'recoveredAt' AS recovered_at
        FROM dropship.dropship_listing_push_job_items WHERE job_id = $1 AND product_variant_id = $2`, [job.id, FIRST_SIZE]);
      expect(paused.rows).toEqual([{ status: "queued", recovered_at: PRESS.toISOString() }]);
      // Ten seconds later, during the backoff, the vendor stops: the recovered size is kept to finish, the rest cancelled.
      now = new Date(PRESS.getTime() + 10_000);
      const stopped = await runService.stopRunForMember(MEMBER, created.run.runId);
      expect(stopped.counts).toMatchObject({ queued: 1, cancelled: 2 });
      const stopAudit = await pool.query(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_run_stop_requested'`);
      expect(stopAudit.rows[0].payload.keptInFlightItems).toHaveLength(1);
      expect(stopAudit.rows[0].payload.cancelledQueuedItems).toHaveLength(2);
      // After the backoff it is sent once more, so the connector adopts or flags what eBay holds; nothing else is sent.
      providerError = null;
      now = new Date(PRESS.getTime() + 3 * 60_000);
      await sweep();
      expect(providerCalls).toEqual([FIRST_SIZE, FIRST_SIZE]);
      expect(await outcomeCounts(created.run.runId)).toEqual({ completed: 1, cancelled: 2 });
      expect(await runRow(created.run.runId)).toMatchObject({ status: "cancelled", stop_reason: "vendor_stop" });
    }, REPLAY_TIMEOUT_MS);

    it("records a fully decided pre-filter and a concurrent Stop one after the other, never deadlocking (verify V3)", async () => {
      await seedSizes(3);
      const revision = await saveSelection("every size", "save-all-v3-001");
      const created = await createRun({ key: "run-deadlock-v3", expected: revision });
      const runId = created.run.runId;
      const stopClient = await wide.connect();
      let stopPromise: Promise<{ ok?: unknown; error?: { code?: string } }> | null = null;
      // The sweep's transaction pauses just before its audit insert until a real concurrent Stop waits on a lock.
      const hookedPool = {
        query: pool.query.bind(pool),
        connect: async () => {
          const client = await wide.connect();
          const original = client.query.bind(client) as (text: string, params?: unknown[]) => Promise<unknown>;
          (client as unknown as { query: unknown }).query = async (text: string, params?: unknown[]) => {
            if (typeof text === "string" && text.includes("INSERT INTO dropship.dropship_audit_events")
              && params?.[3] === "listing_push_run_chunk_prefiltered" && stopPromise === null) {
              const stopPid = (await stopClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
              const stopPool = { query: stopClient.query.bind(stopClient), connect: async () => ({ query: stopClient.query.bind(stopClient), release: () => undefined }) };
              stopPromise = new PgDropshipListingPushRunRepository(stopPool as unknown as Pool)
                .stopRun({ vendorId: VENDOR, runId, actor: { actorType: "vendor", actorId: MEMBER }, now: clock.now() })
                .then((value) => ({ ok: value }), (error: { code?: string }) => ({ error }));
              for (let attempt = 0; attempt < 250; attempt += 1) {
                const waiting = await pool.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted", [stopPid]);
                if (waiting.rows.length > 0) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
            }
            return original(text, params);
          };
          return client;
        },
      };
      try {
        const run = (await new PgDropshipListingPushRunRepository(pool).getRun({ vendorId: VENDOR, runId, problemsAfter: 0, problemsLimit: 50, now }))!.run;
        // The whole chunk is left out (every size deselected), so the record also moves the run's chunk pointer.
        const prefilter = await new PgDropshipListingPushRunSweepRepository(hookedPool as unknown as Pool).recordPrefilter({
          run, chunkIndex: 0, now,
          outcomes: [0, 1, 2].map((offset) => ({ productVariantId: FIRST_SIZE + offset, outcome: "skipped" as const, code: "DROPSHIP_LISTING_NOT_SELECTED" })),
        }).then((value) => ({ ok: value }), (error: { code?: string }) => ({ error }));
        const stop = await stopPromise;
        expect(prefilter).toEqual({ ok: { applied: 3 } });
        expect(stop).toMatchObject({ ok: { changed: true } });
        // The pre-filter came first (it held the run): the sizes are skipped, and the stop had nothing left to cancel.
        expect(await outcomeCounts(runId)).toEqual({ skipped: 3 });
      } finally {
        stopClient.release();
      }
    }, REPLAY_TIMEOUT_MS);

    it("a paused job waits for its backoff when processed directly too (the stock catch-up path), sending nothing early (verify V4)", async () => {
      await seedSizes(1);
      const { createChunkJob, worker } = services();
      const created = await createChunkJob({ vendorId: VENDOR, storeConnectionId: STORE, productVariantIds: [FIRST_SIZE],
        reviewMode: "current_preview", idempotencyKey: "catchup-like-job-v4", requestedBy: { actorType: "system", actorId: "catchup" } });
      providerError = () => http(429);
      await worker.processJob({ jobId: created.job.jobId, workerId: "catchup", idempotencyKey: "catchup-like-job-v4:process" });
      const jobOf = async () => (await pool.query(`SELECT status, next_attempt_at, consecutive_pause_count FROM dropship.dropship_listing_push_jobs
        WHERE id = $1`, [created.job.jobId])).rows[0];
      expect(await jobOf()).toMatchObject({ status: "queued", consecutive_pause_count: 1, next_attempt_at: new Date(PRESS.getTime() + 60_000) });
      // A second direct call a second later is not claimed: nothing sent, the pause count unchanged.
      now = new Date(PRESS.getTime() + 1_000);
      const early = await worker.processJob({ jobId: created.job.jobId, workerId: "catchup", idempotencyKey: "catchup-like-job-v4:process" });
      expect(early.job.status).toBe("queued");
      expect(providerCalls).toEqual([FIRST_SIZE]);
      expect(await jobOf()).toMatchObject({ status: "queued", consecutive_pause_count: 1 });
      expect((await pool.query(`SELECT count(*)::int AS count FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_job_claimed'`)).rows[0].count).toBe(1);
      // Once due it is claimed and sent.
      providerError = null;
      now = new Date(PRESS.getTime() + 60_000);
      await worker.processJob({ jobId: created.job.jobId, workerId: "catchup", idempotencyKey: "catchup-like-job-v4:process" });
      expect(providerCalls).toEqual([FIRST_SIZE, FIRST_SIZE]);
      expect(await jobOf()).toMatchObject({ status: "completed", consecutive_pause_count: 0 });
    }, REPLAY_TIMEOUT_MS);

    it("one product whose stock cannot be read fails only its own sizes; the rest of the chunk is published (verify V6)", async () => {
      await seedSizes(12);
      const revision = await saveSelection("every size", "save-all-v6-001");
      const created = await createRun({ key: "run-product-v6", expected: revision });
      let attempts = 0;
      // Product 2 (sizes 1011 and 1012) cannot have its channel quantity read: the preview refuses the whole chunk.
      const { sweep } = services({ beforeChunkJob: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new DropshipError("DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE",
            "The canonical Dropship channel quantity could not be resolved for product 2: no rows", { productId: 2, retryable: false });
        }
      } });
      await sweep();
      expect((await targetsOf(created.run.runId)).filter((row) => row.outcome !== "pending").map((row) => [row.product_variant_id, row.outcome, row.code]))
        .toEqual([[FIRST_SIZE + 10, "failed", "DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE"], [FIRST_SIZE + 11, "failed", "DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE"]]);
      const audit = await pool.query(`SELECT severity, payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_run_chunk_product_failed'`);
      expect(audit.rows).toEqual([{ severity: "warning", payload: expect.objectContaining({ productId: 2, chunkIndex: 0,
        failedTargets: { before: "pending", after: "failed", productVariantIds: [FIRST_SIZE + 10, FIRST_SIZE + 11] } }) }]);
      now = new Date(PRESS.getTime() + 60_000);
      await sweep();
      expect(await outcomeCounts(created.run.runId)).toEqual({ completed: 10, failed: 2 });
      expect(new Set(providerCalls).size).toBe(10);
      expect(await runRow(created.run.runId)).toMatchObject({ status: "partial" });
    }, REPLAY_TIMEOUT_MS);

    it("a Stop puts each cancelled size's listing back to its status before the queue, unless another push of it is queued (verify V7)", async () => {
      await seedSizes(3);
      await pool.query(`INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id)
        VALUES ($1, $2, $3, 'ebay', 'active', 'EBAY-0'), ($1, $2, $4, 'ebay', 'failed', NULL)`, [VENDOR, STORE, FIRST_SIZE, FIRST_SIZE + 1]);
      const revision = await saveSelection("every size", "save-all-v7-001");
      const created = await createRun({ key: "run-restore-v7", expected: revision });
      const { sweepService, runService, createChunkJob } = services();
      await sweepService.expandRuns();
      const statuses = async () => (await pool.query(`SELECT product_variant_id, status FROM dropship.dropship_vendor_listings
        WHERE store_connection_id = $1 ORDER BY product_variant_id`, [STORE])).rows.map((row) => row.status);
      // PR 1b's live-status rule: the queue keeps the status of a listing eBay lists (the guarded upsert), so only the
      // two sizes that are not live read queued.
      expect(await statuses()).toEqual(["active", "queued", "queued"]);
      const items = await pool.query(`SELECT i.result->>'listingStatusBeforeQueue' AS before FROM dropship.dropship_listing_push_job_items i
        JOIN dropship.dropship_listing_push_jobs j ON j.id = i.job_id WHERE j.run_id = $1 ORDER BY i.product_variant_id`, [created.run.runId]);
      expect(items.rows.map((row) => row.before)).toEqual(["active", "failed", "not_listed"]);
      // A release before PR 1b still wrote queued over a live listing (during a deploy, its process may queue it): the
      // Stop puts that listing back too.
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET status = 'queued' WHERE store_connection_id = $1 AND product_variant_id = $2`,
        [STORE, FIRST_SIZE]);
      // Another push of the third size is queued on its own (outside the run).
      await createChunkJob({ vendorId: VENDOR, storeConnectionId: STORE, productVariantIds: [FIRST_SIZE + 2], reviewMode: "current_preview",
        idempotencyKey: "vendor-job-v7-001", requestedBy: { actorType: "vendor", actorId: MEMBER } });
      await runService.stopRunForMember(MEMBER, created.run.runId);
      expect(await statuses()).toEqual(["active", "failed", "queued"]);
      const events = await pool.query(`SELECT l.product_variant_id, e.payload FROM dropship.dropship_listing_sync_events e
        JOIN dropship.dropship_vendor_listings l ON l.id = e.listing_id WHERE e.event_type = 'listing_push_cancelled' ORDER BY l.product_variant_id`);
      expect(events.rows.map((row) => [row.product_variant_id, row.payload.before, row.payload.after]))
        .toEqual([[FIRST_SIZE, "queued", "active"], [FIRST_SIZE + 1, "queued", "failed"]]);
      const stopAudit = await pool.query(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_run_stop_requested'`);
      expect(stopAudit.rows[0].payload.restoredListings).toHaveLength(2);
    }, REPLAY_TIMEOUT_MS);

    it("a run finished by a process that died before its email gets the email at a later sweep, under the same key, once (verify V9)", async () => {
      await seedSizes(2);
      const revision = await saveSelection("every size", "save-all-v9-001");
      const created = await createRun({ key: "run-notice-v9", expected: revision });
      const { sweep, sweepService } = services();
      providerError = (productVariantId) => (productVariantId === FIRST_SIZE ? http(400) : null);
      await sweep();
      expect(await runRow(created.run.runId)).toMatchObject({ status: "partial" });
      expect(notices.map((notice) => notice.idempotencyKey)).toEqual([`listing-push-run:${created.run.runId}:finished`]);
      const notifiedAt = async () => (await pool.query("SELECT notified_at FROM dropship.dropship_listing_push_runs WHERE id = $1",
        [created.run.runId])).rows[0].notified_at;
      expect(await notifiedAt()).toEqual(PRESS);
      // The process died between the finish's commit and its email: the notice step is not stamped.
      await pool.query("UPDATE dropship.dropship_listing_push_runs SET notified_at = NULL WHERE id = $1", [created.run.runId]);
      now = new Date(PRESS.getTime() + 60_000);
      await sweepService.reconcileAndFinish();
      expect(notices.map((notice) => notice.idempotencyKey)).toEqual(Array(2).fill(`listing-push-run:${created.run.runId}:finished`));
      expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_RUN_NOTICE_RECOVERED")).toMatchObject({ level: "warn" });
      expect(await notifiedAt()).toEqual(now);
      await sweepService.reconcileAndFinish();
      expect(notices).toHaveLength(2);
      // A finished run past the window is never sent again, and a run still publishing has no notice step.
      await pool.query("UPDATE dropship.dropship_listing_push_runs SET notified_at = NULL, completed_at = $2 WHERE id = $1",
        [created.run.runId, new Date(now.getTime() - 25 * 60 * 60_000)]);
      await sweepService.reconcileAndFinish();
      expect(notices).toHaveLength(2);
      await expectSqlState(() => pool.query(`UPDATE dropship.dropship_listing_push_runs SET status = 'processing', completed_at = NULL,
        notified_at = $2 WHERE id = $1`, [created.run.runId, now]), "23514", "dropship_push_run_notified_chk");
    }, REPLAY_TIMEOUT_MS);

    // V15 (FIDELITY-12): the push worker's `selection:` blocker reads the picks at push time, through the preview.
    it("blocks a size whose pick is removed after its chunk job was queued: the worker answers DROPSHIP_LISTING_NOT_SELECTED (PLAN-B v4.1 V15)", async () => {
      await seedSizes(3);
      const revision = await saveSelection("every size", "save-all-v15-01");
      const created = await createRun({ key: "run-unpicked-v15", expected: revision });
      const { sweep, sweepService } = services({ pushTimeSelection: true });
      await sweepService.expandRuns();
      const queued = await pool.query<{ product_variant_id: number; status: string }>(`SELECT i.product_variant_id, i.status
        FROM dropship.dropship_listing_push_job_items i JOIN dropship.dropship_listing_push_jobs j ON j.id = i.job_id
        WHERE j.run_id = $1 ORDER BY i.product_variant_id`, [created.run.runId]);
      expect(queued.rows.map((row) => [row.product_variant_id, row.status])).toEqual([
        [FIRST_SIZE, "queued"], [FIRST_SIZE + 1, "queued"], [FIRST_SIZE + 2, "queued"]]);
      // The vendor removes size 2 while the job waits: the worker's push-time preview reads the picks and no longer selects it.
      await removePicks(pool, VENDOR, [FIRST_SIZE + 1]);
      await sweep();
      const items = await pool.query<{ product_variant_id: number; status: string; error_code: string | null }>(`SELECT i.product_variant_id,
        i.status, i.error_code FROM dropship.dropship_listing_push_job_items i JOIN dropship.dropship_listing_push_jobs j ON j.id = i.job_id
        WHERE j.run_id = $1 ORDER BY i.product_variant_id`, [created.run.runId]);
      expect(items.rows.map((row) => [row.product_variant_id, row.status, row.error_code])).toEqual([
        [FIRST_SIZE, "completed", null], [FIRST_SIZE + 1, "blocked", "DROPSHIP_LISTING_NOT_SELECTED"], [FIRST_SIZE + 2, "completed", null]]);
      expect([...providerCalls].sort((left, right) => left - right)).toEqual([FIRST_SIZE, FIRST_SIZE + 2]);
    }, REPLAY_TIMEOUT_MS);

    it("a run whose only sizes left out were deselected finishes completed, with no email (verify V10)", async () => {
      await seedSizes(3);
      const revision = await saveSelection("every size", "save-all-v10-01");
      const created = await createRun({ key: "run-skipped-v10", expected: revision });
      // The vendor removes size 3 after the press (at main a variant exclude rule).
      await removePicks(pool, VENDOR, [FIRST_SIZE + 2]);
      await services().sweep();
      expect(await outcomeCounts(created.run.runId)).toEqual({ completed: 2, skipped: 1 });
      expect(await runRow(created.run.runId)).toMatchObject({ status: "completed" });
      expect(notices).toEqual([]);
      const finished = await pool.query(`SELECT severity FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_run_finished'`);
      expect(finished.rows).toEqual([{ severity: "info" }]);
    }, REPLAY_TIMEOUT_MS);
  });

  // Rebase of PR A onto PR 1b: the scheduled sweep runs 1b's recovery first, then the run steps, then the claims
  // (dropship-listing-push-job-runner runDropshipListingPushSweep).
  describe("one sweep with PR 1b's listing push recovery", () => {
    /** A listing an earlier release demoted: a push published it live, then a later update's failure wrote 'failed'. */
    async function seedDemotedLiveListing(productVariantId: number): Promise<number> {
      const listing = await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_vendor_listings
        (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id)
        VALUES ($1, $2, $3, 'ebay', 'failed', 'EBAY-OLD') RETURNING id`, [VENDOR, STORE, productVariantId]);
      const listingId = listing.rows[0]!.id;
      const pushes: Array<[string, Date, Record<string, unknown>]> = [
        ["completed", new Date(PRESS.getTime() - 2 * 60 * 60_000), { push: { rawResult: { listingMode: "live" } } }],
        ["failed", new Date(PRESS.getTime() - 60 * 60_000), { push: { status: "failed", retryable: true } }],
      ];
      for (const [status, wroteAt, result] of pushes) {
        const job = await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs
          (vendor_id, store_connection_id, status, created_at, updated_at, completed_at) VALUES ($1, $2, $3, $4, $4, $4) RETURNING id`,
          [VENDOR, STORE, status, wroteAt]);
        await pool.query(`INSERT INTO dropship.dropship_listing_push_job_items
          (job_id, listing_id, product_variant_id, status, result, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
          [job.rows[0]!.id, listingId, productVariantId, status, JSON.stringify(result), wroteAt]);
      }
      return listingId;
    }

    function sweepWith(recovery: DropshipListingPushRecoveryService | undefined) {
      const { queueRepository, worker, sweepService } = services();
      return runDropshipListingPushSweep({
        repository: queueRepository,
        processJob: async (input) => { await worker.processJob(input); },
        runs: sweepService,
        ...(recovery ? { recovery } : {}),
        logger,
        batchSize: 10,
        staleProcessingMinutes: 30,
        now: clock.now(),
        workerId: WORKER_ID,
      });
    }

    function recovery(): DropshipListingPushRecoveryService {
      return new DropshipListingPushRecoveryService({
        liveStatusRepair: new PgDropshipListingLiveStatusRepairRepository(pool),
        // 1b's other step (the account-check requeue) has nothing to find here.
        accountVerificationRequeue: { requeueAccountVerificationFailures: async () => ({ requeued: [], failed: [] }) },
        clock,
        logger,
      });
    }

    it("restores a listing an earlier release demoted before the run's pre-filter reads it, so 'not_live' skips it as already live", async () => {
      await seedSizes(2);
      const listingId = await seedDemotedLiveListing(FIRST_SIZE);
      const revision = await saveSelection("every size", "save-all-1b-0001");
      // At the press the listing reads 'failed', so the 'not_live' snapshot takes it.
      const created = await createRun({ key: "run-1b-order-0001", scope: "not_live", expected: revision });
      expect((await targetsOf(created.run.runId)).map((row) => row.product_variant_id)).toEqual([FIRST_SIZE, FIRST_SIZE + 1]);

      await sweepWith(recovery());

      expect((await pool.query("SELECT status FROM dropship.dropship_vendor_listings WHERE id = $1", [listingId])).rows[0].status).toBe("active");
      expect((await targetsOf(created.run.runId)).map((row) => [row.product_variant_id, row.outcome, row.code])).toEqual([
        [FIRST_SIZE, "skipped", "DROPSHIP_LISTING_ALREADY_LIVE"],
        [FIRST_SIZE + 1, "completed", null],
      ]);
      // eBay already lists it: nothing was sent for it.
      expect(providerCalls).toEqual([FIRST_SIZE + 1]);
      expect(await runRow(created.run.runId)).toMatchObject({ status: "completed" });
      const restored = await pool.query(`SELECT entity_id FROM dropship.dropship_audit_events WHERE event_type = 'listing_live_status_restored'`);
      expect(restored.rows).toEqual([{ entity_id: String(listingId) }]);
    }, REPLAY_TIMEOUT_MS);

    it("without the recovery (the staff sweep), the same listing is sent again: the order is what skips it", async () => {
      await seedSizes(2);
      const listingId = await seedDemotedLiveListing(FIRST_SIZE);
      const revision = await saveSelection("every size", "save-all-1b-0002");
      const created = await createRun({ key: "run-1b-order-0002", scope: "not_live", expected: revision });

      await sweepWith(undefined);

      expect([...providerCalls].sort((left, right) => left - right)).toEqual([FIRST_SIZE, FIRST_SIZE + 1]);
      expect((await targetsOf(created.run.runId)).map((row) => row.outcome)).toEqual(["completed", "completed"]);
      // Its completed push publishes it again (completeItem), so the listing is active either way.
      expect((await pool.query("SELECT status FROM dropship.dropship_vendor_listings WHERE id = $1", [listingId])).rows[0].status).toBe("active");
    }, REPLAY_TIMEOUT_MS);
  });
});
