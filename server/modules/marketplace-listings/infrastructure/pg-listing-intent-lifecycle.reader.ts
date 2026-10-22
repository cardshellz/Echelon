import type { Pool, PoolClient } from "pg";
import { hasListingWorkObligation } from "../domain/listing-work-obligation";
import type { ListingContentWork } from "../domain/listing-intent-lifecycle";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  readChannelStockSelection,
  readOutstandingEbayListingWork,
} from "../../channels/channel-stock-selection";
import { readDropshipListingStockSelection } from "../../dropship/stock-publication-selection";
import {
  readStockClearingEvidence,
  fenceStockClearingEvidence,
} from "../../inventory-planning/stock-clearing-evidence";
import { readListingMemberRetirements } from "./pg-listing-member-lifecycle.repository";
import { managedTargets } from "./pg-listing-intent-propagation.repository";
import type { ListingIntentLifecycleReader } from "../application/listing-intent-lifecycle.service";
import type { IntentDelivery } from "../domain/listing-intent-propagation";

async function lockIdentitySources(
  client: PoolClient,
  delivery: IntentDelivery,
): Promise<void> {
  // Identity projection writes are not selection changes. Pin their source
  // rows as well, so one observation cannot mix two account/mapping versions.
  const scope = delivery.destination;
  if (scope.kind === "channel") {
    await client.query(
      "SELECT id FROM channels.channel_connections WHERE channel_id=$1 FOR SHARE",
      [scope.channelId],
    );
    if (scope.provider === "ebay")
      await client.query(
        "SELECT channel_id FROM ebay.ebay_oauth_tokens WHERE channel_id=$1 FOR SHARE",
        [scope.channelId],
      );
    if (scope.provider === "walmart")
      await client.query(
        "SELECT channel_id FROM channels.walmart_connections WHERE channel_id=$1 FOR SHARE",
        [scope.channelId],
      );
    await client.query(
      "SELECT id FROM channels.channel_listings WHERE channel_id=$1 AND product_variant_id=ANY($2::int[]) FOR SHARE",
      [scope.channelId, delivery.variantIds],
    );
    await client.query(
      "SELECT product_variant_id FROM channels.channel_feeds WHERE channel_id=$1 AND product_variant_id=ANY($2::int[]) FOR SHARE",
      [scope.channelId, delivery.variantIds],
    );
  } else {
    await client.query(
      "SELECT id FROM dropship.dropship_store_connections WHERE id=$1 FOR SHARE",
      [scope.connectionId],
    );
    await client.query(
      "SELECT id FROM dropship.dropship_vendor_listings WHERE store_connection_id=$1 AND product_variant_id=ANY($2::int[]) FOR SHARE",
      [scope.connectionId, delivery.variantIds],
    );
  }
}

/** Thin read adapters retain provider execution status with its existing owner. */
async function readContentWork(
  client: PoolClient,
  delivery: IntentDelivery,
): Promise<ListingContentWork[]> {
  const d = delivery.destination;
  if (d.kind === "channel" && d.provider === "ebay")
    return (await readOutstandingEbayListingWork(client, {
      channelId: d.channelId!, connectionId: d.connectionId, productId: delivery.productId,
    })).map(row => ({ state: row.state === "needs_attention" ? "attention" : "pending",
      action: { owner: "ebay_listing_sync", operationId: row.id } }));
  if (d.kind === "dropship") {
    const rows = await client.query<{id:string;status:string}>(`SELECT j.id::text,i.status
      FROM dropship.dropship_listing_push_job_items i JOIN dropship.dropship_listing_push_jobs j ON j.id=i.job_id
      WHERE j.store_connection_id=$1 AND j.vendor_id=$2 AND i.product_variant_id=ANY($3::integer[])`,
      [d.connectionId,d.vendorId,delivery.variantIds]);
    return rows.rows.flatMap(row => {
      const phase = ["completed","skipped","cancelled"].includes(row.status) ? "completed"
        : ["failed","error","blocked"].includes(row.status) ? "attention" : "pending";
      return hasListingWorkObligation(phase) ? [{ state: phase === "attention" ? "attention" as const : "pending" as const,
        action: { owner: "dropship_listing_push" as const, operationId: row.id } }] : [];
    });
  }
  const rows = await client.query<{id:string;state:string;owner:"channel_listing_publication"|"channel_listing_update"}>(
    `SELECT o.id::text,o.state,'channel_listing_publication' owner FROM marketplace.channel_listing_operations o WHERE o.account_key=$1
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(o.progress->'items') item WHERE (item->>'variantId')::int=ANY($2::int[]))
    UNION ALL SELECT u.id::text,u.state,'channel_listing_update' FROM marketplace.channel_listing_updates u WHERE u.account_key=$1
      AND u.sku IN (SELECT external_sku FROM channels.channel_listings WHERE channel_id=$3 AND product_variant_id=ANY($2::int[]))`,
    [canonicalJson([d.provider,d.marketplaceId ?? "shop",d.environment,d.accountId]),delivery.variantIds,d.channelId]);
  return rows.rows.flatMap(row => {
    const phase = row.state === "reviewed" ? "unsubmitted"
      : ["accepted","completed"].includes(row.state) ? "completed"
      : ["needs_attention","uncertain"].includes(row.state) ? "attention" : "pending";
    return hasListingWorkObligation(phase) ? [{ state: phase === "attention" ? "attention" as const : "pending" as const,
      action: { owner: row.owner, operationId: row.id } }] : [];
  });
}

