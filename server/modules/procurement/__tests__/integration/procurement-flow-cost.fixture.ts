import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";
import { installPreOpeningQuantityAuthorityFixture } from "../../../inventory/__tests__/fixtures/pre-opening-quantity-authority.fixture";

export const FLOW_ACTOR = "controlled-procurement-flow";
export const FLOW_AT = new Date("2026-09-10T12:00:00.000Z");
export const FLOW_IDS = {
  productA: 100, productB: 101, caseA: 200, eachA: 201, caseB: 202, eachB: 203,
  vendor: 5, freightVendor: 6, mappingA: 11, mappingB: 12, warehouse: 1,
  locationX: 99, locationY: 100, order: 1, orderItem: 1,
} as const;

const TABLES = [
  schema.products, schema.productVariants, schema.vendors, schema.vendorProducts,
  schema.purchaseOrders, schema.purchaseOrderLines, schema.poStatusHistory, schema.poEvents,
  schema.poApprovalTiers, schema.poExceptions, schema.purchasingRecommendationDecisions,
  schema.purchasingRecommendationPoHandoffs, schema.inboundShipments, schema.inboundShipmentLines,
  schema.receivingOrders, schema.receivingLines, schema.poReceipts, schema.receiptReversals,
  schema.vendorInvoices, schema.vendorInvoiceLines, schema.vendorInvoicePoLinks,
  schema.apPayments, schema.apPaymentAllocations,
  schema.inboundFreightCosts, schema.inboundFreightAllocations,
  schema.landedCostSnapshots, schema.landedCostAdjustments, schema.inboundShipmentStatusHistory,
  schema.warehouses, schema.warehouseLocations, schema.warehouseSettings, schema.productLocations, schema.echelonSettings,
  schema.inventoryLevels, schema.inventoryLots, schema.inventoryTransactions,
  schema.orders, schema.orderItems, schema.orderItemCosts,
];

/**
 * One exclusively leased, empty local database. DDL follows the existing real
 * receiving-cost-application harness, plus actual RFQ/command migrations. This
 * is explicitly pre-opening legacy quantity authority: it does not certify an
 * activated quantity ledger, authentication middleware, carriers, or channels.
 */
