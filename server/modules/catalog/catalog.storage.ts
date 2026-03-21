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
  purchaseOrderLines,
  inboundShipmentLines,
  receivingLines,
  vendorInvoiceLines,
  orderItems,
  pickingLogs,
  orderItemFinancials,
  inventoryTransactions,
  eq,
  and,
  inArray,
  isNull,
  asc,
  sql,
} from "../../storage/base";
import type {
  Product,
  InsertProduct,
  ProductVariant,
  InsertProductVariant,
  InventoryLevel,
  ProductAsset,
  InsertProductAsset,
} from "../../storage/base";

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
  getProductVariantsByIds(ids: number[]): Promise<ProductVariant[]>;
  getProductsByIds(ids: number[]): Promise<Product[]>;
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

  getItemImageUrlBySku(sku: string): Promise<string | null>;

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

  getPrimaryProductAssets(): Promise<ProductAsset[]>;

  getProductInventoryByProductId(productId: number): Promise<Record<string, unknown>[]>;

  cascadeSkuRename(variantId: number, oldSku: string, newSku: string): Promise<void>;

  reassignInventoryLevelsToVariant(sourceVariantId: number, targetVariantId: number): Promise<number>;

  reassignProductLocationsToVariant(sourceVariantId: number, targetVariantId: number): Promise<number>;

  createMergeAuditTransaction(targetVariantId: number, sourceSku: string, sourceId: number, movedInventory: number, movedLocations: number): Promise<void>;

  searchCatalogProductsWithImage(searchPattern: string, limit: number): Promise<{
    product_id: number;
    variant_id: number;
    variant_sku: string;
    variant_name: string;
    product_sku: string | null;
    product_title: string | null;
    image_url: string | null;
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

  async getProductVariantsByIds(ids: number[]): Promise<ProductVariant[]> {
    if (ids.length === 0) return [];
    return db.select().from(productVariants).where(inArray(productVariants.id, ids));
  },

  async getProductsByIds(ids: number[]): Promise<Product[]> {
    if (ids.length === 0) return [];
    return db.select().from(products).where(inArray(products.id, ids));
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

  async getItemImageUrlBySku(sku: string): Promise<string | null> {
    const upperSku = sku.toUpperCase();
    const result = await db.execute<{ image_url: string | null }>(sql`
      SELECT image_url FROM (
        SELECT pl.image_url FROM product_locations pl
        WHERE UPPER(pl.sku) = ${upperSku} AND pl.image_url IS NOT NULL
        UNION ALL
        SELECT COALESCE(
          (SELECT pa.url FROM product_assets pa WHERE pa.product_variant_id = pv.id AND pa.is_primary = 1 LIMIT 1),
          (SELECT pa.url FROM product_assets pa WHERE pa.product_id = pv.product_id AND pa.product_variant_id IS NULL AND pa.is_primary = 1 LIMIT 1)
        ) as image_url
        FROM product_variants pv
        WHERE UPPER(pv.sku) = ${upperSku}
          AND EXISTS (SELECT 1 FROM product_assets pa WHERE (pa.product_variant_id = pv.id OR (pa.product_id = pv.product_id AND pa.product_variant_id IS NULL)) AND pa.is_primary = 1)
      ) sub
      LIMIT 1
    `);
    return result.rows[0]?.image_url || null;
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

  async getPrimaryProductAssets(): Promise<ProductAsset[]> {
    return await db.select().from(productAssets).where(eq(productAssets.isPrimary, 1));
  },

  async getProductInventoryByProductId(productId: number): Promise<Record<string, unknown>[]> {
    const result = await db.execute(sql`
      SELECT
        pv.id AS variant_id,
        pv.sku,
        pv.name AS variant_name,
        pv.hierarchy_level,
        pv.units_per_variant,
        pv.is_base_unit,
        il.id AS level_id,
        il.warehouse_location_id AS location_id,
        il.variant_qty,
        il.reserved_qty,
        il.picked_qty,
        COALESCE(il.packed_qty, 0) AS packed_qty,
        COALESCE(il.backorder_qty, 0) AS backorder_qty,
        il.updated_at AS level_updated_at,
        wl.code AS location_code,
        wl.location_type,
        wl.zone,
        wl.is_pickable,
        w.name AS warehouse_name
      FROM product_variants pv
      LEFT JOIN inventory_levels il ON il.product_variant_id = pv.id
      LEFT JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
      LEFT JOIN warehouses w ON w.id = wl.warehouse_id
      WHERE pv.product_id = ${productId}
      ORDER BY pv.hierarchy_level ASC, pv.sku ASC, wl.code ASC
    `);
    return result.rows as Record<string, unknown>[];
  },

  async cascadeSkuRename(variantId: number, oldSku: string, newSku: string): Promise<void> {
    const now = new Date();
    // Cross-system write: SKU rename cascades to OMS (order_items, order_item_financials),
    // WMS (picking_logs, product_locations), and Procurement tables. This is a data consistency
    // correction — SKU is a reference key across systems and must remain consistent. The
    // alternative (leaving stale SKUs) would break reporting, picks, and PO matching.
    // Tables with productVariantId FK — match by variant ID
    await db.update(purchaseOrderLines).set({ sku: newSku }).where(eq(purchaseOrderLines.productVariantId, variantId));
    await db.update(inboundShipmentLines).set({ sku: newSku, updatedAt: now }).where(eq(inboundShipmentLines.productVariantId, variantId));
    await db.update(receivingLines).set({ sku: newSku }).where(eq(receivingLines.productVariantId, variantId));
    await db.update(productLocations).set({ sku: newSku }).where(eq(productLocations.productVariantId, variantId));
    await db.update(vendorInvoiceLines).set({ sku: newSku, updatedAt: now }).where(eq(vendorInvoiceLines.productVariantId, variantId));

    // Tables without productVariantId FK — match by old SKU string
    await db.update(orderItems).set({ sku: newSku }).where(eq(orderItems.sku, oldSku));
    await db.update(pickingLogs).set({ sku: newSku }).where(eq(pickingLogs.sku, oldSku));
    await db.update(orderItemFinancials).set({ sku: newSku }).where(eq(orderItemFinancials.sku, oldSku));
  },

  async reassignInventoryLevelsToVariant(sourceVariantId: number, targetVariantId: number): Promise<number> {
    const result = await db.update(inventoryLevels)
      .set({ productVariantId: targetVariantId, updatedAt: new Date() })
      .where(eq(inventoryLevels.productVariantId, sourceVariantId))
      .returning();
    return result.length;
  },

  async reassignProductLocationsToVariant(sourceVariantId: number, targetVariantId: number): Promise<number> {
    const result = await db.update(productLocations)
      .set({ productVariantId: targetVariantId, updatedAt: new Date() })
      .where(eq(productLocations.productVariantId, sourceVariantId))
      .returning();
    return result.length;
  },

  async createMergeAuditTransaction(targetVariantId: number, sourceSku: string, sourceId: number, movedInventory: number, movedLocations: number): Promise<void> {
    await db.insert(inventoryTransactions).values({
      productVariantId: targetVariantId,
      transactionType: "adjustment",
      variantQtyDelta: 0,
      notes: `Merged from variant ${sourceSku || sourceId} (id=${sourceId}): ${movedInventory} inventory records, ${movedLocations} location assignments`,
    });
  },

  async searchCatalogProductsWithImage(searchPattern: string, limit: number): Promise<{
    product_id: number;
    variant_id: number;
    variant_sku: string;
    variant_name: string;
    product_sku: string | null;
    product_title: string | null;
    image_url: string | null;
  }[]> {
    const result = await db.execute<{
      product_id: number;
      variant_id: number;
      variant_sku: string;
      variant_name: string;
      product_sku: string | null;
      product_title: string | null;
      image_url: string | null;
    }>(sql`
      SELECT
        p.id as product_id,
        pv.id as variant_id,
        pv.sku as variant_sku,
        pv.name as variant_name,
        p.sku as product_sku,
        COALESCE(p.title, p.name) as product_title,
        (SELECT pa.url FROM product_assets pa WHERE pa.product_id = p.id AND pa.product_variant_id IS NULL AND pa.is_primary = 1 LIMIT 1) as image_url
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.is_active = true
        AND pv.sku IS NOT NULL
        AND (
          LOWER(pv.sku) LIKE ${searchPattern} OR
          LOWER(pv.name) LIKE ${searchPattern} OR
          LOWER(p.sku) LIKE ${searchPattern} OR
          LOWER(COALESCE(p.title, p.name)) LIKE ${searchPattern}
        )
      ORDER BY pv.sku
      LIMIT ${limit}
    `);
    return result.rows;
  },
};
