import {
  db,
  warehouses,
  warehouseZones,
  warehouseLocations,
  fulfillmentRoutingRules,
  productLocations,
  echelonSettings,
  generateLocationCode,
  eq,
  and,
  asc,
  sql,
  inArray,
  notInArray,
} from "../../../storage/base";
import type {
  Warehouse, InsertWarehouse, WarehouseZone, InsertWarehouseZone,
  WarehouseLocation, InsertWarehouseLocation, FulfillmentRoutingRule, InsertFulfillmentRoutingRule,
  ProductLocation, InsertProductLocation, UpdateProductLocation, EchelonSetting
} from "../../../storage/base";

type Tx = typeof db | any;

// ==========================================
// WAREHOUSE SETTINGS
// ==========================================

export async function getAllSettings(tx: Tx = db): Promise<Record<string, string | null>> {
  const settings = await tx.select().from(echelonSettings);
  const result: Record<string, string | null> = {};
  for (const setting of settings) result[setting.key] = setting.value;
  return result;
}

export async function getSetting(key: string, tx: Tx = db): Promise<string | null> {
  try {
    const result = await tx.select().from(echelonSettings).where(eq(echelonSettings.key, key)).limit(1);
    return result[0]?.value ?? null;
  } catch (error) {
    return null;
  }
}

export async function upsertSetting(key: string, value: string | null, category?: string, tx: Tx = db): Promise<EchelonSetting | null> {
  try {
    const existing = await tx.select().from(echelonSettings).where(eq(echelonSettings.key, key)).limit(1);
    if (existing.length > 0) {
      const updated = await tx.update(echelonSettings).set({ value, updatedAt: new Date() }).where(eq(echelonSettings.key, key)).returning();
      return updated[0];
    }
    const inserted = await tx.insert(echelonSettings).values({
      key, value, type: "string",
      category: category || (key.startsWith("company_") ? "company" : key.startsWith("low_stock") || key.startsWith("critical_stock") ? "inventory" : key.startsWith("picking") || key.startsWith("auto_release") ? "picking" : "general"),
    }).returning();
    return inserted[0];
  } catch (error) {
    return null;
  }
}

// ==========================================
// WAREHOUSES & ZONES
// ==========================================

export async function getAllWarehouses(tx: Tx = db): Promise<Warehouse[]> {
  return await tx.select().from(warehouses).orderBy(asc(warehouses.name));
}

export async function getWarehouseById(id: number, tx: Tx = db): Promise<Warehouse | undefined> {
  const result = await tx.select().from(warehouses).where(eq(warehouses.id, id));
  return result[0];
}

export async function getWarehouseByCode(code: string, tx: Tx = db): Promise<Warehouse | undefined> {
  const result = await tx.select().from(warehouses).where(eq(warehouses.code, code.toUpperCase()));
  return result[0];
}

export async function createWarehouse(warehouse: InsertWarehouse, tx: Tx = db): Promise<Warehouse> {
  const result = await tx.insert(warehouses).values({ ...warehouse, code: warehouse.code.toUpperCase() }).returning();
  return result[0];
}

export async function updateWarehouse(id: number, updates: Partial<InsertWarehouse>, tx: Tx = db): Promise<Warehouse | null> {
  const result = await tx.update(warehouses)
    .set({ ...updates, code: updates.code ? updates.code.toUpperCase() : undefined, updatedAt: new Date() })
    .where(eq(warehouses.id, id)).returning();
  return result[0] || null;
}

export async function deleteWarehouse(id: number, tx: Tx = db): Promise<boolean> {
  const result = await tx.delete(warehouses).where(eq(warehouses.id, id)).returning();
  return result.length > 0;
}

export async function getAllWarehouseZones(tx: Tx = db): Promise<WarehouseZone[]> {
  return await tx.select().from(warehouseZones).orderBy(asc(warehouseZones.code));
}

export async function getWarehouseZoneByCode(code: string, tx: Tx = db): Promise<WarehouseZone | undefined> {
  const result = await tx.select().from(warehouseZones).where(eq(warehouseZones.code, code.toUpperCase()));
  return result[0];
}

export async function createWarehouseZone(zone: InsertWarehouseZone, tx: Tx = db): Promise<WarehouseZone> {
  const result = await tx.insert(warehouseZones).values({ ...zone, code: zone.code.toUpperCase() }).returning();
  return result[0];
}

export async function updateWarehouseZone(id: number, updates: Partial<InsertWarehouseZone>, tx: Tx = db): Promise<WarehouseZone | null> {
  const result = await tx.update(warehouseZones).set(updates).where(eq(warehouseZones.id, id)).returning();
  return result[0] || null;
}

