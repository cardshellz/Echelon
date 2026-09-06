import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "../integration/shipment-line-fixture";

// Deliberately outside both `unit` and `integration` selection. These passing
// characterizations assert KNOWN DEFECTS, not the desired accounting contract.
config({ path: resolve(process.cwd(), ".env.test") });
const url = process.env.ECHELON_TEST_DATABASE_URL;
const enabled = process.env.ECHELON_COST_AUDIT === "true"
  && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" && !!url;
const audit = enabled ? describe : describe.skip;
const NOW = new Date("2026-09-06T12:00:00.000Z");
const TABLES = [
  schema.products, schema.productVariants, schema.vendors, schema.purchaseOrders,
  schema.purchaseOrderLines, schema.inboundShipments, schema.inboundShipmentLines,
  schema.receivingOrders, schema.receivingLines, schema.poReceipts, schema.receiptReversals,
  schema.vendorInvoices, schema.vendorInvoiceLines, schema.poStatusHistory,
  schema.inboundFreightCosts, schema.inboundFreightAllocations,
  schema.landedCostSnapshots, schema.landedCostAdjustments, schema.inboundShipmentStatusHistory,
  schema.warehouses, schema.warehouseLocations, schema.inventoryLevels,
  schema.inventoryLots, schema.inventoryTransactions, schema.orders, schema.orderItems, schema.orderItemCosts,
];

