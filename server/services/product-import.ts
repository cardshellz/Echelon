/**
 * Product Import Service
 *
 * Handles importing and syncing product data from Shopify into the
 * Echelon products/product_variants/product_assets tables.
 *
 * Two main workflows:
 *   1. syncContentAndAssets() — Updates content fields + images on existing products
 *   2. syncProductsWithMultiUOM() — Full SKU-based product/variant creation with hierarchy parsing
 */

import { storage } from "../storage";
import { fetchShopifyCatalogProducts, type ShopifyCatalogProduct } from "../shopify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentSyncResult {
  success: true;
  skuMatched: number;
  skuNotFound: number;
  unmatchedSkus: string[];
  productsUpdated: number;
  assets: number;
  totalProducts: number;
  totalVariants: number;
}

export interface ProductSyncResult {
  success: true;
  products: { created: number; updated: number };
  variants: { created: number; updated: number };
  baseSkusWithVariants: number;
  standaloneProducts: number;
  totalShopifyVariants: number;
}

// SKU parsing pattern: BASE-SKU-[P|B|C]###
const VARIANT_PATTERN = /^(.+)-(P|B|C)(\d+)$/i;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createProductImportService() {
  /**
   * Sync content fields + images from Shopify to existing Echelon products.
   * Matches by SKU or shopifyProductId. Does NOT create new products.
   */
  async function syncContentAndAssets(): Promise<ContentSyncResult> {
    console.log("Starting Shopify catalog sync...");

    const shopifyProducts = await fetchShopifyCatalogProducts();
    console.log(`Fetched ${shopifyProducts.length} variants from Shopify`);

    // Group variants by Shopify Product ID
    const productGroups = new Map<number, ShopifyCatalogProduct[]>();
    for (const variant of shopifyProducts) {
      const group = productGroups.get(variant.shopifyProductId) || [];
      group.push(variant);
      productGroups.set(variant.shopifyProductId, group);
    }
    console.log(`Grouped into ${productGroups.size} parent products`);

    let variantsUpdated = 0;
    let productsUpdated = 0;
    let assetsCreated = 0;
    let skuNotFound = 0;
    const unmatchedSkus: string[] = [];

    for (const [shopifyProductId, variants] of productGroups) {
      const firstVariant = variants[0];

      // Resolve the Echelon product by matching any variant SKU or by shopifyProductId
      let echelonProduct = await storage.getProductByShopifyProductId(String(shopifyProductId));
      for (const variant of variants) {
        if (variant.sku) {
          const pv = await storage.getProductVariantBySku(variant.sku);
          if (pv) {
            if (!echelonProduct) {
              echelonProduct = await storage.getProductById(pv.productId);
            }
            variantsUpdated++;
          } else {
            skuNotFound++;
            unmatchedSkus.push(variant.sku);
          }
        } else {
          skuNotFound++;
          unmatchedSkus.push(`(no SKU) ${variant.title}`);
        }
      }

      if (echelonProduct) {
        // Update content fields
        await storage.updateProduct(echelonProduct.id, {
          title: firstVariant.productTitle || firstVariant.title,
          description: firstVariant.description,
          brand: firstVariant.vendor,
          category: firstVariant.productType,
          tags: firstVariant.tags,
          status: firstVariant.status,
          shopifyProductId: String(shopifyProductId),
        });
        productsUpdated++;

        // Sync product_assets — clear existing and recreate
        await storage.deleteProductAssetsByProductId(echelonProduct.id);

        const seenUrls = new Set<string>();
        for (const variant of variants) {
          for (let i = 0; i < variant.allImages.length; i++) {
            const img = variant.allImages[i];
            if (!seenUrls.has(img.url)) {
              seenUrls.add(img.url);

              let variantId: number | null = null;
              if (variant.sku) {
                const pv = await storage.getProductVariantBySku(variant.sku);
                if (pv) variantId = pv.id;
              }

              await storage.createProductAsset({
                productId: echelonProduct.id,
                productVariantId: variantId,
                assetType: "image",
                url: img.url,
                position: img.position,
                isPrimary: seenUrls.size === 1 ? 1 : 0,
              });
              assetsCreated++;
            }
          }

          // Also sync to product_locations for warehouse assignment
          if (variant.sku) {
            await storage.upsertProductLocationBySku(variant.sku, variant.title, variant.status, undefined, variant.barcode || undefined);
          }
        }
      } else {
        console.log(`[Sync] No Echelon product for Shopify product ${shopifyProductId} (${firstVariant.productTitle})`);
      }
    }

    console.log(`Sync complete: ${variantsUpdated} SKUs matched, ${skuNotFound} unmatched, ${productsUpdated} products updated, ${assetsCreated} assets`);
    if (unmatchedSkus.length > 0) {
      console.log(`Unmatched SKUs (need to be created in Echelon first):`, unmatchedSkus.slice(0, 20));
    }

    return {
      success: true,
      skuMatched: variantsUpdated,
      skuNotFound,
      unmatchedSkus: unmatchedSkus.slice(0, 50),
      productsUpdated,
      assets: assetsCreated,
      totalProducts: productGroups.size,
      totalVariants: shopifyProducts.length,
    };
  }

  /**
   * Full product/variant sync from Shopify with multi-UOM SKU parsing.
   * Parses SKU pattern: BASE-SKU-P50, BASE-SKU-B200, BASE-SKU-C700
   * P=Pack, B=Box, C=Case, number=units per variant.
   * Creates/updates products and product_variants.
   */
  async function syncProductsWithMultiUOM(): Promise<ProductSyncResult> {
    console.log("Starting Shopify product sync to products/product_variants tables...");

    const shopifyProducts = await fetchShopifyCatalogProducts();
    console.log(`Fetched ${shopifyProducts.length} variants from Shopify`);

    // Group by parsed base SKU
    const baseSkuMap: Record<string, {
      baseSku: string;
      baseName: string;
      shopifyProductId: number;
      vendor: string | null;
      productType: string | null;
      description: string | null;
      imageUrl: string | null;
      variants: Array<{
        sku: string;
        name: string;
        type: string;
        unitsPerVariant: number;
        shopifyVariantId: number;
        shopifyInventoryItemId: number | null;
        barcode: string | null;
        imageUrl: string | null;
      }>;
    }> = {};

    // Variants without the -P/-B/-C suffix (treated as single units)
    const standaloneVariants: Array<{
      sku: string;
      name: string;
      shopifyProductId: number;
      shopifyVariantId: number;
      shopifyInventoryItemId: number | null;
      vendor: string | null;
      productType: string | null;
      description: string | null;
      barcode: string | null;
      imageUrl: string | null;
    }> = [];

    for (const variant of shopifyProducts) {
      if (!variant.sku) continue;

      const match = variant.sku.match(VARIANT_PATTERN);

      if (match) {
        const baseSku = match[1];
        const variantType = match[2].toUpperCase();
        const unitsPerVariant = parseInt(match[3], 10);

        if (!baseSkuMap[baseSku]) {
          let baseName = variant.productTitle || variant.title;
          const packMatch = baseName.match(/\s*[-–]\s*(Pack|Box|Case)\s+of\s+\d+.*/i);
          if (packMatch) {
            baseName = baseName.substring(0, packMatch.index).trim();
          }

          baseSkuMap[baseSku] = {
            baseSku,
            baseName,
            shopifyProductId: variant.shopifyProductId,
            vendor: variant.vendor,
            productType: variant.productType,
            description: variant.description,
            imageUrl: variant.imageUrl,
            variants: []
          };
        }

        baseSkuMap[baseSku].variants.push({
          sku: variant.sku,
          name: variant.variantTitle || `${variantType === 'P' ? 'Pack' : variantType === 'B' ? 'Box' : 'Case'} of ${unitsPerVariant}`,
          type: variantType === 'P' ? 'Pack' : variantType === 'B' ? 'Box' : 'Case',
          unitsPerVariant,
          shopifyVariantId: variant.variantId,
          shopifyInventoryItemId: variant.inventoryItemId,
          barcode: variant.barcode,
          imageUrl: variant.imageUrl
        });
      } else {
        standaloneVariants.push({
          sku: variant.sku,
          name: variant.title,
          shopifyProductId: variant.shopifyProductId,
          shopifyVariantId: variant.variantId,
          shopifyInventoryItemId: variant.inventoryItemId,
          vendor: variant.vendor,
          productType: variant.productType,
          description: variant.description,
          barcode: variant.barcode,
          imageUrl: variant.imageUrl
        });
      }
    }

    console.log(`Parsed: ${Object.keys(baseSkuMap).length} base SKUs with variants, ${standaloneVariants.length} standalone`);

    let productsCreated = 0;
    let productsUpdated = 0;
    let variantsCreated = 0;
    let variantsUpdated = 0;

    // Process base SKUs with variants
    for (const [baseSku, data] of Object.entries(baseSkuMap)) {
      let product = await storage.getProductBySku(baseSku);

      if (product) {
        await storage.updateProduct(product.id, {
          name: data.baseName,
          category: data.productType,
          brand: data.vendor,
          description: data.description,
          shopifyProductId: String(data.shopifyProductId),
        });
        productsUpdated++;
      } else {
        product = await storage.createProduct({
          sku: baseSku,
          name: data.baseName,
          category: data.productType,
          brand: data.vendor,
          description: data.description,
          shopifyProductId: String(data.shopifyProductId),
          baseUnit: 'EA',
        });
        productsCreated++;
      }

      for (const v of data.variants) {
        const hierarchyLevel = v.type === 'Pack' ? 1 : v.type === 'Box' ? 2 : 3;
        let variant = await storage.getProductVariantBySku(v.sku);

        if (variant) {
          // Guard: don't silently reassign variant to different product
          if (variant.productId !== product.id) {
            console.warn(`[PRODUCT IMPORT] SKU conflict: ${v.sku} exists on product_id=${variant.productId} but import wants product_id=${product.id} — skipping update`);
            continue;
          }
          await storage.updateProductVariant(variant.id, {
            name: v.name,
            unitsPerVariant: v.unitsPerVariant,
            hierarchyLevel,
            barcode: v.barcode,
            shopifyVariantId: String(v.shopifyVariantId),
            shopifyInventoryItemId: v.shopifyInventoryItemId ? String(v.shopifyInventoryItemId) : undefined,
          });
          variantsUpdated++;
        } else {
          await storage.createProductVariant({
            productId: product.id,
            sku: v.sku,
            name: v.name,
            unitsPerVariant: v.unitsPerVariant,
            hierarchyLevel,
            barcode: v.barcode,
            shopifyVariantId: String(v.shopifyVariantId),
            shopifyInventoryItemId: v.shopifyInventoryItemId ? String(v.shopifyInventoryItemId) : null,
          });
          variantsCreated++;
        }
      }
    }

    // Process standalone variants (no -P/-B/-C suffix)
    for (const sv of standaloneVariants) {
      let product = await storage.getProductBySku(sv.sku);

      if (product) {
        await storage.updateProduct(product.id, {
          name: sv.name,
          category: sv.productType,
          brand: sv.vendor,
          description: sv.description,
          shopifyProductId: String(sv.shopifyProductId),
        });
        productsUpdated++;
      } else {
        product = await storage.createProduct({
          sku: sv.sku,
          name: sv.name,
          category: sv.productType,
          brand: sv.vendor,
          description: sv.description,
          shopifyProductId: String(sv.shopifyProductId),
          baseUnit: 'EA',
        });
        productsCreated++;
      }

      let variant = await storage.getProductVariantBySku(sv.sku);

      if (variant) {
        if (variant.productId !== product.id) {
          console.warn(`[PRODUCT IMPORT] SKU conflict: ${sv.sku} exists on product_id=${variant.productId} but import wants product_id=${product.id} — skipping update`);
          continue;
        }
        await storage.updateProductVariant(variant.id, {
          name: 'Each',
          unitsPerVariant: 1,
          hierarchyLevel: 1,
          barcode: sv.barcode,
          shopifyVariantId: String(sv.shopifyVariantId),
          shopifyInventoryItemId: sv.shopifyInventoryItemId ? String(sv.shopifyInventoryItemId) : undefined,
        });
        variantsUpdated++;
      } else {
        await storage.createProductVariant({
          productId: product.id,
          sku: sv.sku,
          name: 'Each',
          unitsPerVariant: 1,
          hierarchyLevel: 1,
          barcode: sv.barcode,
          shopifyVariantId: String(sv.shopifyVariantId),
          shopifyInventoryItemId: sv.shopifyInventoryItemId ? String(sv.shopifyInventoryItemId) : null,
        });
        variantsCreated++;
      }
    }

    console.log(`Sync complete: products ${productsCreated} created/${productsUpdated} updated, variants ${variantsCreated} created/${variantsUpdated} updated`);

    return {
      success: true,
      products: { created: productsCreated, updated: productsUpdated },
      variants: { created: variantsCreated, updated: variantsUpdated },
      baseSkusWithVariants: Object.keys(baseSkuMap).length,
      standaloneProducts: standaloneVariants.length,
      totalShopifyVariants: shopifyProducts.length,
    };
  }

  return {
    syncContentAndAssets,
    syncProductsWithMultiUOM,
  };
}

export type ProductImportService = ReturnType<typeof createProductImportService>;
