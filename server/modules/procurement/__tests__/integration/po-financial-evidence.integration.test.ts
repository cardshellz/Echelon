import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPoFinancialEvidenceService } from "../../po-financial-evidence.service";
import { readPoFinancialEvidenceSource } from "../../po-financial-evidence.repository";
import { PoFinancialRefreshFixture, REFRESH_ACTOR } from "./po-financial-refresh.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;

databaseTests.sequential("PO financial evidence from real invoice and payment records", () => {
  const fixture = new PoFinancialRefreshFixture();
  let evidence: ReturnType<typeof createPoFinancialEvidenceService>;
  let invoiceId: number;
  beforeAll(async () => {
    await fixture.start(url!);
    evidence = createPoFinancialEvidenceService(fixture.db);
  });
  beforeEach(async () => { await fixture.seed(); invoiceId = await fixture.createInvoice([10, 20]); });
  afterAll(() => fixture.stop());

  async function pay(amount: number) {
    // Approval is an explicit seeded prerequisite; this suite exercises the
    // real payment owner and the read projection, not invoice approval policy.
    await fixture.pool.query("UPDATE procurement.vendor_invoices SET status='approved' WHERE id=$1 AND status='received'", [invoiceId]);
    return fixture.service.recordPayment({ vendorId: 5, paymentDate: new Date("2026-10-15T12:00:00Z"),
      paymentMethod: "wire", currency: "USD", totalAmountCents: amount,
      allocations: [{ vendorInvoiceId: invoiceId, appliedAmountCents: amount }], createdBy: REFRESH_ACTOR });
  }

  it("reports each PO's recorded invoice lines once without rewriting legacy caches or financial records", async () => {
    const before = await fixture.snapshot();
    expect(await evidence.read(10)).toMatchObject({ state: "complete", invoicedAmountCents: 1000, paidAmountCents: 0,
      outstandingAmountCents: 1000, invoiceCount: 1, reviewReasons: [] });
    expect(await evidence.read(20)).toMatchObject({ state: "complete", invoicedAmountCents: 2000, paidAmountCents: 0, outstandingAmountCents: 2000 });
    expect(await fixture.snapshot()).toEqual(before);
    expect((await fixture.amounts()).slice(0, 2).map(row => row.invoiced)).toEqual(["3000", "3000"]);
  });
  it("does not invent PO shares for a partial payment on a shared invoice", async () => {
    await pay(1000);
    const before = await fixture.snapshot();
    for (const [poId, amount] of [[10, 1000], [20, 2000]]) {
      expect(await evidence.read(poId)).toMatchObject({ state: "review_required", invoicedAmountCents: amount,
        paidAmountCents: null, outstandingAmountCents: null,
        reviewReasons: [expect.objectContaining({ code: "PO_SHARED_INVOICE_PARTIAL_PAYMENT", invoiceId })] });
    }
    expect(await fixture.snapshot()).toEqual(before);
    expect((await fixture.service.getPaymentsForPo(10))[0].appliedAmountCents).toBe(1000);
    expect((await fixture.service.getPaymentsForPo(20))[0].appliedAmountCents).toBe(1000);
  });
  it("derives exact conserved PO settlement at full invoice settlement", async () => {
    await pay(1000); await pay(2000);
    expect(await evidence.read(10)).toMatchObject({ state: "complete", invoicedAmountCents: 1000, paidAmountCents: 1000, outstandingAmountCents: 0 });
    expect(await evidence.read(20)).toMatchObject({ state: "complete", invoicedAmountCents: 2000, paidAmountCents: 2000, outstandingAmountCents: 0 });
  });
  it("derives partial settlement for a sole complete owner", async () => {
    await fixture.service.unlinkPoFromInvoice(invoiceId, 20, REFRESH_ACTOR);
    await pay(400);
    expect(await evidence.read(10)).toMatchObject({ state: "complete", invoicedAmountCents: 1000, paidAmountCents: 400, outstandingAmountCents: 600 });
    expect(await evidence.read(20)).toMatchObject({ state: "complete", invoiceCount: 0, invoicedAmountCents: 0, paidAmountCents: 0, outstandingAmountCents: 0 });
  });
  it("does not reinterpret optional relationship metadata as invoice ownership", async () => {
    await fixture.pool.query("UPDATE procurement.vendor_invoice_po_links SET allocated_amount_cents=999999 WHERE vendor_invoice_id=$1", [invoiceId]);
    expect(await evidence.read(10)).toMatchObject({ state: "complete", invoicedAmountCents: 1000 });
    expect(await evidence.read(20)).toMatchObject({ state: "complete", invoicedAmountCents: 2000 });
  });
  it("keeps an unmapped source amount unresolved instead of assigning the invoice residual", async () => {
    await fixture.pool.query("UPDATE procurement.vendor_invoice_lines SET purchase_order_line_id=NULL WHERE purchase_order_line_id=22");
    expect(await evidence.read(10)).toMatchObject({ state: "review_required", invoicedAmountCents: null, paidAmountCents: null,
      outstandingAmountCents: null, reviewReasons: [expect.objectContaining({ code: "PO_INVOICE_LINE_UNASSIGNED" })] });
  });
  it("returns review when an owned line's PO relationship has been removed", async () => {
    await fixture.pool.query("DELETE FROM procurement.vendor_invoice_po_links WHERE purchase_order_id=20");
    expect(await evidence.read(10)).toMatchObject({ state: "review_required", invoicedAmountCents: null,
      reviewReasons: [expect.objectContaining({ code: "PO_INVOICE_OWNERSHIP_INVALID" })] });
  });
  it("reads the canonical payment void without treating retained allocations as settled", async () => {
    const payment = await pay(1000);
    await fixture.service.voidPayment(payment.id, "Synthetic payment reversal", REFRESH_ACTOR);
    expect(await evidence.read(10)).toMatchObject({ state: "complete", invoicedAmountCents: 1000, paidAmountCents: 0, outstandingAmountCents: 1000 });
    expect((await fixture.pool.query("SELECT status FROM procurement.ap_payments WHERE id=$1", [payment.id])).rows[0].status).toBe("voided");
    expect((await fixture.pool.query("SELECT * FROM procurement.ap_payment_allocations")).rows).toHaveLength(1);
    await pay(400);
    const source = await readPoFinancialEvidenceSource(fixture.db, 10);
    expect(source?.invoices[0].payments).toEqual([
      expect.objectContaining({ paymentId: payment.id, paymentStatus: "voided", appliedAmountCents: 1000 }),
      expect.objectContaining({ paymentStatus: "completed", appliedAmountCents: 400 }),
    ]);
    expect(await evidence.read(10)).toMatchObject({ state: "review_required", invoicedAmountCents: 1000,
      paidAmountCents: null, outstandingAmountCents: null });
  });
  it("detects header settlement inconsistent with the retained completed allocation", async () => {
    await pay(1000);
    await fixture.pool.query("UPDATE procurement.vendor_invoices SET paid_amount_cents=900,balance_cents=2100 WHERE id=$1", [invoiceId]);
    expect(await evidence.read(10)).toMatchObject({ state: "review_required", invoicedAmountCents: 1000, paidAmountCents: null,
      reviewReasons: [expect.objectContaining({ code: "PO_INVOICE_SETTLEMENT_MISMATCH" })] });
  });
  it("excludes a canonically voided non-product invoice and distinguishes missing PO from no invoices", async () => {
    // Financial-read scope: fee lines take the real non-product reconciliation
    // branch. Product cost/inventory reversal is covered by the cost fixture.
    await fixture.pool.query("UPDATE procurement.purchase_order_lines SET line_type='fee' WHERE id IN (21,22)");
    await fixture.service.voidInvoice(invoiceId, "Synthetic invoice cancellation", REFRESH_ACTOR);
    expect(await evidence.read(10)).toMatchObject({ state: "complete", invoiceCount: 0, invoicedAmountCents: 0, paidAmountCents: 0, outstandingAmountCents: 0 });
    expect(await evidence.read(999)).toBeNull();
  });
  it("preserves a signed discount in the recorded owned line total", async () => {
    // The existing mills guard requires nonnegative unit pricing; the persisted
    // extended amount carries the signed adjustment used by this read model.
    await fixture.pool.query(`INSERT INTO procurement.vendor_invoice_lines(vendor_invoice_id,purchase_order_line_id,line_number,
      qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents) VALUES($1,21,3,1,100,10000,-100)`, [invoiceId]);
    await fixture.pool.query("UPDATE procurement.vendor_invoices SET invoiced_amount_cents=2900,balance_cents=2900 WHERE id=$1", [invoiceId]);
    expect(await evidence.read(10)).toMatchObject({ state: "complete", invoicedAmountCents: 900, paidAmountCents: 0, outstandingAmountCents: 900 });
    expect(await evidence.read(20)).toMatchObject({ state: "complete", invoicedAmountCents: 2000 });
  });
  it("rejects mixed currency ownership without silently converting it", async () => {
    await fixture.pool.query("UPDATE procurement.purchase_orders SET currency='EUR' WHERE id=20");
    expect(await evidence.read(10)).toMatchObject({ state: "review_required", invoicedAmountCents: null,
      reviewReasons: [expect.objectContaining({ code: "PO_INVOICE_OWNERSHIP_INVALID" })] });
    expect(await evidence.read(20)).toMatchObject({ state: "review_required", currency: "EUR", invoicedAmountCents: null });
  });
  it("keeps all invoice queries on one snapshot while a separate writer removes a source line", async () => {
    const { pool: modulePool } = await import("../../../../db");
    const originalConnect = modulePool.connect;
    const connect = originalConnect as unknown as () => Promise<import("pg").PoolClient>;
    let changed = false;
    modulePool.connect = (async () => {
      const client = await connect.call(modulePool);
      const originalQuery = client.query, originalRelease = client.release;
      client.query = (async (...args: unknown[]) => {
        const first = args[0];
        const text = typeof first === "string" ? first : typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
        const result: unknown = await Reflect.apply(originalQuery, client, args);
        if (!changed && text.includes('from "procurement"."purchase_orders"')) {
          changed = true;
          await fixture.pool.query("UPDATE procurement.vendor_invoice_lines SET purchase_order_line_id=NULL WHERE purchase_order_line_id=22");
        }
        return result;
      }) as typeof client.query;
      client.release = error => { client.query = originalQuery; client.release = originalRelease; originalRelease(error); };
      return client;
    }) as typeof modulePool.connect;
    try {
      expect(await evidence.read(10)).toMatchObject({ state: "complete", invoicedAmountCents: 1000, outstandingAmountCents: 1000 });
      expect(changed).toBe(true);
    } finally { modulePool.connect = originalConnect; }
    expect(await evidence.read(10)).toMatchObject({ state: "review_required", invoicedAmountCents: null });
  });
});
