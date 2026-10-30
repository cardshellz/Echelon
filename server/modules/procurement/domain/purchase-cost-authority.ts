import {
  purchaseCostAuthorityInputSchema, purchaseCostAuthoritySchema,
  type PurchaseCostAmount, type PurchaseCostAuthority, type PurchaseCostAuthorityInput, type PurchaseCostInvoice,
} from "@shared/procurement/purchase-cost-authority";
import type { CostIssue } from "@shared/procurement/cost-source-contracts";
import { costFingerprint } from "../../inventory/domain/cost-fingerprint";
import { exactAuthorityMoney, projectAuthorityAmount, PurchaseCostAuthorityError, sumAuthorityAmounts } from "./purchase-cost-authority-money";

const approved = new Set(["approved", "partially_paid", "paid"]);
const key = (row: { reference: { documentId: number; lineId: number } }): string => `${row.reference.documentId}:${row.reference.lineId}`;
const compareReference = (left: PurchaseCostInvoice, right: PurchaseCostInvoice): number =>
  left.reference.documentId - right.reference.documentId || left.reference.lineId - right.reference.lineId;

function amountIdentity(amount: PurchaseCostAmount): PurchaseCostAmount {
  return { ...amount, adjustments: [...amount.adjustments].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0) };
}

function coverageIdentity(invoice: PurchaseCostInvoice | null | undefined): PurchaseCostInvoice["receiptCoverage"] {
  return invoice?.receiptCoverage ? [...invoice.receiptCoverage].sort((left, right) =>
    left.startPiece - right.startPiece || left.receivingLineId - right.receivingLineId) : null;
}

function coverageIssues(input: PurchaseCostAuthorityInput, invoices: readonly PurchaseCostInvoice[]): CostIssue[] {
  const issues: CostIssue[] = [];
  const quantity = invoices.reduce((sum, row) => sum + BigInt(row.pieces), BigInt(0));
  if (quantity > BigInt(input.scope.basePieces)) issues.push({ code: "INVOICE_COVERAGE_EXCEEDED", message: "Approved invoice quantities exceed this purchase cost scope. Review their source coverage." });
  const intervals = invoices.flatMap(row => (row.receiptCoverage ?? []).map(interval => ({ ...interval, invoice: key(row) })))
    .sort((left, right) => left.startPiece - right.startPiece);
  let end = BigInt(0);
  for (const interval of intervals) {
    const nextEnd = BigInt(interval.startPiece) + BigInt(interval.pieces);
    if (nextEnd > BigInt(input.scope.basePieces)) issues.push({ code: "INVOICE_COVERAGE_OUTSIDE_SCOPE", message: `Invoice source ${interval.invoice} has a receipt interval beyond the purchase cost scope.` });
    if (BigInt(interval.startPiece) < end) issues.push({ code: "INVOICE_COVERAGE_OVERLAP", message: `Invoice source ${interval.invoice} overlaps already covered receipt pieces. No actual cost was assigned to those goods.` });
    if (nextEnd > end) end = nextEnd;
  }
  return issues;
}

function receiptAllocation(input: PurchaseCostAuthorityInput, invoices: readonly PurchaseCostInvoice[]): PurchaseCostAuthority["coverage"]["receiptAllocation"] {
  if (invoices.length === 0 || (invoices.length === 1 && invoices[0].pieces === input.scope.basePieces)) return "whole_line";
  if (invoices.every(row => row.receiptCoverage !== null)) return "explicit_receipts";
  return input.receiptAllocationPolicy === "po_line_blended" ? "po_line_blended" : "decision_required";
}

