import { describe, expect, it } from "vitest";
import { evaluateSupplierCreditSource, resolveSupplierCreditReductions, type SupplierCreditCostRow } from "../../domain/supplier-credit-source";
import { resolvePurchaseCostSource } from "../../domain/purchase-cost-source";
import { resolveShipmentSupplierCredits } from "../../domain/shipment-supplier-credits";
import type { SourceLineInput } from "@shared/procurement/supplier-credit";
import { summarizeInvoiceCostReconciliation } from "../../domain/invoice-cost-reconciliation-summary";
import { projectPurchaseComponentStatus } from "../../domain/purchase-cost-status";

const invoice = { id: 72, vendor_invoice_id: 71, purchase_order_line_id: 21, freight_cost_id: null, currency: "USD",
  qty_invoiced: 100, line_total_cents: 1200,
  cost_component_evidence: { contractVersion: 1, productMills: 100000, packagingMills: 20000, adjustmentMills: 0, packagingTreatment: "separate", source: "operator_review" } };
const po = { id: 21, purchase_order_id: 10, order_qty: 100, received_qty: 100, status: "received",
  total_product_cost_cents: 1000, packaging_cost_cents: 200, currency: "USD" };
const product: SourceLineInput = { invoiceLineId: 72, amountCents: 100, disposition: { kind: "price_reduction", component: "product" } };
const returned: SourceLineInput = { invoiceLineId: 72, amountCents: 240, disposition: { kind: "quarantine_return", returnDispositionId: 14, quantity: 2, evidenceReference: "COLLECTION-14" } };
const returnSource = { dispositionId: 14, observationId: 12, receivingLineId: 31, purchaseOrderLineId: 21,
  productId: 1, productVariantId: 2, unitsPerVariant: 10, observationQuantity: 2, evidenceReference: "COLLECTION-14" };
function credit(line = product, id = 1, sourceInvoice = invoice, sourceReturn = undefined as typeof returnSource | undefined): SupplierCreditCostRow {
  return { id, supplier_credit_id: 9, invoice_line_id: 72, amount_cents: line.amountCents, disposition: line.disposition,
    status: "approved", source_evidence: evaluateSupplierCreditSource({ line, invoice: sourceInvoice, returnSource: sourceReturn }).sourceEvidence };
}

