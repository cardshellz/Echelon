import type { PoolClient } from "pg";
import { z } from "zod";
import { assemblyVariantLabelSchema } from "@shared/warehouse-assembly-execution";

/** Catalog labels only; canonical plans remain the quantity/recipe authority. */
export async function readAssemblyVariantLabels(client: PoolClient, rawIds: readonly number[]) {
  const ids = z.array(z.number().int().positive()).max(1000).parse([...new Set(rawIds)]);
  const rows = await client.query(`SELECT id AS "variantId", sku, name FROM catalog.product_variants WHERE id=ANY($1::integer[]) ORDER BY id`, [ids]);
  return z.array(assemblyVariantLabelSchema).max(1000).parse(rows.rows);
}
