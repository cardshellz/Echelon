import { sql } from "drizzle-orm";
import { projectShipmentUnits, type ShipmentCatalogUnit, type ShipmentUnitSource } from "./domain/shipment-unit-selection";
import type { ShipmentUnits } from "@shared/procurement/shipment-unit-selection";
export async function readShipmentUnitOptions(executor: any, sources: readonly (ShipmentUnitSource & { key: number })[], options: { lock?: boolean } = {}): Promise<Map<number, ShipmentUnits>> {
  const productIds = [...new Set(sources.flatMap((source) => source.productId == null ? [] : [source.productId]))];
  let rows: ShipmentCatalogUnit[] = [];
  if (productIds.length) {
    const ids = sql.join(productIds.map((id) => sql`${id}`), sql`, `);
    const result = await executor.execute(sql`
      SELECT id, product_id AS "productId", sku, name, units_per_variant AS "unitsPerVariant", is_active AS "isActive"
      FROM catalog.product_variants WHERE product_id = ANY(ARRAY[${ids}]::integer[]) ORDER BY product_id, id LIMIT 10001 ${options.lock ? sql`FOR SHARE` : sql``}
    `);
    if (!Array.isArray(result.rows)) throw new Error("Shipment unit options query returned invalid evidence");
    if (result.rows.length > 10000) throw new Error("Shipment catalog options exceed the bounded review limit");
    rows = result.rows;
  }
  return new Map(sources.map((source) => [source.key, projectShipmentUnits(source, rows)]));
}
/** Called after the graph/shipment/PO source locks. The row remains stable until commit. */
export async function lockShipmentCatalogUnit(tx: any, variantId: number): Promise<ShipmentCatalogUnit | null> {
  const result = await tx.execute(sql`
    SELECT id, product_id AS "productId", sku, name, units_per_variant AS "unitsPerVariant", is_active AS "isActive"
    FROM catalog.product_variants WHERE id = ${variantId} FOR SHARE
  `);
  if (!Array.isArray(result.rows)) throw new Error("Shipment unit query returned invalid evidence");
  return result.rows[0] ?? null;
}
