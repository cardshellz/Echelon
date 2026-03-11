import {
  db,
  products,
  productVariants,
  productAssets,
  productLocations,
  inventoryLevels,
  channelFeeds,
  replenRules,
  replenTasks,
  shipments,
  shipmentItems,
  warehouseLocations,
  eq,
  and,
  inArray,
  isNull,
  asc,
  sql,
} from "./base";
import type {
  Product,
  InsertProduct,
  ProductVariant,
  InsertProductVariant,
  InventoryLevel,
  ProductAsset,
  InsertProductAsset,
} from "./base";

export interface IProductStorage {
  getAllProducts(includeInactive?: boolean): Promise<Product[]>;
  getProductById(id: number): Promise<Product | undefined>;
  getProductBySku(sku: string): Promise<Product | undefined>;
  getProductByShopifyProductId(shopifyProductId: string): Promise<Product | undefined>;
  createProduct(product: InsertProduct): Promise<Product>;
  updateProduct(id: number, updates: Partial<InsertProduct>): Promise<Product | null>;
  deleteProduct(id: number): Promise<boolean>;

  getAllProductVariants(includeInactive?: boolean): Promise<ProductVariant[]>;
  getProductVariantById(id: number): Promise<ProductVariant | undefined>;
  getProductVariantBySku(sku: string): Promise<ProductVariant | undefined>;
  getActiveVariantBySku(sku: string, excludeId?: number): Promise<ProductVariant | undefined>;
  getProductVariantsByProductId(productId: number): Promise<ProductVariant[]>;
  createProductVariant(variant: InsertProductVariant): Promise<ProductVariant>;
  updateProductVariant(id: number, updates: Partial<InsertProductVariant>): Promise<ProductVariant | null>;
  deleteProductVariant(id: number): Promise<boolean>;

  getInventoryLevelsByVariantId(variantId: number): Promise<InventoryLevel[]>;
  deleteInventoryLevelsByVariantId(variantId: number): Promise<number>;
  deleteProductLocationsByVariantId(variantId: number): Promise<number>;
  deactivateChannelFeedsByVariantId(variantId: number): Promise<number>;
  deactivateReplenRulesByProductId(productId: number): Promise<number>;
  cancelReplenTasksByProductId(productId: number): Promise<number>;
  getPendingShipmentItemsByVariantIds(variantIds: number[]): Promise<{ id: number; shipmentId: number; productVariantId: number | null; qty: number; status: string }[]>;

  getProductAssetsByProductId(productId: number): Promise<ProductAsset[]>;
  getProductAssetsByVariantId(productVariantId: number): Promise<ProductAsset[]>;
  createProductAsset(asset: InsertProductAsset): Promise<ProductAsset>;
  deleteProductAsset(id: number): Promise<boolean>;
  deleteProductAssetsByProductId(productId: number): Promise<number>;
  updateProductAsset(id: number, updates: Partial<InsertProductAsset>): Promise<ProductAsset | null>;
  reorderProductAssets(productId: number, orderedIds: number[]): Promise<void>;
  setPrimaryProductAsset(productId: number, assetId: number): Promise<void>;

  getAllProductsWithLocations(): Promise<{
    id: number;
    productLocationId: number | null;
    shopifyProductId: string | null;
    sku: string | null;
    name: string;
    location: string | null;
    zone: string | null;
    warehouseLocationId: number | null;
    warehouseId: number | null;
    status: string;
    imageUrl: string | null;
    updatedAt: Date | null;
  }[]>;
  getProductsWithoutLocations(): Promise<{
    id: number;
    shopifyProductId: string | null;
    sku: string | null;
    title: string;
    imageUrl: string | null;
  }[]>;
}

