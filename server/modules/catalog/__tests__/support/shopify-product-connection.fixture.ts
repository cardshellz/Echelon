import { buildShopifyProductMappingSummary } from "../../shopify-product-mapping.domain";
import type { ShopifyConnectionRemoteProduct, ShopifyConnectionSource } from "../../shopify-product-connection.domain";

export const CONNECTION_COMMAND_KEY = "00000000-0000-4000-8000-000000000041";
export const CONNECTION_ACTOR = "user:operator-1";

export function connectionSource(variantCount = 2): ShopifyConnectionSource {
  const variants = Array.from({ length: variantCount }, (_, index) => ({
    id: 51 + index, sku: `BINDER-P${index + 1}`, name: `Package ${index + 1}`, barcode: null,
    isActive: true, salesEligibility: "sellable" as const, requiresShipping: true, trackInventory: index % 2 === 0,
    priceCents: 1999 + index, compareAtPriceCents: null,
  }));
  return {
    product: { id: 41, sku: "BINDER", name: "Binder", title: null, description: "<p>A binder</p>",
      vendor: "Brand", productType: "Binders", tags: ["catalog-tag"], isActive: true, trackInventory: false },
    variants, images: [], channel: { id: 7, name: "Shopify", shopDomain: "test-store.myshopify.com", connectionId: 9, apiVersion: "2026-01" },
    mapping: buildShopifyProductMappingSummary({ productId: 41, productName: "Binder", productSku: "BINDER", catalogProductId: null,
      channel: { id: 7, name: "Shopify", isPrimary: true }, variants: variants.map(variant => ({
        variantId: variant.id, sku: variant.sku, isActive: variant.isActive, catalogBarcode: variant.barcode,
        catalogVariantId: null, catalogInventoryItemId: null, feedId: null, feedIsActive: null, feedProductId: null,
        feedVariantId: null, feedInventoryItemId: null, listingId: null, listingProductId: null, listingVariantId: null,
      })) }),
  };
}

export function existingConnectionProduct(source = connectionSource()): ShopifyConnectionRemoteProduct {
  return { id: "900", title: "Existing binder", handle: "binder", status: "DRAFT", ownership: null,
    variants: source.variants.filter(variant => variant.isActive && variant.salesEligibility === "sellable").map((variant, index) => ({
      id: String(901 + index), title: variant.name, sku: variant.sku, inventoryItemId: String(1901 + index),
      barcode: variant.barcode, priceCents: variant.priceCents!, optionValue: variant.name, localVariantId: null,
      ownership: null, requiresShipping: variant.requiresShipping, trackInventory: variant.trackInventory, inventoryQuantity: 0,
    })) };
}
