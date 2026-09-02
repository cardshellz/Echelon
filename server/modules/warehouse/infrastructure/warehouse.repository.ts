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
import { ne } from "drizzle-orm";
// wms.order_items belongs to modules/orders (writer-ratchet P2.1) — write via its public API.
import { backfillOpenOrderItemBinAssignment } from "../../orders/bin-location-backfill";
import type {
  Warehouse, InsertWarehouse, WarehouseZone, InsertWarehouseZone,
  WarehouseLocation, InsertWarehouseLocation, FulfillmentRoutingRule, InsertFulfillmentRoutingRule,
  ProductLocation, InsertProductLocation, UpdateProductLocation, EchelonSetting
} from "../../../storage/base";
import {
  normalizeLocationInput,
  validateWarehouseLocationIntegrity,
} from "../location-integrity";

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

/**
 * The default FULFILLMENT warehouse — the catch-all an order routes to when no
 * routing rule matches, and the fallback the SLA cutoff uses for an order not
 * yet assigned a warehouse.
 *
 * Excludes `bulk_storage` (a storage hub never ships customer orders, so its
 * cutoff is meaningless), and is deterministic (lowest id) even if more than
 * one warehouse is flagged `is_default`. Single source of truth shared by the
 * fulfillment router and the SLA cutoff resolver so they can never disagree.
 */
export async function getDefaultFulfillmentWarehouse(tx: Tx = db): Promise<Warehouse | undefined> {
  const result = await tx
    .select()
    .from(warehouses)
    .where(and(
      eq(warehouses.isDefault, 1),
      eq(warehouses.isActive, 1),
      inArray(warehouses.warehouseType, ["operations", "3pl"]),
    ))
    .orderBy(asc(warehouses.id))
    .limit(1);
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
  const normalized = normalizeLocationInput(location);
  const rawCode = ('code' in normalized && normalized.code) ? normalized.code : generateLocationCode(normalized as any);
  const code = rawCode.toUpperCase().trim();
  validateWarehouseLocationIntegrity({ ...normalized, code });

  const conditions = [eq(warehouseLocations.code, code.toUpperCase())];
  if (normalized.warehouseId) conditions.push(eq(warehouseLocations.warehouseId, normalized.warehouseId));
  
  const [existing] = await tx.select().from(warehouseLocations).where(and(...conditions));
  if (existing) throw new Error(`Location code "${code}" already exists in this warehouse`);

  const result = await tx.insert(warehouseLocations).values({ ...normalized, code }).returning();
  return result[0];
}

