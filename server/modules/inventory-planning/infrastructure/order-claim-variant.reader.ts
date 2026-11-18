import type { Pool } from "pg";
import { z } from "zod";

const orderIdSchema = z.number().int().positive().max(2_147_483_647);
const rowSchema = z.object({ variant_id: z.number().int().positive() });

/**
 * Every SKU an order's claims touch: the SKU sold on each line and the SKU the
 * stock was taken from (they differ when a case is broken into packs). Released
 * and superseded claims are included, because giving stock back changes what the
 * channels may show just as taking it does.
 */
export class PostgresOrderClaimVariantReader {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async listClaimedVariantIds(orderIds: readonly number[]): Promise<number[]> {
    const ids = [...new Set(orderIds.map(id => orderIdSchema.parse(id)))];
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT variant_id FROM (
         SELECT line.target_variant_id AS variant_id
           FROM inventory.availability_claims claim
           JOIN inventory.availability_claim_lines line ON line.claim_id = claim.id
          WHERE claim.order_id = ANY($1::integer[])
         UNION
         SELECT resource.source_variant_id
           FROM inventory.availability_claims claim
           JOIN inventory.availability_claim_resources resource ON resource.claim_id = claim.id
          WHERE claim.order_id = ANY($1::integer[])
       ) touched ORDER BY variant_id`,
      [ids],
    );
    return z.array(rowSchema).parse(result.rows).map(row => row.variant_id);
  }
}
