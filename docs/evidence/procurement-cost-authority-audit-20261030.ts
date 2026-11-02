import assert from "node:assert/strict";
import { resolvePurchaseCostSource } from "../../server/modules/procurement/domain/purchase-cost-source";
import { projectPoLineLandedCosts } from "../../shared/procurement/po-line-landed-cost";
import { buildShipmentAllocationBasis, buildShipmentAllocationEvidence, projectShipmentProductValue } from "../../server/modules/procurement/domain/shipment-allocation-basis";
import { resolveShipmentChargeEvidence } from "../../server/modules/procurement/domain/shipment-charge-evidence";
import { projectPurchaseComponentStatus, type CurrentPurchaseComponentEvidence } from "../../server/modules/procurement/domain/purchase-cost-status";
import { retainEquivalentShipmentCostSource, type ShipmentCostProposal } from "../../server/modules/procurement/shipment-cost-source-identity";
import { currentShipmentCostSourceIssue } from "../../server/modules/procurement/domain/current-shipment-cost-source";
import { costFingerprint } from "../../server/modules/inventory/infrastructure/cost-evidence-values";

// Pure, synthetic characterization only. No database, production records,
// financial writer, credentials or network access is used by this script.
const quote = { id: 1, purchase_order_id: 10, order_qty: 100, received_qty: 100,
  status: "received", total_product_cost_cents: 90_000, packaging_cost_cents: 10_000,
  discount_cents: 0, tax_cents: 0, currency: "USD" };
const invoice = { id: 2, vendor_invoice_id: 20, qty_invoiced: 100,
  line_total_cents: 120_000, currency: "USD", cost_component_evidence: {
    contractVersion: 1, source: "operator_review", packagingTreatment: "separate",
    productMills: 11_000_000, packagingMills: 1_000_000, adjustmentMills: 0,
  } };
const describeSources = (approvedInvoices: Record<string, unknown>[]) => {
  const result = resolvePurchaseCostSource({ purchaseOrderLine: quote, approvedInvoices });
  return result.map(source => ({ component: source.component, amountMills: source.totalMills,
    basePieces: source.basePieces, evidence: source.evidence,
    issue: source.issue?.code ?? null, sourceKinds: source.sources.map(reference => reference.kind) }));
};
const noInvoice = describeSources([]);
assert.ok(noInvoice.every(source => source.evidence === "estimated"));
const fullInvoice = describeSources([invoice]);
assert.ok(fullInvoice.every(source => source.evidence === "confirmed"));
assert.equal(fullInvoice.reduce((total, source) => total + source.amountMills!, 0), 12_000_000);
const partialInvoice = describeSources([{ ...invoice, qty_invoiced: 50, line_total_cents: 60_000,
  cost_component_evidence: { ...invoice.cost_component_evidence, productMills: 5_500_000, packagingMills: 500_000 } }]);
assert.ok(partialInvoice.every(source => source.evidence === "review_required"));
assert.equal(partialInvoice.reduce((total, source) => total + source.amountMills!, 0), 10_000_000);
const missingBreakdown = describeSources([{ ...invoice, cost_component_evidence: null }]);
assert.ok(missingBreakdown.every(source => source.issue === "INVOICE_COMPONENT_REVIEW_REQUIRED"));
const invoiceDiscount = describeSources([{ ...invoice, line_total_cents: 115_000,
  cost_component_evidence: { ...invoice.cost_component_evidence, adjustmentMills: -500_000 } }]);
assert.ok(invoiceDiscount.every(source => source.issue === "INVOICE_COMPONENT_TOTAL_REVIEW"));

const poDisplay = projectPoLineLandedCosts({
  poHeader: { totalCents: 100_000 },
  poLines: [{ id: 1, orderQty: 100, lineTotalCents: 100_000, status: "received" }],
  costs: { summary: { totalCents: 20_000, poAmountCents: 100_000, combinedCostCents: 120_000 },
    lines: [{ lineId: 30, purchaseOrderLineId: 1, allocatedCents: 20_000 }] },
});
assert.equal(poDisplay.status, "complete");
assert.equal(poDisplay.status === "complete" ? poDisplay.lines[0].totalCents : null, 120_000);
const shipmentDisplay = projectShipmentProductValue(buildShipmentAllocationEvidence(buildShipmentAllocationBasis([
  { lineId: 30, qtyShipped: 100, poLineId: 1, poOrderQty: 100, poTotalProductCostCents: 90_000,
    poCurrency: "USD", totalVolumeCbm: null, totalWeightKg: null, chargeableWeightKg: null },
], "by_value"), 30), 20_000);
assert.equal(shipmentDisplay.totalLandedCostCents, 110_000);

const charge = { id: 40, shipmentId: 50, vendorId: 60, invoiceId: 70, costType: "freight",
  allocationMethod: "by_weight", currency: "USD", actualCents: null, estimatedCents: 20_000, status: "invoiced" };
const freightBill = { id: 80, invoiceId: 70, freightCostId: 40, vendorId: 60, shipmentId: 50,
  currency: "USD", status: "approved", invoiceTotalCents: 22_000, documentLinesTotalCents: 22_000,
  quantity: 1, unitCostMills: 2_200_000, unitCostCents: 22_000, lineTotalCents: 22_000 };
