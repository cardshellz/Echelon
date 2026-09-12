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

import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
const storage = { ...catalogStorage, ...warehouseStorage };
import { fetchShopifyCatalogProducts, type ShopifyCatalogProduct } from "../integrations/shopify";
import { db, productCategories, eq, and } from "../../storage/base";
import {
  decideImportedShopifyProductMapping,
  resolveImportedVariantSku,
  type ImportedShopifyVariantBinding,
} from "./shopify-product-mapping.domain";
import {
  createShopifyProductMappingService,
  type ShopifyProductMappingService,
  type VerifiedShopifyProduct,
} from "./shopify-product-mapping.service";

// ---------------------------------------------------------------------------
// Shopify product_type → Echelon product_type slug mapping
// ---------------------------------------------------------------------------
const PRODUCT_TYPE_SLUG_MAP: Record<string, string> = {
  "toploader": "toploaders",
  "easy glide": "easy-glide-sleeves",
  "magnetic holder": "magnetic-holders",
  "semi-rigid": "semi-rigids",
  "armalope": "armalopes",
  "armalopes": "armalopes",
  "hero": "hero-cases",
  "quad box": "storage-boxes",
  "tough box": "storage-boxes",
  "accessories": "accessories",
  "glove-fit": "glove-fit-toploader", // default, refined by SKU below
  "sleeves and bags": "sleeves-bags",
  "donation": "other",
};

function resolveProductTypeSlug(shopifyType: string | null | undefined, sku?: string | null): string {
  if (!shopifyType || shopifyType.trim() === "") return "other";
  const key = shopifyType.toLowerCase().trim();
  let slug = PRODUCT_TYPE_SLUG_MAP[key] || "other";
  
  // Refine glove-fit by SKU prefix
  if (slug === "glove-fit-toploader" && sku) {
    const skuUp = sku.toUpperCase();
    if (skuUp.startsWith("GLV-MAG")) slug = "glove-fit-mag";
    else if (skuUp.startsWith("GLV-GRD")) slug = "glove-fit-graded";
    else if (skuUp.startsWith("GLV-SR") || skuUp.startsWith("GLV-SLV-SEMI")) slug = "glove-fit-semi";
  }
  
  return slug;
}

function normalizeCategorySlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function resolveImportedProductCategory(categoryName: string | null | undefined): Promise<{ categoryId: number | null; category: string | null }> {
  const name = categoryName?.trim();
  if (!name) {
    return { categoryId: null, category: null };
  }

  const slug = normalizeCategorySlug(name);
  if (!slug) {
    return { categoryId: null, category: name };
  }

  const [existing] = await db
    .select()
    .from(productCategories)
    .where(and(eq(productCategories.slug, slug), eq(productCategories.isActive, true)));

  if (existing) {
    return { categoryId: existing.id, category: existing.name };
  }

  try {
    const [created] = await db
      .insert(productCategories)
      .values({ name, slug })
      .returning();
    return { categoryId: created.id, category: created.name };
  } catch (error: any) {
    if (error?.code !== "23505") throw error;
    const [category] = await db.select().from(productCategories).where(eq(productCategories.slug, slug));
    return category ? { categoryId: category.id, category: category.name } : { categoryId: null, category: name };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentSyncResult {
  success: boolean;
  skuMatched: number;
  skuNotFound: number;
  unmatchedSkus: string[];
  productsUpdated: number;
  assets: number;
  totalProducts: number;
  totalVariants: number;
  canonicalMappings: ShopifyCanonicalMappingProjectionSummary;
  mappingConflicts: ShopifyImportMappingConflict[];
}

export interface ProductSyncResult {
  success: boolean;
  products: { created: number; updated: number };
  variants: { created: number; updated: number };
  baseSkusWithVariants: number;
  standaloneProducts: number;
  totalShopifyVariants: number;
  canonicalMappings: ShopifyCanonicalMappingProjectionSummary;
  mappingConflicts: ShopifyImportMappingConflict[];
}

export interface ShopifyProductAndContentSyncResult extends ProductSyncResult {
  contentSync: {
    success: boolean;
    productsUpdated: number;
    assets: number;
    skuMatched: number;
    skuNotFound: number;
    mappingConflicts: ShopifyImportMappingConflict[];
  };
}

export interface ShopifyCanonicalMappingProjectionSummary {
  eligibleProducts: number;
  attemptedProducts: number;
  repairedProducts: number;
  alreadyConsistentProducts: number;
  failedProducts: number;
  mappedVariants: number;
}

export interface ShopifyImportMappingConflict {
  code:
    | "SHOPIFY_PRODUCT_MAPPING_CONFLICT"
    | "SHOPIFY_PRODUCT_SKUS_SPLIT"
    | "SHOPIFY_BASE_SKU_SPLIT_ACROSS_PRODUCTS"
    | "SHOPIFY_VARIANT_INTERNAL_ONLY_CONFLICT"
    | "SHOPIFY_CANONICAL_MAPPING_PROJECTION_FAILED";
  source: "content_sync" | "multi_uom_sync";
  echelonProductId: number | null;
  echelonSku: string | null;
  existingShopifyProductId: string | null;
  incomingShopifyProductId: string;
  matchedEchelonProductIds?: number[];
  failureCode?: string;
  failureMessage?: string;
}

type ShopifyMappingOwner = Pick<ShopifyProductMappingService, "repair">;

export interface ProductImportDependencies {
  readonly mappingOwner?: ShopifyMappingOwner;
}

function emptyCanonicalMappingProjection(): ShopifyCanonicalMappingProjectionSummary {
  return {
    eligibleProducts: 0,
    attemptedProducts: 0,
    repairedProducts: 0,
    alreadyConsistentProducts: 0,
    failedProducts: 0,
    mappedVariants: 0,
  };
}

function buildVerifiedShopifyProducts(
  rows: readonly ShopifyCatalogProduct[],
): ReadonlyMap<string, VerifiedShopifyProduct> {
  const grouped = new Map<string, {
    title: string | null;
    variants: VerifiedShopifyProduct["variants"][number][];
  }>();
  for (const row of rows) {
    const productId = String(row.shopifyProductId);
    const current = grouped.get(productId) ?? {
      title: row.productTitle?.trim() || row.title?.trim() || null,
      variants: [],
    };
    current.variants.push({
      id: String(row.variantId),
      sku: row.sku?.trim() || null,
      inventoryItemId: row.inventoryItemId == null ? null : String(row.inventoryItemId),
      barcode: row.barcode?.trim() || null,
    });
    grouped.set(productId, current);
  }
  return new Map([...grouped.entries()].map(([productId, product]) => [
    productId,
    Object.freeze({
      id: productId,
      title: product.title,
      variants: Object.freeze([...product.variants]),
    }),
  ]));
}

function failureEvidence(error: unknown): { code: string; message: string } {
  const record = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown }
    : null;
  return {
    code: typeof record?.code === "string"
      ? record.code.slice(0, 100)
      : "SHOPIFY_MAPPING_PROJECTION_FAILED",
    message: typeof record?.message === "string"
      ? record.message.slice(0, 500)
      : "Canonical Shopify mapping projection failed",
  };
}

/**
 * Shopify owns whether a variant ships. Digital lines (gift cards, donations,
 * membership plans) must also be untracked to satisfy
 * product_variants_digital_untracked_chk, so the two travel together.
 */
function shippingFieldsFor(requiresShipping: boolean | undefined) {
  // Only an explicit false means digital. Unknown stays shippable so a partial
  // payload can never silently untrack a physical variant.
  return requiresShipping === false
    ? { requiresShipping: false, trackInventory: false }
    : { requiresShipping: true };
}

// SKU parsing pattern: BASE-SKU-[P|B|C]###
const VARIANT_PATTERN = /^(.+)-(P|B|C)(\d+)$/i;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createProductImportService(
  dependencies: ProductImportDependencies = {},
) {
  const mappingOwner = dependencies.mappingOwner ?? createShopifyProductMappingService();

  async function projectCanonicalMapping(input: {
    productId: number;
    productSku: string | null;
    shopifyProductId: string;
    verifiedShopifyProduct: VerifiedShopifyProduct;
    importedVariantBindings: readonly ImportedShopifyVariantBinding[];
    source: ShopifyImportMappingConflict["source"];
    actor: string;
    summary: ShopifyCanonicalMappingProjectionSummary;
    conflicts: ShopifyImportMappingConflict[];
  }): Promise<void> {
    input.summary.attemptedProducts += 1;
    try {
      const result = await mappingOwner.repair({
        productId: input.productId,
        targetProductId: input.shopifyProductId,
        actor: input.actor,
        verifiedShopifyProduct: input.verifiedShopifyProduct,
        importedVariantBindings: input.importedVariantBindings,
      });
      input.summary.mappedVariants += result.mappedVariantCount;
      if (result.alreadyConsistent) {
        input.summary.alreadyConsistentProducts += 1;
      } else {
        input.summary.repairedProducts += 1;
      }
    } catch (error: unknown) {
      input.summary.failedProducts += 1;
      const failure = failureEvidence(error);
      input.conflicts.push({
        code: "SHOPIFY_CANONICAL_MAPPING_PROJECTION_FAILED",
        source: input.source,
        echelonProductId: input.productId,
        echelonSku: input.productSku,
        existingShopifyProductId: input.shopifyProductId,
        incomingShopifyProductId: input.shopifyProductId,
        failureCode: failure.code,
        failureMessage: failure.message,
      });
      console.error(JSON.stringify({
        event: "shopify_canonical_mapping_projection_failed",
        source: input.source,
        productId: input.productId,
        shopifyProductId: input.shopifyProductId,
        errorCode: failure.code,
        errorMessage: failure.message,
      }));
    }
  }
  /**
   * Sync content fields + images from Shopify to existing Echelon products.
   * Matches by SKU or shopifyProductId. Does NOT create new products.
   */
  async function syncContentAndAssets(options: {
    projectCanonicalMappings?: boolean;
    shopifyProducts?: readonly ShopifyCatalogProduct[];
  } = {}): Promise<ContentSyncResult> {
    console.log("Starting Shopify catalog sync...");

    const shopifyProducts = options.shopifyProducts ?? await fetchShopifyCatalogProducts();
    const verifiedShopifyProducts = buildVerifiedShopifyProducts(shopifyProducts);
    const canonicalMappings = emptyCanonicalMappingProjection();
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
    const mappingConflicts: ShopifyImportMappingConflict[] = [];

    for (const [shopifyProductId, variants] of productGroups) {
      const firstVariant = variants[0];

      // A Shopify parent may be adopted only when every SKU resolves to the same
      // Echelon parent. Split SKU ownership is an operator conflict, not an
      // invitation to let the last matched SKU silently choose the parent.
      const matchedProducts = new Map<number, Awaited<ReturnType<typeof storage.getProductById>>>();
      const importedVariantBindings: ImportedShopifyVariantBinding[] = [];
      const internalOnlyMatches: Array<{ productId: number; sku: string }> = [];
      const mappedByShopifyId = await storage.getProductByShopifyProductId(String(shopifyProductId));
      if (mappedByShopifyId) matchedProducts.set(mappedByShopifyId.id, mappedByShopifyId);
      for (const variant of variants) {
        const importSku = resolveImportedVariantSku(variant);
        const pv = await storage.getProductVariantBySku(importSku);
        if (pv) {
          if (pv.salesEligibility === "internal_only") {
            internalOnlyMatches.push({ productId: pv.productId, sku: importSku });
            continue;
          }
          const matchedProduct = await storage.getProductById(pv.productId);
          if (matchedProduct) matchedProducts.set(matchedProduct.id, matchedProduct);
          importedVariantBindings.push({
            variantId: pv.id,
            remoteVariantId: variant.variantId,
          });
          variantsUpdated++;
        } else {
          skuNotFound++;
          unmatchedSkus.push(importSku);
        }
      }

      if (internalOnlyMatches.length > 0) {
        for (const conflict of internalOnlyMatches) {
          mappingConflicts.push({
            code: "SHOPIFY_VARIANT_INTERNAL_ONLY_CONFLICT",
            source: "content_sync",
            echelonProductId: conflict.productId,
            echelonSku: conflict.sku,
            existingShopifyProductId: null,
            incomingShopifyProductId: String(shopifyProductId),
          });
        }
        console.warn(JSON.stringify({
          event: "shopify_import_mapping_conflict",
          code: "SHOPIFY_VARIANT_INTERNAL_ONLY_CONFLICT",
          source: "content_sync",
          incomingShopifyProductId: String(shopifyProductId),
          variants: internalOnlyMatches,
        }));
        continue;
      }

      if (matchedProducts.size > 1) {
        const matchedEchelonProductIds = [...matchedProducts.keys()].sort((left, right) => left - right);
        mappingConflicts.push({
          code: "SHOPIFY_PRODUCT_SKUS_SPLIT",
          source: "content_sync",
          echelonProductId: null,
          echelonSku: null,
          existingShopifyProductId: null,
          incomingShopifyProductId: String(shopifyProductId),
          matchedEchelonProductIds,
        });
        console.warn(JSON.stringify({
          event: "shopify_import_mapping_conflict",
          code: "SHOPIFY_PRODUCT_SKUS_SPLIT",
          incomingShopifyProductId: String(shopifyProductId),
          matchedEchelonProductIds,
        }));
        continue;
      }

      const echelonProduct = [...matchedProducts.values()][0];

      if (echelonProduct) {
        const mappingDecision = decideImportedShopifyProductMapping(
          echelonProduct.shopifyProductId,
          shopifyProductId,
        );
        if (mappingDecision.action === "conflict") {
          mappingConflicts.push({
            code: "SHOPIFY_PRODUCT_MAPPING_CONFLICT",
            source: "content_sync",
            echelonProductId: echelonProduct.id,
            echelonSku: echelonProduct.sku,
            existingShopifyProductId: mappingDecision.existingProductId,
            incomingShopifyProductId: mappingDecision.incomingProductId,
          });
          console.warn(JSON.stringify({
            event: "shopify_import_mapping_conflict",
            code: "SHOPIFY_PRODUCT_MAPPING_CONFLICT",
            source: "content_sync",
            echelonProductId: echelonProduct.id,
            echelonSku: echelonProduct.sku,
            existingShopifyProductId: mappingDecision.existingProductId,
            incomingShopifyProductId: mappingDecision.incomingProductId,
          }));
          continue;
        }
        const productCategory = await resolveImportedProductCategory(firstVariant.productType);

        // Update content fields
        await storage.updateProduct(echelonProduct.id, {
          title: firstVariant.productTitle || firstVariant.title || undefined,
          description: firstVariant.description || undefined,
          brand: firstVariant.vendor || undefined,
          categoryId: productCategory.categoryId,
          category: productCategory.category,
          productType: resolveProductTypeSlug(firstVariant.productType, firstVariant.sku),
          tags: firstVariant.tags || undefined,
          status: firstVariant.status || undefined,
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
              const assetVariant = await storage.getProductVariantBySku(
                resolveImportedVariantSku(variant),
              );
              if (assetVariant) variantId = assetVariant.id;

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

          // TODO: Boundary cross — writes to product_locations (WMS table) directly instead of
          // routing through a warehouse/bin assignment service. Acceptable for now since
          // product_locations is configuration data (bin assignments), not transactional inventory.
          // When a bin assignment service exists, route through it instead.
          await storage.upsertProductLocationBySku(
            resolveImportedVariantSku(variant),
            variant.title,
            variant.status,
            undefined,
            variant.barcode || undefined,
          );
        }

        if (options.projectCanonicalMappings !== false) {
          const targetProductId = String(shopifyProductId);
          const verifiedShopifyProduct = verifiedShopifyProducts.get(targetProductId);
          canonicalMappings.eligibleProducts += 1;
          if (!verifiedShopifyProduct) {
            canonicalMappings.failedProducts += 1;
            mappingConflicts.push({
              code: "SHOPIFY_CANONICAL_MAPPING_PROJECTION_FAILED",
              source: "content_sync",
              echelonProductId: echelonProduct.id,
              echelonSku: echelonProduct.sku,
              existingShopifyProductId: mappingDecision.productId,
              incomingShopifyProductId: targetProductId,
              failureCode: "SHOPIFY_PRODUCT_SNAPSHOT_MISSING",
              failureMessage: "The fetched Shopify product snapshot was not retained for mapping projection",
            });
          } else {
            await projectCanonicalMapping({
              productId: echelonProduct.id,
              productSku: echelonProduct.sku,
              shopifyProductId: targetProductId,
              verifiedShopifyProduct,
              importedVariantBindings,
              source: "content_sync",
              actor: "system:shopify-content-sync",
              summary: canonicalMappings,
              conflicts: mappingConflicts,
            });
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
    console.log(JSON.stringify({
      event: "shopify_content_sync_completed",
      canonicalMappings,
      mappingConflictCount: mappingConflicts.length,
    }));

    return {
      success: canonicalMappings.failedProducts === 0 && mappingConflicts.length === 0,
      skuMatched: variantsUpdated,
      skuNotFound,
      unmatchedSkus: unmatchedSkus.slice(0, 50),
      productsUpdated,
      assets: assetsCreated,
      totalProducts: productGroups.size,
      totalVariants: shopifyProducts.length,
      canonicalMappings,
      mappingConflicts,
    };
  }

  /**
   * Full product/variant sync from Shopify with multi-UOM SKU parsing.
   * Parses SKU pattern: BASE-SKU-P50, BASE-SKU-B200, BASE-SKU-C700
   * P=Pack, B=Box, C=Case, number=units per variant.
   * Creates/updates products and product_variants.
   */
  async function syncProductsWithMultiUOM(options: {
    shopifyProducts?: readonly ShopifyCatalogProduct[];
  } = {}): Promise<ProductSyncResult> {
    console.log("Starting Shopify product sync to products/product_variants tables...");

    const shopifyProducts = options.shopifyProducts ?? await fetchShopifyCatalogProducts();
    const verifiedShopifyProducts = buildVerifiedShopifyProducts(shopifyProducts);
    const canonicalMappings = emptyCanonicalMappingProjection();
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
        requiresShipping: boolean;
      }>;
    }> = {};

    // Variants without the -P/-B/-C suffix (treated as single units)
    const standaloneVariants: Array<{
      sku: string;
      name: string;
      productTitle: string;
      sourceSkuMissing: boolean;
      shopifyProductId: number;
      shopifyVariantId: number;
      shopifyInventoryItemId: number | null;
      vendor: string | null;
      productType: string | null;
      description: string | null;
      barcode: string | null;
      imageUrl: string | null;
      requiresShipping: boolean;
      /**
       * Additional SKU-less variants of the SAME Shopify product. They become
       * variants of this product rather than products of their own — a graded
       * slab listing carries one row per serial, and each is a unit of one
       * sellable product, not a separate product.
       */
      siblingVariants?: Array<{
        sku: string;
        name: string;
        shopifyVariantId: number;
        shopifyInventoryItemId: number | null;
        barcode: string | null;
        requiresShipping: boolean;
      }>;
    }> = [];

    // SKU-less variants, grouped by their Shopify product so a listing with
    // several of them yields one Echelon product with several variants.
    type FallbackVariant = (typeof standaloneVariants)[number];
    const fallbackByShopifyProduct = new Map<number, FallbackVariant[]>();

    const mappingConflicts: ShopifyImportMappingConflict[] = [];
    const ambiguousBaseSkus = new Set<string>();

    for (const variant of shopifyProducts) {
      // SKU-less variants (sealed wax, graded singles) import under their
      // SHOPIFY-<variantId> fallback instead of being skipped.
      const importSku = resolveImportedVariantSku(variant);

      const match = importSku.match(VARIANT_PATTERN);

      if (match) {
        const baseSku = match[1];
        const variantType = match[2].toUpperCase();
        const unitsPerVariant = parseInt(match[3], 10);

        const existingGroup = baseSkuMap[baseSku];
        if (existingGroup && existingGroup.shopifyProductId !== variant.shopifyProductId) {
          ambiguousBaseSkus.add(baseSku);
          if (!mappingConflicts.some((conflict) =>
            conflict.code === "SHOPIFY_BASE_SKU_SPLIT_ACROSS_PRODUCTS" && conflict.echelonSku === baseSku
          )) {
            mappingConflicts.push({
              code: "SHOPIFY_BASE_SKU_SPLIT_ACROSS_PRODUCTS",
              source: "multi_uom_sync",
              echelonProductId: null,
              echelonSku: baseSku,
              existingShopifyProductId: String(existingGroup.shopifyProductId),
              incomingShopifyProductId: String(variant.shopifyProductId),
            });
          }
          continue;
        }

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
          sku: importSku,
          name: variant.variantTitle || `${variantType === 'P' ? 'Pack' : variantType === 'B' ? 'Box' : 'Case'} of ${unitsPerVariant}`,
          type: variantType === 'P' ? 'Pack' : variantType === 'B' ? 'Box' : 'Case',
          unitsPerVariant,
          shopifyVariantId: variant.variantId,
          shopifyInventoryItemId: variant.inventoryItemId,
          barcode: variant.barcode,
          imageUrl: variant.imageUrl,
          requiresShipping: variant.requiresShipping
        });
      } else {
        const entry: FallbackVariant = {
          sku: importSku,
          name: variant.title,
          productTitle: variant.productTitle || variant.title,
          sourceSkuMissing: !variant.sku?.trim(),
          shopifyProductId: variant.shopifyProductId,
          shopifyVariantId: variant.variantId,
          shopifyInventoryItemId: variant.inventoryItemId,
          vendor: variant.vendor,
          productType: variant.productType,
          description: variant.description,
          barcode: variant.barcode,
          imageUrl: variant.imageUrl,
          requiresShipping: variant.requiresShipping
        };
        if (variant.sku && variant.sku.trim()) {
          // A real SKU still owns its own product, exactly as before.
          standaloneVariants.push(entry);
        } else {
          const bucket = fallbackByShopifyProduct.get(variant.shopifyProductId) ?? [];
          bucket.push(entry);
          fallbackByShopifyProduct.set(variant.shopifyProductId, bucket);
        }
      }
    }

    // One Echelon product per Shopify product for SKU-less listings. The lowest
    // Shopify variant id is the representative so the product SKU is stable
    // across runs; the rest attach as sibling variants.
    let groupedFallbackVariants = 0;
    for (const bucket of fallbackByShopifyProduct.values()) {
      const ordered = [...bucket].sort((left, right) => left.shopifyVariantId - right.shopifyVariantId);
      const [representative, ...siblings] = ordered;
      if (siblings.length > 0) {
        representative.siblingVariants = siblings.map((sibling) => ({
          sku: sibling.sku,
          name: sibling.name,
          shopifyVariantId: sibling.shopifyVariantId,
          shopifyInventoryItemId: sibling.shopifyInventoryItemId,
          barcode: sibling.barcode,
          requiresShipping: sibling.requiresShipping,
        }));
        groupedFallbackVariants += siblings.length;
      }
      standaloneVariants.push(representative);
    }

    console.log(`Parsed: ${Object.keys(baseSkuMap).length} base SKUs with variants, ${standaloneVariants.length} standalone (${groupedFallbackVariants} SKU-less variants folded into a shared product)`);

    let productsCreated = 0;
    let productsUpdated = 0;
    let variantsCreated = 0;
    let variantsUpdated = 0;
    interface ProjectionCandidate {
      productId: number;
      productSku: string | null;
      importedVariantBindings: ImportedShopifyVariantBinding[];
    }
    const projectionOwnersByShopifyProductId = new Map<string, Map<number, ProjectionCandidate>>();
    const recordProjectionCandidate = (
      shopifyProductId: number,
      candidate: ProjectionCandidate,
    ): void => {
      const targetProductId = String(shopifyProductId);
      const owners = projectionOwnersByShopifyProductId.get(targetProductId) ?? new Map();
      const existing = owners.get(candidate.productId);
      if (existing) {
        existing.importedVariantBindings.push(...candidate.importedVariantBindings);
      } else {
        owners.set(candidate.productId, candidate);
      }
      projectionOwnersByShopifyProductId.set(targetProductId, owners);
    };
    const recordSkuSplitConflict = (input: {
      incomingShopifyProductId: number;
      echelonSku: string | null;
      matchedEchelonProductIds: number[];
      reason?: string;
    }): void => {
      const matchedEchelonProductIds = [...new Set(input.matchedEchelonProductIds)]
        .sort((left, right) => left - right);
      mappingConflicts.push({
        code: "SHOPIFY_PRODUCT_SKUS_SPLIT",
        source: "multi_uom_sync",
        echelonProductId: null,
        echelonSku: input.echelonSku,
        existingShopifyProductId: null,
        incomingShopifyProductId: String(input.incomingShopifyProductId),
        matchedEchelonProductIds,
      });
      console.warn(JSON.stringify({
        event: "shopify_import_mapping_conflict",
        code: "SHOPIFY_PRODUCT_SKUS_SPLIT",
        source: "multi_uom_sync",
        incomingShopifyProductId: String(input.incomingShopifyProductId),
        matchedEchelonProductIds,
        ...(input.reason ? { reason: input.reason } : {}),
      }));
    };

    // Process base SKUs with variants
    for (const [baseSku, data] of Object.entries(baseSkuMap)) {
      if (ambiguousBaseSkus.has(baseSku)) {
        console.warn(JSON.stringify({
          event: "shopify_import_mapping_conflict",
          code: "SHOPIFY_BASE_SKU_SPLIT_ACROSS_PRODUCTS",
          source: "multi_uom_sync",
          baseSku,
        }));
        continue;
      }
      const internalOnlyMatches: Array<{ productId: number; sku: string }> = [];
      for (const incomingVariant of data.variants) {
        const existingVariant = await storage.getProductVariantBySku(incomingVariant.sku);
        if (existingVariant?.salesEligibility === "internal_only") {
          internalOnlyMatches.push({
            productId: existingVariant.productId,
            sku: incomingVariant.sku,
          });
        }
      }
      if (internalOnlyMatches.length > 0) {
        for (const conflict of internalOnlyMatches) {
          mappingConflicts.push({
            code: "SHOPIFY_VARIANT_INTERNAL_ONLY_CONFLICT",
            source: "multi_uom_sync",
            echelonProductId: conflict.productId,
            echelonSku: conflict.sku,
            existingShopifyProductId: null,
            incomingShopifyProductId: String(data.shopifyProductId),
          });
        }
        console.warn(JSON.stringify({
          event: "shopify_import_mapping_conflict",
          code: "SHOPIFY_VARIANT_INTERNAL_ONLY_CONFLICT",
          source: "multi_uom_sync",
          incomingShopifyProductId: String(data.shopifyProductId),
          variants: internalOnlyMatches,
        }));
        continue;
      }
      let product = await storage.getProductBySku(baseSku);
      const productCategory = await resolveImportedProductCategory(data.productType);

      if (product) {
        const mappingDecision = decideImportedShopifyProductMapping(
          product.shopifyProductId,
          data.shopifyProductId,
        );
        if (mappingDecision.action === "conflict") {
          mappingConflicts.push({
            code: "SHOPIFY_PRODUCT_MAPPING_CONFLICT",
            source: "multi_uom_sync",
            echelonProductId: product.id,
            echelonSku: product.sku,
            existingShopifyProductId: mappingDecision.existingProductId,
            incomingShopifyProductId: mappingDecision.incomingProductId,
          });
          console.warn(JSON.stringify({
            event: "shopify_import_mapping_conflict",
            code: "SHOPIFY_PRODUCT_MAPPING_CONFLICT",
            source: "multi_uom_sync",
            echelonProductId: product.id,
            echelonSku: product.sku,
            existingShopifyProductId: mappingDecision.existingProductId,
            incomingShopifyProductId: mappingDecision.incomingProductId,
          }));
          continue;
        }
        await storage.updateProduct(product.id, {
          name: data.baseName,
          categoryId: productCategory.categoryId,
          category: productCategory.category,
          productType: resolveProductTypeSlug(data.productType, baseSku),
          brand: data.vendor,
          description: data.description,
        });
        productsUpdated++;
      } else {
        product = await storage.createProduct({
          sku: baseSku,
          name: data.baseName,
          categoryId: productCategory.categoryId,
          category: productCategory.category,
          productType: resolveProductTypeSlug(data.productType, baseSku),
          brand: data.vendor,
          description: data.description,
          baseUnit: 'EA',
        });
        productsCreated++;
      }

      let projectionBlocked = false;
      const importedVariantBindings: ImportedShopifyVariantBinding[] = [];
      for (const v of data.variants) {
        const hierarchyLevel = v.type === 'Pack' ? 1 : v.type === 'Box' ? 2 : 3;
        let variant = await storage.getProductVariantBySku(v.sku);

        if (variant) {
          // Guard: don't silently reassign variant to different product
          if (variant.productId !== product.id) {
            console.warn(`[PRODUCT IMPORT] SKU conflict: ${v.sku} exists on product_id=${variant.productId} but import wants product_id=${product.id} — skipping update`);
            projectionBlocked = true;
            mappingConflicts.push({
              code: "SHOPIFY_PRODUCT_SKUS_SPLIT",
              source: "multi_uom_sync",
              echelonProductId: null,
              echelonSku: v.sku,
              existingShopifyProductId: null,
              incomingShopifyProductId: String(data.shopifyProductId),
              matchedEchelonProductIds: [product.id, variant.productId].sort((left, right) => left - right),
            });
            continue;
          }
          await storage.updateProductVariant(variant.id, {
            ...shippingFieldsFor(v.requiresShipping),
            name: v.name,
            unitsPerVariant: v.unitsPerVariant,
            hierarchyLevel,
            barcode: v.barcode,
          });
          variantsUpdated++;
          importedVariantBindings.push({
            variantId: variant.id,
            remoteVariantId: v.shopifyVariantId,
          });
        } else {
          variant = await storage.createProductVariant({
            ...shippingFieldsFor(v.requiresShipping),
            productId: product.id,
            sku: v.sku,
            name: v.name,
            unitsPerVariant: v.unitsPerVariant,
            hierarchyLevel,
            barcode: v.barcode,
          });
          variantsCreated++;
          importedVariantBindings.push({
            variantId: variant.id,
            remoteVariantId: v.shopifyVariantId,
          });
        }
      }
      if (!projectionBlocked) {
        recordProjectionCandidate(data.shopifyProductId, {
          productId: product.id,
          productSku: product.sku,
          importedVariantBindings,
        });
      }
    }

    // Process standalone variants (no -P/-B/-C suffix)
    for (const sv of standaloneVariants) {
      const incomingVariants = [sv, ...(sv.siblingVariants ?? [])];
      type ExistingVariant = NonNullable<Awaited<ReturnType<typeof storage.getProductVariantBySku>>>;
      const existingVariantsBySku = new Map<string, ExistingVariant>();
      const internalOnlyMatches: Array<{ productId: number; sku: string }> = [];
      for (const incomingVariant of incomingVariants) {
        const catalogVariant = await storage.getProductVariantBySku(incomingVariant.sku);
        if (catalogVariant) existingVariantsBySku.set(incomingVariant.sku, catalogVariant);
        if (catalogVariant?.salesEligibility === "internal_only") {
          internalOnlyMatches.push({
            productId: catalogVariant.productId,
            sku: incomingVariant.sku,
          });
        }
      }
      if (internalOnlyMatches.length > 0) {
        for (const conflict of internalOnlyMatches) {
          mappingConflicts.push({
            code: "SHOPIFY_VARIANT_INTERNAL_ONLY_CONFLICT",
            source: "multi_uom_sync",
            echelonProductId: conflict.productId,
            echelonSku: conflict.sku,
            existingShopifyProductId: null,
            incomingShopifyProductId: String(sv.shopifyProductId),
          });
        }
        console.warn(JSON.stringify({
          event: "shopify_import_mapping_conflict",
          code: "SHOPIFY_VARIANT_INTERNAL_ONLY_CONFLICT",
          source: "multi_uom_sync",
          incomingShopifyProductId: String(sv.shopifyProductId),
          variants: internalOnlyMatches,
        }));
        continue;
      }

      const existingOwnerIds = [...new Set(
        [...existingVariantsBySku.values()].map((variant) => variant.productId),
      )].sort((left, right) => left - right);
      if (existingOwnerIds.length > 1) {
        recordSkuSplitConflict({
          incomingShopifyProductId: sv.shopifyProductId,
          echelonSku: sv.sku,
          matchedEchelonProductIds: existingOwnerIds,
        });
        continue;
      }

      const existingVariant = existingVariantsBySku.get(sv.sku) ?? null;
      let product = await storage.getProductBySku(sv.sku);
      const existingVariantOwner = existingOwnerIds.length === 1
        ? await storage.getProductById(existingOwnerIds[0])
        : null;

      if (existingOwnerIds.length === 1 && !existingVariantOwner) {
        recordSkuSplitConflict({
          incomingShopifyProductId: sv.shopifyProductId,
          echelonSku: sv.sku,
          matchedEchelonProductIds: existingOwnerIds,
          reason: "variant_owner_product_missing",
        });
        continue;
      }

      if (
        sv.sourceSkuMissing
        && product
        && existingVariantOwner
        && product.id !== existingVariantOwner.id
      ) {
        const ownerMappingDecision = decideImportedShopifyProductMapping(
          existingVariantOwner.shopifyProductId,
          sv.shopifyProductId,
        );
        if (ownerMappingDecision.action !== "retain") {
          const matchedEchelonProductIds = [product.id, existingVariantOwner.id]
            .sort((left, right) => left - right);
          recordSkuSplitConflict({
            incomingShopifyProductId: sv.shopifyProductId,
            echelonSku: sv.sku,
            matchedEchelonProductIds,
            reason: "sku_less_variant_owner_is_not_canonical",
          });
          continue;
        }
        product = existingVariantOwner;
      } else if (!product && existingVariantOwner) {
        product = existingVariantOwner;
      }

      const productCategory = await resolveImportedProductCategory(sv.productType);

      if (product) {
        const mappingDecision = decideImportedShopifyProductMapping(
          product.shopifyProductId,
          sv.shopifyProductId,
        );
        if (mappingDecision.action === "conflict") {
          mappingConflicts.push({
            code: "SHOPIFY_PRODUCT_MAPPING_CONFLICT",
            source: "multi_uom_sync",
            echelonProductId: product.id,
            echelonSku: product.sku,
            existingShopifyProductId: mappingDecision.existingProductId,
            incomingShopifyProductId: mappingDecision.incomingProductId,
          });
          console.warn(JSON.stringify({
            event: "shopify_import_mapping_conflict",
            code: "SHOPIFY_PRODUCT_MAPPING_CONFLICT",
            source: "multi_uom_sync",
            echelonProductId: product.id,
            echelonSku: product.sku,
            existingShopifyProductId: mappingDecision.existingProductId,
            incomingShopifyProductId: mappingDecision.incomingProductId,
          }));
          continue;
        }
        await storage.updateProduct(product.id, {
          name: sv.sourceSkuMissing ? sv.productTitle : sv.name,
          categoryId: productCategory.categoryId,
          category: productCategory.category,
          brand: sv.vendor,
          description: sv.description,
        });
        productsUpdated++;
      } else {
        product = await storage.createProduct({
          sku: sv.sku,
          name: sv.sourceSkuMissing ? sv.productTitle : sv.name,
          categoryId: productCategory.categoryId,
          category: productCategory.category,
          brand: sv.vendor,
          description: sv.description,
          baseUnit: 'EA',
        });
        productsCreated++;
      }

      let projectionBlocked = false;
      const importedVariantBindings: ImportedShopifyVariantBinding[] = [];
      let variant = existingVariant;

      if (variant) {
        if (variant.productId !== product.id) {
          console.warn(`[PRODUCT IMPORT] SKU conflict: ${sv.sku} exists on product_id=${variant.productId} but import wants product_id=${product.id} — skipping update`);
          mappingConflicts.push({
            code: "SHOPIFY_PRODUCT_SKUS_SPLIT",
            source: "multi_uom_sync",
            echelonProductId: null,
            echelonSku: sv.sku,
            existingShopifyProductId: null,
            incomingShopifyProductId: String(sv.shopifyProductId),
            matchedEchelonProductIds: [product.id, variant.productId].sort((left, right) => left - right),
          });
          continue;
        }
        await storage.updateProductVariant(variant.id, {
          ...shippingFieldsFor(sv.requiresShipping),
          name: 'Each',
          unitsPerVariant: 1,
          hierarchyLevel: 1,
          barcode: sv.barcode,
        });
        variantsUpdated++;
        importedVariantBindings.push({
          variantId: variant.id,
          remoteVariantId: sv.shopifyVariantId,
        });
      } else {
        variant = await storage.createProductVariant({
          ...shippingFieldsFor(sv.requiresShipping),
          productId: product.id,
          sku: sv.sku,
          name: 'Each',
          unitsPerVariant: 1,
          hierarchyLevel: 1,
          barcode: sv.barcode,
        });
        variantsCreated++;
        importedVariantBindings.push({
          variantId: variant.id,
          remoteVariantId: sv.shopifyVariantId,
        });
      }

      // Remaining SKU-less variants of the same Shopify product ride along as
      // variants instead of becoming duplicate products mapped to one Shopify id.
      for (const sibling of sv.siblingVariants ?? []) {
        const existingSibling = existingVariantsBySku.get(sibling.sku) ?? null;
        if (existingSibling) {
          if (existingSibling.productId !== product.id) {
            console.warn(`[PRODUCT IMPORT] SKU conflict: ${sibling.sku} exists on product_id=${existingSibling.productId} but import wants product_id=${product.id} — skipping update`);
            projectionBlocked = true;
            mappingConflicts.push({
              code: "SHOPIFY_PRODUCT_SKUS_SPLIT",
              source: "multi_uom_sync",
              echelonProductId: null,
              echelonSku: sibling.sku,
              existingShopifyProductId: null,
              incomingShopifyProductId: String(sv.shopifyProductId),
              matchedEchelonProductIds: [product.id, existingSibling.productId].sort((left, right) => left - right),
            });
            continue;
          }
          await storage.updateProductVariant(existingSibling.id, {
            ...shippingFieldsFor(sibling.requiresShipping),
            name: sibling.name,
            unitsPerVariant: 1,
            hierarchyLevel: 1,
            barcode: sibling.barcode,
          });
          variantsUpdated++;
          importedVariantBindings.push({
            variantId: existingSibling.id,
            remoteVariantId: sibling.shopifyVariantId,
          });
        } else {
          const createdSibling = await storage.createProductVariant({
            ...shippingFieldsFor(sibling.requiresShipping),
            productId: product.id,
            sku: sibling.sku,
            name: sibling.name,
            unitsPerVariant: 1,
            hierarchyLevel: 1,
            barcode: sibling.barcode,
          });
          variantsCreated++;
          importedVariantBindings.push({
            variantId: createdSibling.id,
            remoteVariantId: sibling.shopifyVariantId,
          });
        }
      }
      if (!projectionBlocked) {
        recordProjectionCandidate(sv.shopifyProductId, {
          productId: product.id,
          productSku: product.sku,
          importedVariantBindings,
        });
      }
    }

    for (const [shopifyProductId, owners] of projectionOwnersByShopifyProductId) {
      canonicalMappings.eligibleProducts += 1;
      if (owners.size !== 1) {
        const matchedEchelonProductIds = [...owners.keys()].sort((left, right) => left - right);
        canonicalMappings.failedProducts += 1;
        mappingConflicts.push({
          code: "SHOPIFY_PRODUCT_SKUS_SPLIT",
          source: "multi_uom_sync",
          echelonProductId: null,
          echelonSku: null,
          existingShopifyProductId: null,
          incomingShopifyProductId: shopifyProductId,
          matchedEchelonProductIds,
        });
        console.warn(JSON.stringify({
          event: "shopify_import_mapping_conflict",
          code: "SHOPIFY_PRODUCT_SKUS_SPLIT",
          source: "multi_uom_sync",
          incomingShopifyProductId: shopifyProductId,
          matchedEchelonProductIds,
        }));
        continue;
      }

      const candidate = [...owners.values()][0];
      const verifiedShopifyProduct = verifiedShopifyProducts.get(shopifyProductId);
      if (!verifiedShopifyProduct) {
        canonicalMappings.failedProducts += 1;
        mappingConflicts.push({
          code: "SHOPIFY_CANONICAL_MAPPING_PROJECTION_FAILED",
          source: "multi_uom_sync",
          echelonProductId: candidate.productId,
          echelonSku: candidate.productSku,
          existingShopifyProductId: null,
          incomingShopifyProductId: shopifyProductId,
          failureCode: "SHOPIFY_PRODUCT_SNAPSHOT_MISSING",
          failureMessage: "The fetched Shopify product snapshot was not retained for mapping projection",
        });
        continue;
      }

      await projectCanonicalMapping({
        productId: candidate.productId,
        productSku: candidate.productSku,
        shopifyProductId,
        verifiedShopifyProduct,
        importedVariantBindings: candidate.importedVariantBindings,
        source: "multi_uom_sync",
        actor: "system:shopify-product-sync",
        summary: canonicalMappings,
        conflicts: mappingConflicts,
      });
    }

    console.log(`Sync complete: products ${productsCreated} created/${productsUpdated} updated, variants ${variantsCreated} created/${variantsUpdated} updated`);
    console.log(JSON.stringify({
      event: "shopify_product_sync_completed",
      canonicalMappings,
      mappingConflictCount: mappingConflicts.length,
    }));

    return {
      success: canonicalMappings.failedProducts === 0 && mappingConflicts.length === 0,
      products: { created: productsCreated, updated: productsUpdated },
      variants: { created: variantsCreated, updated: variantsUpdated },
      baseSkusWithVariants: Object.keys(baseSkuMap).length,
      standaloneProducts: standaloneVariants.length,
      totalShopifyVariants: shopifyProducts.length,
      canonicalMappings,
      mappingConflicts,
    };
  }

  async function syncProductsAndContent(): Promise<ShopifyProductAndContentSyncResult> {
    // One provider snapshot owns the whole command. Fetching twice could map an
    // older identity set and then report content from a newer set as one sync.
    const shopifyProducts = await fetchShopifyCatalogProducts();
    const productResult = await syncProductsWithMultiUOM({ shopifyProducts });
    const contentResult = await syncContentAndAssets({
      projectCanonicalMappings: false,
      shopifyProducts,
    });
    return {
      ...productResult,
      success: productResult.success && contentResult.success,
      contentSync: {
        success: contentResult.success,
        productsUpdated: contentResult.productsUpdated,
        assets: contentResult.assets,
        skuMatched: contentResult.skuMatched,
        skuNotFound: contentResult.skuNotFound,
        mappingConflicts: contentResult.mappingConflicts,
      },
    };
  }

  return {
    syncContentAndAssets,
    syncProductsWithMultiUOM,
    syncProductsAndContent,
  };
}

export type ProductImportService = ReturnType<typeof createProductImportService>;
