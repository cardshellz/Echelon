import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJson } from "@shared/utils/canonical-json";
import type {
  ShopifyProductMappingStatus,
} from "./shopify-product-mapping.domain";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const safeText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/);

export const SHOPIFY_OWNERSHIP_REPAIR_MAX_GROUPS = 100;

export const shopifyOwnershipRepairRecommendationSchema = z.object({
  shopifyProductId: z.string().regex(/^\d+$/),
  expectedPreviewHash: sha256Schema,
}).strict();

export const shopifyOwnershipRepairRecommendationsSchema = z.array(
  shopifyOwnershipRepairRecommendationSchema,
)
  .min(1)
  .max(SHOPIFY_OWNERSHIP_REPAIR_MAX_GROUPS)
  .superRefine((recommendations, context) => {
    const seen = new Set<string>();
    recommendations.forEach((recommendation, index) => {
      if (seen.has(recommendation.shopifyProductId)) {
        context.addIssue({
          code: "custom",
          path: [index, "shopifyProductId"],
          message: "Each Shopify product may appear only once",
        });
      }
      seen.add(recommendation.shopifyProductId);
    });
  });

export const shopifyOwnershipRepairApplySchema = z.object({
  expectedShopDomain: z.string().trim().min(1).max(255),
  recommendations: shopifyOwnershipRepairRecommendationsSchema,
  idempotencyKey: z.string().uuid(),
  reason: safeText(500),
}).strict();

export type ShopifyOwnershipRepairApplyInput = z.infer<
  typeof shopifyOwnershipRepairApplySchema
>;

export type ShopifyOwnershipRepairRecommendation = z.infer<
  typeof shopifyOwnershipRepairRecommendationSchema
>;

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
  hasCanonicalChannelProductEvidence: boolean;
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
  mappingFingerprint: string;
  activeVariantCount: number;
  activeVariantIssueCount: number;
  hasChannelEvidence: boolean;
  hasCanonicalChannelProductEvidence: boolean;
}

export interface ShopifyDuplicateOwnershipGroup {
  shopifyProductId: string;
  remoteExists: boolean;
  remoteTitle: string | null;
  remoteStatus: string | null;
  remoteShippingGroupCode: string | null;
  shippingGroupCode: string | null;
  ownerProductIds: number[];
  owners: ShopifyDuplicateOwnershipOwner[];
  decision: "canonical_owner_recommended" | "manual_review";
  reason: ShopifyOwnershipDecisionReason;
  recommendedProductId: number | null;
  nonCanonicalProductIds: number[];
  previewHash: string;
}

export interface ShopifyOwnershipRepairResult {
  readonly contractVersion: 1;
  readonly channelId: number;
  readonly shopDomain: string;
  readonly previewHash: string;
  readonly resolvedGroupCount: number;
  readonly recommendedProductIds: readonly number[];
  readonly detachedProductIds: readonly number[];
  readonly clearedCatalogProductCount: number;
  readonly clearedCatalogVariantCount: number;
  readonly detachedFeedCount: number;
  readonly resetListingCount: number;
  readonly completedAt: string;
}

export interface ShopifyOwnershipRepairCommandRecord {
  readonly id: number;
  readonly channelId: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly previewHash: string;
  readonly operator: string;
  readonly reason: string;
  readonly recommendations: readonly ShopifyOwnershipRepairRecommendation[];
  readonly result: ShopifyOwnershipRepairResult;
}

export interface ShopifyOwnershipRepairExecutionResult
  extends ShopifyOwnershipRepairResult {
  readonly commandId: number;
  readonly idempotentReplay: boolean;
}

export const shopifyOwnershipRepairResultSchema:
z.ZodType<ShopifyOwnershipRepairResult> = z.object({
  contractVersion: z.literal(1),
  channelId: z.number().int().positive(),
  shopDomain: z.string().min(1).max(255),
  previewHash: sha256Schema,
  resolvedGroupCount: z.number().int().positive(),
  recommendedProductIds: z.array(z.number().int().positive()),
  detachedProductIds: z.array(z.number().int().positive()),
  clearedCatalogProductCount: z.number().int().nonnegative(),
  clearedCatalogVariantCount: z.number().int().nonnegative(),
  detachedFeedCount: z.number().int().nonnegative(),
  resetListingCount: z.number().int().nonnegative(),
  completedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  const recommended = [...value.recommendedProductIds];
  const detached = [...value.detachedProductIds];
  const recommendedSorted = [...new Set(recommended)].sort(
    (left, right) => left - right,
  );
  const detachedSorted = [...new Set(detached)].sort(
    (left, right) => left - right,
  );
  if (
    recommended.length !== value.resolvedGroupCount
    || JSON.stringify(recommended) !== JSON.stringify(recommendedSorted)
  ) {
    context.addIssue({
      code: "custom",
      path: ["recommendedProductIds"],
      message: "Recommended product IDs must be unique, sorted, and match the resolved group count",
    });
  }
  if (
    detached.length !== value.resolvedGroupCount
    || JSON.stringify(detached) !== JSON.stringify(detachedSorted)
    || value.clearedCatalogProductCount !== detached.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["detachedProductIds"],
      message: "Detached product IDs and cleared product count must match the resolved groups",
    });
  }
});

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

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function orderedRepairRecommendations(
  recommendations: readonly ShopifyOwnershipRepairRecommendation[],
): ShopifyOwnershipRepairRecommendation[] {
  return [...recommendations].sort((left, right) =>
    left.shopifyProductId.localeCompare(
      right.shopifyProductId,
      "en",
      { numeric: true },
    ));
}

