import { z } from "zod";

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
  activeVariantCount: z.number().int().nonnegative(),
  activeVariantIssueCount: z.number().int().nonnegative(),
  hasChannelEvidence: z.boolean(),
}).strict();

const ownershipGroupSchema = z.object({
  shopifyProductId: z.string().regex(/^\d+$/),
  remoteTitle: z.string().nullable(),
  remoteStatus: z.string().nullable(),
  shippingGroupCode: z.string().nullable(),
  ownerProductIds: z.array(z.number().int().positive()),
  owners: z.array(ownershipOwnerSchema).min(2),
  decision: z.enum(["canonical_owner_recommended", "manual_review"]),
  reason: ownershipDecisionReasonSchema,
  recommendedProductId: z.number().int().positive().nullable(),
  nonCanonicalProductIds: z.array(z.number().int().positive()),
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
    pageSize: z.number().int().min(1).max(50),
    totalItems: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }).strict(),
  items: z.array(ownershipGroupSchema),
}).strict();

const ownershipReviewRequestSchema = z.object({
  channelId: z.number().int().positive(),
  filter: shopifyOwnershipReviewFilterSchema,
  page: z.number().int().min(1).max(10_000),
  pageSize: z.number().int().min(1).max(50),
}).strict();

export type ShopifyOwnershipReviewFilter = z.infer<
  typeof shopifyOwnershipReviewFilterSchema
>;
export type ShopifyOwnershipReviewResponse = z.infer<
  typeof ownershipReviewResponseSchema
>;
export type ShopifyDuplicateOwnershipGroup =
  ShopifyOwnershipReviewResponse["items"][number];

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
