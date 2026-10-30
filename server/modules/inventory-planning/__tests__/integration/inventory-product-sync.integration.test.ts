import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installWalmartPublicationInventoryFixture, activateWalmartPublicationInventoryFixture, WALMART_INVENTORY_NOW } from "../fixtures/walmart-publication-inventory.fixture";
import { InventoryProductSyncService } from "../../application/inventory-product-sync.service";
import { PostgresInventoryProductSyncStore } from "../../infrastructure/inventory-product-sync.repository";
import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import type { InventoryPublicationTransportAdapter } from "../../application/inventory-publication-transport";

const runtime = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const product = { productId: 20 };
const firstKey = "11111111-1111-4111-8111-111111111111";
const secondKey = "22222222-2222-4222-8222-222222222222";
const thirdKey = "33333333-3333-4333-8333-333333333333";

dbDescribe.sequential("selected product ATP sync with real planning, transactions and publication", () => {
  let database: InventoryCutoverTestDatabase;
  let service: InventoryProductSyncService;
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    await installWalmartPublicationInventoryFixture(database.pool, { includeQuantityRecoveryMigrations: true });
    await database.pool.query(readFileSync(resolve("migrations/900000036000019340001_stock_links.sql"), "utf8"));
    await activateWalmartPublicationInventoryFixture(database.pool);
    await database.pool.query(`ALTER TABLE channels.sync_settings ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
      UPDATE channels.channels SET status='active' WHERE id=35;
      UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=1;
      INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id,channel_variant_id)
        VALUES(35,101,'P5','test-item','test-variant');
      INSERT INTO catalog.products(id,sku) VALUES(21,'UNSELECTED');
      INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(201,21,'UNSELECTED-P5');
      INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
        VALUES(11,100,201,13,0,0,0);`);
    service = new InventoryProductSyncService(new PostgresInventoryProductSyncStore(database.pool), () => WALMART_INVENTORY_NOW);
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; });

  const outbox = async () => (await database.pool.query(`SELECT id::text,publication_target_id,product_variant_id,
    desired_quantity::text,state,desired_revision::text FROM inventory.inventory_publication_outbox ORDER BY id`)).rows;
  const warehouseEvidence = async () => {
    const tables = ["inventory.inventory_levels", "inventory.inventory_lots", "inventory.inventory_transactions", "wms.order_items", "oms.order_item_costs"] as const;
    return Promise.all(tables.map(async table => ({ table, rows: (await database.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows })));
  };
  const prepare = async (idempotencyKey = firstKey) => ({ ...product,
    expectedReviewHash: (await service.review(product)).reviewHash, idempotencyKey });

  it("reviews without writes, then queues only this product across Shopify and Walmart using ATP", async () => {
    const before = await warehouseEvidence();
    const review = await service.review(product);
    expect(review.ready).toBe(true);
    expect(review.rows.filter(row => row.status === "ready")).toMatchObject([
      { publicationTargetId: 1, providerKey: "shopify", productVariantId: 101, quantity: "17" },
      { publicationTargetId: 2, providerKey: "walmart", productVariantId: 101, quantity: "17" },
    ]);
    expect(await outbox()).toEqual([]);
    expect((await database.pool.query("SELECT * FROM public.idempotency_keys WHERE key LIKE 'inventory-product-sync:%'")).rows).toEqual([]);
    const result = await service.sync({ ...product, expectedReviewHash: review.reviewHash, idempotencyKey: firstKey }, "operator");
    expect(result.receipt.rows).toHaveLength(2);
    expect(await outbox()).toMatchObject([
      { publication_target_id: 1, product_variant_id: 101, desired_quantity: "17", state: "queued" },
      { publication_target_id: 2, product_variant_id: 101, desired_quantity: "17", state: "queued" },
    ]);
    expect(await warehouseEvidence()).toEqual(before);
    const audits = (await database.pool.query("SELECT actor,changes,context FROM public.audit_events WHERE action='inventory_availability.product.synced'")).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "operator", context: { productId: 20, providerWriteAttempted: false } });
  });

  it("isolates a missing Shopify stock link and still queues the safe Walmart destination", async () => {
    await database.pool.query("UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=NULL,revision=revision+1 WHERE publication_target_id=1");
    const review = await service.review(product);
    expect(review.ready).toBe(true);
    const blocked = review.rows.find(row => row.publicationTargetId === 1 && row.productVariantId === 101);
    expect(blocked).toMatchObject({ status: "blocked", quantity: null });
    expect(blocked?.blockers.join(" ")).toContain("PUBLICATION_TARGET_VARIANT_MAPPING_MISSING");
    const result = await service.sync({ ...product, expectedReviewHash: review.reviewHash, idempotencyKey: firstKey }, "operator");
    expect(result.receipt.rows).toMatchObject([{ publicationTargetId: 2, productVariantId: 101 }]);
    expect(result.receipt.rows).toHaveLength(1);
    expect(result.receipt.targets.find(target => target.publicationTargetId === 1)?.status).toBe("blocked");
    expect(await outbox()).toMatchObject([{ publication_target_id: 2, product_variant_id: 101 }]);
    expect(await outbox()).toHaveLength(1);
  });

  it("refuses a global pause and detects a pause made after review before committing any stock", async () => {
    const command = await prepare();
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=false,revision=revision+1");
    const review = await service.review(product);
    expect(review.ready).toBe(false);
    expect(review.blockers.join(" ").toLowerCase()).toContain("paused");
    await expect(service.sync(command, "operator")).rejects.toMatchObject({ code: "PRODUCT_SYNC_REVIEW_STALE" });
    await expect(service.sync(await prepare(), "operator")).rejects.toMatchObject({ code: "PRODUCT_SYNC_BLOCKED" });
    expect(await outbox()).toEqual([]);
  });

  it("keeps a missing-link sibling in the receipt while publishing linked variants of the same destination", async () => {
    await database.pool.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id,channel_variant_id)
      VALUES(35,102,'NEW','unlinked-item','unlinked-variant');`);
    const review = await service.review(product);
    expect(review.ready).toBe(true);
    expect(review.rows.find(row => row.publicationTargetId === 1 && row.productVariantId === 101)?.status).toBe("ready");
    expect(review.rows.find(row => row.publicationTargetId === 1 && row.productVariantId === 102)).toMatchObject({
      status: "blocked", sku: "NEW", blockers: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"],
    });
    const result = await service.sync({ ...product, expectedReviewHash: review.reviewHash, idempotencyKey: firstKey }, "operator");
    expect(result.receipt.rows.map(row => [row.publicationTargetId, row.productVariantId])).toEqual([[1, 101], [2, 101]]);
    expect(result.receipt.blockedRows).toMatchObject([{ publicationTargetId: 1, productVariantId: 102,
      sku: "NEW", blockers: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"] }]);
    expect((await service.progress(firstKey)).receipt.blockedRows).toEqual(result.receipt.blockedRows);
  });

  it("shows saved stock-link diagnostics without invalidating a review when only the next check time changes", async () => {
    await database.pool.query(`UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=NULL,revision=revision+1 WHERE publication_target_id=1;
      INSERT INTO inventory.stock_link_checks(publication_target_id,product_variant_id,status,reason_code,next_check_at,created_at,updated_at)
      VALUES(1,101,'waiting','STOCK_LINK_NOT_ON_SALE','2026-09-28T12:00:00Z','2026-09-27T12:00:00Z','2026-09-27T12:00:00Z');`);
    const review = await service.review(product);
    const blocked = review.rows.find(row => row.publicationTargetId === 1 && row.productVariantId === 101);
    expect(blocked?.blockers.join(" ")).toContain("STOCK_LINK_NOT_ON_SALE");
    expect(blocked?.blockers.join(" ")).toContain("Last saved");
    await database.pool.query("UPDATE inventory.stock_link_checks SET next_check_at='2026-09-29T12:00:00Z',updated_at='2026-09-28T12:00:00Z',revision=revision+1 WHERE publication_target_id=1");
    const refreshed = await service.review(product);
    expect(refreshed.reviewHash).toBe(review.reviewHash);
    expect(refreshed.rows.find(row => row.publicationTargetId === 1)?.blockers.join(" ")).toContain("2026-09-29");
    const result = await service.sync({ ...product, expectedReviewHash: review.reviewHash, idempotencyKey: firstKey }, "operator");
    expect(result.receipt.rows.map(row => row.publicationTargetId)).toEqual([2]);
    expect(result.receipt.blockedRows?.[0].blockers.join(" ")).toContain("STOCK_LINK_NOT_ON_SALE");
  });

  it("applies each destination's active share, holdback and publication cap", async () => {
    await database.pool.query(`INSERT INTO inventory.channel_exposure_policy_versions(scope_key,channel_id,scope_type,version,
      allocation_semantics,eligible,share_bps,holdback_sellable_units,max_publish_mode,max_publish_sellable_units,
      min_publish_sellable_units,definition_hash,supersedes_policy_id,change_reason,idempotency_key,request_hash,created_by)
      VALUES('channel:36',36,'channel',2,'exposure',true,5000,2,'units',5,0,repeat('b',64),
        (SELECT active_policy_id FROM inventory.channel_exposure_policy_heads WHERE scope_key='channel:36'),
        'Reviewed channel stock policy','product-sync-capped-policy',repeat('b',64),'operator');
      UPDATE inventory.channel_exposure_policy_heads SET draft_policy_id=(SELECT id FROM inventory.channel_exposure_policy_versions
        WHERE idempotency_key='product-sync-capped-policy'),revision=revision+1 WHERE scope_key='channel:36';
      UPDATE inventory.channel_exposure_policy_versions SET lifecycle_status='sealed',sealed_by='operator',sealed_at=transaction_timestamp()
        WHERE idempotency_key='product-sync-capped-policy';
      UPDATE inventory.channel_exposure_policy_heads SET active_policy_id=(SELECT id FROM inventory.channel_exposure_policy_versions
        WHERE idempotency_key='product-sync-capped-policy'),draft_policy_id=NULL,revision=revision+1 WHERE scope_key='channel:36';`);
    const review = await service.review(product);
    // ATP is 17. Walmart receives min(floor(17 * 0.5) - 2, 5); Shopify retains its own 100% policy.
    expect(review.rows.filter(row => row.status === "ready").map(row => [row.publicationTargetId, row.quantity])).toEqual([[1, "17"], [2, "5"]]);
    const result = await service.sync({ ...product, expectedReviewHash: review.reviewHash, idempotencyKey: firstKey }, "operator");
    expect(result.receipt.rows.map(row => [row.publicationTargetId, row.quantity])).toEqual([[1, "17"], [2, "5"]]);
  });

  it("preserves retained listing zero duties when inventory is no longer managed", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET track_inventory=false,inventory_tracking_override=false WHERE product_id=20");
    const before = await warehouseEvidence();
    const review = await service.review(product);
    expect(review.ready).toBe(true);
    expect(review.rows.filter(row => row.status === "ready").map(row => [row.publicationTargetId, row.quantity])).toEqual([[1, "0"], [2, "0"]]);
    const result = await service.sync({ ...product, expectedReviewHash: review.reviewHash, idempotencyKey: firstKey }, "operator");
    expect(result.receipt.rows.map(row => row.quantity)).toEqual(["0", "0"]);
    expect(await warehouseEvidence()).toEqual(before);
  });

  it("refuses positive publication and an empty success when the catalog product is archived", async () => {
    await database.pool.query("UPDATE catalog.products SET is_active=false,status='archived' WHERE id=20");
    const review = await service.review(product);
    expect(review.ready).toBe(false);
    expect(review.rows.filter(row => row.status === "ready" && row.quantity !== "0")).toEqual([]);
    await expect(service.sync(await prepare(), "operator")).rejects.toMatchObject({ code: "PRODUCT_SYNC_BLOCKED" });
    expect(await outbox()).toEqual([]);
  });

  it("reports no eligible destinations without creating a successful empty receipt", async () => {
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='disabled',activated_at=NULL,activated_by=NULL,revision=revision+1");
    expect((await service.review(product)).ready).toBe(false);
    await expect(service.sync(await prepare(), "operator")).rejects.toMatchObject({ code: "PRODUCT_SYNC_BLOCKED" });
    expect(await outbox()).toEqual([]);
  });

  it("detects changed stock and target controls between review and sync", async () => {
    const stockCommand = await prepare();
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=19 WHERE product_variant_id=101");
    await expect(service.sync(stockCommand, "operator")).rejects.toMatchObject({ code: "PRODUCT_SYNC_REVIEW_STALE" });
    const targetCommand = await prepare();
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET held_at=transaction_timestamp(),held_by='operator',hold_reason='Count in progress',revision=revision+1 WHERE id=1");
    await expect(service.sync(targetCommand, "operator")).rejects.toMatchObject({ code: "PRODUCT_SYNC_REVIEW_STALE" });
    expect(await outbox()).toEqual([]);
  });

  it("serializes concurrent retries and binds the one saved receipt to its requesting actor", async () => {
    const command = await prepare();
    const results = await Promise.all([service.sync(command, "operator"), service.sync(command, "operator")]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(results[0].receipt).toEqual(results[1].receipt);
    expect(await outbox()).toHaveLength(2);
    expect((await database.pool.query("SELECT * FROM public.audit_events WHERE action='inventory_availability.product.synced'")).rowCount).toBe(1);
    await expect(service.sync(command, "other-actor")).rejects.toMatchObject({ code: "PRODUCT_SYNC_COMMAND_CONFLICT" });
    await expect(service.sync({ ...command, productId: 21 }, "operator")).rejects.toMatchObject({ code: "PRODUCT_SYNC_COMMAND_CONFLICT" });
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=19 WHERE product_variant_id=101");
    expect(await service.sync(command, "operator")).toEqual({ receipt: results[0].receipt, replayed: true });
  });

  it("publishes genuine zero availability through both destinations", async () => {
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=3 WHERE product_variant_id=101; UPDATE inventory.inventory_lots SET qty_on_hand=3 WHERE product_variant_id=101");
    const review = await service.review(product);
    expect(review.rows.filter(row => row.status === "ready").map(row => row.quantity)).toEqual(["0", "0"]);
    const result = await service.sync({ ...product, expectedReviewHash: review.reviewHash, idempotencyKey: firstKey }, "operator");
    expect(result.receipt.rows.map(row => row.quantity)).toEqual(["0", "0"]);
  });

  it("rolls back all destinations and audit when receipt persistence fails, then recovers with the same key", async () => {
    const command = await prepare();
    await database.pool.query(`CREATE FUNCTION public.refuse_product_sync_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic product receipt failure'; END $$;
      CREATE TRIGGER refuse_product_sync_receipt BEFORE INSERT ON public.idempotency_keys FOR EACH ROW EXECUTE FUNCTION public.refuse_product_sync_receipt();`);
    await expect(service.sync(command, "operator")).rejects.toThrow("synthetic product receipt failure");
    expect(await outbox()).toEqual([]);
    expect((await database.pool.query("SELECT * FROM public.audit_events WHERE action='inventory_availability.product.synced'")).rows).toEqual([]);
    await database.pool.query("DROP TRIGGER refuse_product_sync_receipt ON public.idempotency_keys");
    expect((await service.sync(command, "operator")).replayed).toBe(false);
    expect(await outbox()).toHaveLength(2);
  });

  it("tracks each exact receipt row, coalesces pending work, and refreshes verified stock on an explicit new sync", async () => {
    const first = await service.sync(await prepare(), "operator");
    const second = await service.sync(await prepare(secondKey), "operator");
    expect(second.receipt.rows.map(row => row.outboxId)).toEqual(first.receipt.rows.map(row => row.outboxId));
    const publish = vi.fn<InventoryPublicationTransportAdapter["publishAbsolute"]>(async input => ({ publishedQuantity: input.desiredQuantity, providerResponse: { accepted: true } }));
    const read = vi.fn<InventoryPublicationTransportAdapter["readAbsolute"]>(async () => ({ observedQuantity: 17, providerResponse: { quantity: 17 } }));
    const worker = new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(database.pool), {
      get: (_destination, providerKey) => ({ destinationKind: "channel_connection", providerKey,
        supportedScopeTypes: ["location"], publishAbsolute: publish, readAbsolute: read }),
    }, { now: () => new Date() }, () => "product-sync-worker", new PostgresQuantityPublicationAdmission(database.pool));
    expect((await worker.processDue()).verified).toBe(2);
    const status = await service.progress(firstKey);
    expect(status.rows).toMatchObject([
      { publicationTargetId: 1, productVariantId: 101, state: "verified", observedQuantity: "17" },
      { publicationTargetId: 2, productVariantId: 101, state: "verified", observedQuantity: "17" },
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
    const refreshed = await service.sync(await prepare(thirdKey), "operator");
    expect(refreshed.receipt.rows.map(row => row.revision)).toEqual(["2", "2"]);
    expect(refreshed.receipt.rows.every(row => !first.receipt.rows.some(previous => previous.outboxId === row.outboxId))).toBe(true);
    expect((await service.progress(firstKey)).receipt).toEqual(first.receipt);
    expect((await worker.processDue()).verified).toBe(2);
  });

  it("retains a mismatched provider readback as unresolved evidence instead of claiming success", async () => {
    const first = await service.sync(await prepare(), "operator");
    const worker = new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(database.pool), {
      get: (_destination, providerKey) => ({ destinationKind: "channel_connection", providerKey,
        supportedScopeTypes: ["location"],
        publishAbsolute: async input => ({ publishedQuantity: input.desiredQuantity, providerResponse: {} }),
        readAbsolute: async () => ({ observedQuantity: 0, providerResponse: { quantity: 0 } }) }),
    }, { now: () => new Date() }, () => "product-sync-mismatch", new PostgresQuantityPublicationAdmission(database.pool));
    expect((await worker.processDue()).verified).toBe(0);
    const progress = await service.progress(firstKey);
    expect(progress.rows).toHaveLength(2);
    expect(progress.rows.every(row => row.state === "queued" && row.observedQuantity === "0" && row.errorCode === "PROVIDER_READBACK_MISMATCH")).toBe(true);
    const retry = await service.sync(await prepare(secondKey), "operator");
    expect(retry.receipt.rows.map(row => row.outboxId)).toEqual(first.receipt.rows.map(row => row.outboxId));
    expect(await outbox()).toHaveLength(2);
  });
});
