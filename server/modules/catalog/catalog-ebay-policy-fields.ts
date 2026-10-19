import type { PoolClient } from "pg";
import { z } from "zod";
import {
  EbayBusinessPolicyError,
  ebayPolicyValuesSchema,
  type EbayPolicyValues,
} from "@shared/ebay-business-policies";

/** Persistence for the legacy Catalog columns. Channels owns policy selection,
 * provider validation and audit orchestration; Catalog remains their only SQL
 * writer. The caller supplies its transaction so the audit rolls back with it. */
const columns =
  'ebay_fulfillment_policy_override AS "fulfillmentPolicyId", ebay_return_policy_override AS "returnPolicyId", ebay_payment_policy_override AS "paymentPolicyId"';
const identity = z.number().int().positive().max(2147483647);
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("product"), productId: identity }).strict(),
  z.object({ kind: z.literal("variant"), variantId: identity }).strict(),
]);
export type CatalogEbayPolicyTarget = z.infer<typeof targetSchema>;

function missingTarget(): never {
  throw new EbayBusinessPolicyError(
    "EBAY_POLICY_TARGET_NOT_FOUND",
    "The product or variant no longer exists. Refresh the listing.",
    404,
  );
}

export async function readCatalogEbayPolicyFields(
  client: PoolClient,
  target: CatalogEbayPolicyTarget,
): Promise<EbayPolicyValues> {
  const parsed = targetSchema.parse(target);
  const table =
    parsed.kind === "product" ? "catalog.products" : "catalog.product_variants";
  const id = parsed.kind === "product" ? parsed.productId : parsed.variantId;
  const result = await client.query(
    `SELECT ${columns} FROM ${table} WHERE id=$1 FOR UPDATE`,
    [id],
  );
  if (result.rows.length !== 1) return missingTarget();
  return ebayPolicyValuesSchema.parse(result.rows[0]);
}

export async function writeCatalogEbayPolicyFields(
  client: PoolClient,
  target: CatalogEbayPolicyTarget,
  policies: EbayPolicyValues,
  now: Date,
): Promise<void> {
  const parsed = targetSchema.parse(target);
  const table =
    parsed.kind === "product" ? "catalog.products" : "catalog.product_variants";
  const id = parsed.kind === "product" ? parsed.productId : parsed.variantId;
  const values = ebayPolicyValuesSchema.parse(policies);
  const result = await client.query(
    `UPDATE ${table} SET ebay_fulfillment_policy_override=$2,ebay_return_policy_override=$3,ebay_payment_policy_override=$4,updated_at=$5 WHERE id=$1`,
    [
      id,
      values.fulfillmentPolicyId,
      values.returnPolicyId,
      values.paymentPolicyId,
      z.date().parse(now),
    ],
  );
  if (result.rowCount !== 1) missingTarget();
}

export async function readCatalogEbayPolicySelection(
  client: PoolClient,
  productId: number,
  variantIds: readonly number[],
): Promise<{
  productTypeSlug: string | null;
  product: EbayPolicyValues;
  variants: { variantId: number; policies: EbayPolicyValues }[];
}> {
  identity.parse(productId);
  z.array(identity).min(1).max(500).parse(variantIds);
  const product = await client.query(
    `SELECT product_type,${columns} FROM catalog.products WHERE id=$1 FOR SHARE`,
    [productId],
  );
  if (product.rows.length !== 1) return missingTarget();
  const variants = await client.query(
    `SELECT id,${columns} FROM catalog.product_variants WHERE product_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR SHARE`,
    [productId, variantIds],
  );
  if (variants.rows.length !== variantIds.length)
    throw new EbayBusinessPolicyError(
      "EBAY_POLICY_SCOPE_CHANGED",
      "The listing's variants changed. Refresh before publishing.",
      409,
    );
  const { product_type: productTypeSlug, ...productPolicies } = product.rows[0];
  return {
    productTypeSlug,
    product: ebayPolicyValuesSchema.parse(productPolicies),
    variants: variants.rows.map(({ id, ...policies }) => ({
      variantId: id,
      policies: ebayPolicyValuesSchema.parse(policies),
    })),
  };
}
