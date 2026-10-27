import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../../../shared/schema";
import { fixtureColumnDefinitions, fixtureForeignKeys, fixtureTable, qualifiedTable } from "../../../server/modules/procurement/__tests__/integration/shipment-line-fixture";
import { supplierReturnReadFixtureTables } from "../../../server/modules/procurement/__tests__/integration/supplier-return-fixture";

export const CONNECTED_NAVIGATION = {
  purchaseOrderIds: [11, 12], draftPurchaseOrderId: 13, shipmentId: 31, goodsInvoiceId: 71, freightInvoiceId: 72,
  goodsInvoiceCents: 7_500, freightInvoiceCents: 1_500,
} as const;

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), "migrations", name), "utf8");
}

/** Install current owner read schemas, not canned API responses. The quantity
 * fixture starts with an intentionally reduced cost-application placeholder;
 * replace only those proven-empty prerequisites and their empty dependants.
 * This does not claim a full production migration replay or cost-posting UAT. */
export async function installConnectedNavigationFixture(pool: Pool): Promise<void> {
  const tables = [schema.vendorProducts, schema.vendorInvoicePoLinks, schema.vendorInvoiceAttachments,
    schema.apPayments, schema.apPaymentAllocations, schema.poExceptions, schema.poApprovalTiers, schema.poEvents, schema.poRevisions,
    schema.landedCostSnapshots, schema.landedCostAdjustments, schema.inboundShipmentStatusHistory,
    schema.purchasingRecommendationPoHandoffs, schema.requestForQuotes, schema.requestForQuoteLines,
    ...supplierReturnReadFixtureTables.filter(table => table !== schema.supplierReturnLines)];
  for (const table of tables) await pool.query(fixtureTable(table));
  for (const statement of fixtureForeignKeys(tables)) await pool.query(statement);
  for (const table of ["inventory.lot_cost_follow_up_attempts", "inventory.lot_cost_follow_ups", "inventory.cost_applications",
    "inventory.cost_application_lots", "inventory.cost_reporting_events"]) {
    const existing = await pool.query(`SELECT count(*)::int AS count FROM ${table}`);
    if (existing.rows[0]?.count !== 0) throw new Error(`Connected navigation refuses a nonempty prerequisite: ${table}`);
  }
  await pool.query(`DROP TABLE inventory.lot_cost_follow_up_attempts, inventory.lot_cost_follow_ups,
    inventory.cost_application_lots, inventory.cost_reporting_events, inventory.cost_applications`);
  for (const name of ["222_procurement_cost_evidence.sql", "0725_inventory_cost_admission_evidence.sql",
    "900000007000018030001_shipment_cost_exception_decisions.sql",
    "900000008000018110001_shipment_cost_reconciliation.sql",
    "900000009000018290001_historical_cost_origin_repairs.sql", "231_receipt_cost_recovery.sql", "227_purchase_order_history_retention.sql"]) await pool.query(migration(name));
  for (const table of ["cost_applications", "cost_application_lots", "cost_reporting_events"]) {
    await pool.query(`CREATE TRIGGER aa_cutover_writer_admission BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON inventory.${table}
      FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission()`);
  }
  await pool.query(`CREATE UNIQUE INDEX connected_po_number_identity ON procurement.purchase_orders(po_number);
    CREATE UNIQUE INDEX connected_po_line_identity ON procurement.purchase_order_lines(purchase_order_id,id);
    CREATE UNIQUE INDEX connected_invoice_po_identity ON procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id);
    CREATE UNIQUE INDEX connected_payment_invoice_identity ON procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id)`);

  // Purchase workspaces read the exact RFQ origin even when no quote links
  // exist. Install those immutable evidence owners from the real migration;
  // the full RFQ command lifecycle remains in its own integration suites.
  const rfqMigration = migration("224_rfq_quote_revisions_and_purchase_links.sql");
  const rfqStart = rfqMigration.indexOf("CREATE TABLE procurement.rfq_quote_revisions (");
  const rfqEnd = rfqMigration.indexOf("-- Preserve the allocation guard", rfqStart);
  if (rfqStart < 0 || rfqEnd < rfqStart) throw new Error("Connected RFQ evidence migration boundary changed");
  await pool.query(rfqMigration.slice(rfqStart, rfqEnd));
  // Dashboard reads execute their actual recommendation, pipeline and history
  // owners. These are empty synthetic planning histories, not precomputed KPIs.
  const planningTables = [schema.reorderExclusionRules, schema.productLines, schema.productLineProducts,
    schema.autoDraftRuns, schema.purchaseRecommendationRuns, schema.purchaseRecommendationLines,
    schema.purchaseForecastObservations, schema.purchaseForecastEvaluations, schema.purchasePipelineJobRuns,
    schema.purchasingRecommendationDecisions, schema.supplierSourcingRevisions];
  for (const table of planningTables) {
    const name = qualifiedTable(table);
    if ((await pool.query("SELECT to_regclass($1) AS relation", [name])).rows[0].relation) {
      throw new Error("Connected planning fixture requires an uninstalled owner: " + name);
    }
    await pool.query(fixtureTable(table));
  }
  for (const statement of fixtureForeignKeys(planningTables)) await pool.query(statement);
  // Quantity-ledger prerequisites intentionally omit legacy demand-only fields.
  // Add only the exact current schema columns queried by the recommendation owner.
  for (const [table, names] of [
    [schema.orders, ["cancelled_at", "order_placed_at", "created_at", "updated_at"]],
    [schema.orderItems, ["paid_price_cents", "total_price_cents"]],
    [schema.omsOrderLines, ["paid_price_cents", "total_price_cents", "coupon_discount_cents"]],
  ] as const) {
    const definition = getTableConfig(table);
    const existing = new Set((await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
      [definition.schema ?? "public", definition.name])).rows.map(row => row.column_name));
    for (const column of fixtureColumnDefinitions(table).filter(column => (names as readonly string[]).includes(column.name))) {
      if (!existing.has(column.name)) await pool.query("ALTER TABLE " + qualifiedTable(table) + " ADD COLUMN " + column.definition);
    }
  }
  const legacySettings = migration("052_purchasing_dashboard.sql").match(/ALTER TABLE warehouse_settings[\s\S]*?;/g);
  if (legacySettings?.length !== 1) throw new Error("Connected dashboard settings migration boundary changed");
  await pool.query(legacySettings[0].replace("ALTER TABLE warehouse_settings", "ALTER TABLE inventory.warehouse_settings"));
  await pool.query(migration("226_purchase_supplier_progress.sql"));
  await pool.query(migration("223_purchase_planning_policy.sql"));

  // Two product POs share the goods invoice with exact line ownership. Freight
  // has its own invoice: assigning a freight line to a multi-PO goods document
  // would correctly require financial ownership review. Neither invoice has
  // payment, credit, receipt, allocation or cost-posting evidence fabricated.
  await pool.query(`
    INSERT INTO procurement.vendors(id,code,name,currency) VALUES
      (5,'CONNECTED-GOODS','Connected goods supplier','USD'),(6,'CONNECTED-FREIGHT','Connected freight supplier','USD');
    INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,warehouse_id,status,physical_status,financial_status,
      subtotal_cents,total_cents,line_count,invoiced_total_cents,outstanding_cents,created_by,sent_to_vendor_at,vendor_ack_date,first_shipped_at,first_invoiced_at)
    VALUES(11,'CONNECTED-PO-A',5,1,'acknowledged','in_transit','invoiced',2500,2500,1,2500,2500,'connected-receiver',
        '2026-10-20 12:00:00','2026-10-21 12:00:00','2026-10-24 12:00:00','2026-10-24 12:00:00'),
      (12,'CONNECTED-PO-B',5,1,'acknowledged','in_transit','invoiced',5000,5000,1,5000,5000,'connected-receiver',
        '2026-10-20 12:00:00','2026-10-21 12:00:00','2026-10-24 12:00:00','2026-10-24 12:00:00');
    INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,warehouse_id,status,physical_status,financial_status,
      subtotal_cents,total_cents,line_count,created_by)
    VALUES(13,'CONNECTED-DRAFT-PO',5,1,'draft','draft','unbilled',0,0,0,'connected-receiver');
    INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,line_type,status,product_id,product_variant_id,
      expected_receive_variant_id,expected_receive_units_per_variant,sku,product_name,order_qty,unit_cost_cents,unit_cost_mills,line_total_cents,total_product_cost_cents,
      pricing_basis,pricing_source,quoted_unit_cost_mills)
    VALUES(21,11,1,'product','open',20,101,101,5,'PACK','Connected five-piece case',25,100,10000,2500,2500,'per_piece','manual',10000),
      (22,12,1,'product','open',20,101,101,5,'PACK','Connected five-piece case',50,100,10000,5000,5000,'per_piece','manual',10000);
    INSERT INTO procurement.inbound_shipments(id,shipment_number,status,mode,warehouse_id,total_pieces,total_cartons,
      actual_total_cost_cents,allocation_method_default,ship_date,created_by)
    VALUES(31,'CONNECTED-SHIPMENT','in_transit','ocean',1,75,15,1500,'by_value','2026-10-24 12:00:00','connected-receiver');
    INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,
      product_variant_id,sku,qty_shipped,units_per_variant_snapshot,carton_count)
    VALUES(41,31,11,21,101,'P5',25,5,5),(42,31,12,22,101,'P5',50,5,10);
    INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,inbound_shipment_id,status,invoice_date,received_date,due_date,
      approved_at,approved_by,invoiced_amount_cents,balance_cents,currency,created_by)
    VALUES(71,'CONNECTED-GOODS-INVOICE',5,NULL,'approved','2026-10-24 12:00:00','2026-10-24 12:00:00','2026-11-24 12:00:00',
      '2026-10-24 12:00:00','connected-admin',7500,7500,'USD','connected-receiver'),
      (72,'CONNECTED-FREIGHT-INVOICE',6,31,'approved','2026-10-24 12:00:00','2026-10-24 12:00:00','2026-11-24 12:00:00',
      '2026-10-24 12:00:00','connected-admin',1500,1500,'USD','connected-receiver');
    INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id,allocated_amount_cents)
    VALUES(71,11,2500),(71,12,5000);
    INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,description,actual_cents,currency,allocation_method,cost_status,
      vendor_id,vendor_invoice_id,invoice_number,invoice_date)
    VALUES(61,31,'freight','Connected freight charge',1500,'USD','by_value','confirmed',6,72,'CONNECTED-FREIGHT-INVOICE','2026-10-24 12:00:00');
    INSERT INTO procurement.vendor_invoice_lines(vendor_invoice_id,purchase_order_line_id,product_variant_id,line_number,sku,product_name,
      qty_invoiced,qty_ordered,qty_received,unit_cost_cents,unit_cost_mills,line_total_cents,match_status)
    VALUES(71,21,101,1,'PACK','Connected five-piece case',25,25,0,100,10000,2500,'pending'),
      (71,22,101,2,'PACK','Connected five-piece case',50,50,0,100,10000,5000,'pending');
    INSERT INTO procurement.vendor_invoice_lines(vendor_invoice_id,freight_cost_id,line_number,description,qty_invoiced,
      unit_cost_cents,unit_cost_mills,line_total_cents,match_status)
    VALUES(72,61,1,'Connected freight charge',1,1500,150000,1500,'matched');
  `);
}

