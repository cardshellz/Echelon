import { assertRfqSupplySnapshotCurrent, isActiveRfqReservation, rfqPendingSourcingPieces } from "./domain/rfq-sourcing-reservation";
import { loadLinkedRfqPurchases, loadRecommendationRunDates } from "./rfq-sourcing-reservation.repository";
import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  products as productsTable,
  purchaseRecommendationLines as purchaseRecommendationLinesTable,
  requestForQuoteLines as requestForQuoteLinesTable,
  requestForQuotes as requestForQuotesTable,
  vendorProducts as vendorProductsTable,
  vendors as vendorsTable,
} from "@shared/schema";
import type { PurchasingRecommendationItem } from "./purchasing-recommendation.engine";
import type { PurchaseReceiveSelection } from "@shared/procurement/purchase-receive-selection";

const nonRfqSkipReasons = new Set([
  "excluded",
  "already_on_order",
  "not_actionable_status",
  "zero_suggested_quantity",
]);

export type PurchasingRfqQueueItem = {
  recommendationId: string;
  productId: number;
  productVariantId: number | null;
  receiveVariantSelection?: PurchaseReceiveSelection;
  sku: string;
  productName: string;
  requestedPieces: number;
  availablePieces: number;
  onOrderPieces: number;
  reorderPointPieces: number;
  forecastMethod: string;
  forecastDailyPieces: number;
  leadTimeDays: number;
  safetyStockDays: number;
  forwardDemandPieces: number;
  preferredVendorId: number | null;
  preferredVendorName: string | null;
  vendorProductId: number | null;
  supplierAssignmentRequired: boolean;
  confidence: PurchasingRecommendationItem["confidence"];
  rfqConfidence: PurchasingRecommendationItem["rfqConfidence"];
  recommendationCandidateScore: PurchasingRecommendationItem["recommendationCandidateScore"];
  forecastTrust: PurchasingRecommendationItem["demandBasis"]["forecastTrust"];
  qualityGate: PurchasingRecommendationItem["qualityGate"];
  autopilotBlockers: PurchasingRecommendationItem["autopilotBlockers"];
  supplierBasis: PurchasingRecommendationItem["supplierBasis"];
  demandSnapshot: Record<string, unknown>;
};

/** RFQs reserve product base pieces in the forecast's warehouse scope. Receiving
 * choices remain immutable source evidence, but cannot partition that demand.
 * This lookup key is not a recommendation identity or a durable replay key. */
export function purchasingSkuAllocationKey(input: {
  productId: number;
  productVariantId?: number | null;
  warehouseId?: number | null;
}): string {
  return `${input.productId}:${input.warehouseId ?? "all"}`;
}

export async function lockAndLoadActiveRfqAllocations(
  tx: any,
  recommendations: Array<{ id: number; productId: number; productVariantId?: number | null; warehouseId?: number | null }>,
): Promise<Map<string, number>> {
  const productIds = Array.from(new Set<number>(recommendations.map((line) => Number(line.productId))))
    .sort((left, right) => left - right);
  if (productIds.length === 0) return new Map();

  await tx.select({ id: productsTable.id }).from(productsTable)
    .where(inArray(productsTable.id, productIds))
    .orderBy(productsTable.id)
    .for("update");

  const allocatedRecommendation = alias(purchaseRecommendationLinesTable, "allocated_recommendation");
  const allocations = await tx.select({
    id: requestForQuoteLinesTable.id,
    status: requestForQuoteLinesTable.status,
    rfqStatus: requestForQuotesTable.status,
    productId: allocatedRecommendation.productId,
    productVariantId: allocatedRecommendation.productVariantId,
    warehouseId: allocatedRecommendation.warehouseId,
    requestedPieces: requestForQuoteLinesTable.requestedPieces,
  }).from(requestForQuoteLinesTable).innerJoin(
    allocatedRecommendation,
    eq(requestForQuoteLinesTable.recommendationLineId, allocatedRecommendation.id),
  ).innerJoin(requestForQuotesTable, eq(requestForQuoteLinesTable.rfqId, requestForQuotesTable.id)).where(and(
    inArray(allocatedRecommendation.productId, productIds),
  ));
  const linkedPurchases = await loadLinkedRfqPurchases(tx, allocations.map((row: { id: number }) => Number(row.id)));
  if (Array.from(linkedPurchases.values()).some((purchase) => !["draft", "pending_approval"].includes(purchase.status))) {
    const runDates = await loadRecommendationRunDates(tx, recommendations.map((line) => line.id));
    for (const recommendation of recommendations) {
      const related = allocations.filter((row: { productId: number; productVariantId?: number | null; warehouseId?: number | null }) => purchasingSkuAllocationKey(row) === purchasingSkuAllocationKey(recommendation))
        .flatMap((row: { id: number }) => { const linked = linkedPurchases.get(Number(row.id)); return linked ? [linked] : []; });
      assertRfqSupplySnapshotCurrent(related, runDates.get(recommendation.id)!);
    }
  }

  const allocatedBySku = new Map<string, number>();
  for (const allocation of allocations) {
    const key = purchasingSkuAllocationKey(allocation);
    const pieces = rfqPendingSourcingPieces(Number(allocation.requestedPieces), linkedPurchases.get(Number(allocation.id)) ?? null, isActiveRfqReservation(allocation.rfqStatus, allocation.status));
    const total = (allocatedBySku.get(key) ?? 0) + pieces;
    if (!Number.isSafeInteger(total)) throw new Error("RFQ allocation quantity exceeds the supported integer range");
    allocatedBySku.set(key, total);
  }
  return allocatedBySku;
}

