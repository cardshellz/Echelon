import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { AmendmentDatabase } from "../../po-quantity-amendment.repository";
import type { ShipmentTrackingService } from "../../shipment-tracking.service";
import { recordPurchaseCostRevisions } from "../../purchase-cost-application.service";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import { readPoShipmentCosts, type PoShipmentCostSummaryDatabase } from "../../po-shipment-cost-summary.repository";

const PO_ID = 10;
const PO_LINE_ID = 21;
const SHIPMENT_ID = 1;
const FREIGHT_INVOICE_ID = 73;
const FREIGHT_CENTS = 5_000;

/** Uses the real receiving/AP/allocation/revision/application owners in the
 * parent suite's exclusively owned local database. No financial result is mocked. */
export function registerCostSourceCompatibilityCases(fixture: {
  pool: () => pg.Pool;
  database: () => AmendmentDatabase & PoShipmentCostSummaryDatabase;
  shipment: () => ShipmentTrackingService;
  receive: () => Promise<unknown>;
  approveSupplier: () => Promise<unknown>;
  retrySupplier: () => Promise<unknown>;
  actorId: string;
  at: Date;
}): void {
  const query = (text: string, values?: unknown[]) => fixture.pool().query(text, values);
  async function supplierStatus() {
    return fixture.database().transaction(tx => readPurchaseCostStatus(tx, [PO_LINE_ID]),
      { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function snapshot() {
    const tables = ["procurement.cost_source_revisions", "inventory.cost_applications", "inventory.cost_application_lots",
      "inventory.cost_reporting_events", "inventory.cost_reconciliation_approvals", "inventory.cost_reconciliation_postings",
      "inventory.inventory_lots", "oms.order_item_costs", "procurement.receiving_lines", "procurement.po_receipts"] as const;
    return Promise.all(tables.map(async table => ({ table,
      rows: (await query(`SELECT to_jsonb(record) AS value FROM ${table} record ORDER BY to_jsonb(record)::text`)).rows })));
  }
  async function postSupplierAndFreight() {
    await fixture.receive();
    await fixture.approveSupplier();
    await fixture.shipment().finalizeAllocations(SHIPMENT_ID, fixture.actorId);
    await fixture.shipment().pushLandedCostsToLots(SHIPMENT_ID, fixture.actorId);
    await query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=$1", [SHIPMENT_ID]);
    const status = await supplierStatus();
    expect(status.lines[0].components.every(component => component.status === "applied")).toBe(true);
    return status;
  }
  async function linkApprovedFreightInvoice() {
    // Synthetic source setup. The payment transition below uses the actual AP
    // owner, which derives statuses from recorded cash allocations and balances.
    await query(`INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,inbound_shipment_id,
      status,currency,invoiced_amount_cents,balance_cents) VALUES($1,'COMPAT-FREIGHT',5,$2,'approved','USD',$3,$3)`,
    [FREIGHT_INVOICE_ID, SHIPMENT_ID, FREIGHT_CENTS]);
    await query(`INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,freight_cost_id,
      qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents) VALUES(74,$1,1,31,1,$2,$3,$2)`,
    [FREIGHT_INVOICE_ID, FREIGHT_CENTS, FREIGHT_CENTS * 100]);
    await query("UPDATE procurement.inbound_freight_costs SET vendor_id=5,vendor_invoice_id=$1,cost_status='invoiced' WHERE id=31", [FREIGHT_INVOICE_ID]);
    await fixture.shipment().pushLandedCostsToLots(SHIPMENT_ID, fixture.actorId);
  }
  async function payFreight(amount: number) {
    const { recordPayment } = await import("../../ap-ledger.service");
    return recordPayment({ vendorId: 5, currency: "USD", status: "completed", totalAmountCents: amount,
      paymentDate: fixture.at, paymentMethod: "wire", createdBy: fixture.actorId,
      allocations: [{ vendorInvoiceId: FREIGHT_INVOICE_ID, appliedAmountCents: amount }] }, { now: fixture.at });
  }

  describe("recorded cost source compatibility through real owners", () => {
    it("keeps original supplier revisions, applications and approval details after a superseded quote edit", async () => {
      const originalStatus = await postSupplierAndFreight(), original = await snapshot();
      const originalHealth = (await fixture.shipment().getLandedCostHealth()).items;
      await query("UPDATE procurement.purchase_order_lines SET total_product_cost_cents=22000,packaging_cost_cents=2300,tax_cents=30,discount_cents=20 WHERE id=$1", [PO_LINE_ID]);
      expect(await supplierStatus()).toEqual(originalStatus);
      expect((await fixture.shipment().getCostReview(SHIPMENT_ID))?.supplierCosts).toEqual(originalStatus);
      expect((await readPoShipmentCosts(fixture.database(), PO_ID))?.supplierCosts).toEqual(originalStatus);
      expect((await fixture.shipment().getLandedCostHealth()).items).toEqual(originalHealth);
      await fixture.retrySupplier(); await fixture.retrySupplier();
      expect(await snapshot()).toEqual(original);
      expect((await query("SELECT total_product_cost_cents FROM procurement.purchase_order_lines WHERE id=$1", [PO_LINE_ID])).rows[0].total_product_cost_cents).toBe("22000");
    });

    it("uses actual AP payments without reopening unchanged freight postings or rewriting their invoice evidence", async () => {
      await postSupplierAndFreight(); await linkApprovedFreightInvoice();
      const original = await snapshot();
      const originalReview = await fixture.shipment().getCostReview(SHIPMENT_ID);
      const originalHealth = (await fixture.shipment().getLandedCostHealth()).items;
      for (const [amount, status] of [[2_000, "partially_paid"], [3_000, "paid"]] as const) {
        await payFreight(amount);
        expect((await query("SELECT status FROM procurement.vendor_invoices WHERE id=$1", [FREIGHT_INVOICE_ID])).rows[0].status).toBe(status);
        const review = await fixture.shipment().getCostReview(SHIPMENT_ID);
        expect(review?.lines[0]).toEqual(originalReview?.lines[0]);
        expect((await fixture.shipment().getLandedCostHealth()).items).toEqual(originalHealth);
        const reapplied = await fixture.shipment().pushLandedCostsToLots(SHIPMENT_ID, fixture.actorId);
        expect(reapplied.costApplications.every(application => application.replayed)).toBe(true);
        expect(await snapshot()).toEqual(original);
      }
      expect((await query("SELECT paid_amount_cents,balance_cents FROM procurement.vendor_invoices WHERE id=$1", [FREIGHT_INVOICE_ID])).rows[0])
        .toEqual({ paid_amount_cents: "5000", balance_cents: "0" });
      expect((await query("SELECT count(*)::int AS count FROM procurement.ap_payments")).rows[0].count).toBe(2);
    });

    it("serializes concurrent retries of an unchanged confirmed supplier source without a new revision", async () => {
      await postSupplierAndFreight(); const original = await snapshot();
      const before = await fixture.database().transaction(tx => recordPurchaseCostRevisions(tx, PO_LINE_ID, fixture.actorId, fixture.at));
      await query("UPDATE procurement.purchase_order_lines SET total_product_cost_cents=25000 WHERE id=$1", [PO_LINE_ID]);
      const results = await Promise.all([1, 2].map(() => fixture.database()
        .transaction(tx => recordPurchaseCostRevisions(tx, PO_LINE_ID, fixture.actorId, fixture.at))));
      expect(results.map(rows => rows.map(row => row.id))).toEqual([before.map(row => row.id), before.map(row => row.id)]);
      expect(await snapshot()).toEqual(original);
    });

    it("keeps a real invoice amount change visible and records its new source once under concurrent retry", async () => {
      await postSupplierAndFreight();
      const before = await fixture.database().transaction(tx => recordPurchaseCostRevisions(tx, PO_LINE_ID, fixture.actorId, fixture.at));
      const originalSources = (await query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows;
      await query(`UPDATE procurement.vendor_invoice_lines SET line_total_cents=line_total_cents+1,
        cost_component_evidence=jsonb_set(cost_component_evidence,'{productMills}',to_jsonb((cost_component_evidence->>'productMills')::bigint+100)) WHERE id=72`);
      const status = await supplierStatus();
      expect(status.lines[0].components.every(component => component.sourceCurrent === false)).toBe(true);
      const results = await Promise.all([1, 2].map(() => fixture.database()
        .transaction(tx => recordPurchaseCostRevisions(tx, PO_LINE_ID, fixture.actorId, fixture.at))));
      expect(results[0].map(row => row.id)).toEqual(results[1].map(row => row.id));
      expect(results[0].map(row => row.id)).not.toEqual(before.map(row => row.id));
      expect((await query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows.slice(0, originalSources.length)).toEqual(originalSources);
      expect(results[0].find(row => row.contract.component === "product")?.contract.totalMills)
        .toBe(before.find(row => row.contract.component === "product")!.contract.totalMills! + 100);
    });

    it("does not hide a changed source currency or an actual cost mismatch", async () => {
      await postSupplierAndFreight(); const original = await snapshot();
      await query("UPDATE procurement.vendor_invoices SET currency='CAD' WHERE id=71");
      const status = await supplierStatus();
      expect(status.lines[0].components.every(component => component.status === "review_required")).toBe(true);
      expect(status.lines[0].components.some(component => component.issues.some(issue => issue.code === "COST_CURRENCY_REVIEW"))).toBe(true);
      expect(await snapshot()).toEqual(original);
    });

    it("keeps a real lot cost mismatch visible even when the supplier source is financially equivalent", async () => {
      await postSupplierAndFreight();
      await query("UPDATE procurement.purchase_order_lines SET total_product_cost_cents=25000 WHERE id=$1", [PO_LINE_ID]);
      await query("UPDATE inventory.inventory_lots SET po_unit_cost_mills=po_unit_cost_mills+1");
      const before = await snapshot(), status = await supplierStatus();
      const product = status.lines[0].components.find(component => component.component === "product")!;
      expect(product.sourceCurrent).toBe(true);
      expect(product.status).toBe("review_required");
      expect(product.issues.some(issue => issue.code === "COST_COMPONENT_CHANGED")).toBe(true);
      expect(await snapshot()).toEqual(before);
    });
  });
}
