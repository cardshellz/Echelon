import {
  db,
  type ReplenTierDefault,
  type InsertReplenTierDefault,
  type ReplenRule,
  type InsertReplenRule,
  type LocationReplenConfig,
  type InsertLocationReplenConfig,
  type ReplenTask,
  type InsertReplenTask,
  type WarehouseSettings,
  type InsertWarehouseSettings,
  replenTierDefaults,
  replenRules,
  locationReplenConfig,
  replenTasks,
  warehouseSettings,
  eq, and, inArray, isNull, desc, asc, sql,
} from "../../../storage/base";

export interface IReplenishmentStorage {
  getAllReplenTierDefaults(): Promise<ReplenTierDefault[]>;
  getReplenTierDefaultById(id: number): Promise<ReplenTierDefault | undefined>;
  getReplenTierDefaultByLevel(hierarchyLevel: number): Promise<ReplenTierDefault | undefined>;
  getActiveReplenTierDefaults(): Promise<ReplenTierDefault[]>;
  createReplenTierDefault(data: InsertReplenTierDefault): Promise<ReplenTierDefault>;
  updateReplenTierDefault(id: number, updates: Partial<InsertReplenTierDefault>): Promise<ReplenTierDefault | null>;
  deleteReplenTierDefault(id: number): Promise<boolean>;
  getAllReplenRules(): Promise<ReplenRule[]>;
  getReplenRuleById(id: number): Promise<ReplenRule | undefined>;
  getReplenRulesForVariant(pickProductVariantId: number): Promise<ReplenRule[]>;
  getReplenRulesForProduct(productId: number): Promise<ReplenRule[]>;
  createReplenRule(data: InsertReplenRule): Promise<ReplenRule>;
  updateReplenRule(id: number, updates: Partial<InsertReplenRule>): Promise<ReplenRule | null>;
  deleteReplenRule(id: number): Promise<boolean>;
  getActiveReplenRules(): Promise<ReplenRule[]>;
  getLocationReplenConfigs(warehouseLocationId?: number): Promise<LocationReplenConfig[]>;
  getLocationReplenConfig(warehouseLocationId: number, productVariantId: number | null): Promise<LocationReplenConfig | undefined>;
  getLocationReplenConfigById(id: number): Promise<LocationReplenConfig | undefined>;
  createLocationReplenConfig(data: InsertLocationReplenConfig): Promise<LocationReplenConfig>;
  updateLocationReplenConfig(id: number, updates: Partial<InsertLocationReplenConfig>): Promise<LocationReplenConfig | null>;
  deleteLocationReplenConfig(id: number): Promise<boolean>;
  getAllReplenTasks(filters?: { status?: string; assignedTo?: string }): Promise<ReplenTask[]>;
  getReplenTaskById(id: number): Promise<ReplenTask | undefined>;
  createReplenTask(data: InsertReplenTask, tx?: any): Promise<ReplenTask>;
  updateReplenTask(id: number, updates: Partial<InsertReplenTask>, tx?: any): Promise<ReplenTask | null>;
  deleteReplenTask(id: number, tx?: any): Promise<boolean>;
  getPendingReplenTasksForLocation(toLocationId: number): Promise<ReplenTask[]>;
  getAllWarehouseSettings(): Promise<WarehouseSettings[]>;
  getWarehouseSettingsByCode(code: string): Promise<WarehouseSettings | undefined>;
  getWarehouseSettingsById(id: number): Promise<WarehouseSettings | undefined>;
  getDefaultWarehouseSettings(): Promise<WarehouseSettings | undefined>;
  createWarehouseSettings(data: InsertWarehouseSettings): Promise<WarehouseSettings>;
  updateWarehouseSettings(id: number, updates: Partial<InsertWarehouseSettings>): Promise<WarehouseSettings | null>;
  deleteWarehouseSettings(id: number): Promise<boolean>;
  getVelocityLookbackDays(): Promise<number>;
  updateVelocityLookbackDays(days: number): Promise<void>;
}

