import type { PoolClient } from "pg";
import {
  listingPresenceSchema,
  type ListingPresence,
} from "@shared/types/channel-listing-presence";

export async function readListingPresence(
  client: PoolClient,
  accountKey: string,
  skus: readonly string[],
): Promise<ListingPresence[]> {
  const rows = await client.query<{
    sku: string;
    state: string;
    external_product_id: string | null;
    checked_at: Date;
  }>(
    "SELECT sku,state,external_product_id,checked_at FROM marketplace.channel_listing_presence WHERE account_key=$1 AND sku=ANY($2::text[]) ORDER BY sku",
    [accountKey, skus],
  );
  return rows.rows.map((row) =>
    listingPresenceSchema.parse({
      sku: row.sku,
      state: row.state,
      externalProductId: row.external_product_id,
      checkedAt: row.checked_at.toISOString(),
    }),
  );
}

/** Caller owns the exclusive account/SKU lifecycle lock. Failed reads never
 * reach this method. Observation and immutable audit commit atomically. */
export async function recordListingPresence(
  client: PoolClient,
  accountKey: string,
  observation: ListingPresence,
): Promise<ListingPresence> {
  const value = listingPresenceSchema.parse(observation);
  await client.query("BEGIN");
  try {
    const before =
      (await readListingPresence(client, accountKey, [value.sku]))[0] ?? null;
    if (before && before.checkedAt > value.checkedAt) {
      await client.query("COMMIT");
      return before;
    }
    const changed =
      !before ||
      before.state !== value.state ||
      before.externalProductId !== value.externalProductId;
    const saved = await client.query<{ version: string }>(
      `INSERT INTO marketplace.channel_listing_presence
      (account_key,sku,state,external_product_id,checked_at,version) VALUES($1,$2,$3,$4,$5,1)
      ON CONFLICT(account_key,sku) DO UPDATE SET state=EXCLUDED.state,external_product_id=EXCLUDED.external_product_id,
        checked_at=EXCLUDED.checked_at,version=channel_listing_presence.version+CASE WHEN $6 THEN 1 ELSE 0 END
      RETURNING version::text`,
      [
        accountKey,
        value.sku,
        value.state,
        value.externalProductId,
        value.checkedAt,
        changed,
      ],
    );
    if (changed)
      await client.query(
        `INSERT INTO marketplace.channel_listing_presence_events
      (account_key,sku,version,actor,before_state,after_state,occurred_at) VALUES($1,$2,$3,'walmart_listing_observation',$4,$5,$6)`,
        [
          accountKey,
          value.sku,
          saved.rows[0].version,
          before,
          value,
          value.checkedAt,
        ],
      );
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
