import type { Pool } from "pg";
import { z } from "zod";
import type { InventoryAvailabilityTransactionQueryClient } from "../application/inventory-availability-transaction-query.port";

/**
 * The one way a stock change reaches the channels: mark the product changed on
 * the durable publication work row (inventory.publication_selection_work). The
 * publication worker owns planning, provider handoff, retry and blocked-target
 * review. Warehouse operations never plan or publish themselves, so a broken
 * listing cannot fail a pick, shipment, count, receipt, transfer or release.
 *
 * The SQL function coalesces repeated marks in one transaction into one revision
 * and ignores products with no active listing mapping (nothing to publish).
 */
const productIdSchema = z.number().int().positive().max(2_147_483_647);

/** Waiting longer than this means the worker is planning this exact product; the
 * scheduled sweep republishes current quantities if a mark is ever missed. */
const MARK_LOCK_TIMEOUT = "5s";

export async function markPublicationProductChanged(
  client: InventoryAvailabilityTransactionQueryClient,
  productId: number,
): Promise<void> {
  await client.query("SELECT inventory.invalidate_publication_selection_product($1)", [productIdSchema.parse(productId)]);
}

/** For callers whose stock change already committed: one short transaction. */
export async function markPublicationProductsChanged(
  pool: Pick<Pool, "connect">,
  productIds: readonly number[],
): Promise<void> {
  const ids = [...new Set(productIds.map(id => productIdSchema.parse(id)))].sort((a, b) => a - b);
  if (ids.length === 0) return;
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout='${MARK_LOCK_TIMEOUT}'`);
    // Sorted ids give every concurrent marker the same row-lock order.
    for (const productId of ids) await markPublicationProductChanged(client, productId);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) {
      discard = true;
      throw new AggregateError([error, rollbackError], "Publication change mark rollback failed.");
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
