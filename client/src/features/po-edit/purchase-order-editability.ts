export type PurchaseOrderEditabilityMarker = {
  status?: unknown;
  source?: unknown;
  metadata?: unknown;
};

const RECOMMENDATION_METADATA_SOURCES = new Set([
  "accepted_recommendation_handoff",
  "automatic_recommendation_handoff",
]);

/** Recommendation handoffs own their immutable economic snapshot. */
export function isImmutableRecommendationPurchaseOrder(
  po: PurchaseOrderEditabilityMarker | null | undefined,
): boolean {
  if (!po) return false;
  if (!po.metadata || typeof po.metadata !== "object") return false;
  const metadataSource = (po.metadata as Record<string, unknown>).source;
  return typeof metadataSource === "string" &&
    RECOMMENDATION_METADATA_SOURCES.has(metadataSource);
}

export function canUseFullPurchaseOrderEditor(
  po: PurchaseOrderEditabilityMarker | null | undefined,
): boolean {
  return po?.status === "draft" && !isImmutableRecommendationPurchaseOrder(po);
}
