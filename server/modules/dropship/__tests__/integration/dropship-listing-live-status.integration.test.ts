import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateDropshipListingPushJobRepositoryInput } from "../../application/dropship-listing-preview-service";
import type {
  DropshipListingPushWorkerItemRecord,
  DropshipListingPushWorkerJobRecord,
} from "../../application/dropship-listing-push-worker-service";
import { DropshipListingPushRecoveryService } from "../../application/dropship-listing-push-recovery-service";
import { isLiveListingStatus } from "../../domain/listing-live-status";
import { PgDropshipListingPreviewRepository } from "../../infrastructure/dropship-listing-preview.repository";
import { PgDropshipListingPushWorkerRepository } from "../../infrastructure/dropship-listing-push-worker.repository";
import { PgDropshipListingPushOpsRepository } from "../../infrastructure/dropship-listing-push-ops.repository";
import { PgDropshipListingLiveStatusRepairRepository } from "../../infrastructure/dropship-listing-live-status-repair.repository";
import {
  EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE,
  EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE,
  EBAY_PUBLICATION_ENVIRONMENT_MISMATCH_MESSAGE,
} from "../../../../../shared/dropship/ebay-publication-account";

/**
 * A listing live on eBay stays orderable through a queued or failed update
 * (A), listings an earlier push demoted get their live status back (B), and
 * pushes the earlier account check refused are queued again once (C), all
 * against a real PostgreSQL: the CASE guards, the row locks, the audit rows
 * and the idempotency of re-runs are proven on the engine.
 */
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;

const QUEUED_AT = new Date("2026-10-01T10:00:00.000Z");
const NOW = new Date("2026-10-20T12:00:00.000Z");
const LATER = new Date("2026-10-20T12:05:00.000Z");
const WORKER = "worker-live-status";
const VERIFIED_STORE = 22;
const UNVERIFIED_STORE = 23;

