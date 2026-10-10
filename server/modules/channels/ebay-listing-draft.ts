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
  ebay_fulfillment_policy_override?: string | null;
  ebay_return_policy_override?: string | null;
  ebay_payment_policy_override?: string | null;
  isListed?: boolean;
}

interface EbayRoutePoliciesInput {
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
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
  effectivePolicies: EbayRoutePoliciesInput;
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
  const listingPolicies = resolveRequiredPolicies(input.effectivePolicies);
  const groupKey = input.existingGroupKey === undefined
    ? input.product.sku || `PROD-${input.productId}` : input.existingGroupKey;
  if (input.existingGroupKey !== undefined && input.isMultiVariant && groupKey === null) {
    throw new Error("An existing multi-variant eBay listing requires its verified group key.");
  }
  const descriptionHtml = input.product.description || `<p>${escapeHtml(input.product.name)}</p>`;
  const variants: ChannelVariantPayload[] = [];
  const availableQuantityByVariantId = new Map<number, number>();
  const variantListingPoliciesByVariantId = new Map<number, Partial<EbayListingPolicies>>();
  const variationValueByVariantId = new Map<number, string>();

  for (const routeVariant of input.variants) {
    const sku = String(routeVariant.sku ?? "").trim();
    if (!sku) continue;

    const variantId = normalizeRequiredPositiveInteger(routeVariant.id, `Invalid eBay variant id for SKU ${sku}.`);
    const isListed = routeVariant.isListed !== false;
    const priceCents = normalizeCents(input.variantPrices.get(variantId) ?? routeVariant.price_cents);
    if (isListed && (priceCents === null || !isValidEbayFixedPriceCents(priceCents))) {
      throw new Error(
        `eBay listing price is required and must be at least ${formatEbayMinimumPrice()} for SKU ${sku}.`,
      );
    }

    const availableQty = isListed
      ? Math.max(0, input.atpByVariantId.get(variantId) ?? 0)
      : 0;
    const variationValue = routeVariant.option1_value || routeVariant.name || sku;
    availableQuantityByVariantId.set(variantId, availableQty);
    variationValueByVariantId.set(variantId, variationValue);

    const variantPolicies = resolveVariantPolicies(routeVariant);
    if (variantPolicies) {
      variantListingPoliciesByVariantId.set(variantId, variantPolicies);
    }

    variants.push({
      variantId,
      sku,
      name: routeVariant.name || variationValue,
      barcode: routeVariant.barcode ?? null,
      gtin: null,
      mpn: null,
      weightGrams: normalizePackageWeightGrams(routeVariant),
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
    includeOfferListingDescription: false,
    includeOfferTax: false,
  });
}

function resolveRequiredPolicies(policies: EbayRoutePoliciesInput): EbayListingPolicies {
  const resolved = {
    fulfillmentPolicyId: normalizePolicyId(policies.fulfillmentPolicyId),
    returnPolicyId: normalizePolicyId(policies.returnPolicyId),
    paymentPolicyId: normalizePolicyId(policies.paymentPolicyId),
  };
  const missing = Object.entries(resolved)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`eBay listing policies are required before pushing listings. Missing: ${missing.join(", ")}.`);
  }
  return resolved as EbayListingPolicies;
}

function resolveVariantPolicies(
  variant: EbayRouteVariantInput,
): Partial<EbayListingPolicies> | null {
  const policies: Partial<EbayListingPolicies> = {};
  const fulfillmentPolicyId = normalizePolicyId(variant.ebay_fulfillment_policy_override);
  const returnPolicyId = normalizePolicyId(variant.ebay_return_policy_override);
  const paymentPolicyId = normalizePolicyId(variant.ebay_payment_policy_override);
  if (fulfillmentPolicyId) policies.fulfillmentPolicyId = fulfillmentPolicyId;
  if (returnPolicyId) policies.returnPolicyId = returnPolicyId;
  if (paymentPolicyId) policies.paymentPolicyId = paymentPolicyId;
  return Object.keys(policies).length > 0 ? policies : null;
}

function normalizePolicyId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRequiredPositiveInteger(value: unknown, errorMessage: string): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(errorMessage);
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
  // catalog.product_variants.weight_grams is numeric(10,2) (migration 185);
  // eBay package weights are sent in whole grams.
  return Math.max(1, Math.round(numeric));
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
