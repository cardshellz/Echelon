import {
  db,
  type EchelonSetting,
  echelonSettings,
  eq,
} from "../../storage/base";

export interface ISettingsStorage {
  getAllSettings(): Promise<Record<string, string | null>>;
  getSetting(key: string): Promise<string | null>;
  upsertSetting(key: string, value: string | null, category?: string): Promise<EchelonSetting | null>;
}

export const settingsMethods: ISettingsStorage = {
  async getAllSettings(): Promise<Record<string, string | null>> {
    const settings = await db.select().from(echelonSettings);
    const result: Record<string, string | null> = {};
    for (const setting of settings) {
      result[setting.key] = setting.value;
    }
    return result;
  },

  async getSetting(key: string): Promise<string | null> {
    try {
      const result = await db.select().from(echelonSettings).where(eq(echelonSettings.key, key)).limit(1);
      return result[0]?.value ?? null;
    } catch (error) {
      console.warn(`getSetting failed for key "${key}" - echelon_settings table may not exist yet`);
      return null;
    }
  },

  async upsertSetting(key: string, value: string | null, category?: string): Promise<EchelonSetting | null> {
    try {
      const existing = await db.select().from(echelonSettings).where(eq(echelonSettings.key, key)).limit(1);

      if (existing.length > 0) {
        const updated = await db.update(echelonSettings)
          .set({ value, updatedAt: new Date() })
          .where(eq(echelonSettings.key, key))
          .returning();
        return updated[0];
      }

      const inserted = await db.insert(echelonSettings).values({
        key,
        value,
        type: "string",
        category: category || (
          key.startsWith("company_") ? "company" :
          key.startsWith("low_stock") || key.startsWith("critical_stock") ? "inventory" :
          key.startsWith("picking") || key.startsWith("auto_release") ? "picking" : "general"
        ),
      }).returning();
      return inserted[0];
    } catch (error) {
      console.warn(`upsertSetting failed for key "${key}" - echelon_settings table may not exist yet`);
      return null;
    }
  },
};
