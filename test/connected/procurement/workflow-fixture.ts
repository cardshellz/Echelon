import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import * as schema from "../../../shared/schema";
import { supplierReturnReadFixtureTables, installSupplierReturnCompletionFixture } from "../../../server/modules/procurement/__tests__/integration/supplier-return-fixture";
import { qualifiedTable } from "../../../server/modules/procurement/__tests__/integration/shipment-line-fixture";

/** Upgrade only proven-empty read placeholders in this newly owned database.
 * The actual payment/credit/return constraints remain active during every UI command. */
export async function installConnectedWorkflowFixture(pool: Pool): Promise<void> {
  const empty = [...new Set([...supplierReturnReadFixtureTables, schema.supplierCreditApplications,
    schema.supplierCreditApplicationReversals, schema.supplierCreditLines, schema.supplierCredits].map(qualifiedTable))];
  for (const table of [...empty, "procurement.ap_payments", "procurement.ap_payment_allocations"]) {
    const count = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
    if (count.rows[0]?.count !== 0) throw new Error("Connected workflow refuses a nonempty prerequisite: " + table);
  }
  // No CASCADE: an unexpected dependent owner must fail setup visibly.
  await pool.query(`DROP TABLE ${empty.join(",")}`);
  await pool.query(`CREATE UNIQUE INDEX ap_payments_payment_number_active_uidx ON procurement.ap_payments(payment_number) WHERE voided_at IS NULL`);
  for (const name of ["0751_exact_inventory_cost_totals.sql", "157_procurement_usd_financial_authority.sql",
    "900000016000018570001_ap_payment_balance_completion.sql",
    "900000017000018610001_supplier_credit_completion.sql"]) {
    await pool.query(readFileSync(resolve(process.cwd(), "migrations", name), "utf8"));
  }
  await installSupplierReturnCompletionFixture(pool);
  // Legacy runtime DDL in server/db.ts, with bigint money from migration 0576;
  // the AP owner still appends this audit alongside immutable cost evidence.
  await pool.query(`CREATE TABLE inventory.cost_adjustment_log (
    id SERIAL PRIMARY KEY,lot_id INTEGER NOT NULL,lot_number VARCHAR(50),product_variant_id INTEGER,
    sku VARCHAR(100),old_cost_cents BIGINT,new_cost_cents BIGINT,delta_cents BIGINT,
    reason VARCHAR(100),created_at TIMESTAMP NOT NULL DEFAULT NOW())`);
  // The existing administrator retains explicit current permissions, rather
  // than relying on the session role label to authorize financial commands.
  await pool.query(`INSERT INTO identity.auth_permissions(id,resource,action,category)
    VALUES(10,'purchasing','approve','purchasing'),(11,'inventory','receive','inventory');
    INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(3,8),(3,9),(3,10),(9,10),(3,11),(9,11);
    UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=jsonb_build_object(
      'contractVersion',1,'packagingTreatment','separate','productMills',line_total_cents*100,
      'packagingMills',0,'adjustmentMills',0,'source','operator_review') WHERE purchase_order_line_id IS NOT NULL;
    INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,warehouse_id,status,physical_status,financial_status,
      subtotal_cents,total_cents,line_count,created_by,sent_to_vendor_at,vendor_ack_date)
      VALUES(14,'CONNECTED-SETUP-PO',5,1,'acknowledged','acknowledged','unbilled',10000,10000,1,'connected-admin',
        '2026-10-20 12:00:00','2026-10-21 12:00:00');
    INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,line_type,status,product_id,product_variant_id,
      expected_receive_variant_id,expected_receive_units_per_variant,sku,product_name,order_qty,unit_cost_cents,unit_cost_mills,
      line_total_cents,total_product_cost_cents,pricing_basis,pricing_source,quoted_unit_cost_mills)
      VALUES(23,14,1,'product','open',20,101,101,5,'PACK','Connected five-piece case',100,100,10000,10000,10000,'per_piece','manual',10000)`);
}

