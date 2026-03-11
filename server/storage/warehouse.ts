import {
  db,
  warehouses,
  warehouseZones,
  warehouseLocations,
  generateLocationCode,
  eq,
  and,
  asc,
  sql,
} from "./base";
import type {
  Warehouse,
  InsertWarehouse,
  WarehouseZone,
  InsertWarehouseZone,
  WarehouseLocation,
  InsertWarehouseLocation,
} from "./base";

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
};
