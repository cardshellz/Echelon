import { ebayAvailablePolicyValuesSchema, type EbayAvailablePolicyValues } from "@shared/ebay-business-policies";
import { ChannelListingValidationError } from "@shared/channel-listing-validation";
import type { ChannelPackageRequirements, ShippingPackageType } from "@shared/catalog/shipping-package";
import {
  EbayListingBuilder,
  type BuiltEbayListingDraft,
  type EbayListingConfig,
} from "./adapters/ebay/ebay-listing-builder";
import type { EbayListingPolicies } from "./adapters/ebay/ebay-types";
import type {
  ChannelListingPayload,
  ChannelVariantPayload,
} from "./channel-adapter.interface";

import type { EbayListingPhotoPlan } from "./ebay-listing-photos.domain";

const EBAY_MAX_TITLE_LENGTH = 80;

interface EbayRouteProductInput {
  name: string;
  sku?: string | null;
  description?: string | null;
}

interface EbayRouteVariantInput {
  id: number;
  sku?: string | null;
  name?: string | null;
  option1_value?: string | null;
  price_cents?: unknown;
  compare_at_price_cents?: unknown;
  barcode?: string | null;
  ebay_weight_grams?: unknown;
  weight_override?: unknown;
  weight_grams?: unknown;
  weightGrams?: unknown;
  length_mm?: number | string | null;
  width_mm?: number | string | null;
  height_mm?: number | string | null;
  shipping_package_type?: ShippingPackageType | null;
  isListed?: boolean;
}

interface EbayRouteListingDraftInput {
  productId: number;
  product: EbayRouteProductInput;
  variants: EbayRouteVariantInput[];
  photoPlan: EbayListingPhotoPlan;
  aspects: Record<string, string[]>;
  isMultiVariant: boolean;
  variationAspectName: string;
  variantPrices: Map<number, number>;
  atpByVariantId: Map<number, number>;
  marketplaceId: string;
  ebayBrowseCategoryId: string;
  /** Resolved and catalog-validated by the channel policy owner before transport. */
  resolvedPoliciesByVariantId: ReadonlyMap<number, EbayAvailablePolicyValues>;
  packageRequirementsByVariantId?: ReadonlyMap<number, ChannelPackageRequirements>;
  storeCategoryNames: string[];
  merchantLocationKey: string;
  retainUnlistedVariantsInGroup?: boolean;
  /** Existing listing maintenance uses the provider-observed key, including no group for a single item. */
  existingGroupKey?: string | null;
}

const ebayListingBuilder = new EbayListingBuilder();

