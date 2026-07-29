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

export function purchasingSkuAllocationKey(input: {
  productId: number;
  productVariantId?: number | null;
  warehouseId?: number | null;
}): string {
  return `${input.productId}:${input.productVariantId ?? "base"}:${input.warehouseId ?? "all"}`;
}

export async function lockAndLoadActiveRfqAllocations(
  tx: any,
  recommendations: Array<{ productId: number; productVariantId?: number | null; warehouseId?: number | null }>,
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
    productId: allocatedRecommendation.productId,
    productVariantId: allocatedRecommendation.productVariantId,
    warehouseId: allocatedRecommendation.warehouseId,
    requestedPieces: requestForQuoteLinesTable.requestedPieces,
  }).from(requestForQuoteLinesTable).innerJoin(
    allocatedRecommendation,
    eq(requestForQuoteLinesTable.recommendationLineId, allocatedRecommendation.id),
  ).where(and(
    inArray(allocatedRecommendation.productId, productIds),
    inArray(requestForQuoteLinesTable.status, ["draft", "sent", "quoted", "accepted", "ordered"]),
  ));

  const allocatedBySku = new Map<string, number>();
  for (const allocation of allocations) {
    const key = purchasingSkuAllocationKey(allocation);
    allocatedBySku.set(key, (allocatedBySku.get(key) ?? 0) + Number(allocation.requestedPieces));
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
// name. This is a TRACKING read: RFQ creation happens through the Order
// Builder (POST /api/purchasing/rfq-queue) and the post-draft lifecycle
// (send / quote capture / award / PO conversion) is not built server-side
// (docs/PURCHASING-HARDENING-HANDOFF-2026-07-19.md), so in practice every row
// is a draft — but the full schema status enums are passed through so rows
// that ever carry other statuses render honestly instead of being masked.
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
  // Quote-capture evidence. Null until the RFQ lifecycle ships; integer mills
  // (never floats) when present.
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
