import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJson } from "@shared/utils/canonical-json";
import { normalizeShopifyId } from "./shopify-product-mapping.domain";

const positiveId = z.number().int().positive().max(2_147_483_647);
const nonnegativeCount = z.number().int().nonnegative().max(2_147_483_647);
const integerQuantity = z.string().regex(/^-?(0|[1-9]\d*)$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const safeReason = z.string().trim().min(1).max(500)
  .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/);

export const shopifyProductConsolidationPreviewRequestSchema = z.object({
  shopifyProductId: z.string().regex(/^\d+$/),
  canonicalProductId: positiveId,
}).strict();

export const shopifyProductConsolidationApplyRequestSchema =
  shopifyProductConsolidationPreviewRequestSchema.extend({
    expectedShopDomain: z.string().trim().min(1).max(255),
    expectedPreviewHash: sha256,
    idempotencyKey: z.string().uuid(),
    reason: safeReason,
  }).strict();

export type ShopifyProductConsolidationPreviewRequest = z.infer<
  typeof shopifyProductConsolidationPreviewRequestSchema
>;
export type ShopifyProductConsolidationApplyRequest = z.infer<
  typeof shopifyProductConsolidationApplyRequestSchema
>;

export const SHOPIFY_PRODUCT_CONSOLIDATION_BLOCKER_CODES = [
  "remote_product_missing",
  "duplicate_ownership_not_present",
  "canonical_product_not_an_owner",
  "canonical_product_inactive",
  "canonical_product_mapping_mismatch",
  "product_shipping_group_mismatch",
  "product_inventory_strategy_mismatch",
  "product_base_unit_mismatch",
  "product_inventory_type_mismatch",
  "active_transformation_model",
  "active_cutover_freeze",
  "source_runtime_configuration",
  "ambiguous_package_variant",
  "survivor_remote_mapping_missing",
  "survivor_remote_mapping_conflict",
  "variant_remote_mapping_outside_consolidation",
  "variant_definition_mismatch",
  "duplicate_variant_has_inventory",
  "duplicate_variant_has_encumbrance",
  "duplicate_variant_has_active_claim",
  "duplicate_variant_has_open_work",
  "duplicate_variant_has_active_channel_feed",
  "duplicate_variant_has_runtime_configuration",
  "variant_quantity_invalid",
  "variant_has_immutable_product_history",
  "variant_has_immutable_transformation_history",
  "variant_has_build_recipe_reference",
  "variant_has_procurement_mapping",
  "variant_parent_outside_consolidation",
] as const;

export type ShopifyProductConsolidationBlockerCode =
  (typeof SHOPIFY_PRODUCT_CONSOLIDATION_BLOCKER_CODES)[number];

export const PRODUCT_VARIANT_IMMUTABLE_REFERENCE_KINDS = [
  "demand_event_lines",
  "purchase_forecast_observations",
  "listing_publication_members",
  "listing_verification_members",
  "channel_exposure_policy_versions",
  "transformation_recipe_bindings",
  "transformation_recipe_component_snapshots",
] as const;

export type ProductVariantImmutableReferenceKind =
  (typeof PRODUCT_VARIANT_IMMUTABLE_REFERENCE_KINDS)[number];

export const PRODUCT_VARIANT_RUNTIME_REFERENCE_KINDS = [
  "channel_reservations",
  "channel_variant_overrides",
  "channel_allocation_rules",
  "channel_pricing",
  "channel_pricing_rules",
  "other_channel_feeds",
  "other_channel_listings",
  "channel_variant_availability_sync",
  "dropship_catalog_rules",
  "dropship_vendor_selection_rules",
  "dropship_vendor_variant_overrides",
  "dropship_pricing_policies",
  "dropship_ebay_store_category_assignments",
  "dropship_ebay_listing_policy_overrides",
  "dropship_listing_price_settings",
  "dropship_vendor_listings",
  "dropship_open_listing_job_items",
  "dropship_package_profiles",
  "shipping_variant_attrs",
  "shipping_product_set_members",
  "shipping_rate_rule_members",
  "shipping_channel_packing_preferences",
  "warehouse_product_locations",
] as const;

export type ProductVariantRuntimeReferenceKind =
  (typeof PRODUCT_VARIANT_RUNTIME_REFERENCE_KINDS)[number];

