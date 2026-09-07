import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { lockInventoryCostGraph } from "../../../inventory/infrastructure/cost-evidence.repository";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

// Real PostgreSQL regression coverage for the coordinated receipt/AP/freight owners.
config({ path: resolve(process.cwd(), ".env.test") });
const url = process.env.ECHELON_TEST_DATABASE_URL;
const enabled = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" && !!url;
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

audit.sequential("receipt/AP/freight cost revisions with real owners", () => {
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
  let inventory: import("../../../inventory/application/inventory.use-cases").InventoryUseCases;
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
    const lock = await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-application-fixture')) AS acquired");
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
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/222_procurement_cost_evidence.sql"), "utf8"));
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
      inventory = new inventoryModule.InventoryUseCases(database,
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
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,purchase_order_line_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents,cost_component_evidence)
        VALUES(72,71,1,21,200,120,12000,26000,'{"contractVersion":1,"packagingTreatment":"separate","productMills":2400000,"packagingMills":200000,"adjustmentMills":0,"source":"operator_review"}'::jsonb);
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
      if (lease) { await lease.query("SELECT pg_advisory_unlock(hashtext('echelon.procurement.cost-application-fixture'))"); lease.release(); }
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
      await lockInventoryCostGraph(client);
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

  it("records product and packaging separately using exact purchase evidence", async () => {
    await receive();
    expect(await lot()).toMatchObject({ product: "500000", packaging: "50000", freight: "0", total: "550000", cost_provisional: 1 });
    const sources = (await pool.query("SELECT component,contract FROM procurement.cost_source_revisions ORDER BY id")).rows;
    expect(sources.some((source) => source.component === "packaging" && source.contract.totalMills === 200000)).toBe(true);
    expect((await pool.query("SELECT units_per_variant_snapshot FROM inventory.lot_cost_origins")).rows).toEqual([{ units_per_variant_snapshot: 50 }]);
  });

  it.each(["receipt-invoice-freight", "freight-receipt-invoice", "receipt-freight-invoice", "invoice-receipt-freight", "invoice-freight-receipt", "freight-invoice-receipt"])("converges product, packaging, freight and sold COGS for %s", async (order) => {
    for (const action of order.split("-")) {
      if (action === "receipt") { await receive(); await seedConsumedCost(); }
      if (action === "invoice") await approveEvidence();
      if (action === "freight") { await shipment.finalizeAllocations(1, actorId); await shipment.pushLandedCostsToLots(1); }
    }
    expect(await lot()).toMatchObject({ product: "600000", packaging: "50000", freight: "250000", total: "900000" });
    expect((await pool.query("SELECT total_cost_mills::text AS cost FROM oms.order_item_costs")).rows).toEqual([{ cost: "900000" }]);
    const current = (await pool.query("SELECT DISTINCT ON(component) component,contract FROM procurement.cost_source_revisions WHERE component IN ('product','packaging') ORDER BY component,revision DESC")).rows;
    expect(current.every((source) => source.contract.evidence === "confirmed")).toBe(true);
  });

  it("blocks stale freight allocation and preserves exact original charge evidence until refreshed", async () => {
    await receive(); await shipment.finalizeAllocations(1,actorId); await shipment.pushLandedCostsToLots(1);
    const before = await lot();
    const original = (await pool.query("SELECT id,source_evidence FROM procurement.cost_source_revisions WHERE component='landed' AND contract->>'evidence'='confirmed' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(original.source_evidence.charges[0].actual_cents).toBe("5000");
    const changedCharge = await pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=6000 WHERE id=31");
    expect(changedCharge.rowCount).toBe(1);
    const review = await shipment.pushLandedCostsToLots(1);
    expect(review.costApplications[0]).toMatchObject({status:"review_required",issues:expect.arrayContaining([expect.objectContaining({code:"LANDED_ALLOCATION_STALE"})])});
    expect(await lot()).toEqual(before);
    await shipment.finalizeAllocations(1,actorId); await shipment.pushLandedCostsToLots(1);
    expect(await lot()).toMatchObject({freight:"300000",total:"850000"});
    expect((await pool.query("SELECT source_evidence FROM procurement.cost_source_revisions WHERE id=$1",[original.id])).rows[0]).toEqual({source_evidence:original.source_evidence});
  });

  it("rejects old value allocation at receipt after the underlying PO price changes with equal quantity", async () => {
    await pool.query("UPDATE procurement.inbound_freight_costs SET allocation_method='by_value' WHERE id=31");
    await shipment.finalizeAllocations(1, actorId);
    const original = (await pool.query("SELECT id,source_evidence FROM procurement.cost_source_revisions WHERE component='landed' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(original.source_evidence.allocationBasis[0]).toMatchObject({ method: "by_value", basisTotal: 10000 });
    // The actual storage writer changes only purchase economics, leaving the
    // shipment, charge, quantity and finalized allocation untouched.
    await storage.updatePurchaseOrderLine(21, { unitCostCents: 150, unitCostMills: 15000, totalProductCostCents: 30000, lineTotalCents: 32000 });
    expect((await shipment.getAllocationStatus(1)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "stale_allocation_basis" })]));
    const { recordShipmentCostRevisions } = await import("../../shipment-cost-application.service");
    const check = await database.transaction((tx) => recordShipmentCostRevisions(tx, 1, actorId, NOW));
    expect(check.revisions[0].contract).toMatchObject({ evidence: "review_required", issue: { code: "LANDED_ALLOCATION_STALE" } });
    await receive();
    expect(await lot()).toMatchObject({ freight: "0" });
    await shipment.finalizeAllocations(1, actorId); await shipment.pushLandedCostsToLots(1);
    expect(await lot()).toMatchObject({ freight: "250000" });
    expect((await pool.query("SELECT source_evidence FROM procurement.cost_source_revisions WHERE id=$1", [original.id])).rows[0]).toEqual({ source_evidence: original.source_evidence });
  });

  it("requires renewed finalization when the effective shipment default changes even with equal numeric basis", async () => {
    await pool.query("UPDATE procurement.inbound_freight_costs SET allocation_method=NULL WHERE id=31");
    await pool.query("UPDATE procurement.inbound_shipment_lines SET total_weight_kg=1 WHERE id=11");
    await shipment.finalizeAllocations(1, actorId);
    await pool.query("UPDATE procurement.inbound_shipments SET allocation_method_default='by_weight' WHERE id=1");
    const { recordShipmentCostRevisions } = await import("../../shipment-cost-application.service");
    const stale = await database.transaction((tx) => recordShipmentCostRevisions(tx, 1, actorId, NOW));
    expect(stale.revisions[0].contract.issue?.code).toBe("LANDED_ALLOCATION_STALE");
    // Reading again must not replace the last valid finalization baseline with
    // the just-recorded review evidence and thereby clear its own guard.
    const repeated = await database.transaction((tx) => recordShipmentCostRevisions(tx, 1, actorId, NOW));
    expect(repeated.revisions[0].id).toBe(stale.revisions[0].id);
    expect(repeated.revisions[0].contract.issue?.code).toBe("LANDED_ALLOCATION_STALE");
    await shipment.finalizeAllocations(1, actorId);
    const fresh = await database.transaction((tx) => recordShipmentCostRevisions(tx, 1, actorId, NOW));
    expect(fresh.revisions[0].contract).toMatchObject({ evidence: "confirmed", issue: null });
  });
  it("ignores subsequent catalog unit edits when applying invoices and freight", async () => {
    const ids = await receive(); await seedConsumedCost();
    await pool.query("UPDATE catalog.product_variants SET units_per_variant=100 WHERE id=200");
    await approveEvidence(); await shipment.finalizeAllocations(1, actorId); await shipment.pushLandedCostsToLots(1);
    expect((await storage.getReceivingLineById(ids.lineId)).unitsPerVariantSnapshot).toBe(50);
    expect(await lot()).toMatchObject({ product: "600000", packaging: "50000", freight: "250000", total: "900000" });
  });

  it("replaying an already applied revision creates no duplicate applications or COGS delta", async () => {
    await receive(); await approveEvidence(); await shipment.finalizeAllocations(1, actorId); await shipment.pushLandedCostsToLots(1);
    const before = (await pool.query("SELECT COUNT(*)::int AS n FROM inventory.cost_applications")).rows[0].n;
    const result = await shipment.pushLandedCostsToLots(1);
    expect(result.updated).toBe(0);
    expect(result.costApplications.every((application: any) => application.replayed)).toBe(true);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM inventory.cost_applications")).rows[0].n).toBe(before);
  });

  it("unknown historical invoice components preserve quote balances and produce review evidence", async () => {
    await receive();
    await pool.query("UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=NULL WHERE id=72");
    await approveEvidence();
    expect(await lot()).toMatchObject({ product: "500000", packaging: "50000", total: "550000" });
    expect((await pool.query("SELECT status FROM inventory.cost_applications ORDER BY id DESC LIMIT 1")).rows).toEqual([{ status: "review_required" }]);
  });

  it("source and application history reject direct mutation", async () => {
    await receive();
    await expect(pool.query("DELETE FROM procurement.cost_source_revisions")).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE inventory.lot_cost_origins SET units_per_variant_snapshot=100")).rejects.toThrow(/immutable/);
  });

  it("commits physical receipt and a durable pending cost request when AP audit fails, then retries without receiving twice", async () => {
    const ids = await prepareReceipt();
    await failAudit(async () => {
      const result = await receiving.close(ids.receiptId, actorId);
      expect(result.costReconciliation.state).toBe("retry_required");
    });
    expect((await storage.getReceivingOrderById(ids.receiptId)).status).toBe("closed");
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_lots")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.cost_applications")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT state FROM procurement.receipt_cost_attempts")).rows).toEqual([{ state: "retry_required" }]);
    const retry = await receiving.close(ids.receiptId, actorId);
    expect(retry.costReconciliation.state).toBe("applied");
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_lots")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.receipt_cost_requests")).rows[0].count).toBe(1);
    const applicationCount = (await pool.query("SELECT count(*)::int AS count FROM inventory.cost_applications")).rows[0].count;
    await receiving.retryCosts(ids.receiptId, actorId);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.cost_applications")).rows[0].count).toBe(applicationCount);
  });

  it("uses final received quantity for an explicitly short closed purchase line", async () => {
    await receive();
    await pool.query("UPDATE procurement.purchase_order_lines SET status='closed',received_qty=100 WHERE id=21");
    await pool.query(`UPDATE procurement.vendor_invoice_lines SET qty_invoiced=100,line_total_cents=13000,
      cost_component_evidence='{"contractVersion":1,"packagingTreatment":"separate","productMills":1200000,"packagingMills":100000,"adjustmentMills":0,"source":"operator_review"}' WHERE id=72`);
    const result = await approveEvidence();
    expect(result.costApplications.every((application: any) => application.status === "applied")).toBe(true);
    expect(await lot()).toMatchObject({ product: "600000", packaging: "50000", total: "650000" });
  });

  it("protects a manual product correction while allowing independent freight to apply", async () => {
    await receive(); await approveEvidence();
    await cogs.setLotProductCostMills(Number((await lot()).id), 700000, "Audited manual product correction");
    await shipment.finalizeAllocations(1, actorId); await shipment.pushLandedCostsToLots(1);
    const result = await approveEvidence();
    expect(result.costApplications[0]).toMatchObject({ status: "review_required", issues: expect.arrayContaining([expect.objectContaining({ code: "COST_MANUAL_OVERRIDE_REVIEW" })]) });
    expect(await lot()).toMatchObject({ product: "700000", packaging: "50000", freight: "250000", total: "1000000" });
  });

  it("conserves a 7-mill input across three one-unit converted output intervals and sold COGS", async () => {
    await receive();
    const root = await lot();
    const { recordCostRevision } = await import("../../cost-source-revision.repository");
    const { recordLotCostContribution } = await import("../../../inventory/infrastructure/cost-evidence.repository");
    const { applyCostRevision } = await import("../../../inventory/application/apply-cost-revision");
    await pool.query(`INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
      unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_source,received_at)
      VALUES(1001,'SPLIT-A',201,99,1,1,1,1,0,0,1,'transformation','2026-09-06'),(1002,'SPLIT-B',201,99,1,1,1,1,0,0,1,'transformation','2026-09-06'),(1003,'SPLIT-C',201,99,1,1,1,1,0,0,1,'transformation','2026-09-06')`);
    await pool.query(`INSERT INTO oms.order_item_costs(order_id,order_item_id,inventory_lot_id,product_variant_id,qty,unit_cost_cents,total_cost_cents,unit_cost_mills,total_cost_mills)
      VALUES(1,1,1003,201,1,0,0,1,1)`);
    await database.transaction(async (tx) => {
      for (let index=0;index<3;index++) await recordLotCostContribution(tx, { sourceLotId: Number(root.id),outputLotId: 1001+index,sourceQty: 1,
        outputQty: 3,outputStartQty: index,operationKind: "conversion",operationKey: "synthetic-three-layer-build" }, actorId, NOW);
      const revision = await recordCostRevision(tx, { contractVersion: 1,component: "product",scope:{ kind:"purchase_order_line",purchaseOrderId:10,purchaseOrderLineId:21 },
        sources:[{ kind:"purchase_order_line",documentId:10,lineId:21,version:"a".repeat(64) }],currency:"USD",totalMills:28,basePieces:200,
        evidence:"confirmed",packagingTreatment:"separate",issue:null,manualOverride:null }, actorId,NOW);
      expect((await applyCostRevision(tx,revision,cogs,actorId,NOW)).status).toBe("applied");
    });
    expect((await pool.query("SELECT po_unit_cost_mills::text AS cost FROM inventory.inventory_lots WHERE id>=1001 ORDER BY id")).rows).toEqual([{cost:"2"},{cost:"2"},{cost:"3"}]);
    expect((await pool.query("SELECT total_cost_mills::text AS cost FROM oms.order_item_costs")).rows).toEqual([{cost:"3"}]);
  });

  it("applies a later invoice through real transfer lineage into sold destination COGS", async () => {
    await receive();
    await pool.query("INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(100,1,'AUDIT-PICK')");
    await inventory.transfer({productVariantId:200,fromLocationId:99,toLocationId:100,qty:1,userId:actorId});
    await pool.query(`INSERT INTO oms.order_item_costs(order_id,order_item_id,inventory_lot_id,product_variant_id,qty,unit_cost_cents,total_cost_cents,unit_cost_mills,total_cost_mills)
      SELECT 1,1,id,product_variant_id,1,total_unit_cost_cents,total_unit_cost_cents,total_unit_cost_mills,total_unit_cost_mills FROM inventory.inventory_lots WHERE warehouse_location_id=100`);
    await approveEvidence(); await shipment.finalizeAllocations(1,actorId); await shipment.pushLandedCostsToLots(1);
    expect((await pool.query("SELECT total_unit_cost_mills::text AS total FROM inventory.inventory_lots ORDER BY id")).rows).toEqual([{total:"900000"},{total:"900000"}]);
    expect((await pool.query("SELECT total_cost_mills::text AS cost FROM oms.order_item_costs")).rows).toEqual([{cost:"900000"}]);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.lot_cost_origins")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.lot_cost_contributions")).rows[0].count).toBe(1);
  });

  it.each(["invoice-first", "transfer-first"] as const)("serializes actual AP and transfer owners for %s without stale descendants", async (order) => {
    await receive();
    await pool.query("INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(100,1,'AUDIT-PICK')");
    const [{ InventoryUseCases }, { createInventoryMethods }, { InventoryLotService }] = await Promise.all([
      import("../../../inventory/application/inventory.use-cases"),
      import("../../../inventory/infrastructure/inventory.repository"), import("../../../inventory/lots.service"),
    ]);
    let signalHeld!: () => void, releaseHeld!: () => void, signalWaitingPid!: (pid: number) => void;
    const held = new Promise<void>((resolveHeld) => { signalHeld = resolveHeld; });
    const release = new Promise<void>((resolveRelease) => { releaseHeld = resolveRelease; });
    const waitingPid = new Promise<number>((resolvePid) => { signalWaitingPid = resolvePid; });
    const observedDatabase = (hold: boolean) => ({ transaction: (work: (tx: any) => Promise<any>) => database.transaction(async (tx) => {
      if (!hold) signalWaitingPid(Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid));
      const result = await work(tx);
      if (hold) { signalHeld(); await release; }
      return result;
    }) });
    const runTransfer = (hold: boolean) => new InventoryUseCases(observedDatabase(hold) as any,
      createInventoryMethods(database), new InventoryLotService(database), cogs).transfer({
        productVariantId: 200, fromLocationId: 99, toLocationId: 100, qty: 1, userId: actorId,
      });
    const runInvoice = (hold: boolean) => observedDatabase(hold).transaction((tx) => approveEvidence(tx));
    const capture = (work: Promise<unknown>) => work.then((value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }));
    const first = capture(order === "invoice-first" ? runInvoice(true) : runTransfer(true));
    let second: ReturnType<typeof capture> | undefined;
    try {
      await Promise.race([held, first.then((result) => { throw new Error(`Owner failed before held transaction: ${JSON.stringify(result)}`); })]);
      second = capture(order === "invoice-first" ? runTransfer(false) : runInvoice(false));
      const pid = await waitingPid;
      let blocked = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        blocked = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS blocked", [pid])).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      expect(blocked).toBe(true);
      releaseHeld();
      expect(await first).toMatchObject({ ok: true });
      expect(await second).toMatchObject({ ok: true });
    } finally {
      releaseHeld();
      await Promise.all([first, ...(second ? [second] : [])]);
    }
    await shipment.finalizeAllocations(1, actorId); await shipment.pushLandedCostsToLots(1);
    expect((await pool.query("SELECT total_unit_cost_mills::text AS total FROM inventory.inventory_lots ORDER BY id")).rows).toEqual([{ total: "900000" }, { total: "900000" }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.lot_cost_contributions")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT sum(variant_qty)::int AS qty FROM inventory.inventory_levels")).rows[0].qty).toBe(2);
  });

  it("preserves unrepresentable uniform-lot residuals as review without partial changes", async () => {
    await receive();
    await pool.query(`UPDATE procurement.vendor_invoice_lines SET line_total_cents=26001,
      cost_component_evidence='{"contractVersion":1,"packagingTreatment":"separate","productMills":2400100,"packagingMills":200000,"adjustmentMills":0,"source":"operator_review"}' WHERE id=72`);
    const result = await approveEvidence();
    expect(result.costApplications[0].status).toBe("applied");
    // 100 mills across 200 base pieces allocates 50 to the 2-case receipt;
    // each case can represent 25 mills exactly. A sub-mill source is reviewed below.
    const { recordCostRevision } = await import("../../cost-source-revision.repository");
    const { applyCostRevision } = await import("../../../inventory/application/apply-cost-revision");
    const beforeReview = await lot();
    await database.transaction(async (tx) => {
      const revision = await recordCostRevision(tx, {contractVersion:1,component:"product",scope:{kind:"purchase_order_line",purchaseOrderId:10,purchaseOrderLineId:21},
        sources:[{kind:"purchase_order_line",documentId:10,lineId:21,version:"b".repeat(64)}],currency:"USD",totalMills:6,basePieces:200,evidence:"confirmed",packagingTreatment:"separate",issue:null,manualOverride:null}, actorId,NOW);
      const application = await applyCostRevision(tx,revision,cogs,actorId,NOW);
      expect(application).toMatchObject({status:"review_required",lotsUpdated:0});
      expect(application.issues.some(issue=>issue.code==="COST_UNIFORM_LOT_RESIDUAL_REVIEW")).toBe(true);
    });
    expect(await lot()).toEqual(beforeReview);
  });

  it("real AP audit failure rolls back invoice evidence, lot layers, consumed COGS and adjustment log", async () => {
    await receive(); await seedConsumedCost(); const before = await state();
    await failAudit(async () => { await expect(approveEvidence()).rejects.toThrow(/cost audit injected AP audit failure/); });
    expect(await state()).toEqual(before);
  });
});
