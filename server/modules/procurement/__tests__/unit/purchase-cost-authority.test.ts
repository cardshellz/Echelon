import { describe, expect, it } from "vitest";
import { projectPurchaseCostAuthority } from "../../domain/purchase-cost-authority";
import { projectAuthorityAmount, PurchaseCostAuthorityError } from "../../domain/purchase-cost-authority-money";
import { authorityAmount, authorityFreight, authorityInput, authorityInvoice } from "./purchase-cost-authority.fixture";

describe("authoritative purchase money selection", () => {
  it("selects the $1,200 approved invoice plus $200 freight, retaining the $1,000 PO separately", () => {
    const input = authorityInput();
    input.invoices = [{ ...authorityInvoice(), amount: authorityAmount(12_000_000, 11_000_000) }];
    input.shipmentCostCoverage = "complete"; input.shipmentShares = [authorityFreight()];
    const before = structuredClone(input), result = projectPurchaseCostAuthority(input);
    expect(result).toMatchObject({ agreedQuote: { includedMills: 10_000_000 }, supplier: { includedMills: 12_000_000, packagingMills: 1_000_000 },
      shipmentMills: 2_000_000, landedMills: 14_000_000, sourceState: "confirmed", coverage: { confirmedPieces: 100, estimatedPieces: 0 } });
    expect(input).toEqual(before);
  });

  it("uses the explicit PO estimate before invoice approval", () => {
    expect(projectPurchaseCostAuthority(authorityInput())).toMatchObject({ sourceState: "estimated", landedMills: 10_000_000,
      supplier: { productMills: 9_000_000, packagingMills: 1_000_000 }, coverage: { estimatedPieces: 100, confirmedPieces: 0 } });
  });

  it.each(["draft", "received", "disputed", "voided"] as const)("does not use an unapproved %s bill as actual cost", status => {
    const input = authorityInput(), original = projectPurchaseCostAuthority(input);
    input.invoices = [{ ...authorityInvoice(), status }];
    expect(projectPurchaseCostAuthority(input).economicFingerprint).toBe(original.economicFingerprint);
  });

  it("uses actual covered cost and a PO estimate for the remaining pieces without assigning a receipt", () => {
    const input = authorityInput(); input.invoices = [authorityInvoice(50, 6_000_000)];
    const result = projectPurchaseCostAuthority(input);
    expect(result).toMatchObject({ sourceState: "mixed", landedMills: 11_000_000,
      coverage: { confirmedPieces: 50, estimatedPieces: 50, receiptAllocation: "decision_required" } });
    expect(result.issues.map(row => row.code)).toEqual(["INVOICE_RECEIPT_ALLOCATION_REQUIRED"]);
    expect(result.selectedSources.map(row => row.amount.includedMills)).toEqual([6_000_000, 5_000_000]);
  });

  it("accepts explicit receipt intervals without choosing historical stock itself", () => {
    const input = authorityInput();
    input.invoices = [{ ...authorityInvoice(50, 6_000_000), receiptCoverage: [{ receivingLineId: 100, startPiece: 25, pieces: 50 }] }];
    input.receiptAllocationPolicy = "explicit_receipts";
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ landedMills: 11_000_000,
      coverage: { receiptAllocation: "explicit_receipts" }, issues: [] });
  });

  it("requires an explicit decision before blending unlinked invoices", () => {
    const input = authorityInput();
    input.invoices = [authorityInvoice(50, 6_000_000), { ...authorityInvoice(50, 7_000_000), reference: { kind: "vendor_invoice_line", documentId: 21, lineId: 3 } }];
    expect(projectPurchaseCostAuthority(input).coverage.receiptAllocation).toBe("decision_required");
    input.receiptAllocationPolicy = "po_line_blended";
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ supplier: { includedMills: 13_000_000 }, coverage: { receiptAllocation: "po_line_blended" }, issues: [] });
  });

  it.each(["overlap", "outside", "exceeded"])("keeps %s invoice coverage unresolved", kind => {
    const input = authorityInput();
    input.invoices = [{ ...authorityInvoice(50, 6_000_000), receiptCoverage: [{ receivingLineId: 100, startPiece: 0, pieces: 50 }] },
      { ...authorityInvoice(50, 6_000_000), reference: { kind: "vendor_invoice_line", documentId: 21, lineId: 3 },
        receiptCoverage: [{ receivingLineId: 101, startPiece: kind === "outside" ? 90 : 25, pieces: 50 }] }];
    if (kind === "exceeded") input.invoices = [authorityInvoice(101, 12_000_000)];
    const result = projectPurchaseCostAuthority(input);
    expect(result).toMatchObject({ sourceState: "review_required", supplier: null, landedMills: null });
    expect(result.issues.some(row => row.code.startsWith("INVOICE_COVERAGE"))).toBe(true);
  });

  it("preserves a known combined bill without inventing product or packaging amounts", () => {
    const input = authorityInput(); input.invoices = [authorityInvoice()];
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ landedMills: 12_000_000,
      supplier: { productMills: null, packagingMills: null, goodsMills: 12_000_000 }, sourceState: "confirmed" });
  });

  it("accepts an explicit zero price without catalog or PO fallback", () => {
    const input = authorityInput(); input.invoices = [authorityInvoice(100, 0)];
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ supplier: { includedMills: 0 }, landedMills: 0, sourceState: "confirmed" });
  });

  it("keeps missing provisional amounts unknown rather than assuming free goods", () => {
    const input = authorityInput(); input.quote.amount = null; input.invoices = [authorityInvoice(50, 6_000_000)];
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ supplier: null, landedMills: null, sourceState: "review_required" });
  });

  it.each(["EUR", "CAD"])("does not convert %s evidence implicitly", currency => {
    const input = authorityInput(); input.invoices = [{ ...authorityInvoice(), currency }];
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ supplier: null, landedMills: null, sourceState: "review_required" });
    expect(projectPurchaseCostAuthority(input).selectedSources[0].currency).toBe(currency);
  });

  it("uses the quote's own quantity denominator for a smaller financial scope", () => {
    const input = authorityInput(); input.scope.basePieces = 80;
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ supplier: { includedMills: 8_000_000 }, landedMills: 8_000_000 });
  });

  it("does not extrapolate unapproved over-receipt costs from a smaller PO", () => {
    const input = authorityInput(); input.scope.basePieces = 110;
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ supplier: null, landedMills: null, sourceState: "review_required" });
    input.invoices = [authorityInvoice(110, 13_000_000)];
    expect(projectPurchaseCostAuthority(input).landedMills).toBe(13_000_000);
  });
});

