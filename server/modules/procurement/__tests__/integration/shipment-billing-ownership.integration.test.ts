import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vendorInvoiceAttachments } from "@shared/schema";
import { readInvoiceSourceCapabilities } from "../../shipment-billing-ownership.repository";
import { readInvoiceReplacementDetail, replaceVoidedInvoiceInTransaction } from "../../ap-invoice-replacement.service";
import { fixtureTable } from "./shipment-line-fixture";
import { createFlowCostHarness, seedFlowMasterData, FLOW_ACTOR, FLOW_AT, type FlowCostHarness } from "./procurement-flow-cost.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const integration = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
integration.sequential("shipment charge billing ownership through real PostgreSQL owners", () => {
  let harness: FlowCostHarness;
  beforeEach(async () => {
    harness = await createFlowCostHarness(url!);
    await harness.pool.query(fixtureTable(vendorInvoiceAttachments));
    await harness.pool.query(readFileSync(resolve(process.cwd(), "migrations/900000006000017980001_invoice_replacement_lineage.sql"), "utf8"));
    await seedFlowMasterData(harness);
    await harness.pool.query(`INSERT INTO procurement.inbound_shipments(id,shipment_number,status,allocation_method_default,warehouse_id)
      VALUES(1,'OWNERSHIP-SHIP','costing','by_line_count',1);
      INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,actual_cents,currency,exchange_rate,vendor_id,cost_status)
      VALUES(31,1,'freight',1000,'USD',1,6,'finalized')`);
  });
  afterEach(async () => { await harness?.dispose(); });
  async function bill(number = "BILL-1") {
    return harness.ap.createInvoiceFromShipmentCosts(1, { vendorId: 6, invoiceNumber: number, costRowIds: [31], invoiceDate: FLOW_AT }, FLOW_ACTOR);
  }
  async function manual(number = "MANUAL", amount = 1000) {
    const invoice = await harness.ap.createInvoice({ vendorId: 6, invoiceNumber: number, invoiceDate: FLOW_AT, createdBy: FLOW_ACTOR });
    const line = await harness.ap.addInvoiceLine(invoice.id, { description: "Explicit shipment bill line", qtyInvoiced: 1, unitCostMills: amount * 100 }, FLOW_ACTOR);
    return { invoice, line };
  }
  async function snapshot() {
    return Promise.all(["vendor_invoices", "vendor_invoice_lines", "inbound_freight_costs", "vendor_invoice_po_links"].map(async table =>
      (await harness.pool.query(`SELECT * FROM procurement.${table} ORDER BY id`)).rows));
  }
  async function lineId(invoiceId: number) {
    return (await harness.pool.query("SELECT id FROM procurement.vendor_invoice_lines WHERE vendor_invoice_id=$1", [invoiceId])).rows[0].id as number;
  }
  it("creates one owner and uses it consistently for candidates, charge label, payment and invoice totals", async () => {
    expect((await harness.ap.listCostsForInvoiceCreation(1, 6))[0].billingOwnership.state).toBe("unbilled");
    const invoice = await bill();
    expect(await harness.ap.listCostsForInvoiceCreation(1, 6)).toEqual([]);
    expect((await harness.ap.getCostVendorsForShipment(1)).vendors).toEqual([]);
    expect((await harness.ap.enrichCostsWithInvoiceInfo(1))[0]).toMatchObject({ derivedStatus: "invoiced", billingOwnership: { state: "billed", activeInvoiceId: invoice.id } });
    expect((await harness.ap.getShipmentCostPaymentStatus(1)).summary).toMatchObject({ totalCents: 1000, paidCents: 0, outstandingCents: 1000 });
    expect((await harness.ap.getShipmentInvoicesSummary(1)).summary.totalInvoicedCents).toBe(1000);
  });
  it("does not silently create a zero invoice when a charge has no recorded amount", async () => {
    await harness.pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=NULL,estimated_cents=NULL WHERE id=31");
    const before = await snapshot();
    await expect(bill()).rejects.toMatchObject({ statusCode: 422, details: { code: "AP_SHIPMENT_COST_AMOUNT_REQUIRED" } });
    expect(await snapshot()).toEqual(before);
  });
  it("retains an explicitly entered zero invoice amount when the charge amount is unknown", async () => {
    await harness.pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=NULL,estimated_cents=NULL WHERE id=31");
    const invoice = await harness.ap.createInvoiceFromShipmentCosts(1, { vendorId: 6, invoiceNumber: "EXPLICIT-ZERO",
      costRowIds: [31], invoiceDate: FLOW_AT, lineOverrides: [{ freightCostId: 31, qtyInvoiced: 1, unitCostMills: 0 }] }, FLOW_ACTOR);
    expect(invoice.invoicedAmountCents).toBe(0);
    expect((await harness.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership).toMatchObject({ state: "billed", activeInvoiceId: invoice.id });
    expect((await harness.pool.query("SELECT actual_cents,estimated_cents FROM procurement.inbound_freight_costs WHERE id=31")).rows[0]).toEqual({ actual_cents: null, estimated_cents: null });
  });
  it("rejects unlink, generic source deletion and second billing without changing original evidence", async () => {
    const invoice = await bill(), before = await snapshot();
    await expect(harness.ap.unlinkCostFromInvoice(31, FLOW_ACTOR)).rejects.toMatchObject({ statusCode: 409, details: { code: "AP_SHIPMENT_INVOICE_SOURCE_IMMUTABLE" } });
    await expect(harness.ap.removeInvoiceLine(await lineId(invoice.id), FLOW_ACTOR)).rejects.toMatchObject({ statusCode: 409, details: { code: "AP_SHIPMENT_INVOICE_SOURCE_IMMUTABLE" } });
    await expect(bill("BILL-2")).rejects.toMatchObject({ statusCode: 409 });
    expect(await snapshot()).toEqual(before);
  });
  it("rejects PO link/import/unlink on charge invoices before changing source economics", async () => {
    const invoice = await bill(), before = await snapshot();
    for (const operation of [() => harness.ap.linkPoToInvoice(invoice.id, 999, undefined, undefined, FLOW_ACTOR),
      () => harness.ap.unlinkPoFromInvoice(invoice.id, 999, FLOW_ACTOR), () => harness.ap.importLinesFromPO(invoice.id, 999, FLOW_ACTOR)]) {
      await expect(operation()).rejects.toMatchObject({ statusCode: 409, details: { code: "AP_INVOICE_SHIPMENT_SOURCE_OWNED" } });
    }
    expect(await snapshot()).toEqual(before);
  });
  it("detects orphan source lines even when the header pointer was historically cleared", async () => {
    const invoice = await bill();
    await harness.pool.query("UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=NULL WHERE id=31");
    expect(await harness.ap.listCostsForInvoiceCreation(1, 6)).toEqual([]);
    await expect(bill("BILL-2")).rejects.toMatchObject({ statusCode: 409 });
    expect((await harness.ap.enrichCostsWithInvoiceInfo(1))[0]).toMatchObject({ derivedStatus: "review_required", billingOwnership: { state: "review_required" } });
    await expect(harness.ap.getShipmentCostPaymentStatus(1)).rejects.toMatchObject({ statusCode: 409 });
    await expect(harness.ap.getShipmentInvoicesSummary(1)).rejects.toMatchObject({ statusCode: 409 });
    await expect(harness.ap.approveInvoice(invoice.id, FLOW_ACTOR)).rejects.toMatchObject({ statusCode: 409, details: { code: "AP_INVOICE_BILLING_REVIEW_REQUIRED" } });
  });
  it("retains pointer-only association as review until an exact line is selected", async () => {
    const { invoice, line } = await manual();
    await harness.pool.query("UPDATE procurement.inbound_freight_costs SET vendor_invoice_id=$1,cost_status='invoiced' WHERE id=31", [invoice.id]);
    expect((await harness.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership.state).toBe("review_required");
    await expect(harness.ap.unlinkCostFromInvoice(31, FLOW_ACTOR)).rejects.toMatchObject({ statusCode: 409 });
    await expect(harness.ap.approveInvoice(invoice.id, FLOW_ACTOR)).rejects.toMatchObject({ statusCode: 409 });
    await expect(harness.ap.linkCostToInvoice(31, invoice.id, FLOW_ACTOR)).rejects.toMatchObject({ details: { code: "AP_SHIPMENT_INVOICE_LINE_REQUIRED" } });
    const before = (await snapshot())[0];
    await harness.ap.linkCostToInvoice(31, invoice.id, FLOW_ACTOR, line.id);
    expect((await harness.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership.state).toBe("billed");
    expect((await snapshot())[0][0].invoiced_amount_cents).toEqual(before[0].invoiced_amount_cents);
  });
  it("binds explicitly selected existing line atomically and identical retries are no-ops even after approval", async () => {
    const { invoice, line } = await manual();
    expect(await harness.ap.linkCostToInvoice(31, invoice.id, FLOW_ACTOR, line.id)).toMatchObject({ changed: true, invoiceLineId: line.id });
    await harness.ap.approveInvoice(invoice.id, FLOW_ACTOR);
    const before = await snapshot();
    expect(await harness.ap.linkCostToInvoice(31, invoice.id, FLOW_ACTOR, line.id)).toMatchObject({ changed: false });
    expect(await snapshot()).toEqual(before);
    expect((await readInvoiceSourceCapabilities(harness.database, invoice.id)).purchaseOrderLinks.allowed).toBe(false);
  });
  it.each([999, 1001])("rejects a selected line amount %s rather than inventing an allocation", async amount => {
    const { invoice, line } = await manual("AMOUNT", amount), before = await snapshot();
    await expect(harness.ap.linkCostToInvoice(31, invoice.id, FLOW_ACTOR, line.id)).rejects.toMatchObject({ statusCode: 422, details: { code: "AP_SHIPMENT_INVOICE_LINE_AMOUNT_MISMATCH" } });
    expect(await snapshot()).toEqual(before);
  });
  it("does not equate a missing shipment amount to an explicit zero-valued invoice line", async () => {
    await harness.pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=NULL,estimated_cents=NULL WHERE id=31");
    const { invoice, line } = await manual("MISSING-AMOUNT", 0), before = await snapshot();
    await expect(harness.ap.linkCostToInvoice(31, invoice.id, FLOW_ACTOR, line.id)).rejects.toMatchObject({
      statusCode: 422, details: { code: "AP_SHIPMENT_COST_AMOUNT_REQUIRED" },
    });
    expect(await snapshot()).toEqual(before);
  });
  it("rejects a line from another invoice and immutable source reassignment", async () => {
    const first = await manual("FIRST"), second = await manual("SECOND"), before = await snapshot();
    await expect(harness.ap.linkCostToInvoice(31, first.invoice.id, FLOW_ACTOR, second.line.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await snapshot()).toEqual(before);
    await harness.ap.linkCostToInvoice(31, first.invoice.id, FLOW_ACTOR, first.line.id);
    await expect(harness.ap.linkCostToInvoice(31, second.invoice.id, FLOW_ACTOR, second.line.id)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("preserves valid multiple source lines within one owner", async () => {
    const invoice = await bill();
    await harness.pool.query("UPDATE procurement.vendor_invoice_lines SET unit_cost_cents=400,unit_cost_mills=40000,line_total_cents=400 WHERE vendor_invoice_id=$1", [invoice.id]);
    await harness.pool.query(`INSERT INTO procurement.vendor_invoice_lines(vendor_invoice_id,freight_cost_id,line_number,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents)
      VALUES($1,31,2,1,600,60000,600)`, [invoice.id]);
    expect((await harness.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership).toMatchObject({ state: "billed", activeInvoiceId: invoice.id, activeInvoiceLineId: null });
    expect((await harness.ap.getShipmentCostPaymentStatus(1)).summary.totalCents).toBe(1000);
    await expect(harness.ap.approveInvoice(invoice.id, FLOW_ACTOR)).resolves.toMatchObject({ status: "approved" });
    const before = await snapshot(), existingLineId = await lineId(invoice.id);
    await expect(harness.ap.linkCostToInvoice(31, invoice.id, FLOW_ACTOR, existingLineId)).resolves.toMatchObject({
      changed: false, invoiceLineId: existingLineId,
    });
    expect(await snapshot()).toEqual(before);
  });
  it("blocks ambiguous active ownership from approval/payment while allowing an explicit void", async () => {
    const first = await bill(), second = await manual("CONFLICT");
    await harness.pool.query("UPDATE procurement.vendor_invoices SET inbound_shipment_id=1,status='approved' WHERE id=$1", [second.invoice.id]);
    await harness.pool.query("UPDATE procurement.vendor_invoice_lines SET freight_cost_id=31 WHERE id=$1", [second.line.id]);
    expect((await harness.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership.issueCode).toBe("AP_SHIPMENT_BILLING_MULTIPLE_OWNERS");
    await expect(harness.ap.approveInvoice(first.id, FLOW_ACTOR)).rejects.toMatchObject({ statusCode: 409 });
    await expect(harness.ap.recordPayment({ vendorId: 6, paymentDate: FLOW_AT, paymentMethod: "wire", totalAmountCents: 1000,
      allocations: [{ vendorInvoiceId: second.invoice.id, appliedAmountCents: 1000 }], createdBy: FLOW_ACTOR })).rejects.toMatchObject({ statusCode: 409, details: { code: "AP_INVOICE_BILLING_REVIEW_REQUIRED" } });
    await expect(harness.ap.voidInvoice(second.invoice.id, "Duplicate reviewed for void", FLOW_ACTOR)).resolves.toMatchObject({ status: "voided" });
    expect((await harness.pool.query("SELECT id FROM procurement.vendor_invoice_lines WHERE freight_cost_id=31")).rows).toHaveLength(2);
  });
  it("blocks historical mixed product and freight documents across capabilities and totals", async () => {
    const invoice = await bill();
    await harness.pool.query(`INSERT INTO procurement.vendor_invoice_lines(vendor_invoice_id,product_variant_id,line_number,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents)
      VALUES($1,200,2,1,0,0,0)`, [invoice.id]);
    const capabilities = await readInvoiceSourceCapabilities(harness.database, invoice.id);
    expect(capabilities.approval.allowed).toBe(false);
    expect(capabilities.payment.allowed).toBe(false);
    expect((await harness.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership.state).toBe("review_required");
    await expect(harness.ap.getShipmentCostPaymentStatus(1)).rejects.toMatchObject({ statusCode: 409 });
    await expect(harness.ap.getShipmentInvoicesSummary(1)).rejects.toMatchObject({ statusCode: 409 });
    await expect(harness.ap.approveInvoice(invoice.id, FLOW_ACTOR)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("rolls back complete create on audit failure and permits retry without duplicate billing", async () => {
    const before = await snapshot();
    await harness.pool.query(`CREATE FUNCTION procurement.fail_billing_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='ap_ledger.shipment_cost_invoice_created' THEN RAISE EXCEPTION 'billing audit rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER billing_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION procurement.fail_billing_audit()`);
    await expect(bill()).rejects.toThrow(/billing audit rollback/);
    expect(await snapshot()).toEqual(before);
    await harness.pool.query("DROP TRIGGER billing_audit_failure ON public.audit_events");
    await bill();
    expect((await harness.pool.query("SELECT id FROM procurement.vendor_invoice_lines WHERE freight_cost_id=31")).rows).toHaveLength(1);
  });
  it("rolls back source binding on audit failure and permits an identical retry", async () => {
    const { invoice, line } = await manual(), before = await snapshot();
    await harness.pool.query(`CREATE FUNCTION procurement.fail_link_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='ap_ledger.shipment_cost_invoice_linked' THEN RAISE EXCEPTION 'link audit rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER link_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION procurement.fail_link_audit()`);
    await expect(harness.ap.linkCostToInvoice(31, invoice.id, FLOW_ACTOR, line.id)).rejects.toThrow(/link audit rollback/);
    expect(await snapshot()).toEqual(before);
    await harness.pool.query("DROP TRIGGER link_audit_failure ON public.audit_events");
    await expect(harness.ap.linkCostToInvoice(31, invoice.id, FLOW_ACTOR, line.id)).resolves.toMatchObject({ changed: true });
    await expect(harness.ap.linkCostToInvoice(31, invoice.id, FLOW_ACTOR, line.id)).resolves.toMatchObject({ changed: false });
    expect((await harness.pool.query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='ap_ledger.shipment_cost_invoice_linked'")).rows[0].count).toBe(1);
  });
  it("serializes an existing-line binding against a competing new invoice", async () => {
    const { invoice, line } = await manual();
    const results = await Promise.allSettled([harness.ap.linkCostToInvoice(31, invoice.id, FLOW_ACTOR, line.id), bill("CREATE-RACE")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const source = (await harness.pool.query("SELECT vendor_invoice_id FROM procurement.vendor_invoice_lines WHERE freight_cost_id=31")).rows;
    expect(source).toHaveLength(1);
    expect((await harness.pool.query("SELECT vendor_invoice_id FROM procurement.inbound_freight_costs WHERE id=31")).rows[0]).toEqual(source[0]);
  });
  it("serializes competing create commands to one invoice owner", async () => {
    const results = await Promise.allSettled([bill("RACE-A"), bill("RACE-B")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await harness.pool.query("SELECT id FROM procurement.vendor_invoice_lines WHERE freight_cost_id=31")).rows).toHaveLength(1);
  });
  it("replaces a valid split-line invoice under the ownership guard while preserving every historical line", async () => {
    await harness.pool.query(readFileSync(resolve(process.cwd(), "docs/procurement/shipment-invoice-ownership-guard.pending.sql"), "utf8"));
    const original = await bill();
    await harness.pool.query("UPDATE procurement.vendor_invoice_lines SET unit_cost_cents=400,unit_cost_mills=40000,line_total_cents=400 WHERE vendor_invoice_id=$1", [original.id]);
    await harness.pool.query(`INSERT INTO procurement.vendor_invoice_lines(vendor_invoice_id,freight_cost_id,line_number,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents)
      VALUES($1,31,2,1,600,60000,600)`, [original.id]);
    await harness.ap.voidInvoice(original.id, "Correct split invoice", FLOW_ACTOR);
    const originalLines = (await harness.pool.query("SELECT * FROM procurement.vendor_invoice_lines WHERE vendor_invoice_id=$1 ORDER BY id", [original.id])).rows;
    const detail = await readInvoiceReplacementDetail(harness.database, original.id);
    expect(detail.replacementCapability.allowed).toBe(true);
    const replacement = await harness.database.transaction(tx => replaceVoidedInvoiceInTransaction(tx, original.id,
      { expectedVersion: detail.replacementCapability.expectedVersion, reason: "Retain both original source lines" }, FLOW_ACTOR, FLOW_AT));
    expect((await harness.pool.query("SELECT * FROM procurement.vendor_invoice_lines WHERE vendor_invoice_id=$1 ORDER BY id", [original.id])).rows).toEqual(originalLines);
    const successorLines = (await harness.pool.query("SELECT freight_cost_id,line_total_cents FROM procurement.vendor_invoice_lines WHERE vendor_invoice_id=$1 ORDER BY id", [replacement.invoiceId])).rows;
    expect(successorLines).toEqual([{ freight_cost_id: 31, line_total_cents: "400" }, { freight_cost_id: 31, line_total_cents: "600" }]);
    expect((await harness.pool.query(`SELECT count(DISTINCT line.vendor_invoice_id)::int AS count FROM procurement.vendor_invoice_lines line
      JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id WHERE line.freight_cost_id=31 AND invoice.status<>'voided'`)).rows[0].count).toBe(1);
    expect((await harness.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership).toMatchObject({ state: "billed", activeInvoiceId: replacement.invoiceId });
    expect((await harness.ap.getShipmentCostPaymentStatus(1)).summary.totalCents).toBe(1000);
    await expect(harness.ap.approveInvoice(replacement.invoiceId, FLOW_ACTOR)).resolves.toMatchObject({ status: "approved" });
  });
  it("keeps voided source evidence and transfers authority only through explicit replacement", async () => {
    await harness.pool.query(readFileSync(resolve(process.cwd(), "docs/procurement/shipment-invoice-ownership-guard.pending.sql"), "utf8"));
    const original = await bill();
    await harness.ap.voidInvoice(original.id, "Supplier correction", FLOW_ACTOR);
    expect((await harness.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership.state).toBe("voided");
    await expect(bill("UNRELATED-REBILL")).rejects.toMatchObject({ statusCode: 409 });
    const detail = await readInvoiceReplacementDetail(harness.database, original.id);
    const replacement = await harness.database.transaction(tx => replaceVoidedInvoiceInTransaction(tx, original.id,
      { expectedVersion: detail.replacementCapability.expectedVersion, reason: "Explicit successor" }, FLOW_ACTOR, FLOW_AT));
    expect((await harness.ap.enrichCostsWithInvoiceInfo(1))[0].billingOwnership).toMatchObject({ state: "billed", activeInvoiceId: replacement.invoiceId });
    expect((await harness.pool.query("SELECT id FROM procurement.vendor_invoice_lines WHERE freight_cost_id=31")).rows).toHaveLength(2);
    await expect(harness.ap.approveInvoice(replacement.invoiceId, FLOW_ACTOR)).resolves.toMatchObject({ status: "approved" });
  });
});
