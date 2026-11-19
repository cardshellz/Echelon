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

/** One size's facts with its own product's (readCatalogStockSelectionFactsForVariants). */
export interface CatalogStockVariantFacts {
  product: z.infer<typeof productSchema>;
  variant: z.infer<typeof variantSchema>;
}

/**
 * The same facts as readCatalogStockSelectionFacts for sizes of any products,
 * each size with its own product, in one statement (the dropship selection
 * effects reader decides a save's touched sizes across products, PLAN-B v4.1
 * §7.7). A requested id with no catalog row is absent, as there. Ascending
 * by size id.
 */
export async function readCatalogStockSelectionFactsForVariants(client: StockSelectionQueryClient,
  variantIds: readonly number[]): Promise<CatalogStockVariantFacts[]> {
  const ids = [...new Set(z.array(id).parse(variantIds))];
  if (ids.length === 0) return [];
  const rows = (await client.query<Record<string, unknown>>(`${STOCK_VARIANT_FACTS_SELECT}
    WHERE pv.id=ANY($1::integer[]) ORDER BY pv.id`, [ids])).rows;
  return parseStockVariantFacts(rows);
}

/**
 * The same facts as readCatalogStockSelectionFactsForVariants for every size of these products, in one statement
 * (the dropship step 1 save decides which eBay listings a removal ends from every size of a removed product, PR C,
 * PLAN-C v4.1 §4.2). Ascending by size id; at most `maxSizes + 1` rows, so a caller that bounds the read sees an
 * overflow without reading every size of a very large product.
 */
export async function readCatalogStockSelectionFactsForProducts(client: StockSelectionQueryClient,
  productIds: readonly number[], options: { maxSizes: number }): Promise<CatalogStockVariantFacts[]> {
  const ids = [...new Set(z.array(id).parse(productIds))];
  const maxSizes = z.number().int().positive().max(1_000_000).parse(options.maxSizes);
  if (ids.length === 0) return [];
  const rows = (await client.query<Record<string, unknown>>(`${STOCK_VARIANT_FACTS_SELECT}
    WHERE pv.product_id=ANY($1::integer[]) ORDER BY pv.id LIMIT $2`, [ids, maxSizes + 1])).rows;
  return parseStockVariantFacts(rows);
}

/** One size with its own product's facts: the columns both multi-product reads return. */
const STOCK_VARIANT_FACTS_SELECT = `SELECT pv.id,pv.product_id AS "productId",pv.sku,
    pv.uom_type AS "uomType",pv.is_active AS "isActive",pv.requires_shipping AS "requiresShipping",
    pv.track_inventory AS "trackInventory",pv.sales_eligibility AS "salesEligibility",
    pv.ebay_listing_excluded AS "ebayListingExcluded",
    json_build_object('id',p.id,'isActive',p.is_active,'status',p.status,'productType',p.product_type,
      'category',p.category,'ebayListingExcluded',p.ebay_listing_excluded,
      'productLineIds',ARRAY(SELECT product_line_id FROM catalog.product_line_products
        WHERE product_id=p.id ORDER BY product_line_id)) AS product
    FROM catalog.product_variants pv INNER JOIN catalog.products p ON p.id=pv.product_id`;

function parseStockVariantFacts(rows: readonly Record<string, unknown>[]): CatalogStockVariantFacts[] {
  return rows.map(({ product, ...variant }) => ({ product: productSchema.parse(product), variant: variantSchema.parse(variant) }));
}