audit.sequential("AUDIT ONLY: current receipt/AP/freight cost defects with real owners", () => {
  const actorId = `cost-audit-${randomUUID()}`;
  const ownedSchemas: string[] = [];
  let ownsAudit = false;
  let pool: pg.Pool;
  let lease: pg.PoolClient | undefined;
  let defaultModulePool: pg.Pool | undefined;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let storage: any;
  let receiving: import("../../receiving.service").ReceivingService;
  let purchasing: ReturnType<typeof import("../../purchasing.service").createPurchasingService>;
  let shipment: ReturnType<typeof import("../../shipment-tracking.service").createShipmentTrackingService>;
  let createShipment: typeof import("../../shipment-tracking.service").createShipmentTrackingService;
  let cogs: import("../../../inventory/cogs.service").COGSService;
  let reconcile: typeof import("../../ap-ledger.service").reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction;

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url!)) {
      throw new Error("Cost audit requires a separate explicitly disposable LOCAL database");
    }
    pool = new pg.Pool({ connectionString: url, max: 10, ssl: false, statement_timeout: 15_000 });
    lease = await pool.connect();
    const lock = await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-audit-fixture')) AS acquired");
    if (!lock.rows[0].acquired) throw new Error("Another cost audit owns the fixture lease");
    // CREATE fails on an existing schema. Never drop an unowned schema to begin a test.
    for (const name of ["catalog", "procurement", "warehouse", "inventory", "wms", "oms"]) {
      await pool.query(`CREATE SCHEMA ${name}`);
      ownedSchemas.push(name);
    }
    for (const table of TABLES) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(TABLES)) await pool.query(statement);
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/221_receiving_unit_snapshots.sql"), "utf8"));
    await pool.query(`
      CREATE UNIQUE INDEX audit_po_receipt_unique ON procurement.po_receipts(purchase_order_line_id,receiving_line_id);
      CREATE UNIQUE INDEX audit_inventory_level_unique ON inventory.inventory_levels(product_variant_id,warehouse_location_id);
      CREATE UNIQUE INDEX audit_freight_allocation_unique ON procurement.inbound_freight_allocations(shipment_cost_id,inbound_shipment_line_id);
      CREATE UNIQUE INDEX audit_snapshot_unique ON procurement.landed_cost_snapshots(inbound_shipment_line_id) WHERE inbound_shipment_line_id IS NOT NULL;
      CREATE TABLE inventory.cost_adjustment_log (
        id SERIAL PRIMARY KEY, lot_id INTEGER NOT NULL, lot_number VARCHAR(50), product_variant_id INTEGER,
        sku VARCHAR(100), old_cost_cents BIGINT, new_cost_cents BIGINT, delta_cents BIGINT,
        reason VARCHAR(100), created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
    // The log is runtime DDL in server/db.ts:997, with money types aligned by migration0576.
    if (!(await pool.query("SELECT to_regclass('public.audit_events') AS relation")).rows[0].relation) {
      await pool.query(fixtureTable(schema.auditEvents)); ownsAudit = true;
    }
    database = drizzle(pool, { schema });
    const priorDatabase = process.env.DATABASE_URL;
    const priorExternal = process.env.EXTERNAL_DATABASE_URL;
    delete process.env.DATABASE_URL; delete process.env.EXTERNAL_DATABASE_URL;
    try {
      const [receivingModule, purchasingModule, shipmentModule, procurementModule, catalogModule,
        inventoryModule, repositoryModule, lotModule, cogsModule, apModule, dbModule] = await Promise.all([
        import("../../receiving.service"), import("../../purchasing.service"), import("../../shipment-tracking.service"),
        import("../../procurement.storage"), import("../../../catalog/catalog.storage"),
        import("../../../inventory/application/inventory.use-cases"), import("../../../inventory/infrastructure/inventory.repository"),
        import("../../../inventory/lots.service"), import("../../../inventory/cogs.service"),
        import("../../ap-ledger.service"), import("../../../../db"),
      ]);
      defaultModulePool = dbModule.pool;
      // Redirect legacy module-global database calls to the SAME disposable SQL pool. This never
      // substitutes query results; every business read/write still executes in PostgreSQL.
      defaultModulePool.query = pool.query.bind(pool) as any;
      defaultModulePool.connect = pool.connect.bind(pool) as any;
      const methods = { ...procurementModule.procurementMethods, ...catalogModule.productMethods } as any;
      storage = { ...methods };
      const executorPositions: Record<string, number> = {
        generateReceiptNumber: 0, createReceivingOrder: 1, bulkCreateReceivingLines: 1,
        getReceivingOrderById: 1, getReceivingLineById: 1, getReceivingLines: 1,
        getReceivingOrdersForPurchaseOrder: 1, getReceivingOrdersForInboundShipment: 1,
        updateReceivingLine: 2, updateReceivingOrder: 2,
        getPurchaseOrderById: 1, getPurchaseOrderLines: 1, getPurchaseOrderLineById: 1,
        updatePurchaseOrder: 2, updatePurchaseOrderLine: 2, updatePurchaseOrderStatusWithHistory: 3, reconcilePoReceiptLine: 1,
        getProductVariantById: 1, getProductVariantsByProductId: 1,
        getInboundShipmentById: 1, getInboundShipmentLines: 1, updateInboundShipment: 2, updateInboundShipmentLine: 2,
        getInboundFreightCosts: 1, getInboundFreightCostById: 1, getAllocationsForLine: 1,
        getInboundFreightCostAllocations: 1, deleteInboundFreightCostAllocations: 1,
        bulkCreateInboundFreightCostAllocations: 1, getLandedCostSnapshots: 1, getLandedCostSnapshotByPoLine: 1,
        deleteLandedCostSnapshotsForShipment: 1, bulkCreateLandedCostSnapshots: 1,
        createLandedCostAdjustment: 1, createInboundShipmentStatusHistory: 1, getProvisionalLotsByShipment: 1,
      };
      for (const [name, position] of Object.entries(executorPositions)) {
        if (typeof methods[name] !== "function") continue;
        storage[name] = (...args: any[]) => {
          args[position] ??= database;
          return methods[name].apply(storage, args);
        };
      }
      reconcile = apModule.reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction;
      cogs = new cogsModule.COGSService(database);
      const inventory = new inventoryModule.InventoryUseCases(database,
        repositoryModule.createInventoryMethods(database), new lotModule.InventoryLotService(database), cogs);
      purchasing = purchasingModule.createPurchasingService(database, storage, {
        reconcileApprovedInvoiceCost: (id, tx, actor) => reconcile(id, tx, actor),
      });
      createShipment = shipmentModule.createShipmentTrackingService;
      shipment = createShipment(database, storage, cogs, () => NOW);
      receiving = new receivingModule.ReceivingService(database, inventory,
        { queueSyncAfterInventoryChange: async () => undefined }, storage, purchasing, shipment, null,
        { reconcilePurchaseOrderLine: (id, tx, actor) => reconcile(id, tx, actor) }, null, null, () => NOW);
    } finally {
      if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
      if (priorExternal === undefined) delete process.env.EXTERNAL_DATABASE_URL; else process.env.EXTERNAL_DATABASE_URL = priorExternal;
    }
  });

  beforeEach(async () => {
    if (ownedSchemas.length !== 6) throw new Error("Fixture schema ownership missing");
    await pool.query(`TRUNCATE ${TABLES.map(qualifiedTable).join(",")},inventory.cost_adjustment_log RESTART IDENTITY CASCADE`);
    await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
    await pool.query(`
      INSERT INTO catalog.products(id,sku,name) VALUES(100,'AUDIT-PRODUCT','Synthetic cost audit product');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit)
        VALUES(200,100,'AUDIT-CASE','Case of 50',50,'case',false),(201,100,'AUDIT-EACH','Each',1,'piece',true);
      INSERT INTO procurement.vendors(id,code,name) VALUES(5,'AUDIT-VENDOR','Synthetic vendor');
      INSERT INTO warehouse.warehouses(id,code,name) VALUES(1,'AUDIT-WH','Synthetic warehouse');
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(99,1,'AUDIT-DOCK');
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,warehouse_id)
        VALUES(10,'AUDIT-PO',5,'sent',1);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,expected_receive_variant_id,expected_receive_units_per_variant,sku,
        order_qty,unit_cost_cents,unit_cost_mills,total_product_cost_cents,packaging_cost_cents,line_total_cents,status)
        VALUES(21,10,1,100,200,200,50,'AUDIT-PRODUCT',200,100,10000,20000,2000,22000,'open');
      INSERT INTO procurement.inbound_shipments(id,shipment_number,status,allocation_method_default)
        VALUES(1,'AUDIT-SHIP','costing','by_line_count');
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,
        sku,qty_shipped,carton_count,allocated_cost_cents)
        VALUES(11,1,10,21,200,'AUDIT-PRODUCT',100,2,0);
      INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,actual_cents,allocation_method,cost_status,currency,exchange_rate)
        VALUES(31,1,'freight',5000,'by_line_count','finalized','USD',1);
      INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,balance_cents)
        VALUES(71,'AUDIT-INVOICE',5,'received',24000,24000);
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,purchase_order_line_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents)
        VALUES(72,71,1,21,200,120,12000,24000);
      INSERT INTO wms.orders(id,order_number,customer_name) VALUES(1,'AUDIT-SALE','Synthetic customer');
      INSERT INTO wms.order_items(id,order_id,sku,name,quantity) VALUES(1,1,'AUDIT-CASE','Synthetic case',1)`);
  });

  afterAll(async () => {
    try {
      if (pool) {
        if (ownsAudit) await pool.query("DROP TABLE public.audit_events");
        else if (ownedSchemas.length === 6) await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
        for (const name of [...ownedSchemas].reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`);
      }
    } finally {
      if (lease) { await lease.query("SELECT pg_advisory_unlock(hashtext('echelon.procurement.cost-audit-fixture'))"); lease.release(); }
      await pool?.end(); await defaultModulePool?.end();
    }
  });

  async function prepareReceipt() {
    const receipt = await purchasing.createReceiptFromShipment(1, actorId, { purchaseOrderId: 10 });
    const [line] = await storage.getReceivingLines(receipt.id);
    expect(line).toMatchObject({ unitsPerVariantSnapshot: 50, expectedQty: 2, inboundShipmentLineId: 11, purchaseOrderLineId: 21 });
    await receiving.open(receipt.id, actorId);
    await receiving.updateLine(line.id, { receivedQty: 2, putawayLocationId: 99, expectedUnitVersion: receivingUnitVersion(line) }, actorId);
    return { receiptId: receipt.id as number, lineId: line.id as number };
  }
  async function receive() {
    const ids = await prepareReceipt();
    await receiving.close(ids.receiptId, actorId);
    const lineage = (await pool.query(`SELECT t.receiving_line_id,rl.units_per_variant_snapshot,rl.inbound_shipment_line_id,
      pr.qty_received AS received_qty,l.qty_received FROM inventory.inventory_transactions t
      JOIN inventory.inventory_lots l ON l.id=t.inventory_lot_id
      JOIN procurement.receiving_lines rl ON rl.id=t.receiving_line_id
      JOIN procurement.po_receipts pr ON pr.receiving_line_id=rl.id
      WHERE t.transaction_type='receipt' AND t.voided_at IS NULL`)).rows;
    expect(lineage).toEqual([{ receiving_line_id: ids.lineId, units_per_variant_snapshot: 50, inbound_shipment_line_id: 11, received_qty: 100, qty_received: 2 }]);
    return ids;
  }
  async function lot() {
    return (await pool.query(`SELECT id,po_unit_cost_mills::text AS product,packaging_cost_mills::text AS packaging,
      landed_cost_mills::text AS freight,total_unit_cost_mills::text AS total,cost_provisional,cost_source
      FROM inventory.inventory_lots ORDER BY id`)).rows[0];
  }
  async function seedConsumedCost() {
    await pool.query(`INSERT INTO oms.order_item_costs(order_id,order_item_id,inventory_lot_id,product_variant_id,qty,
      unit_cost_cents,total_cost_cents,unit_cost_mills,total_cost_mills)
      SELECT 1,1,id,product_variant_id,1,total_unit_cost_cents,total_unit_cost_cents,total_unit_cost_mills,total_unit_cost_mills
      FROM inventory.inventory_lots`);
  }
  async function approveEvidence(tx: any = undefined) {
    const apply = async (client: any) => {
      // Synthetic evidence setup only; the actual AP reconciliation below owns
      // invoice selection, weighted price, lot recost, COGS cascade, and AP audit.
      await client.execute(sql`UPDATE procurement.vendor_invoices SET status='approved' WHERE id=71`);
      return reconcile(21, client, actorId);
    };
    return tx ? apply(tx) : database.transaction(apply);
  }
  async function state() {
    const relations = [...TABLES.map(qualifiedTable), "inventory.cost_adjustment_log"];
    const values = [];
    for (const relation of relations) values.push((await pool.query(`SELECT * FROM ${relation} ORDER BY id`)).rows);
    values.push((await pool.query("SELECT * FROM public.audit_events WHERE actor=$1 ORDER BY id", [actorId])).rows);
    return values;
  }
  async function failAudit(work: () => Promise<void>) {
    await pool.query(`CREATE FUNCTION procurement.cost_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='ap_ledger.po_line_cost_reconciled' THEN RAISE EXCEPTION 'cost audit injected AP audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER cost_audit_fail BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION procurement.cost_audit_fail()`);
    try { await work(); }
    finally { await pool.query("DROP TRIGGER cost_audit_fail ON public.audit_events; DROP FUNCTION procurement.cost_audit_fail()"); }
  }

  it("DEFECT current product-only generated receipt omits the separately recorded packaging layer", async () => {
    await receive();
    expect(await lot()).toMatchObject({ product: "500000", packaging: "0", freight: "0", total: "500000", cost_provisional: 1 });
    // PO carries 2000 packaging cents / 200 base pieces * 50 pieces = 50000 mills per case.
    expect((await lot()).total).not.toBe("550000");
    const auditRow = (await pool.query("SELECT context FROM public.audit_events WHERE actor=$1 AND action='ap_ledger.po_line_cost_reconciled'", [actorId])).rows;
    expect(auditRow[0].context).toMatchObject({ state: "po_fallback_no_approved_invoice", lotsUpdated: 0 });
  });

  it("DEFECT historical blended PO unit price conditionally counts packaging twice at receive-time AP fallback", async () => {
    await pool.query("UPDATE procurement.purchase_order_lines SET unit_cost_mills=11000,unit_cost_cents=110 WHERE id=21");
    await receive();
    expect(await lot()).toMatchObject({ product: "550000", packaging: "50000", freight: "0", total: "600000", cost_provisional: 0 });
    expect((await lot()).total).not.toBe("550000");
  });

  it("DEFECT receipt -> approved invoice -> freight loses pending freight eligibility and never recosts COGS for freight", async () => {
    await receive(); await seedConsumedCost();
    expect(await approveEvidence()).toMatchObject({ state: "invoice_actual", lotsUpdated: 1, cogsRowsUpdated: 1 });
    expect(await lot()).toMatchObject({ product: "600000", freight: "0", cost_provisional: 0 });
    await shipment.finalizeAllocations(1, actorId);
    expect(await shipment.pushLandedCostsToLots(1)).toEqual({ updated: 0, total: 0, skipped: [] });
    expect((await pool.query("SELECT total_cost_mills::text AS cost FROM oms.order_item_costs")).rows).toEqual([{ cost: "600000" }]);
    expect((await lot()).total).not.toBe("850000");
  });

  it("DEFECT freight -> receipt -> approved invoice erases finalized freight during the real receive-time AP callback", async () => {
    await shipment.finalizeAllocations(1, actorId);
    await receive();
    expect(await lot()).toMatchObject({ product: "500000", freight: "0", total: "500000", cost_provisional: 0 });
    await seedConsumedCost(); await approveEvidence();
    expect(await lot()).toMatchObject({ total: "600000", freight: "0" });
    expect(await shipment.pushLandedCostsToLots(1)).toEqual({ updated: 0, total: 0, skipped: [] });
  });

  it("contrasting order receipt -> freight -> invoice preserves freight, proving event-order dependence", async () => {
    await receive(); await seedConsumedCost(); await shipment.finalizeAllocations(1, actorId);
    expect(await shipment.pushLandedCostsToLots(1)).toEqual({ updated: 1, total: 1, skipped: [] });
    await approveEvidence();
    expect(await lot()).toMatchObject({ product: "600000", freight: "250000", total: "850000" });
    expect((await pool.query("SELECT total_cost_mills::text AS cost FROM oms.order_item_costs")).rows).toEqual([{ cost: "850000" }]);
  });

  it("DEFECT approved invoice rescales a frozen 50-piece receipt using a subsequently edited 100-piece catalog factor", async () => {
    const ids = await receive(); await seedConsumedCost();
    await pool.query("UPDATE catalog.product_variants SET units_per_variant=100 WHERE id=200");
    await approveEvidence();
    expect((await storage.getReceivingLineById(ids.lineId)).unitsPerVariantSnapshot).toBe(50);
    expect(await lot()).toMatchObject({ product: "1200000", total: "1200000" });
    expect((await lot()).product).not.toBe("600000");
  });

  it("real receive/AP audit failure rolls back inventory, lot, receipt and PO state together", async () => {
    const ids = await prepareReceipt(); const before = await state();
    await failAudit(async () => { await expect(receiving.close(ids.receiptId, actorId)).rejects.toThrow(/cost audit injected AP audit failure/); });
    expect(await state()).toEqual(before);
  });

  it("real AP audit failure rolls back invoice evidence, lot layers, consumed COGS and adjustment log", async () => {
    await receive(); await seedConsumedCost(); const before = await state();
    await failAudit(async () => { await expect(approveEvidence()).rejects.toThrow(/cost audit injected AP audit failure/); });
    expect(await state()).toEqual(before);
  });

  it("DEFECT overlapping AP and freight can apply freight that a serial AP-then-freight call skips", async () => {
    await receive(); await seedConsumedCost(); await shipment.finalizeAllocations(1, actorId);
    let release!: () => void;
    let ready!: () => void;
    const hold = new Promise<void>((resolveHold) => { release = resolveHold; });
    const changed = new Promise<void>((resolveReady) => { ready = resolveReady; });
    const pendingAp = database.transaction(async (tx) => {
      await approveEvidence(tx); ready(); await hold;
    });
    let pendingFreight: Promise<unknown> | undefined;
    try {
      await changed;
      let reportPid!: (pid: number) => void;
      const pidReady = new Promise<number>((resolvePid) => { reportPid = resolvePid; });
      const observedDb = { transaction: (work: (tx: any) => Promise<unknown>) => database.transaction(async (tx) => {
        const pid = await tx.execute(sql`SELECT pg_backend_pid() AS pid`); reportPid(Number(pid.rows[0].pid));
        return work(tx);
      }) };
      pendingFreight = createShipment(observedDb as any, storage, cogs, () => NOW).pushLandedCostsToLots(1);
      const pid = await pidReady;
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked = (await pool.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      expect(blocked).toBe(true); release(); await pendingAp;
      expect(await pendingFreight).toEqual({ updated: 1, total: 1, skipped: [] });
      expect(await lot()).toMatchObject({ product: "600000", freight: "250000", total: "850000" });
    } finally { release(); await pendingAp; await pendingFreight; }
  });
});