export async function updateWarehouseLocation(id: number, updates: Partial<Omit<InsertWarehouseLocation, 'code'>>, tx: Tx = db): Promise<WarehouseLocation | null> {
  const existing = await getWarehouseLocationById(id, tx);
  if (!existing) return null;
  
  const normalizedUpdates = normalizeLocationInput(updates);
  const merged = { ...existing, ...normalizedUpdates };
  const newCode = generateLocationCode(merged as any);
  validateWarehouseLocationIntegrity({ ...merged, code: newCode });
  
  if (newCode !== existing.code) {
    const whId = normalizedUpdates.warehouseId ?? existing.warehouseId;
    const conditions = [eq(warehouseLocations.code, newCode.toUpperCase())];
    if (whId) conditions.push(eq(warehouseLocations.warehouseId, whId));
    const [conflict] = await tx.select().from(warehouseLocations).where(and(...conditions));
    if (conflict && conflict.id !== id) throw new Error(`Location code "${newCode}" already exists in this warehouse`);
  }
  
  const result = await tx.update(warehouseLocations).set({ ...normalizedUpdates, code: newCode, updatedAt: new Date() }).where(eq(warehouseLocations.id, id)).returning();
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

/**
 * Make one slot row the primary for its variant.
 *
 * Demotion is scoped to the variant — never to the product. A product-wide
 * demotion (the pre-2026-05-14 behaviour, commit 0faaa645) stripped the flag
 * from every sibling pack size and left them invisible to flag-gated readers.
 * Legacy rows without a variant id are scoped by their SKU string, the key
 * every other slot reader uses for them; a row with neither cannot be scoped
 * safely and is refused.
 */
export async function setPrimaryLocation(productLocationId: number, tx: Tx = db): Promise<ProductLocation | undefined> {
  const location = await getProductLocationById(productLocationId, tx);
  if (!location) return undefined;

  const now = new Date();
  if (location.productVariantId != null) {
    await tx.update(productLocations).set({ isPrimary: 0, updatedAt: now })
      .where(and(eq(productLocations.productVariantId, location.productVariantId), ne(productLocations.id, productLocationId)));
  } else if (location.sku) {
    await tx.update(productLocations).set({ isPrimary: 0, updatedAt: now })
      .where(and(eq(productLocations.sku, location.sku.toUpperCase()), ne(productLocations.id, productLocationId)));
  } else {
    throw new Error(`Product location ${productLocationId} has neither a variant nor a SKU; refusing to scope a primary demotion`);
  }
  const result = await tx.update(productLocations).set({ isPrimary: 1, updatedAt: now }).where(eq(productLocations.id, productLocationId)).returning();
  await backfillOpenOrderItemBinAssignment({ sku: result[0]?.sku, locationCode: result[0]?.location, zone: result[0]?.zone });
  return result[0];
}

export async function createProductLocation(location: InsertProductLocation, tx: Tx = db): Promise<ProductLocation> {
  if (location.warehouseLocationId) {
    const [loc] = await tx.select({
      code: warehouseLocations.code,
      warehouseId: warehouseLocations.warehouseId,
      locationType: warehouseLocations.locationType,
      isPickable: warehouseLocations.isPickable,
      isActive: warehouseLocations.isActive,
    }).from(warehouseLocations).where(eq(warehouseLocations.id, location.warehouseLocationId)).limit(1);
    if (!loc) throw new Error(`Warehouse location ${location.warehouseLocationId} not found`);
    if (loc.isActive !== 1) throw new Error(`Location ${loc.code} is inactive - cannot assign products`);
    if (loc.warehouseId == null) throw new Error(`Location ${loc.code} is not assigned to a warehouse - cannot assign products`);
    if (loc.locationType !== "pick" || loc.isPickable !== 1) throw new Error(`Location ${loc.code} is not a pick face - cannot assign products`);
  }
  const result = await tx.insert(productLocations).values({
    ...location, sku: location.sku?.toUpperCase() || null, location: location.location.toUpperCase(), zone: location.zone.toUpperCase(),
  }).returning();
  if (result[0]?.status === "active") {
    await backfillOpenOrderItemBinAssignment({ sku: result[0]?.sku, locationCode: result[0]?.location, zone: result[0]?.zone });
  }
  return result[0];
}

export async function updateProductLocation(id: number, location: UpdateProductLocation, tx: Tx = db): Promise<ProductLocation | undefined> {
  const updates: any = { ...location };
  if (updates.sku) updates.sku = updates.sku.toUpperCase();
  if (updates.location) updates.location = updates.location.toUpperCase();
  if (updates.zone) updates.zone = updates.zone.toUpperCase();
  updates.updatedAt = new Date();
  
  const result = await tx.update(productLocations).set(updates).where(eq(productLocations.id, id)).returning();
  // Bin moved (or row re-activated at a bin): stamp still-unassigned open items.
  if (result[0] && (updates.location || updates.warehouseLocationId || updates.status === "active")) {
    await backfillOpenOrderItemBinAssignment({ sku: result[0]?.sku, locationCode: result[0]?.location, zone: result[0]?.zone });
  }
  return result[0];
}

export type PromotedSlot = { id: number; sku: string | null; location: string; zone: string };

/**
 * Flag the best remaining active, bin-backed slot of a variant as primary.
 * Ranking mirrors assignVariantToLocation's canonical-row choice: a usable pick
 * face first, then an already-flagged row, then the most recently touched row,
 * then the lowest id. Legacy rows without a variant id are matched by SKU.
 * Returns the promoted row, or null when the variant has no eligible slot.
 */
export async function promoteBestRemainingSlot(
  executor: Tx,
  scope: { productVariantId: number | null; sku: string | null; excludeId?: number | null },
): Promise<PromotedSlot | null> {
  const upperSku = scope.sku ? scope.sku.toUpperCase() : null;
  if (scope.productVariantId == null && !upperSku) return null;

  const variantMatch = scope.productVariantId != null
    ? sql`pl.product_variant_id = ${scope.productVariantId}`
    : sql`FALSE`;
  const result = await executor.execute(sql`
    UPDATE warehouse.product_locations
    SET is_primary = 1, updated_at = NOW()
    WHERE id = (
      SELECT pl.id
      FROM warehouse.product_locations pl
      LEFT JOIN warehouse.warehouse_locations wl ON wl.id = pl.warehouse_location_id
      WHERE pl.status = 'active'
        AND pl.warehouse_location_id IS NOT NULL
        AND pl.id <> ${scope.excludeId ?? -1}
        AND (
          ${variantMatch}
          OR (pl.product_variant_id IS NULL AND pl.sku IS NOT NULL AND UPPER(pl.sku) = ${upperSku})
        )
      ORDER BY
        CASE
          WHEN wl.id IS NOT NULL
           AND wl.warehouse_id IS NOT NULL
           AND wl.is_active = 1
           AND wl.location_type = 'pick'
           AND wl.is_pickable = 1
          THEN 0 ELSE 1
        END,
        pl.is_primary DESC,
        pl.updated_at DESC,
        pl.id ASC
      LIMIT 1
    )
    RETURNING id, sku, location, zone
  `);
  const row = result.rows?.[0] as { id: number; sku: string | null; location: string; zone: string } | undefined;
  return row
    ? { id: Number(row.id), sku: row.sku ?? null, location: String(row.location), zone: String(row.zone) }
    : null;
}

/**
 * Delete a slot row. When the deleted row was the variant's primary, the best
 * remaining active, bin-backed sibling is promoted in the same transaction, so
 * a variant is never left with slots but no primary (that state hid SKUs from
 * every flag-gated reader, 2026-09). Open UNASSIGNED order lines are then
 * re-stamped with the promoted bin — best-effort, after the commit, like every
 * other slot writer here.
 */
export async function deleteProductLocation(id: number, tx: Tx = db): Promise<boolean> {
  const outcome: { deleted: boolean; promoted: PromotedSlot | null } = await tx.transaction(async (t: Tx) => {
    const deleted = await t.execute(sql`
      DELETE FROM warehouse.product_locations
      WHERE id = ${id}
      RETURNING id, product_variant_id, sku, is_primary
    `);
    const row = deleted.rows?.[0] as
      | { id: number; product_variant_id: number | null; sku: string | null; is_primary: number }
      | undefined;
    if (!row) return { deleted: false, promoted: null };
    if (Number(row.is_primary) !== 1) return { deleted: true, promoted: null };

    const promoted = await promoteBestRemainingSlot(t, {
      productVariantId: row.product_variant_id == null ? null : Number(row.product_variant_id),
      sku: row.sku ?? null,
    });
    return { deleted: true, promoted };
  });

  if (outcome.promoted) {
    await backfillOpenOrderItemBinAssignment({
      sku: outcome.promoted.sku,
      locationCode: outcome.promoted.location,
      zone: outcome.promoted.zone,
    });
  }
  return outcome.deleted;
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
