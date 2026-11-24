import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

/** Transaction-scoped catalog identity; no default/global connection. */
export async function readVariantProductIdentity(tx: { execute(query: SQL): Promise<{ rows: unknown[] }> }, variantId: number): Promise<number> {
  const id = z.number().int().positive().max(2_147_483_647).parse(variantId);
  const rows = (await tx.execute(sql`SELECT product_id AS "productId" FROM catalog.product_variants WHERE id=${id} FOR SHARE`)).rows;
  return z.array(z.object({ productId: z.number().int().positive() })).length(1).parse(rows)[0].productId;
}