function shipmentAmount(input: PurchaseCostAuthorityInput, invoices: readonly PurchaseCostInvoice[], issues: CostIssue[]): number | null {
  let amount = BigInt(0);
  let available = input.shipmentCostCoverage !== "awaiting_source";
  if (!available) issues.push({ code: "SHIPMENT_COST_SOURCE_PENDING", message: "Shipment charges are still awaiting source confirmation or allocation. Their absence does not establish a zero landed charge." });
  const chargeTotals = new Map<number, { sourceAmount: number; allocated: bigint; reference: string;
    shipmentId: number; evidence: string; category: string }>();
  const billedSources = new Map<string, number>();
  const supplierSources = new Set(invoices.map(row => `vendor_invoice_line:${key(row)}`));
  for (const share of input.shipmentShares) {
    const validAmount = share.allocatedMills !== null
      && share.allocationSourceAmountMills === share.sourceAmountMills
      && (share.sourceAmountMills >= 0 ? share.allocatedMills >= 0 && share.allocatedMills <= share.sourceAmountMills
        : share.allocatedMills <= 0 && share.allocatedMills >= share.sourceAmountMills);
    const reference = `${share.reference.kind}:${key(share)}`;
    const prior = chargeTotals.get(share.chargeId);
    const owner = billedSources.get(reference);
    const conflicting = (prior && (prior.sourceAmount !== share.sourceAmountMills || prior.reference !== reference
      || prior.shipmentId !== share.shipmentId || prior.evidence !== share.evidence || prior.category !== share.category))
      || (owner !== undefined && owner !== share.chargeId)
      || share.reference.kind === "purchase_order_line"
      || (share.reference.kind === "shipment_cost" && (share.reference.documentId !== share.shipmentId || share.reference.lineId !== share.chargeId))
      || (share.sourceAmountMills < 0 && share.reference.kind !== "supplier_credit_line");
    if (supplierSources.has(reference)) {
      available = false;
      issues.push({ code: "COST_SOURCE_COUNTED_TWICE", message: `Shipment charge ${share.chargeId} claims invoice source ${key(share)}, which already supplies the goods amount. Link a separate charge line or remove the duplicate claim.` });
    } else if (share.currency !== input.scope.currency || share.evidence === "review_required" || !validAmount || conflicting) {
      available = false;
      issues.push({ code: "SHIPMENT_SHARE_REVIEW_REQUIRED", message: `Shipment charge ${share.chargeId}, line ${share.shipmentLineId}, needs a current allocation in the purchase currency.` });
    } else {
      amount += BigInt(share.allocatedMills!);
      chargeTotals.set(share.chargeId, { sourceAmount: share.sourceAmountMills, allocated: (prior?.allocated ?? BigInt(0)) + BigInt(share.allocatedMills!),
        reference, shipmentId: share.shipmentId, evidence: share.evidence, category: share.category });
      billedSources.set(reference, share.chargeId);
    }
  }
  for (const [chargeId, total] of chargeTotals) if (total.sourceAmount >= 0 ? total.allocated > BigInt(total.sourceAmount) : total.allocated < BigInt(total.sourceAmount)) {
    available = false;
    issues.push({ code: "SHIPMENT_SHARE_EXCEEDED", message: `Saved shares of shipment charge ${chargeId} exceed its source amount.` });
  }
  return available ? exactAuthorityMoney(amount, "shipmentShares") : null;
}

/** Quantity-scoped monetary projection only. Receipt lineage, posting approval,
 * persistence and physical mutations remain with their existing owners. */
