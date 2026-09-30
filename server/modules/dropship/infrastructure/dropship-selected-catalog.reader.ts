import type { PoolClient } from "pg";
import type { DropshipListingPreviewRepository } from "../application/dropship-listing-preview-service";
import type { SelectedCatalogReader } from "../application/dropship-selected-catalog";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";

/**
 * The catalog reads a selected-catalog scan needs, bound to one transaction's
 * client. Shared by the pricing-rules, content and eBay category repositories.
 */
export function selectedCatalogReaderForTransaction(
  client: Pick<PoolClient, "query">,
): Omit<SelectedCatalogReader, "vendorId" | "catalog"> & { catalog: DropshipListingPreviewRepository } {
  return {
    catalog: PgDropshipListingPreviewRepository.readerForTransaction(client),
    listProductLines: async (ids) => (await client.query<{ id: number; name: string }>(
      "SELECT id, name FROM catalog.product_lines WHERE id = ANY($1::int[]) ORDER BY name, id", [ids])).rows,
    listVariantIds: async (afterId, limit) => (await client.query<{ id: number }>(
      `SELECT id FROM catalog.product_variants WHERE id > $1 AND requires_shipping = true
       AND COALESCE(track_inventory, true) = true AND sales_eligibility = 'sellable' ORDER BY id LIMIT $2`, [afterId, limit])).rows.map((row) => row.id),
  };
}
