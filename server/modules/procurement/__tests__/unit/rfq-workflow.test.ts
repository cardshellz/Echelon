import { reviewRfqQuantity } from "@shared/procurement/rfq-quantity-review";
import { describe, expect, it } from "vitest";
import { rfqConvertSchema, rfqQuoteCaptureSchema, rfqQuoteRevisionSchema, type RfqQuoteRevision, type RfqWorkflowDetail } from "@shared/procurement/rfq-workflow";
import { assertRfqQuoteCanConvert, rfqWorkflowVersion } from "../../rfq-workflow.service";
import { mapRfqQuoteRevision, RfqEvidenceIntegrityError } from "../../rfq-workflow.repository";
import { classifyRfqWorkflowFailure } from "../../rfq-workflow.commands";
import { parseRfqMoney, rfqQuoteFromForm, rfqQuoteFormFromEvidence } from "../../../../../client/src/lib/rfq-quote-form";

const at = new Date("2026-09-07T12:00:00Z");
function fixture() {
  const quote: RfqQuoteRevision = {
    id: 1, rfqLineId: 2, revision: 1, fingerprint: "b".repeat(64), currency: "USD", quotedPieces: 150,
    quotedUnitCostMills: 6667, productTotalMills: 1_000_000, pricingRemainderMills: -50,
    quote: { pricing: { basis: "extended_total", quantityPieces: 150, quotedTotalCents: 10_000 }, packagingTreatment: "separate", packagingCostCents: 1800, quoteReference: "QUOTE-1", quoteValidUntil: "2026-09-30", quotedAt: at.toISOString(), leadTimeDays: 120, reason: "Original supplier quote" },
    createdBy: "operator", createdAt: at.toISOString(),
  };
  const rules = { vendorProductId: 6, minimumOrderPieces: 1, piecesPerPurchaseUom: null, packSize: 1 };
  const line: RfqWorkflowDetail["lines"][number] = { id: 2, status: "quoted", productId: 3, productVariantId: 4, warehouseId: 5, vendorProductId: 6, sku: "SKU", productName: "Product", requestedPieces: 150, quantityReview: reviewRfqQuantity({ recommendationRules: rules, currentRules: rules, quotedPieces: 150 }), latestQuote: quote, purchaseOrder: null };
  const workflow: RfqWorkflowDetail = { id: 1, rfqNumber: "RFQ-1", vendorId: 10, currency: "USD", status: "quoted", version: "a".repeat(64), lines: [line] };
  return { workflow, line, quoteRevisionId: quote.id, quantityOverrideReason: null, at };
}