export function isPurchasingRfqCandidate(item: PurchasingRecommendationItem): boolean {
  if (!Number.isSafeInteger(item.suggestedOrderPieces) || item.suggestedOrderPieces <= 0) return false;
  if (item.skippedReason && nonRfqSkipReasons.has(item.skippedReason)) return false;
  return item.status === "stockout" || item.status === "order_now" || item.status === "order_soon";
}

export function buildPurchasingRfqQueue(
  result: { items: PurchasingRecommendationItem[]; skippedItems: PurchasingRecommendationItem[] },
): PurchasingRfqQueueItem[] {
  const byRecommendation = new Map<string, PurchasingRecommendationItem>();
  for (const item of [...result.items, ...result.skippedItems]) {
    if (isPurchasingRfqCandidate(item)) byRecommendation.set(item.recommendationId, item);
  }

  return Array.from(byRecommendation.values())
    .map((item) => ({
      recommendationId: item.recommendationId,
      productId: item.productId,
      productVariantId: item.productVariantId ?? null,
      ...(item.receiveVariantSelection ? { receiveVariantSelection: item.receiveVariantSelection } : {}),
      sku: item.sku,
      productName: item.productName,
      requestedPieces: item.suggestedOrderPieces,
      availablePieces: item.available,
      onOrderPieces: item.onOrderPieces,
      reorderPointPieces: item.reorderPoint,
      forecastMethod: item.forecastProvenance.forecastMethod,
      forecastDailyPieces: item.avgDailyUsage,
      leadTimeDays: item.leadTimeDays,
      safetyStockDays: item.safetyStockDays,
      forwardDemandPieces: item.forwardDemandBasis?.forwardDemandPieces ?? 0,
      preferredVendorId: item.preferredVendorId,
      preferredVendorName: item.preferredVendorName,
      vendorProductId: item.supplierBasis.vendorProductId,
      supplierAssignmentRequired: !item.preferredVendorId,
      confidence: item.confidence,
      rfqConfidence: item.rfqConfidence,
      recommendationCandidateScore: item.recommendationCandidateScore,
      forecastTrust: item.demandBasis.forecastTrust,
      qualityGate: item.qualityGate,
      autopilotBlockers: item.autopilotBlockers,
      supplierBasis: item.supplierBasis,
      demandSnapshot: {
        recommendationId: item.recommendationId,
        generatedForLookbackDays: item.forecastProvenance.demandWindowDays,
        status: item.status,
        availablePieces: item.available,
        onOrderPieces: item.onOrderPieces,
        effectiveSupplyPieces: item.currentSupply.effectiveSupplyPieces,
        reorderPointPieces: item.reorderPoint,
        suggestedOrderPieces: item.suggestedOrderPieces,
        ...(item.orderRounding ? { orderRounding: item.orderRounding } : {}),
        planningBasis: item.planningBasis,
        ...(item.receiveVariantSelection ? { receiveVariantSelection: item.receiveVariantSelection } : {}),
        supplierBundleTerms: item.supplierBundleTerms,
        supplyTiming: item.supplyTiming,
        demandBasis: item.demandBasis,
        forecastProvenance: item.forecastProvenance,
      },
    }))
    .sort((left, right) => {
      const leftUrgency = left.availablePieces <= 0 ? 0 : 1;
      const rightUrgency = right.availablePieces <= 0 ? 0 : 1;
      return leftUrgency - rightUrgency
        || right.requestedPieces - left.requestedPieces
        || left.sku.localeCompare(right.sku);
    });
}