export const replenishmentMethods: IReplenishmentStorage = {
  async getAllReplenTierDefaults(): Promise<ReplenTierDefault[]> {
    return await db.select().from(replenTierDefaults).orderBy(asc(replenTierDefaults.hierarchyLevel));
  },

  async getReplenTierDefaultById(id: number): Promise<ReplenTierDefault | undefined> {
    const result = await db.select().from(replenTierDefaults).where(eq(replenTierDefaults.id, id)).limit(1);
    return result[0];
  },

  async getReplenTierDefaultByLevel(hierarchyLevel: number): Promise<ReplenTierDefault | undefined> {
    const result = await db.select().from(replenTierDefaults)
      .where(and(
        eq(replenTierDefaults.hierarchyLevel, hierarchyLevel),
        eq(replenTierDefaults.isActive, 1)
      ))
      .limit(1);
    return result[0];
  },

  async getActiveReplenTierDefaults(): Promise<ReplenTierDefault[]> {
    return await db.select().from(replenTierDefaults)
      .where(eq(replenTierDefaults.isActive, 1))
      .orderBy(asc(replenTierDefaults.hierarchyLevel));
  },

  async createReplenTierDefault(data: InsertReplenTierDefault): Promise<ReplenTierDefault> {
    const result = await db.insert(replenTierDefaults).values(data).returning();
    return result[0];
  },

  async updateReplenTierDefault(id: number, updates: Partial<InsertReplenTierDefault>): Promise<ReplenTierDefault | null> {
    const result = await db.update(replenTierDefaults)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(replenTierDefaults.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteReplenTierDefault(id: number): Promise<boolean> {
    const result = await db.delete(replenTierDefaults).where(eq(replenTierDefaults.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async getAllReplenRules(): Promise<ReplenRule[]> {
    return await db.select().from(replenRules).orderBy(asc(replenRules.priority));
  },

  async getReplenRuleById(id: number): Promise<ReplenRule | undefined> {
    const result = await db.select().from(replenRules).where(eq(replenRules.id, id)).limit(1);
    return result[0];
  },

  async getReplenRulesForVariant(pickProductVariantId: number): Promise<ReplenRule[]> {
    return await db.select().from(replenRules)
      .where(and(
        eq(replenRules.pickProductVariantId, pickProductVariantId),
        eq(replenRules.isActive, 1)
      ))
      .orderBy(asc(replenRules.priority));
  },

  async getReplenRulesForProduct(productId: number): Promise<ReplenRule[]> {
    return await db.select().from(replenRules)
      .where(and(
        eq(replenRules.productId, productId),
        eq(replenRules.isActive, 1)
      ))
      .orderBy(asc(replenRules.priority));
  },

  async createReplenRule(data: InsertReplenRule): Promise<ReplenRule> {
    const result = await db.insert(replenRules).values(data).returning();
    return result[0];
  },

  async updateReplenRule(id: number, updates: Partial<InsertReplenRule>): Promise<ReplenRule | null> {
    const result = await db.update(replenRules)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(replenRules.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteReplenRule(id: number): Promise<boolean> {
    const result = await db.delete(replenRules).where(eq(replenRules.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async getActiveReplenRules(): Promise<ReplenRule[]> {
    return await db.select().from(replenRules)
      .where(eq(replenRules.isActive, 1))
      .orderBy(asc(replenRules.priority));
  },

  async getLocationReplenConfigs(warehouseLocationId?: number): Promise<LocationReplenConfig[]> {
    if (warehouseLocationId !== undefined) {
      return await db.select().from(locationReplenConfig)
        .where(eq(locationReplenConfig.warehouseLocationId, warehouseLocationId))
        .orderBy(asc(locationReplenConfig.id));
    }
    return await db.select().from(locationReplenConfig).orderBy(asc(locationReplenConfig.id));
  },

  async getLocationReplenConfig(warehouseLocationId: number, productVariantId: number | null): Promise<LocationReplenConfig | undefined> {
    const conditions = [eq(locationReplenConfig.warehouseLocationId, warehouseLocationId)];
    if (productVariantId !== null) {
      conditions.push(eq(locationReplenConfig.productVariantId, productVariantId));
    } else {
      conditions.push(isNull(locationReplenConfig.productVariantId));
    }
    const result = await db.select().from(locationReplenConfig)
      .where(and(...conditions))
      .limit(1);
    return result[0];
  },

  async getLocationReplenConfigById(id: number): Promise<LocationReplenConfig | undefined> {
    const result = await db.select().from(locationReplenConfig)
      .where(eq(locationReplenConfig.id, id)).limit(1);
    return result[0];
  },

  async createLocationReplenConfig(data: InsertLocationReplenConfig): Promise<LocationReplenConfig> {
    const result = await db.insert(locationReplenConfig).values(data).returning();
    return result[0];
  },

  async updateLocationReplenConfig(id: number, updates: Partial<InsertLocationReplenConfig>): Promise<LocationReplenConfig | null> {
    const result = await db.update(locationReplenConfig)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(locationReplenConfig.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteLocationReplenConfig(id: number): Promise<boolean> {
    const result = await db.delete(locationReplenConfig).where(eq(locationReplenConfig.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async getAllReplenTasks(filters?: { status?: string; assignedTo?: string }): Promise<ReplenTask[]> {
    let query = db.select().from(replenTasks);

    const conditions = [];
    if (filters?.status) {
      conditions.push(eq(replenTasks.status, filters.status));
    }
    if (filters?.assignedTo) {
      conditions.push(eq(replenTasks.assignedTo, filters.assignedTo));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    return await query.orderBy(asc(replenTasks.priority), desc(replenTasks.createdAt));
  },

  async getReplenTaskById(id: number): Promise<ReplenTask | undefined> {
    const result = await db.select().from(replenTasks).where(eq(replenTasks.id, id)).limit(1);
    return result[0];
  },

  async createReplenTask(data: InsertReplenTask, tx: any = db): Promise<ReplenTask> {
    const result = await tx.insert(replenTasks).values(data).returning();
    return result[0];
  },

  async updateReplenTask(id: number, updates: Partial<InsertReplenTask>, tx: any = db): Promise<ReplenTask | null> {
    const result = await tx.update(replenTasks)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(replenTasks.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteReplenTask(id: number, tx: any = db): Promise<boolean> {
    const result = await tx.delete(replenTasks).where(eq(replenTasks.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async getPendingReplenTasksForLocation(toLocationId: number): Promise<ReplenTask[]> {
    return await db.select().from(replenTasks)
      .where(and(
        eq(replenTasks.toLocationId, toLocationId),
        inArray(replenTasks.status, ["pending", "assigned", "in_progress", "blocked"])
      ));
  },

  async getAllWarehouseSettings(): Promise<WarehouseSettings[]> {
    return await db.select().from(warehouseSettings).orderBy(asc(warehouseSettings.warehouseCode));
  },

  async getWarehouseSettingsByCode(code: string): Promise<WarehouseSettings | undefined> {
    const result = await db.select().from(warehouseSettings)
      .where(eq(warehouseSettings.warehouseCode, code)).limit(1);
    return result[0];
  },

  async getWarehouseSettingsById(id: number): Promise<WarehouseSettings | undefined> {
    const result = await db.select().from(warehouseSettings)
      .where(eq(warehouseSettings.id, id)).limit(1);
    return result[0];
  },

  async getDefaultWarehouseSettings(): Promise<WarehouseSettings | undefined> {
    const result = await db.select().from(warehouseSettings)
      .where(eq(warehouseSettings.warehouseCode, "DEFAULT")).limit(1);
    return result[0];
  },

  async createWarehouseSettings(data: InsertWarehouseSettings): Promise<WarehouseSettings> {
    const result = await db.insert(warehouseSettings).values(data).returning();
    return result[0];
  },

  async updateWarehouseSettings(id: number, updates: Partial<InsertWarehouseSettings>): Promise<WarehouseSettings | null> {
    const result = await db.update(warehouseSettings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(warehouseSettings.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteWarehouseSettings(id: number): Promise<boolean> {
    const result = await db.delete(warehouseSettings).where(eq(warehouseSettings.id, id)).returning();
    return result.length > 0;
  },

  async getVelocityLookbackDays(): Promise<number> {
    const result = await db.execute(sql`SELECT velocity_lookback_days FROM inventory.warehouse_settings LIMIT 1`);
    return (result.rows[0] as any)?.velocity_lookback_days ?? 14;
  },

  async updateVelocityLookbackDays(days: number): Promise<void> {
    await db.execute(sql`UPDATE warehouse_settings SET velocity_lookback_days = ${days}, updated_at = NOW()`);
  },
};
