import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

const variantDisplay = z.object({
  variant_id: z.number().int().positive(), product_id: z.number().int().positive(),
  sku: z.string().nullable(), product_name: z.string(), base_sku: z.string().nullable(),
});
export type InventoryCostDisplay = z.infer<typeof variantDisplay>;

/** Published Catalog metadata read. Inventory owns quantities and valuation;
 * Catalog supplies identity/display fields, never a replacement price decision.
 */
export async function readInventoryCostDisplay(
  db: { execute(query: SQL): Promise<unknown> }, ids: readonly number[],
): Promise<InventoryCostDisplay[]> {
  const parsed = z.array(z.number().int().positive()).parse(ids);
  if (parsed.length === 0) return [];
  const result = await db.execute(sql`SELECT v.id AS variant_id,v.product_id,v.sku,
    p.name AS product_name,p.sku AS base_sku FROM catalog.product_variants v
    JOIN catalog.products p ON p.id=v.product_id
    WHERE v.id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(parsed)}::jsonb)) ORDER BY v.id`);
  const rows = result && typeof result === "object" ? (result as { rows?: unknown }).rows : undefined;
  return z.array(variantDisplay).parse(rows);
}
