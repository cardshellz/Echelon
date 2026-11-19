import pg, { type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { DropshipError } from "../../domain/errors";
import { quantitySalesWindows } from "../../domain/marketplace-quantity-decision";
import { marketplaceSyncNotice } from "../../domain/marketplace-sync-decision";
import { marketplaceSyncOursFromHistory, storedIntentSentText } from "../../domain/marketplace-sync-history";
import {
  setFulfillmentPolicyNotifiedVerdictWithClient,
  upsertFulfillmentPolicyCheckWithClient,
} from "../../infrastructure/dropship-ebay-fulfillment-policy-checks.repository";
import {
  markMarketplaceSaleOrderCancelledWithClient,
  recordMarketplaceSaleLinesWithClient,
  startMarketplaceSalesLedgerWithClient,
  sumMarketplaceSalesWithClient,
} from "../../infrastructure/dropship-listing-marketplace-sales.repository";
import {
  applyMarketplaceListingStatusWithClient,
  applyVendorQuantityLimitWithClient,
  clearQuantityObservationWithClient,
  insertMarketplaceSyncedEventWithClient,
  markListingsMarketplaceSyncDueWithClient,
  readMarketplaceListingSyncStateWithClient,
  readMarketplaceSyncEventsWithClient,
  readNewestCompletedListingIntentWithClient,
  readNewestMarketplaceSyncEventIdWithClient,
  recordMarketplaceObservedFieldsWithClient,
  recordMarketplaceSyncAttemptWithClient,
  saveQuantityObservationWithClient,
  updateMarketplaceIssueCodesWithClient,
} from "../../infrastructure/dropship-marketplace-listing-sync-state.repository";
import {
  recordPreviousMarketplaceIdWithClient,
} from "../../infrastructure/dropship-marketplace-previous-ids.repository";
import {
  claimMarketplaceSyncNoticeBatchesWithClient,
  enqueueMarketplaceSyncNoticesWithClient,
  listUnsentMarketplaceSyncNoticeBatchesWithClient,
  markMarketplaceSyncNoticeBatchSentWithClient,
} from "../../infrastructure/dropship-marketplace-sync-notices.repository";
import {
  expireUnmatchedOrderLinesWithClient,
  parkUnmatchedOrderLineWithClient,
  resolveUnmatchedOrderLineWithClient,
  UNMATCHED_ORDER_EXPIRY_MS,
} from "../../infrastructure/dropship-unmatched-marketplace-orders.repository";
import { ebaySyncBackBaseFixtureSql, installEbaySyncBackSchema } from "../fixtures/ebay-sync-back.fixture";

/**
 * eBay sync-back's repositories against a real PostgreSQL (plan v4 §11 PG):
 * every write is idempotent or a compare-and-set, audit rows commit with
 * their change, and concurrent writers serialize instead of double-writing.
 */
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const VENDOR = 10;
const STORE = 22;
const OTHER_VENDOR = 11;
const OTHER_STORE = 23;
const T0 = new Date("2026-10-22T09:00:00.000Z");
const T1 = new Date("2026-10-22T12:00:00.000Z");
const MINUTE = 60_000;

describeDatabase.sequential("eBay sync-back repositories (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;
  let wide: pg.Pool;
  let listing = 0;
  let otherListing = 0;
  let foreignListing = 0;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, ebaySyncBackBaseFixtureSql);
    pool = database.pool;
    wide = new pg.Pool({ connectionString: database.connectionString, max: 4 });
    await installEbaySyncBackSchema(pool);
  }, 120_000);

  afterAll(async () => {
    await wide?.end();
    await database?.close();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE dropship.dropship_marketplace_sync_notices, dropship.dropship_ebay_fulfillment_policy_checks,
      dropship.dropship_unmatched_marketplace_orders, dropship.dropship_listing_previous_marketplace_ids,
      dropship.dropship_listing_marketplace_sales, dropship.dropship_listing_sync_events, dropship.dropship_listing_push_job_items,
      dropship.dropship_listing_push_jobs, dropship.dropship_audit_events, dropship.dropship_vendor_listings,
      dropship.dropship_store_connections, dropship.dropship_vendors, catalog.product_variants, catalog.products RESTART IDENTITY CASCADE`);
    await pool.query(`
      INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (${VENDOR}, 'member-10'), (${OTHER_VENDOR}, 'member-11');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, last_order_sync_at)
        VALUES (${STORE}, ${VENDOR}, 'ebay', '2026-10-22T12:02:00Z'), (${OTHER_STORE}, ${OTHER_VENDOR}, 'ebay', NULL);
      INSERT INTO catalog.products (id) VALUES (20);
      INSERT INTO catalog.product_variants (id, product_id, sku) VALUES (101, 20, 'CS-101'), (102, 20, 'CS-102'), (103, 20, 'CS-103');`);
    const insert = async (store: number, vendor: number, variant: number, itemNumber: string) => (await pool.query<{ id: number }>(`
      INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id,
        external_offer_id, status, pushed_quantity, last_pushed_at) VALUES ($1, $2, $3, 'ebay', $4, $6, 'active', 10, $5)
      RETURNING id`, [vendor, store, variant, itemNumber, T0, `OFFER-${variant}`])).rows[0]!.id;
    listing = await insert(STORE, VENDOR, 101, "110000000001");
    otherListing = await insert(STORE, VENDOR, 102, "110000000002");
    foreignListing = await insert(OTHER_STORE, OTHER_VENDOR, 103, "110000000003");
  });

  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>, target: Pool | pg.Pool = pool): Promise<T> {
    const client = await target.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function audits(eventType?: string) {
    return (await pool.query(`SELECT event_type, actor_type, actor_id, entity_type, entity_id, payload FROM dropship.dropship_audit_events
      ${eventType ? "WHERE event_type = $1" : ""} ORDER BY id`, eventType ? [eventType] : [])).rows;
  }

  describe("listing sync state", () => {
    it("reads the listing's sync state, and locks it for update when asked", async () => {
      const state = await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing, { forUpdate: true }));
      expect(state).toMatchObject({ listingId: listing, vendorId: VENDOR, storeConnectionId: STORE, productVariantId: 101, platform: "ebay",
        status: "active", externalListingId: "110000000001", externalOfferId: "OFFER-101", pushedQuantity: 10, lastPushedAt: T0,
        issueCodes: [], vendorQuantityLimit: null, quantityBaseline: null, observedQuantity: null, marketplaceSyncAttemptedAt: null });
      expect(await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, 999_999))).toBeNull();
    });

    it("records attempts and marks listings due (NULL first)", async () => {
      await inTransaction((client) => recordMarketplaceSyncAttemptWithClient(client, listing, T1));
      expect((await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing)))!.marketplaceSyncAttemptedAt).toEqual(T1);
      expect(await inTransaction((client) => markListingsMarketplaceSyncDueWithClient(client, [listing, listing, otherListing]))).toBe(1);
      expect((await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing)))!.marketplaceSyncAttemptedAt).toBeNull();
      expect(await inTransaction((client) => markListingsMarketplaceSyncDueWithClient(client, []))).toBe(0);
    });

    it("records what eBay shows, keeping a known policy when the read has none", async () => {
      await inTransaction((client) => recordMarketplaceObservedFieldsWithClient(client, { listingId: listing, observedPriceCents: 1400,
        observedFulfillmentPolicyId: "F-9", syncedAt: T1 }));
      await inTransaction((client) => recordMarketplaceObservedFieldsWithClient(client, { listingId: listing, observedPriceCents: 1500,
        observedFulfillmentPolicyId: null, syncedAt: T1 }));
      expect(await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing))).toMatchObject({
        observedMarketplacePriceCents: 1500, observedFulfillmentPolicyId: "F-9", lastMarketplaceSyncAt: T1 });
    });

    it("adds and removes issue codes atomically, sorted, with drift_detected_at the first sighting of the open set", async () => {
      expect(await inTransaction((client) => updateMarketplaceIssueCodesWithClient(client, { listingId: listing,
        add: ["sku_changed", "ended_out_of_stock"], remove: [], at: T0 }))).toEqual(["ended_out_of_stock", "sku_changed"]);
      expect(await inTransaction((client) => updateMarketplaceIssueCodesWithClient(client, { listingId: listing,
        add: ["sku_changed", "offer_missing"], remove: ["ended_out_of_stock"], at: T1 }))).toEqual(["offer_missing", "sku_changed"]);
      expect((await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing)))!.driftDetectedAt).toEqual(T0);
      expect(await inTransaction((client) => updateMarketplaceIssueCodesWithClient(client, { listingId: listing,
        add: [], remove: ["offer_missing", "sku_changed"], at: T1 }))).toEqual([]);
      expect((await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing)))!.driftDetectedAt).toBeNull();
      await expect(inTransaction((client) => updateMarketplaceIssueCodesWithClient(client, { listingId: listing,
        add: ["made_up" as never], remove: [], at: T1 }))).rejects.toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_INVARIANT_FAILED" });
      await expect(inTransaction((client) => updateMarketplaceIssueCodesWithClient(client, { listingId: 999_999, add: [], remove: [], at: T1 })))
        .rejects.toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_LISTING_NOT_FOUND" });
    });
  });

  describe("quantity observation and the vendor's limit", () => {
    const observed = { quantity: 4, at: T1 };

    it("saves an observation only over the one expected, and clears only the one decided (SB4)", async () => {
      expect(await inTransaction((client) => saveQuantityObservationWithClient(client, { listingId: listing, observation: observed, expected: null }))).toBe(true);
      // A second writer that thought nothing was saved loses.
      expect(await inTransaction((client) => saveQuantityObservationWithClient(client, { listingId: listing,
        observation: { quantity: 3, at: new Date(T1.getTime() + MINUTE) }, expected: null }))).toBe(false);
      expect(await inTransaction((client) => clearQuantityObservationWithClient(client, { listingId: listing,
        expected: { quantity: 4, at: new Date(T1.getTime() + 1) } }))).toBe(false);
      expect((await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing)))!.observedQuantity).toEqual(observed);
      expect(await inTransaction((client) => clearQuantityObservationWithClient(client, { listingId: listing, expected: observed }))).toBe(true);
      expect((await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing)))!.observedQuantity).toBeNull();
    });

    const key = (quantity: number) => `ebay-sync:qty-limit:${listing}:${T1.getTime()}:${quantity}`;
    const apply = (client: PoolClient, input: { expectedLimit: number | null; change: { kind: "set"; limit: number } | { kind: "clear" };
      baseline: { quantity: number; at: Date } | null; decided?: { quantity: number; at: Date } }) => applyVendorQuantityLimitWithClient(client, {
      listingId: listing, decidedObservation: input.decided ?? observed, expectedLimit: input.expectedLimit, change: input.change,
      baseline: input.baseline, changedAt: new Date(T1.getTime() + 5 * MINUTE), idempotencyKey: key((input.decided ?? observed).quantity) });

    it("keeps eBay's number as the limit and its baseline, clears the observation, with one system audit row; a replay is a no-op", async () => {
      await inTransaction((client) => saveQuantityObservationWithClient(client, { listingId: listing, observation: observed, expected: null }));
      const set = () => inTransaction((client) => apply(client, { expectedLimit: null, change: { kind: "set", limit: 4 }, baseline: observed }));
      expect(await set()).toEqual({ applied: true });
      expect(await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing))).toMatchObject({
        vendorQuantityLimit: 4, quantityBaseline: { quantity: 4, at: T1 }, observedQuantity: null });
      expect(await set()).toEqual({ applied: false });
      expect(await audits("listing_quantity_limit_saved")).toEqual([{ event_type: "listing_quantity_limit_saved", actor_type: "system",
        actor_id: "system:ebay-sync-back", entity_type: "dropship_vendor_listing", entity_id: String(listing),
        payload: { before: { vendorQuantityLimit: null }, after: { vendorQuantityLimit: 4 }, observedQuantity: 4, observedAt: T1.toISOString(),
          idempotencyKey: key(4) } }]);
    });

    it("raises a limit and clears it (owner rule 1), and keeps the old baseline when a restore follows", async () => {
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET vendor_quantity_limit = 3, marketplace_quantity_baseline = 3,
        marketplace_quantity_baseline_at = $2, observed_marketplace_quantity = 6, observed_marketplace_quantity_at = $3 WHERE id = $1`,
      [listing, T0, T1]);
      const raised = { quantity: 6, at: T1 };
      expect(await inTransaction((client) => apply(client, { expectedLimit: 3, change: { kind: "set", limit: 6 }, baseline: raised, decided: raised })))
        .toEqual({ applied: true });
      expect(await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing))).toMatchObject({
        vendorQuantityLimit: 6, quantityBaseline: raised, observedQuantity: null });
      // eBay above ATP: the limit goes and the old baseline stays until the restore's publish becomes B.
      const above = { quantity: 25, at: new Date(T1.getTime() + MINUTE) };
      await inTransaction((client) => saveQuantityObservationWithClient(client, { listingId: listing, observation: above, expected: null }));
      expect(await inTransaction((client) => apply(client, { expectedLimit: 6, change: { kind: "clear" }, baseline: null, decided: above })))
        .toEqual({ applied: true });
      expect(await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing))).toMatchObject({
        vendorQuantityLimit: null, quantityBaseline: raised, observedQuantity: null });
      expect((await audits()).map((row) => [row.event_type, row.payload.before, row.payload.after])).toEqual([
        ["listing_quantity_limit_saved", { vendorQuantityLimit: 3 }, { vendorQuantityLimit: 6 }],
        ["listing_quantity_limit_cleared", { vendorQuantityLimit: 6 }, { vendorQuantityLimit: null }]]);
    });

    it("changes nothing when the limit is not the one the decision saw, or the observation was decided already", async () => {
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET vendor_quantity_limit = 3, observed_marketplace_quantity = 4,
        observed_marketplace_quantity_at = $2 WHERE id = $1`, [listing, T1]);
      expect(await inTransaction((client) => apply(client, { expectedLimit: null, change: { kind: "set", limit: 4 }, baseline: observed })))
        .toEqual({ applied: false });
      expect(await inTransaction((client) => apply(client, { expectedLimit: 3, change: { kind: "set", limit: 4 }, baseline: observed,
        decided: { quantity: 4, at: new Date(T1.getTime() + 1) } }))).toEqual({ applied: false });
      expect(await audits()).toEqual([]);
      expect((await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing)))!.vendorQuantityLimit).toBe(3);
    });

    it("serializes two decisions on one observation under the listing row lock: one applies, the other changes nothing", async () => {
      await inTransaction((client) => saveQuantityObservationWithClient(client, { listingId: listing, observation: observed, expected: null }));
      const first = await wide.connect();
      const second = await wide.connect();
      try {
        await first.query("BEGIN");
        await second.query("BEGIN");
        await readMarketplaceListingSyncStateWithClient(first, listing, { forUpdate: true });
        const waiting = (async () => {
          await readMarketplaceListingSyncStateWithClient(second, listing, { forUpdate: true });
          return apply(second, { expectedLimit: null, change: { kind: "set", limit: 4 }, baseline: observed });
        })();
        expect(await apply(first, { expectedLimit: null, change: { kind: "set", limit: 4 }, baseline: observed })).toEqual({ applied: true });
        await first.query("COMMIT");
        expect(await waiting).toEqual({ applied: false });
        await second.query("COMMIT");
      } finally {
        first.release();
        second.release();
      }
      expect(await audits("listing_quantity_limit_saved")).toHaveLength(1);
    });

    it("rolls a limit change back with its audit row, and refuses a limit that is not a whole number", async () => {
      await inTransaction((client) => saveQuantityObservationWithClient(client, { listingId: listing, observation: observed, expected: null }));
      await expect(inTransaction(async (client) => {
        await apply(client, { expectedLimit: null, change: { kind: "set", limit: 4 }, baseline: observed });
        throw new Error("injected failure after the write");
      })).rejects.toThrow("injected failure");
      expect((await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing)))).toMatchObject({
        vendorQuantityLimit: null, observedQuantity: observed });
      expect(await audits()).toEqual([]);
      await expect(inTransaction((client) => apply(client, { expectedLimit: null, change: { kind: "set", limit: -1 }, baseline: null })))
        .rejects.toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_INVARIANT_FAILED" });
    });
  });

  describe("listing status from a read", () => {
    it("ends a listing the vendor ended, once, with an audit row", async () => {
      const end = () => inTransaction((client) => applyMarketplaceListingStatusWithClient(client, { listingId: listing, at: T1,
        endListing: true, reactivate: false, relink: null }));
      expect(await end()).toEqual({ ended: true, reactivated: false, relinked: false });
      expect(await end()).toEqual({ ended: false, reactivated: false, relinked: false });
      expect(await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing))).toMatchObject({ status: "ended", marketplaceEndedAt: T1 });
      expect(await audits("listing_marketplace_ended")).toEqual([expect.objectContaining({ actor_type: "system",
        payload: { before: { status: "active" }, after: { status: "ended" } } })]);
    });

    it("reopens only a listing a read ended, and follows a relist only from the number still ours", async () => {
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET status = 'ended' WHERE id = $1`, [listing]);
      expect(await inTransaction((client) => applyMarketplaceListingStatusWithClient(client, { listingId: listing, at: T1, endListing: false,
        reactivate: true, relink: null }))).toEqual({ ended: false, reactivated: false, relinked: false });
      await pool.query(`UPDATE dropship.dropship_vendor_listings SET marketplace_ended_at = $2 WHERE id = $1`, [listing, T0]);
      expect(await inTransaction((client) => applyMarketplaceListingStatusWithClient(client, { listingId: listing, at: T1, endListing: false,
        reactivate: true, relink: { previousListingId: "110000000001", listingId: "110000000099" } })))
        .toEqual({ ended: false, reactivated: true, relinked: true });
      expect(await inTransaction((client) => readMarketplaceListingSyncStateWithClient(client, listing))).toMatchObject({
        status: "active", marketplaceEndedAt: null, externalListingId: "110000000099" });
      expect(await inTransaction((client) => applyMarketplaceListingStatusWithClient(client, { listingId: listing, at: T1, endListing: false,
        reactivate: false, relink: { previousListingId: "110000000001", listingId: "110000000777" } }))).toMatchObject({ relinked: false });
      expect((await audits()).map((row) => row.event_type)).toEqual(["listing_marketplace_relisted", "listing_marketplace_relinked"]);
    });
  });

  describe("sync events (SB3, SB4)", () => {
    it("reads the newest baseline event and the attempts after it, and records listing_marketplace_synced", async () => {
      const event = (type: string, payload: object) => pool.query(`INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type,
        source, payload, created_at) VALUES ($1, $2, 'test', $3::jsonb, $4)`, [listing, type, JSON.stringify(payload), T0]);
      await event("listing_push_completed", { priceCents: 900 });
      await event("listing_push_attempted", { priceCents: 950 });
      await event("listing_push_completed", { priceCents: 1100 });
      await event("listing_push_attempted", { priceCents: 1200 });
      await event("listing_push_failed", { priceCents: 9999 });
      await pool.query(`INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload)
        VALUES ($1, 'listing_push_attempted', 'test', '{"priceCents":7}')`, [otherListing]);
      const events = await inTransaction((client) => readMarketplaceSyncEventsWithClient(client, listing));
      expect(events.map((row) => [row.eventType, (row.payload as { priceCents: number }).priceCents]))
        .toEqual([["listing_push_completed", 1100], ["listing_push_attempted", 1200]]);
      expect(marketplaceSyncOursFromHistory({ events, storedIntent: null }).priceCents).toEqual({ baseline: 1100, attempted: [1200] });
      const id = await inTransaction((client) => insertMarketplaceSyncedEventWithClient(client, { listingId: listing, trigger: "sweep",
        observedAt: T1, externalListingId: "110000000001", externalOfferId: "OFFER-101", baseline: { priceCents: 1400, currency: "USD",
          sku: "CS-101", fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1" } }));
      expect(await inTransaction((client) => readNewestMarketplaceSyncEventIdWithClient(client, listing))).toBe(id);
      const after = await inTransaction((client) => readMarketplaceSyncEventsWithClient(client, listing));
      // S3: the newest completed push and the attempts after it stay in the read (hasUnsettledPushAttempt); Ours still
      // counts only the newest baseline (the synced event) and the attempts after it.
      expect(after).toEqual([expect.objectContaining({ eventType: "listing_push_completed" }),
        expect.objectContaining({ eventType: "listing_push_attempted" }),
        expect.objectContaining({ id, eventType: "listing_marketplace_synced",
          payload: expect.objectContaining({ priceCents: 1400, trigger: "sweep", externalOfferId: "OFFER-101" }) })]);
      expect(marketplaceSyncOursFromHistory({ events: after, storedIntent: null }).priceCents).toEqual({ baseline: 1400, attempted: [] });
    });

    it("has no events and no intent for a listing never pushed, and reads the newest completed intent", async () => {
      expect(await inTransaction((client) => readMarketplaceSyncEventsWithClient(client, otherListing))).toEqual([]);
      expect(await inTransaction((client) => readNewestMarketplaceSyncEventIdWithClient(client, foreignListing))).toBeNull();
      expect(await inTransaction((client) => readNewestCompletedListingIntentWithClient(client, listing))).toBeNull();
      const job = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs (vendor_id, store_connection_id)
        VALUES (${VENDOR}, ${STORE}) RETURNING id`)).rows[0]!.id;
      await pool.query(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id, product_variant_id, status, result) VALUES
        ($1, $2, 101, 'completed', '{"listingIntent":{"title":"Old"}}'),
        ($1, $2, 101, 'completed', '{"listingIntent":{"title":"New","description":"<p>New words</p>"}}'),
        ($1, $2, 101, 'failed', '{"listingIntent":{"title":"Failed"}}')`, [job, listing]);
      const intent = await inTransaction((client) => readNewestCompletedListingIntentWithClient(client, listing));
      expect(intent).toEqual({ title: "New", description: "<p>New words</p>" });
      // What Card Shellz last sent, for owner rule 2: exactly the newest completed push's text.
      expect(storedIntentSentText(intent)).toEqual({ title: "New", description: "<p>New words</p>" });
    });
  });

  describe("previous item numbers (§7.3)", () => {
    it("keeps an old number once, owned as the listing is", async () => {
      const record = () => inTransaction((client) => recordPreviousMarketplaceIdWithClient(client, { listingId: listing,
        externalListingId: "110000000000", reason: "relisted", replacedAt: T1 }));
      expect(await record()).toBe(true);
      expect(await record()).toBe(false);
      const row = (await pool.query(`SELECT vendor_id, store_connection_id FROM dropship.dropship_listing_previous_marketplace_ids`)).rows;
      expect(row).toEqual([{ vendor_id: VENDOR, store_connection_id: STORE }]);
      expect((await pool.query(`SELECT listing_id, external_listing_id, reason, replaced_at
        FROM dropship.dropship_listing_previous_marketplace_ids`)).rows).toEqual([
        { listing_id: listing, external_listing_id: "110000000000", reason: "relisted", replaced_at: T1 }]);
    });
  });

  describe("parked order lines (§7.3)", () => {
    const park = (overrides: Partial<Parameters<typeof parkUnmatchedOrderLineWithClient>[1]> = {}) => inTransaction((client) =>
      parkUnmatchedOrderLineWithClient(client, { storeConnectionId: STORE, externalOrderId: "O-1", externalLineItemId: "L-1",
        externalListingId: "119999999999", sku: "CS-101", candidateListingId: listing, reason: "unmatched_sku", orderedAt: T0, seenAt: T1, ...overrides }));

    it("parks a line once, owned by the store, and only on one of the store's own listings", async () => {
      expect(await park()).toBe(true);
      expect(await park()).toBe(false);
      expect(await park({ externalLineItemId: "L-2", candidateListingId: foreignListing })).toBe(false);
      const open = (await pool.query(`SELECT vendor_id, store_connection_id, external_order_id, status, candidate_listing_id,
          first_seen_at, resolved_at FROM dropship.dropship_unmatched_marketplace_orders`)).rows;
      expect(open).toEqual([{ vendor_id: VENDOR, store_connection_id: STORE, external_order_id: "O-1", status: "open",
        candidate_listing_id: listing, first_seen_at: T1, resolved_at: null }]);
    });

    it("resolves an open line once and expires lines after 30 days", async () => {
      await park();
      await park({ externalOrderId: "O-2", seenAt: new Date(T1.getTime() - UNMATCHED_ORDER_EXPIRY_MS + 1) });
      await park({ externalOrderId: "O-3", externalListingId: "118888888888", seenAt: new Date(T1.getTime() - UNMATCHED_ORDER_EXPIRY_MS) });
      const first = (await pool.query<{ id: number }>(`SELECT id FROM dropship.dropship_unmatched_marketplace_orders
        WHERE external_order_id = 'O-1'`)).rows[0]!;
      expect(await inTransaction((client) => resolveUnmatchedOrderLineWithClient(client, { id: first.id, resolution: "relinked", at: T1 }))).toBe(true);
      expect(await inTransaction((client) => resolveUnmatchedOrderLineWithClient(client, { id: first.id, resolution: "cancelled", at: T1 }))).toBe(false);
      expect(await inTransaction((client) => expireUnmatchedOrderLinesWithClient(client, T1))).toBe(1);
      const statuses = (await pool.query(`SELECT external_order_id, status FROM dropship.dropship_unmatched_marketplace_orders ORDER BY external_order_id`)).rows;
      expect(statuses).toEqual([{ external_order_id: "O-1", status: "relinked" }, { external_order_id: "O-2", status: "open" },
        { external_order_id: "O-3", status: "expired" }]);
    });
  });

  describe("shipping policy verdicts (§6.3)", () => {
    it("records a fresh verdict, keeps the verdict last told, and remembers a told verdict only while it stands", async () => {
      const upsert = (compatible: boolean, verdictHash: string) => inTransaction((client) => upsertFulfillmentPolicyCheckWithClient(client, {
        storeConnectionId: STORE, fulfillmentPolicyId: "F-9", compatible, issueCodes: ["local_pickup_unsupported", "local_pickup_unsupported"],
        verdictHash, checkedAt: T1 }));
      expect(await upsert(false, "a".repeat(64))).toEqual({ storeConnectionId: STORE, fulfillmentPolicyId: "F-9", compatible: false,
        issueCodes: ["local_pickup_unsupported"], verdictHash: "a".repeat(64), notifiedVerdictHash: null, checkedAt: T1 });
      expect(await inTransaction((client) => setFulfillmentPolicyNotifiedVerdictWithClient(client, { storeConnectionId: STORE,
        fulfillmentPolicyId: "F-9", verdictHash: "a".repeat(64), notifiedVerdictHash: "a".repeat(64) }))).toBe(true);
      expect((await upsert(false, "b".repeat(64))).notifiedVerdictHash).toBe("a".repeat(64));
      // The verdict moved on: remembering the old one does nothing.
      expect(await inTransaction((client) => setFulfillmentPolicyNotifiedVerdictWithClient(client, { storeConnectionId: STORE,
        fulfillmentPolicyId: "F-9", verdictHash: "a".repeat(64), notifiedVerdictHash: null }))).toBe(false);
      expect((await pool.query(`SELECT store_connection_id, fulfillment_policy_id
        FROM dropship.dropship_ebay_fulfillment_policy_checks`)).rows).toEqual([{ store_connection_id: STORE, fulfillment_policy_id: "F-9" }]);
    });
  });

  describe("the notice outbox (§6.6, SB24)", () => {
    const belowCost = (id: number, day: string) => marketplaceSyncNotice("price_below_cost", `below-cost:${id}:${day}`,
      { listingId: id, priceCents: 650, unitCostCents: 700 });
    const skuChanged = (id: number) => marketplaceSyncNotice("sku_changed", `listing:${id}:sku:abc`, { listingId: id });
    const enqueue = (notices: ReturnType<typeof marketplaceSyncNotice>[], createdAt: Date, store = STORE, vendor = VENDOR) =>
      inTransaction((client) => enqueueMarketplaceSyncNoticesWithClient(client, { vendorId: vendor, storeConnectionId: store, notices, createdAt }));

    it("writes a notice once per store, kind and subject", async () => {
      expect(await enqueue([belowCost(1, "2026-10-22"), skuChanged(1)], T1)).toBe(2);
      expect(await enqueue([belowCost(1, "2026-10-22"), skuChanged(1), belowCost(1, "2026-10-23")], T1)).toBe(1);
      expect(await enqueue([skuChanged(1)], T1, OTHER_STORE, OTHER_VENDOR)).toBe(1);
      expect(await enqueue([], T1)).toBe(0);
    });

    it("refuses a notice that does not match its kind, before writing anything", async () => {
      const wrong = { ...belowCost(1, "2026-10-22"), critical: true };
      await expect(enqueue([skuChanged(9), wrong], T1)).rejects.toBeInstanceOf(DropshipError);
      const removedKind = { kind: "price_kept", critical: false, subjectKey: "listing:1:price", payload: {} } as never;
      await expect(enqueue([removedKind], T1)).rejects.toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_INVARIANT_FAILED" });
      const huge = marketplaceSyncNotice("price_below_cost", "below-cost:1:big", { note: "x".repeat(9_000) });
      await expect(enqueue([huge], T1)).rejects.toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_INVARIANT_FAILED" });
      expect((await pool.query(`SELECT count(*)::int AS count FROM dropship.dropship_marketplace_sync_notices`)).rows[0]).toEqual({ count: 0 });
    });

    it("claims every row at once, one batch per store and kind; sends by key; a failed send is sent again by the same key", async () => {
      await enqueue([skuChanged(1), skuChanged(2), belowCost(1, "2026-10-22")], T1);
      const claimed = await inTransaction((client) => claimMarketplaceSyncNoticeBatchesWithClient(client));
      expect(claimed.map((batch) => [batch.batchKey, batch.noticeIds])).toEqual([
        ["ebay-sync:sku_changed:22:1-2", [1, 2]], ["ebay-sync:price_below_cost:22:3-3", [3]]]);
      expect(await inTransaction((client) => claimMarketplaceSyncNoticeBatchesWithClient(client))).toEqual([]);
      const unsent = await inTransaction((client) => listUnsentMarketplaceSyncNoticeBatchesWithClient(client, 10));
      expect(unsent.map((batch) => [batch.batchKey, batch.critical, batch.payloads.length])).toEqual([
        ["ebay-sync:sku_changed:22:1-2", true, 2], ["ebay-sync:price_below_cost:22:3-3", false, 1]]);
      // The send of the first batch fails: nothing is marked, and it is listed again with the same key.
      expect(await inTransaction((client) => markMarketplaceSyncNoticeBatchSentWithClient(client, { batchKey: unsent[1]!.batchKey, sentAt: T1 }))).toBe(1);
      expect((await inTransaction((client) => listUnsentMarketplaceSyncNoticeBatchesWithClient(client, 10))).map((batch) => batch.batchKey))
        .toEqual(["ebay-sync:sku_changed:22:1-2"]);
      expect(await inTransaction((client) => markMarketplaceSyncNoticeBatchSentWithClient(client, { batchKey: "ebay-sync:sku_changed:22:1-2", sentAt: T1 }))).toBe(2);
      expect(await inTransaction((client) => markMarketplaceSyncNoticeBatchSentWithClient(client, { batchKey: "ebay-sync:sku_changed:22:1-2", sentAt: T1 }))).toBe(0);
      // A row that commits after its kind's batch was claimed gets its own batch, never the sent batch's key.
      await enqueue([skuChanged(3)], T1);
      expect((await inTransaction((client) => claimMarketplaceSyncNoticeBatchesWithClient(client))).map((batch) => batch.batchKey))
        .toEqual(["ebay-sync:sku_changed:22:4-4"]);
    });

    it("never puts a row in two batches when two processes claim at once", async () => {
      await enqueue(Array.from({ length: 40 }, (_, index) => skuChanged(index + 1)), T1);
      const first = await wide.connect();
      const second = await wide.connect();
      try {
        await first.query("BEGIN");
        await second.query("BEGIN");
        const one = await claimMarketplaceSyncNoticeBatchesWithClient(first);
        const two = await claimMarketplaceSyncNoticeBatchesWithClient(second);
        await first.query("COMMIT");
        await second.query("COMMIT");
        expect(one.flatMap((batch) => batch.noticeIds)).toHaveLength(40);
        expect(two).toEqual([]);
      } finally {
        first.release();
        second.release();
      }
      const keys = (await pool.query(`SELECT count(DISTINCT batch_key)::int AS keys, count(*) FILTER (WHERE batch_key IS NULL)::int AS unclaimed
        FROM dropship.dropship_marketplace_sync_notices`)).rows[0];
      expect(keys).toEqual({ keys: 1, unclaimed: 0 });
    });
  });

  describe("the sales ledger (§6.4, SB30)", () => {
    const line = (order: string, quantity: number, orderedAt: Date, listingId = listing) =>
      ({ listingId, externalOrderId: order, externalLineItemId: `${order}-1`, quantity, orderedAt });

    it("records every line once, so a replayed poll adds nothing", async () => {
      const record = () => inTransaction((client) => recordMarketplaceSaleLinesWithClient(client, { storeConnectionId: STORE,
        lines: [line("O-1", 2, T0), line("O-2", 1, T1)], firstSeenAt: T1 }));
      expect(await record()).toBe(2);
      expect(await record()).toBe(0);
      expect(await inTransaction((client) => recordMarketplaceSaleLinesWithClient(client, { storeConnectionId: STORE, lines: [], firstSeenAt: T1 }))).toBe(0);
    });

    it("refuses lines on another store's listing or with no quantity, writing nothing", async () => {
      await expect(inTransaction((client) => recordMarketplaceSaleLinesWithClient(client, { storeConnectionId: STORE,
        lines: [line("O-1", 1, T0), line("O-9", 1, T0, foreignListing)], firstSeenAt: T1 }))).rejects.toMatchObject({
        code: "DROPSHIP_MARKETPLACE_SYNC_INVARIANT_FAILED", context: { classification: "permanent" } });
      await expect(inTransaction((client) => recordMarketplaceSaleLinesWithClient(client, { storeConnectionId: STORE,
        lines: [line("O-1", 0, T0)], firstSeenAt: T1 }))).rejects.toBeInstanceOf(DropshipError);
      expect((await pool.query(`SELECT count(*)::int AS count FROM dropship.dropship_listing_marketplace_sales`)).rows[0]).toEqual({ count: 0 });
    });

    it("sums all lines in the wide window and live lines in the narrow one, half-open, with a cancel counting only as all", async () => {
      const slackEdge = new Date(T0.getTime() - 5 * MINUTE);
      await inTransaction((client) => recordMarketplaceSaleLinesWithClient(client, { storeConnectionId: STORE, firstSeenAt: T1, lines: [
        line("EDGE", 9, slackEdge),                                   // exactly B_at - slack: outside both (half-open)
        line("NEAR", 2, new Date(T0.getTime() - 2 * MINUTE)),         // ambiguous: wide only
        line("SOLD", 3, new Date(T0.getTime() + 60 * MINUTE)),        // in both
        line("GONE", 4, new Date(T0.getTime() + 90 * MINUTE)),        // cancelled: wide only
        line("LATE", 1, new Date(T1.getTime() + 4 * MINUTE)),         // just after the read: wide only
        line("OTHER", 7, new Date(T0.getTime() + 60 * MINUTE), otherListing),
      ] }));
      expect(await inTransaction((client) => markMarketplaceSaleOrderCancelledWithClient(client, { storeConnectionId: STORE,
        externalOrderId: "GONE", cancelledAt: T1 }))).toBe(1);
      expect(await inTransaction((client) => markMarketplaceSaleOrderCancelledWithClient(client, { storeConnectionId: STORE,
        externalOrderId: "GONE", cancelledAt: new Date(T1.getTime() + MINUTE) }))).toBe(0);
      expect((await pool.query(`SELECT cancelled_at FROM dropship.dropship_listing_marketplace_sales WHERE external_order_id = 'GONE'`)).rows[0])
        .toEqual({ cancelled_at: T1 });
      const windows = quantitySalesWindows(T0, T1);
      expect(await inTransaction((client) => sumMarketplaceSalesWithClient(client, { listingId: listing, ...windows }))).toEqual({ all: 10, live: 3 });
      expect(await inTransaction((client) => sumMarketplaceSalesWithClient(client, { listingId: foreignListing, ...windows }))).toEqual({ all: 0, live: 0 });
    });

    it("starts the ledger once", async () => {
      expect(await inTransaction((client) => startMarketplaceSalesLedgerWithClient(client, { storeConnectionId: STORE, since: T0 }))).toBe(true);
      expect(await inTransaction((client) => startMarketplaceSalesLedgerWithClient(client, { storeConnectionId: STORE, since: T1 }))).toBe(false);
      expect((await pool.query(`SELECT marketplace_sales_ledger_since FROM dropship.dropship_store_connections WHERE id = $1`, [STORE])).rows)
        .toEqual([{ marketplace_sales_ledger_since: T0 }]);
    });
  });
});