export interface ShopifyProductConsolidationVariantEvidence {
  readonly id: number;
  readonly productId: number;
  readonly sku: string | null;
  readonly name: string;
  readonly uomType: string;
  readonly unitsPerVariant: number;
  readonly hierarchyLevel: number;
  readonly parentVariantId: number | null;
  readonly isBaseUnit: boolean;
  readonly requiresShipping: boolean;
  readonly trackInventory: boolean;
  readonly salesEligibility: string;
  readonly inventoryPolicy: string;
  readonly dropshipEligible: boolean;
  readonly isActive: boolean;
  readonly shopifyVariantId: string | null;
  readonly feedVariantIds: readonly string[];
  readonly listingVariantIds: readonly string[];
  readonly onHandQty: string;
  readonly reservedQty: string;
  readonly pickedQty: string;
  readonly packedQty: string;
  readonly backorderQty: string;
  readonly activeClaimCount: number;
  readonly openWorkReferenceCount: number;
  readonly activeChannelFeedCount: number;
  readonly runtimeConfigurationReferences: Readonly<Record<
    ProductVariantRuntimeReferenceKind,
    number
  >>;
  readonly procurementVendorProductCount: number;
  readonly buildRecipeReferenceCount: number;
  readonly nonDraftTransformationReferenceCount: number;
  readonly immutableProductReferences: Readonly<Record<
    ProductVariantImmutableReferenceKind,
    number
  >>;
}

export interface ShopifyProductConsolidationProductEvidence {
  readonly id: number;
  readonly sku: string | null;
  readonly name: string;
  readonly status: string | null;
  readonly isActive: boolean;
  readonly shopifyProductId: string | null;
  readonly shippingGroupCode: string | null;
  readonly inventoryStrategy: string;
  readonly baseUnit: string;
  readonly inventoryType: string;
  readonly activeTransformationModelId: number | null;
  readonly draftTransformationModelId: number | null;
  readonly activeReplenRuleCount: number;
  readonly activeReplenTaskCount: number;
  readonly legacyChannelConfigurationCount: number;
  readonly activeChannelExposurePolicyCount: number;
  readonly activeMarketplaceListingScopeCount: number;
  readonly openWmsWorkReferenceCount: number;
  readonly activeDropshipConfigurationCount: number;
  readonly channelPricingRuleCount: number;
  readonly ebayAspectOverrideCount: number;
  readonly productLevelProcurementMappingCount: number;
  readonly variants: readonly ShopifyProductConsolidationVariantEvidence[];
}

export interface ShopifyProductConsolidationEvidence {
  readonly channelId: number;
  readonly shopDomain: string;
  readonly shopifyProductId: string;
  readonly remoteProductExists: boolean;
  readonly remoteProductTitle: string | null;
  readonly ownerProductIds: readonly number[];
  readonly canonicalProductId: number;
  readonly activeCutoverFreezeId: string | null;
  readonly products: readonly ShopifyProductConsolidationProductEvidence[];
  readonly remoteVariantProductIds: Readonly<Record<string, string | null>>;
}

