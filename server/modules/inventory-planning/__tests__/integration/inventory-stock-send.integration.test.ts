import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installWalmartPublicationInventoryFixture, activateWalmartPublicationInventoryFixture, WALMART_INVENTORY_NOW } from "../fixtures/walmart-publication-inventory.fixture";
import { InventoryStockSendService } from "../../application/inventory-stock-send.service";
import { PostgresInventoryStockSendStore } from "../../infrastructure/inventory-stock-send.repository";
import { createAuthorityAwareInventoryPublicationService } from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";

const runtime = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const selection = { productId: 20, publicationTargetId: 1, productVariantIds: [101] };
const key = "11111111-1111-4111-8111-111111111111";

dbDescribe.sequential("selected Shopify stock send with real canonical planning and outbox", () => {
  let database: InventoryCutoverTestDatabase;
  let service: InventoryStockSendService;
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    await installWalmartPublicationInventoryFixture(database.pool, { includeQuantityRecoveryMigrations: true });
    await activateWalmartPublicationInventoryFixture(database.pool);
    await database.pool.query(`ALTER TABLE channels.sync_settings ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
      UPDATE channels.channels SET status='active' WHERE id=35;
      UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=1;
      INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id,channel_variant_id)
        VALUES(35,101,'P5','test-item','test-variant');`);
    service = new InventoryStockSendService(new PostgresInventoryStockSendStore(database.pool), () => WALMART_INVENTORY_NOW);
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; });
  const outbox = async () => (await database.pool.query("SELECT id::text,publication_target_id,product_variant_id,desired_quantity::text,state FROM inventory.inventory_publication_outbox ORDER BY id")).rows;
  const prepare = async (idempotencyKey = key) => ({ ...selection, expectedReviewHash: (await service.review(selection)).reviewHash, idempotencyKey });

  it("reviews without writes, then queues only the selected Shopify pair and preserves warehouse inventory", async () => {
    const stock = (await database.pool.query("SELECT * FROM inventory.inventory_levels ORDER BY id")).rows;
    const context = await service.context({ productId: 20, channelId: 35 });
    expect(context.targets.map(target => target.id)).toEqual([1]);
    const review = await service.review(selection);
    // Twenty on hand less three reserved: the canonical owner supplies 17.
    expect(review).toMatchObject({ ready: true, blockers: [], rows: [{ productVariantId: 101, sku: "P5", quantity: "17" }] });
    expect(await outbox()).toEqual([]);
    const result = await service.send({ ...selection, expectedReviewHash: review.reviewHash, idempotencyKey: key }, "operator");
    expect(result.receipt.rows).toMatchObject([{ productVariantId: 101, quantity: "17", revision: "1" }]);
    expect(await outbox()).toMatchObject([{ publication_target_id: 1, product_variant_id: 101, state: "queued" }]);
    expect((await database.pool.query("SELECT * FROM inventory.inventory_levels ORDER BY id")).rows).toEqual(stock);
    expect((await database.pool.query("SELECT actor,changes,context FROM public.audit_events WHERE action='inventory_availability.stock.sent'")).rows)
      .toMatchObject([{ actor: "operator", changes: { before: { rows: [] }, after: { rows: [{ productVariantId: 101 }] } }, context: { providerWriteAttempted: false } }]);
  });
  it("replays a lost response without creating another desired revision, even after stock changes", async () => {
    const command = await prepare();
    const first = await service.send(command, "operator");
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=19 WHERE product_variant_id=101");
    expect(await service.send(command, "operator")).toEqual({ receipt: first.receipt, replayed: true });
    expect(await outbox()).toHaveLength(1);
  });
  it("publishes a real zero when the remaining stock is entirely reserved", async () => {
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=3 WHERE product_variant_id=101; UPDATE inventory.inventory_lots SET qty_on_hand=3 WHERE product_variant_id=101");
    const review = await service.review(selection);
    expect(review).toMatchObject({ ready: true, rows: [{ quantity: "0" }] });
    expect((await service.send({ ...selection, expectedReviewHash: review.reviewHash, idempotencyKey: key }, "operator")).receipt.rows[0].quantity).toBe("0");
  });
  it("rechecks global stops and location holds between review and send", async () => {
    const command = await prepare();
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=false,revision=revision+1");
    await expect(service.send(command, "operator")).rejects.toMatchObject({ code: "STOCK_SEND_REVIEW_STALE" });
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=true,revision=revision+1");
    const current = await prepare();
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET held_at=transaction_timestamp(),held_by='operator',hold_reason='Count in progress',revision=revision+1 WHERE id=1");
    await expect(service.send(current, "operator")).rejects.toMatchObject({ code: "STOCK_SEND_REVIEW_STALE" });
    expect((await service.review(selection)).ready).toBe(false);
    expect(await outbox()).toEqual([]);
  });
  it("serializes identical concurrent commands and records one receipt and audit event", async () => {
    const command = await prepare();
    const results = await Promise.all([service.send(command, "operator"), service.send(command, "operator")]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(results[0].receipt).toEqual(results[1].receipt);
    expect(await outbox()).toHaveLength(1);
    expect((await database.pool.query("SELECT * FROM public.audit_events WHERE action='inventory_availability.stock.sent'")).rowCount).toBe(1);
  });
  it("refuses stale stock, altered scope and a retry key reused by another actor", async () => {
    const stale = await prepare();
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=19 WHERE product_variant_id=101");
    await expect(service.send(stale, "operator")).rejects.toMatchObject({ code: "STOCK_SEND_REVIEW_STALE" });
    const command = await prepare(); await service.send(command, "operator");
    await expect(service.send(command, "other-actor")).rejects.toMatchObject({ code: "STOCK_SEND_COMMAND_CONFLICT" });
    await expect(service.send({ ...command, productVariantIds: [102] }, "operator")).rejects.toMatchObject({ code: "STOCK_SEND_COMMAND_CONFLICT" });
    expect(await outbox()).toHaveLength(1);
  });
  it("refuses paused controls, another provider, missing mappings and unmanaged variants", async () => {
    expect((await service.review({ ...selection, publicationTargetId: 2 })).ready).toBe(false);
    expect((await service.review({ ...selection, productVariantIds: [102] })).ready).toBe(false);
    await database.pool.query("UPDATE catalog.product_variants SET track_inventory=false WHERE id=101");
    expect((await service.review(selection)).ready).toBe(false);
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=false");
    expect((await service.context({ productId: 20 })).blockers.join(" ")).toContain("paused");
    expect((await service.review(selection)).ready).toBe(false);
    expect(await outbox()).toEqual([]);
  });
  it("rolls back desired stock and audit if receipt persistence fails, then recovers with the original key", async () => {
    const command = await prepare();
    await database.pool.query(`CREATE FUNCTION public.refuse_stock_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic receipt failure'; END $$;
      CREATE TRIGGER refuse_stock_receipt BEFORE INSERT ON public.idempotency_keys FOR EACH ROW EXECUTE FUNCTION public.refuse_stock_receipt();`);
    await expect(service.send(command, "operator")).rejects.toThrow("synthetic receipt failure");
    expect(await outbox()).toEqual([]);
    expect((await database.pool.query("SELECT * FROM public.audit_events WHERE action='inventory_availability.stock.sent'")).rows).toEqual([]);
    await database.pool.query("DROP TRIGGER refuse_stock_receipt ON public.idempotency_keys");
    expect((await service.send(command, "operator")).replayed).toBe(false);
    expect(await outbox()).toHaveLength(1);
  });
  it("reuses pending work, verifies through the existing admitted worker and refreshes completed work on an explicit resend", async () => {
    const first = await service.send(await prepare(), "operator");
    const second = await service.send(await prepare("22222222-2222-4222-8222-222222222222"), "operator");
    expect(second.receipt.rows[0].outboxId).toBe(first.receipt.rows[0].outboxId);
    const publish = vi.fn(async (input: { desiredQuantity: number }) => ({ publishedQuantity: input.desiredQuantity, providerResponse: { accepted: true } }));
    const read = vi.fn(async () => ({ observedQuantity: 17, providerResponse: { quantity: 17 } }));
    const worker = new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(database.pool), {
      get: () => ({ destinationKind: "channel_connection", providerKey: "shopify", supportedScopeTypes: ["location"], publishAbsolute: publish, readAbsolute: read }),
    }, { now: () => new Date() }, () => "stock-send-worker", new PostgresQuantityPublicationAdmission(database.pool));
    expect((await worker.processDue()).verified).toBe(1);
    const status = await service.progress(key);
    expect(status.rows).toMatchObject([{ state: "verified", observedQuantity: "17" }]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ channelId: 35, productVariantId: 101, desiredQuantity: 17 }));
    expect(publish).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1);
    const automatic = await createAuthorityAwareInventoryPublicationService(database.pool).publishProduct({ ...selection,
      channelId: 35, dryRun: false, triggeredBy: "unchanged_automatic_stock" }, async () => null);
    expect(automatic.authority === "canonical" && automatic.publication.coalescedRows).toBe(1);
    expect(await outbox()).toHaveLength(1);
    const refreshed = await service.send(await prepare("33333333-3333-4333-8333-333333333333"), "operator");
    expect(refreshed.receipt.rows[0].revision).toBe("2");
    expect(refreshed.receipt.rows[0].outboxId).not.toBe(first.receipt.rows[0].outboxId);
    expect((await worker.processDue()).verified).toBe(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect((await service.progress(key)).rows[0].outboxId).toBe(first.receipt.rows[0].outboxId);
  });
  it("records a provider mismatch without presenting it as verified or replacing its pending recovery work", async () => {
    const first = await service.send(await prepare(), "operator");
    const worker = new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(database.pool), {
      get: () => ({ destinationKind: "channel_connection", providerKey: "shopify", supportedScopeTypes: ["location"],
        publishAbsolute: async input => ({ publishedQuantity: input.desiredQuantity, providerResponse: {} }),
        readAbsolute: async () => ({ observedQuantity: 0, providerResponse: { quantity: 0 } }) }),
    }, { now: () => new Date() }, () => "stock-send-mismatch", new PostgresQuantityPublicationAdmission(database.pool));
    expect((await worker.processDue()).verified).toBe(0);
    expect((await service.progress(key)).rows).toMatchObject([{ state: "queued", observedQuantity: "0", errorCode: "PROVIDER_READBACK_MISMATCH" }]);
    const retry = await service.send(await prepare("22222222-2222-4222-8222-222222222222"), "operator");
    expect(retry.receipt.rows[0].outboxId).toBe(first.receipt.rows[0].outboxId);
    expect(await outbox()).toHaveLength(1);
  });
});