export const productMethods: IProductStorage = {
  async getAllProducts(includeInactive = false): Promise<Product[]> {
    if (includeInactive) {
      return await db.select().from(products).orderBy(asc(products.name));
    }
    return await db.select().from(products).where(eq(products.isActive, true)).orderBy(asc(products.name));
  },

  async getProductById(id: number): Promise<Product | undefined> {
    const result = await db.select().from(products).where(eq(products.id, id));
    return result[0];
  },

  async getProductBySku(sku: string): Promise<Product | undefined> {
    const result = await db.select().from(products)
      .where(eq(products.sku, sku.toUpperCase()));
    return result[0];
  },

  async getProductByShopifyProductId(shopifyProductId: string): Promise<Product | undefined> {
    const result = await db.select().from(products).where(eq(products.shopifyProductId, shopifyProductId));
    return result[0];
  },

  async createProduct(product: InsertProduct): Promise<Product> {
    const result = await db.insert(products).values(product).returning();
    return result[0];
  },

  async updateProduct(id: number, updates: Partial<InsertProduct>): Promise<Product | null> {
    const result = await db.update(products)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteProduct(id: number): Promise<boolean> {
    const result = await db.delete(products).where(eq(products.id, id)).returning();
    return result.length > 0;
  },

  async getAllProductVariants(includeInactive = false): Promise<ProductVariant[]> {
    if (includeInactive) {
      return await db.select().from(productVariants).orderBy(asc(productVariants.sku));
    }
    return await db.select().from(productVariants).where(eq(productVariants.isActive, true)).orderBy(asc(productVariants.sku));
  },

  async getProductVariantById(id: number): Promise<ProductVariant | undefined> {
    const result = await db.select().from(productVariants).where(eq(productVariants.id, id));
    return result[0];
  },

  async getProductVariantBySku(sku: string): Promise<ProductVariant | undefined> {
    const result = await db.select().from(productVariants)
      .where(sql`UPPER(${productVariants.sku}) = ${sku.trim().toUpperCase()}`);
    return result[0];
  },

  async getActiveVariantBySku(sku: string, excludeId?: number): Promise<ProductVariant | undefined> {
    const upperSku = sku.trim().toUpperCase();
    const result = await db.select().from(productVariants)
      .where(sql`UPPER(${productVariants.sku}) = ${upperSku} AND ${productVariants.isActive} = true${excludeId ? sql` AND ${productVariants.id} != ${excludeId}` : sql``}`);
    return result[0];
  },

  async getProductVariantsByProductId(productId: number): Promise<ProductVariant[]> {
    return await db.select().from(productVariants)
      .where(eq(productVariants.productId, productId))
      .orderBy(asc(productVariants.hierarchyLevel));
  },

  async createProductVariant(variant: InsertProductVariant): Promise<ProductVariant> {
    const result = await db.insert(productVariants).values(variant).returning();
    return result[0];
  },

  async updateProductVariant(id: number, updates: Partial<InsertProductVariant>): Promise<ProductVariant | null> {
    const result = await db.update(productVariants)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(productVariants.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteProductVariant(id: number): Promise<boolean> {
    const result = await db.delete(productVariants).where(eq(productVariants.id, id)).returning();
    return result.length > 0;
  },

  async getInventoryLevelsByVariantId(variantId: number): Promise<InventoryLevel[]> {
    return db.select().from(inventoryLevels).where(eq(inventoryLevels.productVariantId, variantId));
  },

  async deleteInventoryLevelsByVariantId(variantId: number): Promise<number> {
    const result = await db.delete(inventoryLevels).where(eq(inventoryLevels.productVariantId, variantId)).returning();
    return result.length;
  },

  async deleteProductLocationsByVariantId(variantId: number): Promise<number> {
    const result = await db.delete(productLocations).where(eq(productLocations.productVariantId, variantId)).returning();
    return result.length;
  },

  async deactivateChannelFeedsByVariantId(variantId: number): Promise<number> {
    const result = await db.update(channelFeeds)
      .set({ isActive: 0, updatedAt: new Date() })
      .where(and(eq(channelFeeds.productVariantId, variantId), eq(channelFeeds.isActive, 1)))
      .returning();
    return result.length;
  },

  async deactivateReplenRulesByProductId(productId: number): Promise<number> {
    const result = await db.update(replenRules)
      .set({ isActive: 0 })
      .where(and(eq(replenRules.productId, productId), eq(replenRules.isActive, 1)))
      .returning();
    return result.length;
  },

  async cancelReplenTasksByProductId(productId: number): Promise<number> {
    const result = await db.update(replenTasks)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(and(eq(replenTasks.productId, productId), inArray(replenTasks.status, ["pending", "assigned", "in_progress"])))
      .returning();
    return result.length;
  },

  async getPendingShipmentItemsByVariantIds(variantIds: number[]): Promise<{ id: number; shipmentId: number; productVariantId: number | null; qty: number; status: string }[]> {
    if (variantIds.length === 0) return [];
    const result = await db.select({
      id: shipmentItems.id,
      shipmentId: shipmentItems.shipmentId,
      productVariantId: shipmentItems.productVariantId,
      qty: shipmentItems.qty,
      status: shipments.status,
    })
      .from(shipmentItems)
      .innerJoin(shipments, eq(shipmentItems.shipmentId, shipments.id))
      .where(and(
        inArray(shipmentItems.productVariantId, variantIds),
        inArray(shipments.status, ["pending", "packed"]),
      ));
    return result;
  },

  async getProductAssetsByProductId(productId: number): Promise<ProductAsset[]> {
    return await db.select().from(productAssets)
      .where(eq(productAssets.productId, productId))
      .orderBy(asc(productAssets.position));
  },

  async getProductAssetsByVariantId(productVariantId: number): Promise<ProductAsset[]> {
    return await db.select().from(productAssets)
      .where(eq(productAssets.productVariantId, productVariantId))
      .orderBy(asc(productAssets.position));
  },

  async createProductAsset(asset: InsertProductAsset): Promise<ProductAsset> {
    const result = await db.insert(productAssets).values(asset).returning();
    return result[0];
  },

  async deleteProductAsset(id: number): Promise<boolean> {
    const result = await db.delete(productAssets).where(eq(productAssets.id, id)).returning();
    return result.length > 0;
  },

  async deleteProductAssetsByProductId(productId: number): Promise<number> {
    const result = await db.delete(productAssets).where(eq(productAssets.productId, productId)).returning();
    return result.length;
  },

  async updateProductAsset(id: number, updates: Partial<InsertProductAsset>): Promise<ProductAsset | null> {
    const result = await db.update(productAssets)
      .set(updates)
      .where(eq(productAssets.id, id))
      .returning();
    return result[0] || null;
  },

  async reorderProductAssets(productId: number, orderedIds: number[]): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
      await db.update(productAssets)
        .set({ position: i })
        .where(and(eq(productAssets.id, orderedIds[i]), eq(productAssets.productId, productId)));
    }
  },

  async setPrimaryProductAsset(productId: number, assetId: number): Promise<void> {
    await db.update(productAssets)
      .set({ isPrimary: 0 })
      .where(and(eq(productAssets.productId, productId), eq(productAssets.isPrimary, 1)));
    await db.update(productAssets)
      .set({ isPrimary: 1 })
      .where(and(eq(productAssets.id, assetId), eq(productAssets.productId, productId)));
  },

  async getAllProductsWithLocations(): Promise<{
    id: number;
    productLocationId: number | null;
    shopifyProductId: string | null;
    sku: string | null;
    name: string;
    location: string | null;
    zone: string | null;
    warehouseLocationId: number | null;
    warehouseId: number | null;
    status: string;
    imageUrl: string | null;
    updatedAt: Date | null;
  }[]> {
    const result = await db
      .select({
        id: products.id,
        productLocationId: productLocations.id,
        shopifyProductId: products.shopifyProductId,
        sku: products.sku,
        name: sql<string>`COALESCE(${products.title}, ${products.name})`.as('name'),
        location: productLocations.location,
        zone: productLocations.zone,
        warehouseLocationId: productLocations.warehouseLocationId,
        warehouseId: warehouseLocations.warehouseId,
        status: sql<string>`COALESCE(${productLocations.status}, 'unassigned')`.as('status'),
        imageUrl: sql<string | null>`(SELECT url FROM product_assets WHERE product_id = ${products.id} AND product_variant_id IS NULL AND is_primary = 1 LIMIT 1)`.as('image_url'),
        updatedAt: productLocations.updatedAt,
      })
      .from(products)
      .leftJoin(productLocations, eq(products.id, productLocations.productId))
      .leftJoin(warehouseLocations, eq(productLocations.warehouseLocationId, warehouseLocations.id))
      .orderBy(sql`COALESCE(${products.title}, ${products.name})`);
    return result;
  },

  async getProductsWithoutLocations(): Promise<{
    id: number;
    shopifyProductId: string | null;
    sku: string | null;
    title: string;
    imageUrl: string | null;
  }[]> {
    const result = await db
      .select({
        id: products.id,
        shopifyProductId: products.shopifyProductId,
        sku: products.sku,
        title: sql<string>`COALESCE(${products.title}, ${products.name})`.as('title'),
        imageUrl: sql<string | null>`(SELECT url FROM product_assets WHERE product_id = ${products.id} AND product_variant_id IS NULL AND is_primary = 1 LIMIT 1)`.as('image_url'),
      })
      .from(products)
      .leftJoin(productLocations, eq(products.id, productLocations.productId))
      .where(isNull(productLocations.id))
      .orderBy(sql`COALESCE(${products.title}, ${products.name})`);
    return result;
  },
};
