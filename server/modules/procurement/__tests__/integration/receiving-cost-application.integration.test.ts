import { randomUUID } from "node:crypto";
import { createReceiptCostRecoveryRepository } from "../../receipt-cost-recovery.repository";
import { runReceiptCostRecoveryBatch } from "../../receipt-cost-recovery.worker";
import { receiptCostRecoveryOutcome, recoveryRetryOutcome } from "../../receipt-cost-recovery.domain";
import { processReceiptCostRequests, type ReceiptCostQueueResult } from "../../receipt-cost-queue.service";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { lockInventoryCostGraph } from "../../../inventory/infrastructure/cost-evidence.repository";
import { isShipmentCostLinePosted } from "@shared/procurement/shipment-cost-workflow";
import { projectPoLineLandedCosts } from "@shared/procurement/po-line-landed-cost";
import { readPoShipmentCostSummary, readPoShipmentCosts } from "../../po-shipment-cost-summary.repository";
import { installPreOpeningQuantityAuthorityFixture } from "../../../inventory/__tests__/fixtures/pre-opening-quantity-authority.fixture";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";
import { resetFixtureWithEmptyReceivingCustody } from "./receiving-custody-fixture";
import { createShipmentCostExceptionService, shipmentExceptionScope } from "../../shipment-cost-exception.service";
import { costFingerprint } from "../../../inventory/infrastructure/cost-evidence-values";
import type { ShipmentExceptionRequest } from "@shared/procurement/shipment-cost-exception";
import { registerShipmentReconciliationCases } from "./shipment-cost-reconciliation.cases";
import { registerOriginRepairCases } from "./cost-origin-repair.cases";
import { registerSupplierCreditCostCases } from "./supplier-credit-cost.cases";
import { installSupplierReturnCompletionFixture, withSupplierReturnFixtureReset } from "./supplier-return-fixture";
import { registerSupplierReturnStockCases } from "./supplier-return-stock.cases";
import { registerSupplierReturnCommandCases } from "./supplier-return-command.cases";
import { registerSupplierReturnCreditCases } from "./supplier-return-credit.cases";
import { registerQuantityCorrectionCases } from "./receipt-shipment-quantity-correction.cases";
import { registerPoAmendmentDependencyCases } from "./po-amendment-dependencies.cases";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import { readReceiptCostQueue } from "../../receipt-cost-queue-read.repository";
import { projectReceiptCostQueue } from "../../receipt-cost-queue-read.service";

// Real PostgreSQL regression coverage for the coordinated receipt/AP/freight owners.
config({ path: resolve(process.cwd(), ".env.test") });
const url = process.env.ECHELON_TEST_DATABASE_URL;
const enabled = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" && !!url;
const audit = enabled ? describe : describe.skip;
const NOW = new Date("2026-09-06T12:00:00.000Z");
const TABLES = [
  schema.users, schema.authRoles, schema.authPermissions, schema.authUserRoles, schema.authRolePermissions,
  schema.products, schema.productVariants, schema.vendors, schema.purchaseOrders,
  schema.purchaseOrderLines, schema.inboundShipments, schema.inboundShipmentLines,
  schema.poApprovalTiers, schema.poRevisions, schema.purchasingRecommendationPoHandoffs, schema.warehouseSettings,
  schema.receivingOrders, schema.receivingLines, schema.poReceipts, schema.receiptReversals,
  schema.vendorInvoices, schema.supplierCredits, schema.supplierCreditLines,
  schema.supplierCreditApplications, schema.supplierCreditApplicationReversals, schema.vendorInvoiceLines,
  schema.vendorInvoicePoLinks, schema.poStatusHistory, schema.poEvents, schema.poExceptions,
  schema.inboundFreightCosts, schema.inboundFreightAllocations,
  schema.landedCostSnapshots, schema.landedCostAdjustments, schema.inboundShipmentStatusHistory,
  schema.warehouses, schema.warehouseLocations, schema.productLocations, schema.inventoryLevels,
  schema.inventoryLots, schema.inventoryTransactions, schema.orders, schema.orderItems, schema.orderItemCosts, schema.orderLineCosts,
  schema.cycleCounts, schema.cycleCountItems,
  schema.outboundShipments, schema.outboundShipmentItems,
];

