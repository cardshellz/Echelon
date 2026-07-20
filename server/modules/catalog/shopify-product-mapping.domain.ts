export type ShopifyProductMappingStatus =
  | "unmapped"
  | "catalog_only"
  | "channel_only"
  | "consistent"
  | "incomplete"
  | "mismatch"
  | "conflict";

export interface ShopifyProductMappingVariantEvidence {
  variantId: number;
  sku: string | null;
  isActive: boolean;
  catalogBarcode: string | null;
  catalogVariantId: string | null;
  catalogInventoryItemId: string | null;
  feedId: number | null;
  feedIsActive: boolean | null;
  feedProductId: string | null;
  feedVariantId: string | null;
  feedInventoryItemId: string | null;
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
  activeVariantCount: number;
  archivedVariantCount: number;
  activeVariantIssueIds: number[];
  fingerprint: string;
}

export interface VerifiedShopifyVariantIdentity {
  id: string;
  sku: string | null;
  inventoryItemId: string | null;
  barcode?: string | null;
}

export interface ShopifyVariantMappingResolution {
  variantId: number;
  sku: string;
  remoteSku: string | null;
  remoteBarcode: string | null;
  remoteVariantId: string;
  remoteInventoryItemId: string;
  matchedBy: "existing_id" | "exact_sku";
  replacedVariantIds: string[];
}

export type ImportedShopifyProductMappingDecision =
  | { action: "adopt"; productId: string }
  | { action: "retain"; productId: string }
  | { action: "conflict"; existingProductId: string; incomingProductId: string };