// ---------------------------------------------------------------------------
// Read-only RFQ tracking list (workbench, design surface 05).
//
// Lists created procurement.request_for_quotes rows newest-first with their
// lines joined to the immutable recommendation evidence (SKU / product name /
// recommended pieces), the vendor-product mapping (vendor SKU), and the vendor
// name. Creation is owned by the Order Builder; quote revision capture and
// draft-PO conversion are owned by rfq-workflow.service.ts. This list remains
// a bounded read, preserving the legacy quote fields and every stored status.
// ---------------------------------------------------------------------------

export const RFQ_LIST_DEFAULT_LIMIT = 25;
export const RFQ_LIST_MAX_LIMIT = 100;

/**
 * Bound an untrusted `limit` query param: non-numeric, zero, or negative
 * values fall back to RFQ_LIST_DEFAULT_LIMIT; anything above
 * RFQ_LIST_MAX_LIMIT is capped to it.
 */
export function parseRfqListLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return RFQ_LIST_DEFAULT_LIMIT;
  return Math.min(parsed, RFQ_LIST_MAX_LIMIT);
}

export type RequestForQuoteListLine = {
  id: number;
  rfqId: number;
  recommendationLineId: number;
  recommendationRunId: number | null;
  vendorProductId: number;
  vendorSku: string | null;
  sku: string;
  productName: string;
  status: string;
  requestedPieces: number;
  recommendedPieces: number | null;
  purchaseUom: string | null;
  piecesPerPurchaseUom: number | null;
  quantityOverrideReason: string | null;
  allocationOverrideReason: string | null;
  allocationOverrideApprovedBy: string | null;
  allocationOverrideApprovedAt: Date | string | null;
  allocationOverrideBaselinePieces: number | null;
  allocationOverrideExcessPieces: number | null;
  // Quote compatibility mirrors. Immutable revisions are available through
  // the workflow detail and history endpoints; amounts remain integer mills.
  quotedPieces: number | null;
  quotedUnitCostMills: number | null;
  quoteReference: string | null;
  quoteValidUntil: string | null;
  quotedAt: Date | string | null;
};

export type RequestForQuoteListItem = {
  id: number;
  rfqNumber: string;
  status: string;
  vendorId: number;
  vendorName: string | null;
  requestNote: string | null;
  currency: string;
  responseDueDate: string | null;
  createdBy: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  sentAt: Date | string | null;
  respondedAt: Date | string | null;
  cancelledAt: Date | string | null;
  lineCount: number;
  requestedPiecesTotal: number;
  lines: RequestForQuoteListLine[];
};

export type RequestForQuoteListResult = {
  limit: number;
  count: number;
  /** Status → row count over the returned page (not the whole table). */
  statusCounts: Record<string, number>;
  rfqs: RequestForQuoteListItem[];
};

