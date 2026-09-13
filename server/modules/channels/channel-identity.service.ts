import { and, eq, inArray, isNull } from "drizzle-orm";
import { channelConnections, channelFeeds, channelListings, channels } from "@shared/schema";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import { ChannelIdentityError, internalIdentitySchema, indexInventoryIdentities, type ChannelItemIdentity } from "./channel-identity.domain";
import { ShopifyIdentityReader, type ShopifyIdentityConnection } from "./adapters/shopify-identity.reader";

type IdentityDb = Pick<typeof import("../../db").db, "select" | "transaction">;

/** Channels owns account resolution, external identities, and provider reads. */
export class ChannelIdentityService {
  constructor(
    private readonly db: IdentityDb,
    private readonly reader = new ShopifyIdentityReader(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async shopifyConnection(channelId: number, connectionId?: number): Promise<ShopifyIdentityConnection> {
    internalIdentitySchema.parse(channelId);
    if (connectionId !== undefined) internalIdentitySchema.parse(connectionId);
    const rows = await this.db.select({
      id: channelConnections.id, channelId: channelConnections.channelId,
      shopDomain: channelConnections.shopDomain, accessToken: channelConnections.accessToken,
      apiVersion: channelConnections.apiVersion, shopifyLocationId: channelConnections.shopifyLocationId,
    }).from(channelConnections).innerJoin(channels, eq(channels.id, channelConnections.channelId)).where(and(
      eq(channelConnections.channelId, channelId), eq(channels.provider, "shopify"),
      ...(connectionId === undefined ? [] : [eq(channelConnections.id, connectionId)]),
    )).limit(2);
    if (rows.length !== 1 || !rows[0].shopDomain || !rows[0].accessToken) {
      throw new ChannelIdentityError("CHANNEL_CONNECTION_UNRESOLVED", "Select exactly one configured Shopify account for this channel");
    }
    return { ...rows[0], shopDomain: rows[0].shopDomain, accessToken: rows[0].accessToken, apiVersion: rows[0].apiVersion || "2024-01" };
  }

  async inventoryIdentities(channelId: number): Promise<ChannelItemIdentity[]> {
    internalIdentitySchema.parse(channelId);
    const rows = await this.db.select({
      productVariantId: channelFeeds.productVariantId, externalVariantId: channelFeeds.channelVariantId,
      externalProductId: channelFeeds.channelProductId, externalInventoryItemId: channelFeeds.channelInventoryItemId,
      externalSku: channelFeeds.channelSku,
    }).from(channelFeeds).where(and(
      eq(channelFeeds.channelId, channelId),
      eq(channelFeeds.isActive, 1),
      isNull(channelFeeds.quarantinedAt),
    ));
    const identities: ChannelItemIdentity[] = rows.map((row) => {
      if (!row.externalVariantId) {
        throw new ChannelIdentityError(
          "CHANNEL_IDENTITY_CORRUPT",
          "An active channel feed is missing its external variant identity",
        );
      }
      return { ...row, externalVariantId: row.externalVariantId };
    });
    indexInventoryIdentities(identities);
    return identities;
  }

  async listingIdentities(channelId: number, variantIds: readonly number[]) {
    internalIdentitySchema.parse(channelId);
    variantIds.forEach((id) => internalIdentitySchema.parse(id));
    if (variantIds.length === 0) return [];
    return this.db.select().from(channelListings).where(and(
      eq(channelListings.channelId, channelId), inArray(channelListings.productVariantId, [...variantIds]),
    ));
  }

  async externalInventory(channelId: number, locationId?: string, connectionId?: number) {
    // Legacy feeds have no connection key. An explicit ID must not make an
    // ambiguous legacy channel appear safe; canonical targets use their own API.
    const connection = await this.shopifyConnection(channelId);
    if (connectionId !== undefined && connectionId !== connection.id) {
      throw new ChannelIdentityError("CHANNEL_CONNECTION_UNRESOLVED", "The configured inventory account does not match the channel's unique connection");
    }
    const selectedLocation = locationId || connection.shopifyLocationId;
    if (!selectedLocation) throw new ChannelIdentityError("CHANNEL_LOCATION_REQUIRED", "External inventory requires an explicit provider location");
    const mappings = indexInventoryIdentities(await this.inventoryIdentities(channelId));
    const quantities = await this.reader.inventory(connection, selectedLocation);
    return {
      channelId, connectionId: connection.id, externalLocationId: selectedLocation,
      items: [...quantities].map(([externalInventoryItemId, quantity]) => ({
        externalInventoryItemId, productVariantId: mappings.get(externalInventoryItemId) ?? null, quantity,
      })),
    };
  }

  /** Explicit enable/discovery only. A catalog ID is never a provider identity. */
  async ensureShopifyFeed(input: { channelId: number; productVariantId: number; sku: string | null; actor: string }) {
    internalIdentitySchema.parse(input.productVariantId);
    if (!input.actor.trim()) throw new ChannelIdentityError("CHANNEL_IDENTITY_ACTOR_REQUIRED", "An actor is required for mapping changes");
    const connection = await this.shopifyConnection(input.channelId);
    const [listing] = await this.listingIdentities(input.channelId, [input.productVariantId]);
    const [before] = await this.db.select().from(channelFeeds).where(and(
      eq(channelFeeds.channelId, input.channelId), eq(channelFeeds.productVariantId, input.productVariantId),
    )).limit(1);
    const candidateId = listing?.externalVariantId || before?.channelVariantId;
    if (!candidateId) throw new ChannelIdentityError("CHANNEL_IDENTITY_REQUIRED", "Link this variant to the destination store before enabling inventory sync");
    if (listing?.externalVariantId && before?.channelVariantId && listing.externalVariantId !== before.channelVariantId) {
      throw new ChannelIdentityError("CHANNEL_IDENTITY_CONFLICT", "Feed and listing disagree; preview an audited mapping repair");
    }
    const evidence = await this.reader.variant(connection, candidateId);
    const expectedSku = listing?.externalSku || input.sku;
    if (!expectedSku || evidence.sku !== expectedSku
      || (listing?.externalProductId && evidence.product_id !== listing.externalProductId)) {
      throw new ChannelIdentityError("CHANNEL_IDENTITY_EVIDENCE_MISMATCH", "Destination variant does not match the expected SKU and product");
    }
    if (before?.quarantinedAt) throw new ChannelIdentityError("CHANNEL_IDENTITY_QUARANTINED", "Quarantined mappings require explicit audited repair, not reactivation");
    const timestamp = this.clock();
    return this.db.transaction(async (tx) => {
      // Serialize the owning channel, including first creation when no feed row exists.
      await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, input.channelId)).for("update");
      const currentConnections = await tx.select().from(channelConnections).where(eq(channelConnections.channelId, input.channelId)).limit(2).for("share");
      const [currentConnection] = currentConnections;
      if (currentConnections.length !== 1 || !currentConnection || currentConnection.id !== connection.id
        || currentConnection.shopDomain !== connection.shopDomain || currentConnection.accessToken !== connection.accessToken) {
        throw new ChannelIdentityError("CHANNEL_CONNECTION_CHANGED", "Connection changed during provider verification; retry preview");
      }
      const [currentListing] = await tx.select().from(channelListings).where(and(
        eq(channelListings.channelId, input.channelId), eq(channelListings.productVariantId, input.productVariantId),
      )).for("share");
      if (JSON.stringify(currentListing ?? null) !== JSON.stringify(listing ?? null)) {
        throw new ChannelIdentityError("CHANNEL_IDENTITY_CHANGED", "Listing changed during verification; retry preview");
      }
      const [current] = await tx.select().from(channelFeeds).where(and(
        eq(channelFeeds.channelId, input.channelId), eq(channelFeeds.productVariantId, input.productVariantId),
      )).for("update");
      const values = {
        channelId: input.channelId, productVariantId: input.productVariantId, channelType: "shopify",
        channelVariantId: evidence.id, channelProductId: evidence.product_id,
        channelInventoryItemId: evidence.inventory_item_id, channelSku: evidence.sku, isActive: 1,
      };
      if (current && Object.entries(values).every(([key, value]) => current[key as keyof typeof current] === value) && !current.quarantinedAt) return current;
      if (JSON.stringify(current ?? null) !== JSON.stringify(before ?? null)) {
        throw new ChannelIdentityError("CHANNEL_IDENTITY_CHANGED", "Mapping changed during verification; retry preview");
      }
      const [saved] = current
        ? await tx.update(channelFeeds).set({ ...values, updatedAt: timestamp }).where(eq(channelFeeds.id, current.id)).returning()
        : await tx.insert(channelFeeds).values({ ...values, createdAt: timestamp, updatedAt: timestamp }).returning();
      await persistAuditEvent(tx, {
        actor: input.actor, action: "channel_identity.verified_feed", target: `channel_feed:${saved.id}`,
        changes: { before: current ?? null, after: saved },
        context: { channelId: input.channelId, connectionId: connection.id, externalVariantId: evidence.id },
      }, { timestamp });
      return saved;
    });
  }
}
