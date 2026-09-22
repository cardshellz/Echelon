import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { inventoryTrackingPolicyBaseFixture } from "../fixtures/inventory-tracking-policy.fixture";
import { PickingUseCases } from "../../../orders/picking.use-cases";
import { createShopifyProductMappingService } from "../../shopify-product-mapping.service";
import { createReservationService } from "../../../channels/reservation.service";
import { createCatalogBackfillService, type BackfillResult } from "../../../channels/catalog-backfill.service";
import { removeChannelProductIdentities, upsertChannelProductIdentity } from "../../../channels/channel-product-identity.repository";
import { PostgresInventoryAvailabilityClaimRepository } from "../../../inventory-planning/infrastructure/inventory-availability-claim.repository";
import { productMethods } from "../../catalog.storage";
import { updateProductInventoryTracking } from "../../inventory-tracking-policy.repository";
import { createBulkInventoryTrackingService } from "../../bulk-inventory-tracking.service";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { resolveOrderLineCatalogIdentity } from "../../../oms/order-line-catalog-identity.service";
import { createOmsService } from "../../../oms/oms.service";
import { normalizeShopifyLineItems } from "../../../oms/shopify-line-item-normalizer";
import { buildWmsLineItemFromOmsLine } from "../../../oms/wms-sync.service";
import { decideChannelFulfillmentInventoryPosting } from "../../../oms/domain/channel-fulfillment-inventory-policy";

import { listTrackingStopHistory, exportTrackingStopHistory } from "../../../inventory/infrastructure/tracking-stop.repository";

import { COGSService } from "../../../inventory/cogs.service";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