describeDatabase.sequential("live listing status, repair and account check requeue (PostgreSQL)", () => {
  const schema = `dropship_listing_live_status_${process.pid}`;
  let pool: pg.Pool | undefined;
  let created = false;
  let scopedPool: Pool;
  const qualify = (sql: string) => sql.replaceAll("dropship.", `"${schema}".`);

  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("Live listing status tests require a distinct explicitly disposable PostgreSQL database.");
    }
    if (!/^dropship_listing_live_status_\d+$/.test(schema)) throw new Error("Invalid isolated schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 5,
      ssl: /localhost|127\.0\.0\.1/.test(testUrl) ? false : { rejectUnauthorized: false } });
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    // Owner columns and CHECKs as migrations 0086, 0094 and 0609 define them.
    await pool.query(qualify(`
      CREATE TABLE dropship.dropship_vendors (id integer PRIMARY KEY, member_id text, status varchar(30) NOT NULL DEFAULT 'active',
        entitlement_status varchar(30) NOT NULL DEFAULT 'active');
      CREATE TABLE dropship.dropship_store_connections (id integer PRIMARY KEY, vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
        platform varchar(30) NOT NULL, status varchar(30) NOT NULL DEFAULT 'connected', setup_status varchar(30) NOT NULL DEFAULT 'ready',
        access_token_ref text, refresh_token_ref text, external_account_id varchar(255), provider_environment varchar(20),
        external_account_identity_scheme varchar(40), external_account_verified_at timestamptz,
        CONSTRAINT dropship_store_conn_status_chk CHECK (status IN ('connected','needs_reauth','refresh_failed','grace_period','paused','disconnected')),
        CONSTRAINT dropship_store_connections_stable_identity_chk CHECK (
          external_account_identity_scheme IS NULL
          OR (external_account_identity_scheme = 'provider_user_id' AND external_account_id = btrim(external_account_id)
              AND external_account_id <> '' AND external_account_verified_at IS NOT NULL)));
      CREATE TABLE dropship.dropship_audit_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer, store_connection_id integer, entity_type varchar(80) NOT NULL, entity_id varchar(255),
        event_type varchar(120) NOT NULL, actor_type varchar(40) NOT NULL DEFAULT 'system', actor_id varchar(255),
        severity varchar(20) NOT NULL DEFAULT 'info', payload jsonb, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE dropship.dropship_listing_push_jobs (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer NOT NULL, store_connection_id integer NOT NULL, job_type varchar(40) NOT NULL DEFAULT 'push',
        status varchar(30) NOT NULL DEFAULT 'queued', requested_scope jsonb, requested_by varchar(255),
        idempotency_key varchar(200), request_hash text, error_message text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
        CONSTRAINT dropship_listing_job_status_chk CHECK (status IN ('queued','processing','completed','failed','cancelled')));
      CREATE TABLE dropship.dropship_vendor_listings (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer NOT NULL, store_connection_id integer NOT NULL, product_variant_id integer NOT NULL,
        platform varchar(30) NOT NULL, external_listing_id varchar(255), external_offer_id varchar(255),
        status varchar(40) NOT NULL DEFAULT 'not_listed', vendor_retail_price_cents bigint, pushed_quantity integer NOT NULL DEFAULT 0,
        quantity_cap integer, last_preview_hash varchar(128), last_pushed_at timestamptz, metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT dropship_listing_status_chk CHECK (status IN ('not_listed','preview_ready','queued','pushing','active','paused','ended','failed','blocked','drift_detected')));
      CREATE UNIQUE INDEX dropship_listing_store_variant_idx ON dropship.dropship_vendor_listings(store_connection_id, product_variant_id);
      CREATE TABLE dropship.dropship_listing_push_job_items (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id integer NOT NULL REFERENCES dropship.dropship_listing_push_jobs(id), listing_id integer REFERENCES dropship.dropship_vendor_listings(id),
        product_variant_id integer NOT NULL, action varchar(40) NOT NULL DEFAULT 'push', status varchar(30) NOT NULL DEFAULT 'queued',
        preview_hash varchar(128), external_listing_id varchar(255), error_code varchar(100), error_message text, result jsonb,
        idempotency_key varchar(200), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE dropship.dropship_listing_sync_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        listing_id integer NOT NULL REFERENCES dropship.dropship_vendor_listings(id), event_type varchar(80) NOT NULL,
        source varchar(40) NOT NULL, payload jsonb, created_at timestamptz NOT NULL DEFAULT now());
    `));
    scopedPool = {
      query: (sql: string, values?: unknown[]) => pool!.query(qualify(sql), values),
      connect: async () => {
        const client = await pool!.connect();
        return { query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values), release: () => client.release() };
      },
    } as unknown as Pool;
  });

  beforeEach(async () => {
    await pool!.query(qualify(`TRUNCATE dropship.dropship_audit_events, dropship.dropship_listing_sync_events,
      dropship.dropship_listing_push_job_items, dropship.dropship_listing_push_jobs, dropship.dropship_vendor_listings,
      dropship.dropship_store_connections, dropship.dropship_vendors RESTART IDENTITY CASCADE`));
    await pool!.query(qualify(`
      INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (10, 'member-10');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, access_token_ref, refresh_token_ref,
        external_account_id, provider_environment, external_account_identity_scheme, external_account_verified_at)
      VALUES (22, 10, 'ebay', 'access-22', 'refresh-22', 'seller-22', 'production', 'provider_user_id', '2026-10-19T00:00:00Z'),
             (23, 10, 'ebay', 'access-23', 'refresh-23', 'seller-23', 'production', NULL, NULL);
    `));
  });

  afterAll(async () => { if (created && pool) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool?.end(); });

  async function seedListing(input: {
    variantId: number; status: string; externalListingId?: string | null; storeId?: number; priceCents?: number; previewHash?: string;
  }): Promise<number> {
    const result = await pool!.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_vendor_listings
      (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id, external_offer_id,
       vendor_retail_price_cents, last_preview_hash, metadata, created_at, updated_at)
      VALUES (10, $1, $2, 'ebay', $3, $4, $5, $6, $7, '{"lastPush":{"jobId":1}}'::jsonb, $8, $8) RETURNING id`), [
      input.storeId ?? VERIFIED_STORE, input.variantId, input.status, input.externalListingId ?? null,
      input.externalListingId ? `offer-${input.variantId}` : null, input.priceCents ?? 1299, input.previewHash ?? `preview-${input.variantId}`, QUEUED_AT,
    ]);
    return result.rows[0]!.id;
  }

  let seededJobs = 0;
  async function seedJob(input: { status: string; storeId?: number; createdAt?: Date }): Promise<number> {
    const at = input.createdAt ?? QUEUED_AT;
    seededJobs += 1;
    const result = await pool!.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_listing_push_jobs
      (vendor_id, store_connection_id, status, idempotency_key, request_hash, created_at, updated_at, completed_at)
      VALUES (10, $1, $2, $3, 'hash', $4, $4, $5) RETURNING id`), [
      input.storeId ?? VERIFIED_STORE, input.status, `seed-${seededJobs}`, at,
      input.status === "failed" || input.status === "completed" ? at : null,
    ]);
    return result.rows[0]!.id;
  }

  async function seedItem(input: {
    jobId: number; listingId: number | null; variantId: number; status: string; previewHash?: string;
    errorCode?: string | null; errorMessage?: string | null; result?: Record<string, unknown>; createdAt?: Date;
  }): Promise<number> {
    const result = await pool!.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_listing_push_job_items
      (job_id, listing_id, product_variant_id, status, preview_hash, error_code, error_message, result, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9) RETURNING id`), [
      input.jobId, input.listingId, input.variantId, input.status, input.previewHash ?? `preview-${input.variantId}`,
      input.errorCode ?? null, input.errorMessage ?? null, JSON.stringify(input.result ?? { listingIntent: { listingMode: "live" } }),
      input.createdAt ?? QUEUED_AT,
    ]);
    return result.rows[0]!.id;
  }

  async function listing(id: number): Promise<{ status: string; vendor_retail_price_cents: string; last_preview_hash: string; metadata: Record<string, any> }> {
    return (await pool!.query(qualify(`SELECT status, vendor_retail_price_cents, last_preview_hash, metadata
      FROM dropship.dropship_vendor_listings WHERE id = $1`), [id])).rows[0];
  }

  async function audits(eventType: string): Promise<Array<{ entity_id: string; severity: string; actor_id: string; payload: Record<string, any> }>> {
    return (await pool!.query(qualify(`SELECT entity_id, severity, actor_id, payload FROM dropship.dropship_audit_events
      WHERE event_type = $1 ORDER BY id`), [eventType])).rows;
  }

  function jobRecord(jobId: number): DropshipListingPushWorkerJobRecord {
    return { jobId, vendorId: 10, storeConnectionId: VERIFIED_STORE, platform: "ebay", status: "processing",
      idempotencyKey: "seed", requestHash: "hash", createdAt: QUEUED_AT, updatedAt: QUEUED_AT, completedAt: null };
  }

  function itemRecord(itemId: number, jobId: number, listingId: number, variantId: number): DropshipListingPushWorkerItemRecord {
    return { itemId, jobId, listingId, productVariantId: variantId, status: "processing", previewHash: `preview-${variantId}`,
      externalListingId: null, errorCode: null, errorMessage: null, result: null, listing: null };
  }

  describe("A: a queued or failed update leaves a live listing orderable", () => {
    function previewRow(variantId: number, previewStatus: "ready" | "blocked", priceCents: number) {
      return {
        productVariantId: variantId, productId: 1, previewStatus, blockers: previewStatus === "blocked" ? ["missing_category"] : [],
        warnings: [], priceCents, marketplaceQuantity: 4, previewHash: `new-preview-${variantId}`, listingMode: "live",
        businessPolicySelection: null, listingIntent: { listingMode: "live", priceCents, productVariantId: variantId },
      };
    }

    async function queue(rows: ReturnType<typeof previewRow>[]) {
      const repository = new PgDropshipListingPreviewRepository(scopedPool);
      return repository.createListingPushJob({
        vendorId: 10, storeConnectionId: VERIFIED_STORE, platform: "ebay", productVariantIds: rows.map((row) => row.productVariantId),
        requestedRetailPricesByVariantId: {}, idempotencyKey: `queue-${rows.map((row) => row.productVariantId).join("-")}`,
        requestHash: "request-hash", requestedBy: { actorType: "vendor", actorId: "member-10" },
        preview: {
          vendorId: 10, storeConnectionId: VERIFIED_STORE, platform: "ebay", generatedAt: NOW, rows,
          summary: { total: rows.length, ready: rows.filter((row) => row.previewStatus === "ready").length,
            blocked: rows.filter((row) => row.previewStatus === "blocked").length, warning: 0 },
        },
        now: NOW,
      } as unknown as CreateDropshipListingPushJobRepositoryInput);
    }

    it("keeps a live listing's status when an update is queued, and queues a first listing as before", async () => {
      const active = await seedListing({ variantId: 101, status: "active", externalListingId: "111" });
      const paused = await seedListing({ variantId: 102, status: "paused", externalListingId: "222" });
      const neverPublished = await seedListing({ variantId: 104, status: "failed", externalListingId: null });

      const created = await queue([previewRow(101, "ready", 1499), previewRow(102, "blocked", 999), previewRow(103, "ready", 899), previewRow(104, "ready", 799)]);

      expect(created.items.map((item) => [item.productVariantId, item.status])).toEqual([[101, "queued"], [102, "blocked"], [103, "queued"], [104, "queued"]]);
      expect(await listing(active)).toMatchObject({ status: "active", last_preview_hash: "new-preview-101" });
      // A blocked preview of a draft listing changes nothing on eBay either.
      expect((await listing(paused)).status).toBe("paused");
      // Nothing is pushed for a blocked preview, so the listing keeps its price (no reader may take $9.99 as on eBay);
      // a ready preview writes the price its push will send (the push-time refresh reads it).
      expect((await listing(paused)).vendor_retail_price_cents).toBe("1299");
      expect((await listing(active)).vendor_retail_price_cents).toBe("1499");
      expect((await listing(neverPublished)).status).toBe("queued");
      const firstTime = (await pool!.query(qualify(`SELECT status FROM dropship.dropship_vendor_listings WHERE product_variant_id = 103`))).rows[0];
      expect(firstTime.status).toBe("queued");
      // Still taking orders while the update waits (the rule order acceptance and quoting use).
      expect(isLiveListingStatus((await listing(active)).status)).toBe(true);
      expect(isLiveListingStatus((await listing(paused)).status)).toBe(true);
    });

    it("keeps a live listing's status when its update fails or is blocked, and still records the failure", async () => {
      const active = await seedListing({ variantId: 101, status: "active", externalListingId: "111" });
      const paused = await seedListing({ variantId: 102, status: "paused", externalListingId: "222" });
      const firstTime = await seedListing({ variantId: 103, status: "queued", externalListingId: null });
      const job = await seedJob({ status: "processing" });
      const activeItem = await seedItem({ jobId: job, listingId: active, variantId: 101, status: "processing" });
      const pausedItem = await seedItem({ jobId: job, listingId: paused, variantId: 102, status: "queued" });
      const firstItem = await seedItem({ jobId: job, listingId: firstTime, variantId: 103, status: "processing" });
      const repository = new PgDropshipListingPushWorkerRepository(scopedPool);

      await repository.failItem({ job: jobRecord(job), item: itemRecord(activeItem, job, active, 101), code: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE,
        message: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE, retryable: false, workerId: WORKER, now: NOW });
      await repository.blockItem({ job: jobRecord(job), item: itemRecord(pausedItem, job, paused, 102), code: "DROPSHIP_LISTING_STORE_BLOCKED",
        message: "Dropship store connection is no longer launch-ready for listing push.", workerId: WORKER, now: NOW });
      await repository.failItem({ job: jobRecord(job), item: itemRecord(firstItem, job, firstTime, 103), code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
        message: "eBay listing push failed with HTTP 400", retryable: false, workerId: WORKER, now: NOW });

      const activeRow = await listing(active);
      expect(activeRow.status).toBe("active");
      expect(activeRow.metadata.lastPushError).toMatchObject({ jobItemId: activeItem, code: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE, retryable: false });
      expect((await listing(paused)).status).toBe("paused");
      expect((await listing(firstTime)).status).toBe("failed");
      // The order path's rule: a failed update of a live listing still accepts orders.
      expect(isLiveListingStatus(activeRow.status)).toBe(true);

      const syncEvents = (await pool!.query(qualify(`SELECT listing_id, event_type, payload FROM dropship.dropship_listing_sync_events ORDER BY id`))).rows;
      expect(syncEvents.map((event) => [event.listing_id, event.event_type, event.payload.listingStatus])).toEqual([
        [active, "listing_push_failed", { before: "active", after: "active" }],
        [paused, "listing_push_blocked", { before: "paused", after: "paused" }],
        [firstTime, "listing_push_failed", { before: "queued", after: "failed" }],
      ]);
      const itemAudits = [...await audits("listing_push_item_failed"), ...await audits("listing_push_item_blocked")];
      expect(itemAudits.map((audit) => audit.payload.listingStatus)).toEqual([
        { before: "active", after: "active" }, { before: "queued", after: "failed" }, { before: "paused", after: "paused" },
      ]);
      const items = (await pool!.query(qualify(`SELECT id, status FROM dropship.dropship_listing_push_job_items ORDER BY id`))).rows;
      expect(items.map((item) => item.status)).toEqual(["failed", "blocked", "failed"]);
    });

    it("keeps a live listing's status when ops retries its failed push, and queues a never-published one", async () => {
      const active = await seedListing({ variantId: 101, status: "active", externalListingId: "111" });
      const firstTime = await seedListing({ variantId: 103, status: "failed", externalListingId: null });
      const job = await seedJob({ status: "failed" });
      await seedItem({ jobId: job, listingId: active, variantId: 101, status: "failed", errorCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
        result: { listingIntent: { listingMode: "live" }, push: { retryable: true } } });
      await seedItem({ jobId: job, listingId: firstTime, variantId: 103, status: "failed", errorCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
        result: { listingIntent: { listingMode: "live" }, push: { retryable: true } } });

      const result = await new PgDropshipListingPushOpsRepository(scopedPool).retryJob({
        jobId: job, idempotencyKey: "ops-retry", actor: { actorType: "admin", actorId: "ops-1" }, reason: "eBay outage cleared", now: NOW,
      });

      expect(result).toMatchObject({ status: "queued", requeuedItemCount: 2 });
      expect((await listing(active)).status).toBe("active");
      expect((await listing(firstTime)).status).toBe("queued");
      expect((await listing(active)).metadata.lastPushRetry).toMatchObject({ jobId: job, idempotencyKey: "ops-retry" });
    });
  });

  describe("B: listings an earlier queue or failed push demoted get their live status back", () => {
    async function seedHistory() {
      // Live push completed, then an update failed (the account check bug): restore active.
      const failedLive = await seedListing({ variantId: 201, status: "failed", externalListingId: "201201" });
      // Saved as a draft by its last completed push, then an update was blocked at queue time: restore paused.
      const blockedDraft = await seedListing({ variantId: 202, status: "blocked", externalListingId: "202202" });
      // Queued over a live listing and its push is still running: left to its own outcome.
      const inFlight = await seedListing({ variantId: 203, status: "queued", externalListingId: "203203" });
      // Never published: not this repair's to touch.
      const neverPublished = await seedListing({ variantId: 204, status: "failed", externalListingId: null });
      const alreadyLive = await seedListing({ variantId: 205, status: "active", externalListingId: "205205" });
      // A marketplace id with no completed push to say which status: review, no guess.
      const unexplained = await seedListing({ variantId: 206, status: "failed", externalListingId: "206206" });
      const first = await seedJob({ status: "completed", createdAt: new Date("2026-09-01T00:00:00Z") });
      const second = await seedJob({ status: "failed" });
      const completedLive = await seedItem({ jobId: first, listingId: failedLive, variantId: 201, status: "completed",
        result: { listingIntent: { listingMode: "draft_first" }, push: { status: "updated", rawResult: { listingMode: "live" } } } });
      const failedUpdate = await seedItem({ jobId: second, listingId: failedLive, variantId: 201, status: "failed",
        errorCode: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE, errorMessage: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE });
      const completedDraft = await seedItem({ jobId: first, listingId: blockedDraft, variantId: 202, status: "completed",
        result: { listingIntent: { listingMode: "draft_first" } } });
      await seedItem({ jobId: second, listingId: blockedDraft, variantId: 202, status: "blocked", errorCode: "DROPSHIP_LISTING_PREVIEW_BLOCKED" });
      await seedItem({ jobId: first, listingId: inFlight, variantId: 203, status: "completed" });
      const running = await seedItem({ jobId: second, listingId: inFlight, variantId: 203, status: "processing" });
      await seedItem({ jobId: second, listingId: neverPublished, variantId: 204, status: "failed" });
      await seedItem({ jobId: second, listingId: unexplained, variantId: 206, status: "failed" });
      return { failedLive, blockedDraft, inFlight, neverPublished, alreadyLive, unexplained, completedLive, failedUpdate, completedDraft, running, second };
    }

    it("restores only demoted live listings, from their last completed push, with an audit row each", async () => {
      const seeded = await seedHistory();
      const repair = new PgDropshipListingLiveStatusRepairRepository(scopedPool);

      const result = await repair.restoreDemotedLiveListings({ now: NOW, workerId: WORKER, limit: 50 });

      expect(result.restored.map((row) => [row.listingId, row.previousStatus, row.status, row.basisItemId])).toEqual([
        [seeded.failedLive, "failed", "active", seeded.completedLive],
        [seeded.blockedDraft, "blocked", "paused", seeded.completedDraft],
      ]);
      expect(result.reviewRequired.map((row) => [row.listingId, row.code])).toEqual([
        [seeded.unexplained, "DROPSHIP_LISTING_LIVE_STATUS_NO_COMPLETED_PUSH"],
      ]);
      expect(result.failed).toEqual([]);
      expect((await listing(seeded.failedLive)).status).toBe("active");
      expect((await listing(seeded.failedLive)).metadata.liveStatusRepair).toMatchObject({
        state: "restored", previousStatus: "failed", status: "active", basisJobItemId: seeded.completedLive,
        latestItemId: seeded.failedUpdate, latestItemErrorCode: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE, workerId: WORKER,
      });
      expect((await listing(seeded.blockedDraft)).status).toBe("paused");
      expect((await listing(seeded.inFlight)).status).toBe("queued");
      expect((await listing(seeded.neverPublished)).status).toBe("failed");
      expect((await listing(seeded.alreadyLive)).status).toBe("active");
      expect((await listing(seeded.unexplained)).status).toBe("failed");
      expect((await listing(seeded.unexplained)).metadata.liveStatusRepair).toMatchObject({
        state: "requires_review", code: "DROPSHIP_LISTING_LIVE_STATUS_NO_COMPLETED_PUSH", status: "failed",
      });
      expect(isLiveListingStatus((await listing(seeded.failedLive)).status)).toBe(true);

      const restoredAudits = await audits("listing_live_status_restored");
      expect(restoredAudits.map((audit) => [Number(audit.entity_id), audit.severity, audit.actor_id, audit.payload.before, audit.payload.after])).toEqual([
        [seeded.failedLive, "warning", WORKER, { status: "failed" }, { status: "active" }],
        [seeded.blockedDraft, "warning", WORKER, { status: "blocked" }, { status: "paused" }],
      ]);
      expect((await audits("listing_live_status_review_required")).map((audit) => [Number(audit.entity_id), audit.severity, audit.payload.requiresReview]))
        .toEqual([[seeded.unexplained, "error", true]]);
      const syncEvents = (await pool!.query(qualify(`SELECT listing_id FROM dropship.dropship_listing_sync_events
        WHERE event_type = 'listing_live_status_restored' ORDER BY id`))).rows;
      expect(syncEvents.map((event) => event.listing_id)).toEqual([seeded.failedLive, seeded.blockedDraft]);
    });

    it("is a no-op on a re-run, and restores a skipped listing once its own push has failed", async () => {
      const seeded = await seedHistory();
      const repair = new PgDropshipListingLiveStatusRepairRepository(scopedPool);
      await repair.restoreDemotedLiveListings({ now: NOW, workerId: WORKER, limit: 50 });
      const auditCount = (await pool!.query(qualify(`SELECT count(*)::int AS n FROM dropship.dropship_audit_events`))).rows[0].n;

      const rerun = await repair.restoreDemotedLiveListings({ now: LATER, workerId: WORKER, limit: 50 });
      expect(rerun).toEqual({ restored: [], reviewRequired: [], failed: [], skipped: 0 });
      expect((await pool!.query(qualify(`SELECT count(*)::int AS n FROM dropship.dropship_audit_events`))).rows[0].n).toBe(auditCount);

      // The running push ends in a failure the old code demoted: the next pass restores the listing.
      await pool!.query(qualify(`UPDATE dropship.dropship_listing_push_job_items SET status = 'failed' WHERE id = $1`), [seeded.running]);
      await pool!.query(qualify(`UPDATE dropship.dropship_vendor_listings SET status = 'failed' WHERE id = $1`), [seeded.inFlight]);
      const later = await repair.restoreDemotedLiveListings({ now: LATER, workerId: WORKER, limit: 50 });
      expect(later.restored.map((row) => [row.listingId, row.status])).toEqual([[seeded.inFlight, "active"]]);
    });

    it("leaves a row another transaction holds for the next pass", async () => {
      const seeded = await seedHistory();
      const holder = await pool!.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(qualify(`SELECT id FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE`), [seeded.failedLive]);
        const result = await new PgDropshipListingLiveStatusRepairRepository(scopedPool)
          .restoreDemotedLiveListings({ now: NOW, workerId: WORKER, limit: 50 });
        expect(result.restored.map((row) => row.listingId)).toEqual([seeded.blockedDraft]);
        expect(result.skipped).toBe(1);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      expect((await listing(seeded.failedLive)).status).toBe("failed");
    });

    it("restores a listing an older push blocked after the newest completed push (write order, not id order)", async () => {
      const listingId = await seedListing({ variantId: 207, status: "blocked", externalListingId: "207207" });
      const oldJob = await seedJob({ status: "failed", createdAt: new Date("2026-09-01T00:00:00Z") });
      const newJob = await seedJob({ status: "completed", createdAt: new Date("2026-09-02T00:00:00Z") });
      const older = await seedItem({ jobId: oldJob, listingId, variantId: 207, status: "blocked", errorCode: "DROPSHIP_LISTING_PREVIEW_DRIFT",
        createdAt: new Date("2026-09-01T00:00:00Z") });
      const completed = await seedItem({ jobId: newJob, listingId, variantId: 207, status: "completed",
        result: { listingIntent: { listingMode: "live" }, push: { rawResult: { listingMode: "live" } } }, createdAt: new Date("2026-09-02T00:00:00Z") });
      // A retry of the old job ran after the newer push completed and blocked on preview drift, writing 'blocked' over 'active'.
      await pool!.query(qualify(`UPDATE dropship.dropship_listing_push_job_items SET updated_at = $2 WHERE id = $1`), [older, new Date("2026-09-03T00:00:00Z")]);
      expect(older).toBeLessThan(completed);

      const result = await new PgDropshipListingLiveStatusRepairRepository(scopedPool).restoreDemotedLiveListings({ now: NOW, workerId: WORKER, limit: 50 });

      expect(result.reviewRequired).toEqual([]);
      expect(result.restored.map((row) => [row.listingId, row.previousStatus, row.status, row.basisItemId, row.latestItemId]))
        .toEqual([[listingId, "blocked", "active", completed, older]]);
      expect((await listing(listingId)).status).toBe("active");
    });
  });

  describe("C: pushes the earlier account check refused are queued again once", () => {
    async function seedAccountFailure(input: {
      variantId: number; storeId?: number; message?: string; externalListingId?: string | null; listingStatus?: string;
      itemPreviewHash?: string; code?: string; failedAt?: Date;
    }) {
      const listingId = await seedListing({ variantId: input.variantId, status: input.listingStatus ?? "failed",
        externalListingId: input.externalListingId === undefined ? `${input.variantId}000` : input.externalListingId, storeId: input.storeId });
      const completedJob = await seedJob({ status: "completed", storeId: input.storeId, createdAt: new Date("2026-09-01T00:00:00Z") });
      await seedItem({ jobId: completedJob, listingId, variantId: input.variantId, status: "completed",
        result: { listingIntent: { listingMode: "live" }, push: { rawResult: { listingMode: "live" } } } });
      const jobId = await seedJob({ status: "failed", storeId: input.storeId });
      const itemId = await seedItem({ jobId, listingId, variantId: input.variantId, status: "failed", previewHash: input.itemPreviewHash,
        errorCode: input.code ?? EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE, errorMessage: input.message ?? EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE,
        result: { listingIntent: { listingMode: "live" }, push: { status: "failed", retryable: false,
          ...(input.failedAt ? { processedAt: input.failedAt.toISOString() } : {}) } } });
      if (input.failedAt) {
        await pool!.query(qualify(`UPDATE dropship.dropship_listing_push_job_items SET updated_at = $2 WHERE id = $1`), [itemId, input.failedAt]);
      }
      return { listingId, jobId, itemId };
    }

    /** The requeued push ran again and was refused the same way (for example on a dyno still running the old reader). */
    async function refail(target: { jobId: number; itemId: number }, code = EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE,
      message = EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE): Promise<void> {
      await pool!.query(qualify(`UPDATE dropship.dropship_listing_push_job_items SET status = 'failed', error_code = $2, error_message = $3 WHERE id = $1`),
        [target.itemId, code, message]);
      await pool!.query(qualify(`UPDATE dropship.dropship_listing_push_jobs SET status = 'failed' WHERE id = $1`), [target.jobId]);
    }

    async function item(id: number): Promise<{ status: string; error_code: string | null; error_message: string | null; result: Record<string, any> }> {
      return (await pool!.query(qualify(`SELECT status, error_code, error_message, result FROM dropship.dropship_listing_push_job_items WHERE id = $1`), [id])).rows[0];
    }

    async function job(id: number): Promise<{ status: string; completed_at: Date | null; error_message: string | null }> {
      return (await pool!.query(qualify(`SELECT status, completed_at, error_message FROM dropship.dropship_listing_push_jobs WHERE id = $1`), [id])).rows[0];
    }

    it("requeues only the account check's refusals for live listings on stores verified now, once, with the retry audit", async () => {
      // Failed after the store was verified (2026-10-19): the earlier account check misread it.
      const target = await seedAccountFailure({ variantId: 301, listingStatus: "active", failedAt: new Date("2026-10-19T12:00:00Z") });
      const envMismatch = await seedAccountFailure({ variantId: 302, message: EBAY_PUBLICATION_ENVIRONMENT_MISMATCH_MESSAGE });
      const unverified = await seedAccountFailure({ variantId: 303, storeId: UNVERIFIED_STORE });
      const firstPush = await seedAccountFailure({ variantId: 304, externalListingId: null });
      const superseded = await seedAccountFailure({ variantId: 305 });
      const newerJob = await seedJob({ status: "queued" });
      await seedItem({ jobId: newerJob, listingId: superseded.listingId, variantId: 305, status: "queued" });
      const drifted = await seedAccountFailure({ variantId: 306, itemPreviewHash: "older-preview" });
      const ops = new PgDropshipListingPushOpsRepository(scopedPool);

      const result = await ops.requeueAccountVerificationFailures({ now: NOW, workerId: WORKER, limit: 50 });

      expect(result.failed).toEqual([]);
      expect(result.requeued).toEqual([{ jobId: target.jobId, vendorId: 10, storeConnectionId: VERIFIED_STORE, itemIds: [target.itemId],
        listingIds: [target.listingId], idempotencyKey: `dropship-listing-push:account-check-recovery:job:${target.jobId}`,
        items: [{ itemId: target.itemId, errorCode: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE, basis: "verified_before_failure", attempt: 1 }] }]);
      expect(await item(target.itemId)).toMatchObject({ status: "queued", error_code: null, error_message: null,
        result: { schemeRecovery: { requeuedAt: NOW.toISOString(), workerId: WORKER, previousErrorCode: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE },
          lastRetryRequest: { actorType: "system", actorId: WORKER } } });
      expect(await job(target.jobId)).toEqual({ status: "queued", completed_at: null, error_message: null });
      // The listing stays live (and orderable) while its push is queued again.
      expect((await listing(target.listingId)).status).toBe("active");
      for (const untouched of [envMismatch, unverified, firstPush, superseded, drifted]) {
        expect((await item(untouched.itemId)).status).toBe("failed");
        expect((await job(untouched.jobId)).status).toBe("failed");
      }
      const retryAudits = await audits("listing_push_job_retry_requested");
      expect(retryAudits.map((audit) => [Number(audit.entity_id), audit.actor_id, audit.payload.recovery, audit.payload.previousStatus,
        audit.payload.requeuedItemCount, audit.payload.itemIds])).toEqual([[target.jobId, WORKER, "ebay_account_identity_scheme", "failed", 1, [target.itemId]]]);
      // The audit states what is true either way, and records whether the store was verified before the push failed.
      expect(retryAudits[0]!.payload.reason).toBe("Queued again automatically: this store's eBay identity is verified now.");
      expect(retryAudits[0]!.payload.items).toEqual([{ itemId: target.itemId, errorCode: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE,
        basis: "verified_before_failure", attempt: 1 }]);
      expect((await item(target.itemId)).result.schemeRecovery).toMatchObject({ attempts: 1, basis: "verified_before_failure" });

      // Re-run with no new failure: nothing more.
      expect(await ops.requeueAccountVerificationFailures({ now: LATER, workerId: WORKER, limit: 50 })).toEqual({ requeued: [], failed: [] });
      // A dyno still running the old reader refuses it the same way again: queued again, three times in all.
      for (const attempt of [2, 3]) {
        await refail(target);
        const again = await ops.requeueAccountVerificationFailures({ now: LATER, workerId: WORKER, limit: 50 });
        expect(again.requeued.map((row) => [row.itemIds, row.idempotencyKey]))
          .toEqual([[[target.itemId], `dropship-listing-push:account-check-recovery:job:${target.jobId}:attempt:${attempt}`]]);
        expect((await item(target.itemId)).result.schemeRecovery).toMatchObject({ attempts: attempt, firstRequeuedAt: NOW.toISOString() });
      }
      // Refused a fourth time: no more automatic requeues; marked for a human, with an audit row.
      await refail(target);
      const exhausted = await ops.requeueAccountVerificationFailures({ now: LATER, workerId: WORKER, limit: 50 });
      expect(exhausted.requeued).toEqual([]);
      expect(exhausted.failed).toEqual([{ entity: "dropship_listing_push_job", entityId: target.jobId,
        code: "DROPSHIP_LISTING_PUSH_RECOVERY_REQUEUES_EXHAUSTED", message: expect.any(String), classification: "permanent", markedForReview: true }]);
      expect((await item(target.itemId))).toMatchObject({ status: "failed", result: { schemeRecovery: { state: "requires_review", attempts: 3 } } });
      expect((await audits("listing_push_recovery_review_required")).map((audit) => [Number(audit.entity_id), audit.severity, audit.payload.itemIds]))
        .toEqual([[target.jobId, "error", [target.itemId]]]);
      expect(await ops.requeueAccountVerificationFailures({ now: LATER, workerId: WORKER, limit: 50 })).toEqual({ requeued: [], failed: [] });
      expect(await audits("listing_push_job_retry_requested")).toHaveLength(3);
    });

    it("requeues a store's refusals once it is verified, and only the account check's items of a mixed job", async () => {
      const waiting = await seedAccountFailure({ variantId: 311, storeId: UNVERIFIED_STORE });
      const otherListing = await seedListing({ variantId: 312, status: "failed", externalListingId: "312000", storeId: UNVERIFIED_STORE });
      const otherItem = await seedItem({ jobId: waiting.jobId, listingId: otherListing, variantId: 312, status: "failed",
        errorCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", errorMessage: "eBay listing push failed with HTTP 400",
        result: { listingIntent: { listingMode: "live" }, push: { retryable: false } } });
      const ops = new PgDropshipListingPushOpsRepository(scopedPool);
      expect((await ops.requeueAccountVerificationFailures({ now: NOW, workerId: WORKER, limit: 50 })).requeued).toEqual([]);

      // The vendor reconnects: Settings writes the verified identity (dropship-store-connection repository updateConnection).
      await pool!.query(qualify(`UPDATE dropship.dropship_store_connections SET external_account_identity_scheme = 'provider_user_id',
        external_account_verified_at = $2 WHERE id = $1`), [UNVERIFIED_STORE, NOW]);
      const result = await ops.requeueAccountVerificationFailures({ now: LATER, workerId: WORKER, limit: 50 });

      expect(result.requeued.map((row) => [row.jobId, row.itemIds])).toEqual([[waiting.jobId, [waiting.itemId]]]);
      // A genuine refusal (no verified identity at the time), queued again after the vendor reconnected.
      expect((await audits("listing_push_job_retry_requested"))[0]!.payload.items)
        .toEqual([{ itemId: waiting.itemId, errorCode: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE, basis: "verified_after_failure", attempt: 1 }]);
      expect((await item(waiting.itemId)).status).toBe("queued");
      expect((await item(otherItem)).status).toBe("failed");
      expect((await job(waiting.jobId)).status).toBe("queued");
      // A demoted listing not yet restored shows queued, as an ops retry shows it.
      expect((await listing(waiting.listingId)).status).toBe("queued");
    });

    it("runs restore then requeue in one recovery pass: the listing is live again and its push queued", async () => {
      const target = await seedAccountFailure({ variantId: 321 });
      const logs: string[] = [];
      const recovery = new DropshipListingPushRecoveryService({
        liveStatusRepair: new PgDropshipListingLiveStatusRepairRepository(scopedPool),
        accountVerificationRequeue: new PgDropshipListingPushOpsRepository(scopedPool),
        clock: { now: () => NOW },
        logger: { info: (event) => logs.push(event.code), warn: (event) => logs.push(event.code), error: (event) => logs.push(event.code) },
      });

      const result = await recovery.run({ workerId: WORKER });

      expect(result).toMatchObject({ listingsRestored: 1, jobsRequeued: 1, itemsRequeued: 1, rowFailures: 0, stepFailures: 0 });
      expect((await listing(target.listingId)).status).toBe("active");
      expect((await item(target.itemId)).status).toBe("queued");
      expect(logs).toEqual(["DROPSHIP_LISTING_LIVE_STATUS_RESTORED", "DROPSHIP_LISTING_PUSH_ACCOUNT_CHECK_REQUEUED"]);
      // A second pass changes nothing.
      expect(await recovery.run({ workerId: WORKER })).toMatchObject({ listingsRestored: 0, jobsRequeued: 0 });
    });

    it("requeues a stock-gate refusal for an unverified eBay identity once the store is verified", async () => {
      const gate = await seedAccountFailure({ variantId: 331, storeId: UNVERIFIED_STORE, code: "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED",
        message: "Provider-verified eBay store identity is required before publishing quantity." });
      const ops = new PgDropshipListingPushOpsRepository(scopedPool);
      expect((await ops.requeueAccountVerificationFailures({ now: NOW, workerId: WORKER, limit: 50 })).requeued).toEqual([]);

      await pool!.query(qualify(`UPDATE dropship.dropship_store_connections SET external_account_identity_scheme = 'provider_user_id',
        external_account_verified_at = $2 WHERE id = $1`), [UNVERIFIED_STORE, NOW]);
      const result = await ops.requeueAccountVerificationFailures({ now: LATER, workerId: WORKER, limit: 50 });

      expect(result.requeued.map((row) => [row.jobId, row.itemIds])).toEqual([[gate.jobId, [gate.itemId]]]);
      expect((await item(gate.itemId)).status).toBe("queued");
      expect((await audits("listing_push_job_retry_requested"))[0]!.payload.items)
        .toEqual([{ itemId: gate.itemId, errorCode: "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED", basis: "verified_after_failure", attempt: 1 }]);
    });

    it("leaves refusals the worker would only block again: vendor not active or not entitled, store not connected, not ready or without a refresh token, or a newer item for the same store and size", async () => {
      await pool!.query(qualify(`
        INSERT INTO dropship.dropship_vendors (id, member_id, status, entitlement_status) VALUES (11, 'member-11', 'paused', 'active'),
          (12, 'member-12', 'active', 'inactive');
        INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, setup_status, access_token_ref, refresh_token_ref,
          external_account_id, provider_environment, external_account_identity_scheme, external_account_verified_at)
        VALUES (31, 11, 'ebay', 'connected', 'ready', 'a', 'r', 'seller-31', 'production', 'provider_user_id', '2026-10-19T00:00:00Z'),
               (32, 12, 'ebay', 'connected', 'ready', 'a', 'r', 'seller-32', 'production', 'provider_user_id', '2026-10-19T00:00:00Z'),
               (33, 10, 'ebay', 'needs_reauth', 'ready', 'a', 'r', 'seller-33', 'production', 'provider_user_id', '2026-10-19T00:00:00Z'),
               (34, 10, 'ebay', 'connected', 'attention_required', 'a', 'r', 'seller-34', 'production', 'provider_user_id', '2026-10-19T00:00:00Z'),
               (35, 10, 'ebay', 'connected', 'ready', 'a', NULL, 'seller-35', 'production', 'provider_user_id', '2026-10-19T00:00:00Z');
      `));
      const seedFor = async (vendorId: number, storeId: number, variantId: number) => {
        const listingId = (await pool!.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_vendor_listings
          (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id, last_preview_hash)
          VALUES ($1, $2, $3, 'ebay', 'active', $4, $5) RETURNING id`), [vendorId, storeId, variantId, `${variantId}000`, `preview-${variantId}`])).rows[0]!.id;
        const jobId = (await pool!.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_listing_push_jobs
          (vendor_id, store_connection_id, status, idempotency_key, created_at, updated_at) VALUES ($1, $2, 'failed', $3, $4, $4) RETURNING id`),
          [vendorId, storeId, `predicate-${variantId}`, QUEUED_AT])).rows[0]!.id;
        const itemId = await seedItem({ jobId, listingId, variantId, status: "failed", errorCode: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE,
          errorMessage: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE, result: { listingIntent: { listingMode: "live" }, push: { retryable: false } } });
        return { listingId, jobId, itemId };
      };
      const vendorPaused = await seedFor(11, 31, 341);
      const vendorUnentitled = await seedFor(12, 32, 342);
      const storeNeedsReauth = await seedFor(10, 33, 343);
      const storeNotReady = await seedFor(10, 34, 344);
      const storeNoRefreshToken = await seedFor(10, 35, 345);
      // A newer item for the same store and size on no listing row (a row the preview could not attach).
      const sameSize = await seedAccountFailure({ variantId: 346 });
      const newerJob = await seedJob({ status: "failed" });
      await seedItem({ jobId: newerJob, listingId: null, variantId: 346, status: "failed", errorCode: "DROPSHIP_LISTING_RECORD_REQUIRED" });

      const result = await new PgDropshipListingPushOpsRepository(scopedPool).requeueAccountVerificationFailures({ now: NOW, workerId: WORKER, limit: 50 });

      expect(result).toEqual({ requeued: [], failed: [] });
      for (const untouched of [vendorPaused, vendorUnentitled, storeNeedsReauth, storeNotReady, storeNoRefreshToken, sameSize]) {
        expect((await item(untouched.itemId)).status).toBe("failed");
        expect((await job(untouched.jobId)).status).toBe("failed");
      }
    });

    it("marks a job whose requeue fails for good for review, with an audit row in the same transaction, and never tries it again", async () => {
      const target = await seedAccountFailure({ variantId: 351 });
      await pool!.query(qualify(`
        CREATE FUNCTION dropship.refuse_recovery_job_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RAISE EXCEPTION 'refused by test' USING ERRCODE = '23514'; END $fn$;
        CREATE TRIGGER refuse_recovery_job_update BEFORE UPDATE ON dropship.dropship_listing_push_jobs
          FOR EACH ROW WHEN (NEW.id = ${target.jobId}) EXECUTE FUNCTION dropship.refuse_recovery_job_update();
      `));
      const ops = new PgDropshipListingPushOpsRepository(scopedPool);
      try {
        const result = await ops.requeueAccountVerificationFailures({ now: NOW, workerId: WORKER, limit: 50 });
        expect(result.requeued).toEqual([]);
        expect(result.failed).toEqual([{ entity: "dropship_listing_push_job", entityId: target.jobId, code: "23514", message: "refused by test",
          classification: "permanent", markedForReview: true }]);
      } finally {
        await pool!.query(qualify(`DROP TRIGGER refuse_recovery_job_update ON dropship.dropship_listing_push_jobs;
          DROP FUNCTION dropship.refuse_recovery_job_update();`));
      }
      expect(await item(target.itemId)).toMatchObject({ status: "failed", result: { schemeRecovery: { state: "requires_review", code: "23514" } } });
      const review = await audits("listing_push_recovery_review_required");
      expect(review.map((audit) => [Number(audit.entity_id), audit.severity, audit.actor_id, audit.payload])).toEqual([[target.jobId, "error", WORKER,
        { requiresReview: true, jobId: target.jobId, itemIds: [target.itemId], code: "23514", message: "refused by test", recovery: "ebay_account_identity_scheme" }]]);
      // The trigger is gone, but a row marked for review is never retried automatically.
      expect(await ops.requeueAccountVerificationFailures({ now: LATER, workerId: WORKER, limit: 50 })).toEqual({ requeued: [], failed: [] });
      expect((await item(target.itemId)).status).toBe("failed");
    });
  });

  describe("D: a stock-setup refusal is re-driven only by a person", () => {
    it("lets an ops admin queue again an item Card Shellz had to set up, but not the automatic catch-up", async () => {
      const listingId = await seedListing({ variantId: 401, status: "active", externalListingId: "401000" });
      const jobId = await seedJob({ status: "failed" });
      const itemId = await seedItem({ jobId, listingId, variantId: 401, status: "failed", errorCode: "PUBLICATION_LISTING_TARGET_UNMAPPED",
        errorMessage: "No exact canonical stock target maps this listing.",
        result: { listingIntent: { listingMode: "live" }, push: { retryable: false, context: { classification: "permanent", requiresReview: true } } } });
      const ops = new PgDropshipListingPushOpsRepository(scopedPool);

      // The legacy catch-up retries as the system: still refused, so it never re-pushes a permanent refusal by itself.
      await expect(ops.retryJob({ jobId, idempotencyKey: "catchup-retry", actor: { actorType: "system", actorId: "inventory_publication_catchup" },
        reason: "catch-up", now: NOW })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_OPS_JOB_NOT_RETRYABLE" });
      expect((await pool!.query(qualify(`SELECT status FROM dropship.dropship_listing_push_job_items WHERE id = $1`), [itemId])).rows[0].status).toBe("failed");

      // Once stock updates are set up, an admin retries the job: the dead-lettered item is queued again.
      const result = await ops.retryJob({ jobId, idempotencyKey: "ops-redrive", actor: { actorType: "admin", actorId: "ops-1" },
        reason: "Stock mapping set up", now: LATER });
      expect(result).toMatchObject({ status: "queued", requeuedItemCount: 1 });
      expect((await pool!.query(qualify(`SELECT status FROM dropship.dropship_listing_push_job_items WHERE id = $1`), [itemId])).rows[0].status).toBe("queued");
      expect((await listing(listingId)).status).toBe("active");
    });
  });
});