export async function deleteWarehouseZone(id: number, tx: Tx = db): Promise<boolean> {
  const result = await tx.delete(warehouseZones).where(eq(warehouseZones.id, id)).returning();
  return result.length > 0;
}

export async function getAllWarehouseLocations(tx: Tx = db): Promise<WarehouseLocation[]> {
  return await tx.select().from(warehouseLocations).orderBy(asc(warehouseLocations.code));
}

export async function getWarehouseLocationById(id: number, tx: Tx = db): Promise<WarehouseLocation | undefined> {
  const result = await tx.select().from(warehouseLocations).where(eq(warehouseLocations.id, id));
  return result[0];
}

export async function getWarehouseLocationByCode(code: string, tx: Tx = db): Promise<WarehouseLocation | undefined> {
  const result = await tx.select().from(warehouseLocations).where(eq(warehouseLocations.code, code.toUpperCase()));
  return result[0];
}

export async function createWarehouseLocation(location: InsertWarehouseLocation | Omit<InsertWarehouseLocation, 'code'>, tx: Tx = db): Promise<WarehouseLocation> {
  const rawCode = ('code' in location && location.code) ? location.code : generateLocationCode(location as any);
  const code = rawCode.toUpperCase().trim();

  const conditions = [eq(warehouseLocations.code, code.toUpperCase())];
  if (location.warehouseId) conditions.push(eq(warehouseLocations.warehouseId, location.warehouseId));
  
  const [existing] = await tx.select().from(warehouseLocations).where(and(...conditions));
  if (existing) throw new Error(`Location code "${code}" already exists in this warehouse`);

  const result = await tx.insert(warehouseLocations).values({ ...location, code }).returning();
  return result[0];
}

export async function updateWarehouseLocation(id: number, updates: Partial<Omit<InsertWarehouseLocation, 'code'>>, tx: Tx = db): Promise<WarehouseLocation | null> {
  const existing = await getWarehouseLocationById(id, tx);
  if (!existing) return null;
  
  const merged = { ...existing, ...updates };
  const newCode = generateLocationCode(merged as any);
  
  if (newCode !== existing.code) {
    const whId = updates.warehouseId ?? existing.warehouseId;
    const conditions = [eq(warehouseLocations.code, newCode.toUpperCase())];
    if (whId) conditions.push(eq(warehouseLocations.warehouseId, whId));
    const [conflict] = await tx.select().from(warehouseLocations).where(and(...conditions));
    if (conflict && conflict.id !== id) throw new Error(`Location code "${newCode}" already exists in this warehouse`);
  }
  
  const result = await tx.update(warehouseLocations).set({ ...updates, code: newCode, updatedAt: new Date() }).where(eq(warehouseLocations.id, id)).returning();
  return result[0] || null;
}

export async function deleteWarehouseLocation(id: number, tx: Tx = db): Promise<boolean> {
  const result = await tx.delete(warehouseLocations).where(eq(warehouseLocations.id, id)).returning();
  return result.length > 0;
}

// ==========================================
// FULFILLMENT ROUTING
// ==========================================

export async function getAllFulfillmentRoutingRules(tx: Tx = db): Promise<FulfillmentRoutingRule[]> {
  return await tx.select().from(fulfillmentRoutingRules).orderBy(sql`priority DESC, id`);
}

export async function createFulfillmentRoutingRule(data: InsertFulfillmentRoutingRule, tx: Tx = db): Promise<FulfillmentRoutingRule> {
  const [rule] = await tx.insert(fulfillmentRoutingRules).values(data as any).returning();
  return rule;
}

export async function updateFulfillmentRoutingRule(id: number, data: Partial<InsertFulfillmentRoutingRule>, tx: Tx = db): Promise<FulfillmentRoutingRule | null> {
  const [rule] = await tx.update(fulfillmentRoutingRules).set({ ...data as any, updatedAt: new Date() }).where(eq(fulfillmentRoutingRules.id, id)).returning();
  return rule || null;
}

export async function deleteFulfillmentRoutingRule(id: number, tx: Tx = db): Promise<FulfillmentRoutingRule | null> {
  const [deleted] = await tx.delete(fulfillmentRoutingRules).where(eq(fulfillmentRoutingRules.id, id)).returning();
  return deleted || null;
}

// ==========================================
// PRODUCT BINS
// ==========================================

export async function getAllProductLocations(tx: Tx = db): Promise<ProductLocation[]> {
  return await tx.select().from(productLocations).orderBy(productLocations.sku);
}