const immutableProductReferencesSchema = z.object({
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

export const shopifyProductConsolidationVariantEvidenceSchema = z.object({
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
  immutableProductReferences: immutableProductReferencesSchema,
}).strict();

export const shopifyProductConsolidationProductEvidenceSchema = z.object({
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
  variants: z.array(shopifyProductConsolidationVariantEvidenceSchema),
}).strict();

export const shopifyProductConsolidationEvidenceSchema = z.object({
  channelId: positiveId,
  shopDomain: z.string().trim().min(1).max(255),
  shopifyProductId: z.string().regex(/^\d+$/),
  remoteProductExists: z.boolean(),
  remoteProductTitle: z.string().nullable(),
  ownerProductIds: z.array(positiveId),
  canonicalProductId: positiveId,
  activeCutoverFreezeId: z.string().regex(/^[1-9]\d*$/).nullable(),
  products: z.array(shopifyProductConsolidationProductEvidenceSchema),
  remoteVariantProductIds: z.record(z.string(), z.string().nullable()),
}).strict();

export type ShopifyProductConsolidationVariantActionType =
  | "retain"
  | "move"
  | "retire_duplicate"
  | "archive_inactive";

export interface ShopifyProductConsolidationVariantAction {
  readonly action: ShopifyProductConsolidationVariantActionType;
  readonly sourceProductId: number;
  readonly sourceVariantId: number;
  readonly targetVariantId: number;
  readonly sku: string | null;
  readonly uomType: string;
  readonly unitsPerVariant: number;
  readonly remoteVariantId: string | null;
}

export interface ShopifyProductConsolidationBlocker {
  readonly code: ShopifyProductConsolidationBlockerCode;
  readonly message: string;
  readonly productId: number | null;
  readonly variantId: number | null;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface ShopifyProductConsolidationPlan {
  readonly contractVersion: 1;
  readonly channelId: number;
  readonly shopDomain: string;
  readonly shopifyProductId: string;
  readonly remoteProductTitle: string | null;
  readonly canonicalProductId: number;
  readonly sourceProductIds: readonly number[];
  readonly actions: readonly ShopifyProductConsolidationVariantAction[];
  readonly blockers: readonly ShopifyProductConsolidationBlocker[];
  readonly canApply: boolean;
  readonly previewHash: string;
}

const shopifyProductConsolidationActionSchema = z.object({
  action: z.enum(["retain", "move", "retire_duplicate", "archive_inactive"]),
  sourceProductId: positiveId,
  sourceVariantId: positiveId,
  targetVariantId: positiveId,
  sku: z.string().nullable(),
  uomType: z.string().min(1),
  unitsPerVariant: positiveId,
  remoteVariantId: z.string().nullable(),
}).strict();

const shopifyProductConsolidationBlockerSchema = z.object({
  code: z.enum(SHOPIFY_PRODUCT_CONSOLIDATION_BLOCKER_CODES),
  message: z.string().min(1),
  productId: positiveId.nullable(),
  variantId: positiveId.nullable(),
  context: z.record(z.string(), z.unknown()),
}).strict();

export const shopifyProductConsolidationPlanSchema = z.object({
  contractVersion: z.literal(1),
  channelId: positiveId,
  shopDomain: z.string().trim().min(1).max(255),
  shopifyProductId: z.string().regex(/^\d+$/),
  remoteProductTitle: z.string().nullable(),
  canonicalProductId: positiveId,
  sourceProductIds: z.array(positiveId),
  actions: z.array(shopifyProductConsolidationActionSchema),
  blockers: z.array(shopifyProductConsolidationBlockerSchema),
  canApply: z.boolean(),
  previewHash: sha256,
}).strict();

export const shopifyProductConsolidationResultSchema = z.object({
  contractVersion: z.literal(1),
  channelId: positiveId,
  shopDomain: z.string().trim().min(1).max(255),
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
}).strict();

export type ShopifyProductConsolidationResult = z.infer<
  typeof shopifyProductConsolidationResultSchema
>;

export interface ShopifyProductConsolidationCommandRecord {
  readonly id: number;
  readonly channelId: number;
  readonly shopifyProductId: string;
  readonly canonicalProductId: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly previewHash: string;
  readonly operator: string;
  readonly reason: string;
  readonly result: ShopifyProductConsolidationResult;
}

function quantity(value: string): bigint {
  return BigInt(value);
}

const QUANTITY_FIELDS = [
  "onHandQty",
  "reservedQty",
  "pickedQty",
  "packedQty",
  "backorderQty",
] as const;

function addQuantityBlockers(
  variant: ShopifyProductConsolidationVariantEvidence,
  blockers: ShopifyProductConsolidationBlocker[],
): void {
  for (const field of QUANTITY_FIELDS) {
    if (quantity(variant[field]) >= BigInt(0)) continue;
    blockers.push(blocker(
      "variant_quantity_invalid",
      "A variant has a negative inventory quantity and must be reconciled before catalog consolidation.",
      {
        productId: variant.productId,
        variantId: variant.id,
        context: { field, value: variant[field] },
      },
    ));
  }
}

function packageKey(variant: ShopifyProductConsolidationVariantEvidence): string {
  return canonicalJson({
    uomType: variant.uomType,
    unitsPerVariant: variant.unitsPerVariant,
  });
}

function externalVariantIds(
  variant: ShopifyProductConsolidationVariantEvidence,
): string[] {
  return [...new Set([
    variant.shopifyVariantId,
    ...variant.feedVariantIds,
    ...variant.listingVariantIds,
  ].map(normalizeShopifyId).filter((id): id is string => id !== null))]
    .sort((left, right) => left.localeCompare(
      right,
      "en",
      { numeric: true },
    ));
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(
    right,
    "en",
    { numeric: true },
  ));
}

function canonicalEvidenceForHash(
  evidence: ShopifyProductConsolidationEvidence,
): ShopifyProductConsolidationEvidence {
  return {
    ...evidence,
    ownerProductIds: [...evidence.ownerProductIds].sort((left, right) => left - right),
    products: [...evidence.products]
      .sort((left, right) => left.id - right.id)
      .map((product) => ({
        ...product,
        variants: [...product.variants]
          .sort((left, right) => left.id - right.id)
          .map((variant) => ({
            ...variant,
            feedVariantIds: sortedStrings(variant.feedVariantIds),
            listingVariantIds: sortedStrings(variant.listingVariantIds),
          })),
      })),
  };
}

function remoteVariantIdsForProduct(
  variant: ShopifyProductConsolidationVariantEvidence,
  evidence: ShopifyProductConsolidationEvidence,
): string[] {
  return externalVariantIds(variant).filter(
    (id) => evidence.remoteVariantProductIds[id] === evidence.shopifyProductId,
  );
}

function remoteMappingsOutsideProduct(
  variant: ShopifyProductConsolidationVariantEvidence,
  evidence: ShopifyProductConsolidationEvidence,
): Readonly<Record<string, string>> {
  return Object.fromEntries(externalVariantIds(variant)
    .map((id) => [id, evidence.remoteVariantProductIds[id]] as const)
    .filter((entry): entry is readonly [string, string] =>
      entry[1] !== null
      && entry[1] !== undefined
      && entry[1] !== evidence.shopifyProductId));
}

function runtimeConfigurationReferences(
  variant: ShopifyProductConsolidationVariantEvidence,
): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(variant.runtimeConfigurationReferences)
    .filter(([, count]) => count > 0));
}

