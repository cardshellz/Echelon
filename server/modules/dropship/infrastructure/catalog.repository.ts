import { pool } from "../../../db";
import { DropshipError } from "../domain/errors";

export interface CatalogVariantRow {
  productId: number;
  variantId: number;
  sku: string;
  name: string;
  retailPriceCents: number;
  atpUnits: number;
  imageUrl: string | null;
}

export class CatalogRepository {
  /**
   * Safely retrieves all catalog variants strictly eligible for Dropship distribution.
   * Ensures physical inventory constraints prevent negative Available To Promise parameters lockups.
   */
  static async getEligibleDropshipCatalog(): Promise<CatalogVariantRow[]> {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          p.id as product_id,
          pv.id as variant_id,
          pv.sku,
          p.name as product_name,
          pv.name as variant_name,
          pv.price_cents,
          (
            SELECT COALESCE(SUM(quantity), 0)
            FROM wms_inventory
            WHERE variant_id = pv.id AND location_id IN (SELECT id FROM wms_locations WHERE is_pickable = true)
          ) - (
            SELECT COALESCE(SUM(quantity), 0)
            FROM wms_order_allocations
            WHERE variant_id = pv.id AND status = 'allocated'
          ) as atp_units,
          (
            SELECT url FROM catalog.product_assets 
            WHERE product_id = p.id ORDER BY position ASC LIMIT 1
          ) as image_url
        FROM catalog.products p
        JOIN product_variants pv ON pv.product_id = p.id
        WHERE p.is_active = true 
          AND pv.is_active = true 
          AND p.tags ? 'dropship_eligible'
        ORDER BY p.name ASC, pv.position ASC
      `);

      return result.rows.map((row: any) => ({
        productId: row.product_id,
        variantId: row.variant_id,
        sku: row.sku,
        name: row.variant_name ? `${row.product_name} - ${row.variant_name}` : row.product_name,
        retailPriceCents: parseInt(row.price_cents, 10),
        atpUnits: Math.max(0, parseInt(row.atp_units, 10)),
        imageUrl: row.image_url
      }));
    } catch (e: any) {
      throw new DropshipError("DB_CATALOG_ERROR", "Failed to durably resolve underlying product grids.", { detail: e.message });
    } finally {
      client.release();
    }
  }
}
