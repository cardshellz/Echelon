import type { Pool, PoolClient } from "pg";
import { z } from "zod";

/**
 * The durable record that an operator reviewed an eBay listing update or rebuild that ADDS sizes
 * (channels.ebay_listing_change_intents, migration 900000065).
 *
 * Why it exists. Stock is sent to eBay only for a size Channels reports as selected, and both the stock link made
 * before the change and every quantity write during it re-read that selection from the database. A size being added
 * has no saved eBay identity until the change succeeds, so without this row it is never selected and the change is
 * refused before it starts. While a row is open, channel-stock-selection treats the size as selected, provided the
 * ordinary listing rules (active, sellable, not excluded) already allow it.
 *
 * Lifecycle. Opened before the stock link; closed `applied` once the listing identity is saved (that identity then
 * carries the selection); closed `refused` when the change stopped before anything was sent to eBay; closed
 * `superseded` when a different review of the same product opens. A change that failed after eBay writes began is
 * deliberately left open: the size may already be on the live listing, and it must keep receiving stock updates until
 * a later review applies or replaces it.
 */

const id = z.number().int().positive().max(2_147_483_647);
const memberSchema = z.object({ productVariantId: id, sku: z.string().trim().min(1).max(100) }).strict();
const openSchema = z.object({
  kind: z.enum(["listing_update", "listing_rebuild"]),
  channelId: id, connectionId: id, productId: id,
  externalListingId: z.string().trim().min(1).max(100),
  reviewToken: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.string().trim().min(1).max(200),
  members: z.array(memberSchema).min(1).max(250),
}).strict().refine(input => new Set(input.members.map(member => member.productVariantId)).size === input.members.length,
  "Each added size may appear once.");
const closeSchema = z.object({ channelId: id, productId: id, reviewToken: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.enum(["applied", "refused"]) }).strict();

export type OpenEbayListingChangeIntent = z.input<typeof openSchema>;
export type CloseEbayListingChangeIntent = z.input<typeof closeSchema>;

const LOCK_TIMEOUT = "5s";

export class EbayListingChangeIntentRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  /**
   * Records the reviewed additions. Idempotent: the same review opened twice leaves one open row per size. Any other
   * open row of this product (an earlier review, or a size this review no longer adds) is closed `superseded` in the
   * same transaction, so a product never carries intent from two reviews at once.
   */
  async open(raw: OpenEbayListingChangeIntent, now: Date): Promise<void> {
    const input = openSchema.parse(raw), at = z.date().parse(now);
    const variantIds = input.members.map(member => member.productVariantId);
    await this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`ebay-listing-change-intent:${input.channelId}:${input.productId}`]);
      await client.query(`UPDATE channels.ebay_listing_change_intents SET closed_at=$4, close_reason='superseded'
        WHERE channel_id=$1 AND product_id=$2 AND closed_at IS NULL
          AND (review_token<>$3 OR NOT (product_variant_id=ANY($5::integer[])))`,
      [input.channelId, input.productId, input.reviewToken, at, variantIds]);
      // The member must belong to the product: a size of another product can never be opened through this one.
      const inserted = await client.query(`INSERT INTO channels.ebay_listing_change_intents
          (channel_id,connection_id,product_id,product_variant_id,kind,external_listing_id,sku,review_token,actor,opened_at)
        SELECT $1,$2,$3,member.id,$4,$5,member.sku,$6,$7,$8
        FROM unnest($9::integer[],$10::text[]) AS member(id,sku)
        JOIN catalog.product_variants variant ON variant.id=member.id AND variant.product_id=$3
        ON CONFLICT (channel_id,product_variant_id) WHERE closed_at IS NULL DO NOTHING`,
      [input.channelId, input.connectionId, input.productId, input.kind, input.externalListingId, input.reviewToken,
        input.actor, at, variantIds, input.members.map(member => member.sku)]);
      const open = await client.query(`SELECT 1 FROM channels.ebay_listing_change_intents
        WHERE channel_id=$1 AND product_id=$2 AND review_token=$3 AND closed_at IS NULL AND product_variant_id=ANY($4::integer[])`,
      [input.channelId, input.productId, input.reviewToken, variantIds]);
      if (open.rowCount !== variantIds.length) {
        throw new EbayListingChangeIntentError("EBAY_LISTING_CHANGE_INTENT_NOT_RECORDED",
          "The reviewed listing change could not be recorded for every size it adds. Read eBay again and review the change.",
          { expected: variantIds.length, open: open.rowCount, inserted: inserted.rowCount });
      }
    });
  }

  /** Closes this review's open rows. Closing an already-closed or unknown review changes nothing. */
  async close(raw: CloseEbayListingChangeIntent, now: Date): Promise<number> {
    const input = closeSchema.parse(raw), at = z.date().parse(now);
    let closed = 0;
    await this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`ebay-listing-change-intent:${input.channelId}:${input.productId}`]);
      closed = (await client.query(`UPDATE channels.ebay_listing_change_intents SET closed_at=$4, close_reason=$5
        WHERE channel_id=$1 AND product_id=$2 AND review_token=$3 AND closed_at IS NULL`,
      [input.channelId, input.productId, input.reviewToken, at, input.reason])).rowCount ?? 0;
    });
    return closed;
  }

  private async transaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout='${LOCK_TIMEOUT}'`);
      await work(client);
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) {
        discard = true;
        throw new AggregateError([error, rollbackError], "Listing change intent rollback failed.");
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
}

export class EbayListingChangeIntentError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = "EbayListingChangeIntentError";
  }
}
