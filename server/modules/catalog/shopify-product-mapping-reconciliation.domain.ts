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
