export type ShopifyProductMappingStatus =
  | "unmapped"
  | "catalog_only"
  | "channel_only"
  | "consistent"
  | "mismatch"
  | "conflict";

export interface ShopifyProductMappingVariantEvidence {
  variantId: number;
  sku: string | null;
  isActive: boolean;
  catalogVariantId: string | null;
  feedId: number | null;
  feedIsActive: boolean | null;
  feedProductId: string | null;
  feedVariantId: string | null;
  listingId: number | null;
  listingProductId: string | null;
  listingVariantId: string | null;
}

export interface ShopifyProductMappingSource {
  productId: number;
  productName: string;
  productSku: string | null;
  catalogProductId: string | null;
  channel: {
    id: number;
    name: string;
  };
  variants: ShopifyProductMappingVariantEvidence[];
}

export interface ShopifyProductMappingSummary extends ShopifyProductMappingSource {
  status: ShopifyProductMappingStatus;
  evidenceProductIds: string[];
  recommendedProductId: string | null;
  repairable: boolean;
  fingerprint: string;
}

export type ImportedShopifyProductMappingDecision =
  | { action: "adopt"; productId: string }
  | { action: "retain"; productId: string }
  | { action: "conflict"; existingProductId: string; incomingProductId: string };

export type ShopifyProductMappingRepairEvaluation =
  | { ok: true; targetProductId: string; mappedVariantIds: string[] }
  | {
      ok: false;
      code: "INVALID_SHOPIFY_PRODUCT_ID" | "SHOPIFY_MAPPING_NOT_REPAIRABLE" | "SHOPIFY_VARIANTS_OUTSIDE_TARGET_PRODUCT";
      context: Record<string, unknown>;
    };

export function normalizeShopifyId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const match = trimmed.match(/(\d+)$/);
  return match ? match[1] : null;
}

export function decideImportedShopifyProductMapping(
  existingProductId: string | number | null | undefined,
  incomingProductId: string | number,
): ImportedShopifyProductMappingDecision {
  const existing = normalizeShopifyId(existingProductId);
  const incoming = normalizeShopifyId(incomingProductId);
  if (!incoming) {
    throw new Error("Incoming Shopify product id is invalid");
  }
  if (!existing) return { action: "adopt", productId: incoming };
  if (existing === incoming) return { action: "retain", productId: existing };
  return {
    action: "conflict",
    existingProductId: existing,
    incomingProductId: incoming,
  };
}

function uniqueSortedIds(values: Array<string | null>): string[] {
  return [...new Set(values.map(normalizeShopifyId).filter((value): value is string => value !== null))]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

export function buildShopifyProductMappingSummary(
  source: ShopifyProductMappingSource,
): ShopifyProductMappingSummary {
  const catalogProductId = normalizeShopifyId(source.catalogProductId);
  const evidenceProductIds = uniqueSortedIds(
    source.variants.flatMap((variant) => [variant.feedProductId, variant.listingProductId]),
  );

  let status: ShopifyProductMappingStatus;
  if (evidenceProductIds.length > 1) {
    status = "conflict";
  } else if (!catalogProductId && evidenceProductIds.length === 0) {
    status = "unmapped";
  } else if (catalogProductId && evidenceProductIds.length === 0) {
    status = "catalog_only";
  } else if (!catalogProductId) {
    status = "channel_only";
  } else if (catalogProductId === evidenceProductIds[0]) {
    status = "consistent";
  } else {
    status = "mismatch";
  }

  const recommendedProductId = evidenceProductIds.length === 1 ? evidenceProductIds[0] : null;
  const repairable = (status === "channel_only" || status === "mismatch") && recommendedProductId !== null;
  const variants = source.variants
    .map((variant) => ({
      ...variant,
      catalogVariantId: normalizeShopifyId(variant.catalogVariantId),
      feedProductId: normalizeShopifyId(variant.feedProductId),
      feedVariantId: normalizeShopifyId(variant.feedVariantId),
      listingProductId: normalizeShopifyId(variant.listingProductId),
      listingVariantId: normalizeShopifyId(variant.listingVariantId),
    }))
    .sort((left, right) => left.variantId - right.variantId);
  const fingerprint = JSON.stringify({
    catalogProductId,
    channelId: source.channel.id,
    variants: variants.map((variant) => ({
      variantId: variant.variantId,
      catalogVariantId: variant.catalogVariantId,
      feedId: variant.feedId,
      feedProductId: variant.feedProductId,
      feedVariantId: variant.feedVariantId,
      listingId: variant.listingId,
      listingProductId: variant.listingProductId,
      listingVariantId: variant.listingVariantId,
    })),
  });

  return {
    ...source,
    catalogProductId,
    variants,
    status,
    evidenceProductIds,
    recommendedProductId,
    repairable,
    fingerprint,
  };
}

export function collectMappedShopifyVariantIds(summary: ShopifyProductMappingSummary): string[] {
  return uniqueSortedIds(
    summary.variants.flatMap((variant) => [
      variant.catalogVariantId,
      variant.feedVariantId,
      variant.listingVariantId,
    ]),
  );
}

export function evaluateShopifyProductMappingRepair(input: {
  summary: ShopifyProductMappingSummary;
  requestedProductId: string | number | null | undefined;
  verifiedRemoteVariantIds: string[];
}): ShopifyProductMappingRepairEvaluation {
  const targetProductId = normalizeShopifyId(input.requestedProductId);
  if (!targetProductId) {
    return {
      ok: false,
      code: "INVALID_SHOPIFY_PRODUCT_ID",
      context: { requestedProductId: input.requestedProductId ?? null },
    };
  }

  const alreadyConsistent = input.summary.status === "consistent"
    && input.summary.catalogProductId === targetProductId
    && input.summary.evidenceProductIds.length === 1
    && input.summary.evidenceProductIds[0] === targetProductId;
  if (
    !alreadyConsistent
    && (!input.summary.repairable || input.summary.recommendedProductId !== targetProductId)
  ) {
    return {
      ok: false,
      code: "SHOPIFY_MAPPING_NOT_REPAIRABLE",
      context: {
        status: input.summary.status,
        catalogProductId: input.summary.catalogProductId,
        evidenceProductIds: input.summary.evidenceProductIds,
        requestedProductId: targetProductId,
      },
    };
  }

  const mappedVariantIds = collectMappedShopifyVariantIds(input.summary);
  const remoteVariantIds = new Set(
    input.verifiedRemoteVariantIds
      .map(normalizeShopifyId)
      .filter((variantId): variantId is string => variantId !== null),
  );
  const foreignVariantIds = mappedVariantIds.filter((variantId) => !remoteVariantIds.has(variantId));
  if (foreignVariantIds.length > 0) {
    return {
      ok: false,
      code: "SHOPIFY_VARIANTS_OUTSIDE_TARGET_PRODUCT",
      context: { targetProductId, foreignVariantIds },
    };
  }

  return { ok: true, targetProductId, mappedVariantIds };
}
