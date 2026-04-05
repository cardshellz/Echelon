/**
 * Catalog Backfill Service
 *
 * One-time (or repeatable) import job that ensures all Shopify products and
 * variants are represented in Echelon's master catalog. Direction is always
 * Shopify → Echelon (READ from Shopify, WRITE to Echelon).
 *
 * This is the foundation — the allocation engine needs products to allocate
 * against, and the Shopify adapter needs external IDs mapped.
 *
 * Steps:
 *   1. Fetch all products from Shopify via REST API
 *   2. For each product, upsert into Echelon's products table
 *   3. For each variant, upsert into product_variants table
 *   4. Map Shopify product/variant IDs to Echelon IDs
 *   5. Create/update channel_feeds entries for inventory sync
 *   6. Create/update channel_listings entries for listing sync
 *   7. Backfill channel_pricing from current Shopify prices
 *   8. Backfill product_assets from Shopify images
 *
 * Safety: This ONLY reads from Shopify and writes to Echelon.
 * It never pushes anything back to Shopify.
 */

import { eq, and, sql, inArray } from "drizzle-orm";
import {
  products,
  productVariants,
  productAssets,
  channels,
  channelFeeds,
  channelListings,
  channelPricing,
  channelConnections,
  inventoryLevels,
  inventoryTransactions,
  warehouses,
  warehouseLocations,
  type Product,
  type ProductVariant,
  type Channel,
  type Warehouse,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  /** Channel ID for the Shopify channel in Echelon */
  channelId: number;
  /** If true, only log what would be done without making changes */
  dryRun?: boolean;
  /** If true, also backfill channel_pricing from Shopify prices */
  backfillPricing?: boolean;
  /** If true, also backfill product_assets from Shopify images */
  backfillAssets?: boolean;
  /** If true, backfill inventory levels from Shopify for variants missing Echelon inventory */
  backfillInventory?: boolean;
  /** If provided, only process products matching these Shopify product IDs */
  shopifyProductIds?: string[];
}

export interface BackfillResult {
  success: boolean;
  dryRun: boolean;
  products: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
  };
  variants: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
  };
  feeds: {
    created: number;
    updated: number;
  };
  listings: {
    created: number;
    updated: number;
  };
  pricing: {
    created: number;
    updated: number;
  };
  assets: {
    created: number;
  };
  inventory: {
    /** Variants that had no Echelon inventory — imported from Shopify */
    imported: number;
    /** Variants that already had Echelon inventory — skipped */
    skipped: number;
    /** Variants where Shopify had no inventory data */
    noShopifyData: number;
  };
  errors: string[];
  /** Products that were processed, with ID mappings */
  mappings: Array<{
    shopifyProductId: string;
    echelonProductId: number;
    variants: Array<{
      shopifyVariantId: string;
      echelonVariantId: number;
      sku: string | null;
    }>;
  }>;
  /** Reconciliation report: variants where both Echelon and Shopify have inventory */
  reconciliation: Array<{
    sku: string | null;
    echelonVariantId: number;
    echelonQty: number;
    shopifyQty: number;
    delta: number;
  }>;
}

interface ShopifyProductRaw {
  id: number;
  title: string;
  body_html: string | null;
  vendor: string | null;
  product_type: string | null;
  tags: string;
  status: string;
  variants: Array<{
    id: number;
    title: string;
    sku: string | null;
    price: string;
    compare_at_price: string | null;
    barcode: string | null;
    weight: number | null;
    weight_unit: string | null;
    inventory_item_id: number;
    position: number;
    option1: string | null;
    option2: string | null;
    option3: string | null;
  }>;
  images: Array<{
    id: number;
    src: string;
    alt: string | null;
    position: number;
    variant_ids: number[];
  }>;
  options: Array<{
    name: string;
    position: number;
    values: string[];
  }>;
}