export async function getProductLocationById(id: number, tx: Tx = db): Promise<ProductLocation | undefined> {
  const result = await tx.select().from(productLocations).where(eq(productLocations.id, id));
  return result[0];
}

export async function getProductLocationBySku(sku: string, tx: Tx = db): Promise<ProductLocation | undefined> {
  const result = await tx.select().from(productLocations).where(eq(productLocations.sku, sku.toUpperCase()));
  return result[0];
}

export async function getBinLocationFromInventoryBySku(sku: string, tx: Tx = db): Promise<{ location: string; zone: string; barcode: string | null; imageUrl: string | null } | undefined> {
  const assigned = await tx.execute(sql`
    SELECT pl.location as location_code, pl.zone, pv.barcode, pl.image_url
    FROM warehouse.product_locations pl
    JOIN catalog.product_variants pv ON pv.id = pl.product_variant_id
    WHERE (UPPER(pv.sku) = ${sku.toUpperCase()} OR UPPER(pl.sku) = ${sku.toUpperCase()})
      AND pl.is_primary = 1 AND pl.status = 'active'
    ORDER BY pl.updated_at DESC LIMIT 1
  `);

  if (assigned.rows.length > 0) {
    const row = assigned.rows[0] as any;
    return { location: row.location_code, zone: row.zone || "U", barcode: row.barcode, imageUrl: row.image_url };
  }

  const result = await tx.execute(sql`
    SELECT wl.code as location_code, wl.zone, pv.barcode, COALESCE(pva.url, pa.url) as image_url
    FROM catalog.product_variants pv
    JOIN inventory.inventory_levels il ON il.product_variant_id = pv.id
    JOIN warehouse.warehouse_locations wl ON il.warehouse_location_id = wl.id
    LEFT JOIN catalog.product_assets pva ON pva.product_variant_id = pv.id AND pva.is_primary = 1
    LEFT JOIN catalog.product_assets pa ON pa.product_id = pv.product_id AND pa.product_variant_id IS NULL AND pa.is_primary = 1
    WHERE UPPER(pv.sku) = ${sku.toUpperCase()} AND wl.is_pickable = 1
    ORDER BY CASE wl.location_type WHEN 'pick' THEN 1 WHEN 'reserve' THEN 2 ELSE 3 END,
      wl.is_pickable DESC, wl.zone ASC, wl.aisle ASC, wl.bay ASC, wl.level ASC, wl.bin ASC, il.variant_qty DESC LIMIT 1
  `);

  if (result.rows.length === 0) return undefined;
  const row = result.rows[0] as any;
  return { location: row.location_code, zone: row.zone || "U", barcode: row.barcode, imageUrl: row.image_url };
}

export async function getProductLocationByProductId(productId: number, tx: Tx = db): Promise<ProductLocation | undefined> {
  const result = await tx.select().from(productLocations).where(eq(productLocations.productId, productId));
  return result[0];
}

export async function getProductLocationsByProductId(productId: number, tx: Tx = db): Promise<ProductLocation[]> {
  return await tx.select().from(productLocations).where(eq(productLocations.productId, productId)).orderBy(sql`${productLocations.isPrimary} DESC`);
}

export async function getProductLocationsByWarehouseLocationId(warehouseLocationId: number, tx: Tx = db): Promise<ProductLocation[]> {
  return await tx.select().from(productLocations).where(eq(productLocations.warehouseLocationId, warehouseLocationId)).orderBy(productLocations.name);
}

export async function getProductLocationByComposite(productId: number, warehouseLocationId: number, tx: Tx = db): Promise<ProductLocation | undefined> {
  const result = await tx.select().from(productLocations).where(and(eq(productLocations.productId, productId), eq(productLocations.warehouseLocationId, warehouseLocationId)));
  return result[0];
}

