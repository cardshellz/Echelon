import type {
  ShopifyProductMappingStatus,
} from "./shopify-product-mapping.domain";

export const SHOPIFY_MAPPING_ISSUE_CODES = [
  "catalog_product_id_missing",
  "invalid_shopify_product_id",
  "remote_product_missing",
  "duplicate_local_owner",
  "local_mapping_inconsistent",
  "shipping_group_conflict",
  "storefront_shipping_group_drift",
] as const;

export type ShopifyMappingIssueCode =
  (typeof SHOPIFY_MAPPING_ISSUE_CODES)[number];

export const SHOPIFY_OWNERSHIP_DECISION_REASONS = [
  "single_active_owner_with_matching_evidence",
  "remote_product_missing",
  "owner_count_exceeds_two",
  "shipping_group_conflict",
  "owner_mapping_conflict",
  "multiple_active_owners",
  "no_active_owner",
  "active_owner_catalog_id_mismatch",
  "active_owner_missing_channel_evidence",
] as const;

export type ShopifyOwnershipDecisionReason =
  (typeof SHOPIFY_OWNERSHIP_DECISION_REASONS)[number];

export const SHOPIFY_OWNERSHIP_REVIEW_FILTERS = [
  "all",
  "canonical_owner_recommended",
  "manual_review",
] as const;

export type ShopifyOwnershipReviewFilter =
  (typeof SHOPIFY_OWNERSHIP_REVIEW_FILTERS)[number];

export interface ShopifyMappingLocalProduct {
  productId: number;
  productName: string;
  productSku: string | null;
  rawShopifyProductId: string | null;
  shopifyProductId: string | null;
  shippingGroupCode: string | null;
  mappingStatus: ShopifyProductMappingStatus;
  mappingFingerprint: string;
  evidenceProductIds: string[];
  activeVariantCount: number;
  activeVariantIssueIds: number[];
}

export interface ShopifyRemoteProductSnapshot {
  productId: string;
  exists: boolean;
  title: string | null;
  status: string | null;
  shippingGroupCode: string | null;
}

export interface ShopifyMappingReconciliationItem
  extends ShopifyMappingLocalProduct {
  remoteTitle: string | null;
  remoteStatus: string | null;
  remoteShippingGroupCode: string | null;
  comparedShopifyProductId: string | null;
  ownerProductIds: number[];
  issueCodes: ShopifyMappingIssueCode[];
  canRetireDeadMapping: boolean;
}

export interface ShopifyDuplicateOwnershipOwner {
  productId: number;
  productName: string;
  productSku: string | null;
  shopifyProductId: string | null;
  shippingGroupCode: string | null;
  mappingStatus: ShopifyProductMappingStatus;
  activeVariantCount: number;
  activeVariantIssueCount: number;
  hasChannelEvidence: boolean;
}

export interface ShopifyDuplicateOwnershipGroup {
  shopifyProductId: string;
  remoteTitle: string | null;
  remoteStatus: string | null;
  shippingGroupCode: string | null;
  ownerProductIds: number[];
  owners: ShopifyDuplicateOwnershipOwner[];
  decision: "canonical_owner_recommended" | "manual_review";
  reason: ShopifyOwnershipDecisionReason;
  recommendedProductId: number | null;
  nonCanonicalProductIds: number[];
}

export interface ShopifyOwnershipReviewPage {
  generatedAt: string;
  readOnly: true;
  channel: {
    id: number;
    name: string;
    shopDomain: string;
  };
  summary: {
    duplicateOwnershipGroupCount: number;
    canonicalOwnerRecommendationCount: number;
    manualReviewOwnershipGroupCount: number;
  };
  filter: ShopifyOwnershipReviewFilter;
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  items: ShopifyDuplicateOwnershipGroup[];
}

export interface ShopifyMappingReconciliationReport {
  generatedAt: string;
  channel: {
    id: number;
    name: string;
    shopDomain: string;
  };
  summary: {
    localProductCount: number;
    uniqueShopifyProductCount: number;
    healthyProductCount: number;
    issueProductCount: number;
    issueCounts: Record<ShopifyMappingIssueCode, number>;
  };
  items: ShopifyMappingReconciliationItem[];
}

function distinctValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function compareNullableStrings(
  left: string | null,
  right: string | null,
): boolean {
  return left === right;
}

