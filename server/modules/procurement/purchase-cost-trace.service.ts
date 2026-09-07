import { projectReceiptCostQueue, receiptCostQueueReadSchema } from "./receipt-cost-queue-read.service";
import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import { projectPurchaseCostApplications, purchaseCostApplicationReadSchema } from "./purchase-cost-application-read.service";
import { PurchaseWorkspaceError } from "./purchase-workspace.service";
import { z } from "zod";
import { purchaseCostTraceSchema, type PurchaseCostTrace } from "@shared/procurement/purchase-cost-trace";
import type { PurchaseWorkspace } from "@shared/procurement/purchase-workspace";

const id = z.number().int().positive().safe();
const integer = z.number().int().safe();
const money = integer.nullable();
const date = z.string().datetime({ offset: true }).nullable();
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/).nullable();

/** Raw read contract. Source identities remain available until the application
 * projection verifies them; SQL joins alone must not assert valid lineage. */
export const purchaseCostEvidenceSchema = z.object({
  purchaseLines: z.array(z.object({
    id, sku: z.string().nullable(), lineType: z.string(), status: z.string(),
    pricingBasis: z.string(), pricingSource: z.string(), quoteReference: z.string().nullable(),
    orderedQty: integer, receivedQty: integer.nullable(), cancelledQty: integer.nullable(),
    productCents: money, packagingCents: money, discountCents: money, taxCents: money,
    lineTotalCents: money, productUnitMills: money, pricingRemainderMills: money,
    promisedDate: date, expectedDeliveryDate: date,
  })),
  invoiceLines: z.array(purchaseCostTraceSchema.shape.invoiceLines.element.omit({ componentEvidence: true, components: true, componentIssues: true }).extend({ costComponentEvidence: z.unknown().optional() })),
  applications: purchaseCostApplicationReadSchema.optional(),
  receiptCostQueue: receiptCostQueueReadSchema.optional(),
  shipmentCharges: z.array(purchaseCostTraceSchema.shape.shipmentCharges.element.omit({ amountEvidence: true, amountScope: true, allocations: true })),
  allocations: z.array(z.object({
    id, chargeId: id, chargeShipmentId: id, shipmentId: id, shipmentLineId: id,
    purchaseOrderLineId: id, purchaseOrderId: id.nullable(),
    allocatedCents: money, basisValue: decimal, basisTotal: decimal,
  })),
  receiptLines: z.array(z.object({
    id, receiptId: id, purchaseOrderLineId: id,
    receiptStatus: z.string(), receiptPurchaseOrderId: id.nullable(),
    receiptVariantId: id.nullable(), receiptProductId: id.nullable(), purchaseLineProductId: id.nullable(),
    shipmentId: id.nullable(), shipmentLineId: id.nullable(),
    sourceShipmentId: id.nullable(), sourcePurchaseOrderId: id.nullable(), sourcePurchaseOrderLineId: id.nullable(),
    receivedUnits: integer, reversedUnits: integer, frozenPiecesPerUnit: integer.nullable(),
  })),
  postings: z.array(z.object({
    id, receivingLineId: id, receivingOrderId: id.nullable(), variantId: id.nullable(),
    variantQuantity: integer, postedAt: date, voidedAt: date,
    lot: purchaseCostTraceSchema.shape.receiptLines.element.shape.postings.element.shape.lot.unwrap().omit({ currency: true }).extend({
      receivingOrderId: id.nullable(), purchaseOrderId: id.nullable(),
      purchaseOrderLineId: id.nullable(), shipmentId: id.nullable(),
    }).nullable(),
  })),
});

export type PurchaseCostEvidence = z.infer<typeof purchaseCostEvidenceSchema>;

