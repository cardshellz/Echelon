import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { createStockLinkDatabase, createLiveShopifyTarget, installStockLinkConnectionColumns,
  installStockLinkTickColumns, addShopifyFeed, readStockLinkCheck } from "../fixtures/stock-link.fixture";
import { createShopifyStockLinkSource } from "../../../channels/shopify-stock-link-source";
import type { StockLinkAdapter } from "../../application/stock-link.ports";
import type { StockLinkStoreItem } from "@shared/types/stock-link";
import { createStockLinkService } from "../../infrastructure/stock-link.factory";
import { PostgresProductSyncWorkflowStore } from "../../infrastructure/product-sync-workflow.repository";
import { ProductSyncWorkflowService } from "../../application/product-sync-workflow.service";
import { InventoryProductSyncService } from "../../application/inventory-product-sync.service";
import { PostgresInventoryProductSyncStore } from "../../infrastructure/inventory-product-sync.repository";
import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import type { InventoryPublicationTransportAdapter } from "../../application/inventory-publication-transport";
import { StockLinkError, STOCK_LINK_ERROR_CODES } from "../../domain/stock-link-errors";

const runtime = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));
const dbDescribe = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const key = "12345678-1234-4234-8234-123456789012";
const request = { productId: 20, idempotencyKey: key };
const migration = "900000044000019650001_product_inventory_sync_requests.sql";

