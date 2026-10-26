import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { readDropshipEbayPublishedQuantities } from "../../../inventory-planning/infrastructure/dropship-ebay-published-quantity.reader";
import type { MarketplaceListingSyncWrite } from "../../application/dropship-marketplace-sync-service";
import { DropshipError } from "../../domain/errors";
import { parseMarketplaceListingObservation } from "../../domain/marketplace-listing-observation";
import { decideMarketplaceSync, fulfillmentPolicyVerdictHash } from "../../domain/marketplace-sync-decision";
import { MARKETPLACE_SYNC_ACTOR } from "../../domain/marketplace-sync-keys";
import { PgDropshipQuantityPreWriteGuardReader } from "../../infrastructure/dropship-ebay-inventory-publication.adapter";
import { adoptListingPolicyRowWithClient } from "../../infrastructure/dropship-ebay-listing-policy-adoption.writer";
import { listingPriceTransactionForClient } from "../../infrastructure/dropship-listing-price.repository";
import { PgDropshipListingPushWorkerRepository } from "../../infrastructure/dropship-listing-push-worker.repository";
import { clearSizeLeftoversWithClient } from "../../infrastructure/dropship-listing-setting-leftovers.repository";
import { DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS } from "../../infrastructure/dropship-marketplace-sync-health.sql";
import {
  PgDropshipMarketplaceSyncRepository,
  type MarketplaceSyncPriceWriter,
} from "../../infrastructure/dropship-marketplace-sync.repository";
import { enqueueMarketplaceSyncNoticesWithClient } from "../../infrastructure/dropship-marketplace-sync-notices.repository";
import { ebaySyncBackBaseFixtureSql, installEbaySyncBackSchema } from "../fixtures/ebay-sync-back.fixture";
import { LISTING_END_REQUESTS_REDUCED_FIXTURE_SQL } from "../fixtures/listing-end-reduced.fixture";
import { rawInventoryItem, rawOffer, READ_LISTING_ID, READ_OFFER_ID, READ_SKU } from "../fixtures/ebay-sync-back-reads.fixture";

/**
 * eBay sync-back's sweep persistence against a real PostgreSQL (plan v4 §6.5,
 * §11 FF-17): which listings the sweep reads, the adoption transaction (W9's
 * price save as the system, the size's policy row, the issues, the event, the
 * notice and the attempt commit together or not at all), the quantity
 * decision's compare-and-set, dead letters, the policy check, the IP reader's
 * SQL and the ops-health SQL. W9's own authorization (store, vendor, limits)
 * is proven in its DI and PG suites; here the price writer is W9's save on the
 * same client.
 */
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const VENDOR = 10;
const STORE = 22;
const T0 = new Date("2026-10-22T09:00:00.000Z");
const T1 = new Date("2026-10-22T12:00:00.000Z");
const T2 = new Date("2026-10-22T12:15:00.000Z");

/** The columns the sweep reads that the reduced base fixture does not carry, and the IP outbox the reader reads. */
const SWEEP_FIXTURE_SQL = `
  ALTER TABLE dropship.dropship_store_connections ADD COLUMN access_token_ref text, ADD COLUMN refresh_token_ref text;
  ALTER TABLE dropship.dropship_store_listing_configs ADD COLUMN marketplace_config jsonb NOT NULL DEFAULT '{}';
  ALTER TABLE dropship.dropship_listing_push_jobs ADD COLUMN idempotency_key varchar(200),
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  CREATE TABLE inventory.inventory_publication_targets (id integer PRIMARY KEY, destination_kind varchar(30) NOT NULL,
    dropship_store_connection_id integer, state varchar(20) NOT NULL, publication_authority varchar(30) NOT NULL);
  CREATE TABLE inventory.inventory_publication_outbox (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    publication_target_id integer NOT NULL, product_variant_id integer NOT NULL, desired_revision bigint NOT NULL,
    desired_quantity bigint NOT NULL, dropship_store_connection_id_snapshot integer, state varchar(30) NOT NULL,
    acknowledged_at timestamptz, verified_at timestamptz);
  CREATE TABLE inventory.quantity_publication_attempts (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, outbox_id bigint,
    state text NOT NULL);
  -- What the worker's completeItem writes (the lock-order case): the job's pause count, the item's outcome columns, run targets.
  ALTER TABLE dropship.dropship_listing_push_jobs ADD COLUMN consecutive_pause_count integer NOT NULL DEFAULT 0;
  ALTER TABLE dropship.dropship_listing_push_job_items ADD COLUMN preview_hash text, ADD COLUMN external_listing_id text,
    ADD COLUMN error_code text, ADD COLUMN error_message text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  CREATE TABLE dropship.dropship_listing_push_runs (id integer PRIMARY KEY, status text NOT NULL);
  CREATE TABLE dropship.dropship_listing_push_run_targets (run_id integer NOT NULL, job_item_id integer NOT NULL, outcome text,
    code text, retryable boolean, decided_at timestamptz);
  -- PR C's end requests (reduced; empty but for the health case): the sweep's predicate, its adoption re-check and the
  -- health copy read them (PLAN-C v4.1 §9 I1); their cases are in dropship-listing-end-interplay.integration.test.ts.
  -- The end worker's two health checks (§5.7) count them in the ops-health case below.
  ${LISTING_END_REQUESTS_REDUCED_FIXTURE_SQL}
`;

