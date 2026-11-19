import { sql } from "drizzle-orm";
import { db } from "../../db";

export type PickPriorityShippingLevel = "standard" | "expedited" | "overnight";

const DEFAULT_SHIPPING_BASE: Record<PickPriorityShippingLevel, number> = {
  standard: 100,
  expedited: 300,
  overnight: 500,
};
const DEFAULT_SLA_DAYS = 3;

export async function readPickPrioritySettings(
  database: Pick<typeof db, "execute"> = db,
): Promise<{
  shippingBase: Record<PickPriorityShippingLevel, number>;
  slaDefaultDays: number;
}> {
  const shippingBase: Record<PickPriorityShippingLevel, number> = {
    ...DEFAULT_SHIPPING_BASE,
  };
  let slaDefaultDays = DEFAULT_SLA_DAYS;

  const rows = await database.execute<{ key: string; value: string | null }>(sql`
    SELECT key, value
    FROM warehouse.echelon_settings
    WHERE key IN (
      'priority.shipping_base.standard',
      'priority.shipping_base.expedited',
      'priority.shipping_base.overnight',
      'priority.sla_default_days'
    )
  `);

  for (const row of rows.rows) {
    const n = row.value == null ? NaN : Number(row.value);
    if (!Number.isFinite(n)) continue;
    switch (row.key) {
      case "priority.shipping_base.standard":
        shippingBase.standard = n;
        break;
      case "priority.shipping_base.expedited":
        shippingBase.expedited = n;
        break;
      case "priority.shipping_base.overnight":
        shippingBase.overnight = n;
        break;
      case "priority.sla_default_days":
        slaDefaultDays = n;
        break;
    }
  }

  return { shippingBase, slaDefaultDays };
}

export async function upsertPickPrioritySetting(
  key: string,
  value: number,
  type: string = "number",
  database: Pick<typeof db, "execute"> = db,
): Promise<void> {
  await database.execute(sql`
    INSERT INTO warehouse.echelon_settings (key, value, type, category, description)
    VALUES (${key}, ${String(value)}, ${type}, 'pick_priority', NULL)
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = now()
  `);
}