function emptyIssueCounts(): Record<ShopifyMappingIssueCode, number> {
  return Object.fromEntries(
    SHOPIFY_MAPPING_ISSUE_CODES.map((code) => [code, 0]),
  ) as Record<ShopifyMappingIssueCode, number>;
}

function uniqueOwners(
  owners: ShopifyMappingLocalProduct[],
): ShopifyMappingLocalProduct[] {
  return [...new Map(
    owners.map((owner) => [owner.productId, owner]),
  ).values()]
    .sort((left, right) => left.productId - right.productId);
}

function indexOwnersByShopifyProductId(
  localProducts: ShopifyMappingLocalProduct[],
): Map<string, ShopifyMappingLocalProduct[]> {
  const ownersByShopifyProductId = new Map<
    string,
    ShopifyMappingLocalProduct[]
  >();
  for (const product of localProducts) {
    const ownedProductIds = distinctValues([
      product.shopifyProductId,
      ...product.evidenceProductIds,
    ].filter((productId): productId is string => productId !== null));
    for (const ownedProductId of ownedProductIds) {
      const owners = ownersByShopifyProductId.get(ownedProductId) ?? [];
      owners.push(product);
      ownersByShopifyProductId.set(ownedProductId, owners);
    }
  }
  return ownersByShopifyProductId;
}

export function collectDuplicateShopifyOwnershipProductIds(
  localProducts: ShopifyMappingLocalProduct[],
): string[] {
  return [...indexOwnersByShopifyProductId(localProducts).entries()]
    .filter(([, owners]) => uniqueOwners(owners).length > 1)
    .map(([shopifyProductId]) => shopifyProductId)
    .sort((left, right) =>
      left.localeCompare(right, "en", { numeric: true }));
}

function buildDuplicateOwnershipGroup(input: {
  shopifyProductId: string;
  owners: ShopifyMappingLocalProduct[];
  remote: ShopifyRemoteProductSnapshot | undefined;
}): ShopifyDuplicateOwnershipGroup {
  const owners = uniqueOwners(input.owners);
  const activeOwners = owners.filter((owner) => owner.activeVariantCount > 0);
  const shippingGroups = distinctValues(
    owners.map((owner) => owner.shippingGroupCode),
  );

  let decision: ShopifyDuplicateOwnershipGroup["decision"] = "manual_review";
  let reason: ShopifyOwnershipDecisionReason;
  let recommendedProductId: number | null = null;

  if (!input.remote?.exists) {
    reason = "remote_product_missing";
  } else if (owners.length > 2) {
    reason = "owner_count_exceeds_two";
  } else if (shippingGroups.length > 1) {
    reason = "shipping_group_conflict";
  } else if (owners.some((owner) => owner.mappingStatus === "conflict")) {
    reason = "owner_mapping_conflict";
  } else if (activeOwners.length > 1) {
    reason = "multiple_active_owners";
  } else if (activeOwners.length === 0) {
    reason = "no_active_owner";
  } else if (
    activeOwners[0].shopifyProductId !== input.shopifyProductId
  ) {
    reason = "active_owner_catalog_id_mismatch";
  } else if (
    !activeOwners[0].evidenceProductIds.includes(input.shopifyProductId)
  ) {
    reason = "active_owner_missing_channel_evidence";
  } else {
    decision = "canonical_owner_recommended";
    reason = "single_active_owner_with_matching_evidence";
    recommendedProductId = activeOwners[0].productId;
  }

  const ownerProductIds = owners.map((owner) => owner.productId);
  return {
    shopifyProductId: input.shopifyProductId,
    remoteTitle: input.remote?.title ?? null,
    remoteStatus: input.remote?.status ?? null,
    shippingGroupCode: shippingGroups.length === 1
      ? shippingGroups[0]
      : null,
    ownerProductIds,
    owners: owners.map((owner) => ({
      productId: owner.productId,
      productName: owner.productName,
      productSku: owner.productSku,
      shopifyProductId: owner.shopifyProductId,
      shippingGroupCode: owner.shippingGroupCode,
      mappingStatus: owner.mappingStatus,
      activeVariantCount: owner.activeVariantCount,
      activeVariantIssueCount: owner.activeVariantIssueIds.length,
      hasChannelEvidence: owner.evidenceProductIds.includes(
        input.shopifyProductId,
      ),
    })),
    decision,
    reason,
    recommendedProductId,
    nonCanonicalProductIds: recommendedProductId === null
      ? []
      : ownerProductIds.filter(
        (productId) => productId !== recommendedProductId,
      ),
  };
}