export async function addProductToLocation(data: {
  productId: number; productVariantId?: number | null; warehouseLocationId: number;
  sku?: string | null; shopifyVariantId?: number | null; name: string;
  location: string; zone: string; isPrimary?: number; imageUrl?: string | null; barcode?: string | null;
}, tx: Tx = db): Promise<ProductLocation> {
  const [loc] = await tx.select({ isPickable: warehouseLocations.isPickable }).from(warehouseLocations).where(eq(warehouseLocations.id, data.warehouseLocationId)).limit(1);
  if (loc && loc.isPickable !== 1) throw new Error(`Cannot assign products to non-pick location`);

  const existingByProduct = await tx.select().from(productLocations).where(eq(productLocations.productId, data.productId));
  if (existingByProduct.length > 0) {
    const existing = existingByProduct[0];
    const result = await tx.update(productLocations).set({
      productVariantId: data.productVariantId ?? existing.productVariantId,
      warehouseLocationId: data.warehouseLocationId, sku: data.sku?.toUpperCase() || existing.sku,
      shopifyVariantId: data.shopifyVariantId || existing.shopifyVariantId, name: data.name || existing.name,
      location: data.location.toUpperCase(), zone: data.zone.toUpperCase(), isPrimary: data.isPrimary ?? 1,
      imageUrl: data.imageUrl || existing.imageUrl, barcode: data.barcode || existing.barcode, updatedAt: new Date(),
    }).where(eq(productLocations.id, existing.id)).returning();
    return result[0];
  }

  if (data.sku) {
    const existingBySku = await tx.select().from(productLocations).where(eq(productLocations.sku, data.sku.toUpperCase()));
    if (existingBySku.length > 0) {
      const existing = existingBySku[0];
      const result = await tx.update(productLocations).set({
        productId: data.productId, productVariantId: data.productVariantId ?? existing.productVariantId,
        warehouseLocationId: data.warehouseLocationId, shopifyVariantId: data.shopifyVariantId || existing.shopifyVariantId,
        name: data.name || existing.name, location: data.location.toUpperCase(), zone: data.zone.toUpperCase(),
        isPrimary: data.isPrimary ?? 1, imageUrl: data.imageUrl || existing.imageUrl, barcode: data.barcode || existing.barcode, updatedAt: new Date(),
      }).where(eq(productLocations.id, existing.id)).returning();
      return result[0];
    }
  }

  if (data.isPrimary === 1) {
    await tx.update(productLocations).set({ isPrimary: 0, updatedAt: new Date() }).where(eq(productLocations.productId, data.productId));
  }

  const result = await tx.insert(productLocations).values({
    productId: data.productId, productVariantId: data.productVariantId || null,
    warehouseLocationId: data.warehouseLocationId, sku: data.sku?.toUpperCase() || null,
    shopifyVariantId: data.shopifyVariantId || null, name: data.name,
    location: data.location.toUpperCase(), zone: data.zone.toUpperCase(),
    isPrimary: data.isPrimary ?? 1, status: "active", imageUrl: data.imageUrl || null, barcode: data.barcode || null,
  }).returning();
  return result[0];
}

export async function setPrimaryLocation(productLocationId: number, tx: Tx = db): Promise<ProductLocation | undefined> {
  const location = await getProductLocationById(productLocationId, tx);
  if (!location || !location.productId) return undefined;

  await tx.update(productLocations).set({ isPrimary: 0, updatedAt: new Date() }).where(eq(productLocations.productId, location.productId));
  const result = await tx.update(productLocations).set({ isPrimary: 1, updatedAt: new Date() }).where(eq(productLocations.id, productLocationId)).returning();
  return result[0];
}

export async function createProductLocation(location: InsertProductLocation, tx: Tx = db): Promise<ProductLocation> {
  if (location.warehouseLocationId) {
    const [loc] = await tx.select({ isPickable: warehouseLocations.isPickable }).from(warehouseLocations).where(eq(warehouseLocations.id, location.warehouseLocationId)).limit(1);
    if (loc && loc.isPickable !== 1) throw new Error(`Cannot assign products to non-pick location`);
  }
  const result = await tx.insert(productLocations).values({
    ...location, sku: location.sku?.toUpperCase() || null, location: location.location.toUpperCase(), zone: location.zone.toUpperCase(),
  }).returning();
  return result[0];
}

export async function updateProductLocation(id: number, location: UpdateProductLocation, tx: Tx = db): Promise<ProductLocation | undefined> {
  const updates: any = { ...location };
  if (updates.sku) updates.sku = updates.sku.toUpperCase();
  if (updates.location) updates.location = updates.location.toUpperCase();
  if (updates.zone) updates.zone = updates.zone.toUpperCase();
  updates.updatedAt = new Date();
  
  const result = await tx.update(productLocations).set(updates).where(eq(productLocations.id, id)).returning();
  return result[0];
}

export async function deleteProductLocation(id: number, tx: Tx = db): Promise<boolean> {
  const result = await tx.delete(productLocations).where(eq(productLocations.id, id)).returning();
  return result.length > 0;
}