// SKU parsing for multi-UOM: BASE-SKU-[P|B|C]###
const VARIANT_PATTERN = /^(.+)-(P|B|C)(\d+)$/i;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class CatalogBackfillService {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Run the full catalog backfill from Shopify to Echelon.
   */
  async run(options: BackfillOptions): Promise<BackfillResult> {
    const result: BackfillResult = {
      success: false,
      dryRun: options.dryRun ?? false,
      products: { total: 0, created: 0, updated: 0, skipped: 0 },
      variants: { total: 0, created: 0, updated: 0, skipped: 0 },
      feeds: { created: 0, updated: 0 },
      listings: { created: 0, updated: 0 },
      pricing: { created: 0, updated: 0 },
      assets: { created: 0 },
      inventory: { imported: 0, skipped: 0, noShopifyData: 0 },
      errors: [],
      mappings: [],
      reconciliation: [],
    };

    const isDryRun = options.dryRun ?? false;

    // Validate channel exists and is Shopify
    const [channel] = await this.db
      .select()
      .from(channels)
      .where(eq(channels.id, options.channelId))
      .limit(1);

    if (!channel) {
      result.errors.push(`Channel ${options.channelId} not found`);
      return result;
    }

    if (channel.provider !== "shopify") {
      result.errors.push(`Channel ${options.channelId} is provider "${channel.provider}", expected "shopify"`);
      return result;
    }

    console.log(`[CatalogBackfill] Starting ${isDryRun ? "DRY RUN" : "LIVE"} backfill for channel ${channel.name} (${options.channelId})`);

    // Fetch products from Shopify
    let shopifyProducts: ShopifyProductRaw[];
    try {
      shopifyProducts = await this.fetchShopifyProducts(options.channelId, options.shopifyProductIds);
    } catch (err: any) {
      result.errors.push(`Failed to fetch Shopify products: ${err.message}`);
      return result;
    }

    console.log(`[CatalogBackfill] Fetched ${shopifyProducts.length} products from Shopify`);
    result.products.total = shopifyProducts.length;

    // Process each Shopify product
    for (const shopifyProduct of shopifyProducts) {
      try {
        const mapping = await this.processProduct(
          shopifyProduct,
          options.channelId,
          isDryRun,
          result,
          options.backfillPricing ?? true,
          options.backfillAssets ?? true,
        );
        if (mapping) {
          result.mappings.push(mapping);
        }
      } catch (err: any) {
        result.errors.push(`Error processing Shopify product ${shopifyProduct.id}: ${err.message}`);
        console.error(`[CatalogBackfill] Error processing product ${shopifyProduct.id}:`, err.message);
      }
    }

    // --- Inventory Backfill ---
    const shouldBackfillInventory = options.backfillInventory ?? true;
    if (shouldBackfillInventory && !isDryRun && result.mappings.length > 0) {
      try {
        await this.backfillInventory(options.channelId, result);
      } catch (err: any) {
        result.errors.push(`Inventory backfill failed: ${err.message}`);
        console.error(`[CatalogBackfill] Inventory backfill error:`, err.message);
        console.error(`[CatalogBackfill] Inventory backfill stack:`, err.stack);
      }
    } else if (shouldBackfillInventory && isDryRun) {
      console.log(`[CatalogBackfill] Inventory backfill skipped (dry run)`);
    }

    result.success = result.errors.length === 0;
    console.log(
      `[CatalogBackfill] Complete: ${result.products.created} products created, ${result.products.updated} updated, ` +
      `${result.variants.created} variants created, ${result.variants.updated} updated, ` +
      `${result.feeds.created} feeds created, ${result.listings.created} listings created, ` +
      `${result.inventory.imported} inventory records imported, ${result.inventory.skipped} skipped (Echelon trusted), ` +
      `${result.errors.length} errors`,
    );

    // Log reconciliation report
    if (result.reconciliation.length > 0) {
      console.log(`[CatalogBackfill] === INVENTORY RECONCILIATION REPORT ===`);
      console.log(`[CatalogBackfill] Variants with inventory in BOTH Echelon and Shopify: ${result.reconciliation.length}`);
      for (const row of result.reconciliation) {
        const deltaStr = row.delta > 0 ? `+${row.delta}` : String(row.delta);
        console.log(
          `[CatalogBackfill]   SKU ${row.sku ?? "N/A"} (variant ${row.echelonVariantId}): ` +
          `Echelon=${row.echelonQty}, Shopify=${row.shopifyQty}, delta=${deltaStr}`,
        );
      }
      console.log(`[CatalogBackfill] === END RECONCILIATION REPORT ===`);
    }

    return result;
  }

  /**
   * Process a single Shopify product: upsert product, variants, feeds, listings, pricing, assets.
   */
  private async processProduct(
    shopifyProduct: ShopifyProductRaw,
    channelId: number,
    isDryRun: boolean,
    result: BackfillResult,
    backfillPricing: boolean,
    backfillAssets: boolean,
  ): Promise<BackfillResult["mappings"][0] | null> {
    const shopifyProductId = String(shopifyProduct.id);
    const tags = shopifyProduct.tags
      ? shopifyProduct.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    // Determine base SKU from variants
    let baseSku: string | null = null;
    const multiUomVariants: Array<{
      raw: typeof shopifyProduct.variants[0];
      baseSku: string;
      type: string;
      unitsPerVariant: number;
    }> = [];
    const standaloneVariants: Array<typeof shopifyProduct.variants[0]> = [];

    for (const v of shopifyProduct.variants) {
      const sku = v.sku?.trim()?.toUpperCase() || null;
      if (sku) {
        const match = sku.match(VARIANT_PATTERN);
        if (match) {
          baseSku = baseSku || match[1];
          multiUomVariants.push({
            raw: v,
            baseSku: match[1],
            type: match[2].toUpperCase(),
            unitsPerVariant: parseInt(match[3], 10),
          });
        } else {
          standaloneVariants.push(v);
          baseSku = baseSku || sku;
        }
      } else {
        standaloneVariants.push(v);
      }
    }

    // --- Upsert Product ---
    let echelonProduct: Product | null = null;

    // Try to find by shopifyProductId first
    const [existingByShopifyId] = await this.db
      .select()
      .from(products)
      .where(eq(products.shopifyProductId, shopifyProductId))
      .limit(1);

    // If not found by Shopify ID, try by base SKU
    let existingBySku: Product | undefined;
    if (!existingByShopifyId && baseSku) {
      const [found] = await this.db
        .select()
        .from(products)
        .where(eq(products.sku, baseSku))
        .limit(1);
      existingBySku = found;
    }

    const existing = existingByShopifyId || existingBySku;

    if (existing) {
      // Update existing product
      if (!isDryRun) {
        const [updated] = await this.db
          .update(products)
          .set({
            title: shopifyProduct.title,
            description: shopifyProduct.body_html,
            brand: shopifyProduct.vendor,
            category: shopifyProduct.product_type,
            tags: tags,
            status: shopifyProduct.status === "active" ? "active" : shopifyProduct.status === "draft" ? "draft" : "archived",
            shopifyProductId: shopifyProductId,
            updatedAt: new Date(),
          })
          .where(eq(products.id, existing.id))
          .returning();
        echelonProduct = updated;
      } else {
        echelonProduct = existing;
      }
      result.products.updated++;
      console.log(`[CatalogBackfill] Updated product: ${shopifyProduct.title} (Echelon ID ${existing.id})`);
    } else {
      // Create new product
      if (!isDryRun) {
        const [created] = await this.db
          .insert(products)
          .values({
            sku: baseSku,
            name: shopifyProduct.title,
            title: shopifyProduct.title,
            description: shopifyProduct.body_html,
            brand: shopifyProduct.vendor,
            category: shopifyProduct.product_type,
            tags: tags,
            status: shopifyProduct.status === "active" ? "active" : shopifyProduct.status === "draft" ? "draft" : "archived",
            shopifyProductId: shopifyProductId,
            baseUnit: "EA",
          })
          .returning();
        echelonProduct = created;
      } else {
        echelonProduct = { id: -1 } as Product; // Placeholder for dry run
      }
      result.products.created++;
      console.log(`[CatalogBackfill] Created product: ${shopifyProduct.title} (SKU: ${baseSku})`);
    }

    if (!echelonProduct) return null;

    // --- Upsert Variants ---
    const variantMappings: BackfillResult["mappings"][0]["variants"] = [];
    result.variants.total += shopifyProduct.variants.length;

    // Process multi-UOM variants
    for (const muv of multiUomVariants) {
      const mapping = await this.processVariant(
        echelonProduct.id,
        muv.raw,
        channelId,
        isDryRun,
        result,
        backfillPricing,
        muv.unitsPerVariant,
        muv.type === "P" ? 1 : muv.type === "B" ? 2 : 3,
      );
      if (mapping) variantMappings.push(mapping);
    }

    // Process standalone variants
    for (const sv of standaloneVariants) {
      const mapping = await this.processVariant(
        echelonProduct.id,
        sv,
        channelId,
        isDryRun,
        result,
        backfillPricing,
        1,
        1,
      );
      if (mapping) variantMappings.push(mapping);
    }

    // --- Backfill Assets ---
    if (backfillAssets && shopifyProduct.images.length > 0 && !isDryRun) {
      await this.backfillAssets(echelonProduct.id, shopifyProduct, variantMappings, result);
    }

    return {
      shopifyProductId: shopifyProductId,
      echelonProductId: echelonProduct.id,
      variants: variantMappings,
    };
  }

  /**
   * Process a single variant: upsert variant, feed, listing, pricing.
   */
  private async processVariant(
    productId: number,
    shopifyVariant: ShopifyProductRaw["variants"][0],
    channelId: number,
    isDryRun: boolean,
    result: BackfillResult,
    backfillPricing: boolean,
    unitsPerVariant: number,
    hierarchyLevel: number,
  ): Promise<BackfillResult["mappings"][0]["variants"][0] | null> {
    const shopifyVariantId = String(shopifyVariant.id);
    const shopifyInventoryItemId = String(shopifyVariant.inventory_item_id);
    const sku = shopifyVariant.sku?.trim()?.toUpperCase() || `SHOPIFY-${shopifyVariant.id}`;
    const priceCents = Math.round(parseFloat(shopifyVariant.price || "0") * 100);
    const compareAtPriceCents = shopifyVariant.compare_at_price
      ? Math.round(parseFloat(shopifyVariant.compare_at_price) * 100)
      : null;

    // Variant name from title
    const variantName = shopifyVariant.title !== "Default Title"
      ? shopifyVariant.title
      : unitsPerVariant > 1
        ? `Pack of ${unitsPerVariant}`
        : "Each";

    // Try to find existing variant by shopifyVariantId
    let echelonVariant: ProductVariant | null = null;
    const [existingByShopifyId] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.shopifyVariantId, shopifyVariantId))
      .limit(1);

    // If not found by Shopify ID, try by SKU
    let existingBySku: ProductVariant | undefined;
    if (!existingByShopifyId && sku) {
      const [found] = await this.db
        .select()
        .from(productVariants)
        .where(
          and(
            eq(productVariants.sku, sku),
            eq(productVariants.productId, productId),
          ),
        )
        .limit(1);
      existingBySku = found;
    }

    const existingVariant = existingByShopifyId || existingBySku;

    if (existingVariant) {
      if (!isDryRun) {
        const [updated] = await this.db
          .update(productVariants)
          .set({
            sku,
            name: variantName,
            barcode: shopifyVariant.barcode,
            priceCents,
            compareAtPriceCents,
            shopifyVariantId: shopifyVariantId,
            shopifyInventoryItemId: shopifyInventoryItemId,
            unitsPerVariant,
            hierarchyLevel,
            position: shopifyVariant.position,
            option1Value: shopifyVariant.option1,
            option2Value: shopifyVariant.option2,
            option3Value: shopifyVariant.option3,
            updatedAt: new Date(),
          })
          .where(eq(productVariants.id, existingVariant.id))
          .returning();
        echelonVariant = updated;
      } else {
        echelonVariant = existingVariant;
      }
      result.variants.updated++;
    } else {
      if (!isDryRun) {
        const [created] = await this.db
          .insert(productVariants)
          .values({
            productId,
            sku,
            name: variantName,
            barcode: shopifyVariant.barcode,
            priceCents,
            compareAtPriceCents,
            shopifyVariantId: shopifyVariantId,
            shopifyInventoryItemId: shopifyInventoryItemId,
            unitsPerVariant,
            hierarchyLevel,
            isBaseUnit: unitsPerVariant === 1,
            position: shopifyVariant.position,
            option1Value: shopifyVariant.option1,
            option2Value: shopifyVariant.option2,
            option3Value: shopifyVariant.option3,
          })
          .returning();
        echelonVariant = created;
      } else {
        echelonVariant = { id: -1, sku } as any;
      }
      result.variants.created++;
    }

    if (!echelonVariant) return null;

    // --- Upsert channel_feeds ---
    if (!isDryRun) {
      const [existingFeed] = await this.db
        .select()
        .from(channelFeeds)
        .where(
          and(
            eq(channelFeeds.channelId, channelId),
            eq(channelFeeds.productVariantId, echelonVariant.id),
          ),
        )
        .limit(1);

      if (existingFeed) {
        await this.db
          .update(channelFeeds)
          .set({
            channelVariantId: shopifyVariantId,
            channelSku: sku,
            isActive: 1,
            updatedAt: new Date(),
          })
          .where(eq(channelFeeds.id, existingFeed.id));
        result.feeds.updated++;
      } else {
        await this.db.insert(channelFeeds).values({
          channelId,
          productVariantId: echelonVariant.id,
          channelType: "shopify",
          channelVariantId: shopifyVariantId,
          channelSku: sku,
          isActive: 1,
        });
        result.feeds.created++;
      }

      // --- Upsert channel_listings ---
      const [existingListing] = await this.db
        .select()
        .from(channelListings)
        .where(
          and(
            eq(channelListings.channelId, channelId),
            eq(channelListings.productVariantId, echelonVariant.id),
          ),
        )
        .limit(1);

      if (existingListing) {
        await this.db
          .update(channelListings)
          .set({
            externalVariantId: shopifyVariantId,
            externalSku: sku,
            syncStatus: "synced",
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(channelListings.id, existingListing.id));
        result.listings.updated++;
      } else {
        // We need the Shopify product ID for the listing
        const [product] = await this.db
          .select({ shopifyProductId: products.shopifyProductId })
          .from(products)
          .where(eq(products.id, productId))
          .limit(1);

        await this.db.insert(channelListings).values({
          channelId,
          productVariantId: echelonVariant.id,
          externalProductId: product?.shopifyProductId || null,
          externalVariantId: shopifyVariantId,
          externalSku: sku,
          lastSyncedPrice: priceCents,
          syncStatus: "synced",
          lastSyncedAt: new Date(),
        });
        result.listings.created++;
      }

      // --- Backfill channel_pricing ---
      if (backfillPricing) {
        const [existingPricing] = await this.db
          .select()
          .from(channelPricing)
          .where(
            and(
              eq(channelPricing.channelId, channelId),
              eq(channelPricing.productVariantId, echelonVariant.id),
            ),
          )
          .limit(1);

        if (existingPricing) {
          await this.db
            .update(channelPricing)
            .set({
              price: priceCents,
              compareAtPrice: compareAtPriceCents,
              updatedAt: new Date(),
            })
            .where(eq(channelPricing.id, existingPricing.id));
          result.pricing.updated++;
        } else {
          await this.db.insert(channelPricing).values({
            channelId,
            productVariantId: echelonVariant.id,
            price: priceCents,
            compareAtPrice: compareAtPriceCents,
            currency: "USD",
          });
          result.pricing.created++;
        }
      }
    }

    return {
      shopifyVariantId,
      echelonVariantId: echelonVariant.id,
      sku,
    };
  }

  /**
   * Backfill product assets from Shopify images.
   */
  private async backfillAssets(
    productId: number,
    shopifyProduct: ShopifyProductRaw,
    variantMappings: BackfillResult["mappings"][0]["variants"],
    result: BackfillResult,
  ): Promise<void> {
    // Build variant ID lookup: shopifyVariantId → echelonVariantId
    const variantIdMap = new Map<number, number>();
    for (const m of variantMappings) {
      variantIdMap.set(Number(m.shopifyVariantId), m.echelonVariantId);
    }

    // Safety Check: Do not wipe Echelon's images if they already exist. Echelon is the source of truth.
    const existingAssets = await this.db.select().from(productAssets).where(eq(productAssets.productId, productId));
    if (existingAssets.length > 0) {
      return;
    }

    if (shopifyProduct.images.length === 0) {
      return;
    }

    for (const image of shopifyProduct.images) {
      // Determine variant linkage
      let variantId: number | null = null;
      if (image.variant_ids?.length === 1) {
        variantId = variantIdMap.get(image.variant_ids[0]) ?? null;
      }

      await this.db.insert(productAssets).values({
        productId,
        productVariantId: variantId,
        assetType: "image",
        url: image.src,
        altText: image.alt,
        position: image.position - 1, // Shopify is 1-based, Echelon is 0-based
        isPrimary: image.position === 1 ? 1 : 0,
      });
      result.assets.created++;
    }
  }

  // ---------------------------------------------------------------------------
  // Inventory Backfill
  // ---------------------------------------------------------------------------

  /**
   * Backfill inventory from Shopify for variants that have NO Echelon inventory records.
   *
   * For each variant in the mappings:
   *   - Check if inventoryLevels has ANY record for that productVariantId
   *   - If YES → skip (trust Echelon's count), but record for reconciliation
   *   - If NO → fetch Shopify inventory level and create an inventoryLevels record
   *
   * Safety: NEVER modifies existing Echelon inventory records.
   */
  private async backfillInventory(
    channelId: number,
    result: BackfillResult,
  ): Promise<void> {
    console.log(`[CatalogBackfill] Starting inventory backfill...`);

    // 1. Resolve default warehouse and location for new inventory records
    const defaultLocation = await this.resolveDefaultWarehouseLocation();
    if (!defaultLocation) {
      console.warn(`[CatalogBackfill] No default warehouse/location found — skipping inventory backfill`);
      result.errors.push("No default warehouse or pick location found for inventory backfill");
      return;
    }

    // 2. Collect all variant IDs and their Shopify inventory_item_ids
    const variantInfos: Array<{
      echelonVariantId: number;
      sku: string | null;
      shopifyInventoryItemId: string | null;
    }> = [];

    for (const mapping of result.mappings) {
      for (const v of mapping.variants) {
        // Look up the shopifyInventoryItemId from the variant record
        const [variant] = await this.db
          .select({
            id: productVariants.id,
            sku: productVariants.sku,
            shopifyInventoryItemId: productVariants.shopifyInventoryItemId,
          })
          .from(productVariants)
          .where(eq(productVariants.id, v.echelonVariantId))
          .limit(1);

        if (variant) {
          variantInfos.push({
            echelonVariantId: variant.id,
            sku: variant.sku,
            shopifyInventoryItemId: variant.shopifyInventoryItemId,
          });
        }
      }
    }

    if (variantInfos.length === 0) {
      console.log(`[CatalogBackfill] No variants to check for inventory backfill`);
      return;
    }

    // 3. Check which variants already have Echelon inventory
    const variantIds = variantInfos.map((v) => v.echelonVariantId);
    const existingInventory = await this.db
      .select({
        productVariantId: inventoryLevels.productVariantId,
        totalQty: sql<number>`SUM(${inventoryLevels.variantQty})`.as("total_qty"),
      })
      .from(inventoryLevels)
      .where(inArray(inventoryLevels.productVariantId, variantIds))
      .groupBy(inventoryLevels.productVariantId);

    const echelonInventoryMap = new Map<number, number>();
    for (const row of existingInventory) {
      echelonInventoryMap.set(row.productVariantId, Number(row.totalQty));
    }

    // 4. Determine which variants need Shopify inventory fetch
    const variantsNeedingImport: typeof variantInfos = [];
    const variantsWithEchelonInventory: typeof variantInfos = [];

    for (const vi of variantInfos) {
      if (echelonInventoryMap.has(vi.echelonVariantId)) {
        variantsWithEchelonInventory.push(vi);
        const echelonQty = echelonInventoryMap.get(vi.echelonVariantId)!;
        console.log(
          `[CatalogBackfill] Variant ${vi.sku ?? vi.echelonVariantId}: Echelon has inventory (${echelonQty} units), keeping`,
        );
      } else {
        variantsNeedingImport.push(vi);
      }
    }

    // 5. Fetch Shopify inventory levels for ALL variants (both for import and reconciliation)
    const allShopifyItemIds = variantInfos
      .filter((v) => v.shopifyInventoryItemId != null)
      .map((v) => v.shopifyInventoryItemId!);

    let shopifyInventoryMap = new Map<string, number>();
    if (allShopifyItemIds.length > 0) {
      shopifyInventoryMap = await this.fetchShopifyInventoryLevels(
        channelId,
        allShopifyItemIds,
      );
    }

    // 6. Import inventory for variants that have NO Echelon record
    for (const vi of variantsNeedingImport) {
      if (!vi.shopifyInventoryItemId) {
        console.warn(
          `[CatalogBackfill] Variant ${vi.sku ?? vi.echelonVariantId}: no shopifyInventoryItemId — cannot fetch Shopify level`,
        );
        result.inventory.noShopifyData++;
        continue;
      }

      const shopifyQty = shopifyInventoryMap.get(vi.shopifyInventoryItemId);
      if (shopifyQty === undefined) {
        console.warn(
          `[CatalogBackfill] Variant ${vi.sku ?? vi.echelonVariantId}: no Shopify inventory data returned`,
        );
        result.inventory.noShopifyData++;
        continue;
      }

      // Create inventory record in Echelon
      const qtyToImport = Math.max(0, shopifyQty); // Don't import negative quantities
      await this.db.insert(inventoryLevels).values({
        warehouseLocationId: defaultLocation.locationId,
        productVariantId: vi.echelonVariantId,
        variantQty: qtyToImport,
        reservedQty: 0,
        pickedQty: 0,
        packedQty: 0,
        backorderQty: 0,
      });

      // Log the transaction for audit trail
      await this.db.insert(inventoryTransactions).values({
        productVariantId: vi.echelonVariantId,
        toLocationId: defaultLocation.locationId,
        transactionType: "receipt",
        variantQtyDelta: qtyToImport,
        variantQtyBefore: 0,
        variantQtyAfter: qtyToImport,
        referenceType: "shopify_backfill",
        referenceId: `shopify-inv-item-${vi.shopifyInventoryItemId}`,
        notes: `Backfill from Shopify inventory level (${qtyToImport} units)`,
        userId: "system:catalog-backfill",
      });

      console.log(
        `[CatalogBackfill] Variant ${vi.sku ?? vi.echelonVariantId}: no Echelon inventory, importing Shopify level (${qtyToImport} units)`,
      );
      result.inventory.imported++;
    }

    // 7. Build reconciliation report for variants with BOTH Echelon and Shopify inventory
    for (const vi of variantsWithEchelonInventory) {
      const echelonQty = echelonInventoryMap.get(vi.echelonVariantId)!;

      if (!vi.shopifyInventoryItemId) {
        result.inventory.skipped++;
        continue;
      }

      const shopifyQty = shopifyInventoryMap.get(vi.shopifyInventoryItemId);
      if (shopifyQty === undefined) {
        result.inventory.skipped++;
        continue;
      }

      result.reconciliation.push({
        sku: vi.sku,
        echelonVariantId: vi.echelonVariantId,
        echelonQty,
        shopifyQty,
        delta: echelonQty - shopifyQty,
      });
      result.inventory.skipped++;
    }

    console.log(
      `[CatalogBackfill] Inventory backfill complete: ${result.inventory.imported} imported, ` +
      `${result.inventory.skipped} skipped (trusted Echelon), ${result.inventory.noShopifyData} no Shopify data, ` +
      `${result.reconciliation.length} reconciliation entries`,
    );
  }

  /**
   * Find the default warehouse and a suitable pick location for inventory backfill.
   * Returns the location ID to use for new inventory records.
   */
  private async resolveDefaultWarehouseLocation(): Promise<{
    warehouseId: number;
    locationId: number;
    shopifyLocationId: string | null;
  } | null> {
    // Find the default warehouse
    const [defaultWarehouse] = await this.db
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.isDefault, 1),
          eq(warehouses.isActive, 1),
        ),
      )
      .limit(1);

    if (!defaultWarehouse) {
      // Fall back to any active warehouse
      const [anyWarehouse] = await this.db
        .select()
        .from(warehouses)
        .where(eq(warehouses.isActive, 1))
        .limit(1);

      if (!anyWarehouse) return null;

      return this.findOrCreateDefaultLocation(anyWarehouse);
    }

    return this.findOrCreateDefaultLocation(defaultWarehouse);
  }

  /**
   * Find a default pick location within a warehouse, or create one.
   */
  private async findOrCreateDefaultLocation(
    warehouse: Warehouse,
  ): Promise<{
    warehouseId: number;
    locationId: number;
    shopifyLocationId: string | null;
  }> {
    // Look for a pick-type location in this warehouse
    const [pickLocation] = await this.db
      .select()
      .from(warehouseLocations)
      .where(
        and(
          eq(warehouseLocations.warehouseId, warehouse.id),
          eq(warehouseLocations.locationType, "pick"),
          eq(warehouseLocations.isActive, 1),
        ),
      )
      .limit(1);

    if (pickLocation) {
      return {
        warehouseId: warehouse.id,
        locationId: pickLocation.id,
        shopifyLocationId: warehouse.shopifyLocationId,
      };
    }

    // Look for any active location in this warehouse
    const [anyLocation] = await this.db
      .select()
      .from(warehouseLocations)
      .where(
        and(
          eq(warehouseLocations.warehouseId, warehouse.id),
          eq(warehouseLocations.isActive, 1),
        ),
      )
      .limit(1);

    if (anyLocation) {
      return {
        warehouseId: warehouse.id,
        locationId: anyLocation.id,
        shopifyLocationId: warehouse.shopifyLocationId,
      };
    }

    // Create a default virtual location for backfill
    const [newLocation] = await this.db
      .insert(warehouseLocations)
      .values({
        warehouseId: warehouse.id,
        code: "BACKFILL-DEFAULT",
        name: "Backfill Default Location",
        locationType: "pick",
        isActive: 1,
      })
      .returning();

    console.log(
      `[CatalogBackfill] Created default location BACKFILL-DEFAULT in warehouse ${warehouse.code} (ID ${warehouse.id})`,
    );

    return {
      warehouseId: warehouse.id,
      locationId: newLocation.id,
      shopifyLocationId: warehouse.shopifyLocationId,
    };
  }

  /**
   * Fetch inventory levels from Shopify for a batch of inventory item IDs.
   * Returns a map of inventoryItemId → total available quantity across all locations.
   *
   * Uses the Shopify Inventory Levels API with batched requests (max 50 items per request).
   */
  private async fetchShopifyInventoryLevels(
    channelId: number,
    inventoryItemIds: string[],
  ): Promise<Map<string, number>> {
    const conn = await this.getShopifyCredentials(channelId);
    const result = new Map<string, number>();
    const batchSize = 50; // Shopify allows up to 50 inventory_item_ids per request

    // Determine Shopify location ID (from default warehouse or env)
    let shopifyLocationId: string | null = null;

    // Try to get from warehouse config first
    const [defaultWarehouse] = await this.db
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.isDefault, 1),
          eq(warehouses.isActive, 1),
        ),
      )
      .limit(1);

    shopifyLocationId = defaultWarehouse?.shopifyLocationId ?? null;

    // Fall back to environment variable
    if (!shopifyLocationId) {
      shopifyLocationId = process.env.SHOPIFY_LOCATION_ID ?? null;
    }

    for (let i = 0; i < inventoryItemIds.length; i += batchSize) {
      const batch = inventoryItemIds.slice(i, i + batchSize);
      const idsParam = batch.join(",");

      let url: string;
      if (shopifyLocationId) {
        url = `/inventory_levels.json?inventory_item_ids=${idsParam}&location_ids=${shopifyLocationId}&limit=250`;
      } else {
        // Without location_id, Shopify returns levels for ALL locations — we sum them
        url = `/inventory_levels.json?inventory_item_ids=${idsParam}&limit=250`;
      }

      try {
        const data = await this.shopifyGet(conn, url);
        const levels = data?.inventory_levels || [];

        for (const level of levels) {
          const itemId = String(level.inventory_item_id);
          const available = level.available ?? 0;

          // If we specified a location, just set the value; otherwise sum across locations
          if (shopifyLocationId) {
            result.set(itemId, available);
          } else {
            const current = result.get(itemId) ?? 0;
            result.set(itemId, current + available);
          }
        }
      } catch (err: any) {
        console.error(
          `[CatalogBackfill] Failed to fetch Shopify inventory levels for batch starting at index ${i}: ${err.message}`,
        );
        // Continue with remaining batches — don't fail the entire backfill
      }

      // Rate limiting between batches
      if (i + batchSize < inventoryItemIds.length) {
        await this.delay(500);
      }
    }

    return result;
  }

  /**
   * Get Shopify credentials for API calls.
   */
  private async getShopifyCredentials(channelId: number): Promise<{
    shopDomain: string;
    accessToken: string;
    apiVersion: string;
  }> {
    const [conn] = await this.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.channelId, channelId))
      .limit(1);

    if (!conn?.shopDomain || !conn?.accessToken) {
      throw new Error(`No Shopify credentials for channel ${channelId}`);
    }

    return {
      shopDomain: conn.shopDomain,
      accessToken: conn.accessToken,
      apiVersion: conn.apiVersion || "2024-01",
    };
  }

  /**
   * Make a GET request to the Shopify Admin API.
   */
  private async shopifyGet(
    creds: { shopDomain: string; accessToken: string; apiVersion: string },
    path: string,
  ): Promise<any> {
    const baseUrl = `https://${creds.shopDomain}/admin/api/${creds.apiVersion}`;
    const url = path.startsWith("/") ? `${baseUrl}${path}` : `${baseUrl}/${path}`;

    const response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": creds.accessToken,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") || "2", 10);
      console.warn(`[CatalogBackfill] Rate limited on inventory fetch, waiting ${retryAfter}s`);
      await this.delay(retryAfter * 1000);
      // Retry once after waiting
      const retryResponse = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": creds.accessToken,
          "Content-Type": "application/json",
        },
      });
      if (!retryResponse.ok) {
        throw new Error(`Shopify API ${retryResponse.status} on retry: ${await retryResponse.text()}`);
      }
      return retryResponse.json();
    }

    if (!response.ok) {
      throw new Error(`Shopify API ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  /**
   * Fetch all products from Shopify via REST Admin API.
   * Handles pagination automatically.
   */
  private async fetchShopifyProducts(
    channelId: number,
    filterIds?: string[],
  ): Promise<ShopifyProductRaw[]> {
    // Get credentials from channel_connections
    const [conn] = await this.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.channelId, channelId))
      .limit(1);

    if (!conn?.shopDomain || !conn?.accessToken) {
      throw new Error(`No Shopify credentials for channel ${channelId}`);
    }

    const apiVersion = conn.apiVersion || "2024-01";
    const allProducts: ShopifyProductRaw[] = [];
    let pageInfo: string | null = null;

    do {
      let url: string;
      if (pageInfo) {
        url = `https://${conn.shopDomain}/admin/api/${apiVersion}/products.json?limit=250&page_info=${pageInfo}`;
      } else if (filterIds && filterIds.length > 0) {
        url = `https://${conn.shopDomain}/admin/api/${apiVersion}/products.json?limit=250&ids=${filterIds.join(",")}`;
      } else {
        url = `https://${conn.shopDomain}/admin/api/${apiVersion}/products.json?limit=250`;
      }

      const response = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": conn.accessToken,
          "Content-Type": "application/json",
        },
      });

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Retry-After") || "2", 10);
        console.warn(`[CatalogBackfill] Rate limited, waiting ${retryAfter}s`);
        await this.delay(retryAfter * 1000);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Shopify API ${response.status}: ${body}`);
      }

      const data = await response.json();
      allProducts.push(...(data.products || []));

      // Pagination via Link header
      pageInfo = null;
      const linkHeader = response.headers.get("Link");
      if (linkHeader) {
        const nextMatch = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
        if (nextMatch) {
          pageInfo = nextMatch[1];
        }
      }

      // Rate limiting between pages
      if (pageInfo) {
        await this.delay(500);
      }
    } while (pageInfo);

    return allProducts;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCatalogBackfillService(db: any) {
  return new CatalogBackfillService(db);
}

export type { CatalogBackfillService };