function addRemoteMappingBlocker(
  variant: ShopifyProductConsolidationVariantEvidence,
  evidence: ShopifyProductConsolidationEvidence,
  blockers: ShopifyProductConsolidationBlocker[],
): void {
  const outsideMappings = remoteMappingsOutsideProduct(variant, evidence);
  if (Object.keys(outsideMappings).length === 0) return;
  blockers.push(blocker(
    "variant_remote_mapping_outside_consolidation",
    "A local variant identity belongs to a different live Shopify product and cannot be detached by this command.",
    {
      productId: variant.productId,
      variantId: variant.id,
      context: {
        reviewedShopifyProductId: evidence.shopifyProductId,
        remoteMappings: outsideMappings,
      },
    },
  ));
}

function addRetirementDependencyBlockers(
  variant: ShopifyProductConsolidationVariantEvidence,
  blockers: ShopifyProductConsolidationBlocker[],
  messagePrefix: string,
): void {
  const runtimeReferences = runtimeConfigurationReferences(variant);
  if (Object.keys(runtimeReferences).length > 0) {
    blockers.push(blocker(
      "duplicate_variant_has_runtime_configuration",
      `${messagePrefix} still owns active channel, dropship, or shipping configuration.`,
      {
        productId: variant.productId,
        variantId: variant.id,
        context: { references: runtimeReferences },
      },
    ));
  }
  if (variant.procurementVendorProductCount > 0) {
    blockers.push(blocker(
      "variant_has_procurement_mapping",
      `${messagePrefix} is referenced by procurement vendor-product configuration.`,
      {
        productId: variant.productId,
        variantId: variant.id,
        context: {
          procurementVendorProductCount:
            variant.procurementVendorProductCount,
        },
      },
    ));
  }
}

function blocker(
  code: ShopifyProductConsolidationBlockerCode,
  message: string,
  input: {
    productId?: number | null;
    variantId?: number | null;
    context?: Readonly<Record<string, unknown>>;
  } = {},
): ShopifyProductConsolidationBlocker {
  return Object.freeze({
    code,
    message,
    productId: input.productId ?? null,
    variantId: input.variantId ?? null,
    context: Object.freeze({ ...(input.context ?? {}) }),
  });
}

function variantsCompatible(
  source: ShopifyProductConsolidationVariantEvidence,
  target: ShopifyProductConsolidationVariantEvidence,
): boolean {
  return source.uomType === target.uomType
    && source.unitsPerVariant === target.unitsPerVariant
    && source.requiresShipping === target.requiresShipping
    && source.trackInventory === target.trackInventory
    && source.salesEligibility === target.salesEligibility
    && source.inventoryPolicy === target.inventoryPolicy
    && source.dropshipEligible === target.dropshipEligible
    && source.hierarchyLevel === target.hierarchyLevel
    && source.isBaseUnit === target.isBaseUnit;
}

