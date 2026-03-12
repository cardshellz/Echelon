import {
  db,
  productLocations,
  warehouseLocations,
  eq,
  and,
  inArray,
  notInArray,
  sql,
} from "../../storage/base";
import type {
  ProductLocation,
  InsertProductLocation,
  UpdateProductLocation,
} from "../../storage/base";

export interface IProductLocationStorage {
  getAllProductLocations(): Promise<ProductLocation[]>;
  getProductLocationById(id: number): Promise<ProductLocation | undefined>;
  getProductLocationBySku(sku: string): Promise<ProductLocation | undefined>;
  getProductLocationByComposite(productId: number, warehouseLocationId: number): Promise<ProductLocation | undefined>;
  getBinLocationFromInventoryBySku(sku: string): Promise<{ location: string; zone: string; barcode: string | null; imageUrl: string | null } | undefined>;
  getProductLocationByProductId(productId: number): Promise<ProductLocation | undefined>;
  getProductLocationsByProductId(productId: number): Promise<ProductLocation[]>;
  getProductLocationsByWarehouseLocationId(warehouseLocationId: number): Promise<ProductLocation[]>;
  addProductToLocation(data: {
    productId: number;
    productVariantId?: number | null;
    warehouseLocationId: number;
    sku?: string | null;
    shopifyVariantId?: number | null;
    name: string;
    location: string;
    zone: string;
    isPrimary?: number;
    imageUrl?: string | null;
    barcode?: string | null;
  }): Promise<ProductLocation>;
  setPrimaryLocation(productLocationId: number): Promise<ProductLocation | undefined>;
  createProductLocation(location: InsertProductLocation): Promise<ProductLocation>;
  updateProductLocation(id: number, location: UpdateProductLocation): Promise<ProductLocation | undefined>;
  deleteProductLocation(id: number): Promise<boolean>;
  upsertProductLocationBySku(sku: string, name: string, status?: string, imageUrl?: string, barcode?: string): Promise<ProductLocation>;
  deleteProductLocationsBySku(skus: string[]): Promise<number>;
  deleteOrphanedSkus(validSkus: string[]): Promise<number>;
  getAllSkus(): Promise<string[]>;
}

