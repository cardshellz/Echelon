import { z } from "zod";

const positiveId = z.number().int().positive();
const nonnegativeCount = z.number().int().nonnegative();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const integerQuantity = z.string().regex(/^-?(0|[1-9]\d*)$/);

const immutableReferencesSchema = z.object({
  demand_event_lines: nonnegativeCount,
  purchase_forecast_observations: nonnegativeCount,
  listing_publication_members: nonnegativeCount,
  listing_verification_members: nonnegativeCount,
  channel_exposure_policy_versions: nonnegativeCount,
  transformation_recipe_bindings: nonnegativeCount,
  transformation_recipe_component_snapshots: nonnegativeCount,
}).strict();

const variantEvidenceSchema = z.object({
  id: positiveId,
  productId: positiveId,
  sku: z.string().nullable(),
  name: z.string().min(1),
  uomType: z.string().min(1),
  unitsPerVariant: positiveId,
  hierarchyLevel: positiveId,
  parentVariantId: positiveId.nullable(),
  isBaseUnit: z.boolean(),
  requiresShipping: z.boolean(),
  trackInventory: z.boolean(),
  salesEligibility: z.string().min(1),
  isActive: z.boolean(),
  shopifyVariantId: z.string().nullable(),
  feedVariantIds: z.array(z.string()),
  listingVariantIds: z.array(z.string()),
  onHandQty: integerQuantity,
  reservedQty: integerQuantity,
  pickedQty: integerQuantity,
  packedQty: integerQuantity,
  backorderQty: integerQuantity,
  activeClaimCount: nonnegativeCount,
  openWorkReferenceCount: nonnegativeCount,
  activeChannelFeedCount: nonnegativeCount,
  buildRecipeReferenceCount: nonnegativeCount,
  nonDraftTransformationReferenceCount: nonnegativeCount,
  immutableProductReferences: immutableReferencesSchema,
}).strict();

const productEvidenceSchema = z.object({
  id: positiveId,
  sku: z.string().nullable(),
  name: z.string().min(1),
  status: z.string().nullable(),
  isActive: z.boolean(),
  shopifyProductId: z.string().nullable(),
  shippingGroupCode: z.string().nullable(),
  inventoryStrategy: z.string().min(1),
  baseUnit: z.string().min(1),
  inventoryType: z.string().min(1),
  activeTransformationModelId: positiveId.nullable(),
  draftTransformationModelId: positiveId.nullable(),
  activeReplenRuleCount: nonnegativeCount,
  activeReplenTaskCount: nonnegativeCount,
  legacyChannelConfigurationCount: nonnegativeCount,
  activeChannelExposurePolicyCount: nonnegativeCount,
  activeMarketplaceListingScopeCount: nonnegativeCount,
  variants: z.array(variantEvidenceSchema),
}).strict();

const blockerSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  productId: positiveId.nullable(),
  variantId: positiveId.nullable(),
  context: z.record(z.string(), z.unknown()),
}).strict();

const actionSchema = z.object({
  action: z.enum(["retain", "move", "retire_duplicate", "archive_inactive"]),
  sourceProductId: positiveId,
  sourceVariantId: positiveId,
  targetVariantId: positiveId,
  sku: z.string().nullable(),
  uomType: z.string().min(1),
  unitsPerVariant: positiveId,
  remoteVariantId: z.string().nullable(),
}).strict();

const evidenceSchema = z.object({
  channelId: positiveId,
  shopDomain: z.string().min(1).max(255),
  shopifyProductId: z.string().regex(/^\d+$/),
  remoteProductExists: z.boolean(),
  remoteProductTitle: z.string().nullable(),
  ownerProductIds: z.array(positiveId),
  canonicalProductId: positiveId,
  activeCutoverFreezeId: z.string().regex(/^[1-9]\d*$/).nullable(),
  products: z.array(productEvidenceSchema),
  remoteVariantProductIds: z.record(z.string(), z.string().nullable()),
}).strict();

const planSchema = z.object({
  contractVersion: z.literal(1),
  channelId: positiveId,
  shopDomain: z.string().min(1).max(255),
  shopifyProductId: z.string().regex(/^\d+$/),
  remoteProductTitle: z.string().nullable(),
  canonicalProductId: positiveId,
  sourceProductIds: z.array(positiveId),
  actions: z.array(actionSchema),
  blockers: z.array(blockerSchema),
  canApply: z.boolean(),
  previewHash: sha256,
}).strict();

const previewResponseSchema = z.object({
  contractVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  readOnly: z.literal(true),
  evidence: evidenceSchema,
  plan: planSchema,
}).strict();

const requestSchema = z.object({
  channelId: positiveId,
  shopifyProductId: z.string().regex(/^\d+$/),
  canonicalProductId: positiveId,
}).strict();

export type ShopifyProductConsolidationPreview = z.infer<
  typeof previewResponseSchema
>;

export async function fetchShopifyProductConsolidationPreview(input: {
  channelId: number;
  shopifyProductId: string;
  canonicalProductId: number;
}): Promise<ShopifyProductConsolidationPreview> {
  const request = requestSchema.parse(input);
  const response = await fetch(
    `/api/channels/${request.channelId}/shopify-mapping-reconciliation/ownership-review/consolidation/preview`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shopifyProductId: request.shopifyProductId,
        canonicalProductId: request.canonicalProductId,
      }),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      && typeof body.error === "string"
      ? body.error
      : `Product consolidation preview failed (${response.status})`;
    throw new Error(message);
  }
  const parsed = previewResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Product consolidation preview returned an invalid response");
  }
  return parsed.data;
}
