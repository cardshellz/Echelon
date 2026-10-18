import { z } from "zod";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import { VARIANT_SALES_ELIGIBILITIES } from "@shared/catalog/variant-sales-eligibility";

const id = z.number().int().positive().max(2_147_483_647);
const inputSchema = z.object({ productId: id, productVariantIds: z.array(id) }).strict();
const productSchema = z.object({
  id, isActive: z.boolean(), status: z.string().nullable(), productType: z.string().nullable(),
  category: z.string().nullable(), ebayListingExcluded: z.boolean().nullable(), productLineIds: z.array(id),
});
const variantSchema = z.object({
  id, productId: id, sku: z.string().nullable(), uomType: z.string(), isActive: z.boolean(),
  requiresShipping: z.boolean().nullable(), trackInventory: z.boolean().nullable(),
  salesEligibility: z.enum(VARIANT_SALES_ELIGIBILITIES).nullable(), ebayListingExcluded: z.boolean().nullable(),
});
export interface CatalogStockSelectionFacts {
  product: z.infer<typeof productSchema> | null;
  variants: z.infer<typeof variantSchema>[];
}

export async function readCatalogStockVariantOwners(client: StockSelectionQueryClient, variantIds: readonly number[]) {
  const ids = z.array(id).parse(variantIds);
  return z.array(z.object({ id, productId: id })).parse((await client.query(
    'SELECT id,product_id AS "productId" FROM catalog.product_variants WHERE id=ANY($1::integer[]) ORDER BY id', [ids])).rows);
}

/** Complete product scope for a caller that must detect omitted saved members. */
export async function readCatalogStockProductVariantIds(client: StockSelectionQueryClient, productId: number): Promise<number[]> {
  return z.array(z.object({ id })).parse((await client.query(
    "SELECT id FROM catalog.product_variants WHERE product_id=$1 ORDER BY id", [id.parse(productId)])).rows).map(row => row.id);
}

/** Catalog owns these lifecycle/identity facts; callers own the decision to list.
 * A requested ID from another product is not silently reassigned to this product. */
export async function readCatalogStockSelectionFacts(client: StockSelectionQueryClient,
  raw: { productId: number; productVariantIds: readonly number[] }): Promise<CatalogStockSelectionFacts> {
  const input = inputSchema.parse(raw);
  const product = (await client.query(`SELECT p.id,p.is_active AS "isActive",p.status,p.product_type AS "productType",p.category,
    p.ebay_listing_excluded AS "ebayListingExcluded",ARRAY(SELECT product_line_id FROM catalog.product_line_products
      WHERE product_id=p.id ORDER BY product_line_id) AS "productLineIds" FROM catalog.products p WHERE p.id=$1`, [input.productId])).rows[0];
  if (!product) return { product: null, variants: [] };
  const variants = input.productVariantIds.length ? (await client.query(`SELECT id,product_id AS "productId",sku,uom_type AS "uomType",is_active AS "isActive",
    requires_shipping AS "requiresShipping",track_inventory AS "trackInventory",sales_eligibility AS "salesEligibility",
    ebay_listing_excluded AS "ebayListingExcluded" FROM catalog.product_variants WHERE product_id=$1 AND id=ANY($2::integer[]) ORDER BY id`,
  [input.productId, [...new Set(input.productVariantIds)]])).rows : [];
  return { product: productSchema.parse(product), variants: z.array(variantSchema).parse(variants) };
}