function addProductBlockers(
  evidence: ShopifyProductConsolidationEvidence,
  canonical: ShopifyProductConsolidationProductEvidence | undefined,
  blockers: ShopifyProductConsolidationBlocker[],
): void {
  if (!evidence.remoteProductExists) {
    blockers.push(blocker(
      "remote_product_missing",
      "The Shopify product no longer exists.",
    ));
  }
  if (new Set(evidence.ownerProductIds).size < 2) {
    blockers.push(blocker(
      "duplicate_ownership_not_present",
      "The reviewed Shopify product no longer has multiple local owners.",
      { context: { ownerProductIds: evidence.ownerProductIds } },
    ));
  }
  if (!canonical || !evidence.ownerProductIds.includes(evidence.canonicalProductId)) {
    blockers.push(blocker(
      "canonical_product_not_an_owner",
      "The selected canonical product is not a current local owner.",
      { productId: evidence.canonicalProductId },
    ));
    return;
  }
  if (!canonical.isActive || canonical.status === "archived") {
    blockers.push(blocker(
      "canonical_product_inactive",
      "The selected canonical product is not active.",
      { productId: canonical.id },
    ));
  }
  if (normalizeShopifyId(canonical.shopifyProductId) !== evidence.shopifyProductId) {
    blockers.push(blocker(
      "canonical_product_mapping_mismatch",
      "The selected canonical product does not own the reviewed Shopify product in the catalog.",
      { productId: canonical.id },
    ));
  }
  if (evidence.activeCutoverFreezeId !== null) {
    blockers.push(blocker(
      "active_cutover_freeze",
      "Inventory availability configuration is frozen by an active cutover run.",
      { context: { activationRunId: evidence.activeCutoverFreezeId } },
    ));
  }

  for (const product of evidence.products) {
    if (product.activeTransformationModelId !== null) {
      blockers.push(blocker(
        "active_transformation_model",
        "An active transformation model must be replaced through the inventory activation workflow before catalog consolidation.",
        {
          productId: product.id,
          context: { activeModelId: product.activeTransformationModelId },
        },
      ));
    }
    if (product.id === canonical.id) continue;
    const comparisons: Array<[
      ShopifyProductConsolidationBlockerCode,
      string,
      unknown,
      unknown,
    ]> = [
      ["product_shipping_group_mismatch", "shipping group", product.shippingGroupCode, canonical.shippingGroupCode],
      ["product_inventory_strategy_mismatch", "inventory strategy", product.inventoryStrategy, canonical.inventoryStrategy],
      ["product_base_unit_mismatch", "base unit", product.baseUnit, canonical.baseUnit],
      ["product_inventory_type_mismatch", "inventory type", product.inventoryType, canonical.inventoryType],
    ];
    for (const [code, label, sourceValue, canonicalValue] of comparisons) {
      if (sourceValue === canonicalValue) continue;
      blockers.push(blocker(
        code,
        `The source and canonical products use different ${label} values.`,
        {
          productId: product.id,
          context: { sourceValue, canonicalValue },
        },
      ));
    }
    const runtimeConfiguration = {
      active_replen_rules: product.activeReplenRuleCount,
      active_replen_tasks: product.activeReplenTaskCount,
      legacy_channel_configuration: product.legacyChannelConfigurationCount,
      active_channel_exposure_policies:
        product.activeChannelExposurePolicyCount,
      active_marketplace_listing_scopes:
        product.activeMarketplaceListingScopeCount,
      open_wms_work: product.openWmsWorkReferenceCount,
      active_dropship_configuration:
        product.activeDropshipConfigurationCount,
      channel_pricing_rules: product.channelPricingRuleCount,
      ebay_aspect_overrides: product.ebayAspectOverrideCount,
      product_level_procurement_mappings:
        product.productLevelProcurementMappingCount,
    };
    const activeRuntimeConfiguration = Object.fromEntries(
      Object.entries(runtimeConfiguration).filter(([, count]) => count > 0),
    );
    const runtimeConfigurationCount = Object.values(runtimeConfiguration)
      .reduce((total, count) => total + count, 0);
    if (runtimeConfigurationCount > 0) {
      blockers.push(blocker(
        "source_runtime_configuration",
        "The source product still owns open work or product-level runtime configuration.",
        {
          productId: product.id,
          context: { references: activeRuntimeConfiguration },
        },
      ));
    }
  }
}

