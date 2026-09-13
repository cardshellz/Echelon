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

const runtimeConfigurationReferencesSchema = z.object({
  channel_reservations: nonnegativeCount,
  channel_variant_overrides: nonnegativeCount,
  channel_allocation_rules: nonnegativeCount,
  channel_pricing: nonnegativeCount,
  channel_pricing_rules: nonnegativeCount,
  other_channel_feeds: nonnegativeCount,
  other_channel_listings: nonnegativeCount,
  channel_variant_availability_sync: nonnegativeCount,
  dropship_catalog_rules: nonnegativeCount,
  dropship_vendor_selection_rules: nonnegativeCount,
  dropship_vendor_variant_overrides: nonnegativeCount,
  dropship_pricing_policies: nonnegativeCount,
  dropship_ebay_store_category_assignments: nonnegativeCount,
  dropship_ebay_listing_policy_overrides: nonnegativeCount,
  dropship_listing_price_settings: nonnegativeCount,
  dropship_vendor_listings: nonnegativeCount,
  dropship_open_listing_job_items: nonnegativeCount,
  dropship_package_profiles: nonnegativeCount,
  shipping_variant_attrs: nonnegativeCount,
  shipping_product_set_members: nonnegativeCount,
  shipping_rate_rule_members: nonnegativeCount,
  shipping_channel_packing_preferences: nonnegativeCount,
  warehouse_product_locations: nonnegativeCount,
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
  inventoryPolicy: z.string().min(1),
  dropshipEligible: z.boolean(),
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
  runtimeConfigurationReferences: runtimeConfigurationReferencesSchema,
  procurementVendorProductCount: nonnegativeCount,
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
  openWmsWorkReferenceCount: nonnegativeCount,
  activeDropshipConfigurationCount: nonnegativeCount,
  channelPricingRuleCount: nonnegativeCount,
  ebayAspectOverrideCount: nonnegativeCount,
  productLevelProcurementMappingCount: nonnegativeCount,
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

const applyResponseSchema = z.object({
  contractVersion: z.literal(1),
  channelId: positiveId,
  shopDomain: z.string().min(1).max(255),
  shopifyProductId: z.string().regex(/^\d+$/),
  previewHash: sha256,
  canonicalProductId: positiveId,
  sourceProductIds: z.array(positiveId),
  movedVariantIds: z.array(positiveId),
  retiredVariantIds: z.array(positiveId),
  archivedVariantIds: z.array(positiveId),
  updatedParentVariantIds: z.array(positiveId),
  archivedProductIds: z.array(positiveId),
  invalidatedDraftModelIds: z.array(positiveId),
  replacementDraftModelIds: z.array(positiveId),
  reparentedLocationCount: nonnegativeCount,
  reparentedAssetCount: nonnegativeCount,
  detachedFeedCount: nonnegativeCount,
  resetListingCount: nonnegativeCount,
  completedAt: z.string().datetime(),
  commandId: positiveId,
  idempotentReplay: z.boolean(),
}).strict();

const requestSchema = z.object({
  channelId: positiveId,
  shopifyProductId: z.string().regex(/^\d+$/),
  canonicalProductId: positiveId,
}).strict();

const applyRequestSchema = requestSchema.extend({
  expectedShopDomain: z.string().trim().min(1).max(255),
  expectedPreviewHash: sha256,
  idempotencyKey: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
}).strict();

export type ShopifyProductConsolidationPreview = z.infer<
  typeof previewResponseSchema
>;
export type ShopifyProductConsolidationApplyResponse = z.infer<
  typeof applyResponseSchema
>;
export type ShopifyProductConsolidationApplyRequest = Omit<
  z.infer<typeof applyRequestSchema>,
  "channelId"
>;

export class ShopifyProductConsolidationApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super(message);
    this.name = "ShopifyProductConsolidationApiError";
  }
}

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

export async function applyShopifyProductConsolidation(input: {
  channelId: number;
  request: ShopifyProductConsolidationApplyRequest;
}): Promise<ShopifyProductConsolidationApplyResponse> {
  const parsed = applyRequestSchema.parse({
    channelId: input.channelId,
    ...input.request,
  });
  const { channelId, ...request } = parsed;
  const response = await fetch(
    `/api/channels/${channelId}/shopify-mapping-reconciliation/ownership-review/consolidation/apply`,
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
      : `Product consolidation failed (${response.status})`;
    const code = body && typeof body === "object" && "code" in body
      && typeof body.code === "string"
      ? body.code
      : null;
    throw new ShopifyProductConsolidationApiError(
      message,
      response.status,
      code,
    );
  }
  const result = applyResponseSchema.safeParse(body);
  if (!result.success) {
    throw new Error("Product consolidation returned an invalid response");
  }
  return result.data;
}
