import type { Pool } from "pg";
import { z } from "zod";
import { inShortStockLinkTransaction } from "./stock-link-checks.repository";

/**
 * The stock-link engine's nudge (channels PR4, PLAN-CH-v3 §3.1 "Nudges"): a channel owner saw something that may make a
 * size linkable now (Walmart's scan saw the item PUBLISHED; a Card Shellz eBay Sync finished read-only), so those sizes'
 * check rows are due now on every live, Echelon-managed target of that channel connection. A size without a row gets
 * one (`linked` when its head already has an active link, else `waiting`), as discovery would add it. No fence, no lock
 * beyond the rows' own, no provider I/O, never a link: the engine's next tick decides from the store.
 *
 * A row another claim holds, a row stopped on an error (Check again releases it) and a row already due are left as they
 * are. Returns the sizes whose row is now due, in id order.
 */

const id = z.number().int().positive().max(2_147_483_647);
const nudgeSchema = z.object({
  channelConnectionId: id,
  productVariantIds: z.array(id).min(1).max(500),
}).strict();

export type StockLinkNudge = z.input<typeof nudgeSchema>;

export async function requestStockLinkChecks(pool: Pick<Pool, "connect">, raw: StockLinkNudge, now: Date): Promise<number[]> {
  const input = nudgeSchema.parse(raw);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("A stock-link nudge needs a valid clock time.");
  const variantIds = [...new Set(input.productVariantIds)].sort((a, b) => a - b);
  return inShortStockLinkTransaction(pool, async client => (await client.query<{ product_variant_id: number }>(`
    WITH targets AS (
      SELECT t.id FROM inventory.inventory_publication_targets t
      WHERE t.destination_kind = 'channel_connection' AND t.channel_connection_id = $1
        AND t.state = 'live' AND t.publication_authority = 'echelon'
    ), sizes AS (
      SELECT v.id FROM catalog.product_variants v WHERE v.id = ANY($2::integer[]) ORDER BY v.id FOR KEY SHARE
    )
    INSERT INTO inventory.stock_link_checks AS c(publication_target_id, product_variant_id, status, next_check_at, created_at, updated_at)
    SELECT t.id, s.id, CASE WHEN h.active_mapping_id IS NULL THEN 'waiting' ELSE 'linked' END, $3, $3, $3
    FROM targets t CROSS JOIN sizes s
    LEFT JOIN inventory.publication_variant_mapping_heads h ON h.publication_target_id = t.id AND h.product_variant_id = s.id
    ORDER BY t.id, s.id
    ON CONFLICT (publication_target_id, product_variant_id) DO UPDATE
      SET next_check_at = $3, updated_at = $3, revision = c.revision + 1
      WHERE c.status <> 'error' AND (c.lease_token IS NULL OR c.lease_expires_at <= $3) AND c.next_check_at > $3
    RETURNING c.product_variant_id`, [input.channelConnectionId, variantIds, now])).rows
    .map(row => Number(row.product_variant_id)).filter((value, index, all) => all.indexOf(value) === index).sort((a, b) => a - b));
}