function exactSafeNumber(value: bigint): number | null {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function projectPurchaseLine(line: PurchaseCostEvidence["purchaseLines"][number], purchase: PurchaseWorkspace["purchase"]): PurchaseCostTrace["purchaseLines"][number] {
  const issues: string[] = [];
  const isProduct = line.lineType === "product";
  let outstandingPieces: number | null = null;
  let unreceivedQuoteCents: number | null = null;
  if (isProduct) {
    if (line.orderedQty <= 0 || line.receivedQty === null || line.receivedQty < 0 || line.cancelledQty === null || line.cancelledQty < 0) {
      issues.push("Unreceived quantity needs valid ordered, received and cancelled piece counts.");
    } else {
      const remaining = BigInt(line.orderedQty) - BigInt(line.receivedQty) - BigInt(line.cancelledQty);
      if (remaining < BigInt(0)) issues.push("Received and cancelled pieces exceed the ordered quantity; review the source quantities.");
      else if (["closed", "cancelled"].includes(line.status) || purchase.status === "cancelled") {
        // A closed-short line is history, not a promise of more incoming stock.
        outstandingPieces = 0;
        if (remaining > BigInt(0)) issues.push("This line is closed or cancelled; its unreceived remainder is excluded from expected supply.");
      } else outstandingPieces = Number(remaining);
    }
    if (line.pricingBasis === "legacy_unknown") {
      issues.push("The original quote basis is unknown; recorded component totals need source review.");
    } else if (outstandingPieces !== null && line.productCents !== null && line.packagingCents !== null && line.productCents >= 0 && line.packagingCents >= 0) {
      const denominator = BigInt(line.orderedQty);
      const numerator = (BigInt(line.productCents) + BigInt(line.packagingCents)) * BigInt(outstandingPieces);
      // One half-up rounding at display cents. The full quote and quantity
      // denominator remain exposed; no rounded per-piece price is multiplied.
      unreceivedQuoteCents = exactSafeNumber((numerator * BigInt(2) + denominator) / (denominator * BigInt(2)));
      if (unreceivedQuoteCents === null) issues.push("The proportional quote value exceeds the supported display range.");
    } else if (line.productCents === null || line.packagingCents === null || line.productCents < 0 || line.packagingCents < 0) {
      issues.push("A nonnegative product and packaging quote is required for an unreceived value preview.");
    }
  }
  const arrival = [
    [line.promisedDate, "line_promise"], [line.expectedDeliveryDate, "line_expected"],
    [purchase.confirmedDeliveryDate, "purchase_confirmed"], [purchase.expectedDeliveryDate, "purchase_expected"],
  ] as const;
  const selectedArrival = arrival.find(([value]) => value !== null);
  return {
    id: line.id, sku: line.sku, lineType: line.lineType, status: line.status,
    currency: purchase.currency, pricingBasis: line.pricingBasis, pricingSource: line.pricingSource,
    quoteReference: line.quoteReference, orderedPieces: isProduct ? line.orderedQty : null,
    receivedPieces: isProduct ? line.receivedQty : null, cancelledPieces: isProduct ? line.cancelledQty : null,
    productCents: line.productCents, packagingCents: line.packagingCents, discountCents: line.discountCents,
    taxCents: line.taxCents, lineTotalCents: line.lineTotalCents, productUnitMills: line.productUnitMills,
    pricingRemainderMills: line.pricingRemainderMills, outstandingPieces, unreceivedQuoteCents,
    expectedArrivalDate: selectedArrival?.[0] ?? null, arrivalDateSource: selectedArrival?.[1] ?? null, issues,
  };
}

function projectReceiptLine(line: PurchaseCostEvidence["receiptLines"][number], postings: PurchaseCostEvidence["postings"], purchaseOrderId: number): PurchaseCostTrace["receiptLines"][number] {
  const issues: string[] = [];
  const frozen = line.frozenPiecesPerUnit !== null && line.frozenPiecesPerUnit > 0 ? line.frozenPiecesPerUnit : null;
  if (frozen === null) issues.push("Frozen receipt units are unavailable; current catalog pack sizes cannot prove historical units.");
  if (line.receivedUnits < 0 || line.reversedUnits < 0 || line.reversedUnits > line.receivedUnits) issues.push("Receipt or reversal quantities need review.");
  if (line.receiptPurchaseOrderId !== purchaseOrderId) issues.push("Receipt header does not identify this purchase order.");
  if (line.receiptProductId === null || line.receiptProductId !== line.purchaseLineProductId) issues.push("Receipt product identity does not prove the purchase line product.");
  if (line.shipmentLineId !== null && (line.shipmentId === null || line.sourceShipmentId !== line.shipmentId || line.sourcePurchaseOrderLineId !== line.purchaseOrderLineId || line.sourcePurchaseOrderId !== purchaseOrderId)) {
    issues.push("The exact shipment line does not agree with the receipt and purchase source.");
  }
  if (line.shipmentId !== null && line.shipmentLineId === null) issues.push("This receipt has a shipment header but no exact shipment-line source.");
  const live = postings.filter((posting) => posting.voidedAt === null);
  if (live.length !== 1) {
    if (live.length > 1) issues.push("More than one active receipt transaction refers to this receiving line.");
    else if (line.receiptStatus === "closed" && line.receivedUnits > 0) issues.push("No active original receipt transaction proves this closed receipt line.");
  }
  for (const posting of live) {
    if (posting.receivingOrderId !== line.receiptId || posting.variantId !== line.receiptVariantId || posting.variantQuantity !== line.receivedUnits) {
      issues.push(`Receipt transaction #${posting.id} disagrees with the receipt identity or quantity.`);
    }
    if (posting.lot === null) issues.push(`Receipt transaction #${posting.id} has no surviving lot reference.`);
    else {
      const lot = posting.lot;
      if (lot.receivingOrderId !== line.receiptId || lot.purchaseOrderId !== purchaseOrderId || lot.purchaseOrderLineId !== line.purchaseOrderLineId || lot.shipmentId !== line.shipmentId || lot.variantId !== line.receiptVariantId) {
        issues.push(`Lot #${lot.id} has conflicting or incomplete original source identities.`);
      }
      const components = [lot.productUnitMills, lot.packagingUnitMills, lot.landedUnitMills];
      if (components.some((amount) => amount !== null && amount < 0)) issues.push(`Lot #${lot.id} has a negative component requiring cost-policy review.`);
      if (lot.totalUnitMills === null || components.some((amount) => amount === null)) issues.push(`Lot #${lot.id} has incomplete recorded cost components.`);
      else if (components.reduce<bigint>((sum, amount) => sum + BigInt(amount!), BigInt(0)) !== BigInt(lot.totalUnitMills)) {
        issues.push(`Lot #${lot.id} component amounts do not equal its recorded total.`);
      }
    }
  }
  return {
    id: line.id, receiptId: line.receiptId, purchaseOrderLineId: line.purchaseOrderLineId,
    shipmentId: line.shipmentId, shipmentLineId: line.shipmentLineId,
    receivedUnits: line.receivedUnits, reversedUnits: line.reversedUnits, frozenPiecesPerUnit: frozen,
    unitEvidence: frozen === null ? "unknown" : "frozen_receipt",
    lineageEvidence: issues.length > 0 ? "review_required" : live.length === 1 ? "original_receipt_proven" : "awaiting_posting",
    issues,
    postings: postings.map((posting) => ({
      id: posting.id, variantQuantity: posting.variantQuantity, postedAt: posting.postedAt, voidedAt: posting.voidedAt,
      lot: posting.lot === null ? null : { ...posting.lot, currency: null },
    })),
  };
}

function projectInvoiceLine(line: PurchaseCostEvidence["invoiceLines"][number]): PurchaseCostTrace["invoiceLines"][number] {
  const { costComponentEvidence, ...record } = line;
  if (costComponentEvidence == null) return { ...record, componentEvidence: "unclassified", components: null, componentIssues: [] };
  const parsed = invoiceCostComponentEvidenceSchema.safeParse(costComponentEvidence);
  if (!parsed.success) return { ...record, componentEvidence: "review_required", components: null, componentIssues: ["Recorded invoice component evidence is invalid or unsupported."] };
  const components = parsed.data;
  const issues: string[] = [];
  if (line.lineTotalCents === null || BigInt(components.productMills) + BigInt(components.packagingMills) + BigInt(components.adjustmentMills) !== BigInt(line.lineTotalCents) * BigInt(100)) {
    issues.push("Invoice component amounts do not reconcile to the recorded document total.");
  }
  if (components.packagingTreatment === "included_in_product" && components.packagingMills !== 0) issues.push("Included packaging must not also carry a separate packaging amount.");
  if (components.adjustmentMills !== 0) issues.push("The explicit invoice adjustment requires review by the cost application owner.");
  return { ...record, componentEvidence: issues.length ? "review_required" : "explicit_recorded", components, componentIssues: issues };
}
export function projectPurchaseCostTrace(input: PurchaseCostEvidence, purchase: PurchaseWorkspace["purchase"]): PurchaseCostTrace {
  const evidence = purchaseCostEvidenceSchema.parse(input);
  const sourceLinesByRevision = new Map(evidence.applications?.revisions.map((revision) => [revision.id, revision.purchaseOrderLineId] as const) ?? []);
  const applicationScopes = new Map(evidence.applications?.applications.flatMap((application) => {
    const lineId = sourceLinesByRevision.get(application.sourceRevisionId);
    return lineId === undefined ? [] : [[application.id, { purchaseOrderLineId: lineId, status: application.status }] as const];
  }) ?? []);
  const postings = new Map<number, PurchaseCostEvidence["postings"]>();
  for (const posting of evidence.postings) {
    const rows = postings.get(posting.receivingLineId) ?? [];
    rows.push(posting);
    postings.set(posting.receivingLineId, rows);
  }
  return purchaseCostTraceSchema.parse({
    version: 1,
    applicationEvidence: evidence.applications?.revisions.length ? "recorded" : "not_verified",
    applicationHistory: evidence.applications ? projectPurchaseCostApplications(evidence.applications, purchase.id) : undefined,
    receiptCostRequests: evidence.receiptCostQueue ? projectReceiptCostQueue(evidence.receiptCostQueue, applicationScopes) : undefined,
    purchaseLines: evidence.purchaseLines.map((line) => projectPurchaseLine(line, purchase)),
    invoiceLines: evidence.invoiceLines.map(projectInvoiceLine),
    shipmentCharges: evidence.shipmentCharges.map((charge) => ({
      ...charge,
      amountScope: "whole_shipment_charge",
      amountEvidence: charge.actualCents !== null ? "actual_recorded" : charge.estimatedCents !== null ? "estimated" : "unknown",
      allocations: evidence.allocations.filter((allocation) => allocation.chargeId === charge.id).map((allocation) => {
        if (allocation.shipmentId !== charge.shipmentId || allocation.chargeShipmentId !== charge.shipmentId || (allocation.purchaseOrderId !== null && allocation.purchaseOrderId !== purchase.id)) {
          throw new PurchaseWorkspaceError("PURCHASE_WORKSPACE_COST_SOURCE_CONFLICT", `Cost allocation #${allocation.id} has conflicting shipment or purchase identities.`, 422);
        }
        return { ...allocation, currency: null };
      }),
    })),
    receiptLines: evidence.receiptLines.map((line) => projectReceiptLine(line, postings.get(line.id) ?? [], purchase.id)),
    limitations: [
      "Source amounts and current lot balances are distinct from immutable application snapshots. A successful historical application does not prove that later receipts or transformations have been processed. Internal reporting events do not prove external delivery.",
      "Non-product PO fees, taxes and discounts require an explicit cost-owner allocation before they can be treated as inventory costs. Their source amounts remain visible; the quote preview does not allocate them.",
      "Unreceived quote values are proportional product plus packaging estimates, rounded once to cents. They exclude discounts, tax, freight and other charges and are not booked inventory or payable balances.",
      "Shipment charges cover the whole shipment. Only recorded line allocations relate them to this purchase; their output currency and source revision are not captured by the existing allocation records.",
      "Invoice composition is shown only from explicitly recorded component evidence that reconciles to its total. Historical unclassified lines are not inferred from an amount match or approval status.",
      "Lot amounts are the current per-variant recorded components, not the original receipt valuation. Lots do not record currency. Transferred, transformed and sold descendants require separate application evidence.",
      "Original receipt quantities and current lot quantities are different facts. Receipt status and on-hand quantity do not establish pickable availability.",
    ],
  });
}
