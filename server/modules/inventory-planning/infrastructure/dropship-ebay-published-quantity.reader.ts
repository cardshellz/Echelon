import type { Pool } from "pg";
import { z } from "zod";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";

const inputSchema = z.object({
  storeConnectionId: z.number().int().positive().max(2_147_483_647),
  productVariantIds: z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(500),
  excludeLeased: z.boolean(),
}).strict();

/** Outbox states whose quantity eBay confirmed (acknowledged) or a read-back proved (verified). */
const SETTLED_STATES: readonly string[] = Object.freeze(["acknowledged", "verified"]);

/**
 * What inventory planning last published to one Dropship eBay store, per size
 * (Dropship eBay sync-back's quantity baseline under canonical authority,
 * plan v4 §6.4 "B"): the newest outbox row by desired revision on the store's
 * live Card Shellz destination, its desired quantity and state, and when it
 * settled (verified, else acknowledged; null while it is not settled). A size
 * with no row on a live destination is absent from the answer.
 *
 * A row that never reached eBay is skipped: not settled, not being written,
 * and every quantity admission attempt of it proved no request was sent
 * (`not_sent`, owner_preflight_no_request). Such a row cannot have changed
 * eBay, so it is no baseline (the Dropship transport's pre-write quantity
 * guard refuses a row this way while the vendor's lower number is decided,
 * review OR-2). `excludeLeased` also skips the row being written now: the
 * transport's own view before its write.
 *
 * Read-only: one statement on the pool, no lock. Dropship reads it through
 * quantity-publication.ts and decides nothing about quantity on a row that is
 * not settled. The quantity is a bigint column: a value past 2^53 is refused,
 * never rounded.
 */
export interface DropshipEbayPublishedQuantity {
  productVariantId: number;
  desiredQuantity: number;
  state: string;
  settledAt: Date | null;
}

export async function readDropshipEbayPublishedQuantities(pool: Pick<Pool, "query">,
  raw: { storeConnectionId: number; productVariantIds: readonly number[]; excludeLeased?: boolean }): Promise<DropshipEbayPublishedQuantity[]> {
  const input = inputSchema.parse({ storeConnectionId: raw.storeConnectionId, productVariantIds: [...new Set(raw.productVariantIds)],
    excludeLeased: raw.excludeLeased ?? false });
  const result = await pool.query<{
    product_variant_id: number; desired_quantity: string; state: string; verified_at: Date | null; acknowledged_at: Date | null;
  }>(`SELECT DISTINCT ON (outbox.product_variant_id) outbox.product_variant_id, outbox.desired_quantity::text AS desired_quantity,
      outbox.state, outbox.verified_at, outbox.acknowledged_at
    FROM inventory.inventory_publication_outbox outbox
    JOIN inventory.inventory_publication_targets target ON target.id = outbox.publication_target_id
    WHERE target.destination_kind = 'dropship_store_connection' AND target.dropship_store_connection_id = $1
      AND target.state = 'live' AND target.publication_authority = 'echelon'
      AND outbox.dropship_store_connection_id_snapshot = $1
      AND outbox.product_variant_id = ANY($2::int[])
      AND NOT ($3::boolean AND outbox.state = 'leased')
      AND NOT (outbox.state NOT IN ('acknowledged', 'verified', 'leased')
        AND EXISTS (SELECT 1 FROM inventory.quantity_publication_attempts attempt WHERE attempt.outbox_id = outbox.id)
        AND NOT EXISTS (SELECT 1 FROM inventory.quantity_publication_attempts attempt
          WHERE attempt.outbox_id = outbox.id AND attempt.state <> 'not_sent'))
    ORDER BY outbox.product_variant_id, outbox.desired_revision DESC, outbox.id DESC`,
  [input.storeConnectionId, input.productVariantIds, input.excludeLeased]);
  return result.rows.map((row) => {
    const desiredQuantity = Number(row.desired_quantity);
    if (!Number.isSafeInteger(desiredQuantity) || desiredQuantity < 0) {
      throw new InventoryAvailabilityMasterDataError(500, "DROPSHIP_PUBLISHED_QUANTITY_INVALID",
        "A published dropship quantity is not a safe whole number.", [`productVariantId:${row.product_variant_id}`]);
    }
    const settled = SETTLED_STATES.includes(row.state);
    return {
      productVariantId: row.product_variant_id,
      desiredQuantity,
      state: row.state,
      settledAt: settled ? row.verified_at ?? row.acknowledged_at ?? null : null,
    };
  });
}
