/**
 * eBay Listing Builder
 *
 * Transforms Echelon's canonical ChannelListingPayload into
 * eBay Inventory API payloads:
 * - InventoryItem (per SKU)
 * - Offer (per SKU per marketplace)
 * - InventoryItemGroup (for multi-variation listings)
 *
 * Handles all eBay-specific formatting, aspect mapping,
 * and description HTML generation.
 */

import type {
  EbayInventoryItem,
  EbayOffer,
  EbayInventoryItemGroup,
  EbayConditionEnum,
  EbayListingPolicies,
} from "./ebay-types";
import type {
  ChannelListingPayload,
  ChannelVariantPayload,
  ChannelImagePayload,
} from "../../channel-adapter.interface";
import {
  resolveEbayCategoryMapping,
  buildItemSpecifics,
  type CategoryMapping,
} from "./ebay-category-map";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EbayListingConfig {
  /** eBay merchant location key (from Inventory API) */
  merchantLocationKey: string;
  /** Business policy IDs */
  listingPolicies: EbayListingPolicies;
  /** Default marketplace ID */
  marketplaceId?: string;
  /** Channel-level product overrides (from channel_product_overrides table) */
  channelOverrides?: {
    itemSpecifics?: Record<string, string[]> | null;
    marketplaceCategoryId?: string | null;
    listingFormat?: string | null;
    conditionId?: number | null;
    titleOverride?: string | null;
    descriptionOverride?: string | null;
  };
}

export interface BuiltInventoryItem {
  sku: string;
  payload: Omit<EbayInventoryItem, "sku">;
}

export interface BuiltOffer {
  sku: string;
  variantId: number;
  payload: EbayOffer;
}

export interface BuiltItemGroup {
  groupKey: string;
  payload: Omit<EbayInventoryItemGroup, "inventoryItemGroupKey">;
}

export interface EbayListingBuildOptions {
  availableQuantityByVariantId?: ReadonlyMap<number, number>;
  requirePackageWeight?: boolean;
  titleMaxLength?: number;
  descriptionHtmlOverride?: string;
  categoryIdOverride?: string;
  variantListingPoliciesByVariantId?: ReadonlyMap<number, Partial<EbayListingPolicies>>;
  storeCategoryNames?: string[];
  variationAspectName?: string;
  variationValueByVariantId?: ReadonlyMap<number, string>;
  itemGroupKey?: string;
  itemGroupAspects?: Record<string, string[]>;
  includeVariantSkusInGroup?: boolean;
  includeEmptyAspectsImageVariesBy?: boolean;
  includeOfferListingDescription?: boolean;
  includeOfferTax?: boolean;
}

