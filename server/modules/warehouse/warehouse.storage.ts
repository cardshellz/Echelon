import {
  db,
  warehouses,
  warehouseZones,
  warehouseLocations,
  fulfillmentRoutingRules,
  productLocations,
  inventoryLevels,
  generateLocationCode,
  eq,
  and,
  asc,
  sql,
  inArray,
} from "../../storage/base";
import type {
  Warehouse,
  InsertWarehouse,
  WarehouseZone,
  InsertWarehouseZone,
  WarehouseLocation,
  InsertWarehouseLocation,
  FulfillmentRoutingRule,
  InsertFulfillmentRoutingRule,
} from "../../storage/base";

export interface IWarehouseStorage {
  getAllWarehouses(): Promise<Warehouse[]>;
  getWarehouseById(id: number): Promise<Warehouse | undefined>;
  getWarehouseByCode(code: string): Promise<Warehouse | undefined>;
  createWarehouse(warehouse: InsertWarehouse): Promise<Warehouse>;
  updateWarehouse(id: number, updates: Partial<InsertWarehouse>): Promise<Warehouse | null>;
  deleteWarehouse(id: number): Promise<boolean>;

  getAllWarehouseZones(): Promise<WarehouseZone[]>;
  getWarehouseZoneByCode(code: string): Promise<WarehouseZone | undefined>;
  createWarehouseZone(zone: InsertWarehouseZone): Promise<WarehouseZone>;
  updateWarehouseZone(id: number, updates: Partial<InsertWarehouseZone>): Promise<WarehouseZone | null>;
  deleteWarehouseZone(id: number): Promise<boolean>;

  getAllWarehouseLocations(): Promise<WarehouseLocation[]>;
  getWarehouseLocationById(id: number): Promise<WarehouseLocation | undefined>;
  getWarehouseLocationByCode(code: string): Promise<WarehouseLocation | undefined>;
  createWarehouseLocation(location: InsertWarehouseLocation | Omit<InsertWarehouseLocation, 'code'>): Promise<WarehouseLocation>;
  updateWarehouseLocation(id: number, updates: Partial<Omit<InsertWarehouseLocation, 'code'>>): Promise<WarehouseLocation | null>;
  deleteWarehouseLocation(id: number): Promise<boolean>;

  // Fulfillment routing rules
  getAllFulfillmentRoutingRules(): Promise<FulfillmentRoutingRule[]>;
  createFulfillmentRoutingRule(data: InsertFulfillmentRoutingRule): Promise<FulfillmentRoutingRule>;
  updateFulfillmentRoutingRule(id: number, data: Partial<InsertFulfillmentRoutingRule>): Promise<FulfillmentRoutingRule | null>;
  deleteFulfillmentRoutingRule(id: number): Promise<FulfillmentRoutingRule | null>;

  // Location aggregate queries
  getSkusByWarehouseLocation(): Promise<Map<number, string>>;
  hasProductsAssignedToLocation(warehouseLocationId: number): Promise<boolean>;
  bulkReassignProducts(sourceLocationIds: number[], targetLocationId: number, targetCode: string, targetZone: string): Promise<number>;
  getLocationInventoryDetail(warehouseLocationId: number): Promise<any[]>;
  getWarehouseLocationCodeById(id: number): Promise<string | null>;
}