export type ShopifyProductMappingRepairEvaluation =
  | {
      ok: true;
      targetProductId: string;
      mappedVariantIds: string[];
      variantMappings: ShopifyVariantMappingResolution[];
    }
  | {
      ok: false;
      code:
        | "INVALID_SHOPIFY_PRODUCT_ID"
        | "SHOPIFY_MAPPING_NOT_REPAIRABLE"
        | "SHOPIFY_ACTIVE_VARIANTS_UNRESOLVED";
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

function normalizeSku(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return normalized || null;
}

function variantMappingIds(variant: ShopifyProductMappingVariantEvidence): string[] {
  return uniqueSortedIds([
    variant.catalogVariantId,
    variant.feedVariantId,
    variant.listingVariantId,
  ]);
}

export function buildShopifyProductMappingSummary(
  source: ShopifyProductMappingSource,
): ShopifyProductMappingSummary {
  const catalogProductId = normalizeShopifyId(source.catalogProductId);
  const variants = source.variants
    .map((variant) => ({
      ...variant,
      catalogVariantId: normalizeShopifyId(variant.catalogVariantId),
      catalogInventoryItemId: normalizeShopifyId(variant.catalogInventoryItemId),
      feedProductId: normalizeShopifyId(variant.feedProductId),
      feedVariantId: normalizeShopifyId(variant.feedVariantId),
      feedInventoryItemId: normalizeShopifyId(variant.feedInventoryItemId),
      listingProductId: normalizeShopifyId(variant.listingProductId),
      listingVariantId: normalizeShopifyId(variant.listingVariantId),
    }))
    .sort((left, right) => left.variantId - right.variantId);
  const activeVariants = variants.filter((variant) => variant.isActive);
  const evidenceProductIds = uniqueSortedIds(
    activeVariants.flatMap((variant) => [variant.feedProductId, variant.listingProductId]),
  );
  const activeVariantIssueIds = activeVariants
    .filter((variant) => (
      !variant.catalogVariantId
      || !variant.catalogInventoryItemId
      || !variant.feedId
      || variant.feedIsActive !== true
      || !variant.feedVariantId
      || !variant.feedInventoryItemId
      || !variant.listingId
      || !variant.listingVariantId
      || variantMappingIds(variant).length !== 1
    ))
    .map((variant) => variant.variantId);

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
    status = activeVariantIssueIds.length === 0 ? "consistent" : "incomplete";
  } else {
    status = "mismatch";
  }

  const recommendedProductId = evidenceProductIds.length === 1
    ? evidenceProductIds[0]
    : evidenceProductIds.length === 0
      ? catalogProductId
      : null;
  const repairable = activeVariants.length > 0 && recommendedProductId !== null && [
    "catalog_only",
    "channel_only",
    "incomplete",
    "mismatch",
  ].includes(status);
  const fingerprint = JSON.stringify({
    catalogProductId,
    channelId: source.channel.id,
    variants: variants.map((variant) => ({
      variantId: variant.variantId,
      sku: variant.sku,
      isActive: variant.isActive,
      catalogBarcode: variant.catalogBarcode,
      catalogVariantId: variant.catalogVariantId,
      catalogInventoryItemId: variant.catalogInventoryItemId,
      feedId: variant.feedId,
      feedIsActive: variant.feedIsActive,
      feedProductId: variant.feedProductId,
      feedVariantId: variant.feedVariantId,
      feedInventoryItemId: variant.feedInventoryItemId,
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
    activeVariantCount: activeVariants.length,
    archivedVariantCount: variants.length - activeVariants.length,
    activeVariantIssueIds,
    fingerprint,
  };
}

export function collectMappedShopifyVariantIds(summary: ShopifyProductMappingSummary): string[] {
  return uniqueSortedIds(
    summary.variants.filter((variant) => variant.isActive).flatMap((variant) => [
      variant.catalogVariantId,
      variant.feedVariantId,
      variant.listingVariantId,
    ]),
  );
}

export function evaluateShopifyProductMappingRepair(input: {
  summary: ShopifyProductMappingSummary;
  requestedProductId: string | number | null | undefined;
  verifiedRemoteVariants: VerifiedShopifyVariantIdentity[];
  expectedVariant?: {
    variantId: number;
    remoteVariantId: string | number | null | undefined;
  };
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

  const remoteVariants = input.verifiedRemoteVariants
    .map((variant) => ({
      id: normalizeShopifyId(variant.id),
      sku: variant.sku?.trim() || null,
      normalizedSku: normalizeSku(variant.sku),
      inventoryItemId: normalizeShopifyId(variant.inventoryItemId),
      barcode: variant.barcode?.trim() || null,
    }))
    .filter((variant): variant is {
      id: string;
      sku: string | null;
      normalizedSku: string | null;
      inventoryItemId: string | null;
      barcode: string | null;
    } => variant.id !== null);
  const remoteById = new Map(remoteVariants.map((variant) => [variant.id, variant]));
  const remoteBySku = new Map<string, typeof remoteVariants>();
  for (const remoteVariant of remoteVariants) {
    if (!remoteVariant.normalizedSku) continue;
    const variantsForSku = remoteBySku.get(remoteVariant.normalizedSku) ?? [];
    variantsForSku.push(remoteVariant);
    remoteBySku.set(remoteVariant.normalizedSku, variantsForSku);
  }

  const issues: Array<Record<string, unknown>> = [];
  const variantMappings: ShopifyVariantMappingResolution[] = [];
  const assignedRemoteIds = new Map<string, number>();
  for (const variant of input.summary.variants.filter((candidate) => candidate.isActive)) {
    const existingIds = variantMappingIds(variant);
    const verifiedIdMatches = existingIds
      .map((variantId) => remoteById.get(variantId))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
    const normalizedSku = normalizeSku(variant.sku);
    const skuMatches = normalizedSku ? remoteBySku.get(normalizedSku) ?? [] : [];

    let selected = verifiedIdMatches.length === 1 ? verifiedIdMatches[0] : null;
    let matchedBy: ShopifyVariantMappingResolution["matchedBy"] = "existing_id";
    if (verifiedIdMatches.length > 1) {
      issues.push({
        code: "MULTIPLE_LIVE_IDS",
        variantId: variant.variantId,
        sku: variant.sku,
        liveVariantIds: verifiedIdMatches.map((candidate) => candidate.id),
      });
      continue;
    }
    if (selected && normalizedSku && selected.normalizedSku !== normalizedSku) {
      issues.push({
        code: "ID_SKU_MISMATCH",
        variantId: variant.variantId,
        sku: variant.sku,
        mappedVariantId: selected.id,
        liveSku: selected.sku,
      });
      continue;
    }
    if (selected && skuMatches.length === 1 && skuMatches[0].id !== selected.id) {
      issues.push({
        code: "ID_SKU_CONFLICT",
        variantId: variant.variantId,
        sku: variant.sku,
        mappedVariantId: selected.id,
        skuMatchedVariantId: skuMatches[0].id,
      });
      continue;
    }
    if (!selected) {
      matchedBy = "exact_sku";
      if (!normalizedSku) {
        issues.push({ code: "LOCAL_SKU_MISSING", variantId: variant.variantId });
        continue;
      }
      if (skuMatches.length === 0) {
        issues.push({
          code: "EXACT_SKU_NOT_FOUND",
          variantId: variant.variantId,
          sku: variant.sku,
          staleVariantIds: existingIds,
        });
        continue;
      }
      if (skuMatches.length > 1) {
        issues.push({
          code: "EXACT_SKU_AMBIGUOUS",
          variantId: variant.variantId,
          sku: variant.sku,
          liveVariantIds: skuMatches.map((candidate) => candidate.id),
        });
        continue;
      }
      selected = skuMatches[0];
    }
    if (!selected.inventoryItemId) {
      issues.push({
        code: "INVENTORY_ITEM_ID_MISSING",
        variantId: variant.variantId,
        sku: variant.sku,
        liveVariantId: selected.id,
      });
      continue;
    }
    const previousOwner = assignedRemoteIds.get(selected.id);
    if (previousOwner !== undefined) {
      issues.push({
        code: "LIVE_VARIANT_ASSIGNED_TWICE",
        variantId: variant.variantId,
        sku: variant.sku,
        liveVariantId: selected.id,
        otherVariantId: previousOwner,
      });
      continue;
    }
    assignedRemoteIds.set(selected.id, variant.variantId);
    variantMappings.push({
      variantId: variant.variantId,
      sku: variant.sku?.trim() || selected.sku || "",
      remoteSku: selected.sku,
      remoteBarcode: selected.barcode,
      remoteVariantId: selected.id,
      remoteInventoryItemId: selected.inventoryItemId,
      matchedBy,
      replacedVariantIds: existingIds.filter((variantId) => variantId !== selected.id),
    });
  }

  if (input.expectedVariant) {
    const expectedRemoteVariantId = normalizeShopifyId(input.expectedVariant.remoteVariantId);
    const resolvedVariant = variantMappings.find(
      (mapping) => mapping.variantId === input.expectedVariant?.variantId,
    );
    if (!expectedRemoteVariantId || resolvedVariant?.remoteVariantId !== expectedRemoteVariantId) {
      issues.push({
        code: "SELECTED_VARIANT_MISMATCH",
        variantId: input.expectedVariant.variantId,
        selectedRemoteVariantId: expectedRemoteVariantId,
        resolvedRemoteVariantId: resolvedVariant?.remoteVariantId ?? null,
      });
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      code: "SHOPIFY_ACTIVE_VARIANTS_UNRESOLVED",
      context: { targetProductId, issues },
    };
  }

  return {
    ok: true,
    targetProductId,
    mappedVariantIds: variantMappings.map((variant) => variant.remoteVariantId).sort(),
    variantMappings,
  };
}