audit.sequential("receipt/AP/freight cost revisions with real owners", () => {
  const actorId = `cost-audit-${randomUUID()}`;
  const ownedSchemas: string[] = [];
  let ownsAudit = false;
  let ownsCommands = false;
  let pool: pg.Pool;
  let lease: pg.PoolClient | undefined;
  let defaultModulePool: pg.Pool | undefined;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let storage: any;
  let receiving: import("../../receiving.service").ReceivingService;
  let purchasing: ReturnType<typeof import("../../purchasing.service").createPurchasingService>;
  let shipment: ReturnType<typeof import("../../shipment-tracking.service").createShipmentTrackingService>;
  let createShipment: typeof import("../../shipment-tracking.service").createShipmentTrackingService;
  let costUpdateCommands: ReturnType<typeof import("../../shipment-cost-update.commands").createShipmentCostUpdateCommands>;
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
    for (const name of ["identity", "catalog", "procurement", "warehouse", "inventory", "wms", "oms"]) {
      await pool.query(`CREATE SCHEMA ${name}`);
      ownedSchemas.push(name);
    }
    for (const table of TABLES) await pool.query(fixtureTable(table));
    await pool.query("CREATE UNIQUE INDEX purchase_order_lines_po_id_line_id_uidx ON procurement.purchase_order_lines(purchase_order_id,id)");
    for (const statement of fixtureForeignKeys(TABLES)) await pool.query(statement);
    await installPreOpeningQuantityAuthorityFixture(pool);
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
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/226_purchase_supplier_progress.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/900000017000018590001_receipt_shipment_quantity_amendments.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/900000007000018030001_shipment_cost_exception_decisions.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/0751_exact_inventory_cost_totals.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/900000008000018110001_shipment_cost_reconciliation.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/900000009000018290001_historical_cost_origin_repairs.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/0725_inventory_cost_admission_evidence.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/231_receipt_cost_recovery.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/900000004000017890001_receiving_quarantine.sql"), "utf8"));
    await installSupplierReturnCompletionFixture(pool);
    // The log is runtime DDL in server/db.ts:997, with money types aligned by migration0576.
    if (!(await pool.query("SELECT to_regclass('public.audit_events') AS relation")).rows[0].relation) {
      await pool.query(fixtureTable(schema.auditEvents)); ownsAudit = true;
    }
    if ((await pool.query("SELECT to_regclass('public.financial_command_results') AS relation")).rows[0].relation) {
      throw new Error("Cost workflow fixture requires its own financial command table");
    }
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/136_financial_command_results.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/140_financial_command_operations.sql"), "utf8"));
    ownsCommands = true;
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
      // The legacy inventory port permits caller-selected generic rows; this fixture
      // supplies the real Drizzle executor and never substitutes query results.
      const inventoryDatabase = database as unknown as ConstructorParameters<typeof inventoryModule.InventoryUseCases>[0];
      inventory = new inventoryModule.InventoryUseCases(inventoryDatabase,
        repositoryModule.createInventoryMethods(database), new lotModule.InventoryLotService(database), cogs);
      purchasing = purchasingModule.createPurchasingService(database, storage, {
        reconcileApprovedInvoiceCost: (id, tx, actor) => reconcile(id, tx, actor),
      });
      createShipment = shipmentModule.createShipmentTrackingService;
      shipment = createShipment(database, storage, cogs, () => NOW);
      const [{ createShipmentCostUpdateCommands }, { createDrizzleFinancialCommandRepository }] = await Promise.all([
        import("../../shipment-cost-update.commands"), import("../../../../platform/commands/command-results.repository"),
      ]);
      costUpdateCommands = createShipmentCostUpdateCommands(shipment, createDrizzleFinancialCommandRepository(database), () => NOW);
      receiving = new receivingModule.ReceivingService(database, inventory,
        { queueSyncAfterInventoryChange: async () => undefined }, storage, purchasing, shipment, null,
        { reconcilePurchaseOrderLine: (id, tx, actor) => reconcile(id, tx, actor) }, null, null, () => NOW);
    } finally {
      if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
      if (priorExternal === undefined) delete process.env.EXTERNAL_DATABASE_URL; else process.env.EXTERNAL_DATABASE_URL = priorExternal;
    }
  });

  beforeEach(async () => {
    if (ownedSchemas.length !== 7) throw new Error("Fixture schema ownership missing");
    await pool.query(`ALTER TABLE inventory.lot_cost_origin_amendments DISABLE TRIGGER quantity_amendment_no_truncate;
      ALTER TABLE procurement.receipt_shipment_quantity_amendments DISABLE TRIGGER quantity_amendment_no_truncate;
      ALTER TABLE procurement.receipt_shipment_quantity_results DISABLE TRIGGER quantity_amendment_no_truncate`);
    // These schemas are exclusively owned by this disposable local fixture.
    // Restore production immutability guards before any owner code executes.
    await pool.query(`ALTER TABLE inventory.cost_reconciliation_approvals DISABLE TRIGGER cost_reconciliation_approval_no_truncate;
      ALTER TABLE inventory.cost_reconciliation_postings DISABLE TRIGGER cost_reconciliation_posting_no_truncate;
      ALTER TABLE inventory.cost_origin_repairs DISABLE TRIGGER cost_origin_repair_no_truncate`);
    try { await withSupplierReturnFixtureReset(pool, () => resetFixtureWithEmptyReceivingCustody(pool,
      `TRUNCATE ${TABLES.map(qualifiedTable).join(",")},inventory.cost_adjustment_log RESTART IDENTITY CASCADE`)); }
    finally { await pool.query(`ALTER TABLE inventory.cost_reconciliation_approvals ENABLE TRIGGER cost_reconciliation_approval_no_truncate;
      ALTER TABLE inventory.cost_reconciliation_postings ENABLE TRIGGER cost_reconciliation_posting_no_truncate;
      ALTER TABLE inventory.cost_origin_repairs ENABLE TRIGGER cost_origin_repair_no_truncate`); }
    await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
    await pool.query(`ALTER TABLE inventory.lot_cost_origin_amendments ENABLE TRIGGER quantity_amendment_no_truncate;
      ALTER TABLE procurement.receipt_shipment_quantity_amendments ENABLE TRIGGER quantity_amendment_no_truncate;
      ALTER TABLE procurement.receipt_shipment_quantity_results ENABLE TRIGGER quantity_amendment_no_truncate`);
    await pool.query("TRUNCATE public.financial_command_results RESTART IDENTITY CASCADE");
    await pool.query("INSERT INTO identity.users(id,username,password,role,active) VALUES($1,'cost-audit-owner','unused','admin',1)", [actorId]);
    await pool.query(`
      INSERT INTO identity.users(id,username,password,role,active) VALUES
        ('admin-user','admin','unused','picker',1),('lead-user','lead','unused','admin',1),
        ('custom-user','custom','unused','admin',1),('scoped-user','scoped','unused','admin',1);
      INSERT INTO identity.auth_roles(id,name,is_system) VALUES(1,'Administrator',1),(2,'Team Lead',1),(3,'Administrator',0),(4,'Administrator',1);
      INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(1,'purchasing','approve','purchasing'),(2,'purchasing','view','purchasing');
      INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES('admin-user',1),('lead-user',2),('custom-user',3),('scoped-user',4);
      INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES(1,1,NULL),(2,1,NULL),(3,1,NULL),(4,1,'{"warehouseId":1}');
      INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES(1,2,NULL);
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
    await pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,1)", [actorId]);
  });

  afterAll(async () => {
    try {
      if (pool) {
        if (ownsCommands) await pool.query("DROP TABLE public.financial_command_recoveries, public.financial_command_results; DROP FUNCTION public.guard_financial_command_result_update()");
        if (ownsAudit) await pool.query("DROP TABLE public.audit_events");
        else if ((await pool.query("SELECT to_regclass('public.audit_events') AS relation")).rows[0].relation) await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
        for (const name of [...ownedSchemas].reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`);
      }
    } finally {
      if (lease) { await lease.query("SELECT pg_advisory_unlock(hashtext('echelon.procurement.cost-application-fixture'))"); lease.release(); }
      await pool?.end(); await defaultModulePool?.end();
    }
  });

  it.each(["po", "shipment"] as const)("defaults %s receipt locations only from active primary slots in the destination warehouse", async (source) => {
    await pool.query(`INSERT INTO warehouse.warehouses(id,code,name) VALUES(2,'OTHER-WH','Other warehouse');
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,is_active) VALUES(100,2,'OTHER-DOCK',1),(101,1,'INACTIVE',0);
      INSERT INTO warehouse.product_locations(product_variant_id,warehouse_location_id,name,location,zone,is_primary,status)
        VALUES(200,100,'Wrong warehouse','OTHER-DOCK','OTHER',1,'active'),
          (200,101,'Inactive location','INACTIVE','INACTIVE',1,'active'),
          (200,99,'Correct warehouse','AUDIT-DOCK','DOCK',1,'active')`);
    const receipt = source === "po" ? await purchasing.createReceiptFromPO(10, actorId)
      : await purchasing.createReceiptFromShipment(1, actorId, { purchaseOrderId: 10 });
    expect((await storage.getReceivingLines(receipt.id)).map((line: { putawayLocationId: number | null }) => line.putawayLocationId)).toEqual([99]);
  });

  it.each(["po", "shipment"] as const)("leaves %s receipt unassigned when the only primary slot belongs to another warehouse", async (source) => {
    await pool.query(`INSERT INTO warehouse.warehouses(id,code,name) VALUES(2,'OTHER-WH','Other warehouse');
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(100,2,'OTHER-DOCK');
      INSERT INTO warehouse.product_locations(product_variant_id,warehouse_location_id,name,location,zone,is_primary,status)
        VALUES(200,100,'Wrong warehouse','OTHER-DOCK','OTHER',1,'active')`);
    const receipt = source === "po" ? await purchasing.createReceiptFromPO(10, actorId)
      : await purchasing.createReceiptFromShipment(1, actorId, { purchaseOrderId: 10 });
    expect((await storage.getReceivingLines(receipt.id)).map((line: { putawayLocationId: number | null }) => line.putawayLocationId)).toEqual([null]);
  });

  async function prepareReceipt(quantity = 2) {
    const receipt = await purchasing.createReceiptFromShipment(1, actorId, { purchaseOrderId: 10 });
    const [line] = await storage.getReceivingLines(receipt.id);
    expect(line).toMatchObject({ unitsPerVariantSnapshot: 50, expectedQty: quantity, inboundShipmentLineId: 11, purchaseOrderLineId: 21 });
    await receiving.open(receipt.id, actorId);
    await receiving.updateLine(line.id, { receivedQty: quantity, putawayLocationId: 99, expectedUnitVersion: receivingUnitVersion(line) }, actorId);
    return { receiptId: receipt.id as number, lineId: line.id as number };
  }
  async function receive(quantity = 2) {
    const ids = await prepareReceipt(quantity);
    await receiving.close(ids.receiptId, actorId);
    const lineage = (await pool.query(`SELECT t.receiving_line_id,rl.units_per_variant_snapshot,rl.inbound_shipment_line_id,
      pr.qty_received AS received_qty,l.qty_received FROM inventory.inventory_transactions t
      JOIN inventory.inventory_lots l ON l.id=t.inventory_lot_id
      JOIN procurement.receiving_lines rl ON rl.id=t.receiving_line_id
      JOIN procurement.po_receipts pr ON pr.receiving_line_id=rl.id
      WHERE t.transaction_type='receipt' AND t.voided_at IS NULL`)).rows;
    expect(lineage).toEqual([{ receiving_line_id: ids.lineId, units_per_variant_snapshot: 50, inbound_shipment_line_id: 11, received_qty: quantity * 50, qty_received: quantity }]);
    return ids;
  }
  async function lot() {
    return (await pool.query(`SELECT id,po_unit_cost_mills::text AS product,packaging_cost_mills::text AS packaging,
      landed_cost_mills::text AS freight,total_unit_cost_mills::text AS total,cost_provisional,cost_source
      FROM inventory.inventory_lots ORDER BY id`)).rows[0];
  }
  async function seedConsumedCost() {
    const { InventoryLotService }=await import("../../../inventory/lots.service");
    const source=(await pool.query("SELECT product_variant_id,warehouse_location_id FROM inventory.inventory_lots ORDER BY id LIMIT 1")).rows[0];
    await database.transaction(tx=>new InventoryLotService(tx,()=>NOW).pickFromLots({
      productVariantId:Number(source.product_variant_id),warehouseLocationId:Number(source.warehouse_location_id),qty:1,orderId:1,orderItemId:1,
    }));
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
    const relations = [...TABLES.map(qualifiedTable), "inventory.cost_adjustment_log",
      "inventory.lot_cost_quantity_allocations"];
    const values = [];
    for (const relation of relations) values.push((await pool.query(`SELECT * FROM ${relation} ORDER BY id`)).rows);
    values.push((await pool.query("SELECT * FROM inventory.lot_cost_quantity_bases ORDER BY inventory_lot_id")).rows);
    values.push((await pool.query("SELECT * FROM inventory.lot_cost_contribution_allocations ORDER BY contribution_id")).rows);
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

  it("uses current supplier applications across shipment and receipt status while preserving earlier review attempts", async () => {
    await pool.query("UPDATE procurement.vendor_invoices SET status='approved' WHERE id=71");
    const original = (await pool.query("SELECT cost_component_evidence FROM procurement.vendor_invoice_lines WHERE id=72")).rows[0].cost_component_evidence;
    await pool.query("UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=NULL WHERE id=72");
    const receipt = await receive();
    await shipment.finalizeAllocations(1, actorId);
    await shipment.pushLandedCostsToLots(1, actorId);
    await pool.query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1");
    const before = await shipment.getCostReview(1);
    expect(isShipmentCostLinePosted(before!.lines[0])).toBe(true);
    expect(before!.supplierCosts!.lines[0].components.every(component => component.status === 'review_required')).toBe(true);
    expect((await readPoShipmentCosts(database, 10))?.supplierCosts).toEqual(before!.supplierCosts);
    expect((await shipment.getLandedCostHealth()).items).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'provisional_other_costs', detail: expect.stringContaining('Confirm the supplier invoice amounts'),
    })]));
    const attempts = (await pool.query("SELECT * FROM procurement.receipt_cost_attempts ORDER BY id")).rows;
    await pool.query("UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=$1 WHERE id=72", [original]);
    await approveEvidence();
    const current = await database.transaction(tx => readPurchaseCostStatus(tx, [21]), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(current.lines[0].components).toEqual(expect.arrayContaining([
      expect.objectContaining({component:'product',status:'applied',sourceEvidence:'confirmed'}),
      expect.objectContaining({component:'packaging',status:'applied',sourceEvidence:'confirmed'}),
    ]));
    const queue = await database.transaction(tx => readReceiptCostQueue(tx,10));
    expect(projectReceiptCostQueue(queue,new Map(),current)[0]).toMatchObject({ state:'applied',recordedState:'review_required' });
    expect((await pool.query("SELECT * FROM procurement.receipt_cost_attempts ORDER BY id")).rows).toEqual(attempts);
    expect((await shipment.getCostReview(1))!.supplierCosts).toEqual(current);
    expect((await readPoShipmentCosts(database, 10))?.supplierCosts).toEqual(current);
    expect((await shipment.getLandedCostHealth()).items).toEqual([]);
    // Explicit retry traverses the current owner; an unchanged replay must not
    // append another application or financial adjustment.
    const applicationCount = (await pool.query("SELECT count(*)::int AS n FROM inventory.cost_applications")).rows[0].n;
    await receiving.retryCosts(receipt.receiptId, actorId);
    await receiving.retryCosts(receipt.receiptId, actorId);
    expect((await pool.query("SELECT count(*)::int AS n FROM inventory.cost_applications")).rows[0].n).toBe(applicationCount);

    // The request now has a successful attempt. A subsequent invoice change
    // must still reach the financial owner instead of replaying that old state.
    await pool.query("UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=NULL WHERE id=72");
    expect(await receiving.retryCosts(receipt.receiptId, actorId)).toMatchObject({ state: 'review_required' });
    const changed = await database.transaction(tx => readPurchaseCostStatus(tx, [21]), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(changed.lines[0].components.every(component => component.status === 'review_required')).toBe(true);
    await pool.query("UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=$1 WHERE id=72", [original]);
    expect(await receiving.retryCosts(receipt.receiptId, actorId)).toMatchObject({ state: 'applied' });
    const restored = await database.transaction(tx => readPurchaseCostStatus(tx, [21]), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(restored.lines[0].components.every(component => component.status === 'applied')).toBe(true);
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

  async function failedRecoveryReceipt() {
    const ids = await prepareReceipt();
    await failAudit(async () => {
      expect((await receiving.close(ids.receiptId, actorId)).costReconciliation.state).toBe("retry_required");
    });
    return ids;
  }
  const recoveryTime = () => new Date(NOW.getTime() + 180_000);
  function recoveryRepository() { return createReceiptCostRecoveryRepository(pool); }
  async function prepareRecovery() {
    const repository = recoveryRepository();
    await repository.prepare({ now: recoveryTime(), maxAttempts: 5, graceMs: 120_000, limit: 10 });
    return repository;
  }

  it("automatically recovers the actual rolled-back AP owner without receiving stock twice", async () => {
    await failedRecoveryReceipt();
    const dependencies = { repository: recoveryRepository(), receiving, clock: recoveryTime, leaseToken: randomUUID, logger: console };
    expect(await runReceiptCostRecoveryBatch(dependencies)).toMatchObject({ claimed: 1, applied: 1 });
    expect((await pool.query("SELECT state,attempt_count FROM procurement.receipt_cost_recovery_jobs")).rows).toEqual([{ state: "applied", attempt_count: 1 }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_lots")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT state FROM procurement.receipt_cost_attempts ORDER BY id")).rows).toEqual([{ state: "retry_required" }, { state: "applied" }]);
    const applicationCount = (await pool.query("SELECT count(*)::int AS count FROM inventory.cost_applications")).rows[0].count;
    expect(applicationCount).toBeGreaterThan(0);
    expect(await runReceiptCostRecoveryBatch(dependencies)).toMatchObject({ claimed: 0 });
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.cost_applications")).rows[0].count).toBe(applicationCount);
    expect((await pool.query("SELECT event_type FROM procurement.receipt_cost_recovery_events ORDER BY id")).rows).toEqual([{ event_type: "claimed" }, { event_type: "completed" }]);
    await expect(pool.query("DELETE FROM procurement.receipt_cost_recovery_events")).rejects.toThrow(/immutable/);
  });

  it("serializes manual and automatic cost recovery through the real financial owner", async () => {
    const ids = await failedRecoveryReceipt();
    const repository = await prepareRecovery();
    const claim = (await repository.claimNext({ now: recoveryTime(), leaseMs: 300_000, leaseToken: randomUUID() }))!;
    await Promise.all([receiving.retryCosts(ids.receiptId, actorId), receiving.retryCostsAutomatically(ids.receiptId, claim.requestId)]);
    expect((await pool.query("SELECT state FROM procurement.receipt_cost_attempts ORDER BY id")).rows).toEqual([{ state: "retry_required" }, { state: "applied" }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_lots")).rows[0].count).toBe(1);
    // Recovery metadata follows the durable financial outcome even if this
    // worker captured an earlier transient result.
    await repository.complete(claim, recoveryRetryOutcome(claim, "TRANSIENT", recoveryTime()), recoveryTime());
    expect((await pool.query("SELECT state FROM procurement.receipt_cost_recovery_jobs")).rows[0].state).toBe("applied");
  });

  it.each(["applied", "review_required"] as const)("preserves concurrent manual %s evidence after an automatic financial rollback", async (terminalState) => {
    const ids = await failedRecoveryReceipt();
    const repository = await prepareRecovery();
    const claim = (await repository.claimNext({ now: recoveryTime(), leaseMs: 300_000, leaseToken: randomUUID() }))!;
    let signalRollback!: (error: unknown) => void;
    let releaseAutomatic!: () => void;
    const rolledBack = new Promise<unknown>((resolveRollback) => { signalRollback = resolveRollback; });
    const resumeAutomatic = new Promise<void>((resolveResume) => { releaseAutomatic = resolveResume; });
    let holdFirstRollback = true;
    type FinancialTransaction = Parameters<Parameters<typeof database.transaction>[0]>[0];
    const observedDatabase = {
      execute: database.execute.bind(database),
      transaction: async <T>(work: (tx: FinancialTransaction) => Promise<T>): Promise<T> => {
        try { return await database.transaction(work); }
        catch (error) {
          if (holdFirstRollback) {
            holdFirstRollback = false;
            // The real AP audit failed and PostgreSQL released its graph lock.
            // Hold only the caller so a manual transaction can commit before
            // automatic recovery begins its separate failure-log transaction.
            signalRollback(error);
            await resumeAutomatic;
          }
          throw error;
        }
      },
    };
    let automatic: Promise<ReceiptCostQueueResult> | undefined;
    try {
      await failAudit(async () => {
        automatic = processReceiptCostRequests(observedDatabase, ids.receiptId,
          { reconcilePurchaseOrderLine: (id, tx, actor) => reconcile(id, tx, actor) },
          "system:receipt-cost-recovery", recoveryTime, claim.requestId);
        const failure = await Promise.race([rolledBack, automatic.then(() => { throw new Error("Expected the injected AP audit rollback"); })]);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/cost audit injected AP audit failure/);
      });
      expect((await pool.query("SELECT count(*)::int AS count FROM inventory.cost_applications")).rows[0].count).toBe(0);
      await database.transaction(async (tx) => {
        await lockInventoryCostGraph(tx);
        await tx.execute(sql`UPDATE procurement.vendor_invoices SET status='approved' WHERE id=71`);
        if (terminalState === "review_required") await tx.execute(sql`UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=NULL WHERE id=72`);
      });
      const manual = await receiving.retryCosts(ids.receiptId, actorId);
      expect(manual.state).toBe(terminalState);
      const financialState = await state();
      const applications = (await pool.query("SELECT * FROM inventory.cost_applications ORDER BY id")).rows;
      releaseAutomatic();
      const result = await automatic!;
      expect(result).toEqual(manual);
      expect((await pool.query("SELECT state FROM procurement.receipt_cost_attempts ORDER BY id")).rows)
        .toEqual([{ state: "retry_required" }, { state: terminalState }]);
      expect(await state()).toEqual(financialState);
      expect((await pool.query("SELECT * FROM inventory.cost_applications ORDER BY id")).rows).toEqual(applications);
      expect(await repository.complete(claim, receiptCostRecoveryOutcome(claim, result, recoveryTime()), recoveryTime())).toBe(terminalState);
      expect(await runReceiptCostRecoveryBatch({ repository, receiving, clock: recoveryTime, leaseToken: randomUUID, logger: console })).toMatchObject({ claimed: 0 });
    } finally {
      releaseAutomatic();
      await automatic;
    }
  });

  it("grants a due request to only one simultaneous claimant", async () => {
    await failedRecoveryReceipt(); const repository = await prepareRecovery();
    const claims = await Promise.all(Array.from({ length: 4 }, () => repository.claimNext({ now: recoveryTime(), leaseMs: 300_000, leaseToken: randomUUID() })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await pool.query("SELECT attempt_count FROM procurement.receipt_cost_recovery_jobs")).rows[0].attempt_count).toBe(1);
  });

  it("rolls back a claim when its immutable audit event cannot commit", async () => {
    await failedRecoveryReceipt(); const repository = await prepareRecovery();
    await pool.query(`CREATE FUNCTION procurement.reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected recovery audit failure'; END $$;
      CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON procurement.receipt_cost_recovery_events
      FOR EACH ROW EXECUTE FUNCTION procurement.reject_recovery_audit()`);
    try {
      await expect(repository.claimNext({ now: recoveryTime(), leaseMs: 300_000, leaseToken: randomUUID() })).rejects.toThrow(/injected recovery audit failure/);
      expect((await pool.query("SELECT state,attempt_count,lease_token FROM procurement.receipt_cost_recovery_jobs")).rows).toEqual([{ state: "queued", attempt_count: 0, lease_token: null }]);
      expect((await pool.query("SELECT count(*)::int AS count FROM procurement.receipt_cost_recovery_events")).rows[0].count).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER reject_recovery_audit ON procurement.receipt_cost_recovery_events; DROP FUNCTION procurement.reject_recovery_audit()");
    }
  });

  it("fences an expired worker and preserves the replacement lease", async () => {
    await failedRecoveryReceipt(); const repository = await prepareRecovery();
    const first = (await repository.claimNext({ now: recoveryTime(), leaseMs: 1_000, leaseToken: randomUUID() }))!;
    const later = new Date(recoveryTime().getTime() + 2_000);
    const second = (await repository.claimNext({ now: later, leaseMs: 300_000, leaseToken: randomUUID() }))!;
    expect(second.attemptCount).toBe(2);
    expect(await repository.complete(first, recoveryRetryOutcome(first, "STALE", later), later)).toBeNull();
    expect((await pool.query("SELECT lease_token FROM procurement.receipt_cost_recovery_jobs")).rows[0].lease_token).toBe(second.leaseToken);
  });

  it("reconciles a crash after a successful financial commit without another application", async () => {
    const ids = await failedRecoveryReceipt(); const repository = await prepareRecovery();
    const claim = (await repository.claimNext({ now: recoveryTime(), leaseMs: 1_000, leaseToken: randomUUID() }))!;
    await receiving.retryCostsAutomatically(ids.receiptId, claim.requestId);
    const later = new Date(recoveryTime().getTime() + 2_000);
    await repository.prepare({ now: later, maxAttempts: 5, graceMs: 120_000, limit: 10 });
    expect((await pool.query("SELECT state FROM procurement.receipt_cost_recovery_jobs")).rows[0].state).toBe("applied");
    expect(await repository.claimNext({ now: later, leaseMs: 1_000, leaseToken: randomUUID() })).toBeNull();
  });

  it("stops after repeated abandoned leases and retains the manual recovery path", async () => {
    const ids = await failedRecoveryReceipt(); const repository = await prepareRecovery();
    for (let index = 0; index < 5; index++) {
      const claim = await repository.claimNext({ now: new Date(recoveryTime().getTime() + index * 2_000), leaseMs: 1_000, leaseToken: randomUUID() });
      expect(claim?.attemptCount).toBe(index + 1);
    }
    const later = new Date(recoveryTime().getTime() + 20_000);
    await repository.prepare({ now: later, maxAttempts: 5, graceMs: 120_000, limit: 10 });
    expect((await pool.query("SELECT state,attempt_count FROM procurement.receipt_cost_recovery_jobs")).rows).toEqual([{ state: "exhausted", attempt_count: 5 }]);
    expect(await repository.claimNext({ now: later, leaseMs: 1_000, leaseToken: randomUUID() })).toBeNull();
    expect((await receiving.retryCosts(ids.receiptId, actorId)).state).toBe("applied");
  });

  it("does not retry review-required evidence that arrives after its claim", async () => {
    const ids = await failedRecoveryReceipt(); const repository = await prepareRecovery();
    const claim = (await repository.claimNext({ now: recoveryTime(), leaseMs: 300_000, leaseToken: randomUUID() }))!;
    const summary = { requestId: claim.requestId, purchaseOrderLineId: 21, state: "review_required", issues: [{ code: "UNCLASSIFIED", message: "Quote requires review" }], attemptRecorded: true };
    await pool.query(`INSERT INTO procurement.receipt_cost_attempts(request_id,state,result,recorded_by,recorded_at)
      VALUES($1,'review_required',$2::jsonb,$3,$4)`, [claim.requestId, JSON.stringify({ summary }), actorId, recoveryTime()]);
    expect((await receiving.retryCostsAutomatically(ids.receiptId, claim.requestId)).state).toBe("review_required");
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.cost_applications")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.receipt_cost_attempts")).rows[0].count).toBe(2);
  });

  it("never schedules recent close work or terminal financial outcomes", async () => {
    await failedRecoveryReceipt(); const repository = recoveryRepository();
    await repository.prepare({ now: NOW, maxAttempts: 5, graceMs: 120_000, limit: 10 });
    expect(await repository.claimNext({ now: recoveryTime(), leaseMs: 300_000, leaseToken: randomUUID() })).toBeNull();
    const receipt = (await pool.query("SELECT receiving_order_id AS id FROM procurement.receipt_cost_requests")).rows[0];
    await receiving.retryCosts(receipt.id, actorId);
    await repository.prepare({ now: recoveryTime(), maxAttempts: 5, graceMs: 120_000, limit: 10 });
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.receipt_cost_recovery_jobs")).rows[0].count).toBe(0);
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
    await pool.query("UPDATE inventory.inventory_lots SET qty_on_hand=qty_on_hand-1 WHERE id=$1",[root.id]);
    await pool.query("UPDATE inventory.inventory_lots SET qty_on_hand=0,qty_picked=1 WHERE id=1003");
    await database.transaction(async (tx) => {
      const { allocateLotQuantityCost }=await import("../../../inventory/infrastructure/cost-quantity.repository");
      const allocated=await allocateLotQuantityCost(tx,Number(root.id),1,actorId,NOW);
      for (let index=0;index<3;index++) await recordLotCostContribution(tx, { sourceLotId: Number(root.id),outputLotId: 1001+index,sourceQty: 1,
        costQuantityAllocationId:allocated.id,outputQty: 3,outputStartQty: index,operationKind: "conversion",operationKey: "synthetic-three-layer-build" }, actorId, NOW);
      const revision = await recordCostRevision(tx, { contractVersion: 1,component: "product",scope:{ kind:"purchase_order_line",purchaseOrderId:10,purchaseOrderLineId:21 },
        sources:[{ kind:"purchase_order_line",documentId:10,lineId:21,version:"a".repeat(64) }],currency:"USD",totalMills:28,basePieces:200,
        evidence:"confirmed",packagingTreatment:"separate",issue:null,manualOverride:null }, actorId,NOW);
      expect((await applyCostRevision(tx,revision,cogs,actorId,NOW)).status).toBe("applied");
    });
    expect((await pool.query("SELECT po_unit_cost_mills::text AS cost FROM inventory.inventory_lots WHERE id>=1001 ORDER BY id")).rows).toEqual([{cost:"2"},{cost:"2"},{cost:"3"}]);
    expect((await pool.query("SELECT total_cost_mills::text AS cost FROM oms.order_item_costs")).rows).toEqual([{cost:"3"}]);
  });

  async function legacyQuantityGaps() {
    // A compact reproduction of the 220-case / four-case gap and the depleted
    // 20-box / one-box gap. All historical input/output quantities are retained.
    await pool.query(`UPDATE procurement.purchase_order_lines SET order_qty=2200000 WHERE id=21;
      UPDATE procurement.inbound_shipment_lines SET qty_shipped=2200000 WHERE id=11;
      UPDATE procurement.inbound_freight_costs SET actual_cents=335007 WHERE id=31;
      INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status) VALUES(40,'LEGACY-RECEIPT','shipment','closed');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,inbound_shipment_line_id,sku,product_variant_id,
        expected_qty,received_qty,units_per_variant_snapshot,cost_source_kind)
        VALUES(51,40,21,11,'AUDIT-PRODUCT',200,220,220,10000,'purchase_order_line');
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
        po_line_id,inbound_shipment_id,receiving_order_id,unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_precision_version,cost_source,received_at)
        VALUES(3364,'LEGACY-CASE',200,99,220,157,21,1,40,1000000,1000000,0,0,1000000,1,'po','2026-09-01'),
          (4016,'LEGACY-BOX',201,99,20,0,21,1,NULL,50000,50000,0,0,50000,1,'transformation','2026-09-02'),
          (4017,'OTHER-BOXES',201,99,380,380,21,1,NULL,50000,50000,0,0,50000,1,'transformation','2026-09-02');
      INSERT INTO oms.order_item_costs(order_id,order_item_id,inventory_lot_id,product_variant_id,qty,unit_cost_cents,total_cost_cents,
        unit_cost_mills,total_cost_mills,cost_precision_version,created_at)
        VALUES(1,1,3364,200,39,10000,390000,1000000,39000000,1,'2026-09-03'),
          (1,1,4016,201,19,500,9500,50000,950000,1,'2026-09-03');`);
    const { recordReceiptCostOrigin, recordLotCostContribution } = await import("../../../inventory/infrastructure/cost-evidence.repository");
    await database.transaction(async tx => {
      await recordReceiptCostOrigin(tx, { inventoryLotId:3364,receivingLineId:51,purchaseOrderLineId:21,inboundShipmentLineId:11,
        unitsPerVariantSnapshot:10000,receivedVariantQty:220 }, actorId,NOW);
      for (const [outputLotId, outputStartQty] of [[4016,0],[4017,20]]) await recordLotCostContribution(tx, {
        sourceLotId:3364,outputLotId,sourceQty:20,outputQty:400,outputStartQty,
        operationKind:"conversion",operationKey:"legacy-boxes" },actorId,NOW);
    });
    await shipment.finalizeAllocations(1,actorId);
  }

  async function costQuantityPhysicalSnapshot() {
    return {
      lots: (await pool.query("SELECT id,qty_received,qty_on_hand,qty_reserved,qty_picked,qty_consumed FROM inventory.inventory_lots ORDER BY id")).rows,
      cogs: (await pool.query("SELECT id,order_id,order_item_id,inventory_lot_id,qty FROM oms.order_item_costs ORDER BY id")).rows,
      transactions: (await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows,
    };
  }

  async function updateShipmentCosts(key = randomUUID()) {
    const { shipmentCostUpdateScope, SHIPMENT_COST_UPDATE_PRINCIPAL } = await import("../../shipment-cost-update.commands");
    return costUpdateCommands.execute(1, {}, actorId, {
      ...shipmentCostUpdateScope(1), actorType: "service", actorId: SHIPMENT_COST_UPDATE_PRINCIPAL,
      contractVersion: 1, idempotencyKey: key, requestHash: "b".repeat(64),
    });
  }

  it("updates a closed shipment in one audited command, preserves quantities, and replays a lost response", async () => {
    await receive(); await seedConsumedCost();
    await shipment.finalizeAllocations(1, actorId); await shipment.pushLandedCostsToLots(1, actorId);
    await pool.query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1; UPDATE procurement.inbound_freight_costs SET actual_cents=6000 WHERE id=31");
    const physical = await costQuantityPhysicalSnapshot();
    const key = randomUUID();
    const updated = await updateShipmentCosts(key);
    expect(updated).toMatchObject({ httpStatus: 200, replayed: false, body: { shipmentId: 1, status: "applied", finalizedLines: 1, adjustments: 1, updated: 1 } });
    expect(await lot()).toMatchObject({ freight: "300000", total: "850000" });
    expect((await pool.query("SELECT total_cost_mills::text AS cost FROM oms.order_item_costs")).rows).toEqual([{ cost: "850000" }]);
    expect((await storage.getInboundShipmentById(1)).status).toBe("closed");
    expect((await pool.query("SELECT created_by FROM procurement.landed_cost_adjustments")).rows).toEqual([{ created_by: actorId }]);
    expect(await costQuantityPhysicalSnapshot()).toEqual(physical);
    expect(await updateShipmentCosts(key)).toMatchObject({ replayed: true, body: updated.body });
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.landed_cost_adjustments")).rows[0].count).toBe(1);
    const review = await shipment.getCostReview(1);
    expect(review).toMatchObject({ shipmentId: 1, lines: [{ lineId: 11, sourceIssue: null,
      application: { status: "applied", lotsUpdated: 1, cogsRowsUpdated: 1, issues: [] } }] });
    expect(await shipment.getCostReview(999)).toBeNull();
  });

  it("refreshes a stale by-value basis on a closed shipment without using the forbidden allocate endpoint", async () => {
    await pool.query("UPDATE procurement.inbound_freight_costs SET allocation_method='by_value' WHERE id=31");
    await receive(); await shipment.finalizeAllocations(1, actorId); await shipment.pushLandedCostsToLots(1, actorId);
    await pool.query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1");
    await storage.updatePurchaseOrderLine(21, { unitCostCents: 150, unitCostMills: 15000, totalProductCostCents: 30000, lineTotalCents: 32000 });
    expect((await shipment.getAllocationStatus(1)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "stale_allocation_basis" })]));
    await expect(shipment.runAllocation(1)).rejects.toMatchObject({ statusCode: 409 });
    expect(await updateShipmentCosts()).toMatchObject({ body: { status: "applied", adjustments: 1 } });
    expect((await shipment.getAllocationStatus(1)).issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "stale_allocation_basis" })]));
    expect((await pool.query("SELECT allocation_basis_value FROM procurement.inbound_freight_allocations")).rows).toEqual([{ allocation_basis_value: "15000.000000" }]);
  });

  it("serializes two cost update commands without duplicate adjustments or downstream revaluation", async () => {
    await receive(); await seedConsumedCost(); await shipment.finalizeAllocations(1, actorId); await shipment.pushLandedCostsToLots(1, actorId);
    await pool.query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1; UPDATE procurement.inbound_freight_costs SET actual_cents=6000 WHERE id=31");
    const applicationsBefore = (await pool.query("SELECT count(*)::int AS count FROM inventory.cost_applications")).rows[0].count;
    const results = await Promise.all([updateShipmentCosts(), updateShipmentCosts()]);
    expect(results.map(result => (result.body as { adjustments: number }).adjustments).sort()).toEqual([0, 1]);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.cost_applications")).rows[0].count).toBe(applicationsBefore + 1);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.landed_cost_adjustments")).rows[0].count).toBe(1);
    expect(await lot()).toMatchObject({ freight: "300000", total: "850000" });
  });

  it("takes the shared cost lock before the shipment lock, matching receiving and PO amendments", async () => {
    await receive();
    let signalPid!: (pid: number) => void;
    const waitingPid = new Promise<number>(resolve => { signalPid = resolve; });
    let pending: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
      await database.transaction(async owner => {
        await lockInventoryCostGraph(owner);
        pending = database.transaction(async competitor => {
          signalPid(Number((await competitor.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid));
          return shipment.updateCostsInTransaction(competitor, 1, {}, actorId, NOW);
        }).then(() => ({ ok: true }), error => ({ ok: false, error }));
        const pid = await waitingPid;
        let waitingForGraph = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          waitingForGraph = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting", [pid])).rows[0].waiting;
          if (waitingForGraph) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(waitingForGraph).toBe(true);
        // The waiting update must not own the shipment row while another cost
        // owner holds the graph. NOWAIT makes the reversed lock order fail fast.
        expect((await owner.execute(sql`SELECT id FROM procurement.inbound_shipments WHERE id=1 FOR UPDATE NOWAIT`)).rows).toEqual([{ id: 1 }]);
      });
      expect(await pending).toEqual({ ok: true });
    } finally { await pending; }
  });

  it("rolls back the new split, closed-shipment adjustments, and sold costs if the reporting audit fails", async () => {
    await receive(); await seedConsumedCost(); await shipment.finalizeAllocations(1, actorId); await shipment.pushLandedCostsToLots(1, actorId);
    await pool.query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1; UPDATE procurement.inbound_freight_costs SET actual_cents=6000 WHERE id=31");
    const before = await lot();
    const snapshot = (await pool.query("SELECT * FROM procurement.landed_cost_snapshots")).rows;
    const allocations = (await pool.query("SELECT * FROM procurement.inbound_freight_allocations")).rows;
    const sold = (await pool.query("SELECT * FROM oms.order_item_costs")).rows;
    await pool.query(`CREATE FUNCTION inventory.fail_workflow_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected workflow audit failure'; END $$;
      CREATE TRIGGER fail_workflow_report BEFORE INSERT ON inventory.cost_reporting_events FOR EACH ROW EXECUTE FUNCTION inventory.fail_workflow_report()`);
    try { await expect(updateShipmentCosts()).rejects.toThrow(/injected workflow audit failure/); }
    finally { await pool.query("DROP TRIGGER fail_workflow_report ON inventory.cost_reporting_events; DROP FUNCTION inventory.fail_workflow_report()"); }
    expect(await lot()).toEqual(before);
    expect((await pool.query("SELECT * FROM procurement.landed_cost_snapshots")).rows).toEqual(snapshot);
    expect((await pool.query("SELECT * FROM procurement.inbound_freight_allocations")).rows).toEqual(allocations);
    expect((await pool.query("SELECT * FROM oms.order_item_costs")).rows).toEqual(sold);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.landed_cost_adjustments")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT status FROM public.financial_command_results")).rows).toEqual([{ status: "retryable" }]);
  });

  it("persists actionable review results when historical quantities remain unresolved", async () => {
    await legacyQuantityGaps();
    await pool.query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1");
    const physical = await costQuantityPhysicalSnapshot();
    const result = await updateShipmentCosts();
    expect(result).toMatchObject({ body: { status: "review_required", updated: 3 } });
    const review = await shipment.getCostReview(1);
    expect(review?.lines[0].application).toMatchObject({ status: "review_required", lotsUpdated: 3, cogsRowsUpdated: 2,
      issues: [expect.objectContaining({ code: "COST_UNRESOLVED_QUANTITY_RETAINED", unresolvedQuantity: expect.objectContaining({ inventoryLotId: 3364, quantity: 4 }) }),
        expect.objectContaining({ code: "COST_UNRESOLVED_QUANTITY_RETAINED", unresolvedQuantity: expect.objectContaining({ inventoryLotId: 4016, quantity: 1 }) })] });
    expect(await costQuantityPhysicalSnapshot()).toEqual(physical);
    expect(await shipment.getCostReview(1)).toEqual(review);
  });

  function exceptionService() { return createShipmentCostExceptionService(database, () => NOW); }
  registerPoAmendmentDependencyCases({ pool: () => pool, database: () => database, shipments: () => shipment, at: NOW, receive,
    expectedReceipts: () => storage.getExpectedReceiptsReport(),
    historicalGaps: legacyQuantityGaps,
    receiveDirect: async () => {
      const receipt = await purchasing.createReceiptFromPO(10, actorId);
      const [line] = await storage.getReceivingLines(receipt.id);
      await receiving.open(receipt.id, actorId);
      await receiving.updateLine(line.id, { receivedQty: 1, putawayLocationId: 99, expectedUnitVersion: receivingUnitVersion(line) }, actorId);
      await receiving.close(receipt.id, actorId);
    },
    transferAndSell: async () => {
      await pool.query("INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(100,1,'AMENDMENT-PICK')");
      await inventory.transfer({ productVariantId: 200, fromLocationId: 99, toLocationId: 100, qty: 1, userId: actorId });
      const { InventoryLotService } = await import("../../../inventory/lots.service");
      await database.transaction(tx => new InventoryLotService(tx, () => NOW).pickFromLots({ productVariantId: 200,
        warehouseLocationId: 100, qty: 1, orderId: 1, orderItemId: 1 }));
    } });
  registerQuantityCorrectionCases({pool:()=>pool,database:()=>database,shipments:()=>shipment,at:NOW,receive,approveSupplier:approveEvidence,
    transferAndSell:async()=>{
      await pool.query("INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(100,1,'CORRECTION-PICK')");
      await inventory.transfer({productVariantId:200,fromLocationId:99,toLocationId:100,qty:1,userId:actorId});
      const {InventoryLotService}=await import("../../../inventory/lots.service");
      await database.transaction(tx=>new InventoryLotService(tx,()=>NOW).pickFromLots({productVariantId:200,
        warehouseLocationId:100,qty:1,orderId:1,orderItemId:1}));
    }});
  registerOriginRepairCases({ pool: () => pool, database: () => database, at: NOW, updateCosts: updateShipmentCosts,
    physicalSnapshot: costQuantityPhysicalSnapshot, costHealth: () => shipment.getLandedCostHealth(),
    shipmentReview: () => shipment.getCostReview(1) });
  registerShipmentReconciliationCases({ pool:()=>pool, database:()=>database, at:NOW,
    prepareGaps:legacyQuantityGaps, updateCosts:updateShipmentCosts, physicalSnapshot:costQuantityPhysicalSnapshot,
    costHealth: () => shipment.getLandedCostHealth() });
  async function prepareException() {
    await legacyQuantityGaps();
    await pool.query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1");
    await updateShipmentCosts();
    const context = await exceptionService().context(11, "admin-user");
    expect(context).toMatchObject({ canApprove: true, blockedReason: null, review: { state: "open", kind: "unexplained_quantity" } });
    return { sourceVersion: context.sourceVersion, action: "accept" as const, reason: "Reviewed the historical movement records and retained amount." };
  }
  async function decideException(request: ShipmentExceptionRequest, key = randomUUID(), actor = "admin-user") {
    return exceptionService().decide(11, request, actor, { ...shipmentExceptionScope(11), actorType: "user", actorId: actor,
      contractVersion: 1, idempotencyKey: key, requestHash: costFingerprint(request) });
  }
  async function completeCostSnapshot() {
    return {
      physical: await costQuantityPhysicalSnapshot(),
      lots: (await pool.query("SELECT * FROM inventory.inventory_lots ORDER BY id")).rows,
      cogs: (await pool.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows,
      applications: (await pool.query("SELECT * FROM inventory.cost_applications ORDER BY id")).rows,
      reporting: (await pool.query("SELECT * FROM inventory.cost_reporting_events ORDER BY id")).rows,
      allocations: (await pool.query("SELECT * FROM inventory.lot_cost_quantity_allocations ORDER BY id")).rows,
      charges: (await pool.query("SELECT * FROM procurement.inbound_freight_costs ORDER BY id")).rows,
    };
  }
  it("accepts a historical exception with immutable before/after and no inventory or accounting mutation; lost-response retries replay", async () => {
    const request = await prepareException(), before = await completeCostSnapshot(), key = randomUUID();
    const result = await decideException(request, key);
    expect(result).toMatchObject({ httpStatus: 200, replayed: false, body: { lineId: 11, decision: { action: "accept", actorId: "admin-user" } } });
    expect(await completeCostSnapshot()).toEqual(before);
    expect(await decideException(request, key)).toMatchObject({ httpStatus: 200, replayed: true, body: result.body });
    const saved = (await pool.query("SELECT * FROM procurement.shipment_cost_exception_decisions")).rows;
    expect(saved).toHaveLength(1);
    expect(saved[0].evidence).toMatchObject({ before: { state: "open" }, after: { state: "accepted" },
      inventoryQuantityDelta: 0, inventoryCostDeltaMills: 0, orderCostDeltaMills: 0, approval: { userId: "admin-user", active: true } });
    expect((await shipment.getCostReview(1))?.lines[0]).toMatchObject({ application: { status: "review_required" }, exceptionReview: { state: "accepted" } });
    expect((await readPoShipmentCosts(database, 10))?.lines[0]).toMatchObject({ status: "review_required", exceptionReview: { state: "accepted" } });
    await expect(pool.query("UPDATE procurement.shipment_cost_exception_decisions SET reason='Changed old decision' ")).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM procurement.shipment_cost_exception_decisions")).rejects.toThrow(/immutable/);
    await updateShipmentCosts();
    expect((await exceptionService().context(11, "admin-user")).review?.state).toBe("accepted");
  });
  it("reopens an accepted decision with a new reason and preserves its previous evidence", async () => {
    const request = await prepareException(); await decideException(request);
    const context = await exceptionService().context(11, "admin-user"), before = await completeCostSnapshot();
    const reopened = await decideException({ ...request, sourceVersion: context.sourceVersion, action: "reopen", reason: "New receipt evidence needs another review." });
    expect(reopened).toMatchObject({ httpStatus: 200, body: { decision: { action: "reopen" } } });
    const reviewed = await exceptionService().context(11, "admin-user");
    expect(reviewed.review?.state).toBe("open");
    expect(reviewed.history.map(decision => decision.action)).toEqual(["reopen", "accept"]);
    const events = (await pool.query("SELECT id,previous_decision_id,action FROM procurement.shipment_cost_exception_decisions ORDER BY id")).rows;
    expect(events).toHaveLength(2); expect(events[1].previous_decision_id).toBe(events[0].id);
    expect(await completeCostSnapshot()).toEqual(before);
  });
  it.each(["lead-user", "custom-user", "scoped-user", "missing-user"])("rejects %s using current identity authority", async actor => {
    const request = await prepareException(), before = await completeCostSnapshot();
    expect((await exceptionService().context(11, actor)).canApprove).toBe(false);
    expect(await decideException(request, randomUUID(), actor)).toMatchObject({ httpStatus: 403, body: { code: "SHIPMENT_EXCEPTION_ADMIN_REQUIRED" } });
    expect(await completeCostSnapshot()).toEqual(before);
    expect((await pool.query("SELECT * FROM procurement.shipment_cost_exception_decisions")).rows).toEqual([]);
  });
  it.each(["membership", "permission", "active"])("rechecks revoked %s between preview and approval", async field => {
    const request = await prepareException();
    if (field === "membership") await pool.query("DELETE FROM identity.auth_user_roles WHERE user_id='admin-user'");
    if (field === "permission") await pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=1");
    if (field === "active") await pool.query("UPDATE identity.users SET active=0 WHERE id='admin-user'");
    expect(await decideException(request)).toMatchObject({ httpStatus: 403 });
  });
  it("rejects stale previews and reopens the displayed review when the underlying charge changes", async () => {
    const request = await prepareException(); await decideException(request);
    await pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=400000 WHERE id=31");
    expect((await shipment.getCostReview(1))?.lines[0].exceptionReview?.state).toBe("open");
    expect((await exceptionService().context(11, "admin-user")).blockedReason).toContain("changed");
    expect(await decideException(request)).toMatchObject({ httpStatus: 409, body: { code: "SHIPMENT_EXCEPTION_STALE" } });
    await updateShipmentCosts();
    const current = await exceptionService().context(11, "admin-user");
    expect(current).toMatchObject({ blockedReason: null, review: { state: "open", allocatedMills: 40000000 } });
  });
  it("serializes two independent administrators' confirmations without duplicate decisions", async () => {
    const request = await prepareException();
    const results = await Promise.all([decideException(request), decideException(request)]);
    expect(results.map(result => result.httpStatus).sort()).toEqual([200, 409]);
    expect((await pool.query("SELECT * FROM procurement.shipment_cost_exception_decisions")).rows).toHaveLength(1);
  });
  it("rolls back a failed audit insert and retries the same approval key safely", async () => {
    const request = await prepareException(), key = randomUUID(), before = await completeCostSnapshot();
    await pool.query(`CREATE FUNCTION procurement.fail_exception_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected exception audit failure'; END $$;
      CREATE TRIGGER fail_exception_audit BEFORE INSERT ON procurement.shipment_cost_exception_decisions FOR EACH ROW EXECUTE FUNCTION procurement.fail_exception_audit()`);
    try { await expect(decideException(request, key)).rejects.toThrow(); }
    finally { await pool.query("DROP TRIGGER fail_exception_audit ON procurement.shipment_cost_exception_decisions; DROP FUNCTION procurement.fail_exception_audit()"); }
    expect(await completeCostSnapshot()).toEqual(before);
    expect((await pool.query("SELECT * FROM procurement.shipment_cost_exception_decisions")).rows).toEqual([]);
    // Honor the real command owner's first retry deadline (two seconds). Do not
    // disable its immutable-ledger trigger to make the retry run early.
    await pool.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM next_attempt_at-clock_timestamp())) + 0.01) FROM public.financial_command_results WHERE idempotency_key=$1 AND status='retryable'", [key]);
    expect(await decideException(request, key)).toMatchObject({ httpStatus: 200 });
  });

  it("accepts missing receipt history as a separate review without inventing an origin or applying its charge", async () => {
    await legacyQuantityGaps();
    await pool.query(`INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
      po_line_id,inbound_shipment_id,unit_cost_cents,cost_source,received_at) VALUES(1453,'MISSING-RECEIPT',200,99,10,0,21,1,1,'po','2026-09-01');
      UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1`);
    await updateShipmentCosts();
    const context = await exceptionService().context(11, "admin-user"), before = await completeCostSnapshot();
    expect(context).toMatchObject({ blockedReason: null, review: { kind: "missing_receipt_history", amountMills: 33500700, lotsUpdated: 0, cogsRowsUpdated: 0 } });
    expect(await decideException({ sourceVersion: context.sourceVersion, action: "accept", reason: "Legacy receipt reviewed; source documentation unavailable." })).toMatchObject({ httpStatus: 200 });
    expect(await completeCostSnapshot()).toEqual(before);
    expect((await pool.query("SELECT * FROM inventory.lot_cost_origins WHERE inventory_lot_id=1453")).rows).toEqual([]);
  });

  it("rechecks authority after waiting behind an in-flight cost update", async () => {
    const request = await prepareException();
    const blocker = await pool.connect();
    let release!: () => void;
    let observed!: () => void;
    const locked = new Promise<void>(resolve => { observed = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const gate = database.transaction(async tx => { await lockInventoryCostGraph(tx); observed(); await wait; });
    await locked;
    const attempt = decideException(request);
    try {
      await blocker.query("BEGIN");
      await blocker.query("DELETE FROM identity.auth_user_roles WHERE user_id='admin-user'");
      await blocker.query("COMMIT");
    } finally { release(); blocker.release(); }
    await gate;
    expect(await attempt).toMatchObject({ httpStatus: 403 });
    expect((await pool.query("SELECT * FROM procurement.shipment_cost_exception_decisions")).rows).toEqual([]);
  });

  it("updates late freight through historical gaps into stock and sold costs while retaining every mill", async () => {
    await legacyQuantityGaps();
    const before = await costQuantityPhysicalSnapshot();
    const result = await shipment.pushLandedCostsToLots(1,actorId);
    expect(result).toMatchObject({status:"review_required",updated:3,total:3});
    expect(result.costApplications[0]).toMatchObject({lotsUpdated:3,cogsRowsUpdated:2,issues:[
      {code:"COST_UNRESOLVED_QUANTITY_RETAINED",unresolvedQuantity:{inventoryLotId:3364,quantity:4}},
      {code:"COST_UNRESOLVED_QUANTITY_RETAINED",unresolvedQuantity:{inventoryLotId:4016,quantity:1}},
    ]});
    expect(await costQuantityPhysicalSnapshot()).toEqual(before);
    const { readUnallocatedLotCosts } = await import("../../../inventory/infrastructure/cost-quantity.repository");
    const remaining = await database.transaction(async tx => readUnallocatedLotCosts(tx,
      (await tx.execute(sql`SELECT * FROM inventory.inventory_lots ORDER BY id`)).rows.map(row => ({...row,id:row.id}))));
    const stock = [...remaining.values()].reduce((sum,row) => sum+row.costs.landedMills,BigInt(0));
    const sold = BigInt((await pool.query("SELECT sum(landed_total_cost_mills)::text AS amount FROM oms.order_item_costs")).rows[0].amount);
    const held = result.costApplications[0].issues.reduce((sum,issue) => sum+BigInt(issue.unresolvedQuantity!.amountMills),BigInt(0));
    expect(stock).toBeGreaterThan(BigInt(0)); expect(sold).toBeGreaterThan(BigInt(0)); expect(held).toBeGreaterThan(BigInt(0));
    expect(stock+sold+held).toBe(BigInt(33_500_700));
    expect(remaining.get(3364)?.quantity).toBe(157);
    expect(remaining.get(4016)?.quantity).toBe(0);
    const event = (await pool.query("SELECT payload FROM inventory.cost_reporting_events ORDER BY id DESC LIMIT 1")).rows[0].payload;
    const { inventoryCostReportEventSchema } = await import("@shared/procurement/cost-report-delivery");
    expect(inventoryCostReportEventSchema.parse(event).unresolvedQuantities).toHaveLength(2);
    expect(event.cogsDeltaCents).toBe(result.costApplications[0].totalCogsDeltaCents);
    const retry = await shipment.pushLandedCostsToLots(1,actorId);
    expect(retry).toMatchObject({status:"review_required",updated:0,total:3});
    expect(retry.costApplications[0]).toMatchObject({applicationId:result.costApplications[0].applicationId,replayed:true});
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.lot_cost_quantity_allocations WHERE source_evidence->>'sourceKind'='unresolved_historical_quantity'")).rows[0].count).toBe(2);
    expect(await costQuantityPhysicalSnapshot()).toEqual(before);
  });

  it("serializes simultaneous late-cost retries without duplicate unresolved allocations or COGS changes", async () => {
    await legacyQuantityGaps();
    const results = await Promise.all([shipment.pushLandedCostsToLots(1,actorId),shipment.pushLandedCostsToLots(1,actorId)]);
    expect(results.map(result=>result.updated).sort()).toEqual([0,3]);
    expect(new Set(results.map(result=>result.costApplications[0].applicationId)).size).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.cost_reporting_events")).rows[0].count).toBe(1);
  });

  it("retains zero unresolved cost without losing the quantity review", async () => {
    await legacyQuantityGaps();
    await pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=0 WHERE id=31");
    await shipment.finalizeAllocations(1,actorId);
    const result = await shipment.pushLandedCostsToLots(1,actorId);
    expect(result).toMatchObject({status:"review_required",updated:3});
    expect(result.costApplications[0].issues.map(issue=>issue.unresolvedQuantity?.amountMills)).toEqual([0,0]);
  });

  it("revalues the same unresolved intervals when the supplier's freight changes", async () => {
    await legacyQuantityGaps();
    const first = await shipment.pushLandedCostsToLots(1,actorId);
    const custody = (await pool.query("SELECT * FROM inventory.lot_cost_quantity_allocations ORDER BY id")).rows;
    await pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=670014 WHERE id=31");
    await shipment.finalizeAllocations(1,actorId);
    const revised = await shipment.pushLandedCostsToLots(1,actorId);
    expect(revised).toMatchObject({status:"review_required",updated:3});
    expect((await pool.query("SELECT * FROM inventory.lot_cost_quantity_allocations ORDER BY id")).rows).toEqual(custody);
    expect(revised.costApplications[0].issues.map(issue=>issue.unresolvedQuantity?.allocationId))
      .toEqual(first.costApplications[0].issues.map(issue=>issue.unresolvedQuantity?.allocationId));
    expect(revised.costApplications[0].issues[0].unresolvedQuantity!.amountMills)
      .toBeGreaterThan(first.costApplications[0].issues[0].unresolvedQuantity!.amountMills);
  });

  it("does not let a stock command silently import an unexplained quantity", async () => {
    await legacyQuantityGaps();
    const { ensureLotCostQuantityBasis } = await import("../../../inventory/infrastructure/cost-quantity.repository");
    await expect(database.transaction(async tx => {
      const source = (await tx.execute(sql`SELECT * FROM inventory.inventory_lots WHERE id=3364`)).rows[0];
      await ensureLotCostQuantityBasis(tx,{...source,id:3364},actorId,NOW);
    })).rejects.toMatchObject({code:"COST_HISTORICAL_QUANTITY_INCOMPLETE"});
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.lot_cost_quantity_allocations")).rows[0].count).toBe(0);
  });

  it("refuses excess recorded consumption instead of fabricating negative custody", async () => {
    await legacyQuantityGaps();
    await pool.query("UPDATE inventory.inventory_lots SET qty_on_hand=180 WHERE id=3364");
    const result = await shipment.pushLandedCostsToLots(1,actorId);
    expect(result).toMatchObject({status:"review_required",updated:0,total:0});
    expect(result.skipped.some(issue=>issue.reason==="COST_HISTORICAL_QUANTITY_INCOMPLETE")).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.lot_cost_quantity_allocations")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.cost_reporting_events")).rows[0].count).toBe(0);
  });

  it("does not absorb a new stock discrepancy after exact custody was established", async () => {
    await legacyQuantityGaps(); await shipment.pushLandedCostsToLots(1,actorId);
    await pool.query("UPDATE inventory.inventory_lots SET qty_on_hand=156 WHERE id=3364");
    const result = await shipment.pushLandedCostsToLots(1,actorId);
    expect(result).toMatchObject({status:"review_required",updated:0});
    expect(result.skipped.some(issue=>issue.reason==="COST_QUANTITY_CUSTODY_CONFLICT")).toBe(true);
  });

  it("rolls back cost custody and all revaluation when the reporting audit fails", async () => {
    await legacyQuantityGaps();
    await pool.query(`CREATE FUNCTION inventory.fail_cost_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected cost report failure'; END $$;
      CREATE TRIGGER fail_cost_report BEFORE INSERT ON inventory.cost_reporting_events FOR EACH ROW EXECUTE FUNCTION inventory.fail_cost_report()`);
    try {
      await expect(shipment.pushLandedCostsToLots(1,actorId)).rejects.toThrow("injected cost report failure");
      expect((await pool.query("SELECT count(*)::int AS count FROM inventory.lot_cost_quantity_allocations")).rows[0].count).toBe(0);
      expect((await pool.query("SELECT sum(landed_cost_mills)::text AS amount FROM inventory.inventory_lots")).rows[0].amount).toBe("0");
      expect((await pool.query("SELECT count(*)::int AS count FROM inventory.cost_applications")).rows[0].count).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER fail_cost_report ON inventory.cost_reporting_events; DROP FUNCTION inventory.fail_cost_report()");
    }
  });

  it("applies a later invoice through real transfer lineage into sold destination COGS", async () => {
    await receive();
    await pool.query("INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(100,1,'AUDIT-PICK')");
    await inventory.transfer({productVariantId:200,fromLocationId:99,toLocationId:100,qty:1,userId:actorId});
    const {InventoryLotService}=await import("../../../inventory/lots.service");
    await database.transaction(tx=>new InventoryLotService(tx,()=>NOW).pickFromLots({productVariantId:200,
      warehouseLocationId:100,qty:1,orderId:1,orderItemId:1}));
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

  it("applies uniform-lot residuals while preserving their exact extended cost", async () => {
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
      expect(application).toMatchObject({status:"applied",lotsUpdated:1,issues:[]});
    });
    expect(await lot()).not.toEqual(beforeReview);
    expect((await pool.query("SELECT product_total_cost_mills::text AS amount,cost_basis_qty FROM inventory.inventory_lots ORDER BY id")).rows)
      .toEqual([{amount:"3",cost_basis_qty:2}]);
  });

  it("reads shipment charges and costing readiness without changing supplier totals or writing records", async () => {
    await pool.query("UPDATE procurement.purchase_orders SET total_cents=22000 WHERE id=10");
    const before = await state();
    expect(await readPoShipmentCostSummary(database,10)).toMatchObject({
      freightCents:0,combinedCostCents:null,unallocatedChargeCount:1,inventoryCosting:"pending",
    });
    expect(await state()).toEqual(before);
    await shipment.finalizeAllocations(1,actorId);
    expect(await readPoShipmentCostSummary(database,10)).toMatchObject({
      freightCents:5000,totalCents:5000,poAmountCents:22000,combinedCostCents:27000,
    });
    await receive();
    await shipment.pushLandedCostsToLots(1,actorId);
    expect(await readPoShipmentCostSummary(database,10)).toMatchObject({
      freightCents:5000,appliedLines:1,inventoryCosting:"applied",
    });
    expect((await pool.query("SELECT total_cents,shipping_cost_cents,tax_cents FROM procurement.purchase_orders WHERE id=10")).rows[0])
      .toEqual({total_cents:"22000",shipping_cost_cents:"0",tax_cents:"0"});
    expect(await readPoShipmentCostSummary(database,999999)).toBeNull();
  });

  it("agrees across PO, shipment and health for posted estimates and reopens changed equal-value sources", async () => {
    await pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=NULL,estimated_cents=5000,cost_status='estimated' WHERE id=31");
    await shipment.finalizeAllocations(1, actorId);
    await receive();
    await shipment.pushLandedCostsToLots(1, actorId);
    await pool.query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1");
    const saved = await state();
    const po = await readPoShipmentCosts(database, 10);
    const review = await shipment.getCostReview(1);
    expect(po?.summary).toMatchObject({ inventoryCosting: "applied", appliedLines: 1, pendingLines: 0, estimatedCents: 5000 });
    expect(review?.lines).toHaveLength(1);
    expect(isShipmentCostLinePosted(review!.lines[0])).toBe(true);
    const health = await shipment.getLandedCostHealth();
    expect(health.counts.staleProvisionalLots).toBe(0);
    expect(health.counts.postingReviewRequired).toBe(0);
    expect(health.items.some(item => item.action === "push_costs_to_lots")).toBe(false);
    expect(await state()).toEqual(saved);

    // Equal money is deliberately insufficient: changed supplier evidence must
    // invalidate the old source fingerprint until the owner applies it again.
    await pool.query("UPDATE procurement.inbound_freight_costs SET vendor_id=5 WHERE id=31");
    // A legacy advisory flag must not hide a newly stale posting.
    await pool.query("UPDATE inventory.inventory_lots SET cost_provisional=0");
    const changed = await state();
    expect((await readPoShipmentCosts(database, 10))?.lines[0]).toMatchObject({ status: "review_required",
      issues: expect.arrayContaining([expect.objectContaining({ code: "COST_UPDATE_OUTDATED" })]) });
    const staleReview = await shipment.getCostReview(1);
    expect(isShipmentCostLinePosted(staleReview!.lines[0])).toBe(false);
    expect(staleReview?.lines[0].sourceIssue?.code).toBe("COST_UPDATE_OUTDATED");
    expect((await shipment.getLandedCostHealth()).counts.postingReviewRequired).toBe(1);
    expect(await state()).toEqual(changed);
    await shipment.pushLandedCostsToLots(1, actorId);
    expect((await readPoShipmentCosts(database, 10))?.summary.inventoryCosting).toBe("applied");
    expect(isShipmentCostLinePosted((await shipment.getCostReview(1))!.lines[0])).toBe(true);
  });

  it("reads persistent line reasons and supplier plus shipment cards in a read-only snapshot", async () => {
    await shipment.finalizeAllocations(1, actorId);
    await receive();
    await shipment.pushLandedCostsToLots(1, actorId);
    await pool.query("UPDATE procurement.purchase_orders SET shipping_cost_cents=300,tax_cents=200,total_cents=22500 WHERE id=10");
    const recorded = await readPoShipmentCosts(database, 10);
    const recordedLine = recorded?.lines[0];
    expect(recordedLine?.applicationId).toBeGreaterThan(0);
    const issue = { code: "COST_UNIFORM_LOT_RESIDUAL_REVIEW", message: "The earlier attempt could not represent the exact remainder." };
    // Seed a newer historical attempt. Application records remain immutable.
    const { costFingerprint } = await import("../../../inventory/infrastructure/cost-evidence.repository");
    const applicationKey = costFingerprint({ fixture: "shipment-cost-review", priorApplicationId: recordedLine?.applicationId });
    const result = { applicationId: 0, status: "review_required", lotsUpdated: 0, cogsRowsUpdated: 0,
      totalCogsDeltaCents: 0, issues: [issue], replayed: false };
    const inserted = await pool.query(`INSERT INTO inventory.cost_applications
      (source_revision_id,application_key,status,evidence,recorded_by,recorded_at)
      SELECT source_revision_id,$1,'review_required',jsonb_set(evidence,'{result}',$2::jsonb),$3,$4
      FROM inventory.cost_applications WHERE id=$5 RETURNING id`,
      [applicationKey, JSON.stringify(result), actorId, NOW, recordedLine?.applicationId]);
    expect(inserted.rowCount).toBe(1);
    const before = await state();
    const costs = await readPoShipmentCosts(database, 10);
    expect(costs).toMatchObject({ supplier: { freightCents: 300, dutyCents: 200 },
      totals: { freightCents: 5300, dutyCents: 200, combinedCostCents: 27500 },
      summary: { reviewLines: 1, inventoryCosting: "review_required" },
      lines: [{ lineId: recordedLine?.lineId, purchaseOrderLineId: 21, shipmentId: 1, status: "review_required", issues: [issue] }],
    });
    expect(projectPoLineLandedCosts({
      poHeader: { totalCents: 22500, taxCents: 200, shippingCostCents: 300 },
      poLines: [{ id: 21, orderQty: 200, lineTotalCents: 22000 }], costs,
    })).toEqual({ status: "complete", poLevelAdjustmentCents: 500, lines: [
      { purchaseOrderLineId: 21, pieces: 200, supplierCents: 22000, shipmentCents: 5000, totalCents: 27000 },
    ] });
    expect(costs?.lines[0].applicationId).toBeGreaterThan(0);
    expect(costs?.lines[0].recordedAt).toBeTruthy();
    expect(await state()).toEqual(before);
    expect(await readPoShipmentCostSummary(database, 10)).toEqual(costs?.summary);
  });

  async function exactPieceLot() {
    const {InventoryLotService}=await import("../../../inventory/lots.service");
    const created=await database.transaction(tx=>new InventoryLotService(tx,()=>NOW).createLot({
      productVariantId:201,warehouseLocationId:99,qty:80_000,unitCostCents:5,unitCostMills:500,costSource:"po",receivedAt:NOW,
    }));
    await database.transaction(tx=>cogs.revalueExactComponent(created.id,"landed",11_907_200,80_000,"confirmed shipment charge",actorId,tx));
    return created.id;
  }

  it("preserves a 1,190.72 shipment charge across large partial picks",async()=>{
    const lotId=await exactPieceLot();
    const {InventoryLotService}=await import("../../../inventory/lots.service");
    await database.transaction(tx=>new InventoryLotService(tx,()=>NOW).pickFromLots({
      productVariantId:201,warehouseLocationId:99,qty:30_000,orderId:1,orderItemId:1,expectedExistingCostQuantity:0,
    }));
    const {loadCanonicalDispatchCosts}=await import("../../../inventory/infrastructure/canonical-claim-dispatch-inventory");
    const selected=(await pool.query("SELECT id FROM oms.order_item_costs WHERE inventory_lot_id=$1",[lotId])).rows.map(row=>Number(row.id));
    expect(await loadCanonicalDispatchCosts({client:pool,costIds:selected})).toMatchObject([{
      quantity:"30000",unitCostMills:"649",totalCostMills:"19465200",
      exactTotals:{productMills:"15000000",packagingMills:"0",landedMills:"4465200"},
    }]);
    await database.transaction(tx=>new InventoryLotService(tx,()=>NOW).pickFromLots({
      productVariantId:201,warehouseLocationId:99,qty:50_000,orderId:1,orderItemId:1,expectedExistingCostQuantity:30_000,
    }));
    expect((await pool.query("SELECT SUM(landed_total_cost_mills)::text AS freight,SUM(total_cost_mills)::text AS total FROM oms.order_item_costs WHERE inventory_lot_id=$1",[lotId])).rows)
      .toEqual([{freight:"11907200",total:"51907200"}]);
    expect((await pool.query("SELECT qty_on_hand FROM inventory.inventory_lots WHERE id=$1",[lotId])).rows).toEqual([{qty_on_hand:0}]);
  });

  it("restores exact cost after a partial unpick and conserves value on repick",async()=>{
    const lotId=await exactPieceLot();
    const {InventoryLotService}=await import("../../../inventory/lots.service");
    await database.transaction(tx=>new InventoryLotService(tx,()=>NOW).pickFromLots({
      productVariantId:201,warehouseLocationId:99,qty:30_000,orderId:1,orderItemId:1,expectedExistingCostQuantity:0,
    }));
    await database.transaction(tx=>new InventoryLotService(tx,()=>NOW).unpickFromLots({
      productVariantId:201,warehouseLocationId:99,qty:20_000,orderId:1,orderItemId:1,
    }));
    expect((await pool.query("SELECT qty,total_cost_mills::text AS total,landed_total_cost_mills::text AS freight FROM oms.order_item_costs")).rows)
      .toEqual([{qty:10_000,total:"6488400",freight:"1488400"}]);
    await database.transaction(tx=>new InventoryLotService(tx,()=>NOW).pickFromLots({
      productVariantId:201,warehouseLocationId:99,qty:70_000,orderId:1,orderItemId:1,expectedExistingCostQuantity:10_000,
    }));
    expect((await pool.query("SELECT SUM(total_cost_mills)::text AS total,SUM(landed_total_cost_mills)::text AS freight FROM oms.order_item_costs WHERE inventory_lot_id=$1",[lotId])).rows)
      .toEqual([{total:"51907200",freight:"11907200"}]);
  });

  it("serializes competing picks without overlapping exact cost quantities",async()=>{
    const lotId=await exactPieceLot();
    const {InventoryLotService}=await import("../../../inventory/lots.service");
    const pick=()=>database.transaction(tx=>new InventoryLotService(tx,()=>NOW).pickFromLots({
      productVariantId:201,warehouseLocationId:99,qty:60_000,orderId:1,orderItemId:1,expectedExistingCostQuantity:0,
    }));
    const results=await Promise.allSettled([pick(),pick()]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
    expect((await pool.query("SELECT qty_on_hand FROM inventory.inventory_lots WHERE id=$1",[lotId])).rows).toEqual([{qty_on_hand:20_000}]);
    expect((await pool.query("SELECT SUM(quantity)::int AS quantity FROM inventory.lot_cost_quantity_allocations WHERE inventory_lot_id=$1 AND direction=1",[lotId])).rows)
      .toEqual([{quantity:60_000}]);
  });

  it("replays cost references and reversals without allocating twice and rejects conflicting reuse", async () => {
    const lotId=await exactPieceLot();
    const {allocateLotQuantityCost,referenceLotQuantityCost,reverseLotQuantityCost}=await import("../../../inventory/infrastructure/cost-quantity.repository");
    const allocation=await database.transaction(tx=>allocateLotQuantityCost(tx,lotId,100,actorId,NOW,{},"cost:test:positive"));
    const reference=await database.transaction(tx=>referenceLotQuantityCost(tx,allocation.id!,[{start:0,quantity:50}],actorId,NOW,"cost:test:reference"));
    expect(await database.transaction(tx=>referenceLotQuantityCost(tx,allocation.id!,[{start:0,quantity:50}],actorId,NOW,"cost:test:reference")))
      .toEqual(reference);
    await expect(database.transaction(tx=>referenceLotQuantityCost(tx,allocation.id!,[{start:0,quantity:49}],actorId,NOW,"cost:test:reference")))
      .rejects.toMatchObject({code:"COST_ALLOCATION_REPLAY_CONFLICT"});
    const reversal=await database.transaction(tx=>reverseLotQuantityCost(tx,allocation.id!,50,actorId,NOW,"cost:test:reverse"));
    expect(await database.transaction(tx=>reverseLotQuantityCost(tx,allocation.id!,50,actorId,NOW,"cost:test:reverse")))
      .toEqual(reversal);
    expect((await pool.query("SELECT count(*)::integer AS n FROM inventory.lot_cost_quantity_allocations WHERE inventory_lot_id=$1",[lotId])).rows[0].n).toBe(3);
    await expect(pool.query("UPDATE inventory.lot_cost_quantity_allocations SET quantity=1 WHERE id=$1",[allocation.id])).rejects.toThrow();
    await expect(pool.query("DELETE FROM inventory.lot_cost_quantity_bases WHERE inventory_lot_id=$1",[lotId])).rejects.toThrow();
    await pool.query(readFileSync(resolve(process.cwd(),"migrations/0751_exact_inventory_cost_totals.sql"),"utf8"));
    expect((await pool.query("SELECT count(*)::integer AS n FROM inventory.lot_cost_quantity_allocations WHERE inventory_lot_id=$1",[lotId])).rows[0].n).toBe(3);
  });

  it.each(["shipment","cycle_count"] as const)("conserves exact remaining value after an on-hand %s loss",async(kind)=>{
    const lotId=await exactPieceLot();
    if (kind==="shipment") {
      const {InventoryLotService}=await import("../../../inventory/lots.service");
      await database.transaction(async tx=>{
        await lockInventoryCostGraph(tx);
        await new InventoryLotService(tx,()=>NOW).shipFromLots({
          productVariantId:201,warehouseLocationId:99,qty:30000,fromOnHand:30000,fromPicked:0,reservedToRelease:0,
        });
      });
    } else {
      const level=(await pool.query("INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty) VALUES(201,99,80000) RETURNING id")).rows[0];
      await pool.query("INSERT INTO inventory.cycle_counts(id,name,status,warehouse_id) VALUES(1,'Verified loss','completed',1)");
      await pool.query(`INSERT INTO inventory.cycle_count_items(id,cycle_count_id,warehouse_location_id,product_variant_id,variance_qty,status,approved_by,approved_at)
        VALUES(1,1,99,201,-30000,'approved',$1,$2)`,[actorId,NOW]);
      const {PostgresCanonicalClaimInventoryRepository}=await import("../../../inventory/infrastructure/canonical-claim-inventory.repository");
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        const result=await new PostgresCanonicalClaimInventoryRepository().applyCycleCountAdjustment({
          client,inventoryLevelId:Number(level.id),productVariantId:201,warehouseLocationId:99,
          quantityBefore:80000,countedQty:50000,cycleCountId:1,cycleCountItemId:1,actor:actorId,reason:"Verified stock loss",occurredAt:NOW,
        });
        expect(result.consumedCostMills).toBe(BigInt(19465200));
        await client.query("COMMIT");
      } catch(error) {await client.query("ROLLBACK");throw error;}
      finally {client.release();}
    }
    const {readUnallocatedLotCosts}=await import("../../../inventory/infrastructure/cost-quantity.repository");
    const remaining=await database.transaction(async tx=>readUnallocatedLotCosts(tx,
      (await tx.execute(sql`SELECT * FROM inventory.inventory_lots WHERE id=${lotId}`)).rows.map(row=>({...row,id:row.id}))));
    expect(remaining.get(lotId)).toMatchObject({quantity:50000,costs:{totalMills:BigInt(32442000),landedMills:BigInt(7442000)}});
    expect((await pool.query("SELECT qty_on_hand FROM inventory.inventory_lots WHERE id=$1",[lotId])).rows[0].qty_on_hand).toBe(50000);
  });

  it("real AP audit failure rolls back invoice evidence, lot layers, consumed COGS and adjustment log", async () => {
    await receive(); await seedConsumedCost(); const before = await state();
    await failAudit(async () => { await expect(approveEvidence()).rejects.toThrow(/cost audit injected AP audit failure/); });
    expect(await state()).toEqual(before);
  });
  registerSupplierReturnStockCases({ pool: () => pool, database: () => database, at: NOW, actorId,
    receive, approveInvoice: approveEvidence, inventory: () => inventory, receiving: () => receiving, shipments: () => shipment,
    updateFreight: async () => { await shipment.finalizeAllocations(1, actorId); return shipment.pushLandedCostsToLots(1, actorId); } });
  registerSupplierReturnCommandCases({ pool: () => pool, database: () => database, at: NOW, actorId,
    receive, approveInvoice: approveEvidence, inventory: () => inventory, receiving: () => receiving, shipments: () => shipment,
    updateFreight: async () => { await shipment.finalizeAllocations(1, actorId); return shipment.pushLandedCostsToLots(1, actorId); } });
  registerSupplierReturnCreditCases({ pool: () => pool, database: () => database, at: NOW, actorId,
    receive, approveInvoice: approveEvidence, inventory: () => inventory, receiving: () => receiving, shipments: () => shipment,
    updateFreight: async () => { await shipment.finalizeAllocations(1, actorId); return shipment.pushLandedCostsToLots(1, actorId); } });
  // Custody history is intentionally retained; register its case last so the
  // legacy empty-custody fixture reset never erases immutable return evidence.
  registerSupplierCreditCostCases({ pool: () => pool, database: () => database, at: NOW, actorId,
    receive, approveInvoice: approveEvidence, physicalSnapshot: costQuantityPhysicalSnapshot, receiving: () => receiving,
    closeShort: () => purchasing.closeShort(10, "Returned damaged case will not be replaced", actorId),
    updateFreight: async () => { await shipment.finalizeAllocations(1, actorId); return shipment.pushLandedCostsToLots(1, actorId); },
    prepareQuarantineReceipt: async (scope = { shipmentId: 1, purchaseOrderId: 10 }) => {
      const receipt = await purchasing.createReceiptFromShipment(scope.shipmentId, actorId, { purchaseOrderId: scope.purchaseOrderId });
      await receiving.open(receipt.id, actorId);
      const [line] = await storage.getReceivingLines(receipt.id);
      await receiving.updateLine(line.id, { putawayLocationId: 99, expectedUnitVersion: receivingUnitVersion(line) }, actorId);
      return { receiptId: receipt.id, line: (await storage.getReceivingLines(receipt.id))[0] };
    },
    transferAndSell: async () => {
      await pool.query("INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(100,1,'CREDIT-PICK')");
      await inventory.transfer({ productVariantId: 200, fromLocationId: 99, toLocationId: 100, qty: 1, userId: actorId });
      const { InventoryLotService } = await import("../../../inventory/lots.service");
      await database.transaction(tx => new InventoryLotService(tx, () => NOW).pickFromLots({ productVariantId: 200,
        warehouseLocationId: 100, qty: 1, orderId: 1, orderItemId: 1 }));
    } });

});
