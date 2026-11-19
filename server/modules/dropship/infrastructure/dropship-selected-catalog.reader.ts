import type { PoolClient } from "pg";
import type { DropshipListingPreviewRepository } from "../application/dropship-listing-preview-service";
import type { SelectedCatalogReader } from "../application/dropship-selected-catalog";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";

/**
 * The sizes a vendor could sell: shipped, stock-tracked and sellable. The
 * selected-catalog scan joins it to the vendor's picks; the arrivals ledger
 * walks it whole (listSellableVariantIdsAfter) and its "new for a vendor"
 * read keeps only sizes that still pass it (dropship-catalog-arrivals.repository.ts).
 * Binds the alias `pv` (catalog.product_variants).
 */
export const SELLABLE_VARIANT_SQL = `pv.requires_shipping = true
       AND COALESCE(pv.track_inventory, true) = true AND pv.sales_eligibility = 'sellable'`;

/**
 * The catalog reads a selected-catalog scan needs, bound to one transaction's
 * client and one vendor. Shared by the pricing-rules, eBay category,
 * listing-settings, listing-setting writes, rules-conversion, category-marks,
 * publish-run, run-sweep and selection-summary repositories. `listVariantIds`
 * is a keyset over the vendor's picks (the primary key `(vendor_id,
 * product_variant_id)`), joined to the sellable filter, so a scan reads
 * O(selected) rows and never yields a size the vendor did not pick
 * (PLAN-B v4.1 §9 row 3; FIDELITY-3).
 */
export function selectedCatalogReaderForTransaction(
  client: Pick<PoolClient, "query">,
  vendorId: number,
): Omit<SelectedCatalogReader, "catalog"> & { catalog: DropshipListingPreviewRepository } {
  return {
    vendorId,
    catalog: PgDropshipListingPreviewRepository.readerForTransaction(client),
    listProductLines: async (ids) => (await client.query<{ id: number; name: string }>(
      "SELECT id, name FROM catalog.product_lines WHERE id = ANY($1::int[]) ORDER BY name, id", [ids])).rows,
    listVariantIds: async (afterId, limit) => (await client.query<{ id: number }>(
      `SELECT s.product_variant_id AS id FROM dropship.dropship_vendor_selected_variants s
       INNER JOIN catalog.product_variants pv ON pv.id = s.product_variant_id
       WHERE s.vendor_id = $1 AND s.product_variant_id > $2 AND ${SELLABLE_VARIANT_SQL}
       ORDER BY s.product_variant_id LIMIT $3`, [vendorId, afterId, limit])).rows.map((row) => row.id),
  };
}

/**
 * Every sellable size after `afterId`, ascending, whoever picked it: the
 * selected-catalog scan's former keyset, kept for the catalog arrivals ledger
 * only (PLAN-B v4.1 §9 row 3, §11.1; SAFETY-1), which must see sizes no
 * vendor picked yet. No selection reader may call it.
 */
export async function listSellableVariantIdsAfter(client: Pick<PoolClient, "query">, afterId: number,
  limit: number): Promise<number[]> {
  return (await client.query<{ id: number }>(
    `SELECT pv.id FROM catalog.product_variants pv WHERE pv.id > $1 AND ${SELLABLE_VARIANT_SQL} ORDER BY pv.id LIMIT $2`,
    [afterId, limit])).rows.map((row) => row.id);
}