export const productLocationMethods: IProductLocationStorage = {
  async getAllProductLocations(): Promise<ProductLocation[]> {
    return await db.select().from(productLocations).orderBy(productLocations.sku);
  },

  async getProductLocationById(id: number): Promise<ProductLocation | undefined> {
    const result = await db.select().from(productLocations).where(eq(productLocations.id, id));
    return result[0];
  },

  async getProductLocationBySku(sku: string): Promise<ProductLocation | undefined> {
    const result = await db.select().from(productLocations).where(eq(productLocations.sku, sku.toUpperCase()));
    return result[0];
  },

  async getBinLocationFromInventoryBySku(sku: string): Promise<{
    location: string;
    zone: string;
    barcode: string | null;
    imageUrl: string | null;
  } | undefined> {
    const assigned = await db.execute<{
      location_code: string;
      zone: string | null;
      barcode: string | null;
      image_url: string | null;
    }>(sql`
      SELECT
        pl.location as location_code,
        pl.zone,
        pv.barcode,
        pl.image_url
      FROM product_locations pl
      JOIN product_variants pv ON pv.id = pl.product_variant_id
      WHERE (UPPER(pv.sku) = ${sku.toUpperCase()} OR UPPER(pl.sku) = ${sku.toUpperCase()})
        AND pl.is_primary = 1
        AND pl.status = 'active'
      ORDER BY pl.updated_at DESC
      LIMIT 1
    `);

    if (assigned.rows.length > 0) {
      const row = assigned.rows[0];
      return {
        location: row.location_code,
        zone: row.zone || "U",
        barcode: row.barcode,
        imageUrl: row.image_url,
      };
    }

    const result = await db.execute<{
      location_code: string;
      zone: string | null;
      barcode: string | null;
      image_url: string | null;
    }>(sql`
      SELECT
        wl.code as location_code,
        wl.zone,
        pv.barcode,
        COALESCE(pva.url, pa.url) as image_url
      FROM product_variants pv
      JOIN inventory_levels il ON il.product_variant_id = pv.id
      JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
      LEFT JOIN product_assets pva ON pva.product_variant_id = pv.id AND pva.is_primary = 1
      LEFT JOIN product_assets pa ON pa.product_id = pv.product_id AND pa.product_variant_id IS NULL AND pa.is_primary = 1
      WHERE UPPER(pv.sku) = ${sku.toUpperCase()}
        AND il.variant_qty > 0
        AND wl.is_pickable = 1
      ORDER BY
        CASE wl.location_type
          WHEN 'pick' THEN 1
          WHEN 'reserve' THEN 2
          ELSE 3
        END,
        wl.is_pickable DESC,
        wl.zone ASC, wl.aisle ASC, wl.bay ASC, wl.level ASC, wl.bin ASC,
        il.variant_qty DESC
      LIMIT 1
    `);

    if (result.rows.length === 0) return undefined;

    const row = result.rows[0];
    return {
      location: row.location_code,
      zone: row.zone || "U",
      barcode: row.barcode,
      imageUrl: row.image_url,
    };
  },

  async getProductLocationByProductId(productId: number): Promise<ProductLocation | undefined> {
    const result = await db.select().from(productLocations).where(eq(productLocations.productId, productId));
    return result[0];
  },

  async getProductLocationsByProductId(productId: number): Promise<ProductLocation[]> {
    return await db.select().from(productLocations)
      .where(eq(productLocations.productId, productId))
      .orderBy(sql`${productLocations.isPrimary} DESC`);
  },

  async getProductLocationsByWarehouseLocationId(warehouseLocationId: number): Promise<ProductLocation[]> {
    return await db.select().from(productLocations)
      .where(eq(productLocations.warehouseLocationId, warehouseLocationId))
      .orderBy(productLocations.name);
  },

  async getProductLocationByComposite(productId: number, warehouseLocationId: number): Promise<ProductLocation | undefined> {
    const result = await db.select().from(productLocations)
      .where(and(
        eq(productLocations.productId, productId),
        eq(productLocations.warehouseLocationId, warehouseLocationId)
      ));
    return result[0];
  },

  async addProductToLocation(data: {
    productId: number;
    productVariantId?: number | null;
    warehouseLocationId: number;
    sku?: string | null;
    shopifyVariantId?: number | null;
    name: string;
    location: string;
    zone: string;
    isPrimary?: number;
    imageUrl?: string | null;
    barcode?: string | null;
  }): Promise<ProductLocation> {
    const [loc] = await db
      .select({ isPickable: warehouseLocations.isPickable })
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, data.warehouseLocationId))
      .limit(1);
    if (loc && loc.isPickable !== 1) {
      throw new Error(`Cannot assign products to non-pick location (id=${data.warehouseLocationId})`);
    }
    const existingByProduct = await db.select().from(productLocations)
      .where(eq(productLocations.productId, data.productId));

    if (existingByProduct.length > 0) {
      const existing = existingByProduct[0];
      const result = await db.update(productLocations)
        .set({
          productVariantId: data.productVariantId ?? existing.productVariantId,
          warehouseLocationId: data.warehouseLocationId,
          sku: data.sku?.toUpperCase() || existing.sku,
          shopifyVariantId: data.shopifyVariantId || existing.shopifyVariantId,
          name: data.name || existing.name,
          location: data.location.toUpperCase(),
          zone: data.zone.toUpperCase(),
          isPrimary: data.isPrimary ?? 1,
          imageUrl: data.imageUrl || existing.imageUrl,
          barcode: data.barcode || existing.barcode,
          updatedAt: new Date(),
        })
        .where(eq(productLocations.id, existing.id))
        .returning();
      return result[0];
    }

    if (data.sku) {
      const existingBySku = await db.select().from(productLocations)
        .where(eq(productLocations.sku, data.sku.toUpperCase()));

      if (existingBySku.length > 0) {
        const existing = existingBySku[0];
        const result = await db.update(productLocations)
          .set({
            productId: data.productId,
            productVariantId: data.productVariantId ?? existing.productVariantId,
            warehouseLocationId: data.warehouseLocationId,
            shopifyVariantId: data.shopifyVariantId || existing.shopifyVariantId,
            name: data.name || existing.name,
            location: data.location.toUpperCase(),
            zone: data.zone.toUpperCase(),
            isPrimary: data.isPrimary ?? 1,
            imageUrl: data.imageUrl || existing.imageUrl,
            barcode: data.barcode || existing.barcode,
            updatedAt: new Date(),
          })
          .where(eq(productLocations.id, existing.id))
          .returning();
        return result[0];
      }
    }

    if (data.isPrimary === 1) {
      await db.update(productLocations)
        .set({ isPrimary: 0, updatedAt: new Date() })
        .where(eq(productLocations.productId, data.productId));
    }

    const result = await db.insert(productLocations).values({
      productId: data.productId,
      productVariantId: data.productVariantId || null,
      warehouseLocationId: data.warehouseLocationId,
      sku: data.sku?.toUpperCase() || null,
      shopifyVariantId: data.shopifyVariantId || null,
      name: data.name,
      location: data.location.toUpperCase(),
      zone: data.zone.toUpperCase(),
      isPrimary: data.isPrimary ?? 1,
      status: "active",
      imageUrl: data.imageUrl || null,
      barcode: data.barcode || null,
    }).returning();
    return result[0];
  },

  async setPrimaryLocation(productLocationId: number): Promise<ProductLocation | undefined> {
    const location = await productLocationMethods.getProductLocationById(productLocationId);
    if (!location || !location.productId) return undefined;

    await db.update(productLocations)
      .set({ isPrimary: 0, updatedAt: new Date() })
      .where(eq(productLocations.productId, location.productId));
    
    const result = await db.update(productLocations)
      .set({ isPrimary: 1, updatedAt: new Date() })
      .where(eq(productLocations.id, productLocationId))
      .returning();
    return result[0];
  },

  async createProductLocation(location: InsertProductLocation): Promise<ProductLocation> {
    if (location.warehouseLocationId) {
      const [loc] = await db
        .select({ isPickable: warehouseLocations.isPickable })
        .from(warehouseLocations)
        .where(eq(warehouseLocations.id, location.warehouseLocationId))
        .limit(1);
      if (loc && loc.isPickable !== 1) {
        throw new Error(`Cannot assign products to non-pick location (id=${location.warehouseLocationId})`);
      }
    }
    const result = await db.insert(productLocations).values({
      ...location,
      sku: location.sku?.toUpperCase() || null,
      location: location.location.toUpperCase(),
      zone: location.zone.toUpperCase(),
    }).returning();
    return result[0];
  },

  async updateProductLocation(id: number, location: UpdateProductLocation): Promise<ProductLocation | undefined> {
    const updates: any = { ...location };
    if (updates.sku) updates.sku = updates.sku.toUpperCase();
    if (updates.location) updates.location = updates.location.toUpperCase();
    if (updates.zone) updates.zone = updates.zone.toUpperCase();
    updates.updatedAt = new Date();
    
    const result = await db
      .update(productLocations)
      .set(updates)
      .where(eq(productLocations.id, id))
      .returning();
    return result[0];
  },

  async deleteProductLocation(id: number): Promise<boolean> {
    const result = await db.delete(productLocations).where(eq(productLocations.id, id)).returning();
    return result.length > 0;
  },

  async upsertProductLocationBySku(sku: string, name: string, status?: string, imageUrl?: string, barcode?: string): Promise<ProductLocation> {
    const upperSku = sku.toUpperCase();
    const existing = await productLocationMethods.getProductLocationBySku(upperSku);
    
    if (existing) {
      const updates: any = { name, updatedAt: new Date() };
      if (status) updates.status = status;
      if (imageUrl !== undefined) updates.imageUrl = imageUrl;
      if (barcode !== undefined) updates.barcode = barcode || null;
      const result = await db
        .update(productLocations)
        .set(updates)
        .where(eq(productLocations.sku, upperSku))
        .returning();
      return result[0];
    } else {
      const result = await db.insert(productLocations).values({
        sku: upperSku,
        name,
        location: "UNASSIGNED",
        zone: "U",
        status: status || "active",
        imageUrl: imageUrl || null,
        barcode: barcode || null,
      }).returning();
      return result[0];
    }
  },

  async deleteProductLocationsBySku(skus: string[]): Promise<number> {
    if (skus.length === 0) return 0;
    const upperSkus = skus.map(s => s.toUpperCase());
    const result = await db.delete(productLocations)
      .where(inArray(productLocations.sku, upperSkus))
      .returning();
    return result.length;
  },

  async deleteOrphanedSkus(validSkus: string[]): Promise<number> {
    if (validSkus.length === 0) {
      const result = await db.delete(productLocations).returning();
      return result.length;
    }
    const upperSkus = validSkus.map(s => s.toUpperCase());
    const result = await db.delete(productLocations)
      .where(notInArray(productLocations.sku, upperSkus))
      .returning();
    return result.length;
  },

  async getAllSkus(): Promise<string[]> {
    const result = await db.select({ sku: productLocations.sku }).from(productLocations);
    return result.map(r => r.sku).filter((s): s is string => s !== null);
  },
};