export function projectPurchaseCostAuthority(value: unknown): PurchaseCostAuthority {
  const parsed = purchaseCostAuthorityInputSchema.safeParse(value);
  if (!parsed.success) throw new PurchaseCostAuthorityError("PURCHASE_COST_AUTHORITY_INPUT_INVALID", "Purchase cost evidence is invalid.", {
    fields: parsed.error.issues.map(issue => issue.path.join(".")),
  });
  const input = parsed.data;
  const invoices = input.invoices.filter(row => approved.has(row.status)).sort(compareReference);
  const invoiceByReference = new Map(invoices.map(row => [key(row), row]));
  const issues = coverageIssues(input, invoices);
  if (input.scope.currency !== "USD") issues.push({ code: "COST_CURRENCY_REVIEW", message: "This costing contract requires explicit USD evidence; no currency conversion was inferred." });
  if (invoices.some(row => row.currency !== input.scope.currency)) issues.push({ code: "INVOICE_CURRENCY_MISMATCH", message: "Approved supplier costs and purchase currency differ. Review the recorded conversion." });
  const coverageValid = !issues.some(issue => issue.code.startsWith("INVOICE_COVERAGE"));
  const confirmedPieces = coverageValid ? exactAuthorityMoney(invoices.reduce((sum, row) => sum + BigInt(row.pieces), BigInt(0)), "confirmedPieces") : 0;
  const remaining = coverageValid ? input.scope.basePieces - confirmedPieces : 0;
  const selectedSources: PurchaseCostAuthority["selectedSources"] = coverageValid ? invoices.map(row => ({
    reference: row.reference, currency: row.currency, pieces: row.pieces, sourceBasePieces: row.pieces, sourceAmount: row.amount,
    evidence: "confirmed", amount: projectAuthorityAmount(row.amount, 1, 1),
    sourceRevisionId: row.sourceRevisionId, approval: row.approval,
  })) : [];
  if (remaining > 0) {
    if (!input.quote.amount) issues.push({ code: "PURCHASE_QUOTE_AMOUNT_MISSING", message: "Uninvoiced pieces have no recorded provisional PO amount." });
    else if (input.scope.basePieces > input.quote.basePieces) issues.push({ code: "PURCHASE_QUANTITY_BASIS_REVIEW", message: "The cost scope exceeds the quoted purchase quantity. Record the additional goods' financial source before extending the PO estimate." });
    else selectedSources.push({ reference: input.quote.reference, currency: input.scope.currency, pieces: remaining, sourceBasePieces: input.quote.basePieces,
      sourceAmount: input.quote.amount, evidence: "estimated",
      amount: projectAuthorityAmount(input.quote.amount, remaining, input.quote.basePieces),
      sourceRevisionId: input.quote.sourceRevisionId, approval: input.quote.approval });
  }
  const estimatedPieces = selectedSources.filter(row => row.evidence === "estimated").reduce((sum, row) => sum + row.pieces, 0);
  const completeAmount = coverageValid && confirmedPieces + estimatedPieces === input.scope.basePieces
    && selectedSources.every(row => row.currency === input.scope.currency);
  const supplier = completeAmount ? sumAuthorityAmounts(selectedSources.map(row => row.amount)) : null;
  if (supplier?.includedMills === null) issues.push({ code: "COST_ADJUSTMENT_CLASSIFICATION_REQUIRED", message: "The full billed amount is recorded. Classify its named adjustments before calculating inventory cost." });
  if (supplier?.includedMills != null && supplier.includedMills < 0) issues.push({ code: "COST_NEGATIVE_SUPPLIER_AMOUNT", message: "The selected adjustments produce a negative inventory cost. Review their disposition." });
  const allocation = receiptAllocation(input, invoices);
  if (allocation === "decision_required") issues.push({ code: "INVOICE_RECEIPT_ALLOCATION_REQUIRED", message: "Invoice amounts are known. Choose the approved receipt-allocation rule before assigning their costs to stock or sold goods." });
  const shipmentMills = shipmentAmount(input, invoices, issues);
  const amountBlocked = issues.some(issue => issue.code !== "INVOICE_RECEIPT_ALLOCATION_REQUIRED");
  let landedMills = amountBlocked || supplier?.includedMills == null || shipmentMills === null ? null
    : exactAuthorityMoney(BigInt(supplier.includedMills) + BigInt(shipmentMills), "landed");
  if (landedMills !== null && landedMills < 0) {
    issues.push({ code: "COST_NEGATIVE_LANDED_AMOUNT", message: "Supplier and charge adjustments produce a negative landed amount. Review the source credits." });
    landedMills = null;
  }
  // Only selected economic facts enter this identity. Settlement state,
  // display metadata, audit timestamps, revision serials and superseded quotes
  // are retained as provenance without invalidating unchanged costs.
  const economicFingerprint = costFingerprint({
    contractVersion: 1, scope: input.scope, receiptAllocation: allocation, shipmentCostCoverage: input.shipmentCostCoverage,
    supplier: selectedSources.map(row => {
      const invoice = row.evidence === "confirmed" ? invoiceByReference.get(key(row)) : null;
      return { reference: row.reference, pieces: row.pieces, evidence: row.evidence, amount: row.amount,
        sourceBasePieces: row.sourceBasePieces, sourceAmount: amountIdentity(row.sourceAmount),
        currency: invoice?.currency ?? input.scope.currency,
        receiptCoverage: coverageIdentity(invoice) };
    }),
    unresolvedInvoiceCoverage: coverageValid ? null : invoices.map(row => ({ reference: row.reference, pieces: row.pieces,
      currency: row.currency, amount: amountIdentity(row.amount), receiptCoverage: coverageIdentity(row) })),
    shipmentShares: [...input.shipmentShares].sort((left, right) => left.chargeId - right.chargeId || left.shipmentLineId - right.shipmentLineId)
      .map(({ sourceRevisionId: _revision, approval: _approval, ...share }) => share),
    issues: issues.map(issue => issue.code).sort(),
  });
  const application = input.application;
  const state = application?.economicFingerprint && application.economicFingerprint !== economicFingerprint ? "source_changed"
    : application?.state === "applied" && issues.length > 0 ? "review_required" : application?.state ?? "not_requested";
  const output = purchaseCostAuthoritySchema.safeParse({
    contractVersion: 1, scope: input.scope, economicFingerprint,
    sourceState: issues.some(issue => issue.code !== "INVOICE_RECEIPT_ALLOCATION_REQUIRED") ? "review_required"
      : (confirmedPieces > 0 || input.shipmentShares.some(share => share.evidence === "confirmed"))
        ? (estimatedPieces > 0 || input.shipmentShares.some(share => share.evidence === "estimated")) ? "mixed" : "confirmed" : "estimated",
    coverage: { confirmedPieces, estimatedPieces, receiptAllocation: allocation },
    agreedQuote: input.quote.amount ? projectAuthorityAmount(input.quote.amount, 1, 1) : null,
    supplier, selectedSources, shipmentCostCoverage: input.shipmentCostCoverage, shipmentShares: input.shipmentShares, shipmentMills, landedMills,
    application: { state, applicationIds: application?.applicationIds ?? [], approvals: application?.approvals ?? [] }, issues,
  });
  if (!output.success) throw new PurchaseCostAuthorityError("PURCHASE_COST_AUTHORITY_OUTPUT_INVALID", "The costing owner produced an invalid monetary projection.", {
    fields: output.error.issues.map(issue => issue.path.join(".")),
  });
  return output.data;
}
