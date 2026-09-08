import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { ChannelQuantityPublicationTarget } from "../channel-quantity-publication-target";
import { QuantityPublicationAdmissionError, quantityPublicationScopeSchema, type QuantityPublicationScope } from "../../inventory-planning/domain/quantity-publication-admission";

const databaseId = z.number().int().positive().max(2147483647);
const connectionRow = z.object({ channel_id: databaseId, provider: z.string(), status: z.string(),
  sync_enabled: z.boolean().nullable(), connection_count: z.number().int().nonnegative() });
const mappingRow = z.object({ product_id: databaseId, product_variant_id: databaseId });

/** Reads CURRENT legacy channel-owned mappings only. The caller supplies a
 * non-admitting expected-scope constraint; actual adapters acquire admission and
 * recheck the real connection/account/location/SKU before I/O. No historical canonical model,
 * catalog-wide SKU search, or stored quantity is a substitute for this mapping.
 */
export class PostgresChannelQuantityPublicationCatchupRepository {
  constructor(private readonly database: Pick<Pool, "connect">) {}

  async resolve(rawScope: unknown): Promise<ChannelQuantityPublicationTarget> {
    const parsed = quantityPublicationScopeSchema.safeParse(rawScope);
    if (!parsed.success) throw failure("PUBLICATION_CATCHUP_SCOPE_INVALID", "A valid exact quantity publication scope is required.");
    const scope = parsed.data;
    if (scope.destinationKind !== "channel_connection"
      || (scope.providerKey === "shopify" ? scope.providerScopeType !== "location" : scope.providerScopeType !== "account")) {
      throw failure("PUBLICATION_CATCHUP_SCOPE_UNSUPPORTED", "Legacy channel catch-up requires a Shopify location or eBay account scope.");
    }
    if (scope.providerKey === "shopify") {
      assertCanonicalShopifyId(scope.externalScopeId);
      assertCanonicalShopifyId(scope.externalInventoryItemId);
    } else if (/^(group|batch|offer):/.test(scope.externalInventoryItemId)) {
      throw failure("PUBLICATION_CATCHUP_SCOPE_UNSUPPORTED", "Group and offer lifecycle roots require their known per-SKU catch-up obligations.");
    }

    const client = await this.database.connect();
    try { return await this.resolveUsingClient(client, scope); }
    finally { client.release(); }
  }

  private async resolveUsingClient(client: Pick<PoolClient, "query">, scope: QuantityPublicationScope): Promise<ChannelQuantityPublicationTarget> {
    const connections = (await client.query(
      `SELECT channel.id AS channel_id,channel.provider,channel.status,channel.sync_enabled,
        (SELECT count(*)::integer FROM channels.channel_connections peer WHERE peer.channel_id=channel.id) AS connection_count
       FROM channels.channel_connections connection
       JOIN channels.channels channel ON channel.id=connection.channel_id
       WHERE connection.id=$1 LIMIT 2`, [scope.connectionId],
    )).rows;
    if (connections.length !== 1) throw failure("PUBLICATION_CATCHUP_CONNECTION_UNAVAILABLE", "The exact channel connection no longer exists.");
    const connection = connectionRow.safeParse(connections[0]);
    if (!connection.success) throw failure("PUBLICATION_CATCHUP_CONNECTION_INVALID", "Current channel connection evidence is malformed.");
    const owner = connection.data;
    if (owner.connection_count !== 1) throw failure("PUBLICATION_CATCHUP_CONNECTION_AMBIGUOUS", "Legacy channel-level mappings cannot select between multiple connections.");
    if (owner.provider !== scope.providerKey || owner.status !== "active" || owner.sync_enabled !== true) {
      throw failure("PUBLICATION_CATCHUP_CHANNEL_UNAVAILABLE", "The exact channel provider is changed, inactive, or inventory sync is disabled.");
    }

    const rows = scope.providerKey === "shopify"
      ? (await client.query(
        `SELECT variant.product_id,variant.id AS product_variant_id
         FROM channels.channel_feeds feed
         JOIN catalog.product_variants variant ON variant.id=feed.product_variant_id
         JOIN channels.channel_warehouse_assignments assignment ON assignment.channel_id=feed.channel_id AND assignment.enabled=true
         JOIN warehouse.warehouses warehouse ON warehouse.id=assignment.warehouse_id
         WHERE feed.channel_id=$1 AND feed.is_active=1 AND feed.quarantined_at IS NULL
           AND feed.channel_inventory_item_id IN ($2,'gid://shopify/InventoryItem/' || $2)
           AND warehouse.shopify_location_id IN ($3,'gid://shopify/Location/' || $3)
         ORDER BY feed.id,assignment.id LIMIT 2`,
        [owner.channel_id,scope.externalInventoryItemId,scope.externalScopeId],
      )).rows
      : (await client.query(
        `SELECT variant.product_id,variant.id AS product_variant_id
         FROM catalog.product_variants variant
         LEFT JOIN channels.channel_feeds feed ON feed.channel_id=$1 AND feed.product_variant_id=variant.id
         LEFT JOIN channels.channel_listings listing ON listing.channel_id=$1 AND listing.product_variant_id=variant.id
         WHERE (feed.id IS NOT NULL OR listing.id IS NOT NULL) AND feed.quarantined_at IS NULL
           AND COALESCE(listing.external_sku,feed.channel_sku,variant.sku)=$2
         ORDER BY variant.id,feed.id,listing.id LIMIT 2`, [owner.channel_id,scope.externalInventoryItemId],
      )).rows;
    // Do not DISTINCT this result: two feed/listing/warehouse rows are ambiguous
    // even if their catalog variant happens to match.
    if (rows.length !== 1) throw failure(rows.length > 1 ? "PUBLICATION_CATCHUP_MAPPING_AMBIGUOUS" : "PUBLICATION_CATCHUP_MAPPING_MISSING",
      "Exactly one current channel mapping and destination must own the requested inventory identity.");
    const mapping = mappingRow.safeParse(rows[0]);
    if (!mapping.success) throw failure("PUBLICATION_CATCHUP_MAPPING_INVALID", "The current channel mapping has invalid catalog ownership.");
    if ((scope.productId !== null && scope.productId !== mapping.data.product_id)
      || (scope.productVariantId !== null && scope.productVariantId !== mapping.data.product_variant_id)) {
      throw failure("PUBLICATION_CATCHUP_MAPPING_CHANGED", "Stored catalog hints disagree with the current exact channel mapping.");
    }
    return { scope, channelId: owner.channel_id, productId: mapping.data.product_id, productVariantId: mapping.data.product_variant_id };
  }
}

function assertCanonicalShopifyId(value: string): void {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw failure(
    "PUBLICATION_CATCHUP_SCOPE_INVALID", "Shopify catch-up identities must be canonical positive safe-integer REST IDs.");
}
function failure(code: string, message: string): QuantityPublicationAdmissionError {
  return new QuantityPublicationAdmissionError(code, message);
}