function addSurvivorBlockers(
  variant: ShopifyProductConsolidationVariantEvidence,
  evidence: ShopifyProductConsolidationEvidence,
  blockers: ShopifyProductConsolidationBlocker[],
): string | null {
  const remoteIds = remoteVariantIdsForProduct(variant, evidence);
  const allRemoteParents = [...new Set(externalVariantIds(variant).map(
    (id) => evidence.remoteVariantProductIds[id] ?? null,
  ))];
  if (variant.salesEligibility === "sellable" && remoteIds.length === 0) {
    blockers.push(blocker(
      "survivor_remote_mapping_missing",
      "The retained variant has no verified mapping to the reviewed Shopify product.",
      { productId: variant.productId, variantId: variant.id },
    ));
  } else if (variant.salesEligibility === "sellable" && (
    remoteIds.length > 1 || allRemoteParents.some(
    (parentId) => parentId !== evidence.shopifyProductId,
    )
  )) {
    blockers.push(blocker(
      "survivor_remote_mapping_conflict",
      "The retained variant has conflicting live Shopify variant ownership.",
      {
        productId: variant.productId,
        variantId: variant.id,
        context: { remoteVariantIds: remoteIds, remoteProductIds: allRemoteParents },
      },
    ));
  }

  if (variant.productId !== evidence.canonicalProductId) {
    const immutableReferences = Object.entries(
      variant.immutableProductReferences,
    ).filter(([, count]) => count > 0);
    if (immutableReferences.length > 0) {
      blockers.push(blocker(
        "variant_has_immutable_product_history",
        "The retained variant has immutable evidence tied to its current product identity.",
        {
          productId: variant.productId,
          variantId: variant.id,
          context: { references: Object.fromEntries(immutableReferences) },
        },
      ));
    }
    if (variant.nonDraftTransformationReferenceCount > 0) {
      blockers.push(blocker(
        "variant_has_immutable_transformation_history",
        "The retained variant belongs to a sealed, retired, or superseded transformation model.",
        {
          productId: variant.productId,
          variantId: variant.id,
          context: {
            referenceCount: variant.nonDraftTransformationReferenceCount,
          },
        },
      ));
    }
    if (variant.buildRecipeReferenceCount > 0) {
      blockers.push(blocker(
        "variant_has_build_recipe_reference",
        "The retained variant is referenced by a build recipe whose product identity would become inconsistent.",
        {
          productId: variant.productId,
          variantId: variant.id,
          context: { referenceCount: variant.buildRecipeReferenceCount },
        },
      ));
    }
    if (variant.procurementVendorProductCount > 0) {
      blockers.push(blocker(
        "variant_has_procurement_mapping",
        "The retained variant is referenced by procurement vendor-product configuration tied to its current product.",
        {
          productId: variant.productId,
          variantId: variant.id,
          context: {
            procurementVendorProductCount:
              variant.procurementVendorProductCount,
          },
        },
      ));
    }
  }
  return remoteIds.length === 1 ? remoteIds[0] : null;
}

function addDuplicateBlockers(
  source: ShopifyProductConsolidationVariantEvidence,
  target: ShopifyProductConsolidationVariantEvidence,
  blockers: ShopifyProductConsolidationBlocker[],
): void {
  if (!variantsCompatible(source, target)) {
    blockers.push(blocker(
      "variant_definition_mismatch",
      "Two variants share a package quantity but disagree on fulfillment or inventory semantics.",
      {
        productId: source.productId,
        variantId: source.id,
        context: { targetVariantId: target.id },
      },
    ));
  }
  if (quantity(source.onHandQty) > BigInt(0)) {
    blockers.push(blocker(
      "duplicate_variant_has_inventory",
      "A duplicate variant still has physical inventory and cannot be retired by a metadata-only consolidation.",
      {
        productId: source.productId,
        variantId: source.id,
        context: { onHandQty: source.onHandQty, targetVariantId: target.id },
      },
    ));
  }
  const encumbrance = quantity(source.reservedQty)
    + quantity(source.pickedQty)
    + quantity(source.packedQty)
    + quantity(source.backorderQty);
  if (encumbrance > BigInt(0)) {
    blockers.push(blocker(
      "duplicate_variant_has_encumbrance",
      "A duplicate variant still has reserved, picked, packed, or backordered quantity.",
      {
        productId: source.productId,
        variantId: source.id,
        context: {
          reservedQty: source.reservedQty,
          pickedQty: source.pickedQty,
          packedQty: source.packedQty,
          backorderQty: source.backorderQty,
          targetVariantId: target.id,
        },
      },
    ));
  }
  if (source.activeClaimCount > 0) {
    blockers.push(blocker(
      "duplicate_variant_has_active_claim",
      "A duplicate variant is still owned by an active canonical availability claim.",
      {
        productId: source.productId,
        variantId: source.id,
        context: { activeClaimCount: source.activeClaimCount },
      },
    ));
  }
  if (source.openWorkReferenceCount > 0) {
    blockers.push(blocker(
      "duplicate_variant_has_open_work",
      "A duplicate variant still has open order, shipment, or build work.",
      {
        productId: source.productId,
        variantId: source.id,
        context: { openWorkReferenceCount: source.openWorkReferenceCount },
      },
    ));
  }
  if (source.activeChannelFeedCount > 0) {
    blockers.push(blocker(
      "duplicate_variant_has_active_channel_feed",
      "A duplicate variant still has an active channel feed.",
      {
        productId: source.productId,
        variantId: source.id,
        context: { activeChannelFeedCount: source.activeChannelFeedCount },
      },
    ));
  }
  addRetirementDependencyBlockers(source, blockers, "A duplicate variant");
}

