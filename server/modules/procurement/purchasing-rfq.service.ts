import { rfqWorkListQuerySchema, rfqWorkListResponseSchema, type RfqWorkListLine, type RfqWorkListItem, type RfqWorkListResponse } from "@shared/procurement/rfq-work-list";
import { readRfqWorkListEvidence, type RfqWorkListDatabase } from "./rfq-work-list.repository";
import { summarizeRfqHandoff } from "./domain/rfq-work-list";
import { PendingPurchaseSourcingReviewError, sourcingScopesOverlap, assertRfqSupplySnapshotCurrent, isActiveRfqReservation, rfqPendingSourcingPieces } from "./domain/rfq-sourcing-reservation";
import { loadPendingPurchaseSourcingReservations, type PendingPurchaseSourcingReservation, loadLinkedRfqPurchases, loadRecommendationRunDates } from "./rfq-sourcing-reservation.repository";
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  products as productsTable,
  purchaseRecommendationLines as purchaseRecommendationLinesTable,
  requestForQuoteLines as requestForQuoteLinesTable,
  requestForQuotes as requestForQuotesTable,
  vendorProducts as vendorProductsTable,
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

export async function lockAndLoadRfqSourcing(
  tx: any,
  recommendations: Array<{ id: number; productId: number; productVariantId?: number | null; warehouseId?: number | null }>,
): Promise<{ allocatedBySku: Map<string, number>; pendingPurchases: Array<PendingPurchaseSourcingReservation & { recommendationIds: number[] }> }> {
  const productIds = Array.from(new Set<number>(recommendations.map((line) => Number(line.productId))))
    .sort((left, right) => left - right);
  if (productIds.length === 0) return { allocatedBySku: new Map(), pendingPurchases: [] };

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
  const purchases = await loadPendingPurchaseSourcingReservations(tx, productIds);
  const pendingPurchases = purchases.flatMap((purchase) => {
    const recommendationIds = recommendations.filter((line) => {
      if (!sourcingScopesOverlap(line, purchase)) return false;
      // A linked purchase is covered only by the exact RFQ allocation scope.
      // Global/warehouse overlap still requires review when that baseline does
      // not account for it; never silently waive a linked draft obligation.
      const coveredByRfqBaseline = purchase.rfqLineId !== null && allocations.some((allocation: { id: number; productId: number; warehouseId?: number | null }) =>
        Number(allocation.id) === purchase.rfqLineId && purchasingSkuAllocationKey(allocation) === purchasingSkuAllocationKey(line));
      return !coveredByRfqBaseline;
    }).map((line) => line.id);
    return recommendationIds.length ? [{ ...purchase, recommendationIds }] : [];
  });
  return { allocatedBySku, pendingPurchases };
}

/** The RFQ-only allocation override baseline is also enforced in SQL. An
 * unrelated draft PO therefore requires explicit owner review, not an altered
 * override baseline that the database cannot corroborate. */
export async function lockAndLoadActiveRfqAllocations(
  tx: any,
  recommendations: Array<{ id: number; productId: number; productVariantId?: number | null; warehouseId?: number | null }>,
): Promise<Map<string, number>> {
  const { allocatedBySku, pendingPurchases } = await lockAndLoadRfqSourcing(tx, recommendations);
  if (pendingPurchases.length > 0) throw new PendingPurchaseSourcingReviewError(pendingPurchases.map((purchase) => purchase.purchaseOrderId));
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

// The list owns a validated read projection; creation and commands remain with
// their existing RFQ/PO owners.
export { RFQ_LIST_DEFAULT_LIMIT, RFQ_LIST_MAX_LIMIT } from "@shared/procurement/rfq-work-list";
export type RequestForQuoteListLine = RfqWorkListLine;
export type RequestForQuoteListItem = RfqWorkListItem;
export type RequestForQuoteListResult = RfqWorkListResponse;
export function parseRfqListLimit(value: unknown): number {
  return rfqWorkListQuerySchema.parse(value === undefined ? {} : { limit: value }).limit;
}
export async function listRequestForQuotes(database: RfqWorkListDatabase, options: unknown = {}): Promise<RfqWorkListResponse> {
  const query = rfqWorkListQuerySchema.parse(options);
  const evidence = await readRfqWorkListEvidence(database, query);
  const statusCounts: Record<string, number> = {};
  const rfqs = evidence.headers.map(header => {
    const lines = evidence.lines.filter(line => line.rfqId === header.id);
    const totalPieces = lines.reduce((total, line) => total + BigInt(line.requestedPieces), BigInt(0));
    if (totalPieces > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("RFQ requested piece total exceeds the supported exact range");
    statusCounts[header.status] = (statusCounts[header.status] ?? 0) + 1;
    return { ...header, lines, lineCount: lines.length, requestedPiecesTotal: Number(totalPieces),
      handoff: summarizeRfqHandoff(header, lines, evidence.links.filter(link => link.rfqId === header.id || link.actualRfqId === header.id)) };
  });
  return rfqWorkListResponseSchema.parse({ limit: query.limit, count: rfqs.length, statusCounts, rfqs,
    page: { total: evidence.total, limit: query.limit, offset: query.offset,
      nextOffset: query.offset + rfqs.length < evidence.total ? query.offset + rfqs.length : null } });
}