/** W9's save on the adoption transaction's client, as the system (its authorization runs in W9's own suites). */
const w9Save: MarketplaceSyncPriceWriter = {
  async adoptPrice(client, input) {
    const tx = listingPriceTransactionForClient(client, { storeConnectionId: input.storeConnectionId, productVariantId: input.productVariantId,
      vendorId: input.vendorId, memberId: MARKETPLACE_SYNC_ACTOR.actorId, idempotencyKey: input.idempotencyKey, actorType: "system" });
    const saved = await tx.save({ priceCents: input.priceCents, pricingMode: "fixed", expectedRevisionId: input.expectedRevisionId,
      idempotencyKey: input.idempotencyKey, requestHash: sha(`${input.priceCents}:${input.expectedRevisionId}`), now: input.now });
    return saved.idempotentReplay ? "replayed" : "adopted";
  },
};

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describeDatabase.sequential("eBay sync-back sweep persistence (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;
  let repository: PgDropshipMarketplaceSyncRepository;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, `${ebaySyncBackBaseFixtureSql}\n${SWEEP_FIXTURE_SQL}`);
    pool = database.pool;
    await installEbaySyncBackSchema(pool);
    for (const file of ["0657_dropship_listing_price_settings.sql", "0659_dropship_store_pricing_rules.sql",
      "0735_dropship_listing_price_inherit_mode.sql", "217_dropship_ebay_listing_policy_overrides.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
    }
    repository = new PgDropshipMarketplaceSyncRepository(pool, w9Save);
  }, 120_000);

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE dropship.dropship_marketplace_sync_notices, dropship.dropship_ebay_fulfillment_policy_checks,
      dropship.dropship_listing_previous_marketplace_ids, dropship.dropship_listing_sync_events, dropship.dropship_listing_push_job_items,
      dropship.dropship_listing_push_jobs, dropship.dropship_audit_events, dropship.dropship_listing_price_settings,
      dropship.dropship_listing_price_revisions, dropship.dropship_ebay_listing_policy_overrides,
      dropship.dropship_ebay_listing_policy_override_revisions, dropship.dropship_vendor_listings, dropship.dropship_store_listing_configs,
      dropship.dropship_store_connections, dropship.dropship_vendors, catalog.product_variants, catalog.products,
      inventory.quantity_publication_attempts, inventory.inventory_publication_outbox, inventory.inventory_publication_targets,
      dropship.dropship_listing_end_requests RESTART IDENTITY CASCADE`);
    await pool.query(`
      INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (${VENDOR}, 'member-10'), (11, 'member-11');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, setup_status, last_order_sync_at, access_token_ref,
        refresh_token_ref) VALUES (${STORE}, ${VENDOR}, 'ebay', 'connected', 'ready', '2026-10-22T13:00:00Z', 'a', 'r'),
        (23, 11, 'ebay', 'needs_reauth', 'ready', NULL, 'a', 'r'), (24, 11, 'ebay', 'connected', 'ready', NULL, NULL, NULL);
      INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, marketplace_config)
        VALUES (${STORE}, '{"marketplaceId": "EBAY_US"}');
      INSERT INTO catalog.products (id) VALUES (20);
      INSERT INTO catalog.product_variants (id, product_id, sku) VALUES (101, 20, 'CS-101'), (102, 20, 'CS-102'), (103, 20, 'CS-103'),
        (104, 20, 'CS-104'), (105, 20, 'CS-105');`);
    const insert = async (variant: number, status: string, itemNumber: string | null, offerId: string, attemptedAt: Date | null = null) =>
      (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id,
        platform, external_listing_id, external_offer_id, status, pushed_quantity, last_pushed_at, marketplace_sync_attempted_at)
        VALUES ($1, $2, $3, 'ebay', $4, $5, $6, 10, $7, $8) RETURNING id`,
      [VENDOR, STORE, variant, itemNumber, offerId, status, T0, attemptedAt])).rows[0]!.id;
    ids.live = await insert(101, "active", READ_LISTING_ID, READ_OFFER_ID);
    ids.readEarlier = await insert(105, "active", "110000000005", "OFFER-105", T0);
    ids.draft = await insert(102, "paused", "OFFER-102", "OFFER-102");
    ids.staged = await insert(103, "active", "OFFER-103", "OFFER-103");
    ids.pushing = await insert(104, "active", "110000000004", "OFFER-104");
    const job = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs (vendor_id, store_connection_id)
      VALUES ($1, $2) RETURNING id`, [VENDOR, STORE])).rows[0]!.id;
    await pool.query(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id, product_variant_id, status)
      VALUES ($1, $2, 104, 'queued')`, [job, ids.pushing]);
    await pool.query(`INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload, created_at)
      VALUES ($1, 'listing_push_completed', 'push', '{"priceCents":1100,"fulfillmentPolicyId":"F-1","returnPolicyId":"R-1","paymentPolicyId":"P-1"}', $2)`,
    [ids.live, T0]);
  });

  async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
    return Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params)).rows[0]!.n);
  }

  /** The decision the sweep makes for a read where the vendor set 6.50 (below the 7.00 cost) and policy F-9. */
  function vendorWrite(overrides: Partial<MarketplaceListingSyncWrite> = {}): MarketplaceListingSyncWrite {
    const parsed = parseMarketplaceListingObservation({ inventoryItem: rawInventoryItem(), expectedOfferId: READ_OFFER_ID,
      offer: rawOffer({ pricingSummary: { price: { value: "6.50", currency: "USD" } },
        listingPolicies: { fulfillmentPolicyId: "F-9", returnPolicyId: "R-1", paymentPolicyId: "P-1" } }) });
    if (parsed.kind !== "observed") throw new Error(parsed.reason);
    const decision = decideMarketplaceSync({
      trigger: { kind: "sweep" }, read: { kind: "observed", observation: parsed.observation }, observedAt: T1,
      listing: { listingId: ids.live!, itemLabel: "Toploaders", sku: READ_SKU, externalListingId: READ_LISTING_ID, status: "active",
        issueCodes: [], marketplaceEndedAt: null, latestPublishedQuantity: 10 },
      ours: { priceCents: { baseline: 1100, attempted: [] }, fulfillmentPolicyId: { baseline: "F-1", attempted: [] },
        returnPolicyId: { baseline: "R-1", attempted: [] }, paymentPolicyId: { baseline: "P-1", attempted: [] } },
      echelon: { priceCents: 1100, fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1", unitCostCents: 700 },
    });
    return {
      trigger: "sweep", excludeJobItemId: null,
      listingId: ids.live!, vendorId: VENDOR, storeConnectionId: STORE, productVariantId: 101, externalOfferId: READ_OFFER_ID, observedAt: T1,
      expectedNewestEventId: newestEventId, decision, oursPriceBaseline: 1100,
      price: { priceCents: 650, expectedRevisionId: null }, policies: { fulfillmentPolicyId: "F-9" },
      observed: { priceCents: 650, fulfillmentPolicyId: "F-9" }, saveObservation: { quantity: 10, at: T1 }, expectedObservation: null,
      ...overrides,
    };
  }
  /** The listing's newest sync event as the sweep read it (the push that completed at T0). */
  let newestEventId = 0;
  beforeEach(async () => {
    newestEventId = (await pool.query<{ id: number }>(`SELECT max(id) AS id FROM dropship.dropship_listing_sync_events WHERE listing_id = $1`,
      [ids.live])).rows[0]!.id;
  });

  describe("which listings the sweep reads (§6.2)", () => {
    it("reads launch-ready eBay stores only, with their marketplace and swept listing count", async () => {
      expect(await repository.listSweepStores()).toEqual([{ vendorId: VENDOR, storeConnectionId: STORE, marketplaceId: "EBAY_US",
        liveListingCount: 2, salesLedgerSince: null, lastOrderSyncAt: new Date("2026-10-22T13:00:00Z") }]);
    });

    it("reads never-read listings first, never a draft, a staged offer, one with a push in flight, or a dead-lettered one", async () => {
      expect(await repository.listDueListingIds({ storeConnectionId: STORE, limit: 50 })).toEqual([ids.live, ids.readEarlier]);
      expect(await repository.listDueListingIds({ storeConnectionId: STORE, limit: 1 })).toEqual([ids.live]);
      await repository.deadLetterListing({ listingId: ids.live!, failureCode: "23514", at: T1 });
      expect(await repository.listDueListingIds({ storeConnectionId: STORE, limit: 50 })).toEqual([ids.readEarlier]);
      expect((await pool.query(`SELECT marketplace_issue_codes FROM dropship.dropship_vendor_listings WHERE id = $1`, [ids.live])).rows[0])
        .toEqual({ marketplace_issue_codes: ["sync_requires_review"] });
      expect((await pool.query(`SELECT event_type, actor_type, severity, payload FROM dropship.dropship_audit_events`)).rows).toEqual([
        { event_type: "listing_marketplace_sync_dead_lettered", actor_type: "system", severity: "error",
          payload: { failureCode: "23514", requiresReview: true } }]);
    });

    it("decides a saved observation before reading the listing again", async () => {
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET observed_marketplace_quantity = 4, observed_marketplace_quantity_at = $2
        WHERE id = $1`, [ids.readEarlier, T1]);
      expect(await repository.listObservedListingIds({ storeConnectionId: STORE, limit: 50 })).toEqual([ids.readEarlier]);
      expect(await repository.listDueListingIds({ storeConnectionId: STORE, limit: 50 })).toEqual([ids.live]);
    });

    it("loads a listing in one snapshot: its sync events, its newest stored intent, and whether a push is in flight", async () => {
      expect(await repository.loadListing(ids.pushing!)).toMatchObject({ listingId: ids.pushing, hasOpenPushItem: true, events: [] });
      const live = await repository.loadListing(ids.live!);
      expect(live).toMatchObject({ listingId: ids.live, externalOfferId: READ_OFFER_ID, hasOpenPushItem: false, storedIntent: null,
        events: [expect.objectContaining({ eventType: "listing_push_completed" })] });
    });
  });

  describe("the adoption transaction (§6.5, FF-17)", () => {
    it("keeps the vendor's price (a system W9 revision) and policy (the size's row) with their audit rows, the event, the notice and the observation, in one commit", async () => {
      const result = await repository.applyListingSync(vendorWrite());

      expect(result).toMatchObject({ price: "adopted", policies: "saved", observationSaved: true, noticesWritten: 1 });
      expect((await pool.query(`SELECT override_price_cents, pricing_mode FROM dropship.dropship_listing_price_settings`)).rows)
        .toEqual([{ override_price_cents: 650, pricing_mode: "fixed" }]);
      expect((await pool.query(`SELECT actor_id, idempotency_key FROM dropship.dropship_listing_price_revisions`)).rows)
        .toEqual([{ actor_id: "system:ebay-sync-back", idempotency_key: `ebay-sync:price:${ids.live}:650:none` }]);
      expect((await pool.query(`SELECT fulfillment_policy_id, return_policy_id, payment_policy_id FROM dropship.dropship_ebay_listing_policy_overrides`)).rows)
        .toEqual([{ fulfillment_policy_id: "F-9", return_policy_id: null, payment_policy_id: null }]);
      expect((await pool.query(`SELECT event_type, actor_type FROM dropship.dropship_audit_events ORDER BY id`)).rows).toEqual([
        { event_type: "listing_price_saved", actor_type: "system" }, { event_type: "ebay_listing_policy_override_replaced", actor_type: "system" }]);
      expect((await pool.query(`SELECT event_type, source, payload ->> 'priceCents' AS price FROM dropship.dropship_listing_sync_events
        WHERE id = $1`, [result.syncedEventId])).rows).toEqual([{ event_type: "listing_marketplace_synced", source: "ebay_sync_back", price: "650" }]);
      expect((await pool.query(`SELECT kind, subject_key FROM dropship.dropship_marketplace_sync_notices`)).rows)
        .toEqual([{ kind: "price_below_cost", subject_key: `below-cost:${ids.live}:2026-10-22` }]);
      expect((await pool.query(`SELECT observed_marketplace_price_cents::int AS price, observed_fulfillment_policy_id,
        observed_marketplace_quantity, marketplace_sync_attempted_at FROM dropship.dropship_vendor_listings WHERE id = $1`, [ids.live])).rows)
        .toEqual([{ price: 650, observed_fulfillment_policy_id: "F-9", observed_marketplace_quantity: 10, marketplace_sync_attempted_at: T1 }]);
    });

    it("rolls every part back when one fails (an injected refusal of the notice row)", async () => {
      await pool.query(`ALTER TABLE dropship.dropship_marketplace_sync_notices ADD CONSTRAINT test_refuse CHECK (kind <> 'price_below_cost')`);
      try {
        await expect(repository.applyListingSync(vendorWrite())).rejects.toMatchObject({ code: "23514" });
      } finally {
        await pool.query(`ALTER TABLE dropship.dropship_marketplace_sync_notices DROP CONSTRAINT test_refuse`);
      }
      for (const table of ["dropship.dropship_listing_price_revisions", "dropship.dropship_listing_price_settings",
        "dropship.dropship_ebay_listing_policy_overrides", "dropship.dropship_ebay_listing_policy_override_revisions",
        "dropship.dropship_audit_events", "dropship.dropship_marketplace_sync_notices"]) {
        expect(await count(table), table).toBe(0);
      }
      expect(await count("dropship.dropship_listing_sync_events")).toBe(1);
      expect(await count("dropship.dropship_vendor_listings", "id = $1 AND marketplace_sync_attempted_at IS NULL AND observed_marketplace_quantity IS NULL",
        [ids.live])).toBe(1);
    });

    it("writes nothing from a decision made before another event (SB4): the second of two identical decisions loses", async () => {
      await repository.applyListingSync(vendorWrite());
      await expect(repository.applyListingSync(vendorWrite())).rejects.toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_OBSERVATION_CHANGED" });
      expect(await count("dropship.dropship_listing_price_revisions")).toBe(1);
      expect(await count("dropship.dropship_ebay_listing_policy_override_revisions")).toBe(1);
      expect(await count("dropship.dropship_marketplace_sync_notices")).toBe(1);
    });

    it("undoes only the price when W9 refuses it for a Card Shellz limit: flagged, no below-cost notice, B for price kept", async () => {
      const refusing: MarketplaceSyncPriceWriter = {
        async adoptPrice(client, input) {
          await w9Save.adoptPrice(client, input);
          throw new DropshipError("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", "below the floor");
        },
      };
      const result = await new PgDropshipMarketplaceSyncRepository(pool, refusing).applyListingSync(vendorWrite());
      expect(result).toMatchObject({ price: "refused_limit", policies: "saved", noticesWritten: 0 });
      expect(await count("dropship.dropship_listing_price_revisions")).toBe(0);
      expect(await count("dropship.dropship_ebay_listing_policy_overrides")).toBe(1);
      expect((await pool.query(`SELECT marketplace_issue_codes FROM dropship.dropship_vendor_listings WHERE id = $1`, [ids.live])).rows[0])
        .toEqual({ marketplace_issue_codes: ["price_outside_card_shellz_limit"] });
      expect((await pool.query(`SELECT payload ->> 'priceCents' AS price FROM dropship.dropship_listing_sync_events WHERE id = $1`,
        [result.syncedEventId])).rows[0]).toEqual({ price: "1100" });
    });

    /** The quantity this read decides at once (the vendor raised eBay to 12, between no limit and ATP 20): limit 12. */
    const quantityOnRead = (overrides: Record<string, unknown> = {}) => ({ saveObservation: { quantity: 12, at: T1 }, quantity: {
      listingId: ids.live!, storeConnectionId: STORE, observation: { quantity: 12, at: T1 }, expectedLimit: null,
      writes: { limitChange: { kind: "set" as const, limit: 12 }, baseline: { quantity: 12, at: T1 }, clearObservation: false,
        restore: "none" as const, issues: { add: [], remove: [] } },
      idempotencyKey: `ebay-sync:qty-limit:${ids.live}:${T1.getTime()}:12`, decidedAt: T1, ...overrides } });

    it("commits the quantity this read decides, the limit with its audit row, in the same commit as the price and policy (S3)", async () => {
      const result = await repository.applyListingSync(vendorWrite(quantityOnRead()));

      expect(result).toMatchObject({ price: "adopted", policies: "saved", observationSaved: true, quantityApplied: true });
      expect((await pool.query(`SELECT vendor_quantity_limit, marketplace_quantity_baseline, observed_marketplace_quantity
        FROM dropship.dropship_vendor_listings WHERE id = $1`, [ids.live])).rows[0])
        .toEqual({ vendor_quantity_limit: 12, marketplace_quantity_baseline: 12, observed_marketplace_quantity: null });
      expect((await pool.query(`SELECT event_type, actor_type FROM dropship.dropship_audit_events ORDER BY id`)).rows).toEqual([
        { event_type: "listing_price_saved", actor_type: "system" }, { event_type: "ebay_listing_policy_override_replaced", actor_type: "system" },
        { event_type: "listing_quantity_limit_saved", actor_type: "system" }]);
    });

    it("rolls the limit back with the price and policy when a later part of the commit fails", async () => {
      await pool.query(`ALTER TABLE dropship.dropship_marketplace_sync_notices ADD CONSTRAINT test_refuse CHECK (kind <> 'price_below_cost')`);
      try {
        await expect(repository.applyListingSync(vendorWrite(quantityOnRead()))).rejects.toMatchObject({ code: "23514" });
      } finally {
        await pool.query(`ALTER TABLE dropship.dropship_marketplace_sync_notices DROP CONSTRAINT test_refuse`);
      }
      expect(await count("dropship.dropship_audit_events")).toBe(0);
      expect(await count("dropship.dropship_listing_price_revisions")).toBe(0);
      expect(await count("dropship.dropship_vendor_listings", "id = $1 AND vendor_quantity_limit IS NULL AND observed_marketplace_quantity IS NULL",
        [ids.live])).toBe(1);
    });

    it("writes no limit from a decision that saw another limit, and keeps the observation for the next decision", async () => {
      const result = await repository.applyListingSync(vendorWrite(quantityOnRead({ expectedLimit: 3 })));
      expect(result).toMatchObject({ price: "adopted", observationSaved: true, quantityApplied: false });
      expect((await pool.query(`SELECT vendor_quantity_limit, observed_marketplace_quantity FROM dropship.dropship_vendor_listings
        WHERE id = $1`, [ids.live])).rows[0]).toEqual({ vendor_quantity_limit: null, observed_marketplace_quantity: 12 });
      expect(await count("dropship.dropship_audit_events", "event_type = 'listing_quantity_limit_saved'")).toBe(0);
    });

    it("replays a key instead of writing twice: W9's price and the policy writer", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const input = { vendorId: VENDOR, storeConnectionId: STORE, productVariantId: 101, priceCents: 1400, expectedRevisionId: null,
          idempotencyKey: `ebay-sync:price:${ids.live}:1400:none`, now: T1 };
        expect(await w9Save.adoptPrice(client, input)).toBe("adopted");
        expect(await w9Save.adoptPrice(client, input)).toBe("replayed");
        const policy = { vendorId: VENDOR, storeConnectionId: STORE, productVariantId: 101, changes: { returnPolicyId: "R-9" },
          idempotencyKey: `ebay-sync:policy:${ids.live}:0123456789abcdef`, requestHash: "c".repeat(64), now: T1 };
        expect(await adoptListingPolicyRowWithClient(client, policy)).toMatchObject({ kind: "saved" });
        expect(await adoptListingPolicyRowWithClient(client, policy)).toMatchObject({ kind: "replayed" });
        await expect(adoptListingPolicyRowWithClient(client, { ...policy, requestHash: "d".repeat(64) }))
          .rejects.toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_INVARIANT_FAILED" });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });
  });

  // Review OR-6 (plan v4 §6.5, §11): the adoption transaction, the worker's completeItem and the listing settings' leftover
  // clean-up, each started together while a gate holds the first lock it contends for, all finish: no lock cycle (40P01).
  describe("lock order (§6.5)", () => {
    it("runs the adoption transaction against completeItem and the leftovers clean-up with no deadlock", async () => {
      const wide = new pg.Pool({ connectionString: database!.connectionString, max: 6 });
      const seed = await pool.connect();
      try {
        await seed.query("BEGIN");
        await adoptListingPolicyRowWithClient(seed, { vendorId: VENDOR, storeConnectionId: STORE, productVariantId: 101,
          changes: { returnPolicyId: "R-9" }, idempotencyKey: `ebay-sync:policy:${ids.live}:feedfacefeedface`, requestHash: "c".repeat(64), now: T0 });
        await seed.query("COMMIT");
      } finally {
        seed.release();
      }
      const job = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs (vendor_id, store_connection_id, status)
        VALUES ($1, $2, 'processing') RETURNING id`, [VENDOR, STORE])).rows[0]!.id;
      const item = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id,
        product_variant_id, status) VALUES ($1, $2, 101, 'processing') RETURNING id`, [job, ids.live])).rows[0]!.id;
      const gate = await wide.connect();
      const settings = await wide.connect();
      try {
        await gate.query("BEGIN");
        // The store lock (the adoption's and the settings transaction's first) and the listing row (completeItem's first shared one).
        await gate.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [STORE]);
        await gate.query("SELECT id FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE", [ids.live]);
        const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;

        const adoption = new PgDropshipMarketplaceSyncRepository(wide, w9Save).applyListingSync(vendorWrite());
        const completion = new PgDropshipListingPushWorkerRepository(wide).completeItem({
          job: { jobId: job, vendorId: VENDOR, storeConnectionId: STORE } as never,
          item: { itemId: item, listingId: ids.live!, productVariantId: 101 } as never,
          intent: { quantity: 7, priceCents: 1100, listingMode: "live" } as never,
          pushResult: { status: "updated", externalListingId: READ_LISTING_ID, externalOfferId: READ_OFFER_ID,
            rawResult: { provider: "ebay" } } as never,
          workerId: "worker-lock-order", now: T2 });
        const cleanUp = (async () => {
          await settings.query("BEGIN");
          await settings.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [STORE]);
          const cleared = await clearSizeLeftoversWithClient(settings, { vendorId: VENDOR, storeConnectionId: STORE,
            actor: { actorType: "vendor", actorId: "member-10" }, requestKey: "lock-order-settings-1" },
          { productIds: [20], fields: ["returnPolicy"], requestHash: "e".repeat(64), now: T2 });
          await settings.query("COMMIT");
          return cleared;
        })();
        const waiting = async () => Number((await pool.query<{ n: string }>(`SELECT count(DISTINCT pid)::text AS n FROM pg_locks
          WHERE NOT granted AND pid <> $1`, [gatePid])).rows[0]!.n);
        for (let attempt = 0; attempt < 200 && await waiting() < 3; attempt += 1) await new Promise((done) => setTimeout(done, 25));
        expect(await waiting()).toBe(3);
        await gate.query("COMMIT");

        const outcomes = await Promise.allSettled([adoption, completion, cleanUp]);
        const codes = outcomes.map((outcome) => outcome.status === "rejected" ? (outcome.reason as { code?: string }).code ?? "unknown" : "done");
        expect(codes).not.toContain("40P01");
        // completeItem and the clean-up always finish; the adoption either commits first or finds the push's newer event (SB4).
        expect(codes[1]).toBe("done");
        expect(codes[2]).toBe("done");
        expect(["done", "DROPSHIP_MARKETPLACE_SYNC_OBSERVATION_CHANGED"]).toContain(codes[0]);
        expect((await pool.query(`SELECT status FROM dropship.dropship_listing_push_job_items WHERE id = $1`, [item])).rows)
          .toEqual([{ status: "completed" }]);
        expect((await pool.query(`SELECT pushed_quantity, last_pushed_at FROM dropship.dropship_vendor_listings WHERE id = $1`, [ids.live])).rows)
          .toEqual([{ pushed_quantity: 7, last_pushed_at: T2 }]);
      } finally {
        await gate.query("ROLLBACK").catch(() => undefined);
        await settings.query("ROLLBACK").catch(() => undefined);
        gate.release();
        settings.release();
        await wide.end();
      }
    });
  });

  describe("the quantity decision (owner rule 1, §6.4)", () => {
    beforeEach(async () => {
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET observed_marketplace_quantity = 4, observed_marketplace_quantity_at = $2
        WHERE id = $1`, [ids.live, T1]);
    });
    const decision = (overrides: Record<string, unknown> = {}) => ({
      listingId: ids.live!, storeConnectionId: STORE, observation: { quantity: 4, at: T1 }, expectedLimit: null,
      writes: { limitChange: { kind: "set" as const, limit: 4 }, baseline: { quantity: 4, at: T1 }, clearObservation: false, restore: "none" as const,
        issues: { add: [], remove: [] } },
      idempotencyKey: `ebay-sync:qty-limit:${ids.live}:${T1.getTime()}:4`, decidedAt: T2, ...overrides });

    it("keeps the vendor's number as the limit with one system audit row; the same decision again changes nothing", async () => {
      expect(await repository.applyQuantityDecision(decision())).toEqual({ applied: true });
      expect((await pool.query(`SELECT vendor_quantity_limit, marketplace_quantity_baseline, observed_marketplace_quantity
        FROM dropship.dropship_vendor_listings WHERE id = $1`, [ids.live])).rows[0])
        .toEqual({ vendor_quantity_limit: 4, marketplace_quantity_baseline: 4, observed_marketplace_quantity: null });
      expect(await repository.applyQuantityDecision(decision())).toEqual({ applied: false });
      expect(await count("dropship.dropship_audit_events", "event_type = 'listing_quantity_limit_saved' AND actor_type = 'system'")).toBe(1);
    });

    it("loses to a limit that moved since the decision, and writes the blocked-restore flag only with its decision", async () => {
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET vendor_quantity_limit = 2 WHERE id = $1`, [ids.live]);
      expect(await repository.applyQuantityDecision(decision())).toEqual({ applied: false });
      expect(await repository.applyQuantityDecision(decision({ expectedLimit: 2, writes: { limitChange: null, baseline: null,
        clearObservation: true, restore: "blocked", issues: { add: ["quantity_restore_blocked"], remove: [] } } }))).toEqual({ applied: true });
      expect((await pool.query(`SELECT vendor_quantity_limit, marketplace_issue_codes, observed_marketplace_quantity
        FROM dropship.dropship_vendor_listings WHERE id = $1`, [ids.live])).rows[0])
        .toEqual({ vendor_quantity_limit: 2, marketplace_issue_codes: ["quantity_restore_blocked"], observed_marketplace_quantity: null });
    });
  });

  describe("the push pre-read's persistence (plan v4 §5)", () => {
    it("reads one launch-ready store, and none that is not", async () => {
      expect(await repository.loadStore(STORE)).toMatchObject({ vendorId: VENDOR, storeConnectionId: STORE, marketplaceId: "EBAY_US" });
      expect(await repository.loadStore(23)).toBeNull();
      expect(await repository.loadStore(24)).toBeNull();
    });

    it("does not count the asking push item as a push in flight", async () => {
      const own = (await pool.query<{ id: number }>(`SELECT id FROM dropship.dropship_listing_push_job_items WHERE listing_id = $1`,
        [ids.pushing])).rows[0]!.id;
      expect(await repository.loadListing(ids.pushing!)).toMatchObject({ hasOpenPushItem: true });
      expect(await repository.loadListing(ids.pushing!, { excludeJobItemId: own })).toMatchObject({ hasOpenPushItem: false });
    });

    it("saves the asking item's own read and records it as a push read", async () => {
      const job = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs (vendor_id, store_connection_id)
        VALUES ($1, $2) RETURNING id`, [VENDOR, STORE])).rows[0]!.id;
      const own = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id, product_variant_id,
        status) VALUES ($1, $2, 101, 'processing') RETURNING id`, [job, ids.live])).rows[0]!.id;
      expect(await repository.applyListingSync(vendorWrite())).toMatchObject({ observationSaved: false });
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET observed_marketplace_quantity = NULL WHERE id = $1`, [ids.live]);
      const result = await new PgDropshipMarketplaceSyncRepository(pool, w9Save).applyListingSync(vendorWrite({ trigger: "push",
        excludeJobItemId: own, expectedNewestEventId: (await repository.loadListing(ids.live!))!.events.at(-1)!.id }));
      expect(result).toMatchObject({ observationSaved: true });
      expect((await pool.query(`SELECT payload ->> 'trigger' AS trigger FROM dropship.dropship_listing_sync_events WHERE id = $1`,
        [result.syncedEventId])).rows[0]).toEqual({ trigger: "push" });
    });

    it("records each attempt; an attempt after the newest completed push leaves the quantity unsettled until the next completes", async () => {
      const sent = { priceCents: 1100, currency: "USD", sku: READ_SKU, fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1",
        titleHash: "a".repeat(64), descriptionHash: "b".repeat(64) };
      await repository.recordPushAttempt({ listingId: ids.live!, jobId: 30, jobItemId: 5, sent, at: T1 });
      const attempted = await repository.loadListing(ids.live!);
      expect(attempted).toMatchObject({ pushAttemptUnsettled: true });
      expect(attempted!.events.map((event) => event.eventType)).toEqual(["listing_push_completed", "listing_push_attempted"]);
      expect(attempted!.events[1]!.payload).toEqual({ jobId: 30, jobItemId: 5, ...sent });

      await pool.query(`INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload, created_at)
        VALUES ($1, 'listing_push_completed', 'dropship_worker', '{"priceCents":1100}', $2)`, [ids.live, T2]);
      expect(await repository.loadListing(ids.live!)).toMatchObject({ pushAttemptUnsettled: false });
    });

    it("never takes a failed or skipped push's event for a newer decision event (SB4), so reads keep applying", async () => {
      await pool.query(`INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload, created_at)
        VALUES ($1, 'listing_push_failed', 'dropship_worker', '{}', $2), ($1, 'listing_push_skipped', 'dropship_worker', '{}', $2)`, [ids.live, T1]);
      await expect(repository.applyListingSync(vendorWrite())).resolves.toMatchObject({ price: "adopted" });
    });
  });

  describe("the per-store policy check (§6.3, owner rule 7b)", () => {
    const check = (compatible: boolean, checkedAt: Date) => {
      const issueCodes = compatible ? [] : ["local_pickup_unsupported"];
      return { vendorId: VENDOR, storeConnectionId: STORE, fulfillmentPolicyId: "F-9", compatible, issueCodes,
        verdictHash: fulfillmentPolicyVerdictHash(issueCodes), listingCount: 2, checkedAt };
    };

    it("tells a newly incompatible policy once, forgets it when it works again, and tells it again when it breaks again", async () => {
      expect(await repository.applyPolicyCheck(check(false, T1))).toEqual({ notified: true });
      expect(await repository.applyPolicyCheck(check(false, T2))).toEqual({ notified: false });
      expect(await repository.applyPolicyCheck(check(true, new Date(T2.getTime() + 60_000)))).toEqual({ notified: false });
      expect(await repository.applyPolicyCheck(check(false, new Date(T2.getTime() + 120_000)))).toEqual({ notified: true });
      expect((await pool.query(`SELECT kind, critical FROM dropship.dropship_marketplace_sync_notices ORDER BY id`)).rows)
        .toEqual([{ kind: "policy_incompatible", critical: true }, { kind: "policy_incompatible", critical: true }]);
    });

    it("lists the store's live policies, the one checked longest ago first", async () => {
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET observed_fulfillment_policy_id = CASE WHEN id = $1 THEN 'F-9' ELSE 'F-1' END
        WHERE id = ANY($2::int[])`, [ids.live, [ids.live, ids.readEarlier]]);
      await repository.applyPolicyCheck(check(true, T1));
      expect(await repository.listObservedPolicies({ storeConnectionId: STORE, limit: 20 }))
        .toEqual([{ fulfillmentPolicyId: "F-1", listingCount: 1 }, { fulfillmentPolicyId: "F-9", listingCount: 1 }]);
    });
  });

  describe("the notice outbox's dead letter (CLAUDE.md §6)", () => {
    it("never claims, lists or sends a batch again once the notification service refused it for good", async () => {
      const client = await pool.connect();
      try {
        await enqueueMarketplaceSyncNoticesWithClient(client, { vendorId: VENDOR, storeConnectionId: STORE, createdAt: T1,
          notices: [{ kind: "offer_missing", critical: true, subjectKey: `listing:${ids.live}:offer-missing:1`, payload: { listingId: ids.live } }] });
      } finally {
        client.release();
      }
      expect(await repository.claimNoticeBatches()).toBe(1);
      const [batch] = await repository.listUnsentNoticeBatches(10);
      expect(await repository.deadLetterNoticeBatch({ batchKey: batch!.batchKey, failureCode: "DROPSHIP_NOTIFICATION_INVALID_SEND", at: T2 })).toBe(1);
      expect(await repository.listUnsentNoticeBatches(10)).toEqual([]);
      expect(await repository.markNoticeBatchSent({ batchKey: batch!.batchKey, sentAt: T2 })).toBe(0);
      expect(await repository.claimNoticeBatches()).toBe(0);
      expect((await pool.query(`SELECT failure_code, sent_at FROM dropship.dropship_marketplace_sync_notices`)).rows)
        .toEqual([{ failure_code: "DROPSHIP_NOTIFICATION_INVALID_SEND", sent_at: null }]);
    });
  });

  describe("published readers", () => {
    it("reads what inventory planning last published to the store's live destination, per size (the canonical baseline)", async () => {
      await pool.query(`INSERT INTO inventory.inventory_publication_targets VALUES (1, 'dropship_store_connection', ${STORE}, 'live', 'echelon'),
        (2, 'dropship_store_connection', ${STORE}, 'disabled', 'echelon')`);
      await pool.query(`INSERT INTO inventory.inventory_publication_outbox (publication_target_id, product_variant_id, desired_revision,
        desired_quantity, dropship_store_connection_id_snapshot, state, acknowledged_at, verified_at) VALUES
        (1, 101, 1, 8, ${STORE}, 'verified', $1, $1), (1, 101, 2, 6, ${STORE}, 'acknowledged', $2, NULL),
        (1, 102, 1, 3, ${STORE}, 'leased', NULL, NULL), (2, 105, 9, 1, ${STORE}, 'verified', $1, $1)`, [T0, T1]);
      expect(await readDropshipEbayPublishedQuantities(pool, { storeConnectionId: STORE, productVariantIds: [101, 102, 105] })).toEqual([
        { productVariantId: 101, desiredQuantity: 6, state: "acknowledged", settledAt: T1 },
        { productVariantId: 102, desiredQuantity: 3, state: "leased", settledAt: null },
      ]);
    });

    // Review OR-2: a row every admission attempt proved not sent cannot have changed eBay, so it is no baseline; the
    // transport's pre-write guard also leaves out the row it is writing.
    it("leaves out a row eBay never got, and the row being written when the transport asks", async () => {
      await pool.query(`INSERT INTO inventory.inventory_publication_targets VALUES (1, 'dropship_store_connection', ${STORE}, 'live', 'echelon')`);
      const row = async (variant: number, revision: number, quantity: number, state: string, settledAt: Date | null) => (await pool.query<{ id: string }>(`
        INSERT INTO inventory.inventory_publication_outbox (publication_target_id, product_variant_id, desired_revision, desired_quantity,
          dropship_store_connection_id_snapshot, state, acknowledged_at, verified_at) VALUES (1, $1, $2, $3, ${STORE}, $4, $5, $5) RETURNING id`,
      [variant, revision, quantity, state, settledAt])).rows[0]!.id;
      const attempts = (outboxId: string, ...states: string[]) => Promise.all(states.map((state) => pool.query(
        `INSERT INTO inventory.quantity_publication_attempts (outbox_id, state) VALUES ($1, $2)`, [outboxId, state])));
      await row(101, 1, 10, "verified", T0);
      await attempts(await row(101, 2, 12, "queued", null), "not_sent", "not_sent");
      await row(102, 1, 5, "verified", T0);
      await attempts(await row(102, 2, 7, "leased", null), "running");
      await row(103, 1, 3, "verified", T0);
      await attempts(await row(103, 2, 4, "queued", null), "not_sent", "uncertain");
      await row(104, 1, 6, "verified", T0);
      await row(104, 2, 8, "queued", null);
      const read = (excludeLeased: boolean) => readDropshipEbayPublishedQuantities(pool, { storeConnectionId: STORE,
        productVariantIds: [101, 102, 103, 104], excludeLeased });
      expect(await read(false)).toEqual([
        { productVariantId: 101, desiredQuantity: 10, state: "verified", settledAt: T0 },
        { productVariantId: 102, desiredQuantity: 7, state: "leased", settledAt: null },
        // One attempt may have reached eBay, and a row never tried yet is still on its way: both stay.
        { productVariantId: 103, desiredQuantity: 4, state: "queued", settledAt: null },
        { productVariantId: 104, desiredQuantity: 8, state: "queued", settledAt: null },
      ]);
      expect((await read(true)).find((entry) => entry.productVariantId === 102)).toEqual(
        { productVariantId: 102, desiredQuantity: 5, state: "verified", settledAt: T0 });
    });

    it("loads what the pre-write guard judges, and marks a refused listing for the sync job", async () => {
      const verifiedAt = new Date("2026-10-22T10:00:00.000Z");
      await pool.query(`UPDATE dropship.dropship_store_connections SET marketplace_sales_ledger_since = '2026-10-22T08:00:00Z' WHERE id = $1`, [STORE]);
      await pool.query(`INSERT INTO inventory.inventory_publication_targets VALUES (1, 'dropship_store_connection', ${STORE}, 'live', 'echelon')`);
      await pool.query(`INSERT INTO inventory.inventory_publication_outbox (publication_target_id, product_variant_id, desired_revision,
        desired_quantity, dropship_store_connection_id_snapshot, state, acknowledged_at, verified_at) VALUES
        (1, 101, 1, 9, ${STORE}, 'verified', $1, $1), (1, 101, 2, 12, ${STORE}, 'leased', NULL, NULL)`, [verifiedAt]);
      await pool.query(`INSERT INTO dropship.dropship_listing_marketplace_sales (store_connection_id, listing_id, external_order_id,
        external_line_item_id, quantity, ordered_at, first_seen_at) VALUES ($1, $2, 'O-1', 'L-1', 2, '2026-10-22T11:00:00Z', '2026-10-22T11:01:00Z')`,
      [STORE, ids.live]);
      const guard = new PgDropshipQuantityPreWriteGuardReader(pool);
      // B is IP's settled 9 (newer than the push's 10 at T0); the row being written (12) is not counted.
      expect(await guard.load(STORE, 101, T1)).toEqual({ listingId: ids.live, baseline: { quantity: 9, at: verifiedAt, settled: true },
        salesAll: 2, salesLedgerSince: new Date("2026-10-22T08:00:00.000Z"), listingLive: true });
      // A push of the listing in flight: nothing is settled.
      expect((await guard.load(STORE, 104, T1))?.baseline?.settled).toBe(false);
      expect(await guard.load(STORE, 999, T1)).toBeNull();
      await guard.markDue(ids.readEarlier!);
      expect((await pool.query(`SELECT marketplace_sync_attempted_at FROM dropship.dropship_vendor_listings WHERE id = $1`,
        [ids.readEarlier])).rows).toEqual([{ marketplace_sync_attempted_at: null }]);
    });

    it("runs every ops-health check against the schema, counting what each names", async () => {
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET marketplace_issue_codes = '{quantity_restore_blocked}' WHERE id = $1`,
        [ids.readEarlier]);
      await repository.deadLetterListing({ listingId: ids.live!, failureCode: "23514", at: T1 });
      const dialect = new PgDialect();
      const counted: Record<string, number> = {};
      // The order fixes' checks read order intake columns this fixture leaves out; they run in
      // dropship-ebay-sync-back-orders.integration.test.ts.
      for (const check of DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.filter((entry) => !/^DROPSHIP_(EBAY_)?ORDER_/.test(entry.code))) {
        const countQuery = dialect.sqlToQuery(check.countSql);
        counted[check.code] = Number((await pool.query<{ count: number }>(countQuery.sql, countQuery.params)).rows[0]!.count);
        const sampleQuery = dialect.sqlToQuery(check.sampleSql);
        await pool.query(sampleQuery.sql, sampleQuery.params);
      }
      expect(counted).toEqual({
        DROPSHIP_MARKETPLACE_LISTING_NEEDS_REVIEW: 1, DROPSHIP_LISTING_POLICY_INCOMPATIBLE: 0, DROPSHIP_LISTING_ENDED_OUT_OF_STOCK: 0,
        DROPSHIP_MARKETPLACE_SYNC_QUANTITY_PENDING: 0, DROPSHIP_LISTING_QUANTITY_RESTORE_BLOCKED: 1, DROPSHIP_MARKETPLACE_SYNC_NOTICE_DEAD_LETTER: 0,
        DROPSHIP_MARKETPLACE_SYNC_CORRECTION_RATE: 0, DROPSHIP_LISTING_END_FAILED: 0, DROPSHIP_LISTING_END_STUCK: 0,
      });
    });

    it("counts and samples the listing ends that need a person and the ends that waited more than 7 days (PLAN-C v4.1 §5.7)", async () => {
      // A failed end, an end that ended, a fresh pending end, and a pending end of 8 days ago.
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await pool.query(`INSERT INTO dropship.dropship_listing_end_requests (listing_id, state, ended_at, vendor_id, store_connection_id,
          product_variant_id, code, context, decided_at, created_at) VALUES
        ($1, 'failed', NULL, ${VENDOR}, ${STORE}, 101, 'DROPSHIP_LISTING_END_REJECTED', '{"attemptIds": ["a-1", "a-2"]}', $3, $3),
        ($2, 'ended', $3, ${VENDOR}, ${STORE}, 102, NULL, '{}', $3, $3),
        ($4, 'pending', NULL, ${VENDOR}, ${STORE}, 103, NULL, '{}', NULL, now()),
        ($5, 'pending', NULL, ${VENDOR}, ${STORE}, 104, 'DROPSHIP_LISTING_END_STORE_NOT_CONNECTED', '{}', NULL, $6)`,
      [ids.live, ids.readEarlier, T1, ids.draft, ids.staged, eightDaysAgo]);
      const dialect = new PgDialect();
      const run = async (code: string) => {
        const check = DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.find((entry) => entry.code === code)!;
        const count = dialect.sqlToQuery(check.countSql);
        const sample = dialect.sqlToQuery(check.sampleSql);
        return { count: Number((await pool.query<{ count: number }>(count.sql, count.params)).rows[0]!.count),
          sample: (await pool.query(sample.sql, sample.params)).rows };
      };
      expect(await run("DROPSHIP_LISTING_END_FAILED")).toEqual({ count: 1, sample: [{ end_request_id: "1", vendor_id: VENDOR,
        store_connection_id: STORE, listing_id: ids.live, product_variant_id: 101, code: "DROPSHIP_LISTING_END_REJECTED",
        attempt_ids: ["a-1", "a-2"], decided_at: T1 }] });
      expect(await run("DROPSHIP_LISTING_END_STUCK")).toEqual({ count: 1, sample: [{ end_request_id: "4", vendor_id: VENDOR,
        store_connection_id: STORE, listing_id: ids.staged, state: "pending", code: "DROPSHIP_LISTING_END_STORE_NOT_CONNECTED",
        deferral_count: 0, created_at: eightDaysAgo }] });
      // Staff retry or resolve the failed end, and the stuck one moves on: both clear.
      await pool.query(`UPDATE dropship.dropship_listing_end_requests SET state = 'resolved' WHERE state = 'failed'`);
      await pool.query(`UPDATE dropship.dropship_listing_end_requests SET state = 'superseded' WHERE id = 4`);
      expect((await run("DROPSHIP_LISTING_END_FAILED")).count).toBe(0);
      expect((await run("DROPSHIP_LISTING_END_STUCK")).count).toBe(0);
    });
  });
});
