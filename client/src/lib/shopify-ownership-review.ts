import { z } from "zod";

export const SHOPIFY_OWNERSHIP_REPAIR_MAX_GROUPS = 100;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const shopifyOwnershipReviewFilterSchema = z.enum([
  "all",
  "canonical_owner_recommended",
  "manual_review",
]);

const ownershipDecisionReasonSchema = z.enum([
  "single_active_owner_with_matching_evidence",
  "remote_product_missing",
  "owner_count_exceeds_two",
  "shipping_group_conflict",
  "owner_mapping_conflict",
  "multiple_active_owners",
  "no_active_owner",
  "active_owner_catalog_id_mismatch",
  "active_owner_missing_channel_evidence",
]);

const ownershipOwnerSchema = z.object({
  productId: z.number().int().positive(),
  productName: z.string(),
  productSku: z.string().nullable(),
  shopifyProductId: z.string().nullable(),
  shippingGroupCode: z.string().nullable(),
  mappingStatus: z.string().min(1),
  mappingFingerprint: z.string().min(1),
  activeVariantCount: z.number().int().nonnegative(),
  activeVariantIssueCount: z.number().int().nonnegative(),
  hasChannelEvidence: z.boolean(),
  hasCanonicalChannelProductEvidence: z.boolean(),
}).strict();

const ownershipGroupSchema = z.object({
  shopifyProductId: z.string().regex(/^\d+$/),
  remoteExists: z.boolean(),
  remoteTitle: z.string().nullable(),
  remoteStatus: z.string().nullable(),
  remoteShippingGroupCode: z.string().nullable(),
  shippingGroupCode: z.string().nullable(),
  ownerProductIds: z.array(z.number().int().positive()),
  owners: z.array(ownershipOwnerSchema).min(2),
  decision: z.enum(["canonical_owner_recommended", "manual_review"]),
  reason: ownershipDecisionReasonSchema,
  recommendedProductId: z.number().int().positive().nullable(),
  nonCanonicalProductIds: z.array(z.number().int().positive()),
  previewHash: sha256Schema,
}).strict();

const ownershipReviewResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  readOnly: z.literal(true),
  channel: z.object({
    id: z.number().int().positive(),
    name: z.string(),
    shopDomain: z.string().min(1),
  }).strict(),
  summary: z.object({
    duplicateOwnershipGroupCount: z.number().int().nonnegative(),
    canonicalOwnerRecommendationCount: z.number().int().nonnegative(),
    manualReviewOwnershipGroupCount: z.number().int().nonnegative(),
  }).strict(),
  filter: shopifyOwnershipReviewFilterSchema,
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().min(1)
      .max(SHOPIFY_OWNERSHIP_REPAIR_MAX_GROUPS),
    totalItems: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }).strict(),
  items: z.array(ownershipGroupSchema),
}).strict();

const ownershipReviewRequestSchema = z.object({
  channelId: z.number().int().positive(),
  filter: shopifyOwnershipReviewFilterSchema,
  page: z.number().int().min(1).max(10_000),
  pageSize: z.number().int().min(1).max(SHOPIFY_OWNERSHIP_REPAIR_MAX_GROUPS),
}).strict();

const ownershipRepairRecommendationSchema = z.object({
  shopifyProductId: z.string().regex(/^\d+$/),
  expectedPreviewHash: sha256Schema,
}).strict();

const ownershipRepairRequestSchema = z.object({
  channelId: z.number().int().positive(),
  expectedShopDomain: z.string().trim().min(1).max(255),
  recommendations: z.array(ownershipRepairRecommendationSchema)
    .min(1)
    .max(SHOPIFY_OWNERSHIP_REPAIR_MAX_GROUPS),
  idempotencyKey: z.string().uuid(),
  reason: z.string().trim().min(1).max(500)
    .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.recommendations.forEach((recommendation, index) => {
    if (seen.has(recommendation.shopifyProductId)) {
      context.addIssue({
        code: "custom",
        path: ["recommendations", index, "shopifyProductId"],
        message: "Each Shopify product may appear only once",
      });
    }
    seen.add(recommendation.shopifyProductId);
  });
});

const ownershipRepairResponseSchema = z.object({
  contractVersion: z.literal(1),
  commandId: z.number().int().positive(),
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
  idempotentReplay: z.boolean(),
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
      message: "Invalid recommended owner receipt",
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
      message: "Invalid detached owner receipt",
    });
  }
});

export type ShopifyOwnershipReviewFilter = z.infer<
  typeof shopifyOwnershipReviewFilterSchema
>;
export type ShopifyOwnershipReviewResponse = z.infer<
  typeof ownershipReviewResponseSchema
>;
export type ShopifyDuplicateOwnershipGroup =
  ShopifyOwnershipReviewResponse["items"][number];
export type ShopifyOwnershipRepairRequest = Omit<
  z.infer<typeof ownershipRepairRequestSchema>,
  "channelId"
>;
export type ShopifyOwnershipRepairResponse = z.infer<
  typeof ownershipRepairResponseSchema
>;

export class ShopifyOwnershipRepairApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super(message);
    this.name = "ShopifyOwnershipRepairApiError";
  }
}

export async function fetchShopifyOwnershipReview(input: {
  channelId: number;
  filter: ShopifyOwnershipReviewFilter;
  page: number;
  pageSize: number;
}): Promise<ShopifyOwnershipReviewResponse> {
  const request = ownershipReviewRequestSchema.parse(input);
  const query = new URLSearchParams({
    filter: request.filter,
    page: String(request.page),
    pageSize: String(request.pageSize),
  });
  const response = await fetch(
    `/api/channels/${request.channelId}/shopify-mapping-reconciliation/ownership-review?${query.toString()}`,
    { credentials: "include" },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      && typeof body.error === "string"
      ? body.error
      : `Ownership review failed (${response.status})`;
    throw new Error(message);
  }

  const parsed = ownershipReviewResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Ownership review returned an invalid response");
  }
  return parsed.data;
}

export async function applyShopifyOwnershipRepair(input: {
  channelId: number;
  request: ShopifyOwnershipRepairRequest;
}): Promise<ShopifyOwnershipRepairResponse> {
  const parsed = ownershipRepairRequestSchema.parse({
    channelId: input.channelId,
    ...input.request,
  });
  const { channelId, ...request } = parsed;
  const response = await fetch(
    `/api/channels/${channelId}/shopify-mapping-reconciliation/ownership-review/apply`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      && typeof body.error === "string"
      ? body.error
      : `Ownership repair failed (${response.status})`;
    const code = body && typeof body === "object" && "code" in body
      && typeof body.code === "string"
      ? body.code
      : null;
    throw new ShopifyOwnershipRepairApiError(message, response.status, code);
  }
  const result = ownershipRepairResponseSchema.safeParse(body);
  if (!result.success) {
    throw new Error("Ownership repair returned an invalid response");
  }
  return result.data;
}