export function buildShopifyOwnershipReview(input: {
  generatedAt: string;
  channel: {
    id: number;
    name: string;
    shopDomain: string;
  };
  localProducts: ShopifyMappingLocalProduct[];
  remoteProducts: Map<string, ShopifyRemoteProductSnapshot>;
  filter: ShopifyOwnershipReviewFilter;
  page: number;
  pageSize: number;
}): ShopifyOwnershipReviewPage {
  if (
    !Number.isInteger(input.page)
    || input.page < 1
    || input.page > 10_000
  ) {
    throw new RangeError(
      "Ownership review page must be an integer from 1 through 10000",
    );
  }
  if (
    !Number.isInteger(input.pageSize)
    || input.pageSize < 1
    || input.pageSize > 50
  ) {
    throw new RangeError(
      "Ownership review page size must be an integer from 1 through 50",
    );
  }

  const ownersByShopifyProductId = indexOwnersByShopifyProductId(
    input.localProducts,
  );

  const ownershipGroups = [...ownersByShopifyProductId.entries()]
    .filter(([, owners]) => uniqueOwners(owners).length > 1)
    .map(([shopifyProductId, owners]) => buildDuplicateOwnershipGroup({
      shopifyProductId,
      owners,
      remote: input.remoteProducts.get(shopifyProductId),
    }))
    .sort((left, right) => {
      const decisionOrder = Number(
        left.decision === "canonical_owner_recommended",
      ) - Number(right.decision === "canonical_owner_recommended");
      if (decisionOrder !== 0) return decisionOrder;
      const titleOrder = (left.remoteTitle ?? "").localeCompare(
        right.remoteTitle ?? "",
      );
      return titleOrder !== 0
        ? titleOrder
        : left.shopifyProductId.localeCompare(
          right.shopifyProductId,
          "en",
          { numeric: true },
        );
    });
  const filteredGroups = input.filter === "all"
    ? ownershipGroups
    : ownershipGroups.filter((group) => group.decision === input.filter);
  const offset = (input.page - 1) * input.pageSize;

  return {
    generatedAt: input.generatedAt,
    readOnly: true,
    channel: input.channel,
    summary: {
      duplicateOwnershipGroupCount: ownershipGroups.length,
      canonicalOwnerRecommendationCount: ownershipGroups.filter(
        (group) => group.decision === "canonical_owner_recommended",
      ).length,
      manualReviewOwnershipGroupCount: ownershipGroups.filter(
        (group) => group.decision === "manual_review",
      ).length,
    },
    filter: input.filter,
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      totalItems: filteredGroups.length,
      totalPages: Math.ceil(filteredGroups.length / input.pageSize),
    },
    items: filteredGroups.slice(offset, offset + input.pageSize),
  };
}

export function normalizeShopifyProductReference(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  const gidMatch = trimmed.match(/^gid:\/\/shopify\/Product\/(\d+)$/);
  if (gidMatch) return gidMatch[1];

  return null;
}