describe("economic identity and original approval preservation", () => {
  it.each(["approved", "partially_paid", "paid"] as const)("retains the same amount and posting identity for %s", status => {
    const input = authorityInput(); input.invoices = [authorityInvoice()];
    const original = projectPurchaseCostAuthority(input);
    const approval = input.invoices[0].approval!;
    input.application = { state: "applied", economicFingerprint: original.economicFingerprint, applicationIds: [123], approvals: [approval] };
    input.invoices[0].status = status;
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ economicFingerprint: original.economicFingerprint,
      application: { state: "applied", applicationIds: [123], approvals: [approval] } });
  });

  it("retains the selected invoice identity when a superseded quote changes", () => {
    const input = authorityInput(); input.invoices = [authorityInvoice()];
    const original = projectPurchaseCostAuthority(input);
    input.quote.amount = authorityAmount(20_000_000); input.quote.sourceRevisionId = 999;
    const result = projectPurchaseCostAuthority(input);
    expect(result.economicFingerprint).toBe(original.economicFingerprint);
    expect(result.agreedQuote?.includedMills).toBe(20_000_000);
    expect(result.landedMills).toBe(12_000_000);
  });

  it("changes identity when the still-used provisional quote changes", () => {
    const input = authorityInput(); input.invoices = [authorityInvoice(50, 6_000_000)];
    const original = projectPurchaseCostAuthority(input);
    input.quote.amount = authorityAmount(20_000_000);
    expect(projectPurchaseCostAuthority(input).economicFingerprint).not.toBe(original.economicFingerprint);
  });

  it.each(["amount", "currency", "source", "withdrawn"])("invalidates an earlier application after a financial %s change", kind => {
    const input = authorityInput(); input.invoices = [authorityInvoice()];
    const original = projectPurchaseCostAuthority(input);
    input.application = { state: "applied", economicFingerprint: original.economicFingerprint, applicationIds: [123], approvals: [] };
    if (kind === "amount") input.invoices[0].amount = authorityAmount(13_000_000);
    if (kind === "currency") input.invoices[0].currency = "EUR";
    if (kind === "source") input.invoices[0].reference.lineId = 3;
    if (kind === "withdrawn") input.invoices[0].status = "voided";
    expect(projectPurchaseCostAuthority(input).application.state).toBe("source_changed");
  });

  it("does not hash timestamps or revision serials into unchanged money", () => {
    const input = authorityInput(); input.invoices = [authorityInvoice()];
    const original = projectPurchaseCostAuthority(input);
    input.invoices[0].sourceRevisionId = 999;
    input.invoices[0].approval = { actorId: "another-approved-actor", recordedAt: "2026-10-31T12:00:00Z", reference: "recorded-history" };
    expect(projectPurchaseCostAuthority(input).economicFingerprint).toBe(original.economicFingerprint);
  });

  it("is independent of invoice and receipt-interval input order", () => {
    const input = authorityInput(); input.receiptAllocationPolicy = "explicit_receipts";
    input.invoices = [{ ...authorityInvoice(50, 6_000_000), receiptCoverage: [
      { receivingLineId: 101, startPiece: 25, pieces: 25 }, { receivingLineId: 100, startPiece: 0, pieces: 25 }] },
    { ...authorityInvoice(50, 6_000_000), reference: { kind: "vendor_invoice_line", documentId: 21, lineId: 3 }, receiptCoverage: [{ receivingLineId: 102, startPiece: 50, pieces: 50 }] }];
    const original = projectPurchaseCostAuthority(input);
    input.invoices[0].receiptCoverage!.reverse(); input.invoices.reverse();
    expect(projectPurchaseCostAuthority(input).economicFingerprint).toBe(original.economicFingerprint);
  });

  it("keeps adjustment ordering out of the selected economic identity", () => {
    const input = authorityInput(), invoice = authorityInvoice();
    invoice.amount.adjustments = [
      { key: "tax", category: "tax", amountMills: 200, treatment: "inventory" },
      { key: "discount", category: "discount", amountMills: -200, treatment: "inventory" },
    ];
    input.invoices = [invoice];
    const original = projectPurchaseCostAuthority(input);
    input.invoices[0].amount.adjustments.reverse();
    expect(projectPurchaseCostAuthority(input).economicFingerprint).toBe(original.economicFingerprint);
  });

  it("retains original approval details but rejects completion while allocation is unresolved", () => {
    const input = authorityInput(); input.invoices = [authorityInvoice(50, 6_000_000)];
    const original = projectPurchaseCostAuthority(input);
    const approval = input.invoices[0].approval!;
    input.application = { state: "applied", economicFingerprint: original.economicFingerprint, applicationIds: [123], approvals: [approval] };
    expect(projectPurchaseCostAuthority(input).application).toEqual({ state: "review_required", applicationIds: [123], approvals: [approval] });
  });
});

