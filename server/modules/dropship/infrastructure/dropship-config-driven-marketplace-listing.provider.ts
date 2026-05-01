import type {
  DropshipCanonicalListingContent,
  DropshipMarketplaceListingProvider,
  DropshipMarketplaceListingValidationResult,
  DropshipStoreListingConfig,
} from "../application/dropship-marketplace-listing-provider";

export class ConfigDrivenDropshipMarketplaceListingProvider implements DropshipMarketplaceListingProvider {
  buildListingIntent(input: {
    config: DropshipStoreListingConfig;
    content: DropshipCanonicalListingContent;
    priceCents: number | null;
    quantity: number;
  }): DropshipMarketplaceListingValidationResult {
    const blockers: string[] = [];
    const warnings: string[] = [];

    if (!input.config.isActive) {
      blockers.push("listing_config_inactive");
    }
    if (input.config.listingMode === "manual_only") {
      blockers.push("listing_config_manual_only");
    }
    if (input.quantity <= 0) {
      blockers.push("marketplace_quantity_unavailable");
    }
    if (input.priceCents === null || input.priceCents < 0) {
      blockers.push("vendor_retail_price_required");
    }

    for (const key of input.config.requiredConfigKeys) {
      if (!hasConfigValue(input.config.marketplaceConfig, key)) {
        blockers.push(`missing_config:${key}`);
      }
    }

    for (const field of input.config.requiredProductFields) {
      if (!hasProductField(input.content, field)) {
        blockers.push(`missing_product_field:${field}`);
      }
    }

    const title = input.content.title?.trim() || input.content.productName.trim();
    if (!title) {
      blockers.push("listing_title_required");
    }
    if (!input.content.sku?.trim()) {
      blockers.push("variant_sku_required");
    }
    if (!input.content.description?.trim()) {
      warnings.push("listing_description_missing");
    }

    if (blockers.length > 0 || input.priceCents === null) {
      return { intent: null, blockers, warnings };
    }

    return {
      intent: {
        platform: input.config.platform,
        listingMode: input.config.listingMode,
        inventoryMode: input.config.inventoryMode,
        priceMode: input.config.priceMode,
        productVariantId: input.content.productVariantId,
        sku: input.content.sku,
        title,
        description: input.content.description,
        category: input.content.category,
        condition: input.content.condition,
        priceCents: input.priceCents,
        quantity: input.quantity,
        marketplaceConfig: input.config.marketplaceConfig,
      },
      blockers,
      warnings,
    };
  }
}

function hasConfigValue(config: Record<string, unknown>, dottedKey: string): boolean {
  const value = dottedKey
    .split(".")
    .reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, config);

  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== null && value !== undefined;
}

function hasProductField(content: DropshipCanonicalListingContent, field: string): boolean {
  const value = (content as unknown as Record<string, unknown>)[field];
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return value !== null && value !== undefined;
}