/** Persisted physical/financial/command evidence for connected assertions, never API substitutes. */
export async function readConnectedWorkflowState(pool: Pool) {
  return (await pool.query(`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.receipt_invoice_cost_allocations t) AS "receiptInvoiceAllocations",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.audit_events t WHERE action='procurement.receipt_invoice_costs.approved') AS "receiptInvoiceApprovals",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.receipt_cost_requests t) AS "receiptCostRequests",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.receipt_cost_attempts t) AS "receiptCostAttempts",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.purchase_orders t) AS "purchaseOrders",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.purchase_order_lines t) AS "purchaseLines",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.receiving_lines t) AS "receivingLines",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.supplier_credit_application_reversals t) AS "creditReversals",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.ap_payments t) AS payments,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.ap_payment_allocations t) AS "paymentAllocations",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.supplier_credits t) AS credits,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.supplier_credit_applications t) AS "creditApplications",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.supplier_returns t) AS returns,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.supplier_return_lines t) AS "returnLines",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory.supplier_return_cost_entries t) AS "returnCosts",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.vendor_invoices t) AS invoices,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.purchase_tax_types t) AS "taxTypes",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.vendor_invoice_line_taxes t) AS "invoiceTaxes",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.audit_events t WHERE action='procurement.tax.approved') AS "taxApprovals",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.inbound_shipments t) AS shipments,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.inbound_shipment_lines t) AS "shipmentLines",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM procurement.receiving_orders t) AS receipts,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory.inventory_transactions t) AS transactions,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory.inventory_lots t) AS lots,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory.quantity_commands t) AS "quantityCommands",
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY idempotency_key),'[]'::jsonb) FROM public.financial_command_results t) AS commands`)).rows[0];
}

/** Synthetic scenario only, called through the loopback child's token-guarded
 * control endpoint before any receipt exists. No production server imports it. */
export async function seedReceiptInvoiceWorkflow(pool: Pool): Promise<void> {
  if ((await pool.query("SELECT count(*)::int AS count FROM procurement.receiving_orders WHERE purchase_order_id=11")).rows[0].count !== 0)
    throw new Error("Receipt invoice scenario requires an untouched synthetic PO");
  await pool.query(`UPDATE procurement.purchase_order_lines SET order_qty=50,total_product_cost_cents=5000,line_total_cents=5000,receipt_costing_enabled=1 WHERE id=21;
    UPDATE procurement.purchase_orders SET subtotal_cents=5000,total_cents=5000,invoiced_total_cents=5500,outstanding_cents=5500 WHERE id=11;
    UPDATE procurement.vendor_invoice_lines SET qty_ordered=50 WHERE purchase_order_line_id=21;
    INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,balance_cents,currency,approved_at,approved_by)
      VALUES(81,'CONNECTED-SECOND-BATCH',5,'approved',3000,3000,'USD','2026-10-24 12:00:00','connected-admin');
    INSERT INTO procurement.vendor_invoice_lines(vendor_invoice_id,purchase_order_line_id,product_variant_id,line_number,sku,product_name,
      qty_invoiced,qty_ordered,qty_received,unit_cost_cents,unit_cost_mills,line_total_cents,cost_component_evidence)
      VALUES(81,21,101,1,'PACK','Connected five-piece case',25,50,0,120,12000,3000,
      '{"contractVersion":1,"source":"operator_review","packagingTreatment":"included_in_product","productMills":300000,"packagingMills":0,"adjustmentMills":0}');
    INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id,allocated_amount_cents) VALUES(81,11,3000);
    INSERT INTO procurement.inbound_shipments(id,shipment_number,status,mode,warehouse_id,total_pieces,total_cartons,allocation_method_default,created_by)
      VALUES(32,'CONNECTED-SECOND-SHIPMENT','in_transit','ocean',1,25,5,'by_value','connected-receiver');
    INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,sku,qty_shipped,units_per_variant_snapshot,carton_count)
      VALUES(43,32,11,21,101,'P5',25,5,5)`);
}