export async function upsertProductLocationBySku(sku: string, name: string, status?: string, imageUrl?: string, barcode?: string, tx: Tx = db): Promise<ProductLocation> {
  const upperSku = sku.toUpperCase();
  const existing = await getProductLocationBySku(upperSku, tx);
  
  if (existing) {
    const updates: any = { name, updatedAt: new Date() };
    if (status) updates.status = status;
    if (imageUrl !== undefined) updates.imageUrl = imageUrl;
    if (barcode !== undefined) updates.barcode = barcode || null;
    const result = await tx.update(productLocations).set(updates).where(eq(productLocations.sku, upperSku)).returning();
    return result[0];
  } else {
    const result = await tx.insert(productLocations).values({
      sku: upperSku, name, location: "UNASSIGNED", zone: "U", status: status || "active", imageUrl: imageUrl || null, barcode: barcode || null,
    }).returning();
    return result[0];
  }
}

export async function deleteProductLocationsBySku(skus: string[], tx: Tx = db): Promise<number> {
  if (skus.length === 0) return 0;
  const upperSkus = skus.map(s => s.toUpperCase());
  const result = await tx.delete(productLocations).where(inArray(productLocations.sku, upperSkus)).returning();
  return result.length;
}

export async function deleteOrphanedSkus(validSkus: string[], tx: Tx = db): Promise<number> {
  if (validSkus.length === 0) {
    const result = await tx.delete(productLocations).returning();
    return result.length;
  }
  const upperSkus = validSkus.map(s => s.toUpperCase());
  const result = await tx.delete(productLocations).where(notInArray(productLocations.sku, upperSkus)).returning();
  return result.length;
}

export async function getAllSkus(tx: Tx = db): Promise<string[]> {
  const result = await tx.select({ sku: productLocations.sku }).from(productLocations);
  return result.map((r: any) => r.sku).filter((s: string|null): s is string => s !== null);
}

// ==========================================
// BIN AGGREGATE
// ==========================================

export async function getSkusByWarehouseLocation(tx: Tx = db): Promise<Map<number, string>> {
  const result = await tx.execute(sql`
    SELECT warehouse_location_id, STRING_AGG(sku, ', ' ORDER BY is_primary DESC, sku) as skus
    FROM warehouse.product_locations WHERE sku IS NOT NULL GROUP BY warehouse_location_id
  `);
  const map = new Map<number, string>();
  for (const row of result.rows as any[]) {
    if (row.warehouse_location_id && row.skus) map.set(row.warehouse_location_id, row.skus);
  }
  return map;
}

export async function hasProductsAssignedToLocation(warehouseLocationId: number, tx: Tx = db): Promise<boolean> {
  const result = await tx.select({ id: productLocations.id }).from(productLocations).where(eq(productLocations.warehouseLocationId, warehouseLocationId)).limit(1);
  return result.length > 0;
}

export async function bulkReassignProducts(sourceLocationIds: number[], targetLocationId: number, targetCode: string, targetZone: string, tx: Tx = db): Promise<number> {
  const result = await tx.update(productLocations).set({ warehouseLocationId: targetLocationId, location: targetCode, zone: targetZone }).where(inArray(productLocations.warehouseLocationId, sourceLocationIds));
  return result.rowCount || 0;
}

export async function getLocationInventoryDetail(warehouseLocationId: number, tx: Tx = db): Promise<any[]> {
  const result = await tx.execute(sql`
    SELECT il.id, il.product_variant_id, il.variant_qty, il.reserved_qty, il.picked_qty, pv.sku, pv.name as variant_name, pv.units_per_variant,
      COALESCE(p.title, p.name) as product_title, p.id as product_id,
      (SELECT pa.url FROM catalog.product_assets pa WHERE pa.product_id = p.id AND pa.product_variant_id IS NULL AND pa.is_primary = 1 LIMIT 1) as image_url, pv.barcode
    FROM inventory.inventory_levels il
    JOIN catalog.product_variants pv ON il.product_variant_id = pv.id
    LEFT JOIN catalog.products p ON pv.product_id = p.id
    WHERE il.warehouse_location_id = ${warehouseLocationId} AND il.variant_qty > 0 ORDER BY pv.sku
  `);
  return (result.rows as any[]).map(row => ({
    id: row.id, variantId: row.product_variant_id, qty: row.variant_qty, reservedQty: row.reserved_qty,
    pickedQty: row.picked_qty, sku: row.sku, variantName: row.variant_name, unitsPerVariant: row.units_per_variant,
    productTitle: row.product_title, productId: row.product_id, imageUrl: row.image_url, barcode: row.barcode,
  }));
}

export async function getWarehouseLocationCodeById(id: number, tx: Tx = db): Promise<string | null> {
  const [loc] = await tx.select({ code: warehouseLocations.code }).from(warehouseLocations).where(eq(warehouseLocations.id, id)).limit(1);
  return loc?.code ?? null;
}