const freightVariance = resolveShipmentChargeEvidence({ charge, invoices: [freightBill], priorConfirmedCharge: null });
assert.equal(freightVariance.issue?.code, "LANDED_INVOICE_AMOUNT_REVIEW");
const matchingCharge = { ...charge, estimatedCents: 22_000 };
const freightPaymentStates = ["approved", "partially_paid", "paid"].map(status => ({ status,
  result: resolveShipmentChargeEvidence({ charge: matchingCharge, invoices: [{ ...freightBill, status }], priorConfirmedCharge: null }) }));
assert.ok(freightPaymentStates.every(item => item.result.evidence === "confirmed"));
assert.deepEqual(freightPaymentStates[0].result, freightPaymentStates[1].result);
assert.deepEqual(freightPaymentStates[0].result, freightPaymentStates[2].result);

const selectedProduct = resolvePurchaseCostSource({ purchaseOrderLine: quote, approvedInvoices: [invoice] })[0];
const completion: CurrentPurchaseComponentEvidence = {
  input: selectedProduct, currentFingerprint: "a".repeat(64),
  revision: { id: 1, contract: { ...selectedProduct, revision: 1, fingerprint: "a".repeat(64) } },
  application: { id: 2, status: "applied", reportingVerified: true,
    evidence: { lotIds: [901], result: { status: "applied", lotsUpdated: 1, issues: [] } } },
  lotIds: [901], unprovenLotIds: [],
  changedLots: [{ lotId: 901, component: "product", amountMatches: true }],
};
const originalCompletion = projectPurchaseComponentStatus(completion);
assert.equal(originalCompletion.status, "applied");
const descendantCompletion = projectPurchaseComponentStatus({ ...completion, lotIds: [901, 902] });
assert.equal(descendantCompletion.status, "review_required");
assert.ok(descendantCompletion.issues.some(issue => issue.code === "COST_APPLICATION_SCOPE_CHANGED"));

function shipmentProposalForInvoiceStatus(status: string): ShipmentCostProposal {
  // These raw fields include the invoice.status selected by the live evidence reader.
  const row = { id: 80, vendor_invoice_id: 70, freight_cost_id: 40, qty_invoiced: 1,
    line_total_cents: 22_000, status, purchase_order_line_id: null, product_variant_id: null };
  return { input: { contractVersion: 1, component: "landed", scope: { kind: "shipment_line",
    purchaseOrderId: 10, purchaseOrderLineId: 1, inboundShipmentId: 50, inboundShipmentLineId: 30 },
    sources: [{ kind: "vendor_invoice_line", documentId: 70, lineId: 80, version: costFingerprint(row) }],
    currency: "USD", totalMills: 2_200_000, basePieces: 100, evidence: "confirmed",
    packagingTreatment: "not_applicable", issue: null, manualOverride: null },
    sourceEvidence: { invoices: [row] } };
}
const approvedProposal = shipmentProposalForInvoiceStatus("approved");
const savedFingerprint = costFingerprint(approvedProposal);
const approvedContract = { ...approvedProposal.input, revision: 1, fingerprint: savedFingerprint };
const paidProposal = retainEquivalentShipmentCostSource(shipmentProposalForInvoiceStatus("paid"), {
  contract: approvedContract, fingerprint: savedFingerprint, source_evidence: approvedProposal.sourceEvidence,
});
const paymentOnlySourceIssue = currentShipmentCostSourceIssue({ lineId: 30, shipmentId: 50,
  contract: approvedContract, currentFingerprint: costFingerprint(paidProposal) });
assert.equal(approvedProposal.input.totalMills, paidProposal.input.totalMills);
assert.notEqual(savedFingerprint, costFingerprint(paidProposal));
assert.equal(paymentOnlySourceIssue?.code, "COST_UPDATE_OUTDATED");

const originalSupplierEvidence = { purchaseOrderLine: quote, approvedInvoices: [invoice] };
const changedQuoteEvidence = { purchaseOrderLine: { ...quote, total_product_cost_cents: 100_000 }, approvedInvoices: [invoice] };
const originalSupplierInput = resolvePurchaseCostSource(originalSupplierEvidence)[0];
const changedQuoteInput = resolvePurchaseCostSource(changedQuoteEvidence)[0];
assert.deepEqual(originalSupplierInput, changedQuoteInput);
assert.notEqual(costFingerprint({ input: originalSupplierInput, sourceEvidence: originalSupplierEvidence }),
  costFingerprint({ input: changedQuoteInput, sourceEvidence: changedQuoteEvidence }));

console.log(JSON.stringify({
  purpose: "Characterize current production domain functions against the agreed costing design",
  noInvoice, fullInvoice, partialInvoice, missingBreakdown, invoiceDiscount,
  differentCostProjectionsForSameSyntheticGoods: {
    selectedSupplierInvoiceCents: 120_000, allocatedShipmentCents: 20_000,
    agreedDesignLandedCents: 140_000,
    poProjectionCents: poDisplay.status === "complete" ? poDisplay.lines[0].totalCents : null,
    shipmentProjectionCents: shipmentDisplay.totalLandedCostCents,
  },
  freightVariance, freightPaymentStates,
  savedApplicationThenNewDescendant: { before: originalCompletion, after: descendantCompletion },
  paymentOnlySourceChange: { unchangedAmountMills: paidProposal.input.totalMills, issue: paymentOnlySourceIssue },
  quoteEditAfterInvoice: { unchangedSelectedInvoiceAmountMills: changedQuoteInput.totalMills,
    selectedInputUnchanged: true, wholeSourceFingerprintChanges: true },
}, null, 2));