function addInactiveRetirementBlockers(
  source: ShopifyProductConsolidationVariantEvidence,
  blockers: ShopifyProductConsolidationBlocker[],
): void {
  if (quantity(source.onHandQty) > BigInt(0)) {
    blockers.push(blocker(
      "duplicate_variant_has_inventory",
      "An inactive source variant still has physical inventory and cannot be archived.",
      {
        productId: source.productId,
        variantId: source.id,
        context: { onHandQty: source.onHandQty },
      },
    ));
  }
  if (
    quantity(source.reservedQty)
      + quantity(source.pickedQty)
      + quantity(source.packedQty)
      + quantity(source.backorderQty) > BigInt(0)
  ) {
    blockers.push(blocker(
      "duplicate_variant_has_encumbrance",
      "An inactive source variant still has operational inventory commitments.",
      { productId: source.productId, variantId: source.id },
    ));
  }
  if (source.activeClaimCount > 0) {
    blockers.push(blocker(
      "duplicate_variant_has_active_claim",
      "An inactive source variant is still owned by an active canonical availability claim.",
      { productId: source.productId, variantId: source.id },
    ));
  }
  if (source.openWorkReferenceCount > 0) {
    blockers.push(blocker(
      "duplicate_variant_has_open_work",
      "An inactive source variant still has open warehouse work.",
      { productId: source.productId, variantId: source.id },
    ));
  }
  if (source.activeChannelFeedCount > 0) {
    blockers.push(blocker(
      "duplicate_variant_has_active_channel_feed",
      "An inactive source variant still has an active channel feed.",
      { productId: source.productId, variantId: source.id },
    ));
  }
  addRetirementDependencyBlockers(source, blockers, "An inactive source variant");
}