describeDatabase.sequential("product inventory policy migration and transactions", () => {
  let database: InventoryCutoverTestDatabase;
  let orm: ReturnType<typeof drizzle<typeof schema>>;
  let migration: string;
  let custodyMigration: string;
  const now = new Date("2026-09-21T12:00:00Z");
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, inventoryTrackingPolicyBaseFixture);
    migration = await readFile(resolve("migrations/0694_product_inventory_tracking_policy.sql"), "utf8");
    custodyMigration = await readFile(resolve("migrations/0696_inventory_tracking_lot_custody.sql"), "utf8");
    await database.pool.query(`INSERT INTO catalog.products(id,name) VALUES(1,'Existing');
      INSERT INTO catalog.product_variants(id,product_id,name,track_inventory)
      VALUES(1,1,'Tracked',true),(2,1,'Untracked',false),(3,1,'Legacy null',null);`);
    await database.pool.query(migration);
    await database.pool.query(custodyMigration);
    await database.pool.query(await readFile(resolve("migrations/0697_inventory_tracking_history.sql"), "utf8"));
    for (const file of ["136_financial_command_results.sql", "140_financial_command_operations.sql"]) {
      await database.pool.query(await readFile(resolve("migrations", file), "utf8"));
    }
    expect((await database.pool.query("SELECT inventory_tracking_override FROM catalog.product_variants ORDER BY id")).rows)
      .toEqual([{ inventory_tracking_override: null }, { inventory_tracking_override: false }, { inventory_tracking_override: null }]);
    orm = drizzle(database.pool, { schema });
  });
  beforeEach(async () => {
    await database.pool.query(`ALTER TABLE inventory.tracking_stop_history DISABLE TRIGGER tracking_stop_history_no_truncate;
      TRUNCATE inventory.tracking_stop_history, inventory.build_component_reservations, inventory.quantity_ledger_opening, inventory.replen_tasks;
      TRUNCATE catalog.products, catalog.product_variants, channels.channels,
      channels.channel_product_identities, channels.channel_listings, channels.channel_feeds,
      oms.oms_orders, oms.oms_order_lines, oms.oms_order_events, oms.oms_order_line_authority_events,
      wms.orders, wms.order_items, wms.picking_logs, wms.allocation_exceptions, inventory.inventory_levels, inventory.inventory_lots,
      inventory.availability_claim_lines, inventory.availability_claim_resources,
      inventory.inventory_publication_outbox, inventory.availability_runtime_authority, inventory.availability_claim_commands,
      warehouse.warehouse_locations, public.audit_events, public.financial_command_results RESTART IDENTITY CASCADE;
      ALTER TABLE inventory.tracking_stop_history ENABLE TRIGGER tracking_stop_history_no_truncate;
      INSERT INTO catalog.products(id,name,sku) VALUES(1,'Product','PRODUCT');
      INSERT INTO channels.channels(id,name,provider) VALUES(36,'Store','shopify'),(37,'Other store','shopify');`);
  });
  afterAll(async () => { await database?.close(); });

  const createVariant = (override?: boolean | null) => orm.transaction(tx => productMethods.createProductVariant({
    productId: 1, name: "Variant", sku: `V-${String(override).toUpperCase()}`,
    ...(override === undefined ? {} : { inventoryTrackingOverride: override }),
  }, tx));

  const bulkService = () => createBulkInventoryTrackingService(orm, () => now);
  function bulkCommand(input: unknown, key = "bulk-policy-test"): FinancialCommandDescriptor {
    return { actorType: "user", actorId: "policy-test", method: "POST",
      routeTemplate: "/api/products/inventory-tracking/bulk/apply", resourceKey: "product-inventory-tracking",
      idempotencyKey: key, requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      commandName: "catalog.inventory_tracking.bulk", contractVersion: 1 };
  }

  const stopRequest = { productIds: [1], inventoryTrackingDefault: false, stockDisposition: "retain_history" as const };
  async function stockForStop() {
    const variant = await createVariant();
    await database.pool.query("INSERT INTO warehouse.warehouse_locations(id,code) VALUES(1,'UNSORTED')");
    await database.pool.query(`INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty,reserved_qty,picked_qty,packed_qty,backorder_qty)
      VALUES($1,1,2,1,3,4,5);
      `, [variant.id]);
    await database.pool.query(`INSERT INTO inventory.inventory_lots(product_variant_id,warehouse_location_id,lot_number,received_at,
      qty_on_hand,qty_reserved,qty_picked,qty_packed,qty_received,qty_consumed,unit_cost_mills,total_unit_cost_mills)
      VALUES($1,1,'HISTORY', $2,2,1,3,4,12,3,9007199254740993,9007199254740993)`, [variant.id, now]);
    return variant;
  }
  async function stopThroughReview(request = stopRequest, key = "stop-tracking") {
    const service = bulkService(); const preview = await service.preview(request);
    const input = { ...request, expectedPreviewHash: preview.previewHash };
    return { preview, input, result: await service.apply(input, bulkCommand(input, key)) };
  }

  it("stops managed balances while retaining exact immutable quantities, cost precision, identity and replay evidence", async () => {
    const variant = await stockForStop();
    const before = (await database.pool.query(`SELECT to_jsonb(l)::text AS lot FROM inventory.inventory_lots l`)).rows[0].lot;
    await orm.insert(schema.channelFeeds).values({ channelId: 36, productVariantId: variant.id, channelVariantId: "stop-probe", isActive: 1 });
    const outcome = await stopThroughReview();
    expect(outcome.preview.products[0]).toMatchObject({ status: "change", blockers: [], history: [{ variantId: variant.id,
      summary: { levelCount: 1, lotCount: 1, onHand: "2", reserved: "1", picked: "3", packed: "4", backorder: "5", recordedOnHandValueMills: "18014398509481986" } }] });
    expect(outcome.result).toMatchObject({ httpStatus: 200, body: { changedProductIds: [1] } });
    expect((await orm.select().from(schema.inventoryLevels))[0]).toMatchObject({ variantQty: 0, reservedQty: 0, pickedQty: 0, packedQty: 0, backorderQty: 0 });
    expect((await database.pool.query(`SELECT qty_on_hand,qty_reserved,qty_picked,qty_packed,qty_received,qty_consumed,status,unit_cost_mills::text FROM inventory.inventory_lots`)).rows[0])
      .toEqual({ qty_on_hand: 0, qty_reserved: 0, qty_picked: 0, qty_packed: 0, qty_received: 12, qty_consumed: 3, status: "tracking_stopped", unit_cost_mills: "9007199254740993" });
    const history = (await database.pool.query(`SELECT actor,stopped_at,lots->0 AS lot,(lots->0)::text AS exact_lot,snapshot_hash FROM inventory.tracking_stop_history`)).rows;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ actor: "user:policy-test", stopped_at: now, exact_lot: before,
      snapshot_hash: outcome.preview.products[0].history![0].snapshotHash });
    expect((await orm.select().from(schema.channelFeeds))[0].isActive).toBe(0);
    expect(await bulkService().apply(outcome.input, bulkCommand(outcome.input, "stop-tracking"))).toEqual({ ...outcome.result, replayed: true });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.tracking_stop_history")).rows[0].count).toBe(1);
    for (const statement of ["UPDATE inventory.tracking_stop_history SET actor='changed'", "DELETE FROM inventory.tracking_stop_history", "TRUNCATE inventory.tracking_stop_history"]) {
      await expect(database.pool.query(statement)).rejects.toMatchObject({ code: "23514" });
    }
    const records = await listTrackingStopHistory(orm, 1);
    expect(records.records[0].summary.recordedOnHandValueMills).toBe("18014398509481986");
    const document = await exportTrackingStopHistory(orm, 1, records.records[0].id);
    expect(document).toContain('"unit_cost_mills": 9007199254740993');
    expect(await exportTrackingStopHistory(orm, 2, records.records[0].id)).toBeNull();
    // Re-enabling starts from a new managed balance, never stale retained stock.
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, true, "user:test", now));
    expect((await orm.select().from(schema.inventoryLevels))[0].variantQty).toBe(0);
    expect((await orm.select().from(schema.inventoryLots))[0].status).toBe("tracking_stopped");
  });

  it.each(["quantity", "cost", "unshown-lot"])("invalidates a stop-tracking review after a %s changes", async change => {
    const variant = await stockForStop(); const service = bulkService();
    if (change === "unshown-lot") await database.pool.query(`INSERT INTO inventory.inventory_lots(product_variant_id,warehouse_location_id,lot_number,received_at,qty_on_hand)
      SELECT $1,1,'TAIL-'||n,now(),1 FROM generate_series(1,21)n`, [variant.id]);
    const preview = await service.preview(stopRequest);
    if (change === "quantity") await database.pool.query("UPDATE inventory.inventory_levels SET picked_qty=4");
    if (change === "cost") await database.pool.query("UPDATE inventory.inventory_lots SET unit_cost_mills=9007199254740994");
    if (change === "unshown-lot") await database.pool.query("UPDATE inventory.inventory_lots SET qty_on_hand=2 WHERE lot_number='TAIL-21'");
    const input = { ...stopRequest, expectedPreviewHash: preview.previewHash };
    expect(await service.apply(input, bulkCommand(input))).toMatchObject({ httpStatus: 409, body: { code: "BULK_INVENTORY_PREVIEW_STALE" } });
    expect((await orm.select().from(schema.products))[0].inventoryTrackingDefault).toBe(true);
    expect((await database.pool.query("SELECT * FROM inventory.tracking_stop_history")).rows).toHaveLength(0);
  });

  it.each(["oms_orders", "open_orders", "build_reservations", "frozen_locations", "replenishment", "quantity_ledger"])(
    "does not archive an unresolved %s obligation", async blocker => {
      const variant = await stockForStop();
      if (blocker === "oms_orders") {
        const [sale] = await orm.insert(schema.omsOrders).values({ channelId: 36, externalOrderId: "open", status: "confirmed", orderedAt: now }).returning();
        await orm.insert(schema.omsOrderLines).values({ orderId: sale.id, productVariantId: variant.id, quantity: 1 });
      }
      if (blocker === "open_orders") {
        const [order] = await orm.insert(schema.wmsOrders).values({ orderNumber: "OPEN", customerName: "Test", warehouseStatus: "ready" }).returning();
        await orm.insert(schema.wmsOrderItems).values({ orderId: order.id, productId: variant.id, sku: variant.sku!, name: "Variant", quantity: 1 });
      }
      if (blocker === "build_reservations") await database.pool.query(`INSERT INTO inventory.build_component_reservations(build_order_component_id,inventory_lot_id,reserved_qty)
        SELECT 1,id,1 FROM inventory.inventory_lots`);
      if (blocker === "frozen_locations") await database.pool.query("UPDATE warehouse.warehouse_locations SET cycle_count_freeze_id=1");
      if (blocker === "replenishment") await database.pool.query("INSERT INTO inventory.replen_tasks(pick_product_variant_id,status) VALUES($1,'pending')", [variant.id]);
      if (blocker === "quantity_ledger") await database.pool.query("INSERT INTO inventory.quantity_ledger_opening VALUES(true,1)");
      const { preview, result } = await stopThroughReview();
      expect(preview.products[0].blockers.map(b => b.code)).toContain(blocker);
      expect(result).toMatchObject({ httpStatus: 409, body: { code: "BULK_INVENTORY_TRACKING_BLOCKED" } });
      expect((await orm.select().from(schema.inventoryLevels))[0].variantQty).toBe(2);
      expect((await database.pool.query("SELECT * FROM inventory.tracking_stop_history")).rows).toHaveLength(0);
    });

  it("rolls back history, balances, feed and policies together when a later product fails", async () => {
    const variant = await stockForStop();
    await orm.insert(schema.channelFeeds).values({ channelId: 36, productVariantId: variant.id, channelVariantId: "rollback-history", isActive: 1 });
    await database.pool.query(`INSERT INTO catalog.products(id,name) VALUES(2,'Failure probe');
      CREATE FUNCTION catalog.fail_stop_probe() RETURNS trigger LANGUAGE plpgsql AS $probe$
        BEGIN IF NEW.id=2 THEN RAISE EXCEPTION 'Injected stop failure'; END IF; RETURN NEW; END $probe$;
      CREATE TRIGGER stop_failure BEFORE UPDATE ON catalog.products FOR EACH ROW EXECUTE FUNCTION catalog.fail_stop_probe();`);
    try {
      await expect(stopThroughReview({ ...stopRequest, productIds: [1,2] })).rejects.toThrow();
      expect((await orm.select().from(schema.inventoryLevels))[0].variantQty).toBe(2);
      expect((await orm.select().from(schema.inventoryLots))[0].qtyPicked).toBe(3);
      expect((await orm.select().from(schema.channelFeeds))[0].isActive).toBe(1);
      expect((await orm.select().from(schema.products)).every(p => p.inventoryTrackingDefault)).toBe(true);
      expect((await database.pool.query("SELECT * FROM inventory.tracking_stop_history")).rows).toHaveLength(0);
      expect(await orm.select().from(schema.auditEvents)).toHaveLength(0);
    } finally { await database.pool.query("DROP TRIGGER stop_failure ON catalog.products; DROP FUNCTION catalog.fail_stop_probe()"); }
  });

  it("preserves explicit tracked overrides and every terminal order record while stopping inherited stock", async () => {
    const variant = await stockForStop(); const tracked = await createVariant(true);
    await database.pool.query("INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty) VALUES($1,1,9)", [tracked.id]);
    const [order] = await orm.insert(schema.wmsOrders).values({ orderNumber: "SHIPPED", customerName: "Test", warehouseStatus: "shipped" }).returning();
    await orm.insert(schema.wmsOrderItems).values({ orderId: order.id, productId: variant.id, sku: variant.sku!, name: "Variant", quantity: 1,
      pickedQuantity: 1, fulfilledQuantity: 1, status: "completed", inventoryTracking: true, catalogProductId: 1 });
    const before = await orm.select().from(schema.wmsOrderItems);
    expect((await stopThroughReview()).result.httpStatus).toBe(200);
    expect(await orm.select().from(schema.wmsOrderItems)).toEqual(before);
    expect((await orm.select().from(schema.productVariants).where(eq(schema.productVariants.id, tracked.id)))[0].trackInventory).toBe(true);
    expect((await orm.select().from(schema.inventoryLevels).where(eq(schema.inventoryLevels.productVariantId, tracked.id)))[0].variantQty).toBe(9);
    expect((await database.pool.query("SELECT product_variant_id FROM inventory.tracking_stop_history")).rows).toEqual([{ product_variant_id: variant.id }]);
  });


  it.each(["stock", "lot", "oms", "wms"])("serializes a new %s write against the history transition", async kind => {
    const variant = await stockForStop();
    const [sale] = await orm.insert(schema.omsOrders).values({ channelId: 36, externalOrderId: "race", status: "confirmed", orderedAt: now }).returning();
    const [order] = await orm.insert(schema.wmsOrders).values({ orderNumber: "RACE", customerName: "Test", warehouseStatus: "ready" }).returning();
    let release!: () => void; let ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const transition = orm.transaction(async tx => {
      await updateProductInventoryTracking(tx, 1, false, "race-owner", now, "retain_history");
      ready(); await gate;
    });
    await Promise.race([entered, transition]);
    const writer = await database.pool.connect();
    let attempt: Promise<unknown> | undefined;
    try {
      const statement = kind === "stock" ? `INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty) VALUES($1,2,1)`
        : kind === "lot" ? `INSERT INTO inventory.inventory_lots(product_variant_id,warehouse_location_id,lot_number,received_at,qty_on_hand) VALUES($1,1,'RACE',now(),1)`
        : kind === "oms" ? `INSERT INTO oms.oms_order_lines(order_id,product_variant_id,catalog_product_id,inventory_tracking,quantity) VALUES(${sale.id},$1,1,true,1)`
        : `INSERT INTO wms.order_items(order_id,product_id,catalog_product_id,inventory_tracking,sku,name,quantity) VALUES(${order.id},$1,1,true,'RACE','Race',1)`;
      attempt = writer.query(statement, [variant.id]).then(() => null, error => error);
      release(); await transition;
      expect(await attempt).toMatchObject({ code: "23514" });
      expect((await orm.select().from(schema.inventoryLevels))[0].variantQty).toBe(0);
      expect((await database.pool.query("SELECT summary->>'onHand' AS quantity FROM inventory.tracking_stop_history")).rows).toEqual([{ quantity: "2" }]);
    } finally { release(); await transition; await attempt; writer.release(); }
  });

  it("picks a future combined-order line after stopping without checking or deducting stock", async () => {
    const variant = await stockForStop();
    expect((await stopThroughReview()).result.httpStatus).toBe(200);
    await database.pool.query(`INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_product_id,external_variant_id)
      VALUES(36,$1,'1000','1001')`, [variant.id]);
    const identity = await resolveOrderLineCatalogIdentity(orm, { channelId: 36, externalProductId: "1000", externalVariantId: "1001", sku: variant.sku });
    expect(identity).toMatchObject({ id: variant.id, productId: 1, inventoryTracking: false });
    const [order] = await orm.insert(schema.wmsOrders).values({ orderNumber: "FUTURE", customerName: "Test", combinedGroupId: 700, warehouseStatus: "ready" }).returning();
    const [item] = await orm.insert(schema.wmsOrderItems).values({ orderId: order.id, productId: variant.id, sku: variant.sku!, name: "Variant", quantity: 5,
      catalogProductId: 1, inventoryTracking: false, requiresShipping: 1, location: "UNASSIGNED" }).returning();
    const storage = {
      getOrderItemById: async (id: number) => (await orm.select().from(schema.wmsOrderItems).where(eq(schema.wmsOrderItems.id, id)))[0],
      getOrderById: async (id: number) => (await orm.select().from(schema.wmsOrders).where(eq(schema.wmsOrders.id, id)))[0],
      getOrderItems: async (id: number) => orm.select().from(schema.wmsOrderItems).where(eq(schema.wmsOrderItems.orderId, id)),
      getAllWarehouseSettings: async () => [], getUser: async () => ({ id: "picker", username: "picker", role: "picker" }),
      createPickingLog: async (row: typeof schema.pickingLogs.$inferInsert) => orm.insert(schema.pickingLogs).values(row),
      updateOrderProgress: vi.fn(async () => undefined), getProductVariantBySku: vi.fn(async () => undefined),
    };
    const inventoryCore = { withTx: () => inventoryCore, pickItem: vi.fn(), unpickItem: vi.fn() };
    const service = new PickingUseCases(orm as never, inventoryCore as never, {} as never, storage as never);
    expect(await service.pickItem(item.id, { status: "completed", pickedQuantity: 5, userId: "picker", pickMethod: "pick_all" }))
      .toMatchObject({ success: true, item: { pickedQuantity: 5, status: "completed" } });
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();
    expect((await orm.select().from(schema.inventoryLevels))[0].pickedQty).toBe(0);
    expect((await database.pool.query("SELECT summary->>'picked' AS quantity FROM inventory.tracking_stop_history")).rows).toEqual([{ quantity: "3" }]);
    expect(decideChannelFulfillmentInventoryPosting({ omsRequiresShipping: true, wmsRequiresShipping: 1,
      omsInventoryTracking: false, wmsInventoryTracking: false, omsCatalogProductId: 1, wmsCatalogProductId: 1,
      productVariantId: variant.id, catalogVariantId: variant.id, catalogRequiresShipping: true, catalogTrackInventory: false,
    })).toMatchObject({ status: "resolved", requiresInventoryPosting: false });
    expect(await new COGSService(orm).getInventoryValuation()).toMatchObject({ totalQty: 0, totalValueCents: 0 });
  });


  it("bounds combined snapshot size before returning or applying an interactive review", async () => {
    const variant = await createVariant();
    await database.pool.query(`INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty)
      SELECT $1,n,1 FROM generate_series(1,10001)n`, [variant.id]);
    await expect(bulkService().preview(stopRequest)).rejects.toMatchObject({ code: "BULK_INVENTORY_HISTORY_TOO_LARGE" });
    expect((await database.pool.query("SELECT * FROM inventory.tracking_stop_history")).rows).toHaveLength(0);
    expect((await orm.select().from(schema.products))[0].inventoryTrackingDefault).toBe(true);
  });

  it("records an empty transition and preserves its evidence when migrations run again", async () => {
    await createVariant();
    expect((await stopThroughReview()).result.httpStatus).toBe(200);
    const before = await database.pool.query("SELECT to_jsonb(h)::text AS document FROM inventory.tracking_stop_history h");
    expect(before.rows).toHaveLength(1);
    await database.pool.query(await readFile(resolve("migrations/0697_inventory_tracking_history.sql"), "utf8"));
    expect((await database.pool.query("SELECT to_jsonb(h)::text AS document FROM inventory.tracking_stop_history h")).rows).toEqual(before.rows);
    await expect(database.pool.query("DELETE FROM inventory.tracking_stop_history")).rejects.toMatchObject({ code: "23514" });
  });


  it("bulk changes product-only and variant products while preserving overrides in both directions", async () => {
    await database.pool.query("INSERT INTO catalog.products(id,name) VALUES(2,'No variants'),(3,'Already set')");
    const inherited = await createVariant();
    const tracked = await createVariant(true);
    const untracked = await createVariant(false);
    // An explicit tracked override keeps its stock; it must not block a change
    // that only affects the product default and inheriting variants.
    await database.pool.query("INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty) VALUES($1,1,2)", [tracked.id]);
    await orm.transaction(tx => updateProductInventoryTracking(tx, 3, false, "fixture", now));
    const service = bulkService();
    for (const next of [false, true]) {
      const request = { productIds: [3, 2, 1], inventoryTrackingDefault: next };
      const preview = await service.preview(request);
      expect(preview.products.map(p => p.productId)).toEqual([1, 2, 3]);
      expect(preview.products[0]).toMatchObject({ changingVariantCount: 1, trackedOverrideCount: 1, untrackedOverrideCount: 1 });
      expect(preview.products[1]).toMatchObject({ variantCount: 0, status: "change" });
      const input = { ...request, expectedPreviewHash: preview.previewHash };
      const result = await service.apply(input, bulkCommand(input, `bulk-policy-${next}`));
      expect(result).toMatchObject({ httpStatus: 200, replayed: false, body: { changedProductIds: next ? [1, 2, 3] : [1, 2],
        unchangedProductIds: next ? [] : [3], trackedOverrideCount: 1, untrackedOverrideCount: 1, changingVariantCount: 1 } });
      expect((await orm.select().from(schema.productVariants).orderBy(schema.productVariants.id)).map(v => [v.id, v.inventoryTrackingOverride, v.trackInventory]))
        .toEqual([[inherited.id, null, next], [tracked.id, true, true], [untracked.id, false, false]]);
    }
    const audits = await orm.select().from(schema.auditEvents);
    expect(audits.filter(a => a.action === "catalog.inventory_tracking_bulk.changed")).toHaveLength(2);
    expect(audits.filter(a => a.action === "catalog.inventory_tracking_bulk.changed").every(a => a.actor === "user:policy-test")).toBe(true);
  });

  it("reports stock blockers before apply and changes none of the otherwise eligible products", async () => {
    await database.pool.query("INSERT INTO catalog.products(id,name) VALUES(2,'Eligible')");
    const variant = await createVariant();
    await database.pool.query("INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty) VALUES($1,1,2)", [variant.id]);
    const service = bulkService();
    const request = { productIds: [2, 1], inventoryTrackingDefault: false };
    const preview = await service.preview(request);
    expect(preview.products[0]).toMatchObject({ status: "blocked", blockers: [{ variantId: variant.id, code: "stock" }] });
    expect(preview.products[1].status).toBe("change");
    const input = { ...request, expectedPreviewHash: preview.previewHash };
    expect(await service.apply(input, bulkCommand(input))).toMatchObject({ httpStatus: 409, body: { code: "BULK_INVENTORY_TRACKING_BLOCKED" } });
    expect((await orm.select().from(schema.products)).every(p => p.inventoryTrackingDefault)).toBe(true);
    expect(await orm.select().from(schema.auditEvents)).toHaveLength(0);
    expect((await orm.select().from(schema.inventoryLevels))[0].variantQty).toBe(2);
  });

  it("requires a fresh eligible-subset preview and applies only that subset with audits and replay", async () => {
    await database.pool.query("INSERT INTO catalog.products(id,name) VALUES(2,'Eligible')");
    const variant = await createVariant();
    await database.pool.query("INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty) VALUES($1,1,2)", [variant.id]);
    const service = bulkService();
    const full = await service.preview({ productIds: [1, 2], inventoryTrackingDefault: false });
    const request = { productIds: [2], inventoryTrackingDefault: false };
    const wrong = { ...request, expectedPreviewHash: full.previewHash };
    expect(await service.apply(wrong, bulkCommand(wrong, "wrong-subset")))
      .toMatchObject({ httpStatus: 409, body: { code: "BULK_INVENTORY_PREVIEW_STALE" } });
    const preview = await service.preview(request);
    const input = { ...request, expectedPreviewHash: preview.previewHash };
    const result = await service.apply(input, bulkCommand(input));
    expect(result).toMatchObject({ httpStatus: 200, body: { changedProductIds: [2] } });
    expect(await service.apply(input, bulkCommand(input))).toEqual({ ...result, replayed: true });
    expect((await orm.select().from(schema.products).orderBy(schema.products.id)).map(p => p.inventoryTrackingDefault)).toEqual([true, false]);
    expect((await orm.select().from(schema.inventoryLevels))[0].variantQty).toBe(2);
    expect((await orm.select().from(schema.auditEvents)).filter(a => a.action === "catalog.inventory_tracking_default.changed"))
      .toMatchObject([{ target: "product:2" }]);
  });

  it("returns exact stock, lot and order evidence without treating a cancelled warehouse order as a cancelled sale", async () => {
    const variant = await createVariant();
    const [location] = await orm.insert(schema.warehouseLocations).values({ code: "UNSORTED" }).returning();
    const [level] = await orm.insert(schema.inventoryLevels).values({ productVariantId: variant.id, warehouseLocationId: location.id,
      variantQty: 2, reservedQty: 1, pickedQty: 3, packedQty: 4, backorderQty: 5 }).returning();
    const [lot] = await orm.insert(schema.inventoryLots).values({ productVariantId: variant.id, warehouseLocationId: location.id,
      lotNumber: "LOT-RECON", qtyOnHand: 2, qtyReserved: 1, qtyPicked: 3, qtyPacked: 4, receivedAt: now }).returning();
    const [sale] = await orm.insert(schema.omsOrders).values({ channelId: 36, externalOrderId: "56076", externalOrderNumber: "#56076",
      status: "confirmed", fulfillmentStatus: null, orderedAt: now }).returning();
    const [line] = await orm.insert(schema.omsOrderLines).values({ orderId: sale.id, productVariantId: variant.id, quantity: 6 }).returning();
    const [cancelled] = await orm.insert(schema.wmsOrders).values({ orderNumber: "#56076", customerName: "Test", warehouseStatus: "cancelled" }).returning();
    const [ready] = await orm.insert(schema.wmsOrders).values({ orderNumber: "#63309", customerName: "Test", warehouseStatus: "ready" }).returning();
    await orm.insert(schema.wmsOrderItems).values({ orderId: cancelled.id, omsOrderLineId: line.id, productId: variant.id,
      sku: variant.sku!, name: "Variant", quantity: 6, pickedQuantity: 6, status: "completed" });
    // Legacy null-variant SKU matching must agree with the transition guard.
    const [item] = await orm.insert(schema.wmsOrderItems).values({ orderId: ready.id, sku: variant.sku!, name: "Variant", quantity: 1 }).returning();
    const service = bulkService();
    const request = { productIds: [1], inventoryTrackingDefault: false };
    const preview = await service.preview(request);
    const blockers = Object.fromEntries(preview.products[0].blockers.map(b => [b.code, b.evidence]));
    expect(blockers.stock).toEqual({ totalCount: 1, records: [{ kind: "stock", recordId: level.id, locationId: location.id,
      locationCode: "UNSORTED", onHand: 2, reserved: 1, picked: 3, packed: 4, backorder: 5 }] });
    expect(blockers.lots).toEqual({ totalCount: 1, records: [{ kind: "lots", recordId: lot.id, lotNumber: "LOT-RECON",
      locationId: location.id, locationCode: "UNSORTED", onHand: 2, reserved: 1, picked: 3, packed: 4 }] });
    expect(blockers.open_orders).toEqual({ totalCount: 1, records: [{ kind: "open_orders", recordId: item.id,
      orderId: ready.id, orderNumber: "#63309", status: "ready", itemStatus: "pending", quantity: 1, picked: 0, fulfilled: 0 }] });
    expect(blockers.oms_orders).toEqual({ totalCount: 1, records: [{ kind: "oms_orders", recordId: line.id,
      orderId: sale.id, orderNumber: "#56076", status: "confirmed", fulfillmentStatus: null, quantity: 6,
      warehouseOrderCount: 1, warehouseOrders: [{ orderId: cancelled.id, orderNumber: "#56076", status: "cancelled" }] }] });
    for (const statement of ["UPDATE inventory.inventory_levels SET picked_qty=7", "UPDATE oms.oms_orders SET status='processing'"]) {
      const before = await service.preview(request);
      await database.pool.query(statement);
      expect((await service.preview(request)).previewHash).not.toBe(before.previewHash);
      const input = { ...request, expectedPreviewHash: before.previewHash };
      expect(await service.apply(input, bulkCommand(input, statement)))
        .toMatchObject({ httpStatus: 409, body: { code: "BULK_INVENTORY_PREVIEW_STALE" } });
    }
    expect((await orm.select().from(schema.products))[0].inventoryTrackingDefault).toBe(true);
    expect((await orm.select().from(schema.omsOrders))[0].status).toBe("processing");
    expect(await orm.select().from(schema.auditEvents)).toHaveLength(0);
  });

  it("bounds evidence per variant and preserves exact bigint claim and publication IDs", async () => {
    const variant = await createVariant();
    await database.pool.query(`INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty)
      SELECT $1,n,1 FROM generate_series(1,21) n;
      `, [variant.id]);
    const large = "9007199254740993";
    await database.pool.query(`INSERT INTO inventory.availability_claim_lines
      (id,claim_id,line_key,order_item_id,target_variant_id,requested_qty,planned_qty,shortfall_qty)
      VALUES($1,$1,'line',1,$2,$1,$1,0)`, [large, variant.id]);
    await database.pool.query(`INSERT INTO inventory.availability_claim_resources
      (id,claim_id,claim_line_id,warehouse_id,warehouse_location_id,inventory_level_id,source_variant_id,claimed_qty)
      VALUES($1,$1,$1,1,1,1,$2,$1)`, [large, variant.id]);
    await database.pool.query("INSERT INTO inventory.inventory_publication_outbox(id,product_variant_id,state) VALUES(77,$1,'desired'),(78,$1,'verified')", [variant.id]);
    const preview = await bulkService().preview({ productIds: [1], inventoryTrackingDefault: false });
    const blockers = Object.fromEntries(preview.products[0].blockers.map(b => [b.code, b.evidence]));
    expect(blockers.stock?.totalCount).toBe(21);
    expect(blockers.stock?.records).toHaveLength(20);
    expect(blockers.stock?.records[0]).toMatchObject({ locationCode: null, locationId: 1 });
    expect(blockers.claims).toEqual({ totalCount: 1, records: [{ kind: "claims", recordId: large, claimId: large,
      orderItemId: 1, planned: large, released: "0", consumed: "0" }] });
    expect(blockers.resources).toEqual({ totalCount: 1, records: [{ kind: "resources", recordId: large, claimId: large,
      locationId: 1, locationCode: null, claimed: large, released: "0", consumed: "0" }] });
    expect(blockers.publication).toEqual({ totalCount: 1, records: [{ kind: "publication", recordId: "77", state: "desired" }] });
  });

  it.each(["qty_picked", "qty_packed"])("blocks a custody-only lot in %s and rejects new untracked custody", async bucket => {
    const variant = await createVariant();
    await database.pool.query(`INSERT INTO inventory.inventory_lots(product_variant_id,warehouse_location_id,lot_number,received_at,${bucket})
      VALUES($1,1,'CUSTODY',now(),1)`, [variant.id]);
    const preview = await bulkService().preview({ productIds: [1], inventoryTrackingDefault: false });
    expect(preview.products[0]).toMatchObject({ status: "blocked", blockers: [{ code: "lots", evidence: { totalCount: 1 } }] });
    await expect(orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now)))
      .rejects.toMatchObject({ code: "INVENTORY_POLICY_HAS_DEPENDENCIES" });
    await expect(orm.transaction(tx => productMethods.updateProductVariant(variant.id, { inventoryTrackingOverride: false }, tx)))
      .rejects.toMatchObject({ code: "INVENTORY_POLICY_HAS_DEPENDENCIES" });
    // Explicit fixture reconciliation; the policy owner must never do this itself.
    await database.pool.query(`UPDATE inventory.inventory_lots SET ${bucket}=0`);
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now));
    await expect(database.pool.query(`UPDATE inventory.inventory_lots SET ${bucket}=1`)).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query(`INSERT INTO inventory.inventory_lots(product_variant_id,warehouse_location_id,lot_number,received_at,${bucket})
      VALUES($1,1,'UNTRACKED',now(),1)`, [variant.id])).rejects.toMatchObject({ code: "23514" });
    await database.pool.query(custodyMigration);
    await expect(database.pool.query(`UPDATE inventory.inventory_lots SET ${bucket}=1`)).rejects.toMatchObject({ code: "23514" });
  });

  it.each(["stock", "override", "new-variant", "product"])("rejects a stale bulk preview after a %s change", async change => {
    const variant = await createVariant();
    const service = bulkService();
    const request = { productIds: [1], inventoryTrackingDefault: false };
    const preview = await service.preview(request);
    if (change === "stock") await database.pool.query("INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty) VALUES($1,1,1)", [variant.id]);
    if (change === "override") await orm.transaction(tx => productMethods.updateProductVariant(variant.id, { inventoryTrackingOverride: true }, tx));
    if (change === "new-variant") await createVariant(false);
    if (change === "product") await database.pool.query("UPDATE catalog.products SET name='Renamed' WHERE id=1");
    const input = { ...request, expectedPreviewHash: preview.previewHash };
    expect(await service.apply(input, bulkCommand(input))).toMatchObject({ httpStatus: 409, body: { code: "BULK_INVENTORY_PREVIEW_STALE" } });
    expect((await orm.select().from(schema.products))[0].inventoryTrackingDefault).toBe(true);
  });

  it("blocks missing products without dropping them from the reviewed selection", async () => {
    const service = bulkService();
    const request = { productIds: [1, 999], inventoryTrackingDefault: false };
    const preview = await service.preview(request);
    expect(preview.products[1]).toMatchObject({ productId: 999, status: "blocked", blockers: [{ code: "CATALOG_PRODUCT_MISSING" }] });
    const input = { ...request, expectedPreviewHash: preview.previewHash };
    expect(await service.apply(input, bulkCommand(input))).toMatchObject({ httpStatus: 409 });
    expect((await orm.select().from(schema.products))[0].inventoryTrackingDefault).toBe(true);
  });

  it("replays the exact committed result after a later edit and rejects key reuse with a different payload", async () => {
    const service = bulkService();
    const request = { productIds: [1], inventoryTrackingDefault: false };
    const preview = await service.preview(request);
    const input = { ...request, expectedPreviewHash: preview.previewHash };
    const result = await service.apply(input, bulkCommand(input));
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, true, "later-edit", now));
    const auditCount = (await orm.select().from(schema.auditEvents)).length;
    expect(await service.apply(input, bulkCommand(input))).toEqual({ ...result, replayed: true });
    expect((await orm.select().from(schema.products))[0].inventoryTrackingDefault).toBe(true);
    expect(await orm.select().from(schema.auditEvents)).toHaveLength(auditCount);
    const altered = { ...input, inventoryTrackingDefault: true };
    await expect(service.apply(altered, bulkCommand(altered))).rejects.toMatchObject({ statusCode: 422, code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
  });

  it("rolls back the entire bulk change and audit when the second product write fails", async () => {
    const variant = await createVariant();
    await orm.insert(schema.channelFeeds).values({ channelId: 36, productVariantId: variant.id, channelVariantId: "rollback-probe", isActive: 1 });
    await database.pool.query(`INSERT INTO catalog.products(id,name) VALUES(2,'Failure probe');
      CREATE FUNCTION catalog.fail_bulk_policy_probe() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id=2 THEN RAISE EXCEPTION 'Injected second product failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER bulk_policy_failure BEFORE UPDATE ON catalog.products FOR EACH ROW EXECUTE FUNCTION catalog.fail_bulk_policy_probe();`);
    try {
      const service = bulkService();
      const request = { productIds: [1, 2], inventoryTrackingDefault: false };
      const preview = await service.preview(request);
      const input = { ...request, expectedPreviewHash: preview.previewHash };
      await expect(service.apply(input, bulkCommand(input))).rejects.toThrow();
      expect((await orm.select().from(schema.products)).every(p => p.inventoryTrackingDefault)).toBe(true);
      expect((await orm.select().from(schema.productVariants))[0].trackInventory).toBe(true);
      expect((await orm.select().from(schema.channelFeeds))[0].isActive).toBe(1);
      expect(await orm.select().from(schema.auditEvents)).toHaveLength(0);
      expect((await database.pool.query("SELECT status FROM public.financial_command_results")).rows).toEqual([{ status: "retryable" }]);
    } finally {
      await database.pool.query("DROP TRIGGER bulk_policy_failure ON catalog.products; DROP FUNCTION catalog.fail_bulk_policy_probe()");
    }
  });

  it("serializes overlapping batches selected in opposite orders and rejects the stale loser", async () => {
    await database.pool.query("INSERT INTO catalog.products(id,name) VALUES(2,'Second')");
    const service = bulkService();
    const first = { productIds: [1, 2], inventoryTrackingDefault: false };
    const second = { ...first, productIds: [2, 1] };
    const preview = await service.preview(first);
    const inputs = [first, second].map(request => ({ ...request, expectedPreviewHash: preview.previewHash }));
    const results = await Promise.all(inputs.map((input, index) => service.apply(input, bulkCommand(input, `overlap-${index}`))));
    expect(results.map(result => result.httpStatus).sort()).toEqual([200, 409]);
    expect((await orm.select().from(schema.products)).every(p => !p.inventoryTrackingDefault)).toBe(true);
    expect((await orm.select().from(schema.auditEvents)).filter(a => a.action === "catalog.inventory_tracking_bulk.changed")).toHaveLength(1);
  });

  const importVariant = async (sku: string, requiresShipping: boolean) => {
    const result: BackfillResult = {
      success: true, dryRun: false,
      products: { total: 1, created: 0, updated: 0, skipped: 0 },
      variants: { total: 1, created: 0, updated: 0, skipped: 0 },
      feeds: { created: 0, updated: 0 }, listings: { created: 0, updated: 0 },
      pricing: { created: 0, updated: 0 }, assets: { created: 0 },
      inventory: { imported: 0, skipped: 0, noShopifyData: 0 },
      errors: [], mappingConflicts: [], mappings: [], reconciliation: [],
    };
    const imported = await orm.transaction(tx => {
      const importer = createCatalogBackfillService(tx);
      // Exercise the real per-variant import and Catalog writer without fetching
      // a remote catalog. Keep this private seam out of the production API.
      return importer["processVariant"](1, "1000", {
        id: 1001, title: "Default Title", sku, price: "1.00", compare_at_price: null,
        barcode: null, weight: null, weight_unit: null, inventory_item_id: 1002,
        requires_shipping: requiresShipping, position: 1,
        option1: null, option2: null, option3: null,
      }, 36, false, result, false, 1, 1);
    });
    expect(result.errors).toEqual([]);
    expect(imported).not.toBeNull();
    return imported!;
  };

  it.each([true, false].flatMap(productDefault => [true, false].map(requiresShipping => ({
    productDefault, requiresShipping,
  }))))("imports a new variant with product default $productDefault and shipping $requiresShipping, preserving inheritance on replay", async ({ productDefault, requiresShipping }) => {
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, productDefault, "user:test", now));
    const imported = await importVariant("IMPORTED", requiresShipping);
    expect(await importVariant("IMPORTED", requiresShipping)).toEqual(imported);
    expect(await orm.select().from(schema.productVariants)).toMatchObject([{
      id: imported.echelonVariantId, inventoryTrackingOverride: null,
      trackInventory: requiresShipping && productDefault, requiresShipping,
    }]);
    expect(await orm.select().from(schema.channelFeeds)).toMatchObject([{
      productVariantId: imported.echelonVariantId, isActive: requiresShipping && productDefault ? 1 : 0,
    }]);
    expect(await orm.select().from(schema.channelListings)).toHaveLength(1);
  });

  it.each([true, false].flatMap(productDefault => [null, true, false].map(override => ({
    productDefault, override,
  }))))("preserves override $override under product default $productDefault through physical, digital and physical imports", async ({ productDefault, override }) => {
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, productDefault, "user:test", now));
    const variant = await createVariant(override);
    for (const requiresShipping of [true, false, true]) {
      const imported = await importVariant(variant.sku!, requiresShipping);
      expect(imported.echelonVariantId).toBe(variant.id);
      const expectedTracking = requiresShipping && (override ?? productDefault);
      expect(await orm.select().from(schema.productVariants)).toMatchObject([{
        id: variant.id, inventoryTrackingOverride: override, trackInventory: expectedTracking, requiresShipping,
      }]);
      expect(await orm.select().from(schema.channelFeeds)).toMatchObject([{
        productVariantId: variant.id, isActive: expectedTracking ? 1 : 0,
      }]);
      expect(await orm.select().from(schema.channelListings)).toHaveLength(1);
    }
  });

  it("keeps binding upserts idempotent and removals scoped to their channel and product inside the caller transaction", async () => {
    await database.pool.query("INSERT INTO catalog.products(id,name) VALUES(2,'Other product')");
    const identity = { channelId: 36, productId: 1, externalProductId: "1000" };
    await orm.transaction(async tx => {
      await upsertChannelProductIdentity(tx, identity);
      await upsertChannelProductIdentity(tx, identity);
      await upsertChannelProductIdentity(tx, { ...identity, channelId: 37 });
      await upsertChannelProductIdentity(tx, { ...identity, productId: 2, externalProductId: "2000" });
      await removeChannelProductIdentities(tx, { channelId: 36, productIds: [] });
    });
    expect(await orm.select().from(schema.channelProductIdentities)).toHaveLength(3);
    await expect(orm.transaction(async tx => {
      await removeChannelProductIdentities(tx, { channelId: 36, productIds: [1] });
      throw new Error("Abort repair");
    })).rejects.toThrow("Abort repair");
    expect(await orm.select().from(schema.channelProductIdentities)).toHaveLength(3);
    await orm.transaction(tx => removeChannelProductIdentities(tx, { channelId: 36, productIds: [1] }));
    expect((await orm.select().from(schema.channelProductIdentities))
      .map(row => [row.channelId, row.productId]).sort()).toEqual([[36, 2], [37, 1]]);
  });

  it("rejects malformed bindings and competing external owners without changing the established identity", async () => {
    const identity = { channelId: 36, productId: 1, externalProductId: "1000" };
    await database.pool.query("INSERT INTO catalog.products(id,name) VALUES(2,'Other product')");
    await orm.transaction(tx => upsertChannelProductIdentity(tx, identity));
    await expect(orm.transaction(tx => upsertChannelProductIdentity(tx, { ...identity, productId: 2 })))
      .rejects.toMatchObject({ code: "23505" });
    await expect(orm.transaction(tx => upsertChannelProductIdentity(tx, { ...identity, externalProductId: " " })))
      .rejects.toMatchObject({ name: "ZodError" });
    await expect(orm.transaction(tx => removeChannelProductIdentities(tx, { channelId: 0, productIds: [1] })))
      .rejects.toMatchObject({ name: "ZodError" });
    expect(await orm.select().from(schema.channelProductIdentities)).toMatchObject([identity]);
  });

  it("inherits both defaults while explicit overrides survive product changes and migration replay", async () => {
    const inherited = await createVariant();
    const tracked = await createVariant(true);
    const untracked = await createVariant(false);
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now));
    expect((await orm.select().from(schema.productVariants).orderBy(schema.productVariants.id)).map(v => [v.id, v.trackInventory]))
      .toEqual([[inherited.id, false], [tracked.id, true], [untracked.id, false]]);
    await database.pool.query(migration);
    await database.pool.query(custodyMigration);
    expect((await orm.select().from(schema.productVariants).where(eq(schema.productVariants.id, inherited.id)))[0].inventoryTrackingOverride).toBeNull();
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, true, "user:test", now));
    expect((await orm.select().from(schema.productVariants).orderBy(schema.productVariants.id)).map(v => [v.id, v.trackInventory]))
      .toEqual([[inherited.id, true], [tracked.id, true], [untracked.id, false]]);
    expect(await orm.select().from(schema.auditEvents)).toHaveLength(2);
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, true, "user:test", now));
    expect(await orm.select().from(schema.auditEvents)).toHaveLength(2);
  });

  it("new variants inherit an untracked product and an explicit true overrides it", async () => {
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now));
    expect(await createVariant()).toMatchObject({ trackInventory: false, inventoryTrackingOverride: null });
    expect(await createVariant(true)).toMatchObject({ trackInventory: true, inventoryTrackingOverride: true });
  });

  it("resets an explicit variant override to the product default without ambiguity", async () => {
    const variant = await createVariant(false);
    const updated = await orm.transaction(tx => productMethods.updateProductVariant(variant.id,
      { inventoryTrackingOverride: null }, tx));
    expect(updated).toMatchObject({ trackInventory: true, inventoryTrackingOverride: null });
    await expect(orm.transaction(tx => productMethods.updateProductVariant(variant.id,
      { inventoryTrackingOverride: false, trackInventory: true }, tx)))
      .rejects.toMatchObject({ code: "INVENTORY_POLICY_INVALID" });
    expect((await orm.select().from(schema.productVariants))[0]).toMatchObject({ trackInventory: true, inventoryTrackingOverride: null });
  });

  it("rejects bypassing the projection owner and rolls back a blocked family change", async () => {
    const variant = await createVariant();
    await expect(database.pool.query("UPDATE catalog.products SET inventory_tracking_default=false WHERE id=1"))
      .rejects.toMatchObject({ code: "23514" });
    await database.pool.query(`INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty)
      VALUES($1,1,2)`, [variant.id]);
    await expect(orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now)))
      .rejects.toMatchObject({ code: "INVENTORY_POLICY_HAS_DEPENDENCIES" });
    expect((await orm.select().from(schema.products))[0].inventoryTrackingDefault).toBe(true);
    expect(await orm.select().from(schema.auditEvents)).toHaveLength(0);
  });

  it.each(["stock", "picked-lot", "packed-lot"])("serializes a concurrent %s write with disabling tracking", async kind => {
    const variant = await createVariant();
    const owner = await database.pool.connect();
    const receipt = await database.pool.connect();
    try {
      await owner.query("BEGIN");
      await owner.query("SELECT id FROM catalog.products WHERE id=1 FOR UPDATE");
      await owner.query("SELECT id FROM catalog.product_variants WHERE id=$1 FOR UPDATE", [variant.id]);
      await owner.query("UPDATE catalog.products SET inventory_tracking_default=false WHERE id=1");
      await owner.query("UPDATE catalog.product_variants SET track_inventory=false WHERE id=$1", [variant.id]);
      const insert = kind === "stock" ? `INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty) VALUES($1,1,1)`
        : `INSERT INTO inventory.inventory_lots(product_variant_id,warehouse_location_id,lot_number,received_at,${kind === "picked-lot" ? "qty_picked" : "qty_packed"})
          VALUES($1,1,'CONCURRENT',now(),1)`;
      const attempt = receipt.query(insert, [variant.id]).then(() => null, error => error);
      await owner.query("COMMIT");
      expect(await attempt).toMatchObject({ code: "23514" });
      expect(await orm.select().from(schema.inventoryLevels)).toHaveLength(0);
      expect(await orm.select().from(schema.inventoryLots)).toHaveLength(0);
    } finally { await owner.query("ROLLBACK"); owner.release(); receipt.release(); }
  });

  it("matches a product without variants by channel identity despite a reused SKU, preserving policy on replay", async () => {
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now));
    await database.pool.query(`INSERT INTO catalog.products(id,name) VALUES(2,'Other product');
      INSERT INTO catalog.product_variants(id,product_id,name,sku) VALUES(418,2,'Wrong item','REUSED');
      INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_product_id,external_variant_id)
      VALUES(36,418,'other-product','other-variant');
      INSERT INTO channels.channel_product_identities(channel_id,product_id,external_product_id) VALUES(36,1,'1000');`);
    const source = { channelId: 36, externalProductId: "1000", externalVariantId: "1001", sku: "REUSED" };
    expect(await resolveOrderLineCatalogIdentity(orm, source)).toMatchObject({ id: null, productId: 1, inventoryTracking: false, matchedBy: "channel_product_id" });
    await expect(resolveOrderLineCatalogIdentity(orm, { ...source, externalProductId: "unmapped" }))
      .rejects.toMatchObject({ code: "ORDER_LINE_PRODUCT_IDENTITY_CONFLICT" });
    expect(await resolveOrderLineCatalogIdentity(orm, { ...source, channelId: 37, sku: null })).toBeNull();
    const data = { orderedAt: now, sourceTopic: "orders/paid", sourceEventId: "fixture-paid", financialStatus: "paid",
      lineItems: normalizeShopifyLineItems([{ id: 20, product_id: 1000, variant_id: 1001, sku: "REUSED", title: "Stickers", quantity: 5, price: "1.00", requires_shipping: true }], []) };
    const service = createOmsService(orm);
    await service.ingestOrder(36, "combined-source-1", data);
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, true, "user:test", now));
    await service.ingestOrder(36, "combined-source-1", data);
    const [line] = await orm.select().from(schema.omsOrderLines);
    expect(line).toMatchObject({ productVariantId: null, catalogProductId: 1, inventoryTracking: false, quantity: 5 });
    expect((await orm.select().from(schema.omsOrderEvents)).filter(event => event.eventType === "line_catalog_identity_resolved")).toHaveLength(1);
    const item = await buildWmsLineItemFromOmsLine(orm, line, 5, 1);
    expect(item).toMatchObject({ productId: null, catalogProductId: 1, inventoryTracking: false, pickedQuantity: 0, requiresShipping: 1 });
    expect(decideChannelFulfillmentInventoryPosting({ omsRequiresShipping: true, wmsRequiresShipping: 1,
      omsInventoryTracking: line.inventoryTracking, wmsInventoryTracking: item.inventoryTracking,
      omsCatalogProductId: line.catalogProductId, wmsCatalogProductId: item.catalogProductId,
      productVariantId: null, catalogVariantId: null, catalogRequiresShipping: null, catalogTrackInventory: null,
    })).toMatchObject({ status: "resolved", requiresInventoryPosting: false });
    // An already-existing pre-migration line keeps its legacy classification on replay.
    await orm.update(schema.omsOrderLines).set({ catalogProductId: null, inventoryTracking: null });
    await service.ingestOrder(36, "combined-source-1", data);
    expect((await orm.select().from(schema.omsOrderLines))[0]).toMatchObject({ catalogProductId: null, inventoryTracking: null });
  });
  it.each([null, 69].flatMap(combinedGroupId => ["legacy", "canonical"].map(authority => ({ combinedGroupId, authority }))))(
    "confirms, replays and reverses a product-only pick in group $combinedGroupId under $authority without stock writes", async ({ combinedGroupId, authority }) => {
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now));
    const [order] = await orm.insert(schema.wmsOrders).values({ orderNumber: "#63300", customerName: "Test", combinedGroupId, warehouseStatus: "ready" }).returning();
    const [item] = await orm.insert(schema.wmsOrderItems).values({ orderId: order.id, sku: "PRODUCT", name: "Stickers", quantity: 5,
      catalogProductId: 1, inventoryTracking: false, requiresShipping: 1, location: "UNASSIGNED" }).returning();
    const storage = {
      getOrderItemById: async (id: number) => (await orm.select().from(schema.wmsOrderItems).where(eq(schema.wmsOrderItems.id, id)))[0],
      getOrderById: async (id: number) => (await orm.select().from(schema.wmsOrders).where(eq(schema.wmsOrders.id, id)))[0],
      getOrderItems: async (id: number) => orm.select().from(schema.wmsOrderItems).where(eq(schema.wmsOrderItems.orderId, id)),
      getAllWarehouseSettings: async () => [],
      getUser: async () => ({ id: "picker", username: "picker", role: "picker" }),
      createPickingLog: async (row: typeof schema.pickingLogs.$inferInsert) => orm.insert(schema.pickingLogs).values(row),
      updateOrderProgress: vi.fn(async () => undefined),
      getProductVariantBySku: vi.fn(async () => undefined),
    };
    const inventoryCore = { withTx: () => inventoryCore, pickItem: vi.fn(), unpickItem: vi.fn() };
    const getLatestClaim = vi.fn();
    const runtime = authority === "canonical" ? { execute: async (work: (context: unknown) => Promise<unknown>) =>
      work({ authority: "canonical", getLatestClaim }) } : undefined;
    const service = new PickingUseCases(orm as never, inventoryCore as never, {} as never, storage as never,
      undefined, undefined, false, runtime as never);
    const request = { status: "completed", pickedQuantity: 5, userId: "picker", pickMethod: "pick_all" };
    expect(await service.pickItem(item.id, request)).toMatchObject({ success: true, item: { pickedQuantity: 5, status: "completed" } });
    expect(storage.updateOrderProgress).toHaveBeenLastCalledWith(order.id, "ready_to_ship");
    expect(await service.pickItem(item.id, request)).toMatchObject({ success: true });
    expect((await orm.select().from(schema.pickingLogs)).filter(log => log.actionType === "item_picked")).toHaveLength(1);
    expect((await orm.select().from(schema.auditEvents)).filter(event => event.action === "wms.non_inventory_pick_confirmed")).toHaveLength(1);
    expect(await service.unpickItem(item.id, { qty: 5, userId: "picker", reason: "Reconfirm physical goods" })).toMatchObject({ success: true, item: { pickedQuantity: 0 } });
    expect((await orm.select().from(schema.auditEvents)).filter(event => event.action === "wms.non_inventory_pick_reversed")).toHaveLength(1);
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();
    expect(inventoryCore.unpickItem).not.toHaveBeenCalled();
    expect(getLatestClaim).not.toHaveBeenCalled();
    expect(await orm.select().from(schema.inventoryLevels)).toHaveLength(0);
    expect(await orm.select().from(schema.inventoryLots)).toHaveLength(0);
  });

  it("verifies and links a product without creating variants, and replay is idempotent", async () => {
    const verifyShopifyProduct = vi.fn(async () => ({ id: "1000", title: "Stickers", variants: [
      { id: "1001", sku: "REUSED", inventoryItemId: "1002", barcode: null },
    ] }));
    const mapping = createShopifyProductMappingService({ database: orm as never, verifyShopifyProduct });
    const request = { productId: 1, channelId: 36, targetProductId: "1000", actor: "user:catalog", allowProductOnlyAdoption: true };
    expect(await mapping.repair(request)).toMatchObject({ alreadyConsistent: false, mappedVariantCount: 0 });
    expect(verifyShopifyProduct).toHaveBeenCalledWith(36, "1000");
    expect(await orm.select().from(schema.productVariants)).toHaveLength(0);
    expect(await orm.select().from(schema.channelProductIdentities)).toMatchObject([{ productId: 1, channelId: 36, externalProductId: "1000" }]);
    expect(await mapping.repair(request)).toMatchObject({ alreadyConsistent: true });
    expect((await orm.select().from(schema.auditEvents)).filter(event => event.action === "catalog.shopify_product_mapping_repaired")).toHaveLength(1);
  });

  it("excludes a product-only physical line from legacy reservations and canonical stock claims", async () => {
    const [order] = await orm.insert(schema.wmsOrders).values({ orderNumber: "#NONSTOCK", customerName: "Test", warehouseStatus: "ready" }).returning();
    await orm.insert(schema.wmsOrderItems).values({ orderId: order.id, sku: "PRODUCT", name: "Stickers", quantity: 5,
      catalogProductId: 1, inventoryTracking: false, requiresShipping: 1 });
    const reservation = createReservationService(orm, {}, {}, {}, undefined, () => now);
    expect(await reservation.reserveOrder(order.id)).toMatchObject({ reserved: 0, promised: 0, failed: [] });
    await orm.insert(schema.inventoryAvailabilityRuntimeAuthority).values({ authority: "canonical", activationRunId: BigInt(1),
      changedBy: "test", changeReason: "Disposable policy test" });
    const claims = new PostgresInventoryAvailabilityClaimRepository({} as never, database.pool, () => now);
    const request = { orderId: order.id, idempotencyKey: "product-only-claim", actor: "test", reason: "Confirm no stock demand" };
    expect(await claims.claimOrder(request)).toMatchObject({ outcome: "no_claim_required", idempotentReplay: false });
    expect(await claims.claimOrder(request)).toMatchObject({ outcome: "no_claim_required", idempotentReplay: true });
    expect(await orm.select().from(schema.inventoryAvailabilityClaimLines)).toHaveLength(0);
    expect(await orm.select().from(schema.inventoryAvailabilityClaimResources)).toHaveLength(0);
  });

});