export function buildEbayRouteListingDraft(
  input: EbayRouteListingDraftInput,
): BuiltEbayListingDraft {
  const firstPolicies = input.resolvedPoliciesByVariantId?.values().next().value;
  if (!firstPolicies) throw new ChannelListingValidationError({ field: "policies", reason: "required", productId: input.productId });
  const listingPolicies = ebayAvailablePolicyValuesSchema.parse(firstPolicies);
  const groupKey = input.existingGroupKey === undefined
    ? input.product.sku || `PROD-${input.productId}` : input.existingGroupKey;
  if (input.existingGroupKey !== undefined && input.isMultiVariant && groupKey === null) {
    throw new ChannelListingValidationError({ field: "listing_identity", reason: "required", productId: input.productId });
  }
  const descriptionHtml = input.product.description || `<p>${escapeHtml(input.product.name)}</p>`;
  const variants: ChannelVariantPayload[] = [];
  const availableQuantityByVariantId = new Map<number, number>();
  const variantListingPoliciesByVariantId = new Map<number, Partial<EbayListingPolicies>>();
  const variationValueByVariantId = new Map<number, string>();

  for (const routeVariant of input.variants) {
    const sku = String(routeVariant.sku ?? "").trim();
    if (!sku) continue;

    const variantId = normalizeRequiredPositiveInteger(routeVariant.id, input.productId);
    const isListed = routeVariant.isListed !== false;
    const priceCents = normalizeCents(input.variantPrices.get(variantId) ?? routeVariant.price_cents);
    if (isListed && (priceCents === null || !isValidEbayFixedPriceCents(priceCents))) {
      throw new ChannelListingValidationError({ field: "price", reason: priceCents === null ? "required" : "invalid",
        productId: input.productId, variantId, variantSku: sku });
    }

    const availableQty = isListed
      ? Math.max(0, input.atpByVariantId.get(variantId) ?? 0)
      : 0;
    const variationValue = routeVariant.option1_value || routeVariant.name || sku;
    availableQuantityByVariantId.set(variantId, availableQty);
    variationValueByVariantId.set(variantId, variationValue);

    const resolvedPolicies = input.resolvedPoliciesByVariantId.get(variantId);
    if (isListed && !resolvedPolicies) throw new ChannelListingValidationError({ field: "policies", reason: "required", productId: input.productId, variantId });
    if (resolvedPolicies) {
      variantListingPoliciesByVariantId.set(variantId, ebayAvailablePolicyValuesSchema.parse(resolvedPolicies));
    }

    variants.push({
      variantId,
      sku,
      name: routeVariant.name || variationValue,
      barcode: routeVariant.barcode ?? null,
      gtin: null,
      mpn: null,
      weightGrams: normalizePackageWeightGrams(routeVariant),
      package: { weightGrams: (routeVariant.ebay_weight_grams ?? routeVariant.weight_override ?? routeVariant.weight_grams ?? routeVariant.weightGrams ?? null) as number | string | null,
        lengthMm: routeVariant.length_mm, widthMm: routeVariant.width_mm, heightMm: routeVariant.height_mm,
        shippingPackageType: routeVariant.shipping_package_type },
      priceCents,
      compareAtPriceCents: normalizeCents(routeVariant.compare_at_price_cents),
      isListed,
      externalVariantId: null,
      externalInventoryItemId: null,
    });
  }

  const listing: ChannelListingPayload = {
    productId: input.productId,
    title: input.product.name,
    description: descriptionHtml,
    category: null,
    tags: null,
    status: "active",
    variants,
    images: [],
    metadata: {
      groupKey,
      itemSpecifics: input.aspects,
      conditionId: 1000,
    },
  };

  const config: EbayListingConfig = {
    merchantLocationKey: input.merchantLocationKey,
    listingPolicies,
    marketplaceId: input.marketplaceId,
    channelOverrides: {
      marketplaceCategoryId: input.ebayBrowseCategoryId,
      conditionId: 1000,
    },
  };

  return ebayListingBuilder.buildListingDraft(listing, config, {
    photoPlan: input.photoPlan,
    availableQuantityByVariantId,
    requirePackageWeight: true,
    packageRequirementsByVariantId: input.packageRequirementsByVariantId,
    titleMaxLength: EBAY_MAX_TITLE_LENGTH,
    descriptionHtmlOverride: descriptionHtml,
    categoryIdOverride: input.ebayBrowseCategoryId,
    variantListingPoliciesByVariantId,
    storeCategoryNames: input.storeCategoryNames,
    variationAspectName: input.isMultiVariant ? input.variationAspectName : undefined,
    variationValueByVariantId,
    itemGroupKey: groupKey ?? undefined,
    preserveExistingGroup: input.existingGroupKey !== undefined && groupKey !== null,
    itemGroupAspects: input.aspects,
    includeVariantSkusInGroup: true,
    retainUnlistedVariantsInGroup: input.retainUnlistedVariantsInGroup === true,
    includeEmptyAspectsImageVariesBy: true,
    // updateOffer replaces the offer. Its description must come from the same
    // prepared catalog revision as the inventory item and group, including when
    // repairing a legacy listing whose provider description is missing.
    includeOfferListingDescription: true,
    includeOfferTax: false,
  });
}

function normalizeRequiredPositiveInteger(value: unknown, productId: number): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isInteger(numeric) || numeric <= 0) {
    throw new ChannelListingValidationError({ field: "variant_identity", reason: "invalid", productId });
  }
  return numeric;
}

function normalizePackageWeightGrams(variant: EbayRouteVariantInput): number | null {
  const rawWeight =
    variant.ebay_weight_grams
    ?? variant.weight_override
    ?? variant.weight_grams
    ?? variant.weightGrams
    ?? null;
  const numeric = typeof rawWeight === "string" ? Number(rawWeight) : rawWeight;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function centsToDecimalString(cents: number): string {
  const normalized = Math.trunc(cents);
  const whole = Math.floor(Math.abs(normalized) / 100);
  const fractional = String(Math.abs(normalized) % 100).padStart(2, "0");
  return `${normalized < 0 ? "-" : ""}${whole}.${fractional}`;
}

export const EBAY_MIN_FIXED_PRICE_CENTS = 99;

export function normalizeCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return null;
  return Math.trunc(numeric);
}

export function isValidEbayFixedPriceCents(value: unknown): boolean {
  const cents = normalizeCents(value);
  return cents !== null && cents >= EBAY_MIN_FIXED_PRICE_CENTS;
}

export function formatEbayMinimumPrice(): string {
  return `$${centsToDecimalString(EBAY_MIN_FIXED_PRICE_CENTS)}`;
}
