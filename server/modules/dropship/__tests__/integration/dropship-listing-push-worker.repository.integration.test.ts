import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipMarketplaceListingIntent } from "../../application/dropship-marketplace-listing-provider";
import { PgDropshipListingPushWorkerRepository } from "../../infrastructure/dropship-listing-push-worker.repository";

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
  let created = false;
  const qualify = (sql: string) => sql.replaceAll("dropship.", `"${schema}".`);

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
    const scopedPool = {
      query: (sql: string, values?: unknown[]) => pool!.query(qualify(sql), values),
      connect: async () => {
        const client = await pool!.connect();
        return { query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values), release: () => client.release() };
      },
    } as unknown as Pool;
    repository = new PgDropshipListingPushWorkerRepository(scopedPool);
  });

  beforeEach(async () => {
    await pool!.query(qualify(`TRUNCATE dropship.dropship_audit_events, dropship.dropship_listing_push_jobs,
      dropship.dropship_vendor_listings, dropship.dropship_listing_push_job_items, dropship.dropship_listing_sync_events RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => { if (created && pool) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool?.end(); });

  async function seedJob(input: { jobStatus: "queued" | "processing"; itemStatus: "queued" | "failed"; updatedAt?: Date }): Promise<{ jobId: number; itemId: number; listingId: number }> {
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

    expect(await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: NOW })).toBe(true);
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
    await repository.markItemProcessing({ jobId: seeded.jobId, itemId: seeded.itemId, now: NOW });
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
});