export function shopifyOwnershipRepairPreviewHash(input: {
  channelId: number;
  shopDomain: string;
  recommendations: readonly ShopifyOwnershipRepairRecommendation[];
}): string {
  return sha256({
    contractVersion: 1,
    channelId: input.channelId,
    shopDomain: input.shopDomain,
    recommendations: orderedRepairRecommendations(input.recommendations),
  });
}

export function shopifyOwnershipRepairRequestHash(input: {
  channelId: number;
  shopDomain: string;
  recommendations: readonly ShopifyOwnershipRepairRecommendation[];
  operator: string;
  reason: string;
}): string {
  return sha256({
    contractVersion: 1,
    channelId: input.channelId,
    shopDomain: input.shopDomain,
    recommendations: orderedRepairRecommendations(input.recommendations),
    operator: input.operator,
    reason: input.reason,
  });
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
  channel: ShopifyMappingReconciliationReport["channel"];
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
    || !activeOwners[0].hasCanonicalChannelProductEvidence
  ) {
    reason = "active_owner_missing_channel_evidence";
  } else {
    decision = "canonical_owner_recommended";
    reason = "single_active_owner_with_matching_evidence";
    recommendedProductId = activeOwners[0].productId;
  }

  const ownerProductIds = owners.map((owner) => owner.productId);
  const ownerEvidence: ShopifyDuplicateOwnershipOwner[] = owners.map((owner) => ({
    productId: owner.productId,
    productName: owner.productName,
    productSku: owner.productSku,
    shopifyProductId: owner.shopifyProductId,
    shippingGroupCode: owner.shippingGroupCode,
    mappingStatus: owner.mappingStatus,
    mappingFingerprint: owner.mappingFingerprint,
    activeVariantCount: owner.activeVariantCount,
    activeVariantIssueCount: owner.activeVariantIssueIds.length,
    hasChannelEvidence: owner.evidenceProductIds.includes(
      input.shopifyProductId,
    ),
    hasCanonicalChannelProductEvidence:
      owner.hasCanonicalChannelProductEvidence,
  }));
  const groupWithoutHash = {
    shopifyProductId: input.shopifyProductId,
    remoteExists: input.remote?.exists === true,
    remoteTitle: input.remote?.title ?? null,
    remoteStatus: input.remote?.status ?? null,
    remoteShippingGroupCode: input.remote?.shippingGroupCode ?? null,
    shippingGroupCode: shippingGroups.length === 1
      ? shippingGroups[0]
      : null,
    ownerProductIds,
    owners: ownerEvidence,
    decision,
    reason,
    recommendedProductId,
    nonCanonicalProductIds: recommendedProductId === null
      ? []
      : ownerProductIds.filter(
        (productId) => productId !== recommendedProductId,
      ),
  };
  return {
    ...groupWithoutHash,
    previewHash: sha256({
      contractVersion: 1,
      channel: {
        id: input.channel.id,
        shopDomain: input.channel.shopDomain,
      },
      group: {
        shopifyProductId: groupWithoutHash.shopifyProductId,
        remoteExists: groupWithoutHash.remoteExists,
        remoteStatus: groupWithoutHash.remoteStatus,
        remoteShippingGroupCode: groupWithoutHash.remoteShippingGroupCode,
        shippingGroupCode: groupWithoutHash.shippingGroupCode,
        ownerProductIds: groupWithoutHash.ownerProductIds,
        owners: groupWithoutHash.owners.map((owner) => ({
          productId: owner.productId,
          shopifyProductId: owner.shopifyProductId,
          shippingGroupCode: owner.shippingGroupCode,
          mappingStatus: owner.mappingStatus,
          mappingFingerprint: owner.mappingFingerprint,
          activeVariantCount: owner.activeVariantCount,
          activeVariantIssueCount: owner.activeVariantIssueCount,
          hasChannelEvidence: owner.hasChannelEvidence,
          hasCanonicalChannelProductEvidence:
            owner.hasCanonicalChannelProductEvidence,
        })),
        decision: groupWithoutHash.decision,
        reason: groupWithoutHash.reason,
        recommendedProductId: groupWithoutHash.recommendedProductId,
        nonCanonicalProductIds: groupWithoutHash.nonCanonicalProductIds,
      },
    }),
  };
}

export function buildShopifyOwnershipGroups(input: {
  channel: ShopifyMappingReconciliationReport["channel"];
  localProducts: ShopifyMappingLocalProduct[];
  remoteProducts: Map<string, ShopifyRemoteProductSnapshot>;
}): ShopifyDuplicateOwnershipGroup[] {
  const ownersByShopifyProductId = indexOwnersByShopifyProductId(
    input.localProducts,
  );
  return [...ownersByShopifyProductId.entries()]
    .filter(([, owners]) => uniqueOwners(owners).length > 1)
    .map(([shopifyProductId, owners]) => buildDuplicateOwnershipGroup({
      shopifyProductId,
      owners,
      remote: input.remoteProducts.get(shopifyProductId),
      channel: input.channel,
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
    || input.pageSize > SHOPIFY_OWNERSHIP_REPAIR_MAX_GROUPS
  ) {
    throw new RangeError(
      `Ownership review page size must be an integer from 1 through ${SHOPIFY_OWNERSHIP_REPAIR_MAX_GROUPS}`,
    );
  }

  const ownershipGroups = buildShopifyOwnershipGroups(input);
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
