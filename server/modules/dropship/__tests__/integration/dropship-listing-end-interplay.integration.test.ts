import { PgDialect } from "drizzle-orm/pg-core";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import type { QuantityPublicationScope } from "../../../inventory-planning/domain/quantity-publication-admission";
import type { CreateDropshipListingPushJobRepositoryInput } from "../../application/dropship-listing-preview-service";
import {
  DropshipListingPushWorkerService,
  type DropshipListingPushWorkerItemRecord,
  type DropshipListingPushWorkerJobRecord,
} from "../../application/dropship-listing-push-worker-service";
import type { DropshipMarketplaceListingPushProvider } from "../../application/dropship-marketplace-listing-push-provider";
import { DropshipListingEndOpsService } from "../../application/dropship-listing-end-ops-service";
import { DropshipMarketplaceSyncService, type MarketplaceListingSyncWrite } from "../../application/dropship-marketplace-sync-service";
import { LISTING_END_FENCE_CODES } from "../../domain/listing-end-fence";
import { parseMarketplaceListingObservation } from "../../domain/marketplace-listing-observation";
import { decideMarketplaceSync } from "../../domain/marketplace-sync-decision";
import { MARKETPLACE_SYNC_CODES } from "../../domain/marketplace-sync-errors";
import { PgDropshipEbayOrderIntakeRepository } from "../../infrastructure/dropship-ebay-order-intake.repository";
import { PgDropshipListingLiveStatusRepairRepository } from "../../infrastructure/dropship-listing-live-status-repair.repository";
import { PgDropshipListingEndOpsRepository } from "../../infrastructure/dropship-listing-end-ops.repository";
import { PgDropshipListingPreviewRepository } from "../../infrastructure/dropship-listing-preview.repository";
import { PgDropshipListingPushOpsRepository } from "../../infrastructure/dropship-listing-push-ops.repository";
import { PgDropshipListingPushWorkerRepository } from "../../infrastructure/dropship-listing-push-worker.repository";
import { DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS } from "../../infrastructure/dropship-marketplace-sync-health.sql";
import {
  PgDropshipMarketplaceSyncRepository,
  type MarketplaceSyncPriceWriter,
} from "../../infrastructure/dropship-marketplace-sync.repository";
import { DropshipQuantityPublicationCatchupProvider } from "../../infrastructure/dropship-quantity-publication-catchup.provider";
import { ebaySyncBackBaseFixtureSql, installEbaySyncBackSchema } from "../fixtures/ebay-sync-back.fixture";
import { rawInventoryItem, rawOffer, READ_LISTING_ID, READ_OFFER_ID, READ_SKU } from "../fixtures/ebay-sync-back-reads.fixture";
import {
  applyThroughReleaseExecutor,
  insertListingEndRequests,
  LISTING_END_FIXTURE_AT,
  LISTING_END_MIGRATION_FILE,
  listingEndMigrationSql,
  type ListingEndRequestRow,
} from "../fixtures/listing-end.fixture";
import { LISTING_PUSH_RUNS_MIGRATION_FILE, listingPushRunsMigrationSql } from "../fixtures/listing-push-runs.fixture";

