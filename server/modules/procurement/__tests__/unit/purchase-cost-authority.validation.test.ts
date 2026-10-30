import { describe, expect, it } from "vitest";
import { purchaseCostAmountProjectionSchema, purchaseCostAuthorityInputSchema, purchaseCostAuthoritySchema } from "@shared/procurement/purchase-cost-authority";
import { projectPurchaseCostAuthority } from "../../domain/purchase-cost-authority";
import { authorityFreight, authorityInput, authorityInvoice } from "./purchase-cost-authority.fixture";

describe("purchase cost authority boundary validation", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "100", true, null])(
    "rejects invalid piece count %s without coercion or an unclassified BigInt error", value => {
      const input = authorityInput();
      const raw = { ...input, scope: { ...input.scope, basePieces: value } };
      expect(purchaseCostAuthorityInputSchema.safeParse(raw).success).toBe(false);
      expect(() => projectPurchaseCostAuthority(raw)).toThrowError(expect.objectContaining({ code: "PURCHASE_COST_AUTHORITY_INPUT_INVALID" }));
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "100", true, null])(
    "rejects invalid money %s at the input boundary", value => {
      const input = authorityInput();
      const raw = { ...input, quote: { ...input.quote, amount: { ...input.quote.amount, goodsMills: value } } };
      expect(purchaseCostAuthorityInputSchema.safeParse(raw).success).toBe(false);
      expect(() => projectPurchaseCostAuthority(raw)).toThrowError(expect.objectContaining({ code: "PURCHASE_COST_AUTHORITY_INPUT_INVALID" }));
    },
  );

  it("rejects a mismatched document total or component split", () => {
    const input = authorityInput(); input.quote.amount!.documentTotalMills++;
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
    input.quote.amount!.documentTotalMills--; input.quote.amount!.breakdown!.productMills++;
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects duplicate invoice lines and mismatched PO source links", () => {
    const input = authorityInput(); input.invoices = [authorityInvoice(50), authorityInvoice(50)];
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
    input.invoices = [{ ...authorityInvoice(), purchaseOrderLineId: 99 }];
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
    input.invoices = []; input.quote.reference.documentId = 99;
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects duplicate source adjustments", () => {
    const input = authorityInput();
    input.quote.amount!.adjustments = [
      { key: "same", category: "tax", amountMills: 0, treatment: "inventory" },
      { key: "same", category: "tax", amountMills: 0, treatment: "inventory" },
    ];
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects malformed or incomplete receipt coverage", () => {
    const input = authorityInput(); input.invoices = [{ ...authorityInvoice(), receiptCoverage: [{ receivingLineId: 100, startPiece: 0, pieces: 50 }] }];
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
    const raw = { ...input, invoices: [{ ...input.invoices[0], pieces: 1.5 }] };
    expect(purchaseCostAuthorityInputSchema.safeParse(raw).success).toBe(false);
  });

  it("does not accept an empty shipment list as complete charge evidence", () => {
    const input = authorityInput(); input.shipmentCostCoverage = "complete";
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
    input.shipmentCostCoverage = "not_applicable"; input.shipmentShares = [authorityFreight()];
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects duplicated shipment-line shares", () => {
    const input = authorityInput(); input.shipmentCostCoverage = "complete"; input.shipmentShares = [authorityFreight(), authorityFreight()];
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
  });

  it("requires real posting references for a claim that costs are applied", () => {
    const input = authorityInput(); input.application = { state: "applied", economicFingerprint: null, applicationIds: [], approvals: [] };
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects unexpected payment fields instead of accepting another price basis", () => {
    expect(purchaseCostAuthorityInputSchema.safeParse({ ...authorityInput(), paidAmountMills: 500 }).success).toBe(false);
  });

  it("validates the outbound landed total and quantity scope", () => {
    const output = projectPurchaseCostAuthority(authorityInput());
    expect(purchaseCostAuthoritySchema.safeParse({ ...output, landedMills: 1 }).success).toBe(false);
    expect(purchaseCostAuthoritySchema.safeParse({ ...output, coverage: { ...output.coverage, confirmedPieces: 100 } }).success).toBe(false);
  });

  it("rejects an outbound supplier summary that differs from its source amounts", () => {
    const output = projectPurchaseCostAuthority(authorityInput());
    const forged = { ...output, supplier: { ...output.supplier!, documentMills: 2, goodsMills: 2,
      productMills: 1, packagingMills: 1, includedMills: 2 }, landedMills: 2 };
    expect(purchaseCostAuthoritySchema.safeParse(forged).success).toBe(false);
  });

  it("does not accept a forged completed status without posting evidence", () => {
    const output = projectPurchaseCostAuthority(authorityInput());
    expect(purchaseCostAuthoritySchema.safeParse({ ...output,
      application: { state: "applied", applicationIds: [], approvals: [] } }).success).toBe(false);
  });

  it("rejects an invented breakdown when the selected invoice split is unknown", () => {
    const input = authorityInput(); input.invoices = [authorityInvoice()];
    const output = projectPurchaseCostAuthority(input);
    expect(purchaseCostAuthoritySchema.safeParse({ ...output,
      supplier: { ...output.supplier!, productMills: 12_000_000, packagingMills: 0 } }).success).toBe(false);
  });

  it("rejects swapped confirmed and estimated quantity labels", () => {
    const output = projectPurchaseCostAuthority(authorityInput());
    expect(purchaseCostAuthoritySchema.safeParse({ ...output,
      coverage: { ...output.coverage, confirmedPieces: 100, estimatedPieces: 0 } }).success).toBe(false);
  });

  it("rejects a shipment total that differs from its saved shares", () => {
    const input = authorityInput(); input.shipmentCostCoverage = "complete"; input.shipmentShares = [authorityFreight()];
    const output = projectPurchaseCostAuthority(input);
    expect(purchaseCostAuthoritySchema.safeParse({ ...output, shipmentMills: 1, landedMills: 10_000_001 }).success).toBe(false);
  });

  it("bounds total receipt intervals across invoices", () => {
    const input = authorityInput();
    const coverage = Array.from({ length: 501 }, (_, startPiece) => ({ receivingLineId: 100, startPiece, pieces: 1 }));
    input.invoices = [{ ...authorityInvoice(501), receiptCoverage: coverage },
      { ...authorityInvoice(501), reference: { kind: "vendor_invoice_line", documentId: 21, lineId: 3 }, receiptCoverage: coverage }];
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects duplicated recorded application IDs", () => {
    const input = authorityInput(), output = projectPurchaseCostAuthority(input);
    input.application = { state: "applied", economicFingerprint: output.economicFingerprint, applicationIds: [123, 123], approvals: [] };
    expect(purchaseCostAuthorityInputSchema.safeParse(input).success).toBe(false);
    expect(purchaseCostAuthoritySchema.safeParse({ ...output,
      application: { state: "applied", applicationIds: [123, 123], approvals: [] } }).success).toBe(false);
  });

  it("requires the projected document and component amounts to reconcile", () => {
    const amount = projectPurchaseCostAuthority(authorityInput()).supplier!;
    expect(purchaseCostAmountProjectionSchema.safeParse({ ...amount, documentMills: 1 }).success).toBe(false);
    expect(purchaseCostAmountProjectionSchema.safeParse({ ...amount, productMills: null }).success).toBe(false);
    expect(purchaseCostAmountProjectionSchema.safeParse({ ...amount, includedMills: 1 }).success).toBe(false);
    expect(purchaseCostAmountProjectionSchema.safeParse({ ...amount, goodsMills: 1.5 }).success).toBe(false);
  });

  it("rejects a forged numeric landed total when a required source is unknown", () => {
    const output = projectPurchaseCostAuthority(authorityInput());
    expect(purchaseCostAuthoritySchema.safeParse({ ...output, supplier: null, landedMills: 1 }).success).toBe(false);
    expect(purchaseCostAuthoritySchema.safeParse({ ...output, shipmentMills: null, landedMills: 1 }).success).toBe(false);
  });

  it("does not accept a supplier summary that mixes source currencies", () => {
    const output = projectPurchaseCostAuthority(authorityInput());
    expect(purchaseCostAuthoritySchema.safeParse({ ...output,
      selectedSources: output.selectedSources.map(source => ({ ...source, currency: "EUR" })) }).success).toBe(false);
  });
});