export class PostgresListingIntentLifecycleReader implements ListingIntentLifecycleReader {
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  async inspect(delivery: IntentDelivery, now: Date) {
    const provider = delivery.destination.provider;
    if (
      delivery.variantIds.length > 250 ||
      (provider !== "ebay" && provider !== "shopify" && provider !== "walmart")
    )
      return null; // Existing scoped handoff still owns its size limit.
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='250ms'");
      await fenceStockClearingEvidence(client);
      await lockIdentitySources(client, delivery);
      // Read current owner projections under the same selection/publication fence.
      // A missing retained mapping or changed account is never evidence of exclusion.
      const d = delivery.destination;
      const destinations = await managedTargets(
        client,
        [
          {
            productId: delivery.productId,
            ...(d.kind === "channel"
              ? { channelId: d.channelId! }
              : { storeConnectionId: d.connectionId }),
          },
        ],
        "",
        10,
      );
      const exact = destinations.filter(
        (row) => canonicalJson(row.destination) === canonicalJson(d),
      );
      if (
        exact.length !== 1 ||
        canonicalJson(exact[0].variant_ids) !==
          canonicalJson([...delivery.variantIds].sort((a, b) => a - b))
      ) {
        const error = new Error(
          "The retained listing scope or account changed; review its original destination.",
        );
        Object.assign(error, {
          code: "LISTING_INTENT_LIFECYCLE_SCOPE_CHANGED",
        });
        throw error;
      }
      const selection =
        d.kind === "channel"
          ? await readChannelStockSelection(client, {
              channelId: d.channelId!,
              channelConnectionId: d.connectionId,
              productId: delivery.productId,
              productVariantIds: delivery.variantIds,
            })
          : await readDropshipListingStockSelection(client, {
              storeConnectionId: d.connectionId,
              productId: delivery.productId,
              productVariantIds: delivery.variantIds,
              now,
            });
      if (selection.variants.some((row) => row.listingSelected !== false)) {
        await client.query("COMMIT");
        return null;
      }
      const destinationKind =
        d.kind === "channel"
          ? ("channel_connection" as const)
          : ("dropship_store_connection" as const);
      const retirements = (
        await readListingMemberRetirements(client, {
          destinationKind,
          connectionId: d.connectionId,
          productVariantIds: delivery.variantIds,
        })
      ).filter(
        (row) =>
          row.identity.accountId === d.accountId &&
          row.identity.environment === d.environment &&
          (d.marketplaceId === null || row.identity.market === d.marketplaceId),
      );
      const members = selection.variants.map((row) => row.productVariantId);
      const stock = members.length
        ? await readStockClearingEvidence(client, {
            destinationKind,
            connectionId: d.connectionId,
            accountId: d.accountId!,
            providerKey: provider,
            productId: delivery.productId,
            productVariantIds: members,
          })
        : [];
      const contentWork = await readContentWork(client, delivery);
      const result = {
        selection,
        accountId: d.accountId!,
        retainedVariantIds: delivery.variantIds,
        retirements,
        stock,
        contentWork,
        now,
      };
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
}