/**
 * PR C's fences and their interplay with every Dropship writer and reader that meets a listing Card Shellz is
 * ending or ended (PLAN-C v4.1 §6-§9), on PostgreSQL with the real migrations: 0743, eBay sync-back's, PR A's publish
 * runs and PR C's end requests (through the release executor). End rows are fixture rows (C2 is inert until C3's
 * save writes them). A "Card Shellz end" (C end) is a listing `ended` with marketplace_ended_at NULL and an `ended`
 * end request; a "vendor end" is sync-back's `ended` with marketplace_ended_at. Clocks are fixed; eBay is a stub.
 * C5 adds a staff resolution's interplay (§10, §9 I11): "Ended on eBay" through the real staff service is a C end
 * (never swept, a pre-dated vendor press fenced); "Left on sale" closes the end and the sweep reads the listing again.
 */
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const VENDOR = 10;
const STORE = 22;
const PRODUCT = 20;
const REVISION = 1;
const WORKER = "worker-interplay";
const T_PUSHED = new Date("2026-10-20T09:00:00.000Z");
const T_QUEUED_BEFORE_END = new Date("2026-10-24T10:00:00.000Z");
/** The fixture end rows' clock: a Card Shellz end finished at this time. */
const T_ENDED = new Date(LISTING_END_FIXTURE_AT);
const NOW = new Date("2026-10-26T09:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;

/**
 * What the code under test reads that the sync-back base leaves out: the store's account and tokens, the listing
 * config's columns, the job and item columns of 0086/0094, and the rule set revisions table PR A's and PR C's keys
 * reference (0091, reduced to its key and owner).
 */
const INTERPLAY_FIXTURE_SQL = `
  ALTER TABLE dropship.dropship_store_connections ADD COLUMN access_token_ref text, ADD COLUMN refresh_token_ref text,
    ADD COLUMN external_account_id varchar(255), ADD COLUMN provider_environment varchar(20),
    ADD COLUMN external_account_identity_scheme varchar(40), ADD COLUMN external_account_verified_at timestamptz;
  ALTER TABLE dropship.dropship_store_listing_configs ADD COLUMN price_mode varchar(40) NOT NULL DEFAULT 'vendor_defined',
    ADD COLUMN marketplace_config jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN required_config_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN required_product_fields jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE dropship.dropship_listing_push_jobs ADD COLUMN job_type varchar(40) NOT NULL DEFAULT 'push', ADD COLUMN requested_scope jsonb,
    ADD COLUMN requested_by varchar(255), ADD COLUMN idempotency_key varchar(200), ADD COLUMN request_hash text, ADD COLUMN error_message text,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN completed_at timestamptz,
    ADD CONSTRAINT dropship_listing_job_status_chk CHECK (status IN ('queued','processing','completed','failed','cancelled'));
  CREATE UNIQUE INDEX dropship_listing_job_idem_idx ON dropship.dropship_listing_push_jobs(vendor_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  ALTER TABLE dropship.dropship_listing_push_job_items ADD COLUMN preview_hash varchar(128), ADD COLUMN external_listing_id varchar(255),
    ADD COLUMN error_code varchar(100), ADD COLUMN error_message text, ADD COLUMN idempotency_key varchar(200),
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT dropship_listing_job_item_status_chk CHECK (status IN ('queued','processing','completed','failed','blocked','cancelled'));
  CREATE UNIQUE INDEX dropship_listing_job_item_job_variant_idx ON dropship.dropship_listing_push_job_items(job_id, product_variant_id);
  CREATE TABLE dropship.dropship_vendor_selection_rule_set_revisions (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE);
  -- The staff list's vendor columns (0086), read by the staff surface's repository (C5).
  ALTER TABLE dropship.dropship_vendors ADD COLUMN business_name varchar(200), ADD COLUMN email varchar(255);
`;

/** The price writer is never reached: no case here adopts a price (the sweep and pre-read writes carry none). */
const noPriceWriter: MarketplaceSyncPriceWriter = {
  async adoptPrice() { throw new Error("No interplay case adopts a price."); },
};

type Handle = Pick<Pool, "query">;

describeDatabase.sequential("PR C end requests: fences and interplay (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;
  const dialect = new PgDialect();

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, `${ebaySyncBackBaseFixtureSql}\n${INTERPLAY_FIXTURE_SQL}`);
    pool = database.pool;
    await installEbaySyncBackSchema(pool);
    const client = await pool.connect();
    try {
      await applyThroughReleaseExecutor(client, LISTING_PUSH_RUNS_MIGRATION_FILE, listingPushRunsMigrationSql());
      await applyThroughReleaseExecutor(client, LISTING_END_MIGRATION_FILE, listingEndMigrationSql());
    } finally {
      client.release();
    }
  }, 120_000);

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE dropship.dropship_listing_end_requests, dropship.dropship_listing_previous_marketplace_ids,
      dropship.dropship_marketplace_sync_notices, dropship.dropship_listing_sync_events, dropship.dropship_listing_push_run_targets,
      dropship.dropship_listing_push_job_items, dropship.dropship_listing_push_jobs, dropship.dropship_listing_push_runs,
      dropship.dropship_audit_events, dropship.dropship_vendor_listings, dropship.dropship_store_listing_configs,
      dropship.dropship_vendor_selection_rule_set_revisions, dropship.dropship_store_connections, dropship.dropship_vendors,
      catalog.product_variants, catalog.products RESTART IDENTITY CASCADE`);
    await pool.query(`
      INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (${VENDOR}, 'member-10');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, setup_status, access_token_ref, refresh_token_ref,
        external_account_id, provider_environment, external_account_identity_scheme, external_account_verified_at, last_order_sync_at)
        VALUES (${STORE}, ${VENDOR}, 'ebay', 'connected', 'ready', 'access-22', 'refresh-22', 'seller-22', 'production',
          'provider_user_id', '2026-10-01T00:00:00Z', '2026-10-26T08:00:00Z');
      INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, inventory_mode, is_active,
        marketplace_config) VALUES (${STORE}, 'ebay', 'live', 'managed_quantity_sync', true, '{"marketplaceId":"EBAY_US"}');
      INSERT INTO catalog.products (id, sku) VALUES (${PRODUCT}, 'CS-TOP');
      INSERT INTO catalog.product_variants (id, product_id, sku) VALUES (101, ${PRODUCT}, '${READ_SKU}'), (102, ${PRODUCT}, 'CS-TOP-102'),
        (103, ${PRODUCT}, 'CS-TOP-103'), (104, ${PRODUCT}, 'CS-TOP-104'), (105, ${PRODUCT}, 'CS-TOP-105'), (106, ${PRODUCT}, 'CS-TOP-106');
      INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions (vendor_id) VALUES (${VENDOR});`);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Seeds and reads

  async function seedListing(input: {
    variant: number; status: string; listingId?: string | null; offerId?: string | null; marketplaceEndedAt?: Date | null;
    updatedAt?: Date; issueCodes?: string[];
  }): Promise<number> {
    const listingId = input.listingId === undefined ? `1100000000${input.variant}` : input.listingId;
    const offerId = input.offerId === undefined ? `OFFER-${input.variant}` : input.offerId;
    const result = await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_vendor_listings
      (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id, external_offer_id, marketplace_ended_at,
       marketplace_issue_codes, last_preview_hash, vendor_retail_price_cents, pushed_quantity, last_pushed_at, metadata, created_at, updated_at)
      VALUES ($1, $2, $3, 'ebay', $4, $5, $6, $7, $8, $9, 1100, 10, $10, '{}'::jsonb, $10, $11) RETURNING id`,
    [VENDOR, STORE, input.variant, input.status, listingId, offerId, input.marketplaceEndedAt ?? null, input.issueCodes ?? [],
      `preview-${input.variant}`, T_PUSHED, input.updatedAt ?? T_PUSHED]);
    return result.rows[0]!.id;
  }

  /** A Card Shellz end, as C4's finish leaves it: the listing `ended` (ids kept, no vendor end time) and its request `ended`. */
  async function seedCardShellzEnd(variant: number, options: { listingId?: string; offerId?: string } = {}): Promise<number> {
    const listingId = await seedListing({ variant, status: "ended", updatedAt: T_ENDED, ...options });
    await seedEnds([{ listingId, variant, state: "ended" }]);
    return listingId;
  }

  async function seedEnds(rows: Array<{ listingId: number; variant: number; state: string; endedAt?: string | null }>): Promise<number[]> {
    return insertListingEndRequests(pool, rows.map((row): ListingEndRequestRow => ({
      vendorId: VENDOR, storeConnectionId: STORE, listingId: row.listingId, productId: PRODUCT, productVariantId: row.variant,
      selectionRevisionId: REVISION, state: row.state, reason: "size_removed",
      ...(row.state === "ending" ? { resolvedIdentity: { connectionId: STORE } } : {}),
      ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
    })));
  }

  let jobs = 0;
  async function seedJob(input: { status?: string; requestedBy?: string; createdAt?: Date } = {}): Promise<number> {
    jobs += 1;
    const at = input.createdAt ?? NOW;
    return (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs
      (vendor_id, store_connection_id, status, idempotency_key, request_hash, requested_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'hash', $5, $6, $6) RETURNING id`,
    [VENDOR, STORE, input.status ?? "queued", `interplay-${jobs}`, input.requestedBy ?? "system", at])).rows[0]!.id;
  }

  /** A queued push item with a live listing intent; `vendorPress` marks it the vendor's own (the queue's relistAllowed). */
  async function seedItem(input: { jobId: number; listingId: number; variant: number; status?: string; vendorPress?: boolean;
    createdAt?: Date; result?: Record<string, unknown> }): Promise<number> {
    const result = { listingIntent: listingIntent(input.variant), ...(input.vendorPress ? { relistAllowed: true } : {}), ...input.result };
    const at = input.createdAt ?? NOW;
    return (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_job_items
      (job_id, listing_id, product_variant_id, status, preview_hash, result, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7) RETURNING id`,
    [input.jobId, input.listingId, input.variant, input.status ?? "queued", `preview-${input.variant}`, JSON.stringify(result), at])).rows[0]!.id;
  }

  function listingIntent(variant: number) {
    return { platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync", priceMode: "vendor_defined",
      productVariantId: variant, sku: variant === 101 ? READ_SKU : `CS-TOP-${variant}`, title: "Toploaders", description: "Rigid.",
      category: null, brand: "Card Shellz", gtin: null, mpn: null, condition: "new", itemSpecifics: null, imageUrls: [],
      priceCents: 1100, quantity: 10, marketplaceConfig: { marketplaceId: "EBAY_US" } };
  }

  async function listingRow(id: number): Promise<{ status: string; updated_at: Date; marketplace_ended_at: Date | null;
    external_listing_id: string | null; external_offer_id: string | null }> {
    return (await pool.query(`SELECT status, updated_at, marketplace_ended_at, external_listing_id, external_offer_id
      FROM dropship.dropship_vendor_listings WHERE id = $1`, [id])).rows[0];
  }

  async function itemRow(id: number): Promise<{ status: string; error_code: string | null; created_at: Date }> {
    return (await pool.query(`SELECT status, error_code, created_at FROM dropship.dropship_listing_push_job_items WHERE id = $1`, [id])).rows[0];
  }

  function jobRecord(jobId: number, overrides: Partial<DropshipListingPushWorkerJobRecord> = {}): DropshipListingPushWorkerJobRecord {
    return { jobId, vendorId: VENDOR, storeConnectionId: STORE, platform: "ebay", status: "processing", idempotencyKey: "seed",
      requestHash: "hash", createdAt: NOW, updatedAt: NOW, completedAt: null, ...overrides };
  }

  function itemRecord(itemId: number, jobId: number, listingId: number, variant: number): DropshipListingPushWorkerItemRecord {
    return { itemId, jobId, listingId, productVariantId: variant, status: "processing", previewHash: `preview-${variant}`,
      externalListingId: null, errorCode: null, errorMessage: null, result: null, listing: null };
  }

  /** The eBay push provider: records every call, answers as a completed update. No case here should reach it but one. */
  function pushProvider(): DropshipMarketplaceListingPushProvider & { calls: number[] } {
    const calls: number[] = [];
    return {
      calls,
      async pushListing(input) {
        calls.push(input.jobItemId);
        return { status: "updated", externalListingId: "110000009999", externalOfferId: input.existingExternalOfferId ?? "OFFER-NEW",
          rawResult: {} };
      },
    } as DropshipMarketplaceListingPushProvider & { calls: number[] };
  }

  const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

  function worker(provider: DropshipMarketplaceListingPushProvider, extra: Partial<ConstructorParameters<typeof DropshipListingPushWorkerService>[0]> = {}) {
    return new DropshipListingPushWorkerService({ repository: new PgDropshipListingPushWorkerRepository(pool), marketplacePush: provider,
      clock: { now: () => NOW }, logger: silentLogger, ...extra });
  }

  /** The backend running a statement that starts with `prefix` and waits on a heavyweight lock, if any. */
  async function waitingBackend(prefix: string): Promise<number | null> {
    const row = (await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE state = 'active' AND wait_event_type = 'Lock' AND left(ltrim(query), $2) = $1 AND pid <> pg_backend_pid()
      ORDER BY query_start LIMIT 1`, [prefix, prefix.length])).rows[0];
    return row?.pid ?? null;
  }

  async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!(await check())) {
      if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    }
  }

  /**
   * The pool, except that the first transaction's COMMIT waits until `release` is called: the repository's
   * transaction is held open after its writes, as a slow worker's would be (TST-4).
   */
  function poolHoldingFirstCommit(): { pool: Pool; reachedCommit: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reachedCommit = new Promise<void>((resolve) => { reached = resolve; });
    let held = false;
    const wrapped = {
      query: (text: string, values?: unknown[]) => pool.query(text, values),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: unknown, values?: unknown[]) => {
            if (text === "COMMIT" && !held) {
              held = true;
              reached();
              await gate;
            }
            return client.query(text as string, values);
          },
          release: (error?: Error) => client.release(error),
        } as unknown as PoolClient;
      },
    } as unknown as Pool;
    return { pool: wrapped, reachedCommit, release };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // §6.3 / §9 I4: `ended` survives every writer except a completed push (SB8).

  function previewRow(variant: number) {
    return { productVariantId: variant, productId: PRODUCT, previewStatus: "ready", blockers: [], warnings: [], priceCents: 1200,
      marketplaceQuantity: 10, previewHash: `new-preview-${variant}`, listingMode: "live", businessPolicySelection: null,
      listingIntent: listingIntent(variant) };
  }

  /** The push queue's upsert (PRV), as the vendor's press or a system push makes it. */
  async function queue(variants: number[], requestedBy: { actorType: string; actorId: string } = { actorType: "vendor", actorId: "member-10" }) {
    const rows = variants.map(previewRow);
    return new PgDropshipListingPreviewRepository(pool).createListingPushJob({
      vendorId: VENDOR, storeConnectionId: STORE, platform: "ebay", productVariantIds: variants, requestedRetailPricesByVariantId: {},
      idempotencyKey: `queue-${requestedBy.actorType}-${variants.join("-")}`, requestHash: "request-hash", requestedBy,
      preview: { vendorId: VENDOR, storeConnectionId: STORE, platform: "ebay", generatedAt: NOW, rows,
        summary: { total: rows.length, ready: rows.length, blocked: 0, warning: 0 } },
      now: NOW,
    } as unknown as CreateDropshipListingPushJobRepositoryInput);
  }

  describe("an ended listing stays ended through every writer but a completed push (§6.3)", () => {
    it("keeps `ended` and the end's updated_at when a push is queued, for Card Shellz's end and the vendor's", async () => {
      const cardShellzEnd = await seedCardShellzEnd(101);
      const vendorEnd = await seedListing({ variant: 102, status: "ended", marketplaceEndedAt: T_ENDED, updatedAt: T_ENDED });
      const live = await seedListing({ variant: 103, status: "active" });

      const created = await queue([101, 102, 103]);

      expect(created.items.map((item) => [item.productVariantId, item.status])).toEqual([[101, "queued"], [102, "queued"], [103, "queued"]]);
      for (const id of [cardShellzEnd, vendorEnd]) {
        expect(await listingRow(id)).toMatchObject({ status: "ended", updated_at: T_ENDED });
      }
      // The vendor's re-publish is a saved push newer than the end (its item was created after updated_at): the stock
      // reader's newer-push rule (SPR) sees it while the listing keeps its end for the push's pre-read.
      const item = await itemRow(created.items[0]!.itemId);
      expect(item.created_at.getTime()).toBeGreaterThan(T_ENDED.getTime());
      expect((await listingRow(live)).status).toBe("active");
    }, CASE_TIMEOUT_MS);

    it("keeps `ended` through a failed or blocked push, and moves updated_at so the failed item is no newer push", async () => {
      const ended = await seedCardShellzEnd(101);
      const blocked = await seedCardShellzEnd(102);
      const job = await seedJob({ status: "processing" });
      const failedItem = await seedItem({ jobId: job, listingId: ended, variant: 101, status: "processing" });
      const blockedItem = await seedItem({ jobId: job, listingId: blocked, variant: 102, status: "processing" });
      const repository = new PgDropshipListingPushWorkerRepository(pool);

      await repository.failItem({ job: jobRecord(job), item: itemRecord(failedItem, job, ended, 101), code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
        message: "eBay listing push failed with HTTP 400", retryable: false, workerId: WORKER, now: NOW });
      await repository.blockItem({ job: jobRecord(job), item: itemRecord(blockedItem, job, blocked, 102), code: "DROPSHIP_LISTING_STORE_BLOCKED",
        message: "Dropship store connection is no longer launch-ready for listing push.", workerId: WORKER, now: NOW });

      expect(await listingRow(ended)).toMatchObject({ status: "ended", updated_at: NOW });
      expect(await listingRow(blocked)).toMatchObject({ status: "ended", updated_at: NOW });
      const events = (await pool.query(`SELECT listing_id, event_type, payload -> 'listingStatus' AS status FROM dropship.dropship_listing_sync_events
        WHERE event_type IN ('listing_push_failed', 'listing_push_blocked') ORDER BY id`)).rows;
      expect(events).toEqual([{ listing_id: ended, event_type: "listing_push_failed", status: { before: "ended", after: "ended" } },
        { listing_id: blocked, event_type: "listing_push_blocked", status: { before: "ended", after: "ended" } }]);
    }, CASE_TIMEOUT_MS);

    it("keeps `ended` when the job breaker fails every queued item of the job", async () => {
      const ended = await seedCardShellzEnd(101);
      const vendorEnd = await seedListing({ variant: 102, status: "ended", marketplaceEndedAt: T_ENDED, updatedAt: T_ENDED });
      const job = await seedJob({ status: "processing" });
      const first = await seedItem({ jobId: job, listingId: ended, variant: 101, status: "processing" });
      await seedItem({ jobId: job, listingId: vendorEnd, variant: 102 });

      const tripped = await new PgDropshipListingPushWorkerRepository(pool).tripJobBreaker({ job: jobRecord(job),
        item: itemRecord(first, job, ended, 101), code: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE", message: "eBay wasn't answering.",
        workerId: WORKER, now: NOW });

      expect(tripped.failedItemIds).toHaveLength(2);
      expect((await listingRow(ended)).status).toBe("ended");
      expect((await listingRow(vendorEnd)).status).toBe("ended");
      const audit = (await pool.query(`SELECT payload -> 'listingStatuses' AS statuses FROM dropship.dropship_audit_events
        WHERE event_type = 'listing_push_job_breaker_tripped'`)).rows[0];
      expect(audit.statuses).toEqual([{ listingId: ended, before: "ended", after: "ended" }, { listingId: vendorEnd, before: "ended", after: "ended" }]);
    }, CASE_TIMEOUT_MS);

    it("keeps `ended` when staff retry the failed push, and the live-status repair never touches it afterwards", async () => {
      const ended = await seedCardShellzEnd(101);
      const job = await seedJob({ status: "failed" });
      await seedItem({ jobId: job, listingId: ended, variant: 101, status: "failed",
        result: { push: { status: "failed", retryable: true } } });

      const retried = await new PgDropshipListingPushOpsRepository(pool).retryJob({ jobId: job, idempotencyKey: "ops-retry",
        actor: { actorType: "admin", actorId: "ops-1" }, reason: "eBay outage cleared", now: NOW });

      expect(retried).toMatchObject({ status: "queued", requeuedItemCount: 1 });
      expect((await listingRow(ended)).status).toBe("ended");
      // Before PR C a queue and then a failure turned an ended row `failed`, which the repair then made `active` again.
      const repairs = await new PgDropshipListingLiveStatusRepairRepository(pool).restoreDemotedLiveListings({ now: NOW, workerId: WORKER, limit: 50 });
      expect(repairs).toMatchObject({ restored: [], reviewRequired: [] });
      expect((await listingRow(ended)).status).toBe("ended");
    }, CASE_TIMEOUT_MS);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // §6.2: the push fence in markItemProcessing.

  describe("the push fence (§6.2)", () => {
    it.each([
      { state: "pending", outcome: "end_open" },
      { state: "ending", outcome: "end_open" },
      { state: "failed", outcome: "end_review" },
    ])("answers $outcome for an item whose listing has a $state end, and leaves the item queued", async ({ state, outcome }) => {
      const listing = await seedListing({ variant: 101, status: "active" });
      await seedEnds([{ listingId: listing, variant: 101, state }]);
      const job = await seedJob();
      const item = await seedItem({ jobId: job, listingId: listing, variant: 101 });

      expect(await new PgDropshipListingPushWorkerRepository(pool).markItemProcessing({ jobId: job, itemId: item, workerId: WORKER, now: NOW }))
        .toBe(outcome);
      expect((await itemRow(item)).status).toBe("queued");
    }, CASE_TIMEOUT_MS);

    it("fences an item created before Card Shellz's end finished (SAF-9), and starts one created after it", async () => {
      const ended = await seedCardShellzEnd(101);
      const job = await seedJob();
      const before = await seedItem({ jobId: job, listingId: ended, variant: 101, vendorPress: true, createdAt: T_QUEUED_BEFORE_END });
      const otherJob = await seedJob();
      const after = await seedItem({ jobId: otherJob, listingId: ended, variant: 101, vendorPress: true, createdAt: NOW });
      const repository = new PgDropshipListingPushWorkerRepository(pool);

      expect(await repository.markItemProcessing({ jobId: job, itemId: before, workerId: WORKER, now: NOW })).toBe("ended_since_queued");
      expect((await itemRow(before)).status).toBe("queued");
      expect(await repository.markItemProcessing({ jobId: otherJob, itemId: after, workerId: WORKER, now: NOW })).toBe("started");
      expect((await itemRow(after)).status).toBe("processing");
    }, CASE_TIMEOUT_MS);

    it("does not fence a closed end: superseded or resolved", async () => {
      const superseded = await seedListing({ variant: 101, status: "active" });
      const resolved = await seedListing({ variant: 102, status: "active" });
      await seedEnds([{ listingId: superseded, variant: 101, state: "superseded" }, { listingId: resolved, variant: 102, state: "resolved" }]);
      const job = await seedJob();
      const first = await seedItem({ jobId: job, listingId: superseded, variant: 101, createdAt: T_QUEUED_BEFORE_END });
      const second = await seedItem({ jobId: job, listingId: resolved, variant: 102, createdAt: T_QUEUED_BEFORE_END });
      const repository = new PgDropshipListingPushWorkerRepository(pool);

      expect(await repository.markItemProcessing({ jobId: job, itemId: first, workerId: WORKER, now: NOW })).toBe("started");
      expect(await repository.markItemProcessing({ jobId: job, itemId: second, workerId: WORKER, now: NOW })).toBe("started");
    }, CASE_TIMEOUT_MS);

    // Interleaving (a) at the fence's side: the fence read no end and holds the listing FOR SHARE until it commits;
    // the save's end insert (a key lock) goes through, and a claim's listing lock FOR UPDATE waits for the commit and
    // then sees the item processing. The real claim (C4) runs the same interleaving in
    // dropship-listing-end.integration.test.ts ("interleaving (a)"), where it defers WAITING_FOR_PUSH.
    it("holds the listing while it starts an item: a claim waits for the commit, then sees the item processing", async () => {
      const listing = await seedListing({ variant: 101, status: "active" });
      const job = await seedJob();
      const item = await seedItem({ jobId: job, listingId: listing, variant: 101 });
      const held = poolHoldingFirstCommit();
      const starting = new PgDropshipListingPushWorkerRepository(held.pool).markItemProcessing({ jobId: job, itemId: item, workerId: WORKER, now: NOW });
      await held.reachedCommit;
      await seedEnds([{ listingId: listing, variant: 101, state: "pending" }]);
      const claim = await pool.connect();
      try {
        await claim.query("BEGIN");
        await claim.query("SET LOCAL lock_timeout = '10s'");
        const locking = claim.query("SELECT id FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE", [listing]);
        await waitFor(async () => (await waitingBackend("SELECT id FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE")) !== null,
          "the claim's listing lock to wait on the fence");
        held.release();
        expect(await starting).toBe("started");
        await locking;
        const seen = await claim.query<{ status: string }>(`SELECT status FROM dropship.dropship_listing_push_job_items
          WHERE listing_id = $1 AND status = 'processing'`, [listing]);
        expect(seen.rows).toEqual([{ status: "processing" }]);
        await claim.query("COMMIT");
      } finally {
        held.release();
        await claim.query("ROLLBACK").catch(() => undefined);
        claim.release();
      }
    }, CASE_TIMEOUT_MS);

    // Interleaving (b) at the fence's side: the claim moved the end to `ending` holding the listing; the fence waits, then
    // refuses. The real claim runs it in dropship-listing-end.integration.test.ts ("interleaving (b)").
    it("waits for a claim that holds the listing, then refuses the item once the claim committed `ending`", async () => {
      const listing = await seedListing({ variant: 101, status: "active" });
      const [endId] = await seedEnds([{ listingId: listing, variant: 101, state: "pending" }]);
      const job = await seedJob();
      const item = await seedItem({ jobId: job, listingId: listing, variant: 101 });
      const claim = await pool.connect();
      try {
        await claim.query("BEGIN");
        await claim.query("SELECT id FROM dropship.dropship_listing_end_requests WHERE id = $1 FOR UPDATE", [endId]);
        await claim.query("SELECT id FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE", [listing]);
        await claim.query(`UPDATE dropship.dropship_listing_end_requests SET state = 'ending', resolved_identity = '{"connectionId":22}'::jsonb,
          version = version + 1, updated_at = $2 WHERE id = $1`, [endId, NOW]);
        const starting = new PgDropshipListingPushWorkerRepository(pool).markItemProcessing({ jobId: job, itemId: item, workerId: WORKER, now: NOW });
        await waitFor(async () => (await waitingBackend("SELECT 1 FROM dropship.dropship_vendor_listings WHERE id = $1 FOR SHARE")) !== null,
          "the fence's listing lock to wait on the claim");
        await claim.query("COMMIT");
        expect(await starting).toBe("end_open");
        expect((await itemRow(item)).status).toBe("queued");
      } finally {
        await claim.query("ROLLBACK").catch(() => undefined);
        claim.release();
      }
    }, CASE_TIMEOUT_MS);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // §9 I3, I6, I10 and SAF-9: pushes that meet a Card Shellz end.

  describe("pushes that meet Card Shellz's end (§9 I3, I6)", () => {
    it("never sends a vendor's press queued before the end: cancelled quietly with its code, the listing stays ended", async () => {
      const ended = await seedCardShellzEnd(101);
      const job = await seedJob({ requestedBy: "vendor:member-10", createdAt: T_QUEUED_BEFORE_END });
      const item = await seedItem({ jobId: job, listingId: ended, variant: 101, vendorPress: true, createdAt: T_QUEUED_BEFORE_END });
      const provider = pushProvider();

      const result = await worker(provider).processJob({ jobId: job, workerId: WORKER, idempotencyKey: "process-pre-dated" });

      expect(provider.calls).toEqual([]);
      expect(result.items).toEqual([expect.objectContaining({ itemId: item, status: "cancelled", errorCode: LISTING_END_FENCE_CODES.endedSincePublish })]);
      expect(await listingRow(ended)).toMatchObject({ status: "ended", marketplace_ended_at: null });
      const audit = (await pool.query(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_item_skipped'`)).rows;
      expect(audit).toEqual([{ payload: expect.objectContaining({ code: LISTING_END_FENCE_CODES.endedSincePublish, before: "queued",
        after: "cancelled" }) }]);
    }, CASE_TIMEOUT_MS);

    // Queued through the upsert (B3: without its `ended` arm the queue reopens the listing and the read ends it as the vendor's).
    it("stops a system push after Card Shellz's end at the pre-read (stubbed eBay read), quietly, and the listing stays ended", async () => {
      const ended = await seedCardShellzEnd(101, { listingId: READ_LISTING_ID, offerId: READ_OFFER_ID });
      const created = await queue([101], { actorType: "system", actorId: "cost_change" });
      const job = created.job.jobId;
      const item = created.items[0]!.itemId;
      expect((await listingRow(ended)).status).toBe("ended");
      const provider = pushProvider();
      const reads: string[] = [];
      const sync = new DropshipMarketplaceSyncService({
        repository: new PgDropshipMarketplaceSyncRepository(pool, noPriceWriter),
        reader: { async readLiveListing(input) {
          reads.push(input.offerId);
          // eBay shows the withdrawn offer, not on sale (HYPOTHESIS A3 / I5: it still carries its price and quantity).
          return { kind: "read", inventoryItem: rawInventoryItem(),
            offer: rawOffer({ status: "UNPUBLISHED", listing: { listingId: READ_LISTING_ID, listingStatus: "ENDED" } }) };
        } },
        previews: { async generatePreview() {
          return { rows: [{ productVariantId: 101, sku: READ_SKU, title: "Toploaders", priceCents: 1100, priceSettingRevisionId: null,
            marketplaceQuantity: 10, businessPolicySelection: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1",
              overriddenFields: [] }, economics: null }] } as never;
        } },
        restores: { async queueRestore() { throw new Error("A push pre-read never queues a restore."); } },
        baselines: { async readPublishBaselines(input) {
          return new Map(input.listings.map((entry) => [entry.listingId, { quantity: 10, at: T_PUSHED, settled: true }]));
        } },
        policyGuard: { async evaluateForStoreConnection(input) {
          return { compatible: true, fulfillmentPolicyId: input.fulfillmentPolicyId, issues: [] } as never;
        } },
        notifications: { async send() { return {}; } },
        clock: { now: () => NOW },
        logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      const result = await worker(provider, { marketplaceSync: sync }).processJob({ jobId: job, workerId: WORKER, idempotencyKey: "process-system" });

      expect(reads).toEqual([READ_OFFER_ID]);
      expect(provider.calls).toEqual([]);
      expect(result.items).toEqual([expect.objectContaining({ itemId: item, status: "cancelled", errorCode: MARKETPLACE_SYNC_CODES.endedOnEbay })]);
      // Read, not reopened: Card Shellz's end has no vendor end time, so sync-back neither reopens nor relinks it.
      expect(await listingRow(ended)).toMatchObject({ status: "ended", marketplace_ended_at: null, external_listing_id: READ_LISTING_ID });
    }, CASE_TIMEOUT_MS);

    it("relists through the vendor's publish made after the end: active, the old item number kept as republished, still polled", async () => {
      const ended = await seedCardShellzEnd(101);
      const job = await seedJob({ requestedBy: "vendor:member-10" });
      const item = await seedItem({ jobId: job, listingId: ended, variant: 101, vendorPress: true });
      const repository = new PgDropshipListingPushWorkerRepository(pool);

      expect(await repository.markItemProcessing({ jobId: job, itemId: item, workerId: WORKER, now: NOW })).toBe("started");
      await repository.completeItem({ job: jobRecord(job), item: { ...itemRecord(item, job, ended, 101), result: { listingIntent: listingIntent(101) } },
        intent: listingIntent(101) as never, workerId: WORKER, now: NOW,
        pushResult: { status: "created", externalListingId: "110000000777", externalOfferId: "OFFER-101", rawResult: {} } as never });

      expect(await listingRow(ended)).toMatchObject({ status: "active", external_listing_id: "110000000777", marketplace_ended_at: null });
      expect((await pool.query(`SELECT external_listing_id, reason FROM dropship.dropship_listing_previous_marketplace_ids WHERE listing_id = $1`,
        [ended])).rows).toEqual([{ external_listing_id: "1100000000101", reason: "republished" }]);
      const stores = await new PgDropshipEbayOrderIntakeRepository(pool).listPollableStoreConnections({ limit: 10 });
      expect([...(stores.find((store) => store.storeConnectionId === STORE)?.dropshipListingIds ?? [])].sort())
        .toEqual(["110000000777", "1100000000101"].sort());
    }, CASE_TIMEOUT_MS);

    it("never sends a cost-change reprice of a listing being ended: cancelled quietly, eBay never called", async () => {
      const live = await seedListing({ variant: 101, status: "active" });
      await seedEnds([{ listingId: live, variant: 101, state: "pending" }]);
      const job = await seedJob({ requestedBy: "system:cost_change" });
      const item = await seedItem({ jobId: job, listingId: live, variant: 101 });
      const provider = pushProvider();

      const result = await worker(provider).processJob({ jobId: job, workerId: WORKER, idempotencyKey: "process-reprice" });

      expect(provider.calls).toEqual([]);
      expect(result.items).toEqual([expect.objectContaining({ itemId: item, status: "cancelled", errorCode: LISTING_END_FENCE_CODES.inProgress })]);
      expect((await listingRow(live)).status).toBe("active");
    }, CASE_TIMEOUT_MS);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // §9 I1: the sync sweep leaves a listing being ended alone.

  describe("the sync sweep and an open end (§9 I1)", () => {
    const repository = () => new PgDropshipMarketplaceSyncRepository(pool, noPriceWriter);

    it("reads no listing with a pending, ending or failed end, nor a Card Shellz end, in its due and observed lists and store count", async () => {
      const ids: number[] = [];
      for (const variant of [101, 102, 103, 104]) ids.push(await seedListing({ variant, status: "active" }));
      await seedEnds([{ listingId: ids[0]!, variant: 101, state: "pending" }, { listingId: ids[1]!, variant: 102, state: "ending" },
        { listingId: ids[2]!, variant: 103, state: "failed" }]);
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET observed_marketplace_quantity = 4, observed_marketplace_quantity_at = $1
        WHERE id = $2`, [NOW, ids[2]]);
      // I2: a Card Shellz end (no vendor end time) is never swept after the finish either.
      await seedCardShellzEnd(105);

      expect(await repository().listDueListingIds({ storeConnectionId: STORE, limit: 50 })).toEqual([ids[3]]);
      expect(await repository().listObservedListingIds({ storeConnectionId: STORE, limit: 50 })).toEqual([]);
      expect((await repository().loadStore(STORE))?.liveListingCount).toBe(1);

      // A closed end no longer hides the listing.
      await pool.query("UPDATE dropship.dropship_listing_end_requests SET state = 'superseded', next_attempt_at = NULL, decided_at = $2 WHERE listing_id = $1",
        [ids[0], NOW]);
      expect(await repository().listDueListingIds({ storeConnectionId: STORE, limit: 50 })).toEqual([ids[0], ids[3]]);
    }, CASE_TIMEOUT_MS);

    // §10, §9 I11 (SAF-8): a staff resolution of a failed end, through the real staff service (C5).
    function staff() {
      return new DropshipListingEndOpsService({ repository: new PgDropshipListingEndOpsRepository(pool),
        recovery: { async reconcile() { throw new Error("Mark resolved never asks inventory recovery."); } },
        clock: { now: () => NOW }, log: { debug: () => undefined, info: () => undefined } });
    }
    const STAFF = { actorType: "admin", actorId: "staff-1" } as const;

    it("'Ended on eBay' is a Card Shellz end: never swept; a vendor press queued before it is fenced, one made after it starts", async () => {
      const listing = await seedListing({ variant: 101, status: "active" });
      const [endId] = await seedEnds([{ listingId: listing, variant: 101, state: "failed" }]);
      const job = await seedJob();
      const before = await seedItem({ jobId: job, listingId: listing, variant: 101, vendorPress: true, createdAt: T_QUEUED_BEFORE_END });
      // While it waits for staff the end is open, so the sweep leaves it alone (I12).
      expect(await repository().listDueListingIds({ storeConnectionId: STORE, limit: 50 })).toEqual([]);

      await staff().resolve({ endRequestId: endId!, outcome: "ended_on_ebay", reason: "Ended it on eBay by hand.",
        idempotencyKey: "staff-interplay-0001", actor: STAFF });

      expect(await listingRow(listing)).toMatchObject({ status: "ended", marketplace_ended_at: null, updated_at: NOW });
      // I2: never swept after it either, so no later read can take it for the vendor's own end or reopen it.
      expect(await repository().listDueListingIds({ storeConnectionId: STORE, limit: 50 })).toEqual([]);
      expect((await repository().loadStore(STORE))?.liveListingCount).toBe(0);
      const worker = new PgDropshipListingPushWorkerRepository(pool);
      expect(await worker.markItemProcessing({ jobId: job, itemId: before, workerId: WORKER, now: NOW })).toBe("ended_since_queued");
      const laterJob = await seedJob();
      const after = await seedItem({ jobId: laterJob, listingId: listing, variant: 101, vendorPress: true,
        createdAt: new Date(NOW.getTime() + 60_000) });
      expect(await worker.markItemProcessing({ jobId: laterJob, itemId: after, workerId: WORKER, now: NOW })).toBe("started");
    }, CASE_TIMEOUT_MS);

    it("'Left on sale' closes the end: the sweep reads the listing again and the listing is left as it is", async () => {
      const listing = await seedListing({ variant: 102, status: "active" });
      const [endId] = await seedEnds([{ listingId: listing, variant: 102, state: "failed" }]);
      expect(await repository().listDueListingIds({ storeConnectionId: STORE, limit: 50 })).toEqual([]);

      await staff().resolve({ endRequestId: endId!, outcome: "left_on_sale", reason: "The vendor keeps selling it.",
        idempotencyKey: "staff-interplay-0002", actor: STAFF });

      expect(await repository().listDueListingIds({ storeConnectionId: STORE, limit: 50 })).toEqual([listing]);
      expect(await listingRow(listing)).toMatchObject({ status: "active", updated_at: T_PUSHED, marketplace_ended_at: null });
    }, CASE_TIMEOUT_MS);

    it("never writes a vendor end from a read made before the end opened: the adoption re-check refuses it", async () => {
      const live = await seedListing({ variant: 101, status: "active", listingId: READ_LISTING_ID, offerId: READ_OFFER_ID });
      // The read: eBay shows the offer withdrawn while 10 units were published, which a sweep takes for the vendor's end.
      const parsed = parseMarketplaceListingObservation({ inventoryItem: rawInventoryItem(), expectedOfferId: READ_OFFER_ID,
        offer: rawOffer({ status: "UNPUBLISHED", listing: { listingId: READ_LISTING_ID, listingStatus: "ENDED" } }) });
      if (parsed.kind !== "observed") throw new Error(parsed.reason);
      const decision = decideMarketplaceSync({ trigger: { kind: "sweep" }, read: { kind: "observed", observation: parsed.observation },
        observedAt: NOW, listing: { listingId: live, itemLabel: "Toploaders", sku: READ_SKU, externalListingId: READ_LISTING_ID,
          status: "active", issueCodes: [], marketplaceEndedAt: null, latestPublishedQuantity: 10 },
        ours: { priceCents: { baseline: 1100, attempted: [] }, fulfillmentPolicyId: { baseline: "F-1", attempted: [] },
          returnPolicyId: { baseline: "R-1", attempted: [] }, paymentPolicyId: { baseline: "P-1", attempted: [] } },
        echelon: { priceCents: 1100, fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1", unitCostCents: 700 } });
      expect(decision.status.endListing).toBe(true);
      const write: MarketplaceListingSyncWrite = { trigger: "sweep", excludeJobItemId: null, listingId: live, vendorId: VENDOR,
        storeConnectionId: STORE, productVariantId: 101, externalOfferId: READ_OFFER_ID, observedAt: NOW, expectedNewestEventId: null,
        decision, oursPriceBaseline: 1100, price: null, policies: null, observed: null, saveObservation: null, expectedObservation: null };

      // The save's end insert commits while the sweep waits for the listing (its key lock blocks the sweep's FOR UPDATE).
      const save = await pool.connect();
      try {
        await save.query("BEGIN");
        await insertListingEndRequests(save, [{ vendorId: VENDOR, storeConnectionId: STORE, listingId: live, productId: PRODUCT,
          productVariantId: 101, selectionRevisionId: REVISION }]);
        const applying = repository().applyListingSync(write);
        await waitFor(async () => (await waitingBackend("SELECT")) !== null, "the sweep's listing lock to wait on the end insert");
        await save.query("COMMIT");
        await expect(applying).rejects.toMatchObject({ code: MARKETPLACE_SYNC_CODES.observationChanged,
          context: expect.objectContaining({ listingId: live, reason: "listing_end_open", classification: "transient" }) });
      } finally {
        await save.query("ROLLBACK").catch(() => undefined);
        save.release();
      }
      expect(await listingRow(live)).toMatchObject({ status: "active", marketplace_ended_at: null });
      expect((await pool.query(`SELECT count(*)::int AS n FROM dropship.dropship_listing_sync_events WHERE listing_id = $1`, [live])).rows[0])
        .toEqual({ n: 0 });
    }, CASE_TIMEOUT_MS);

    it("leaves a listing being ended out of the sweep's health counts", async () => {
      const flagged = await seedListing({ variant: 101, status: "active", issueCodes: ["sku_changed"] });
      const count = async () => Number((await (pool as Handle).query(dialect.sqlToQuery(DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS
        .find((check) => check.code === "DROPSHIP_MARKETPLACE_LISTING_NEEDS_REVIEW")!.countSql).sql,
      dialect.sqlToQuery(DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.find((check) => check.code === "DROPSHIP_MARKETPLACE_LISTING_NEEDS_REVIEW")!
        .countSql).params)).rows[0]!.count);
      expect(await count()).toBe(1);
      await seedEnds([{ listingId: flagged, variant: 101, state: "failed" }]);
      expect(await count()).toBe(0);
    }, CASE_TIMEOUT_MS);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // §6.4: the quantity catch-up.

  describe("the quantity catch-up (§6.4)", () => {
    const scope: QuantityPublicationScope = { destinationKind: "dropship_store_connection", connectionId: STORE, providerKey: "ebay",
      providerScopeType: "account", externalScopeId: "seller-22", externalInventoryItemId: "offer:OFFER-103", productId: null,
      productVariantId: null };
    const claim = { catchupId: "3", revision: "2", attemptBoundaryId: "0", scope };

    function provider(previews: string[]) {
      return new DropshipQuantityPublicationCatchupProvider({ database: pool,
        preview: { async generatePreview() { previews.push("preview"); throw new Error("preview reached"); },
          async createListingPushJob() { throw new Error("No job may be created."); } } as never,
        worker: { async processJob() { throw new Error("No job may be processed."); } } as never,
        operations: { async retryJob() { throw new Error("No job may be retried."); } } as never });
    }

    it("refuses a listing with an open end as a changed lifecycle, before it looks for or creates a job", async () => {
      const listing = await seedListing({ variant: 103, status: "active" });
      await seedEnds([{ listingId: listing, variant: 103, state: "pending" }]);
      const previews: string[] = [];

      await expect(provider(previews).refresh(scope, claim)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_LISTING_CHANGED" });
      expect(previews).toEqual([]);

      // Without the open end the same listing goes on to its preview (the stub stops it there).
      await pool.query("UPDATE dropship.dropship_listing_end_requests SET state = 'superseded', next_attempt_at = NULL, decided_at = $2 WHERE listing_id = $1",
        [listing, NOW]);
      await expect(provider(previews).refresh(scope, claim)).rejects.toThrow("preview reached");
      expect(previews).toEqual(["preview"]);
    }, CASE_TIMEOUT_MS);
  });
});