describe("charge shares, adjustments and exact amount conservation", () => {
  it("does not mistake missing charges for a confirmed zero", () => {
    const input = authorityInput(); input.shipmentCostCoverage = "awaiting_source";
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ shipmentMills: null, landedMills: null, sourceState: "review_required" });
  });

  it("keeps a saved allocation stale until it matches the selected charge source", () => {
    const input = authorityInput(); input.shipmentCostCoverage = "complete";
    input.shipmentShares = [{ ...authorityFreight(), sourceAmountMills: 2_200_000 }];
    expect(projectPurchaseCostAuthority(input).landedMills).toBeNull();
  });

  it.each(["currency", "missing", "review", "wrong-owner", "negative-noncredit"])("requires charge review for %s evidence", kind => {
    const input = authorityInput(), share = authorityFreight(); input.shipmentCostCoverage = "complete";
    if (kind === "currency") share.currency = "CAD";
    if (kind === "missing") share.allocatedMills = null;
    if (kind === "review") share.evidence = "review_required";
    if (kind === "wrong-owner") share.reference.documentId = 99;
    if (kind === "negative-noncredit") {
      share.sourceAmountMills = -100; share.allocationSourceAmountMills = -100; share.allocatedMills = -100;
    }
    input.shipmentShares = [share];
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ shipmentMills: null, landedMills: null, sourceState: "review_required" });
  });

  it("accepts an explicitly recorded zero shipment charge", () => {
    const input = authorityInput(); input.shipmentCostCoverage = "complete";
    input.shipmentShares = [{ ...authorityFreight(), sourceAmountMills: 0, allocationSourceAmountMills: 0, allocatedMills: 0 }];
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ shipmentMills: 0, landedMills: 10_000_000, issues: [] });
  });

  it("does not add an entire consolidated charge to this PO's smaller share", () => {
    const input = authorityInput(); input.shipmentCostCoverage = "complete";
    input.shipmentShares = [{ ...authorityFreight(), allocatedMills: 500_000 }];
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ shipmentMills: 500_000, landedMills: 10_500_000 });
  });

  it("rejects shares that cumulatively exceed the same charge", () => {
    const input = authorityInput(); input.shipmentCostCoverage = "complete";
    input.shipmentShares = [authorityFreight(), { ...authorityFreight(), shipmentLineId: 31 }];
    expect(projectPurchaseCostAuthority(input).issues.map(row => row.code)).toContain("SHIPMENT_SHARE_EXCEEDED");
  });

  it.each(["shipment", "category", "evidence"])("rejects conflicting %s facts for the same charge", kind => {
    const input = authorityInput(); input.shipmentCostCoverage = "complete";
    const second = { ...authorityFreight(), shipmentLineId: 31, allocatedMills: 500_000 };
    if (kind === "shipment") second.shipmentId = 99;
    if (kind === "category") second.category = "duty";
    if (kind === "evidence") second.evidence = "estimated";
    input.shipmentShares = [{ ...authorityFreight(), allocatedMills: 500_000 }, second];
    expect(projectPurchaseCostAuthority(input).landedMills).toBeNull();
  });

  it("retains a provisional charge as part of the total without declaring all costs confirmed", () => {
    const input = authorityInput(); input.invoices = [authorityInvoice()]; input.shipmentCostCoverage = "complete";
    input.shipmentShares = [{ ...authorityFreight(), evidence: "estimated" }];
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ landedMills: 14_000_000, sourceState: "mixed" });
  });

  it("rejects two charges claiming the same invoice source amount", () => {
    const input = authorityInput(); input.shipmentCostCoverage = "complete";
    input.shipmentShares = [authorityFreight(), { ...authorityFreight(), chargeId: 41 }];
    expect(projectPurchaseCostAuthority(input).landedMills).toBeNull();
  });

  it("does not count an invoiced supplier amount again as a shipment charge", () => {
    const input = authorityInput(); input.invoices = [authorityInvoice()]; input.shipmentCostCoverage = "complete";
    input.shipmentShares = [{ ...authorityFreight(), reference: input.invoices[0].reference }];
    const result = projectPurchaseCostAuthority(input);
    expect(result.supplier?.includedMills).toBe(12_000_000);
    expect(result.shipmentMills).toBeNull();
    expect(result.landedMills).toBeNull();
    expect(result.issues.map(row => row.code)).toContain("COST_SOURCE_COUNTED_TWICE");
  });

  it("recognizes an explicit supplier credit once without creating an expense", () => {
    const input = authorityInput(); input.shipmentCostCoverage = "complete";
    input.shipmentShares = [{ ...authorityFreight(), reference: { kind: "supplier_credit_line", documentId: 60, lineId: 61 },
      sourceAmountMills: -100_000, allocationSourceAmountMills: -100_000, allocatedMills: -100_000 }];
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ shipmentMills: -100_000, landedMills: 9_900_000 });
  });

  it.each(["inventory", "excluded", "unclassified"] as const)("respects explicit %s tax treatment", treatment => {
    const input = authorityInput(), invoice = authorityInvoice();
    invoice.amount.documentTotalMills += 1_000_000;
    invoice.amount.adjustments = [{ key: "tax-1", category: "tax", amountMills: 1_000_000, treatment }]; input.invoices = [invoice];
    const result = projectPurchaseCostAuthority(input);
    expect(result.supplier?.documentMills).toBe(13_000_000);
    expect(result.landedMills).toBe(treatment === "unclassified" ? null : treatment === "inventory" ? 13_000_000 : 12_000_000);
  });

  it("applies an explicitly classified discount that reconciles to the invoice", () => {
    const input = authorityInput(), invoice = authorityInvoice();
    invoice.amount.documentTotalMills -= 500_000;
    invoice.amount.adjustments = [{ key: "discount-1", category: "discount", amountMills: -500_000, treatment: "inventory" }]; input.invoices = [invoice];
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ supplier: { inventoryAdjustmentsMills: -500_000 }, landedMills: 11_500_000 });
  });

  it("does not let two unclassified adjustments cancel into false completion", () => {
    const input = authorityInput(), invoice = authorityInvoice();
    invoice.amount.adjustments = [{ key: "tax", category: "tax", amountMills: 100, treatment: "unclassified" },
      { key: "credit", category: "other", amountMills: -100, treatment: "unclassified" }]; input.invoices = [invoice];
    expect(projectPurchaseCostAuthority(input)).toMatchObject({ supplier: { unclassifiedAdjustmentsMills: 0, includedMills: null }, landedMills: null });
  });

  it("requires review when an excluded adjustment would leave negative supplier inventory cost", () => {
    const input = authorityInput(), invoice = authorityInvoice(100, 100);
    invoice.amount.adjustments = [
      { key: "credit", category: "supplier_credit", amountMills: -200, treatment: "inventory" },
      { key: "tax", category: "tax", amountMills: 200, treatment: "excluded" },
    ]; input.invoices = [invoice];
    const result = projectPurchaseCostAuthority(input);
    expect(result).toMatchObject({ supplier: { documentMills: 100, includedMills: -100 }, landedMills: null });
    expect(result.issues.map(row => row.code)).toContain("COST_NEGATIVE_SUPPLIER_AMOUNT");
  });

  it("requires review when shipment credits exceed the selected supplier cost", () => {
    const input = authorityInput(); input.quote.amount = authorityAmount(100); input.shipmentCostCoverage = "complete";
    input.shipmentShares = [{ ...authorityFreight(), reference: { kind: "supplier_credit_line", documentId: 60, lineId: 61 },
      sourceAmountMills: -200, allocationSourceAmountMills: -200, allocatedMills: -200 }];
    const result = projectPurchaseCostAuthority(input);
    expect(result.landedMills).toBeNull();
    expect(result.issues.map(row => row.code)).toContain("COST_NEGATIVE_LANDED_AMOUNT");
  });

  it("conserves a rounded provisional total across small product/packaging components", () => {
    const result = projectAuthorityAmount(authorityAmount(2, 1), 1, 3);
    expect(result.documentMills).toBe(1);
    expect(result.goodsMills).toBe(result.productMills! + result.packagingMills!);
    expect(result.includedMills).toBe(1);
  });

  it("conserves signed adjustments and exact totals across a deterministic quantity matrix", () => {
    for (let product = 1; product <= 12; product++) for (let quantity = 1; quantity <= 7; quantity++) {
      const amount = authorityAmount(product + 3, product);
      amount.documentTotalMills -= 1;
      amount.adjustments = [{ key: "discount", category: "discount", amountMills: -1, treatment: "inventory" }];
      const result = projectAuthorityAmount(amount, quantity, 7);
      expect(result.documentMills).toBe(result.goodsMills + result.inventoryAdjustmentsMills);
      expect(result.goodsMills).toBe(result.productMills! + result.packagingMills!);
    }
  });

  it.each([[1, 0], [-1, 3], [4, 3], [1.5, 3]])("rejects an invalid projection quantity %s/%s", (quantity, denominator) => {
    expect(() => projectAuthorityAmount(authorityAmount(10), quantity, denominator)).toThrowError(expect.objectContaining({ code: "PURCHASE_COST_QUANTITY_INVALID" }));
  });

  it("fails explicitly instead of losing precision when totals exceed safe integers", () => {
    const input = authorityInput(); input.quote.amount = authorityAmount(Number.MAX_SAFE_INTEGER);
    input.shipmentCostCoverage = "complete"; input.shipmentShares = [authorityFreight()];
    expect(() => projectPurchaseCostAuthority(input)).toThrowError(PurchaseCostAuthorityError);
    try { projectPurchaseCostAuthority(input); } catch (error) {
      expect(error).toMatchObject({ code: "PURCHASE_COST_AUTHORITY_RANGE" });
    }
  });
});