describe("supplier credits use explicit immutable invoice component evidence", () => {
  it("reduces product price without changing gross invoice, units, or packaging", () => {
    const source = { purchaseOrderLine: po, approvedInvoices: [invoice], supplierCredits: [credit()] };
    const before = structuredClone(source);
    expect(resolvePurchaseCostSource(source)).toMatchObject([
      { component: "product", totalMills: 90000, basePieces: 100, evidence: "confirmed" },
      { component: "packaging", totalMills: 20000, basePieces: 100, evidence: "confirmed" },
    ]);
    expect(source).toEqual(before);
    expect(resolvePurchaseCostSource(source)[0].sources).toContainEqual(expect.objectContaining({ kind: "supplier_credit_line", documentId: 9, lineId: 1 }));
  });
  it("supports separate product and packaging credits on the same invoice line", () => {
    const packaging: SourceLineInput = { ...product, amountCents: 50, disposition: { kind: "price_reduction", component: "packaging" } };
    expect(resolvePurchaseCostSource({ purchaseOrderLine: po, approvedInvoices: [invoice], supplierCredits: [credit(), credit(packaging, 2)] }))
      .toMatchObject([{ totalMills: 90000 }, { totalMills: 15000 }]);
  });
  it("restores gross source on void while retaining compensating credit identity", () => {
    const value = credit(); value.status = "voided";
    const sources = resolvePurchaseCostSource({ purchaseOrderLine: po, approvedInvoices: [invoice], supplierCredits: [value] });
    expect(sources).toMatchObject([{ totalMills: 100000, evidence: "confirmed" }, { totalMills: 20000, evidence: "confirmed" }]);
    expect(sources[0].sources.some(source => source.kind === "supplier_credit_line")).toBe(true);
  });
  it("invoice reconciliation accepts current net invoice/credit authority but not credit-only or mixed quote sources", () => {
    const contracts = resolvePurchaseCostSource({ purchaseOrderLine: po, approvedInvoices: [invoice], supplierCredits: [credit()] });
    const result = { costSources: contracts.map((contract, index) => ({ id: index + 1,
      contract: { ...contract, revision: 1, fingerprint: "a".repeat(64) } })),
    costApplications: [{ status: "applied" as const }, { status: "applied" as const }] };
    expect(summarizeInvoiceCostReconciliation(result)).toMatchObject({ state: "confirmed_invoice_cost", authoritativeUnitCostMills: 900 });
    for (const source of result.costSources) source.contract.sources = source.contract.sources.filter(reference => reference.kind === "supplier_credit_line");
    expect(summarizeInvoiceCostReconciliation(result).state).toBe("review_required");
    for (const source of result.costSources) source.contract.sources.push({ kind: "purchase_order_line", documentId: 10, lineId: 21, version: "b".repeat(64) });
    expect(summarizeInvoiceCostReconciliation(result).state).toBe("review_required");
  });
  it("rejects cumulative credits that exceed one component even when invoice total permits it", () => {
    const large = { ...product, amountCents: 600 };
    const result = resolvePurchaseCostSource({ purchaseOrderLine: po, approvedInvoices: [invoice], supplierCredits: [credit(large), credit(large, 2)] });
    expect(result.every(source => source.evidence === "review_required")).toBe(true);
    expect(result[0].issue?.code).toBe("CREDIT_SOURCE_EXCEEDED");
    expect(result[0].totalMills).toBeGreaterThanOrEqual(0);
  });
  it("does not apply a credit when the approved invoice's component evidence changes", () => {
    const changed = { ...invoice, cost_component_evidence: { ...invoice.cost_component_evidence, productMills: 110000, packagingMills: 10000 } };
    expect(resolvePurchaseCostSource({ purchaseOrderLine: po, approvedInvoices: [changed], supplierCredits: [credit()] })[0])
      .toMatchObject({ evidence: "review_required", issue: { code: "CREDIT_SOURCE_CHANGED" } });
  });
  it.each([{ purchaseOrderLineId: 22 }, { freightCostId: 31 }])("rejects a frozen product source with altered identity %j", scope => {
    const value = credit();
    value.source_evidence = { ...(value.source_evidence as Record<string, unknown>), ...scope };
    expect(resolvePurchaseCostSource({ purchaseOrderLine: po, approvedInvoices: [invoice], supplierCredits: [value] })[0])
      .toMatchObject({ evidence: "review_required", issue: { code: "CREDIT_SOURCE_SCOPE_MISMATCH" } });
  });
  it("verifies the selected PO scope even when existing gross invoice fingerprints omit the field", () => {
    const { purchase_order_line_id: _scope, ...grossInvoice } = invoice;
    const value = credit();
    expect(resolvePurchaseCostSource({ purchaseOrderLine: po, approvedInvoices: [grossInvoice], supplierCredits: [value] })[0].evidence).toBe("confirmed");
    expect(resolvePurchaseCostSource({ purchaseOrderLine: { ...po, id: 22 }, approvedInvoices: [grossInvoice], supplierCredits: [value] })[0].issue?.code).toBe("CREDIT_SOURCE_SCOPE_MISMATCH");
  });
  it("keeps unsupported invoice adjustments explicit", () => {
    const value = evaluateSupplierCreditSource({ line: product, invoice: { ...invoice, cost_component_evidence: { ...invoice.cost_component_evidence, adjustmentMills: 1 } } });
    expect(value).toMatchObject({ costState: "review_required", costIssues: [{ code: "CREDIT_COMPONENT_SOURCE_REVIEW" }] });
  });
  it("removes returned original quantity and both exact original components, preserving retained unit cost", () => {
    const value = credit(returned, 1, invoice, returnSource);
    expect(resolvePurchaseCostSource({ purchaseOrderLine: { ...po, received_qty: 80 }, approvedInvoices: [invoice], supplierCredits: [value] }))
      .toMatchObject([{ totalMills: 80000, basePieces: 80, evidence: "confirmed" }, { totalMills: 16000, basePieces: 80, evidence: "confirmed" }]);
  });
  it.each(["open", "received", "closed"])("describes an exact full quarantine return without inventing a denominator for a %s source", status => {
    const fullReturn = { ...returned, amountCents: 1200, disposition: { ...returned.disposition, quantity: 10 } } as SourceLineInput;
    const value = credit(fullReturn, 1, invoice, { ...returnSource, observationQuantity: 10 });
    const contracts = resolvePurchaseCostSource({ purchaseOrderLine: { ...po, received_qty: 0, status }, approvedInvoices: [invoice], supplierCredits: [value] });
    expect(contracts).toMatchObject([
      { component: "product", totalMills: 0, basePieces: 0, evidence: "confirmed", issue: null,
        inventoryEffect: { kind: "none", reason: "full_quarantine_return", returnedBasePieces: 100 } },
      { component: "packaging", totalMills: 0, basePieces: 0, evidence: "confirmed", issue: null,
        inventoryEffect: { kind: "none", reason: "full_quarantine_return", returnedBasePieces: 100 } },
    ]);
    // Source arithmetic alone cannot override a missing live inventory proof.
    for (const input of contracts) expect(projectPurchaseComponentStatus({ input, currentFingerprint: "a".repeat(64),
      revision: { id: 1, contract: { ...input, revision: 1, fingerprint: "a".repeat(64) } },
      application: { id: 1, status: "applied", reportingVerified: true, evidence: { lotIds: [], result: { status: "applied", lotsUpdated: 0, issues: [] } } },
      lotIds: [], unprovenLotIds: [], changedLots: [] }).status).toBe("review_required");
    expect(summarizeInvoiceCostReconciliation({ costSources: contracts.map((contract, index) => ({ id: index + 1,
      contract: { ...contract, revision: 1, fingerprint: "a".repeat(64) } })), costApplications: [{ status: "review_required" }, { status: "review_required" }] }))
      .toMatchObject({ state: "review_required", authoritativeUnitCostMills: null });
  });
  it("does not disguise malformed or excessive full-return evidence as the supported-source boundary", () => {
    const fullReturn = { ...returned, amountCents: 1200, disposition: { ...returned.disposition, quantity: 10 } } as SourceLineInput;
    const value = credit(fullReturn, 1, invoice, { ...returnSource, observationQuantity: 10 });
    for (const credits of [[{ ...value, source_evidence: {} }], [value, { ...value, id: 2 }]]) {
      expect(resolveSupplierCreditReductions([invoice], credits).issues.length).toBeGreaterThan(0);
      expect(resolvePurchaseCostSource({ purchaseOrderLine: { ...po, received_qty: 0 }, approvedInvoices: [invoice], supplierCredits: credits })
        .every(source => source.evidence === "review_required" && source.issue?.code !== "CREDIT_FULL_QUARANTINE_RETURN_COST_REVIEW")).toBe(true);
    }
  });
  it.each([239, 241])("keeps an unexplained return credit difference of %i cents in review", amountCents => {
    const value = evaluateSupplierCreditSource({ line: { ...returned, amountCents }, invoice, returnSource });
    expect(value).toMatchObject({ costState: "review_required", sourceEvidence: { reduction: { basePieces: 0, productMills: 0, packagingMills: 0 } }, costIssues: [{ code: "CREDIT_RETURN_VALUE_REVIEW" }] });
  });
  it("does not invent a return source for unknown goods", () => {
    expect(evaluateSupplierCreditSource({ line: returned, invoice })).toMatchObject({ costState: "review_required", costIssues: [{ code: "CREDIT_RETURN_SOURCE_REVIEW" }] });
  });
  it("rejects return evidence bound to a different original purchase line", () => {
    const value = credit(returned, 1, invoice, { ...returnSource, purchaseOrderLineId: 22 });
    expect(resolveSupplierCreditReductions([invoice], [value]).issues[0].code).toBe("CREDIT_SOURCE_DISPOSITION_MISMATCH");
  });
  it("requires exact integer component allocation instead of rounding a return", () => {
    const odd = { ...invoice, qty_invoiced: 3 };
    expect(evaluateSupplierCreditSource({ line: { ...returned, amountCents: 400 }, invoice: odd,
      returnSource: { ...returnSource, unitsPerVariant: 1, observationQuantity: 1 } }).costState).toBe("review_required");
  });
  it("retains invalid stored evidence as review rather than treating it as zero credit", () => {
    expect(resolveSupplierCreditReductions([invoice], [{ ...credit(), source_evidence: {} }]).issues[0].code).toBe("CREDIT_SOURCE_CHANGED");
  });
  it("rejects duplicated credit identities without counting the same reduction twice", () => {
    const value = credit();
    const result = resolveSupplierCreditReductions([invoice], [value, value]);
    expect(result.productMills).toBe(BigInt(10000));
    expect(result.sources).toHaveLength(1);
    expect(result.issues[0].code).toBe("CREDIT_SOURCE_DUPLICATE");
    expect(resolvePurchaseCostSource({ purchaseOrderLine: po, approvedInvoices: [invoice], supplierCredits: [value, value] })[0].evidence).toBe("review_required");
  });
  it.each([{}, { kind: "price_reduction", component: "packaging" }, { kind: "receipt_reversal", id: 14 }])("rejects malformed or contradictory disposition %j", disposition => {
    expect(resolveSupplierCreditReductions([invoice], [{ ...credit(), disposition }]).issues[0].code).toBe("CREDIT_SOURCE_DISPOSITION_MISMATCH");
  });
});

