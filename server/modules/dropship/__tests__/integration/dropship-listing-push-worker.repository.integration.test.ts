import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipMarketplaceListingIntent } from "../../application/dropship-marketplace-listing-provider";
import { PgDropshipListingPushJobQueueRepository } from "../../infrastructure/dropship-listing-push-job-runner";
import { PgDropshipListingPushWorkerRepository } from "../../infrastructure/dropship-listing-push-worker.repository";
import { listingPushRunsMigrationSql } from "../fixtures/listing-push-runs.fixture";
import { ebaySyncBackListingColumnsSql } from "../fixtures/ebay-sync-back.fixture";

/**
 * The worker repository against a real PostgreSQL: claim, item outcome and
 * finalize are separate transactions, and the job's status must follow its
 * items once the worker is done with them.
 */
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;
const NOW = new Date("2026-09-29T01:00:00.000Z");
const WORKER = "worker-test";

describeDatabase.sequential("listing push worker repository (PostgreSQL)", () => {
  const schema = `dropship_listing_push_worker_${process.pid}`;
  let pool: pg.Pool | undefined;
  let repository: PgDropshipListingPushWorkerRepository;
  let queue: PgDropshipListingPushJobQueueRepository;
  let created = false;
  // The real publish runs migration runs here too, so the worker reads the job columns production has.
  const qualify = (sql: string) => sql.replaceAll("dropship.", `"${schema}".`).replaceAll("catalog.", `"${schema}".`);

  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("Listing push worker tests require a distinct explicitly disposable PostgreSQL database.");
    }
    if (!/^dropship_listing_push_worker_\d+$/.test(schema)) throw new Error("Invalid isolated schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 5,
      ssl: /localhost|127\.0\.0\.1/.test(testUrl) ? false : { rejectUnauthorized: false } });
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    await pool.query(qualify(`
      CREATE TABLE dropship.dropship_vendors (id integer PRIMARY KEY, member_id text, status text NOT NULL DEFAULT 'active',
        entitlement_status text NOT NULL DEFAULT 'entitled');
      CREATE TABLE dropship.dropship_store_connections (id integer PRIMARY KEY, vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
        platform text NOT NULL, status text NOT NULL DEFAULT 'connected', setup_status text NOT NULL DEFAULT 'ready',
        access_token_ref text, refresh_token_ref text);
      CREATE UNIQUE INDEX worker_store_owner_idx ON dropship.dropship_store_connections (id, vendor_id);
      CREATE TABLE dropship.dropship_vendor_selection_rule_set_revisions (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer NOT NULL);
      CREATE TABLE catalog.product_variants (id integer PRIMARY KEY);
      INSERT INTO catalog.product_variants (id) VALUES (101);
      CREATE TABLE dropship.dropship_store_listing_configs (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id), platform varchar(30) NOT NULL,
        listing_mode varchar(40) NOT NULL, inventory_mode varchar(40) NOT NULL DEFAULT 'managed_quantity_sync',
        price_mode varchar(40) NOT NULL DEFAULT 'vendor_defined', marketplace_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        required_config_keys jsonb NOT NULL DEFAULT '[]'::jsonb, required_product_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
        is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
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
      CREATE TABLE dropship.dropship_listing_push_job_items (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id integer NOT NULL REFERENCES dropship.dropship_listing_push_jobs(id), listing_id integer REFERENCES dropship.dropship_vendor_listings(id),
        product_variant_id integer NOT NULL, action varchar(40) NOT NULL DEFAULT 'push', status varchar(30) NOT NULL DEFAULT 'queued',
        preview_hash varchar(128), external_listing_id varchar(255), error_code varchar(100), error_message text, result jsonb,
        idempotency_key varchar(200), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE dropship.dropship_listing_sync_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        listing_id integer NOT NULL REFERENCES dropship.dropship_vendor_listings(id), event_type varchar(80) NOT NULL,
        source varchar(40) NOT NULL, payload jsonb, created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (10, 'member-1');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, access_token_ref, refresh_token_ref)
        VALUES (22, 10, 'ebay', 'access-ref', 'refresh-ref');
      INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode) VALUES (22, 'ebay', 'live');
    `));
    await pool.query(qualify(listingPushRunsMigrationSql()));
    // The eBay sync-back listing columns a completed push writes (plan v4 §5 step 7), from the real migration.
    await pool.query(qualify(ebaySyncBackListingColumnsSql()));
    const scopedPool = {
      query: (sql: string, values?: unknown[]) => pool!.query(qualify(sql), values),
      connect: async () => {
        const client = await pool!.connect();
        return { query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values), release: () => client.release() };
      },
    } as unknown as Pool;
    repository = new PgDropshipListingPushWorkerRepository(scopedPool);
    queue = new PgDropshipListingPushJobQueueRepository(scopedPool);
  });

  beforeEach(async () => {
    await pool!.query(qualify(`TRUNCATE dropship.dropship_audit_events, dropship.dropship_listing_push_jobs,
      dropship.dropship_vendor_listings, dropship.dropship_listing_push_job_items, dropship.dropship_listing_sync_events,
      dropship.dropship_listing_push_run_targets, dropship.dropship_listing_push_runs RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => { if (created && pool) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool?.end(); });

  async function seedJob(input: { jobStatus: "queued" | "processing"; itemStatus: "queued" | "failed" | "processing"; updatedAt?: Date }): Promise<{ jobId: number; itemId: number; listingId: number }> {
    const listing = await pool!.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_vendor_listings
      (vendor_id, store_connection_id, product_variant_id, platform, status) VALUES (10, 22, 101, 'ebay', 'queued') RETURNING id`));
    const job = await pool!.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_listing_push_jobs
      (vendor_id, store_connection_id, status, idempotency_key, request_hash, created_at, updated_at)
      VALUES (10, 22, $1, 'queue-1', 'hash-1', $2, $2) RETURNING id`), [input.jobStatus, input.updatedAt ?? NOW]);
    const item = await pool!.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_listing_push_job_items
      (job_id, listing_id, product_variant_id, status, preview_hash, error_code, error_message, result)
      VALUES ($1, $2, 101, $3, 'preview-1', $4, $5, $6::jsonb) RETURNING id`), [
      job.rows[0]!.id, listing.rows[0]!.id, input.itemStatus,
      input.itemStatus === "failed" ? "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR" : null,
      input.itemStatus === "failed" ? "eBay listing push failed with HTTP 404: 25713 This Offer is not available." : null,
      JSON.stringify({ listingIntent: intent(), ...(input.itemStatus === "failed" ? { push: { status: "failed", retryable: false } } : {}) }),
    ]);
    return { jobId: job.rows[0]!.id, itemId: item.rows[0]!.id, listingId: listing.rows[0]!.id };
  }

  function intent(): DropshipMarketplaceListingIntent {
    return { quantity: 3, priceCents: 1299, listingMode: "live" } as unknown as DropshipMarketplaceListingIntent;
  }

  async function jobRow(jobId: number): Promise<{ status: string; completed_at: Date | null; error_message: string | null }> {
    const result = await pool!.query(qualify(`SELECT status, completed_at, error_message FROM dropship.dropship_listing_push_jobs WHERE id = $1`), [jobId]);
    return result.rows[0];
  }

  it("completes the job once its only item is pushed", async () => {
    const seeded = await seedJob({ jobStatus: "queued", itemStatus: "queued" });
    const claim = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-1", now: NOW });
    expect(claim.claimed).toBe(true);
    expect(claim.job.status).toBe("processing");
    expect(claim.items).toHaveLength(1);

    expect(await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: NOW, workerId: WORKER })).toBe(true);
    const completed = await repository.completeItem({
      job: claim.job, item: claim.items[0]!, intent: intent(), workerId: WORKER, now: NOW,
      pushResult: { status: "created", externalListingId: "123456789012", externalOfferId: "offer-1",
        rawResult: { provider: "ebay", marketplaceId: "EBAY_US", listingMode: "live", published: true } },
    });
    expect(completed.status).toBe("completed");
    expect(completed.externalListingId).toBe("123456789012");

    const finalized = await repository.finalizeJob({ jobId: seeded.jobId, workerId: WORKER, now: NOW });
    expect(finalized.job.status).toBe("completed");
    expect(finalized.summary).toMatchObject({ total: 1, completed: 1, failed: 0 });
    expect(await jobRow(seeded.jobId)).toEqual({ status: "completed", completed_at: NOW, error_message: null });

    const listing = await pool!.query(qualify(`SELECT status, external_listing_id, external_offer_id, pushed_quantity, vendor_retail_price_cents
      FROM dropship.dropship_vendor_listings WHERE id = $1`), [seeded.listingId]);
    expect(listing.rows[0]).toEqual({ status: "active", external_listing_id: "123456789012", external_offer_id: "offer-1", pushed_quantity: 3, vendor_retail_price_cents: "1299" });
  });

  it("fails the job once its only item failed, keeping the marketplace's reason on the item", async () => {
    const seeded = await seedJob({ jobStatus: "queued", itemStatus: "queued" });
    const claim = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-2", now: NOW });
    await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: NOW, workerId: WORKER });
    const failed = await repository.failItem({
      job: claim.job, item: claim.items[0]!, code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      message: "eBay listing push failed with HTTP 404: 25713 This Offer is not available.", retryable: false,
      providerErrors: [{ errorId: 25713, message: "This Offer is not available." }], endpoint: "GET /sell/inventory/v1/offer?sku=SKU-101&marketplace_id=EBAY_US",
      workerId: WORKER, now: NOW,
    });
    expect(failed.status).toBe("failed");
    expect(failed.result).toMatchObject({ push: { status: "failed", retryable: false, endpoint: "GET /sell/inventory/v1/offer?sku=SKU-101&marketplace_id=EBAY_US" } });

    const finalized = await repository.finalizeJob({ jobId: seeded.jobId, workerId: WORKER, now: NOW });
    expect(finalized.job.status).toBe("failed");
    expect(await jobRow(seeded.jobId)).toEqual({ status: "failed", completed_at: NOW, error_message: "One or more listing push items failed or were blocked." });
  });

  it("finalizes a stale processing job whose item already failed instead of leaving it processing", async () => {
    const stale = new Date(NOW.getTime() - 31 * 60_000);
    const seeded = await seedJob({ jobStatus: "processing", itemStatus: "failed", updatedAt: stale });
    const claim = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-3", now: NOW, staleProcessingMinutes: 30 });
    expect(claim.claimed).toBe(true);
    expect(claim.items.map((item) => item.status)).toEqual(["failed"]);

    const finalized = await repository.finalizeJob({ jobId: seeded.jobId, workerId: WORKER, now: NOW });
    expect(finalized.job.status).toBe("failed");
    expect((await jobRow(seeded.jobId)).status).toBe("failed");
  });

  it("refuses to claim a job that another worker is still processing", async () => {
    const seeded = await seedJob({ jobStatus: "processing", itemStatus: "queued", updatedAt: NOW });
    await expect(repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-4", now: NOW, staleProcessingMinutes: 30 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_JOB_ALREADY_PROCESSING" });
  });
  it("claims a job an older release wrote without the run columns: no run, no pauses", async () => {
    const seeded = await seedJob({ jobStatus: "queued", itemStatus: "queued" });
    const claim = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-5", now: NOW });
    expect(claim.job).toMatchObject({ jobId: seeded.jobId, status: "processing", runId: null, consecutivePauseCount: 0 });
  });

  it("moves the job's heartbeat when an item starts, so a long job is not taken for stale", async () => {
    const seeded = await seedJob({ jobStatus: "queued", itemStatus: "queued" });
    await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-6", now: NOW });
    const later = new Date(NOW.getTime() + 29 * 60_000);
    expect(await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: later, workerId: WORKER })).toBe(true);
    const job = await pool!.query(qualify("SELECT status, updated_at FROM dropship.dropship_listing_push_jobs WHERE id = $1"), [seeded.jobId]);
    expect(job.rows[0]).toEqual({ status: "processing", updated_at: later });
    // 40 minutes after the claim, 11 after the heartbeat: still running, not stale.
    await expect(repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-7",
      now: new Date(NOW.getTime() + 40 * 60_000), staleProcessingMinutes: 30 })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_JOB_ALREADY_PROCESSING" });
    expect(await queue.listClaimableJobIds({ limit: 10, now: new Date(NOW.getTime() + 40 * 60_000), staleAfterMinutes: 30 })).toEqual([]);
    // 31 minutes after the last heartbeat: stale, and recovery puts the item being sent back in the queue.
    const stale = new Date(later.getTime() + 31 * 60_000);
    expect(await queue.listClaimableJobIds({ limit: 10, now: stale, staleAfterMinutes: 30 })).toEqual([seeded.jobId]);
    const recovered = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-8", now: stale, staleProcessingMinutes: 30 });
    expect(recovered.claimed).toBe(true);
    expect(recovered.items.map((item) => item.status)).toEqual(["queued"]);
    // A guarded start never takes an item that is not queued.
    expect(await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: stale, workerId: WORKER })).toBe(true);
    expect(await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: stale, workerId: WORKER })).toBe(false);
  });

  it("pauses: the item and job go back to queued with a backoff the queue honours, and a completed push resets the count", async () => {
    const seeded = await seedJob({ jobStatus: "queued", itemStatus: "queued" });
    const claim = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-9", now: NOW });
    await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: NOW, workerId: WORKER });
    const paused = await repository.pauseItem({ job: claim.job, item: claim.items[0]!, code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      message: "eBay listing push failed with HTTP 429.", reason: "rate_limited", workerId: WORKER, now: NOW });
    expect(paused).toMatchObject({ consecutivePauseCount: 1, nextAttemptAt: new Date(NOW.getTime() + 60_000), job: { status: "queued" } });
    const rows = await pool!.query(qualify(`SELECT j.status AS job_status, j.next_attempt_at, j.consecutive_pause_count,
      i.status AS item_status, i.result->'transientPauses' AS pauses, i.result->'lastPause'->>'reason' AS reason
      FROM dropship.dropship_listing_push_jobs j JOIN dropship.dropship_listing_push_job_items i ON i.job_id = j.id WHERE j.id = $1`), [seeded.jobId]);
    expect(rows.rows[0]).toEqual({ job_status: "queued", next_attempt_at: new Date(NOW.getTime() + 60_000), consecutive_pause_count: 1,
      item_status: "queued", pauses: 1, reason: "rate_limited" });
    const audit = await pool!.query(qualify(`SELECT severity, payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_job_paused'`));
    expect(audit.rows[0]).toMatchObject({ severity: "warning", payload: { itemId: seeded.itemId, consecutivePauseCount: 1, reason: "rate_limited" } });
    expect(await queue.listClaimableJobIds({ limit: 10, now: new Date(NOW.getTime() + 59_999), staleAfterMinutes: 30 })).toEqual([]);
    expect(await queue.listClaimableJobIds({ limit: 10, now: new Date(NOW.getTime() + 60_000), staleAfterMinutes: 30 })).toEqual([seeded.jobId]);

    // The second pause in a row backs off two minutes.
    const again = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-10", now: new Date(NOW.getTime() + 60_000) });
    expect(again.job.consecutivePauseCount).toBe(1);
    await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: new Date(NOW.getTime() + 60_000), workerId: WORKER });
    const second = await repository.pauseItem({ job: again.job, item: again.items[0]!, code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      message: "eBay listing push failed with HTTP 429.", reason: "rate_limited", workerId: WORKER, now: new Date(NOW.getTime() + 60_000) });
    expect(second).toMatchObject({ consecutivePauseCount: 2, nextAttemptAt: new Date(NOW.getTime() + 180_000) });

    const third = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-11", now: new Date(NOW.getTime() + 180_000) });
    await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: new Date(NOW.getTime() + 180_000), workerId: WORKER });
    await repository.completeItem({ job: third.job, item: third.items[0]!, intent: intent(), workerId: WORKER, now: new Date(NOW.getTime() + 180_000),
      pushResult: { status: "created", externalListingId: "123456789012", externalOfferId: "offer-1", rawResult: {} } });
    const reset = await pool!.query(qualify("SELECT consecutive_pause_count FROM dropship.dropship_listing_push_jobs WHERE id = $1"), [seeded.jobId]);
    expect(reset.rows[0]).toEqual({ consecutive_pause_count: 0 });
  });

  // eBay sync-back's push-time rule (plan v4 §5 step 7): what a completed push proves, in the completion's transaction.
  describe("eBay sync-back facts a completed push proves", () => {
    const sent = { priceCents: 1299, currency: "USD", sku: "SKU-101", fulfillmentPolicyId: "F-9", returnPolicyId: "R-1", paymentPolicyId: "P-1",
      titleHash: "a".repeat(64), descriptionHash: "b".repeat(64) };
    async function complete(listing: { externalListingId: string | null; externalOfferId: string | null }, pushedListingId: string) {
      const seeded = await seedJob({ jobStatus: "queued", itemStatus: "queued" });
      await pool!.query(qualify(`UPDATE dropship.dropship_vendor_listings SET external_listing_id = $2, external_offer_id = $3, status = 'ended',
        marketplace_issue_codes = '{offer_missing,quantity_restore_blocked,sync_requires_review}', marketplace_ended_at = $4,
        marketplace_sync_attempted_at = $4 WHERE id = $1`), [seeded.listingId, listing.externalListingId, listing.externalOfferId,
        new Date(NOW.getTime() - 3_600_000)]);
      const claim = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-sb", now: NOW });
      await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: NOW, workerId: WORKER });
      await repository.completeItem({ job: claim.job, item: claim.items[0]!, intent: intent(), workerId: WORKER, now: NOW,
        pushResult: { status: "updated", externalListingId: pushedListingId, externalOfferId: "offer-1", sent,
          rawResult: { provider: "ebay", marketplaceId: "EBAY_US", listingMode: "live", published: true } } });
      return seeded;
    }

    it("records the policy now live, the item number it replaced, the issues eBay's acceptance disproves (never a dead letter); no vendor end, due for the sweep", async () => {
      const seeded = await complete({ externalListingId: "110000000001", externalOfferId: "offer-1" }, "110000000002");

      expect((await pool!.query(qualify(`SELECT status, external_listing_id, observed_fulfillment_policy_id, marketplace_issue_codes,
        marketplace_ended_at, marketplace_sync_attempted_at FROM dropship.dropship_vendor_listings WHERE id = $1`), [seeded.listingId])).rows[0])
        .toEqual({ status: "active", external_listing_id: "110000000002", observed_fulfillment_policy_id: "F-9",
          marketplace_issue_codes: ["quantity_restore_blocked", "sync_requires_review"], marketplace_ended_at: null, marketplace_sync_attempted_at: null });
      expect((await pool!.query(qualify(`SELECT external_listing_id, reason, replaced_at FROM dropship.dropship_listing_previous_marketplace_ids
        WHERE listing_id = $1`), [seeded.listingId])).rows).toEqual([{ external_listing_id: "110000000001", reason: "republished", replaced_at: NOW }]);
      // SB3: Card Shellz's baseline for price and policies, from what eBay took.
      expect((await pool!.query(qualify(`SELECT payload FROM dropship.dropship_listing_sync_events
        WHERE listing_id = $1 AND event_type = 'listing_push_completed'`), [seeded.listingId])).rows[0]!.payload)
        .toMatchObject({ priceCents: 1299, currency: "USD", sku: "SKU-101", fulfillmentPolicyId: "F-9", returnPolicyId: "R-1", paymentPolicyId: "P-1",
          // Review OR-1: the fingerprints of the title and description this push wrote (owner rule 2's "what Card Shellz last sent").
          titleHash: "a".repeat(64), descriptionHash: "b".repeat(64) });
      // Rule 2: the stored intent stays Card Shellz's own; only result.push is added.
      expect((await pool!.query(qualify(`SELECT result -> 'listingIntent' AS intent, result -> 'push' ->> 'status' AS push
        FROM dropship.dropship_listing_push_job_items WHERE id = $1`), [seeded.itemId])).rows[0]).toEqual({ intent: intent(), push: "updated" });
    });

    it.each([
      ["a first publish", { externalListingId: null, externalOfferId: null }],
      ["a staged draft (its offer id stood in for the item number)", { externalListingId: "offer-1", externalOfferId: "offer-1" }],
      ["the same item number", { externalListingId: "110000000002", externalOfferId: "offer-1" }],
    ])("records no previous item number for %s", async (_name, listing) => {
      const seeded = await complete(listing, "110000000002");
      expect((await pool!.query(qualify(`SELECT count(*)::int AS count FROM dropship.dropship_listing_previous_marketplace_ids
        WHERE listing_id = $1`), [seeded.listingId])).rows[0].count).toBe(0);
    });
  });

  it("skips an item quietly for a listing the vendor ended: cancelled, not failed, with its event and audit row, once", async () => {
    const seeded = await seedJob({ jobStatus: "queued", itemStatus: "queued" });
    await pool!.query(qualify(`UPDATE dropship.dropship_vendor_listings SET status = 'ended' WHERE id = $1`), [seeded.listingId]);
    const claim = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-skip", now: NOW });
    await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: NOW, workerId: WORKER });
    const input = { job: claim.job, item: claim.items[0]!, code: "DROPSHIP_LISTING_ENDED_ON_EBAY", message: "Ended on eBay.", workerId: WORKER, now: NOW };

    expect(await repository.skipItem(input)).toMatchObject({ status: "cancelled", errorCode: "DROPSHIP_LISTING_ENDED_ON_EBAY" });
    expect(await repository.skipItem(input)).toMatchObject({ status: "cancelled" });

    expect((await pool!.query(qualify(`SELECT result -> 'push' AS push FROM dropship.dropship_listing_push_job_items WHERE id = $1`),
      [seeded.itemId])).rows[0].push).toMatchObject({ status: "skipped", errorCode: "DROPSHIP_LISTING_ENDED_ON_EBAY", retryable: false });
    expect((await pool!.query(qualify(`SELECT event_type, payload FROM dropship.dropship_listing_sync_events WHERE listing_id = $1`),
      [seeded.listingId])).rows).toEqual([{ event_type: "listing_push_skipped",
      payload: { jobId: seeded.jobId, jobItemId: seeded.itemId, code: "DROPSHIP_LISTING_ENDED_ON_EBAY" } }]);
    expect((await pool!.query(qualify(`SELECT event_type, payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_push_item_skipped'`)))
      .rows).toEqual([{ event_type: "listing_push_item_skipped", payload: { jobId: seeded.jobId, listingId: seeded.listingId,
      code: "DROPSHIP_LISTING_ENDED_ON_EBAY", before: "processing", after: "cancelled" } }]);
    expect((await pool!.query(qualify(`SELECT status FROM dropship.dropship_vendor_listings WHERE id = $1`), [seeded.listingId])).rows[0])
      .toEqual({ status: "ended" });
    const finalized = await repository.finalizeJob({ jobId: seeded.jobId, workerId: WORKER, now: NOW });
    expect(finalized.job.status).not.toBe("failed");
  });

  it("never turns an item a stop cancelled into blocked or failed, and then writes nothing for its listing (review MC9)", async () => {
    const seeded = await seedJob({ jobStatus: "queued", itemStatus: "queued" });
    const claim = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-mc9", now: NOW });
    // A Stop cancels the item after the claim read it as queued.
    await pool!.query(qualify(`UPDATE dropship.dropship_listing_push_job_items SET status = 'cancelled', error_code = 'DROPSHIP_LISTING_PUSH_RUN_STOPPED'
      WHERE id = $1`), [seeded.itemId]);
    const blocked = await repository.blockItem({ job: claim.job, item: claim.items[0]!, code: "DROPSHIP_LISTING_STORE_BLOCKED",
      message: "The store is not ready.", workerId: WORKER, now: NOW });
    expect(blocked.status).toBe("cancelled");
    const failed = await repository.failItem({ job: claim.job, item: claim.items[0]!, code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      message: "eBay listing push failed with HTTP 400.", retryable: false, workerId: WORKER, now: NOW });
    expect(failed.status).toBe("cancelled");
    const rows = await pool!.query(qualify(`SELECT i.status, i.error_code, l.status AS listing_status
      FROM dropship.dropship_listing_push_job_items i JOIN dropship.dropship_vendor_listings l ON l.id = i.listing_id WHERE i.id = $1`), [seeded.itemId]);
    expect(rows.rows[0]).toEqual({ status: "cancelled", error_code: "DROPSHIP_LISTING_PUSH_RUN_STOPPED", listing_status: "queued" });
    expect((await pool!.query(qualify("SELECT count(*)::int AS count FROM dropship.dropship_listing_sync_events"))).rows[0].count).toBe(0);
    expect((await pool!.query(qualify(`SELECT count(*)::int AS count FROM dropship.dropship_audit_events
      WHERE event_type IN ('listing_push_item_blocked', 'listing_push_item_failed')`))).rows[0].count).toBe(0);
  });

  it("trips the job breaker: every queued and in-flight item fails retryable with its listing, and the count is used up", async () => {
    const seeded = await seedJob({ jobStatus: "queued", itemStatus: "queued" });
    const claim = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-12", now: NOW });
    await pool!.query(qualify("UPDATE dropship.dropship_listing_push_jobs SET consecutive_pause_count = 6 WHERE id = $1"), [seeded.jobId]);
    await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: NOW, workerId: WORKER });
    const tripped = await repository.tripJobBreaker({ job: claim.job, item: claim.items[0]!, code: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE",
      message: "eBay wasn't answering, so this size wasn't sent. Publish again later.", workerId: WORKER, now: NOW });
    expect(tripped).toEqual({ failedItemIds: [seeded.itemId], runStopped: false });
    const rows = await pool!.query(qualify(`SELECT i.status, i.error_code, i.result->'push'->>'retryable' AS retryable, l.status AS listing_status,
      j.consecutive_pause_count, j.next_attempt_at
      FROM dropship.dropship_listing_push_job_items i JOIN dropship.dropship_vendor_listings l ON l.id = i.listing_id
      JOIN dropship.dropship_listing_push_jobs j ON j.id = i.job_id WHERE i.id = $1`), [seeded.itemId]);
    expect(rows.rows[0]).toEqual({ status: "failed", error_code: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE", retryable: "true",
      listing_status: "failed", consecutive_pause_count: 0, next_attempt_at: null });
    const finalized = await repository.finalizeJob({ jobId: seeded.jobId, workerId: WORKER, now: NOW });
    expect(finalized.job.status).toBe("failed");
  });

  // Rebase of PR A onto PR 1b: the breaker writes listings under the live-status rule (domain/listing-live-status), as
  // markItemTerminalFailure does: eBay still lists a live listing, so it keeps taking orders.
  it("trips the job breaker without moving a live listing out of its live status, and records each listing before -> after", async () => {
    const live = await pool!.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_vendor_listings
      (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id)
      VALUES (10, 22, 102, 'ebay', 'active', '110012345678') RETURNING id`));
    const liveListingId = live.rows[0]!.id;
    const seeded = await seedJob({ jobStatus: "queued", itemStatus: "queued" });
    const liveItem = await pool!.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_listing_push_job_items
      (job_id, listing_id, product_variant_id, status, preview_hash, result) VALUES ($1, $2, 102, 'queued', 'preview-2', $3::jsonb) RETURNING id`),
      [seeded.jobId, liveListingId, JSON.stringify({ listingIntent: intent() })]);
    const claim = await repository.claimJob({ jobId: seeded.jobId, workerId: WORKER, idempotencyKey: "process-13", now: NOW });
    await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: NOW, workerId: WORKER });
    const tripped = await repository.tripJobBreaker({ job: claim.job, item: claim.items.find((item) => item.itemId === seeded.itemId)!,
      code: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE", message: "eBay wasn't answering, so this size wasn't sent. Publish again later.",
      workerId: WORKER, now: NOW });
    expect([...tripped.failedItemIds].sort((left, right) => left - right)).toEqual([seeded.itemId, liveItem.rows[0]!.id].sort((left, right) => left - right));
    const listings = await pool!.query(qualify(`SELECT id, status, metadata->'lastPushError'->>'code' AS code
      FROM dropship.dropship_vendor_listings ORDER BY id`));
    expect(listings.rows).toEqual([
      // Live on eBay: keeps its status; the error is still recorded on it.
      { id: liveListingId, status: "active", code: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE" },
      // Never published: fails, as before.
      { id: seeded.listingId, status: "failed", code: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE" },
    ]);
    const events = await pool!.query(qualify(`SELECT listing_id, payload->'listingStatus' AS listing_status, payload->>'code' AS code
      FROM dropship.dropship_listing_sync_events WHERE event_type = 'listing_push_failed' ORDER BY listing_id`));
    expect(events.rows).toEqual([
      { listing_id: liveListingId, listing_status: { before: "active", after: "active" }, code: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE" },
      { listing_id: seeded.listingId, listing_status: { before: "queued", after: "failed" }, code: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE" },
    ]);
    const audit = await pool!.query(qualify(`SELECT payload->'listingStatuses' AS listing_statuses FROM dropship.dropship_audit_events
      WHERE event_type = 'listing_push_job_breaker_tripped'`));
    expect(audit.rows).toEqual([{ listing_statuses: [
      { listingId: liveListingId, before: "active", after: "active" },
      { listingId: seeded.listingId, before: "queued", after: "failed" },
    ] }]);
  });
});
