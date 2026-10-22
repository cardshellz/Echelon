import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import {
  DROPSHIP_EBAY_STOCK as F, addDropshipLivePush, createDropshipEbayTarget, installDropshipEbayStockFixture, sealDropshipMapping,
} from "../fixtures/dropship-ebay-stock.fixture";
import {
  createAuthorityAwareInventoryPublicationService, createTransactionScopedInventoryPublicationService,
} from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { PostgresPublicationSelectionWork } from "../../infrastructure/publication-selection-work.repository";
import { publishOperationalShipmentInsideTransaction } from "../../infrastructure/inventory-availability-dispatch-publication";

// P4 (PLAN-F2-v2 section 9.2, C3b, owner decision Q6 = Yes). Variant A (101) is a
// linked live Dropship eBay listing; its sibling B (102) has a saved live push
// that failed before eBay gave it an identity, so B is selected but has no stock
// link. Before row isolation every stock change froze A at its old quantity.
const runtime = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const VARIANT_B = 102;

dbDescribe.sequential("row isolation for a Dropship eBay destination, real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let targetId: number;
  const outbox = async (variantId: number, publicationTargetId = targetId) => (await database.pool.query<{ desired_revision: string; desired_quantity: number; state: string }>(
    `SELECT desired_revision::text,desired_quantity::int,state FROM inventory.inventory_publication_outbox
     WHERE publication_target_id=$1 AND product_variant_id=$2 ORDER BY desired_revision`, [publicationTargetId, variantId])).rows;
  const decrementStock = (units: number) => database.pool.query(`UPDATE inventory.inventory_levels SET variant_qty=variant_qty-$1 WHERE product_variant_id=101;
    UPDATE inventory.inventory_lots SET qty_on_hand=qty_on_hand-$1 WHERE product_variant_id=101`.replaceAll("$1", String(units)));
  const fanOutPreview = async (logger: typeof quiet = quiet) => {
    const client = await database.pool.connect();
    try {
      // Caller-owned publication requires SERIALIZABLE read-write; the dry run is rolled back.
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const routed = await createTransactionScopedInventoryPublicationService(client, { logger })
        .publishProduct({ productId: F.productId, dryRun: true, triggeredBy: "row_isolation_test", blockedTargets: "isolate" },
          async () => { throw new Error("Canonical publication is required."); });
      await client.query("ROLLBACK");
      if (routed.authority !== "canonical") throw new Error("Canonical publication is required.");
      return routed.publication;
    } finally { client.release(); }
  };

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    await installDropshipEbayStockFixture(database.pool);
    targetId = await createDropshipEbayTarget(database.pool);
    await sealDropshipMapping(database.pool, targetId, F.variantId, F.sku);
    await addDropshipLivePush(database.pool, { listingId: 1, productVariantId: F.variantId, sku: F.sku, jobId: 1, jobItemId: 1,
      status: "completed", externalListingId: "listing-A", externalOfferId: "offer-A", listingStatus: "active" });
    await addDropshipLivePush(database.pool, { listingId: 2, productVariantId: VARIANT_B, sku: "NEW", jobId: 2, jobItemId: 2,
      status: "failed", listingStatus: "failed" });
    // A's current canonical quantity, sent through the exact single-listing path.
    await createAuthorityAwareInventoryPublicationService(database.pool, { logger: quiet }).publishProduct({ productId: F.productId,
      publicationTargetId: targetId, productVariantIds: [F.variantId], dryRun: false, triggeredBy: "fixture_initial_quantity" }, async () => null);
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; });

  it("selects the unlinked sibling for publication and reports only its row", async () => {
    expect(await outbox(F.variantId)).toEqual([{ desired_revision: "1", desired_quantity: 17, state: "queued" }]);
    const preview = await fanOutPreview();
    expect(preview.rows.filter(row => row.publicationTargetId === targetId).map(row => [row.productVariantId, row.desiredQuantity]))
      .toEqual([[F.variantId, "17"]]);
    expect(preview.blockedTargets?.filter(entry => entry.publicationTargetId === targetId)).toEqual([{ publicationTargetId: targetId,
      channelId: F.policyChannelId, channelName: "Dropship OMS", errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING",
      blockerCodes: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"], productVariantIds: [VARIANT_B], isolation: "rows" }]);
  });

  it("keeps publishing the linked listing's new quantity through selection-work replans and dispatch", async () => {
    await decrementStock(5);
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT inventory.invalidate_publication_selection_product($1)", [F.productId]);
      await client.query("COMMIT");
    } finally { client.release(); }
    const work = new PostgresPublicationSelectionWork(database.pool, () => new Date(Date.now() + 1_000));
    expect(await work.processDue()).toMatchObject({ skipped: 0 });
    expect(await outbox(F.variantId)).toEqual([
      { desired_revision: "1", desired_quantity: 17, state: "superseded" },
      { desired_revision: "2", desired_quantity: 12, state: "queued" },
    ]);
    expect(await outbox(VARIANT_B)).toEqual([]);
    // The unlinked row stays recorded for review on the work row.
    expect((await database.pool.query("SELECT outcome,error_code FROM inventory.publication_selection_attempts WHERE product_id=$1 ORDER BY id DESC LIMIT 1",
      [F.productId])).rows[0]).toMatchObject({ outcome: "blocked" });

    await decrementStock(2);
    const dispatch = await database.pool.connect();
    try {
      await dispatch.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await publishOperationalShipmentInsideTransaction({ client: dispatch, request: { productVariantId: F.variantId } } as never);
      await dispatch.query("COMMIT");
    } catch (error) { await dispatch.query("ROLLBACK"); throw error; }
    finally { dispatch.release(); }
    expect((await outbox(F.variantId)).at(-1)).toEqual({ desired_revision: "3", desired_quantity: 10, state: "queued" });
    expect(await outbox(VARIANT_B)).toEqual([]);
  });

  // Channels PR1 (PLAN-CH-v3 section 7, owner decision: one unlinked size must not freeze its
  // linked sizes). Each channel destination below sells three sizes of product 20: 101 and 103
  // are linked, 102 is selected but not linked. Every outbox row writes one item absolutely
  // (Shopify item at one location, Walmart SKU at the ship node, eBay SKU), so the linked
  // sizes publish and only 102 is withheld, logged and recorded. Any other blocker still
  // withholds the whole destination.
  const channelDestinations = [
    { label: "Shopify location", targetId: 1, channelId: 35, items: { 101: "test-item", 103: "item-103" } },
    { label: "Walmart ship node", targetId: 2, channelId: 36, items: { 101: "P5", 103: "UNCERTAIN" } },
    { label: "Card Shellz eBay account", targetId: 3, channelId: 67, items: { 101: "P5", 103: "UNCERTAIN" } },
  ] as const;
  const sellThreeSizes = async (destination: typeof channelDestinations[number]) => {
    if (destination.channelId === 67) {
      await database.pool.query(`UPDATE channels.channel_listings SET external_product_id='listing-20',external_sku='P5' WHERE id=1;
        INSERT INTO channels.channel_listings(id,channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status)
        VALUES(2,67,102,'NEW','offer-NEW','listing-20','synced'),(3,67,103,'UNCERTAIN','offer-UNCERTAIN','listing-20','synced')`);
    } else {
      // Shopify and Walmart select a size through its active channel feed.
      await database.pool.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id,is_active)
        SELECT $1,v.id,v.sku,v.sku,1 FROM catalog.product_variants v
        WHERE v.id IN (101,102,103) AND NOT EXISTS (SELECT 1 FROM channels.channel_feeds f WHERE f.channel_id=$1 AND f.product_variant_id=v.id)`,
      [destination.channelId]);
    }
    await database.pool.query("UPDATE channels.channels SET status='active' WHERE id=$1", [destination.channelId]);
    for (const [variantId, item] of Object.entries(destination.items)) {
      const linked = await database.pool.query(`SELECT 1 FROM inventory.publication_variant_mapping_heads
        WHERE publication_target_id=$1 AND product_variant_id=$2 AND active_mapping_id IS NOT NULL`, [destination.targetId, Number(variantId)]);
      if (!linked.rowCount) await sealDropshipMapping(database.pool, destination.targetId, Number(variantId), item);
    }
    await database.pool.query(`UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1
      WHERE id=$1 AND state<>'live'`, [destination.targetId]);
  };

  it.each(channelDestinations)("publishes the two linked sizes of a channel $label destination and withholds only the unlinked one", async (destination) => {
    await sellThreeSizes(destination);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const preview = await fanOutPreview(logger);
    expect(preview.rows.filter(row => row.publicationTargetId === destination.targetId)
      .map(row => [row.productVariantId, row.externalInventoryItemId])).toEqual([[101, destination.items[101]], [103, destination.items[103]]]);
    expect(preview.blockedTargets?.filter(entry => entry.publicationTargetId === destination.targetId)).toEqual([expect.objectContaining({
      errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING", blockerCodes: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"],
      productVariantIds: [VARIANT_B], isolation: "rows" })]);
    // The withheld size stays visible: the run logs it by id. (A caller-owned transaction's
    // publisher reports through warn, marked pending_commit; see its factory.)
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "canonical_inventory_publication_target_isolated",
      outcome: "rows_skipped", isolation: "rows", error_code: "CANONICAL_PUBLICATION_MAPPING_MISSING",
      publicationTargetId: destination.targetId, productVariantIds: [VARIANT_B], transactionState: "pending_commit" }));
    // The Dropship destination is unaffected.
    expect(preview.rows.filter(row => row.publicationTargetId === targetId).map(row => row.productVariantId)).toEqual([F.variantId]);
  });

  it.each(channelDestinations)("still withholds the whole channel $label destination when a linked size has another blocker", async (destination) => {
    await sellThreeSizes(destination);
    // A quarantined saved channel identity of linked size 103 is a selection blocker, not a missing link.
    // (eBay selects through its listing, so its feed row exists only to carry the quarantine.)
    await database.pool.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id,is_active)
      SELECT $1,103,'UNCERTAIN','UNCERTAIN',1 WHERE NOT EXISTS (SELECT 1 FROM channels.channel_feeds WHERE channel_id=$1 AND product_variant_id=103)`,
    [destination.channelId]);
    await database.pool.query("UPDATE channels.channel_feeds SET quarantined_at=transaction_timestamp() WHERE channel_id=$1 AND product_variant_id=103",
      [destination.channelId]);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const preview = await fanOutPreview(logger);
    expect(preview.rows.filter(row => row.publicationTargetId === destination.targetId)).toEqual([]);
    expect(preview.blockedTargets?.find(entry => entry.publicationTargetId === destination.targetId)).toMatchObject({ isolation: "target",
      blockerCodes: ["CHANNEL_SELECTION_MAPPING_QUARANTINED", "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"], productVariantIds: [VARIANT_B, 103] });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "canonical_inventory_publication_target_isolated",
      outcome: "target_skipped", isolation: "target", publicationTargetId: destination.targetId }));
    expect(preview.rows.filter(row => row.publicationTargetId === targetId).map(row => row.productVariantId)).toEqual([F.variantId]);
  });
});