export const warehouseMethods: IWarehouseStorage = {
  async getAllWarehouses(): Promise<Warehouse[]> {
    return await db.select().from(warehouses).orderBy(asc(warehouses.name));
  },

  async getWarehouseById(id: number): Promise<Warehouse | undefined> {
    const result = await db.select().from(warehouses).where(eq(warehouses.id, id));
    return result[0];
  },

  async getWarehouseByCode(code: string): Promise<Warehouse | undefined> {
    const result = await db.select().from(warehouses).where(eq(warehouses.code, code.toUpperCase()));
    return result[0];
  },

  async createWarehouse(warehouse: InsertWarehouse): Promise<Warehouse> {
    const result = await db.insert(warehouses).values({
      ...warehouse,
      code: warehouse.code.toUpperCase(),
    }).returning();
    return result[0];
  },

  async updateWarehouse(id: number, updates: Partial<InsertWarehouse>): Promise<Warehouse | null> {
    const result = await db
      .update(warehouses)
      .set({
        ...updates,
        code: updates.code ? updates.code.toUpperCase() : undefined,
        updatedAt: new Date(),
      })
      .where(eq(warehouses.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteWarehouse(id: number): Promise<boolean> {
    const result = await db.delete(warehouses).where(eq(warehouses.id, id)).returning();
    return result.length > 0;
  },

  async getAllWarehouseZones(): Promise<WarehouseZone[]> {
    return await db.select().from(warehouseZones).orderBy(asc(warehouseZones.code));
  },

  async getWarehouseZoneByCode(code: string): Promise<WarehouseZone | undefined> {
    const result = await db.select().from(warehouseZones).where(eq(warehouseZones.code, code.toUpperCase()));
    return result[0];
  },

  async createWarehouseZone(zone: InsertWarehouseZone): Promise<WarehouseZone> {
    const result = await db.insert(warehouseZones).values({
      ...zone,
      code: zone.code.toUpperCase(),
    }).returning();
    return result[0];
  },

  async updateWarehouseZone(id: number, updates: Partial<InsertWarehouseZone>): Promise<WarehouseZone | null> {
    const result = await db
      .update(warehouseZones)
      .set(updates)
      .where(eq(warehouseZones.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteWarehouseZone(id: number): Promise<boolean> {
    const result = await db.delete(warehouseZones).where(eq(warehouseZones.id, id)).returning();
    return result.length > 0;
  },

  async getAllWarehouseLocations(): Promise<WarehouseLocation[]> {
    return await db.select().from(warehouseLocations).orderBy(asc(warehouseLocations.code));
  },

  async getWarehouseLocationById(id: number): Promise<WarehouseLocation | undefined> {
    const result = await db.select().from(warehouseLocations).where(eq(warehouseLocations.id, id));
    return result[0];
  },

  async getWarehouseLocationByCode(code: string): Promise<WarehouseLocation | undefined> {
    const result = await db.select().from(warehouseLocations).where(eq(warehouseLocations.code, code.toUpperCase()));
    return result[0];
  },

  async createWarehouseLocation(location: InsertWarehouseLocation | Omit<InsertWarehouseLocation, 'code'>): Promise<WarehouseLocation> {
    const rawCode = ('code' in location && location.code) ? location.code : generateLocationCode(location);
    const code = rawCode.toUpperCase().trim();

    const conditions = [eq(warehouseLocations.code, code.toUpperCase())];
    if (location.warehouseId) {
      conditions.push(eq(warehouseLocations.warehouseId, location.warehouseId));
    }
    const [existing] = await db.select().from(warehouseLocations).where(and(...conditions));
    if (existing) {
      throw new Error(`Location code "${code}" already exists in this warehouse`);
    }

    const result = await db.insert(warehouseLocations).values({
      ...location,
      code,
    }).returning();
    return result[0];
  },

  async updateWarehouseLocation(id: number, updates: Partial<Omit<InsertWarehouseLocation, 'code'>>): Promise<WarehouseLocation | null> {
    const existing = await this.getWarehouseLocationById(id);
    if (!existing) return null;
    
    const merged = { ...existing, ...updates };
    const newCode = generateLocationCode(merged);
    
    if (newCode !== existing.code) {
      const whId = updates.warehouseId ?? existing.warehouseId;
      const conditions = [eq(warehouseLocations.code, newCode.toUpperCase())];
      if (whId) conditions.push(eq(warehouseLocations.warehouseId, whId));
      const [conflict] = await db.select().from(warehouseLocations).where(and(...conditions));
      if (conflict && conflict.id !== id) {
        throw new Error(`Location code "${newCode}" already exists in this warehouse`);
      }
    }
    
    const result = await db
      .update(warehouseLocations)
      .set({ ...updates, code: newCode, updatedAt: new Date() })
      .where(eq(warehouseLocations.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteWarehouseLocation(id: number): Promise<boolean> {
    const result = await db.delete(warehouseLocations).where(eq(warehouseLocations.id, id)).returning();
    return result.length > 0;
  },

  // Fulfillment routing rules

  async getAllFulfillmentRoutingRules(): Promise<FulfillmentRoutingRule[]> {
    return await db.select().from(fulfillmentRoutingRules).orderBy(sql`priority DESC, id`);
  },

  async createFulfillmentRoutingRule(data: InsertFulfillmentRoutingRule): Promise<FulfillmentRoutingRule> {
    const [rule] = await db.insert(fulfillmentRoutingRules).values(data as any).returning();
    return rule;
  },

  async updateFulfillmentRoutingRule(id: number, data: Partial<InsertFulfillmentRoutingRule>): Promise<FulfillmentRoutingRule | null> {
    const [rule] = await db.update(fulfillmentRoutingRules)
      .set({ ...data as any, updatedAt: new Date() })
      .where(eq(fulfillmentRoutingRules.id, id))
      .returning();
    return rule || null;
  },

  async deleteFulfillmentRoutingRule(id: number): Promise<FulfillmentRoutingRule | null> {
    const [deleted] = await db.delete(fulfillmentRoutingRules)
      .where(eq(fulfillmentRoutingRules.id, id))
      .returning();
    return deleted || null;
  },

  // Location aggregate queries

  async getSkusByWarehouseLocation(): Promise<Map<number, string>> {
    const result = await db.execute(sql`
      SELECT warehouse_location_id, STRING_AGG(sku, ', ' ORDER BY is_primary DESC, sku) as skus
      FROM product_locations
      WHERE sku IS NOT NULL
      GROUP BY warehouse_location_id
    `);
    const map = new Map<number, string>();
    for (const row of result.rows as any[]) {
      if (row.warehouse_location_id && row.skus) {
        map.set(row.warehouse_location_id, row.skus);
      }
    }
    return map;
  },

  async hasProductsAssignedToLocation(warehouseLocationId: number): Promise<boolean> {
    const result = await db.select({ id: productLocations.id })
      .from(productLocations)
      .where(eq(productLocations.warehouseLocationId, warehouseLocationId))
      .limit(1);
    return result.length > 0;
  },

  async bulkReassignProducts(sourceLocationIds: number[], targetLocationId: number, targetCode: string, targetZone: string): Promise<number> {
    const result = await db.update(productLocations)
      .set({
        warehouseLocationId: targetLocationId,
        location: targetCode,
        zone: targetZone,
      })
      .where(inArray(productLocations.warehouseLocationId, sourceLocationIds));
    return result.rowCount || 0;
  },

  async getLocationInventoryDetail(warehouseLocationId: number): Promise<any[]> {
    const result = await db.execute(sql`
      SELECT
        il.id,
        il.product_variant_id,
        il.variant_qty,
        il.reserved_qty,
        il.picked_qty,
        pv.sku,
        pv.name as variant_name,
        pv.units_per_variant,
        COALESCE(p.title, p.name) as product_title,
        p.id as product_id,
        (SELECT pa.url FROM product_assets pa WHERE pa.product_id = p.id AND pa.product_variant_id IS NULL AND pa.is_primary = 1 LIMIT 1) as image_url,
        pv.barcode
      FROM inventory_levels il
      JOIN product_variants pv ON il.product_variant_id = pv.id
      LEFT JOIN products p ON pv.product_id = p.id
      WHERE il.warehouse_location_id = ${warehouseLocationId}
        AND il.variant_qty > 0
      ORDER BY pv.sku
    `);
    return (result.rows as any[]).map(row => ({
      id: row.id,
      variantId: row.product_variant_id,
      qty: row.variant_qty,
      reservedQty: row.reserved_qty,
      pickedQty: row.picked_qty,
      sku: row.sku,
      variantName: row.variant_name,
      unitsPerVariant: row.units_per_variant,
      productTitle: row.product_title,
      productId: row.product_id,
      imageUrl: row.image_url,
      barcode: row.barcode,
    }));
  },

  async getWarehouseLocationCodeById(id: number): Promise<string | null> {
    const [loc] = await db.select({ code: warehouseLocations.code }).from(warehouseLocations).where(eq(warehouseLocations.id, id)).limit(1);
    return loc?.code ?? null;
  },
};