export async function listRequestForQuotes(
  dbClient: any,
  options: { limit?: unknown } = {},
): Promise<RequestForQuoteListResult> {
  const limit = parseRfqListLimit(options.limit);

  const rfqRows = await dbClient.select().from(requestForQuotesTable)
    .orderBy(desc(requestForQuotesTable.createdAt), desc(requestForQuotesTable.id))
    .limit(limit);

  if (rfqRows.length === 0) {
    return { limit, count: 0, statusCounts: {}, rfqs: [] };
  }

  const rfqIds = rfqRows.map((rfq: any) => Number(rfq.id));
  const lineRows = await dbClient.select({
    id: requestForQuoteLinesTable.id,
    rfqId: requestForQuoteLinesTable.rfqId,
    recommendationLineId: requestForQuoteLinesTable.recommendationLineId,
    recommendationRunId: purchaseRecommendationLinesTable.runId,
    vendorProductId: requestForQuoteLinesTable.vendorProductId,
    vendorSku: vendorProductsTable.vendorSku,
    sku: purchaseRecommendationLinesTable.sku,
    productName: purchaseRecommendationLinesTable.productName,
    status: requestForQuoteLinesTable.status,
    requestedPieces: requestForQuoteLinesTable.requestedPieces,
    recommendedPieces: purchaseRecommendationLinesTable.recommendedPieces,
    purchaseUom: requestForQuoteLinesTable.purchaseUom,
    piecesPerPurchaseUom: requestForQuoteLinesTable.piecesPerPurchaseUom,
    quantityOverrideReason: requestForQuoteLinesTable.quantityOverrideReason,
    allocationOverrideReason: requestForQuoteLinesTable.allocationOverrideReason,
    allocationOverrideApprovedBy: requestForQuoteLinesTable.allocationOverrideApprovedBy,
    allocationOverrideApprovedAt: requestForQuoteLinesTable.allocationOverrideApprovedAt,
    allocationOverrideBaselinePieces: requestForQuoteLinesTable.allocationOverrideBaselinePieces,
    allocationOverrideExcessPieces: requestForQuoteLinesTable.allocationOverrideExcessPieces,
    quotedPieces: requestForQuoteLinesTable.quotedPieces,
    quotedUnitCostMills: requestForQuoteLinesTable.quotedUnitCostMills,
    quoteReference: requestForQuoteLinesTable.quoteReference,
    quoteValidUntil: requestForQuoteLinesTable.quoteValidUntil,
    quotedAt: requestForQuoteLinesTable.quotedAt,
  }).from(requestForQuoteLinesTable)
    .innerJoin(
      purchaseRecommendationLinesTable,
      eq(requestForQuoteLinesTable.recommendationLineId, purchaseRecommendationLinesTable.id),
    )
    .leftJoin(vendorProductsTable, eq(requestForQuoteLinesTable.vendorProductId, vendorProductsTable.id))
    .where(inArray(requestForQuoteLinesTable.rfqId, rfqIds))
    .orderBy(requestForQuoteLinesTable.rfqId, requestForQuoteLinesTable.id);

  const vendorIds = Array.from(new Set<number>(rfqRows.map((rfq: any) => Number(rfq.vendorId))));
  const vendorRows = vendorIds.length === 0 ? [] : await dbClient.select({
    id: vendorsTable.id,
    name: vendorsTable.name,
  }).from(vendorsTable).where(inArray(vendorsTable.id, vendorIds));
  const vendorNameById = new Map<number, string>(
    vendorRows.map((vendor: any) => [Number(vendor.id), String(vendor.name)]),
  );

  const linesByRfqId = new Map<number, RequestForQuoteListLine[]>();
  for (const line of lineRows) {
    const rfqId = Number(line.rfqId);
    const group = linesByRfqId.get(rfqId) ?? [];
    group.push({
      id: Number(line.id),
      rfqId,
      recommendationLineId: Number(line.recommendationLineId),
      recommendationRunId: line.recommendationRunId == null ? null : Number(line.recommendationRunId),
      vendorProductId: Number(line.vendorProductId),
      vendorSku: line.vendorSku ?? null,
      sku: String(line.sku),
      productName: String(line.productName),
      status: String(line.status),
      requestedPieces: Number(line.requestedPieces),
      recommendedPieces: line.recommendedPieces == null ? null : Number(line.recommendedPieces),
      purchaseUom: line.purchaseUom ?? null,
      piecesPerPurchaseUom: line.piecesPerPurchaseUom == null ? null : Number(line.piecesPerPurchaseUom),
      quantityOverrideReason: line.quantityOverrideReason ?? null,
      allocationOverrideReason: line.allocationOverrideReason ?? null,
      allocationOverrideApprovedBy: line.allocationOverrideApprovedBy ?? null,
      allocationOverrideApprovedAt: line.allocationOverrideApprovedAt ?? null,
      allocationOverrideBaselinePieces:
        line.allocationOverrideBaselinePieces == null ? null : Number(line.allocationOverrideBaselinePieces),
      allocationOverrideExcessPieces:
        line.allocationOverrideExcessPieces == null ? null : Number(line.allocationOverrideExcessPieces),
      quotedPieces: line.quotedPieces == null ? null : Number(line.quotedPieces),
      quotedUnitCostMills: line.quotedUnitCostMills == null ? null : Number(line.quotedUnitCostMills),
      quoteReference: line.quoteReference ?? null,
      quoteValidUntil: line.quoteValidUntil ?? null,
      quotedAt: line.quotedAt ?? null,
    });
    linesByRfqId.set(rfqId, group);
  }

  const statusCounts: Record<string, number> = {};
  const rfqs: RequestForQuoteListItem[] = rfqRows.map((rfq: any) => {
    const status = String(rfq.status);
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const lines = linesByRfqId.get(Number(rfq.id)) ?? [];
    return {
      id: Number(rfq.id),
      rfqNumber: String(rfq.rfqNumber),
      status,
      vendorId: Number(rfq.vendorId),
      vendorName: vendorNameById.get(Number(rfq.vendorId)) ?? null,
      requestNote: rfq.requestNote ?? null,
      currency: String(rfq.currency ?? "USD"),
      responseDueDate: rfq.responseDueDate ?? null,
      createdBy: rfq.createdBy ?? null,
      createdAt: rfq.createdAt,
      updatedAt: rfq.updatedAt,
      sentAt: rfq.sentAt ?? null,
      respondedAt: rfq.respondedAt ?? null,
      cancelledAt: rfq.cancelledAt ?? null,
      lineCount: lines.length,
      requestedPiecesTotal: lines.reduce((sum, line) => sum + line.requestedPieces, 0),
      lines,
    };
  });

  return { limit, count: rfqs.length, statusCounts, rfqs };
}
