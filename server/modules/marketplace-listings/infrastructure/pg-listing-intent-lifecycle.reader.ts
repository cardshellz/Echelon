import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  readChannelStockSelection,
  hasOutstandingEbayListingWork,
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
async function hasPendingContent(
  client: PoolClient,
  delivery: IntentDelivery,
): Promise<boolean> {
  const d = delivery.destination;
  if (d.kind === "channel" && d.provider === "ebay")
    return hasOutstandingEbayListingWork(client, {
      channelId: d.channelId!,
      connectionId: d.connectionId,
      productId: delivery.productId,
    });
  if (d.kind === "dropship")
    return (
      (
        await client.query(
          "SELECT 1 FROM dropship.dropship_listing_push_job_items i JOIN dropship.dropship_listing_push_jobs j ON j.id=i.job_id WHERE j.store_connection_id=$1 AND j.vendor_id=$2 AND i.product_variant_id=ANY($3::integer[]) AND i.status NOT IN ('completed','skipped','cancelled') LIMIT 1",
          [d.connectionId, d.vendorId, delivery.variantIds],
        )
      ).rows.length > 0
    );
  return (
    (
      await client.query(
        `SELECT 1 FROM marketplace.channel_listing_operations o WHERE o.account_key=$1 AND o.state<>'completed'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(o.progress->'items') item WHERE (item->>'variantId')::int=ANY($2::int[]))
    UNION ALL SELECT 1 FROM marketplace.channel_listing_updates u WHERE u.account_key=$1 AND u.state<>'accepted'
    AND u.sku IN (SELECT external_sku FROM channels.channel_listings WHERE channel_id=$3 AND product_variant_id=ANY($2::int[])) LIMIT 1`,
        [
          canonicalJson([
            d.provider,
            d.marketplaceId ?? "shop",
            d.environment,
            d.accountId,
          ]),
          delivery.variantIds,
          d.channelId,
        ],
      )
    ).rows.length > 0
  );
}

export class PostgresListingIntentLifecycleReader implements ListingIntentLifecycleReader {
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  async inspect(delivery: IntentDelivery, now: Date) {
    if (
      delivery.variantIds.length > 250 ||
      !["ebay", "shopify", "walmart"].includes(delivery.destination.provider)
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
            productId: delivery.productId,
            productVariantIds: members,
          })
        : [];
      const pendingContent = await hasPendingContent(client, delivery);
      const result = {
        selection,
        accountId: d.accountId!,
        retainedVariantIds: delivery.variantIds,
        retirements,
        stock,
        pendingContent,
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