describe("explicit landed credits preserve gross charges and allocate exact net cents", () => {
  const freightInvoice = { ...invoice, purchase_order_line_id: null, freight_cost_id: 31, line_total_cents: 2, qty_invoiced: 1, cost_component_evidence: null };
  const landed: SourceLineInput = { invoiceLineId: 72, amountCents: 1, disposition: { kind: "price_reduction", component: "landed" } };
  const charge = { id: 31, actual_cents: 2, estimated_cents: null };
  const allocations = [{ shipment_cost_id: 31, inbound_shipment_line_id: 11, allocated_cents: 1 }, { shipment_cost_id: 31, inbound_shipment_line_id: 12, allocated_cents: 1 }];
  const row = (id: number): SupplierCreditCostRow => ({ id, supplier_credit_id: id, invoice_line_id: 72, amount_cents: 1, disposition: landed.disposition,
    status: "approved", source_evidence: evaluateSupplierCreditSource({ line: landed, invoice: freightInvoice }).sourceEvidence });
  it("aggregates repeated one-cent credits before allocating so neither line becomes negative", () => {
    const input = { charges: [charge], allocations, invoices: [freightInvoice], credits: [row(1), row(2)] };
    const before = structuredClone(input);
    const result = resolveShipmentSupplierCredits(input);
    expect(result.issues).toEqual([]);
    expect(result.allocations.map(value => value.allocated_cents)).toEqual([0, 0]);
    expect(input).toEqual(before);
  });
  it("restores the original allocation by excluding voided economic effects", () => {
    const result = resolveShipmentSupplierCredits({ charges: [charge], allocations, invoices: [freightInvoice], credits: [{ ...row(1), status: "voided" }] });
    expect(result.allocations).toEqual(allocations);
    expect(result.sources[0].kind).toBe("supplier_credit_line");
  });
  it("retains missing or negative gross charge allocations as review", () => {
    const result = resolveShipmentSupplierCredits({ charges: [{ ...charge, actual_cents: -2 }], allocations, invoices: [freightInvoice], credits: [row(1)] });
    expect(result.issues[0].code).toBe("CREDIT_LANDED_ALLOCATION_REVIEW");
    expect(result.allocations).toEqual(allocations);
  });
  it.each([{ purchaseOrderLineId: 21 }, { freightCostId: 32 }])("rejects a frozen landed source with altered identity %j", scope => {
    const value = row(1);
    value.source_evidence = { ...(value.source_evidence as Record<string, unknown>), ...scope };
    expect(resolveShipmentSupplierCredits({ charges: [charge], allocations, invoices: [freightInvoice], credits: [value] }).issues[0].code)
      .toBe("CREDIT_LANDED_SOURCE_CHANGED");
  });
  it("does not reinterpret an unrelated legacy negative charge as an explicit supplier credit", () => {
    const result = resolveShipmentSupplierCredits({ charges: [charge, { id: 32, actual_cents: -1 }], allocations: [...allocations, { shipment_cost_id: 32, inbound_shipment_line_id: 11, allocated_cents: -1 }], invoices: [], credits: [] });
    expect(result.allocations[2].allocated_cents).toBe(-1);
    expect(result.creditedCentsByCharge.size).toBe(0);
  });
});