export function buildShopifyProductConsolidationPlan(
  rawEvidence: ShopifyProductConsolidationEvidence,
): ShopifyProductConsolidationPlan {
  const evidence = shopifyProductConsolidationEvidenceSchema.parse(rawEvidence);
  const products = [...evidence.products].sort((left, right) => left.id - right.id);
  const canonical = products.find(
    (product) => product.id === evidence.canonicalProductId,
  );
  const sourceProductIds = products
    .map((product) => product.id)
    .filter((productId) => productId !== evidence.canonicalProductId);
  const blockers: ShopifyProductConsolidationBlocker[] = [];
  addProductBlockers(evidence, canonical, blockers);
  for (const variant of products.flatMap((product) => product.variants)) {
    addQuantityBlockers(variant, blockers);
    addRemoteMappingBlocker(variant, evidence, blockers);
  }

  const activeVariants = products.flatMap((product) => product.variants)
    .filter((variant) => variant.isActive);
  const variantsByPackage = new Map<
    string,
    ShopifyProductConsolidationVariantEvidence[]
  >();
  for (const variant of activeVariants) {
    const key = packageKey(variant);
    const variants = variantsByPackage.get(key) ?? [];
    variants.push(variant);
    variantsByPackage.set(key, variants);
  }

  const actions: ShopifyProductConsolidationVariantAction[] = [];
  const finalVariantIds = new Set<number>();
  const replacementByVariantId = new Map<number, number>();
  for (const variants of [...variantsByPackage.values()].sort(
    (left, right) => packageKey(left[0]).localeCompare(packageKey(right[0])),
  )) {
    const ordered = [...variants].sort((left, right) => left.id - right.id);
    const canonicalCandidates = ordered.filter(
      (variant) => variant.productId === evidence.canonicalProductId,
    );
    const remoteCandidates = ordered.filter((variant) =>
      variant.salesEligibility === "sellable"
      && remoteVariantIdsForProduct(variant, evidence).length === 1);
    let survivor: ShopifyProductConsolidationVariantEvidence | undefined;
    if (canonicalCandidates.length === 1) {
      survivor = canonicalCandidates[0];
    } else if (canonicalCandidates.length === 0 && remoteCandidates.length === 1) {
      survivor = remoteCandidates[0];
    } else if (
      canonicalCandidates.length === 0
      && remoteCandidates.length === 0
      && ordered.length === 1
      && ordered[0].salesEligibility !== "sellable"
    ) {
      survivor = ordered[0];
    } else {
      blockers.push(blocker(
        "ambiguous_package_variant",
        "The package has no unique survivor under the selected canonical product.",
        {
          productId: evidence.canonicalProductId,
          context: {
            uomType: ordered[0].uomType,
            unitsPerVariant: ordered[0].unitsPerVariant,
            variantIds: ordered.map((variant) => variant.id),
            canonicalCandidateIds: canonicalCandidates.map((variant) => variant.id),
            remoteCandidateIds: remoteCandidates.map((variant) => variant.id),
          },
        },
      ));
      continue;
    }

    finalVariantIds.add(survivor.id);
    const survivorRemoteId = addSurvivorBlockers(survivor, evidence, blockers);
    actions.push(Object.freeze({
      action: survivor.productId === evidence.canonicalProductId
        ? "retain"
        : "move",
      sourceProductId: survivor.productId,
      sourceVariantId: survivor.id,
      targetVariantId: survivor.id,
      sku: survivor.sku,
      uomType: survivor.uomType,
      unitsPerVariant: survivor.unitsPerVariant,
      remoteVariantId: survivorRemoteId,
    }));

    for (const duplicate of ordered) {
      if (duplicate.id === survivor.id) continue;
      const survivorRemoteIds = remoteVariantIdsForProduct(survivor, evidence);
      const duplicateRemoteIds = remoteVariantIdsForProduct(duplicate, evidence);
      if (
        duplicateRemoteIds.length > 0
        && canonicalJson(duplicateRemoteIds) !== canonicalJson(survivorRemoteIds)
      ) {
        blockers.push(blocker(
          "ambiguous_package_variant",
          "Two variants with the same package definition map to different live Shopify variants.",
          {
            productId: duplicate.productId,
            variantId: duplicate.id,
            context: {
              survivorVariantId: survivor.id,
              survivorRemoteVariantIds: survivorRemoteIds,
              duplicateRemoteVariantIds: duplicateRemoteIds,
            },
          },
        ));
      }
      replacementByVariantId.set(duplicate.id, survivor.id);
      addDuplicateBlockers(duplicate, survivor, blockers);
      actions.push(Object.freeze({
        action: "retire_duplicate",
        sourceProductId: duplicate.productId,
        sourceVariantId: duplicate.id,
        targetVariantId: survivor.id,
        sku: duplicate.sku,
        uomType: duplicate.uomType,
        unitsPerVariant: duplicate.unitsPerVariant,
        remoteVariantId: remoteVariantIdsForProduct(duplicate, evidence)[0] ?? null,
      }));
    }
  }

  for (const product of products) {
    if (product.id === evidence.canonicalProductId) continue;
    for (const variant of product.variants.filter((candidate) => !candidate.isActive)) {
      addInactiveRetirementBlockers(variant, blockers);
      actions.push(Object.freeze({
        action: "archive_inactive",
        sourceProductId: product.id,
        sourceVariantId: variant.id,
        targetVariantId: variant.id,
        sku: variant.sku,
        uomType: variant.uomType,
        unitsPerVariant: variant.unitsPerVariant,
        remoteVariantId: null,
      }));
    }
  }

  const allVariants = new Map(products.flatMap((product) => product.variants)
    .map((variant) => [variant.id, variant] as const));
  for (const variantId of finalVariantIds) {
    const variant = allVariants.get(variantId)!;
    if (variant.parentVariantId === null) continue;
    const resolvedParentId = replacementByVariantId.get(variant.parentVariantId)
      ?? variant.parentVariantId;
    if (!finalVariantIds.has(resolvedParentId)) {
      blockers.push(blocker(
        "variant_parent_outside_consolidation",
        "A retained variant points to a parent that will not belong to the canonical product.",
        {
          productId: variant.productId,
          variantId: variant.id,
          context: {
            parentVariantId: variant.parentVariantId,
            resolvedParentVariantId: resolvedParentId,
          },
        },
      ));
    }
  }

  const sortedActions = actions.sort((left, right) =>
    left.sourceVariantId - right.sourceVariantId);
  const sortedBlockers = blockers.sort((left, right) =>
    left.code.localeCompare(right.code)
      || (left.productId ?? 0) - (right.productId ?? 0)
      || (left.variantId ?? 0) - (right.variantId ?? 0));
  const planWithoutHash = {
    contractVersion: 1 as const,
    channelId: evidence.channelId,
    shopDomain: evidence.shopDomain,
    shopifyProductId: evidence.shopifyProductId,
    remoteProductTitle: evidence.remoteProductTitle,
    canonicalProductId: evidence.canonicalProductId,
    sourceProductIds,
    actions: sortedActions,
    blockers: sortedBlockers,
    canApply: sortedBlockers.length === 0,
  };
  const previewHash = createHash("sha256")
    .update(canonicalJson({
      evidence: canonicalEvidenceForHash(evidence),
      plan: planWithoutHash,
    }))
    .digest("hex");
  return Object.freeze({ ...planWithoutHash, previewHash });
}

export function shopifyProductConsolidationRequestHash(input: {
  readonly actor: string;
  readonly request: ShopifyProductConsolidationApplyRequest;
}): string {
  return createHash("sha256")
    .update(canonicalJson({
      contractVersion: 1,
      actor: input.actor,
      ...input.request,
    }))
    .digest("hex");
}