export function normalizeShopifyAdminDomain(value: string): string | null {
  const normalized = value.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!normalized) return null;

  const withSuffix = normalized.includes(".")
    ? normalized
    : `${normalized}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(withSuffix)
    ? withSuffix
    : null;
}

export function buildShopifyMappingReconciliationReport(input: {
  generatedAt: string;
  channel: {
    id: number;
    name: string;
    shopDomain: string;
  };
  localProducts: ShopifyMappingLocalProduct[];
  remoteProducts: Map<string, ShopifyRemoteProductSnapshot>;
}): ShopifyMappingReconciliationReport {
  const ownersByShopifyProductId = new Map<
    string,
    ShopifyMappingLocalProduct[]
  >();

  for (const product of input.localProducts) {
    const ownedProductIds = distinctValues([
      product.shopifyProductId,
      ...product.evidenceProductIds,
    ].filter((productId): productId is string => productId !== null));
    for (const ownedProductId of ownedProductIds) {
      const owners = ownersByShopifyProductId.get(ownedProductId) ?? [];
      owners.push(product);
      ownersByShopifyProductId.set(ownedProductId, owners);
    }
  }

  const items = input.localProducts.map((product) => {
    const ownedProductIds = distinctValues([
      product.shopifyProductId,
      ...product.evidenceProductIds,
    ].filter((productId): productId is string => productId !== null));
    const owners = distinctValues(
      ownedProductIds.flatMap(
        (ownedProductId) =>
          ownersByShopifyProductId.get(ownedProductId) ?? [],
      ),
    );
    const ownerProductIds = distinctValues([
      product.productId,
      ...owners.map((owner) => owner.productId),
    ])
      .sort((left, right) => left - right);
    const ownerShippingGroups = distinctValues(
      [product, ...owners].map((owner) => owner.shippingGroupCode),
    );
    const comparedShopifyProductId = product.shopifyProductId
      ?? (product.evidenceProductIds.length === 1
        ? product.evidenceProductIds[0]
        : null);
    const remote = comparedShopifyProductId
      ? input.remoteProducts.get(comparedShopifyProductId)
      : undefined;
    const issueCodes: ShopifyMappingIssueCode[] = [];

    if (!product.rawShopifyProductId?.trim()) {
      issueCodes.push("catalog_product_id_missing");
    } else if (!product.shopifyProductId) {
      issueCodes.push("invalid_shopify_product_id");
    }
    if (comparedShopifyProductId && !remote?.exists) {
      issueCodes.push("remote_product_missing");
    }

    if (ownerProductIds.length > 1) {
      issueCodes.push("duplicate_local_owner");
      if (ownerShippingGroups.length > 1) {
        issueCodes.push("shipping_group_conflict");
      }
    }
    if (
      product.shopifyProductId
      && remote?.exists
      && !compareNullableStrings(
        product.shippingGroupCode,
        remote.shippingGroupCode,
      )
    ) {
      issueCodes.push("storefront_shipping_group_drift");
    }

    if (product.mappingStatus !== "consistent") {
      issueCodes.push("local_mapping_inconsistent");
    }

    return {
      ...product,
      remoteTitle: remote?.title ?? null,
      remoteStatus: remote?.status ?? null,
      remoteShippingGroupCode: remote?.shippingGroupCode ?? null,
      comparedShopifyProductId,
      ownerProductIds,
      issueCodes,
      canRetireDeadMapping: (
        product.shopifyProductId !== null
        && issueCodes.includes("remote_product_missing")
      ),
    };
  }).sort((left, right) => {
    const issueOrder = Number(right.issueCodes.length > 0)
      - Number(left.issueCodes.length > 0);
    if (issueOrder !== 0) return issueOrder;
    const nameOrder = left.productName.localeCompare(right.productName);
    return nameOrder !== 0 ? nameOrder : left.productId - right.productId;
  });

  const issueCounts = emptyIssueCounts();
  for (const item of items) {
    for (const issueCode of item.issueCodes) {
      issueCounts[issueCode] += 1;
    }
  }

  return {
    generatedAt: input.generatedAt,
    channel: input.channel,
    summary: {
      localProductCount: items.length,
      uniqueShopifyProductCount: ownersByShopifyProductId.size,
      healthyProductCount: items.filter((item) => item.issueCodes.length === 0)
        .length,
      issueProductCount: items.filter((item) => item.issueCodes.length > 0)
        .length,
      issueCounts,
    },
    items,
  };
}

export function evaluateDeadMappingRetirement(input: {
  expectedProductId: string;
  remoteProductExists: boolean;
  liveVariantIds: string[];
}):
  | { ok: true }
  | {
      ok: false;
      code: "SHOPIFY_PRODUCT_STILL_EXISTS" | "SHOPIFY_VARIANT_STILL_EXISTS";
      context: Record<string, unknown>;
    } {
  if (input.remoteProductExists) {
    return {
      ok: false,
      code: "SHOPIFY_PRODUCT_STILL_EXISTS",
      context: { shopifyProductId: input.expectedProductId },
    };
  }

  if (input.liveVariantIds.length > 0) {
    return {
      ok: false,
      code: "SHOPIFY_VARIANT_STILL_EXISTS",
      context: {
        shopifyProductId: input.expectedProductId,
        liveVariantIds: [...input.liveVariantIds].sort((left, right) =>
          left.localeCompare(right, "en", { numeric: true })),
      },
    };
  }

  return { ok: true };
}
