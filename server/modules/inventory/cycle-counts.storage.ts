import {
  db,
  type CycleCount,
  type InsertCycleCount,
  type CycleCountItem,
  type InsertCycleCountItem,
  cycleCounts,
  cycleCountItems,
  eq, desc, asc,
} from "../../storage/base";

export interface ICycleCountStorage {
  getAllCycleCounts(): Promise<CycleCount[]>;
  getCycleCountById(id: number): Promise<CycleCount | undefined>;
  createCycleCount(data: InsertCycleCount): Promise<CycleCount>;
  updateCycleCount(id: number, updates: Partial<InsertCycleCount>): Promise<CycleCount | null>;
  deleteCycleCount(id: number): Promise<boolean>;
  getCycleCountItems(cycleCountId: number): Promise<CycleCountItem[]>;
  getCycleCountItemById(id: number): Promise<CycleCountItem | undefined>;
  createCycleCountItem(data: InsertCycleCountItem): Promise<CycleCountItem>;
  updateCycleCountItem(id: number, updates: Partial<InsertCycleCountItem>): Promise<CycleCountItem | null>;
  deleteCycleCountItem(id: number): Promise<boolean>;
  bulkCreateCycleCountItems(items: InsertCycleCountItem[]): Promise<CycleCountItem[]>;
}

export const cycleCountMethods: ICycleCountStorage = {
  async getAllCycleCounts(): Promise<CycleCount[]> {
    return await db.select().from(cycleCounts).orderBy(desc(cycleCounts.createdAt));
  },

  async getCycleCountById(id: number): Promise<CycleCount | undefined> {
    const result = await db.select().from(cycleCounts).where(eq(cycleCounts.id, id)).limit(1);
    return result[0];
  },

  async createCycleCount(data: InsertCycleCount): Promise<CycleCount> {
    const result = await db.insert(cycleCounts).values(data).returning();
    return result[0];
  },

  async updateCycleCount(id: number, updates: Partial<InsertCycleCount>): Promise<CycleCount | null> {
    const result = await db.update(cycleCounts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(cycleCounts.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteCycleCount(id: number): Promise<boolean> {
    const result = await db.delete(cycleCounts).where(eq(cycleCounts.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async getCycleCountItems(cycleCountId: number): Promise<CycleCountItem[]> {
    return await db.select().from(cycleCountItems).where(eq(cycleCountItems.cycleCountId, cycleCountId)).orderBy(asc(cycleCountItems.id));
  },

  async getCycleCountItemById(id: number): Promise<CycleCountItem | undefined> {
    const result = await db.select().from(cycleCountItems).where(eq(cycleCountItems.id, id)).limit(1);
    return result[0];
  },

  async createCycleCountItem(data: InsertCycleCountItem): Promise<CycleCountItem> {
    const result = await db.insert(cycleCountItems).values(data).returning();
    return result[0];
  },

  async updateCycleCountItem(id: number, updates: Partial<InsertCycleCountItem>): Promise<CycleCountItem | null> {
    const result = await db.update(cycleCountItems)
      .set(updates)
      .where(eq(cycleCountItems.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteCycleCountItem(id: number): Promise<boolean> {
    const result = await db.delete(cycleCountItems).where(eq(cycleCountItems.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async bulkCreateCycleCountItems(items: InsertCycleCountItem[]): Promise<CycleCountItem[]> {
    if (items.length === 0) return [];
    return await db.insert(cycleCountItems).values(items).returning();
  },
};