export async function readConnectedNavigationState(pool: Pool) {
  const result = await pool.query(`SELECT
    (SELECT count(*)::int FROM procurement.purchase_orders) AS "purchaseOrderCount",
    (SELECT count(*)::int FROM procurement.inbound_shipments) AS "shipmentCount",
    (SELECT count(*)::int FROM procurement.vendor_invoices) AS "invoiceCount",
    (SELECT jsonb_agg(to_jsonb(po) ORDER BY id) FROM procurement.purchase_orders po WHERE id IN (11,12,13)) AS "purchaseOrders",
    (SELECT to_jsonb(shipment) FROM procurement.inbound_shipments shipment WHERE id=31) AS shipment,
    (SELECT jsonb_agg(to_jsonb(line) ORDER BY id) FROM procurement.inbound_shipment_lines line WHERE inbound_shipment_id=31) AS "shipmentLines",
    (SELECT jsonb_agg(to_jsonb(cost) ORDER BY id) FROM procurement.inbound_freight_costs cost WHERE inbound_shipment_id=31) AS "freightCosts",
    (SELECT coalesce(jsonb_agg(to_jsonb(allocation) ORDER BY id),'[]'::jsonb) FROM procurement.inbound_freight_allocations allocation) AS "freightAllocations",
    (SELECT jsonb_agg(to_jsonb(invoice) ORDER BY id) FROM procurement.vendor_invoices invoice WHERE id IN (71,72)) AS invoices,
    (SELECT jsonb_agg(to_jsonb(line) ORDER BY id) FROM procurement.vendor_invoice_lines line WHERE vendor_invoice_id IN (71,72)) AS "invoiceLines",
    (SELECT jsonb_agg(to_jsonb(link) ORDER BY id) FROM procurement.vendor_invoice_po_links link WHERE vendor_invoice_id=71) AS "invoicePoLinks",
    (SELECT count(*)::int FROM procurement.ap_payments) AS payments,
    (SELECT coalesce(jsonb_agg(to_jsonb(allocation) ORDER BY id),'[]'::jsonb) FROM procurement.ap_payment_allocations allocation) AS "paymentAllocations",
    (SELECT count(*)::int FROM procurement.supplier_credits) AS "supplierCredits",
    (SELECT count(*)::int FROM procurement.supplier_credit_applications) AS "supplierCreditApplications",
    (SELECT count(*)::int FROM procurement.supplier_credit_application_reversals) AS "supplierCreditApplicationReversals",
    (SELECT coalesce(jsonb_agg(to_jsonb(document) ORDER BY id),'[]'::jsonb) FROM procurement.supplier_returns document) AS "supplierReturns",
    (SELECT coalesce(jsonb_agg(to_jsonb(line) ORDER BY id),'[]'::jsonb) FROM procurement.supplier_return_lines line) AS "supplierReturnLines",
    (SELECT jsonb_agg(to_jsonb(level) ORDER BY id) FROM inventory.inventory_levels level) AS "inventoryLevels",
    (SELECT count(*)::int FROM inventory.quantity_commands) AS "quantityCommands",
    (SELECT count(*)::int FROM inventory.quantity_entries) AS "quantityEntries",
    (SELECT count(*)::int FROM inventory.cost_applications) AS "costApplications",
    (SELECT count(*)::int FROM public.auto_draft_runs) AS "autoDraftRuns",
    (SELECT count(*)::int FROM procurement.purchase_pipeline_job_runs) AS "purchasePipelineJobRuns"`);
  return result.rows[0];
}