export interface BuiltEbayListingDraft {
  inventoryItems: BuiltInventoryItem[];
  offers: BuiltOffer[];
  itemGroup: BuiltItemGroup | null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class EbayListingBuilder {
  buildListingDraft(
    listing: ChannelListingPayload,
    config: EbayListingConfig,
    options: EbayListingBuildOptions = {},
  ): BuiltEbayListingDraft {
    return {
      inventoryItems: this.buildInventoryItems(listing, config, options),
      offers: this.buildOffers(listing, config, options),
      itemGroup: this.buildItemGroup(listing, config, options),
    };
  }

  /**
   * Build eBay InventoryItem payloads from listing data.
   * One InventoryItem per active variant SKU.
   */
  buildInventoryItems(
    listing: ChannelListingPayload,
    config: EbayListingConfig,
    options: EbayListingBuildOptions = {},
  ): BuiltInventoryItem[] {
    const categoryMapping = this.resolveCategoryMapping(listing, config);
    const productAspects = buildItemSpecifics(
      categoryMapping,
      listing.metadata?.itemSpecifics as Record<string, string[]> | undefined,
      config.channelOverrides?.itemSpecifics,
    );

    return listing.variants
      .filter((v) => v.isListed && v.sku)
      .map((variant) => ({
        sku: variant.sku!,
        payload: this.buildSingleInventoryItem(
          variant,
          listing,
          productAspects,
          options,
        ),
      }));
  }

  /**
   * Build eBay Offer payloads from listing data.
   * One Offer per active variant SKU.
   */
  buildOffers(
    listing: ChannelListingPayload,
    config: EbayListingConfig,
    options: EbayListingBuildOptions = {},
  ): BuiltOffer[] {
    const categoryMapping = this.resolveCategoryMapping(listing, config);
    const categoryId =
      options.categoryIdOverride ||
      config.channelOverrides?.marketplaceCategoryId ||
      categoryMapping.categoryId;

    return listing.variants
      .filter((v) => v.isListed && v.sku)
      .map((variant) => ({
        sku: variant.sku!,
        variantId: variant.variantId,
        payload: this.buildSingleOffer(
          variant,
          listing,
          config,
          categoryId,
          options,
        ),
      }));
  }

  /**
   * Build eBay InventoryItemGroup for multi-variation listings.
   * Groups all active variants under one listing.
   *
   * Returns null if only one variant (single-variation listing — use publishOffer instead).
   */
  buildItemGroup(
    listing: ChannelListingPayload,
    config: EbayListingConfig,
    options: EbayListingBuildOptions = {},
  ): BuiltItemGroup | null {
    const activeVariants = listing.variants.filter(
      (v) => v.isListed && v.sku,
    );

    // Single variant — no group needed
    if (activeVariants.length <= 1) return null;

    // Determine variation aspect name and values
    const { aspectName, aspectValues } =
      this.extractVariationAspect(activeVariants, options);

    const title =
      this.formatTitle(config.channelOverrides?.titleOverride || listing.title, options);

    const description =
      config.channelOverrides?.descriptionOverride ||
      this.resolveDescriptionHtml(listing, options);

    const imageUrls = listing.images
      .sort((a, b) => a.position - b.position)
      .map((img) => img.url)
      .slice(0, 12); // eBay max 12 for groups

    // Group key = product SKU or product ID
    const groupKey = options.itemGroupKey
      || (listing.metadata?.groupKey as string | undefined)
      || `ECHELON-P${listing.productId}`;
    const aspects = options.itemGroupAspects
      ? { ...options.itemGroupAspects }
      : {
          [aspectName]: aspectValues,
        };
    const payload: Omit<EbayInventoryItemGroup, "inventoryItemGroupKey"> & { variantSKUs?: string[] } = {
      title,
      description,
      imageUrls,
      aspects,
      variesBy: {
        ...(options.includeEmptyAspectsImageVariesBy ? { aspectsImageVariesBy: [] } : {}),
        specifications: [
          {
            name: aspectName,
            values: aspectValues,
          },
        ],
      },
    };
    if (options.includeVariantSkusInGroup) {
      payload.variantSKUs = activeVariants.map((variant) => variant.sku!).filter(Boolean);
    }

    return {
      groupKey,
      payload,
    };
  }

  // -------------------------------------------------------------------------
  // Private: Build Individual Payloads
  // -------------------------------------------------------------------------

  private buildSingleInventoryItem(
    variant: ChannelVariantPayload,
    listing: ChannelListingPayload,
    aspects: Record<string, string[]>,
    options: EbayListingBuildOptions,
  ): Omit<EbayInventoryItem, "sku"> {
    const imageUrls = listing.images
      .sort((a, b) => a.position - b.position)
      .map((img) => img.url)
      .slice(0, 12);

    // Add variant-specific aspects
    const variantAspects = { ...aspects };

    // Add UPC/EAN/MPN if available
    if (variant.gtin) {
      variantAspects["UPC"] = [variant.gtin];
    }
    if (variant.mpn) {
      variantAspects["MPN"] = [variant.mpn];
    }

    if (options.variationAspectName) {
      const variationValue = this.resolveVariationValue(variant, options);
      variantAspects[options.variationAspectName] = [variationValue];
    } else {
      // Add pack size aspect for variation differentiation
      const packSizeLabel = this.extractPackSizeLabel(variant);
      if (packSizeLabel) {
        variantAspects["Number of Items"] = [packSizeLabel];
      }
    }

    const product: EbayInventoryItem["product"] = {
      title: this.formatTitle(listing.title, options),
      description: this.resolveDescriptionHtml(listing, options),
      aspects: variantAspects,
      imageUrls,
    };

    // Set brand/mpn/upc on product level too
    if (aspects["Brand"]?.[0]) product.brand = aspects["Brand"][0];
    if (variant.mpn) product.mpn = variant.mpn;
    if (variant.gtin) product.upc = [variant.gtin];

    const condition = this.mapCondition(
      listing.metadata?.conditionId as number | undefined,
    );

    const item: Omit<EbayInventoryItem, "sku"> = {
      locale: "en_US",
      product,
      condition,
      availability: {
        shipToLocationAvailability: {
          quantity: 0, // Set by inventory push, not listing creation
        },
      },
    };
    item.availability.shipToLocationAvailability.quantity =
      this.resolveAvailableQuantity(variant, options);

    // Add weight if available
    if (variant.weightGrams) {
      item.packageWeightAndSize = {
        weight: {
          value: variant.weightGrams,
          unit: "GRAM",
        },
      };
    } else if (options.requirePackageWeight) {
      throw new Error(
        `eBay package weight is required for SKU ${variant.sku}. Set catalog.product_variants.weight_grams or channels.channel_variant_overrides.weight_override before pushing this listing.`,
      );
    }

    return item;
  }

  private buildSingleOffer(
    variant: ChannelVariantPayload,
    listing: ChannelListingPayload,
    config: EbayListingConfig,
    categoryId: string,
    options: EbayListingBuildOptions,
  ): EbayOffer {
    const priceCents = variant.priceCents || 0;
    const price = (priceCents / 100).toFixed(2);
    const listingPolicies = this.resolveListingPolicies(variant, config, options);

    const offer: EbayOffer = {
      sku: variant.sku!,
      marketplaceId: (config.marketplaceId || "EBAY_US") as any,
      format: "FIXED_PRICE",
      availableQuantity: this.resolveAvailableQuantity(variant, options),
      categoryId,
      listingPolicies,
      merchantLocationKey: config.merchantLocationKey,
      pricingSummary: {
        price: {
          value: price,
          currency: "USD",
        },
      },
    };
    if (options.includeOfferListingDescription !== false) {
      offer.listingDescription = this.resolveDescriptionHtml(listing, options);
    }
    if (options.includeOfferTax !== false) {
      offer.tax = {
        applyTax: true,
      };
    }
    if (options.storeCategoryNames && options.storeCategoryNames.length > 0) {
      offer.storeCategoryNames = options.storeCategoryNames;
    }

    // Add compare-at price as original retail price
    if (variant.compareAtPriceCents) {
      offer.pricingSummary.originalRetailPrice = {
        value: (variant.compareAtPriceCents / 100).toFixed(2),
        currency: "USD",
      };
    }

    return offer;
  }

  // -------------------------------------------------------------------------
  // Private: Helpers
  // -------------------------------------------------------------------------

  private resolveCategoryMapping(
    listing: ChannelListingPayload,
    config: EbayListingConfig,
  ): CategoryMapping {
    // Use channel override category if specified
    if (config.channelOverrides?.marketplaceCategoryId) {
      return {
        categoryId: config.channelOverrides.marketplaceCategoryId,
        categoryName: "Custom Override",
        defaultAspects: { Brand: ["Card Shellz"] },
        conditionId: String(config.channelOverrides.conditionId || 1000),
      };
    }

    return resolveEbayCategoryMapping({
      category: listing.category,
      name: listing.title,
    });
  }

  /**
   * Extract variation aspect name and values from variants.
   * Card Shellz products vary by pack size (P25, P100, C1000, etc.)
   */
  private extractVariationAspect(
    variants: ChannelVariantPayload[],
    options: EbayListingBuildOptions = {},
  ): { aspectName: string; aspectValues: string[] } {
    const aspectName = options.variationAspectName || "Pack Size";
    const aspectValues: string[] = [];

    for (const variant of variants) {
      const label = options.variationAspectName
        ? this.resolveVariationValue(variant, options)
        : this.extractPackSizeLabel(variant);
      if (label && !aspectValues.includes(label)) {
        aspectValues.push(label);
      }
    }

    // If no pack size labels found, fall back to variant name
    if (aspectValues.length === 0) {
      for (const variant of variants) {
        const name = variant.name || variant.sku || `Variant ${variant.variantId}`;
        if (!aspectValues.includes(name)) {
          aspectValues.push(name);
        }
      }
    }

    return { aspectName, aspectValues };
  }

  /**
   * Extract a human-readable pack size label from a variant.
   * Maps internal codes like P25, P100, C1000 to "25 Count", "100 Count", etc.
   */
  private extractPackSizeLabel(variant: ChannelVariantPayload): string | null {
    // Check option1 first (most likely pack size)
    const name = variant.name || "";

    // Match patterns like "P25", "P100", "C1000", "25-Pack", "100 Count"
    const patterns = [
      /(\d+)\s*(?:count|ct|pk|pack)/i,
      /(?:P|C|B)(\d+)/i,
      /(\d+)\s*(?:per\s*)?(?:pack|case|box)/i,
    ];

    for (const pattern of patterns) {
      const match = name.match(pattern);
      if (match) {
        return `${match[1]} Count`;
      }
    }

    // Try the SKU
    const sku = variant.sku || "";
    const skuMatch = sku.match(/[-_](?:P|C|B)(\d+)$/i);
    if (skuMatch) {
      return `${skuMatch[1]} Count`;
    }

    return null;
  }

  /**
   * Build clean HTML description for eBay listing.
   * No external CSS, no JavaScript, no iframes — eBay-compliant.
   */
  private buildDescriptionHtml(listing: ChannelListingPayload): string {
    const bulletPoints = listing.metadata?.bulletPoints as string[] | undefined;

    let html = `<div style="font-family: Arial, Helvetica, sans-serif; max-width: 800px; margin: 0 auto; color: #333;">`;

    // Title
    html += `<h2 style="color: #1a1a1a; margin-bottom: 16px;">${this.escapeHtml(listing.title)}</h2>`;

    // Description
    if (listing.description) {
      html += `<div style="margin-bottom: 20px; line-height: 1.6;">${listing.description}</div>`;
    }

    // Bullet points
    if (bulletPoints && bulletPoints.length > 0) {
      html += `<h3 style="color: #1a1a1a; margin-bottom: 8px;">Features</h3>`;
      html += `<ul style="margin-bottom: 20px; line-height: 1.8;">`;
      for (const point of bulletPoints) {
        html += `<li>${this.escapeHtml(point)}</li>`;
      }
      html += `</ul>`;
    }

    // Brand footer
    html += `<div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 13px; color: #666;">`;
    html += `<p><strong>Card Shellz, LLC</strong> — Premium Trading Card Supplies</p>`;
    html += `<p>Veteran-owned. 100% Happiness Guarantee. Made for collectors, by collectors.</p>`;
    html += `</div>`;

    html += `</div>`;

    return html;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private mapCondition(conditionId?: number): EbayConditionEnum {
    // All Card Shellz products are new
    if (!conditionId || conditionId === 1000) return "NEW";

    const map: Record<number, EbayConditionEnum> = {
      1000: "NEW",
      1500: "NEW_OTHER",
      1750: "NEW_WITH_DEFECTS",
      2000: "CERTIFIED_REFURBISHED",
      2500: "SELLER_REFURBISHED",
      3000: "USED_EXCELLENT",
      4000: "USED_VERY_GOOD",
      5000: "USED_GOOD",
      6000: "USED_ACCEPTABLE",
      7000: "FOR_PARTS_OR_NOT_WORKING",
    };

    return map[conditionId] || "NEW";
  }

  private resolveAvailableQuantity(
    variant: ChannelVariantPayload,
    options: EbayListingBuildOptions,
  ): number {
    const rawQuantity = options.availableQuantityByVariantId?.get(variant.variantId);
    if (rawQuantity === undefined || rawQuantity === null) return 0;
    if (!Number.isFinite(rawQuantity)) return 0;
    return Math.max(0, Math.trunc(rawQuantity));
  }

  private resolveListingPolicies(
    variant: ChannelVariantPayload,
    config: EbayListingConfig,
    options: EbayListingBuildOptions,
  ): EbayListingPolicies {
    const variantPolicies = options.variantListingPoliciesByVariantId?.get(variant.variantId) ?? {};
    return {
      paymentPolicyId: variantPolicies.paymentPolicyId ?? config.listingPolicies.paymentPolicyId,
      returnPolicyId: variantPolicies.returnPolicyId ?? config.listingPolicies.returnPolicyId,
      fulfillmentPolicyId: variantPolicies.fulfillmentPolicyId ?? config.listingPolicies.fulfillmentPolicyId,
    };
  }

  private resolveVariationValue(
    variant: ChannelVariantPayload,
    options: EbayListingBuildOptions,
  ): string {
    const explicitValue = options.variationValueByVariantId?.get(variant.variantId);
    const fallbackValue = variant.name || variant.sku || `Variant ${variant.variantId}`;
    return explicitValue || fallbackValue;
  }

  private resolveDescriptionHtml(
    listing: ChannelListingPayload,
    options: EbayListingBuildOptions,
  ): string {
    return options.descriptionHtmlOverride ?? this.buildDescriptionHtml(listing);
  }

  private formatTitle(title: string, options: EbayListingBuildOptions): string {
    const maxLength = options.titleMaxLength;
    if (!maxLength || title.length <= maxLength) return title;
    return `${title.substring(0, maxLength - 3)}...`;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEbayListingBuilder(): EbayListingBuilder {
  return new EbayListingBuilder();
}