export async function createFlowCostHarness(url: string) {
  const parsed = new URL(url);
  if (process.env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true"
    || !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url)) {
    throw new Error("FLOW requires a separate explicitly disposable LOCAL database");
  }
  const pool = new pg.Pool({ connectionString: url, max: 10, ssl: false, statement_timeout: 15_000 });
  const ownedSchemas: string[] = [];
  const ownedPublicTables: string[] = [];
  let ownsCommandFunction = false;
  let lease: pg.PoolClient | undefined;
  let restoreModulePool: (() => void) | undefined;

  async function dispose() {
    try {
      for (const name of [...ownedPublicTables].reverse()) await pool.query(`DROP TABLE public.${name} CASCADE`);
      if (ownsCommandFunction) await pool.query("DROP FUNCTION public.guard_financial_command_result_update()");
      for (const name of [...ownedSchemas].reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`);
    } finally {
      restoreModulePool?.();
      if (lease) {
        await lease.query("SELECT pg_advisory_unlock(hashtext('echelon.procurement.controlled-flow'))");
        lease.release();
      }
      await pool.end();
    }
  }

  const priorDatabase = process.env.DATABASE_URL;
  const priorExternal = process.env.EXTERNAL_DATABASE_URL;
  // Some owners still import server/db. Never allow those module imports to
  // initialize a production pool; redirect their SQL to this actual test pool.
  delete process.env.DATABASE_URL;
  delete process.env.EXTERNAL_DATABASE_URL;
  try {
    lease = await pool.connect();
    const lock = await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.controlled-flow')) AS acquired");
    if (!lock.rows[0]?.acquired) throw new Error("Another FLOW test owns this database");
    for (const name of ["catalog", "procurement", "warehouse", "inventory", "wms", "oms"]) {
      // An existing schema is a hard failure. Cleanup drops only owned objects.
      await pool.query(`CREATE SCHEMA ${name}`);
      ownedSchemas.push(name);
    }
    for (const table of TABLES) {
      try { await pool.query(fixtureTable(table)); }
      catch (cause) { throw new Error(`FLOW fixture could not install ${qualifiedTable(table)}`, { cause }); }
    }
    // Migration 130 uses these compound identities; install them before the
    // corresponding schema-declared FK constraints are materialized.
    await pool.query(`
      CREATE UNIQUE INDEX purch_rec_decisions_id_rec_kind_uidx
        ON procurement.purchasing_recommendation_decisions(id,recommendation_id,kind);
      CREATE UNIQUE INDEX purchase_order_lines_po_id_line_id_uidx
        ON procurement.purchase_order_lines(purchase_order_id,id)`);
    for (const foreignKey of fixtureForeignKeys(TABLES)) await pool.query(foreignKey);
    await installPreOpeningQuantityAuthorityFixture(pool);
    await pool.query(`
      CREATE TABLE inventory.availability_runtime_authority (
        singleton_key boolean PRIMARY KEY, authority text, revision bigint, activation_run_id bigint
      );
      INSERT INTO inventory.availability_runtime_authority VALUES(true,'legacy',1,NULL);
      CREATE UNIQUE INDEX product_variants_id_product_uidx ON catalog.product_variants(id,product_id);
      CREATE UNIQUE INDEX flow_po_number_unique ON procurement.purchase_orders(po_number);
      CREATE UNIQUE INDEX flow_po_receipt_unique ON procurement.po_receipts(purchase_order_line_id,receiving_line_id);
      CREATE UNIQUE INDEX flow_inventory_level_unique ON inventory.inventory_levels(product_variant_id,warehouse_location_id);
      CREATE UNIQUE INDEX flow_freight_allocation_unique ON procurement.inbound_freight_allocations(shipment_cost_id,inbound_shipment_line_id);
      CREATE UNIQUE INDEX flow_snapshot_unique ON procurement.landed_cost_snapshots(inbound_shipment_line_id)
        WHERE inbound_shipment_line_id IS NOT NULL;
      CREATE UNIQUE INDEX flow_invoice_po_unique ON procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id);
      CREATE UNIQUE INDEX flow_invoice_number_unique ON procurement.vendor_invoices(vendor_id,invoice_number);
      CREATE TABLE inventory.cost_adjustment_log (
        id SERIAL PRIMARY KEY, lot_id INTEGER NOT NULL, lot_number VARCHAR(50), product_variant_id INTEGER,
        sku VARCHAR(100), old_cost_cents BIGINT, new_cost_cents BIGINT, delta_cents BIGINT,
        reason VARCHAR(100), created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
    for (const name of ["audit_events", "financial_command_results", "financial_command_recoveries"]) {
      const result = await pool.query("SELECT to_regclass($1) AS relation", [`public.${name}`]);
      if (result.rows[0].relation) throw new Error(`FLOW refuses an existing public.${name}`);
    }
    const commandFunction = await pool.query("SELECT to_regprocedure('public.guard_financial_command_result_update()') AS function");
    if (commandFunction.rows[0].function) throw new Error("FLOW refuses an existing financial command guard function");
    await pool.query(fixtureTable(schema.auditEvents));
    ownedPublicTables.push("audit_events");

    const rfqHelper = await import("./rfq-controlled-acceptance-helper");
    for (const migration of [...rfqHelper.RFQ_CONTROLLED_MIGRATIONS,
      "221_receiving_unit_snapshots.sql", "222_procurement_cost_evidence.sql", "231_receipt_cost_recovery.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
      if (migration === "136_financial_command_results.sql") {
        ownedPublicTables.push("financial_command_results");
        ownsCommandFunction = true;
      }
      if (migration === "140_financial_command_operations.sql") ownedPublicTables.push("financial_command_recoveries");
    }
    const database = drizzle(pool, { schema });
    const [receivingModule, purchasingModule, shipmentModule, procurementModule, catalogModule,
      inventoryModule, inventoryRepository, lotModule, cogsModule, ap, databaseModule,
      financialRepository, costCommandsModule, lineCommandsModule, warehouseRepository] = await Promise.all([
      import("../../receiving.service"), import("../../purchasing.service"), import("../../shipment-tracking.service"),
      import("../../procurement.storage"), import("../../../catalog/catalog.storage"),
      import("../../../inventory/application/inventory.use-cases"), import("../../../inventory/infrastructure/inventory.repository"),
      import("../../../inventory/lots.service"), import("../../../inventory/cogs.service"), import("../../ap-ledger.service"),
      import("../../../../db"), import("../../../../platform/commands/command-results.repository"),
      import("../../shipment-cost-commands"), import("../../shipment-line-commands"),
      import("../../../warehouse/infrastructure/warehouse.repository"),
    ]);
    const modulePool = databaseModule.pool;
    const originalQuery = modulePool.query;
    const originalConnect = modulePool.connect;
    restoreModulePool = () => {
      modulePool.query = originalQuery;
      modulePool.connect = originalConnect;
    };
    // No substituted rows: both injected and legacy module-global executors use
    // the same real SQL pool, with the owners' transaction boundaries intact.
    modulePool.query = pool.query.bind(pool) as typeof modulePool.query;
    modulePool.connect = pool.connect.bind(pool) as typeof modulePool.connect;
    const storage = { ...procurementModule.procurementMethods, ...catalogModule.productMethods,
      getSetting: (key: string) => warehouseRepository.getSetting(key, database),
      getAllWarehouseLocations: () => warehouseRepository.getAllWarehouseLocations(database),
      getAllProductLocations: () => warehouseRepository.getAllProductLocations(database),
    };
    const cogs = new cogsModule.COGSService(database);
    const inventoryDatabase = database as unknown as ConstructorParameters<typeof inventoryModule.InventoryUseCases>[0];
    const inventory = new inventoryModule.InventoryUseCases(inventoryDatabase,
      inventoryRepository.createInventoryMethods(database), new lotModule.InventoryLotService(database), cogs, () => FLOW_AT);
    const purchasing = purchasingModule.createPurchasingService(database, storage, {
      now: () => FLOW_AT,
      reconcileApprovedInvoiceCost: (id, tx, actor) => ap.reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(id, tx, actor),
      });
    const shipment = shipmentModule.createShipmentTrackingService(database, storage, cogs, () => FLOW_AT);
    const suppressedChannelSyncs: number[] = [];
    const receiving = new receivingModule.ReceivingService(database, inventory,
      { queueSyncAfterInventoryChange: async (variantId: number) => { suppressedChannelSyncs.push(variantId); } },
      storage, purchasing, shipment, null,
      { reconcilePurchaseOrderLine: (id, tx, actor) => ap.reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(id, tx, actor) },
      null, null, () => FLOW_AT);
    const commandRepository = financialRepository.createDrizzleFinancialCommandRepository(database);
    return { pool, database, storage, cogs, inventory, purchasing, shipment, receiving, ap, rfqHelper,
      costCommands: costCommandsModule.createShipmentCostCommands(shipment, commandRepository, () => FLOW_AT),
      lineCommands: lineCommandsModule.createShipmentLineCommands(shipment, commandRepository, () => FLOW_AT),
      suppressedChannelSyncs, dispose };
  } catch (error) {
    await dispose();
    throw error;
  } finally {
    if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
    if (priorExternal === undefined) delete process.env.EXTERNAL_DATABASE_URL; else process.env.EXTERNAL_DATABASE_URL = priorExternal;
  }
}

export type FlowCostHarness = Awaited<ReturnType<typeof createFlowCostHarness>>;

/** Only master data and an unfulfilled synthetic sales order are inserted. */
export async function seedFlowMasterData(harness: FlowCostHarness) {
  await harness.pool.query(`
    INSERT INTO catalog.products(id,sku,name)
      VALUES(100,'PROC-UAT-FLOW-A','Controlled FLOW product A'),(101,'PROC-UAT-FLOW-B','Controlled FLOW product B');
    INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit,weight_grams)
      VALUES(200,100,'PROC-UAT-FLOW-A-C100','A carton of 100',100,'case',false,1000),
        (201,100,'PROC-UAT-FLOW-A-EACH','A piece',1,'piece',true,10),
        (202,101,'PROC-UAT-FLOW-B-C100','B carton of 100',100,'case',false,1000),
        (203,101,'PROC-UAT-FLOW-B-EACH','B piece',1,'piece',true,10);
    INSERT INTO procurement.vendors(id,code,name,default_lead_time_days)
      VALUES(5,'PROC-UAT-FLOW-VENDOR','Controlled product supplier',30),(6,'PROC-UAT-FLOW-FRT','Controlled freight supplier',30);
    INSERT INTO procurement.vendor_products(id,vendor_id,product_id,product_variant_id,vendor_sku,
      unit_cost_cents,unit_cost_mills,pack_size,moq,lead_time_days,is_preferred,weight_kg)
      VALUES(11,5,100,200,'FLOW-A',200,20000,100,100,30,1,1),
        (12,5,101,202,'FLOW-B',400,40000,100,100,30,1,1);
    INSERT INTO warehouse.warehouses(id,code,name) VALUES(1,'PROC-UAT-FLOW','Controlled local warehouse');
    INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,is_pickable)
      VALUES(99,1,'PROC-UAT-FLOW-X',1),(100,1,'PROC-UAT-FLOW-Y',1);
    INSERT INTO inventory.warehouse_settings(warehouse_code,require_approval) VALUES('DEFAULT',false);
    INSERT INTO wms.orders(id,order_number,customer_name,warehouse_id,total_cents,currency,source)
      VALUES(1,'PROC-UAT-FLOW-SALE','Synthetic acceptance customer',1,30000,'USD','manual');
    INSERT INTO wms.order_items(id,order_id,product_id,sku,name,quantity,unit_price_cents,total_price_cents)
      VALUES(1,1,100,'PROC-UAT-FLOW-A-C100','Synthetic sale of one A carton',1,30000,30000)`);
}