describe("RFQ quote and conversion contracts", () => {
  it("preserves the original quote pricing basis and exact packaging", () => {
    const input = fixture();
    expect(assertRfqQuoteCanConvert(input)).toEqual(input.line.latestQuote);
    const captured = rfqQuoteCaptureSchema.parse({ expectedVersion: input.workflow.version, quote: input.line.latestQuote!.quote });
    expect(captured.quote.pricing).toEqual({ basis: "extended_total", quantityPieces: 150, quotedTotalCents: 10000 });
    expect(captured.quote.packagingCostCents).toBe(1800);
  });
  it.each(["cancelled", "declined", "expired"])("rejects conversion from %s requests", (status) => {
    const input = fixture(); input.workflow.status = status;
    expect(() => assertRfqQuoteCanConvert(input)).toThrow(expect.objectContaining({ code: "RFQ_NOT_ACTIVE" }));
  });
  it("rejects missing, stale, expired, converted and unsupported-currency sources", () => {
    const stale = fixture(); stale.quoteRevisionId = 3;
    expect(() => assertRfqQuoteCanConvert(stale)).toThrow(expect.objectContaining({ code: "RFQ_QUOTE_CHANGED" }));
    const missing = fixture(); missing.line.latestQuote = null;
    expect(() => assertRfqQuoteCanConvert(missing)).toThrow(expect.objectContaining({ code: "RFQ_QUOTE_REQUIRED" }));
    const expired = fixture(); expired.line.latestQuote!.quote.quoteValidUntil = "2026-09-06";
    expect(() => assertRfqQuoteCanConvert(expired)).toThrow(expect.objectContaining({ code: "RFQ_QUOTE_EXPIRED" }));
    const ordered = fixture(); ordered.line.status = "ordered";
    expect(() => assertRfqQuoteCanConvert(ordered)).toThrow(expect.objectContaining({ code: "RFQ_LINE_ALREADY_ORDERED" }));
    const foreign = fixture(); foreign.workflow.currency = "EUR";
    expect(() => assertRfqQuoteCanConvert(foreign)).toThrow(expect.objectContaining({ code: "RFQ_CURRENCY_UNSUPPORTED" }));
  });
  it.each(["unknown", "included_in_product"] as const)("preserves %s packaging evidence but requires review before conversion", (packagingTreatment) => {
    const input = fixture(); input.line.latestQuote!.quote.packagingTreatment = packagingTreatment;
    expect(rfqQuoteCaptureSchema.safeParse({ expectedVersion: input.workflow.version, quote: input.line.latestQuote!.quote }).success).toBe(true);
    expect(() => assertRfqQuoteCanConvert(input)).toThrow(expect.objectContaining({ code: "RFQ_PACKAGING_REVIEW_REQUIRED" }));
  });
  it("requires an explicit audited reason when quote quantity differs", () => {
    const input = fixture(); input.line.requestedPieces = 100;
    expect(() => assertRfqQuoteCanConvert(input)).toThrow(expect.objectContaining({ code: "RFQ_QUANTITY_OVERRIDE_REQUIRED" }));
    expect(assertRfqQuoteCanConvert({ ...input, quantityOverrideReason: "Supplier minimum is 150 pieces" }).quotedPieces).toBe(150);
  });
  it("requires the existing reason for current rule drift even when quote quantity equals request", () => {
    const input = fixture();
    const rules = input.line.quantityReview.currentRules!;
    input.line.quantityReview = reviewRfqQuantity({ recommendationRules: rules, currentRules: { ...rules, minimumOrderPieces: 200 }, quotedPieces: 150 });
    expect(() => assertRfqQuoteCanConvert(input)).toThrow(expect.objectContaining({ code: "RFQ_QUANTITY_REVIEW_REQUIRED" }));
    expect(assertRfqQuoteCanConvert({ ...input, quantityOverrideReason: "Vendor explicitly confirmed a 150-piece exception" }).quotedPieces).toBe(150);
    input.line.quantityReview = reviewRfqQuantity({ recommendationRules: rules, currentRules: { ...rules, packSize: 0 }, quotedPieces: 150 });
    expect(() => assertRfqQuoteCanConvert({ ...input, quantityOverrideReason: "Cannot override invalid data" })).toThrow(expect.objectContaining({ code: "RFQ_ORDER_RULES_INVALID" }));
  });
  it("changes the reviewed workflow version when supplier order rules change", () => {
    const { version: _version, ...snapshot } = fixture().workflow;
    const before = rfqWorkflowVersion(snapshot);
    const line = snapshot.lines[0];
    line.quantityReview = reviewRfqQuantity({ recommendationRules: line.quantityReview.recommendationRules, currentRules: { ...line.quantityReview.currentRules!, packSize: 100 }, quotedPieces: 150 });
    expect(rfqWorkflowVersion(snapshot)).not.toBe(before);
  });
  it("rejects duplicate selections, coercion, fractional quantities and unsafe amounts", () => {
    expect(rfqConvertSchema.safeParse({ expectedVersion: "a".repeat(64), lines: [{ rfqLineId: 2, quoteRevisionId: 1 }, { rfqLineId: 2, quoteRevisionId: 1 }], quantityOverrideReason: null }).success).toBe(false);
    for (const quotedTotalCents of ["100", true, null, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const input = fixture();
      const quote = { ...input.line.latestQuote!.quote, pricing: { basis: "extended_total", quantityPieces: 150, quotedTotalCents } };
      expect(rfqQuoteCaptureSchema.safeParse({ expectedVersion: input.workflow.version, quote }).success).toBe(false);
    }
  });
  it("rejects conflicting recorded economics as stored evidence failure, not invalid operator input", () => {
    const quote = fixture().line.latestQuote!;
    expect(rfqQuoteRevisionSchema.safeParse({ ...quote, productTotalMills: quote.productTotalMills + 1 }).success).toBe(false);
    expect(() => mapRfqQuoteRevision({ id: quote.id, rfq_line_id: quote.rfqLineId, revision: 1, fingerprint: quote.fingerprint, currency: "USD", quoted_pieces: 150, quoted_unit_cost_mills: "1", product_total_mills: "1000000", pricing_remainder_mills: "-50", quote_data: quote.quote, created_by: "operator", created_at: "2026-09-07 12:00:00+00" })).toThrow(RfqEvidenceIntegrityError);
    expect(classifyRfqWorkflowFailure(new RfqEvidenceIntegrityError()).kind).toBe("retryable");
  });
  it("requires review when header currency no longer matches its immutable quote", () => {
    const input = fixture(); input.line.latestQuote!.currency = "EUR";
    expect(() => assertRfqQuoteCanConvert(input)).toThrow(expect.objectContaining({ code: "RFQ_QUOTE_CURRENCY_CHANGED" }));
  });
  it("changes the reviewed version when a quote revision, source quantity or PO link changes", () => {
    const original = fixture().workflow;
    const { version: _version, ...snapshot } = original;
    const version = rfqWorkflowVersion(snapshot);
    for (const changed of [
      { ...snapshot, lines: [{ ...snapshot.lines[0], requestedPieces: 200 }] },
      { ...snapshot, lines: [{ ...snapshot.lines[0], latestQuote: { ...snapshot.lines[0].latestQuote!, revision: 2 } }] },
    ]) expect(rfqWorkflowVersion(changed)).not.toBe(version);
    expect(rfqWorkflowVersion(structuredClone(snapshot))).toBe(version);
  });
});

describe("RFQ quote form exact amounts", () => {
  it("parses cents and mills with integer arithmetic including zero and sub-cent quotes", () => {
    expect(parseRfqMoney("0", 2)).toBe(0);
    expect(parseRfqMoney(".0375", 4)).toBe(375);
    expect(parseRfqMoney("1234567.89", 2)).toBe(123456789);
    expect(parseRfqMoney("900719925474.0991", 4)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each(["", "-1", "1e3", "NaN", "1.234", "9007199254740991.99"])("rejects invalid cents %s", (raw) => expect(() => parseRfqMoney(raw, 2)).toThrow());
  it("round-trips vendor purchase-unit pricing without converting it into a rounded piece price", () => {
    const evidence = fixture().line.latestQuote!.quote;
    evidence.pricing = { basis: "per_purchase_uom", purchaseUom: "case", uomQuantity: 3, piecesPerUom: 50, quotedCostMillsPerUom: 333333 };
    const form = rfqQuoteFormFromEvidence(evidence, 150, "2026-09-07");
    const restored = rfqQuoteFromForm({ ...form, reason: "Supplier confirmed the case quote" });
    expect(restored.pricing).toEqual(evidence.pricing);
    expect(restored.packagingCostCents).toBe(1800);
  });
  it("starts new packaging evidence unknown and requires an explicit zero when separate", () => {
    const form = rfqQuoteFormFromEvidence(null, 150, "2026-09-07");
    expect(form.packagingTreatment).toBe("unknown");
    const valid = { ...form, amount: "1.00", quoteReference: "Quote", reason: "Supplier email", packagingTreatment: "separate" as const };
    expect(() => rfqQuoteFromForm(valid)).toThrow();
    expect(rfqQuoteFromForm({ ...valid, packagingAmount: "0" }).packagingCostCents).toBe(0);
  });
});
