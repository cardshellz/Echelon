import { describe, expect, it } from "vitest";
import type { PoFinancialEvidenceInput, PoFinancialInvoiceEvidence } from "../../domain/po-financial-evidence";
import { buildPoFinancialWorkflow } from "../../domain/po-financial-workflow";
import { buildPoFinancialMilestonePatch } from "../../domain/po-financial-milestones";

const now = new Date("2026-10-19T12:00:00Z");
const existing = { firstInvoicedAt: null, firstPaidAt: null, fullyPaidAt: null };
function source(paid = 0, shared = false, status?: string): PoFinancialEvidenceInput {
  const invoice: PoFinancialInvoiceEvidence = {
    id: 10, vendorId: 9, currency: "USD", status: status ?? (paid === 1000 ? "paid" : paid > 0 ? "partially_paid" : "approved"),
    invoicedAmountCents: 1000, paidAmountCents: paid, balanceCents: 1000 - paid,
    links: [1, ...(shared ? [2] : [])].map(purchaseOrderId => ({ purchaseOrderId, purchaseOrderVendorId: 9, purchaseOrderCurrency: "USD" })),
    lines: [{ id: 11, purchaseOrderLineId: 21, purchaseOrderId: 1, freightCostId: null, lineTotalCents: shared ? 400 : 1000 },
      ...(shared ? [{ id: 12, purchaseOrderLineId: 22, purchaseOrderId: 2, freightCostId: null, lineTotalCents: 600 }] : [])],
    payments: paid > 0 ? [{ allocationId: 31, paymentId: 41, paymentVendorId: 9, paymentCurrency: "USD", paymentStatus: "completed", appliedAmountCents: paid }] : [],
  };
  return { purchaseOrderId: 1, vendorId: 9, currency: "USD", invoices: [invoice] };
}
const patch = (input: PoFinancialEvidenceInput) => buildPoFinancialMilestonePatch({ workflow: buildPoFinancialWorkflow(input), existing, now });

describe("canonical PO financial milestones", () => {
  it("records a proven invoice and an exact sole-owner partial payment", () => {
    expect(patch(source())).toEqual({ firstInvoicedAt: now });
    expect(patch(source(400))).toEqual({ firstInvoicedAt: now, firstPaidAt: now });
  });
  it("does not invent milestones for partially settled shared invoices", () => {
    expect(patch(source(400, true))).toEqual({});
  });
  it("records settlement only when the canonical workflow is settled", () => {
    expect(patch(source(1000, true))).toEqual({ firstInvoicedAt: now, firstPaidAt: now, fullyPaidAt: now });
    expect(patch(source(1000, false, "disputed"))).toEqual({ firstInvoicedAt: now, firstPaidAt: now });
  });
  it("rejects inconsistent paid evidence instead of trusting invoice headers", () => {
    const input = source(1000); input.invoices[0].payments = [];
    expect(patch(input)).toEqual({});
  });
  it("does not backfill or overwrite preserved historical timestamps", () => {
    const old = new Date("2020-01-01T00:00:00Z");
    expect(buildPoFinancialMilestonePatch({ workflow: buildPoFinancialWorkflow(source(1000)),
      existing: { firstInvoicedAt: old, firstPaidAt: old, fullyPaidAt: old }, now })).toEqual({});
    expect(patch({ ...source(), invoices: [] })).toEqual({});
    expect(patch(source(0, false, "voided"))).toEqual({});
  });
  it("uses the supplied valid command time without mutating it", () => {
    const result = patch(source());
    expect(result.firstInvoicedAt).not.toBe(now);
    expect(now.toISOString()).toBe("2026-10-19T12:00:00.000Z");
    expect(() => buildPoFinancialMilestonePatch({ workflow: buildPoFinancialWorkflow(source()), existing, now: new Date("invalid") })).toThrow();
  });
});