dbDescribe.sequential("product sync: saved links through canonical registration, publication and readback", () => {
  let database: InventoryCutoverTestDatabase;
  let targetId: number;
  let now: Date;
  let items: StockLinkStoreItem[];
  let store: PostgresProductSyncWorkflowStore;
  let publication: InventoryProductSyncService;
  let workflow: ProductSyncWorkflowService;
  let checks: ReturnType<typeof vi.fn<(skus: readonly string[]) => void>>;
  let unavailableTarget: number | null;
  const source = createShopifyStockLinkSource();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let lease = 0;
  const token = () => `00000000-0000-4000-8000-${String(++lease).padStart(12, "0")}`;
  beforeEach(async () => {
    database = await createStockLinkDatabase(); runtime.pool = database.pool;
    await installStockLinkConnectionColumns(database.pool);
    await installStockLinkTickColumns(database.pool);
    await database.pool.query(readFileSync(resolve("migrations", migration), "utf8"));
    await database.pool.query("ALTER TABLE channels.sync_settings ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1");
    await addShopifyFeed(database.pool, 101, "5501", { sku: "P5" });
    targetId = await createLiveShopifyTarget(database.pool);
    now = new Date("2026-10-30T12:00:00.000Z");
    items = [{ itemId: "5501", sku: "P5", productId: "9001", productStatus: "DRAFT" }];
    unavailableTarget = null;
    checks = vi.fn<(skus: readonly string[]) => void>();
    const adapter: StockLinkAdapter = { destinationKind: "channel_connection", providerKey: "shopify",
      async findItemsBySku(destination, skus) {
        checks([...skus]);
        if (destination.publicationTargetId === unavailableTarget)
          throw new StockLinkError(STOCK_LINK_ERROR_CODES.providerUnavailable,"Fixture provider unavailable",{});
        return { observedAt: now.toISOString(), readFingerprint: await source.readFingerprint(database.pool, destination),
          skus: [...skus], items: items.filter(item => skus.includes(item.sku!)) };
      },
      async observeItems(destination, ids) {
        return { observedAt: now.toISOString(), readFingerprint: await source.readFingerprint(database.pool, destination),
          observations: ids.map(itemId => ({ itemId, item: items.find(item => item.itemId === itemId) ?? null })) };
      },
    };
    const links = createStockLinkService({ pool: database.pool, bindings: [{ adapter, source }], clock: () => now,
      monotonicNow: () => 0, random: () => 0.5, newLeaseToken: token, logger: log });
    store = new PostgresProductSyncWorkflowStore(database.pool);
    publication = new InventoryProductSyncService(new PostgresInventoryProductSyncStore(database.pool), () => now);
    workflow = new ProductSyncWorkflowService({ store, publication, links, clock: () => now, newLeaseToken: token,
      enabled: () => true, logger: log });
  }, 60_000);
  afterEach(async () => { vi.restoreAllMocks(); await database?.close(); runtime.pool = null; });
  const outbox = async () => (await database.pool.query(`SELECT id::text,publication_target_id,product_variant_id,desired_quantity::text,state
    FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1 ORDER BY id`, [targetId])).rows;
  const heads = async () => (await database.pool.query(`SELECT h.product_variant_id,v.external_inventory_item_id
    FROM inventory.publication_variant_mapping_heads h JOIN inventory.publication_variant_mapping_versions v ON v.id=h.active_mapping_id
    WHERE h.publication_target_id=$1 ORDER BY h.product_variant_id`, [targetId])).rows;
  const warehouse = async () => (await database.pool.query("SELECT * FROM inventory.inventory_levels ORDER BY id")).rows;
  const advance = (ms = 31_000) => { now = new Date(now.getTime() + ms); };

  it("wakes the old draft rejection once, uses the existing IDs, and verifies the ATP quantity without moving warehouse stock", async () => {
    await database.pool.query(`INSERT INTO inventory.stock_link_checks(publication_target_id,product_variant_id,status,reason_code,next_check_at,created_at,updated_at)
      VALUES($1,101,'waiting','STOCK_LINK_NOT_ON_SALE',$2::timestamptz+interval '16 hours',$2::timestamptz-interval '1 day',$2::timestamptz-interval '1 hour')`,[targetId,now]);
    const before = await warehouse();
    const review = await publication.review({ productId: 20 });
    expect(review.rows.find(row => row.publicationTargetId === targetId)?.blockers).toContain("PUBLICATION_TARGET_VARIANT_MAPPING_MISSING");
    expect(await heads()).toEqual([]); expect(await outbox()).toEqual([]);
    expect((await workflow.start(request,"operator")).state).toBe("checking_links");
    expect((await readStockLinkCheck(database.pool,targetId,101))?.next_check_at).toEqual(now);
    expect(await outbox()).toEqual([]); // Durable acceptance precedes every publication side effect.
    await workflow.tick();
    const result = await workflow.progress(key,"operator");
    expect(result.state).toBe("queued");
    expect(await heads()).toEqual([{ product_variant_id:101,external_inventory_item_id:"5501" }]);
    expect(result.delivery?.receipt.rows.find(row => row.publicationTargetId === targetId)).toMatchObject({ quantity:"17",externalInventoryItemId:"5501" });
    expect(checks).toHaveBeenCalledWith(["P5"]);
    // pg truncates PostgreSQL microseconds to milliseconds. Move the injected
    // worker clock beyond every queued timestamp rather than rounding it down.
    const availableAt = (await database.pool.query("SELECT max(available_at) AS due FROM inventory.inventory_publication_outbox WHERE state='queued'")).rows[0].due as Date;
    const due = new Date(availableAt.getTime()+1000);
    let providerQuantity = 0;
    const transport: InventoryPublicationTransportAdapter = { destinationKind:"channel_connection",providerKey:"shopify",supportedScopeTypes:["location"],
      publishAbsolute: vi.fn(async command => { providerQuantity=command.desiredQuantity; return {publishedQuantity:providerQuantity,providerResponse:{accepted:true}}; }),
      readAbsolute: vi.fn(async () => ({ observedQuantity:providerQuantity,providerResponse:{quantity:providerQuantity} })) };
    const worker = new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(database.pool),
      { get: () => transport }, { now: () => due }, token, new PostgresQuantityPublicationAdmission(database.pool));
    await worker.processDue();
    expect((await workflow.progress(key,"operator")).delivery?.rows.find(row => row.publicationTargetId === targetId)?.state).toBe("verified");
    expect(await warehouse()).toEqual(before);
  }, 60_000);

  it("never discovers, claims, registers or publishes another product even when its check is due", async () => {
    await database.pool.query(`INSERT INTO catalog.products(id,sku) VALUES(21,'OTHER');
      INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(201,21,'OTHER-P1')`);
    await addShopifyFeed(database.pool,201,"5502",{sku:"OTHER-P1"});
    await database.pool.query(`INSERT INTO inventory.stock_link_checks(publication_target_id,product_variant_id,status,next_check_at,created_at,updated_at)
      VALUES($1,201,'waiting',$2,$2,$2)`,[targetId,now]);
    items.push({itemId:"5502",sku:"OTHER-P1",productId:"9002",productStatus:"ACTIVE"});
    const other = await readStockLinkCheck(database.pool,targetId,201);
    await workflow.start(request,"operator"); await workflow.tick();
    expect(await readStockLinkCheck(database.pool,targetId,201)).toEqual(other);
    expect(await heads()).toHaveLength(1);
    expect((await outbox()).every(row => row.product_variant_id === 101)).toBe(true);
    expect(checks).toHaveBeenCalledTimes(1);
    expect((await database.pool.query("SELECT recent_cursor_raw,sweep_cursor_variant_id FROM inventory.stock_link_destinations WHERE publication_target_id=$1",[targetId])).rows[0])
      .toEqual({recent_cursor_raw:null,sweep_cursor_variant_id:null});
  },60_000);

  it("serializes duplicate acceptance and worker claims, and rejects another actor or product using the same key", async () => {
    const result = await Promise.all([workflow.start(request,"operator"),workflow.start(request,"operator")]);
    expect(result[0]).toEqual(result[1]);
    await expect(workflow.start(request,"other-user")).rejects.toMatchObject({code:"PRODUCT_SYNC_COMMAND_CONFLICT"});
    await expect(workflow.progress(key,"other-user")).rejects.toMatchObject({code:"PRODUCT_SYNC_NOT_FOUND"});
    await Promise.all([workflow.tick(),workflow.tick()]);
    expect((await workflow.progress(key,"operator")).state).toBe("queued");
    expect((await database.pool.query("SELECT * FROM public.audit_events WHERE action='inventory_availability.product_sync.requested'")).rowCount).toBe(1);
    expect((await database.pool.query("SELECT * FROM public.audit_events WHERE action='inventory_availability.product.synced'")).rowCount).toBe(1);
  },60_000);

  it("replays the persisted exact publication after its commit response is lost", async () => {
    await workflow.start(request,"operator");
    const actual = publication.sync.bind(publication);
    vi.spyOn(publication,"sync").mockImplementationOnce(async (...args) => { await actual(...args); throw new Error("Connection lost after commit"); });
    await workflow.tick();
    const waiting = await store.read(key,"operator");
    expect(waiting.state).toBe("publishing"); expect(waiting.publicationCommand).not.toBeNull();
    const original = await outbox();
    advance(); await workflow.tick();
    expect((await workflow.progress(key,"operator")).state).toBe("queued");
    expect(await outbox()).toEqual(original);
    expect((await database.pool.query("SELECT * FROM public.audit_events WHERE action='inventory_availability.product.synced'")).rowCount).toBe(1);
  },60_000);

  it("recovers an expired worker lease after restart", async () => {
    await workflow.start(request,"operator");
    const abandoned = await store.claim(now,token()); expect(abandoned).not.toBeNull();
    await workflow.tick(); expect(checks).not.toHaveBeenCalled();
    advance(6*60_000); await workflow.tick();
    expect((await workflow.progress(key,"operator")).state).toBe("queued");
  },60_000);

  it("keeps ambiguous ACTIVE and DRAFT identities blocked without overwriting the saved link", async () => {
    items.push({itemId:"5502",sku:"P5",productId:"9002",productStatus:"ACTIVE"});
    await workflow.start(request,"operator"); await workflow.tick();
    expect((await workflow.progress(key,"operator")).state).toBe("blocked");
    expect(await heads()).toEqual([]); expect(await outbox()).toEqual([]);
    expect((await readStockLinkCheck(database.pool,targetId,101))?.status).toBe("flagged");
    expect((await database.pool.query("SELECT channel_inventory_item_id FROM channels.channel_feeds WHERE product_variant_id=101 AND channel_id=35")).rows[0].channel_inventory_item_id).toBe("5501");
  },60_000);

  it("honors a global pause and target hold rather than enrolling through them", async () => {
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=false,revision=revision+1");
    await expect(workflow.start(request,"operator")).rejects.toMatchObject({code:"PRODUCT_SYNC_BLOCKED"});
    expect((await database.pool.query("SELECT * FROM inventory.product_inventory_sync_requests")).rowCount).toBe(0);
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=true,revision=revision+1");
    await workflow.start(request,"operator");
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET held_at=$2,held_by='operator',hold_reason='Inventory count',revision=revision+1 WHERE id=$1",[targetId,now]);
    await workflow.tick();
    expect((await workflow.progress(key,"operator")).state).toBe("blocked");
    expect(checks).not.toHaveBeenCalled(); expect(await outbox()).toEqual([]);
  },60_000);

  it("waits through a provider failure and completes every eligible destination without re-registering the first", async () => {
    const secondTarget = await createLiveShopifyTarget(database.pool,{location:"98766"});
    unavailableTarget = secondTarget;
    await workflow.start(request,"operator"); await workflow.tick();
    expect((await workflow.progress(key,"operator")).state).toBe("checking_links");
    expect(await heads()).toHaveLength(1);
    const first = await outbox();
    unavailableTarget = null;
    advance(11*60_000); await workflow.tick();
    const result = await workflow.progress(key,"operator");
    expect(result.state).toBe("queued");
    expect(result.delivery?.receipt.rows.map(row=>row.publicationTargetId)).toEqual([targetId,secondTarget]);
    expect(await outbox()).toEqual(first);
    expect((await database.pool.query("SELECT * FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=$1",[targetId])).rowCount).toBe(1);
  },60_000);

  it("publishes genuine zero through newly registered draft links", async () => {
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=3 WHERE product_variant_id=101; UPDATE inventory.inventory_lots SET qty_on_hand=3 WHERE product_variant_id=101");
    await workflow.start(request,"operator"); await workflow.tick();
    const result = await workflow.progress(key,"operator");
    expect(result.state).toBe("queued");
    expect(result.delivery?.receipt.rows.find(row=>row.publicationTargetId===targetId)?.quantity).toBe("0");
  },60_000);

  it("does not clear permanent stock-link errors or their operator review requirement", async () => {
    await database.pool.query(`INSERT INTO inventory.stock_link_checks(publication_target_id,product_variant_id,status,reason_code,error_class,next_check_at,created_at,updated_at)
      VALUES($1,101,'error','STOCK_LINK_STATE_INVALID','permanent',NULL,$2,$2)`,[targetId,now]);
    const before=await readStockLinkCheck(database.pool,targetId,101);
    await workflow.start(request,"operator"); await workflow.tick();
    expect((await workflow.progress(key,"operator")).state).toBe("blocked");
    expect(await readStockLinkCheck(database.pool,targetId,101)).toEqual(before);
    expect(checks).not.toHaveBeenCalled();expect(await heads()).toEqual([]);
  },60_000);

  it("recovers the same saved publication after a bounded failure stops automatic retries", async () => {
    await workflow.start(request,"operator");
    const actual=publication.sync.bind(publication);
    vi.spyOn(publication,"sync").mockImplementationOnce(async(...args)=>{await actual(...args);throw new Error("Lost response");});
    advance(31*60_000);await workflow.tick();
    const failed=await store.read(key,"operator");
    expect(failed.state).toBe("failed");expect(failed.publicationCommand).not.toBeNull();
    const original=await outbox();
    expect((await workflow.start(request,"operator")).state).toBe("publishing");
    await workflow.tick();
    expect((await workflow.progress(key,"operator")).state).toBe("queued");
    expect(await outbox()).toEqual(original);
  },60_000);
});
