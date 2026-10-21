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
  const fanOutPreview = async () => {
    const client = await database.pool.connect();
    try {
      // Caller-owned publication requires SERIALIZABLE read-write; the dry run is rolled back.
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const routed = await createTransactionScopedInventoryPublicationService(client, { logger: quiet })
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

  it("keeps whole-destination isolation for a channel destination with an unlinked selected row", async () => {
    // The channel eBay destination (target 3) links 101 but not its selected sibling 102.
    await sealDropshipMapping(database.pool, 3, F.variantId, "P5");
    await database.pool.query(`INSERT INTO channels.channel_listings(id,channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status)
      VALUES(2,67,102,'NEW','offer-NEW','listing-20','synced');
      UPDATE channels.channel_listings SET external_product_id='listing-20',external_variant_id='offer-P5' WHERE id=1`);
    const preview = await fanOutPreview();
    expect(preview.rows.filter(row => row.publicationTargetId === 3)).toEqual([]);
    expect(preview.blockedTargets?.find(entry => entry.publicationTargetId === 3)).toMatchObject({ isolation: "target",
      errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING", productVariantIds: [VARIANT_B] });
    // The Dropship destination is unaffected by the channel destination's isolation.
    expect(preview.rows.filter(row => row.publicationTargetId === targetId).map(row => row.productVariantId)).toEqual([F.variantId]);
  });
});
