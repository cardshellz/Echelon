import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";

export type DropshipListingMode = "draft_first" | "live" | "manual_only";
export type DropshipListingInventoryMode = "managed_quantity_sync" | "manual_quantity" | "disabled";
export type DropshipListingPriceMode = "vendor_defined" | "connection_default" | "disabled";

export interface DropshipStoreListingConfig {
  id: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  listingMode: DropshipListingMode;
  inventoryMode: DropshipListingInventoryMode;
  priceMode: DropshipListingPriceMode;
  marketplaceConfig: Record<string, unknown>;
  requiredConfigKeys: string[];
  requiredProductFields: string[];
  isActive: boolean;
}

export interface DropshipCanonicalListingContent {
  productId: number;
  productVariantId: number;
  sku: string | null;
  productName: string;
  variantName: string;
  title: string | null;
  description: string | null;
  category: string | null;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  condition: string | null;
  itemSpecifics: Record<string, unknown> | null;
}

export interface DropshipMarketplaceListingIntent {
  platform: DropshipSourcePlatform;
  listingMode: DropshipListingMode;
  inventoryMode: DropshipListingInventoryMode;
  priceMode: DropshipListingPriceMode;
  productVariantId: number;
  sku: string | null;
  title: string;
  description: string | null;
  category: string | null;
  condition: string | null;
  priceCents: number;
  quantity: number;
  marketplaceConfig: Record<string, unknown>;
}

export interface DropshipMarketplaceListingValidationResult {
  intent: DropshipMarketplaceListingIntent | null;
  blockers: string[];
  warnings: string[];
}

export interface DropshipMarketplaceListingProvider {
  buildListingIntent(input: {
    config: DropshipStoreListingConfig;
    content: DropshipCanonicalListingContent;
    priceCents: number | null;
    quantity: number;
  }): DropshipMarketplaceListingValidationResult;
}
