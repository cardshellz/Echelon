import {
  db,
  type CycleCount,
  type InsertCycleCount,
  type CycleCountItem,
  type InsertCycleCountItem,
  cycleCounts,
  cycleCountItems,
  eq, desc, asc,
} from "../../../storage/base";

export interface ICycleCountStorage {
  getAllCycleCounts(): Promise<CycleCount[]>;
  getCycleCountById(id: number): Promise<CycleCount | undefined>;
  createCycleCount(data: InsertCycleCount, tx?: any): Promise<CycleCount>;
  updateCycleCount(id: number, updates: Partial<InsertCycleCount>, tx?: any): Promise<CycleCount | null>;
  deleteCycleCount(id: number, tx?: any): Promise<boolean>;
  getCycleCountItems(cycleCountId: number): Promise<CycleCountItem[]>;
  getCycleCountItemById(id: number): Promise<CycleCountItem | undefined>;
  createCycleCountItem(data: InsertCycleCountItem, tx?: any): Promise<CycleCountItem>;
  updateCycleCountItem(id: number, updates: Partial<InsertCycleCountItem>, tx?: any): Promise<CycleCountItem | null>;
  deleteCycleCountItem(id: number, tx?: any): Promise<boolean>;
  bulkCreateCycleCountItems(items: InsertCycleCountItem[], tx?: any): Promise<CycleCountItem[]>;
}

export const cycleCountMethods: ICycleCountStorage = {
  async getAllCycleCounts(): Promise<CycleCount[]> {
    return await db.select().from(cycleCounts).orderBy(desc(cycleCounts.createdAt));
  },

  async getCycleCountById(id: number): Promise<CycleCount | undefined> {
    const result = await db.select().from(cycleCounts).where(eq(cycleCounts.id, id)).limit(1);
    return result[0];
  },

  async createCycleCount(data: InsertCycleCount, tx: any = db): Promise<CycleCount> {
    const result = await tx.insert(cycleCounts).values(data).returning();
    return result[0];
  },

  async updateCycleCount(id: number, updates: Partial<InsertCycleCount>, tx: any = db): Promise<CycleCount | null> {
    const result = await tx.update(cycleCounts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(cycleCounts.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteCycleCount(id: number, tx: any = db): Promise<boolean> {
    const result = await tx.delete(cycleCounts).where(eq(cycleCounts.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async getCycleCountItems(cycleCountId: number): Promise<CycleCountItem[]> {
    return await db.select().from(cycleCountItems).where(eq(cycleCountItems.cycleCountId, cycleCountId)).orderBy(asc(cycleCountItems.id));
  },

  async getCycleCountItemById(id: number): Promise<CycleCountItem | undefined> {
    const result = await db.select().from(cycleCountItems).where(eq(cycleCountItems.id, id)).limit(1);
    return result[0];
  },

  async createCycleCountItem(data: InsertCycleCountItem, tx: any = db): Promise<CycleCountItem> {
    const result = await tx.insert(cycleCountItems).values(data).returning();
    return result[0];
  },

  async updateCycleCountItem(id: number, updates: Partial<InsertCycleCountItem>, tx: any = db): Promise<CycleCountItem | null> {
    const result = await tx.update(cycleCountItems)
      .set(updates)
      .where(eq(cycleCountItems.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteCycleCountItem(id: number, tx: any = db): Promise<boolean> {
    const result = await tx.delete(cycleCountItems).where(eq(cycleCountItems.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async bulkCreateCycleCountItems(items: InsertCycleCountItem[], tx: any = db): Promise<CycleCountItem[]> {
    if (items.length === 0) return [];
    return await tx.insert(cycleCountItems).values(items).returning();
  },
};
