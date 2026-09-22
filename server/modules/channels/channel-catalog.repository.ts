import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import { VARIANT_SALES_ELIGIBILITY_LOCK_NAMESPACE } from "@shared/catalog/variant-sales-eligibility";
import { channelCatalogItemSchema, channelCatalogLinkSchema, type ChannelCatalogVariant } from "@shared/types/channel-catalog";
import type { ChannelCatalogAccount, ChannelCatalogRepository, VerifiedChannelCatalogMapping } from "./channel-catalog.service";
import { ChannelIdentityError } from "./channel-identity.domain";

const positiveId = z.number().int().positive().max(2_147_483_647);
const variantSchema = z.object({ id: positiveId, sku: z.string().nullable(), name: z.string(), is_active: z.boolean(),
  sales_eligibility: z.string().nullable(), requires_shipping: z.boolean().nullable(), track_inventory: z.boolean().nullable() });
function variantView(raw: unknown): ChannelCatalogVariant {
  const row = variantSchema.parse(raw);
  return { id: row.id, sku: row.sku, name: row.name, eligible: row.is_active
    && (row.sales_eligibility === null || row.sales_eligibility === "sellable")
    && row.requires_shipping !== false && row.track_inventory !== false };
}
const variantColumns = "id,sku,name,is_active,sales_eligibility,requires_shipping,track_inventory";

/** Shared channel identity persistence: feeds and listing projections commit together. */
export class PostgresChannelCatalogRepository implements ChannelCatalogRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  async providerKey(channelId: number): Promise<string> {
    positiveId.parse(channelId);
    return this.read(async client => {
      const row = (await client.query("SELECT provider FROM channels.channels WHERE id=$1", [channelId])).rows[0];
      if (!row) throw new ChannelIdentityError("CHANNEL_NOT_FOUND", "Channel not found");
      return z.string().min(1).parse(row.provider);
    });
  }
  private async read<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { return await work(client); } finally { client.release(); }
  }
  async candidates(channelId: number, skus: readonly string[]) {
    positiveId.parse(channelId);
    const keys = z.array(z.string().min(1).max(100)).max(1_000).parse(skus);
    if (keys.length === 0) return { variants: [], mappings: [] };
    return this.read(async client => {
      const feeds = await client.query(`SELECT product_variant_id,channel_sku,channel_variant_id,channel_inventory_item_id,is_active,quarantined_at
        FROM channels.channel_feeds WHERE channel_id=$1 AND (channel_sku=ANY($2::text[])
          OR product_variant_id IN (SELECT id FROM catalog.product_variants WHERE sku=ANY($2::text[])))`, [channelId, keys]);
      const variants = await client.query(`SELECT ${variantColumns} FROM catalog.product_variants
        WHERE sku=ANY($1::text[]) OR id=ANY($2::integer[]) ORDER BY sku,id`, [keys, feeds.rows.map(row => row.product_variant_id)]);
      const rows = z.array(z.object({ product_variant_id: positiveId, channel_sku: z.string().nullable(),
        channel_variant_id: z.string().nullable(), channel_inventory_item_id: z.string().nullable(),
        is_active: z.number().int(), quarantined_at: z.date().nullable() })).parse(feeds.rows);
      return { variants: variants.rows.map(variantView), mappings: rows.map(row => ({
        productVariantId: row.product_variant_id, sku: row.channel_sku ?? "", externalVariantId: row.channel_variant_id,
        externalInventoryItemId: row.channel_inventory_item_id, active: row.is_active === 1 && row.quarantined_at === null,
      })) };
    });
  }
  async searchVariants(query: string) {
    const term = z.string().trim().min(2).max(100).parse(query).replace(/[\\%_]/g, "\\$&");
    return this.read(async client => (await client.query(`SELECT ${variantColumns} FROM catalog.product_variants
      WHERE sku ILIKE $1 OR name ILIKE $1 ORDER BY sku,id LIMIT 50`, [`%${term}%`])).rows.map(variantView));
  }
  async saveMappings(account: ChannelCatalogAccount,
    items: readonly VerifiedChannelCatalogMapping[], actor: string, now: Date): Promise<void> {
    positiveId.parse(account.channelId); positiveId.parse(account.connectionId);
    z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).parse(account.provider);
    z.string().trim().min(1).max(200).parse(actor); z.date().parse(now);
    channelCatalogLinkSchema.parse({ mappings: items.map(entry => ({ sku: entry.item.sku, productVariantId: entry.productVariantId })) });
    for (const entry of items) { channelCatalogItemSchema.parse(entry.item); z.string().min(1).max(100).nullable().parse(entry.expectedLocalSku); }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const connection = await client.query(`SELECT c.id FROM channels.channels c JOIN channels.channel_connections cc ON cc.channel_id=c.id
        WHERE c.id=$1 AND c.provider=$2 AND cc.id=$3 FOR UPDATE OF c,cc`, [account.channelId, account.provider, account.connectionId]);
      if (connection.rowCount !== 1) throw new ChannelIdentityError("CHANNEL_CONNECTION_CHANGED", "The channel connection changed; refresh before linking");
      for (const entry of [...items].sort((a, b) => a.productVariantId - b.productVariantId)) {
        await client.query("SELECT pg_advisory_xact_lock($1,$2)", [VARIANT_SALES_ELIGIBILITY_LOCK_NAMESPACE, positiveId.parse(entry.productVariantId)]);
        await this.saveOne(client, account, entry, actor, now);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private async saveOne(client: PoolClient, account: ChannelCatalogAccount,
    { item, productVariantId, expectedLocalSku }: VerifiedChannelCatalogMapping, actor: string, now: Date) {
    const variant = (await client.query(`SELECT ${variantColumns} FROM catalog.product_variants WHERE id=$1 FOR SHARE`, [productVariantId])).rows[0];
    if (!variant || !variantView(variant).eligible) throw new ChannelIdentityError("CHANNEL_VARIANT_UNAVAILABLE", "Select an active, sellable fulfillment variant");
    if (expectedLocalSku !== null && variant.sku !== expectedLocalSku) {
      throw new ChannelIdentityError("CHANNEL_CATALOG_SKU_CHANGED", "The Echelon SKU changed during matching; refresh and retry");
    }
    if (expectedLocalSku !== null) {
      const exact = await client.query("SELECT id FROM catalog.product_variants WHERE sku=$1 FOR SHARE", [expectedLocalSku]);
      if (exact.rowCount !== 1) throw new ChannelIdentityError("CHANNEL_CATALOG_SKU_AMBIGUOUS", "Multiple Echelon variants now match the SKU; review the listing feed");
    }
    const feeds = (await client.query(`SELECT * FROM channels.channel_feeds WHERE channel_id=$1
      AND (product_variant_id=$2 OR channel_sku=$3 OR channel_variant_id=$4 OR channel_inventory_item_id=$5) FOR UPDATE`,
    [account.channelId, productVariantId, item.sku, item.externalVariantId, item.externalInventoryItemId])).rows;
    if (feeds.length > 1 || feeds.some(feed => feed.product_variant_id !== productVariantId || feed.channel_sku !== item.sku
      || feed.channel_variant_id !== item.externalVariantId || feed.channel_inventory_item_id !== item.externalInventoryItemId
      || feed.channel_type !== account.provider || (feed.channel_product_id && feed.channel_product_id !== item.externalProductId))) {
      throw new ChannelIdentityError("CHANNEL_MAPPING_CONFLICT", "A SKU or variant is already linked to a different identity");
    }
    if (feeds.some(feed => feed.is_active !== 1 || feed.quarantined_at !== null)) {
      throw new ChannelIdentityError("CHANNEL_MAPPING_INACTIVE", "Disabled or quarantined mappings require reviewed repair");
    }
    const listings = (await client.query(`SELECT * FROM channels.channel_listings WHERE channel_id=$1
      AND (product_variant_id=$2 OR external_sku=$3 OR external_variant_id=$4) FOR UPDATE`,
    [account.channelId, productVariantId, item.sku, item.externalVariantId])).rows;
    if (listings.length > 1 || listings.some(listing => listing.product_variant_id !== productVariantId
      || listing.external_sku !== item.sku || listing.external_variant_id !== item.externalVariantId
      || (listing.external_product_id && listing.external_product_id !== item.externalProductId))) {
      throw new ChannelIdentityError("CHANNEL_LISTING_CONFLICT", "The existing listing projection disagrees with the verified SKU");
    }
    if (feeds.length === 1 && listings.length === 1 && feeds[0].channel_product_id === item.externalProductId
      && listings[0].external_product_id === item.externalProductId) return;
    await client.query(`INSERT INTO channels.channel_feeds (channel_id,product_variant_id,channel_type,channel_variant_id,
      channel_product_id,channel_sku,channel_inventory_item_id,is_active,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$8) ON CONFLICT (channel_id,product_variant_id)
      DO UPDATE SET channel_product_id=EXCLUDED.channel_product_id,updated_at=EXCLUDED.updated_at`,
    [account.channelId,productVariantId,account.provider,item.externalVariantId,item.externalProductId,item.sku,item.externalInventoryItemId,now]);
    await client.query(`INSERT INTO channels.channel_listings (channel_id,product_variant_id,external_product_id,external_variant_id,
      external_sku,sync_status,last_synced_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'synced',$6,$6,$6)
      ON CONFLICT (channel_id,product_variant_id) DO UPDATE SET external_product_id=EXCLUDED.external_product_id,
      sync_status='synced',last_synced_at=EXCLUDED.last_synced_at,updated_at=EXCLUDED.updated_at`,
    [account.channelId,productVariantId,item.externalProductId,item.externalVariantId,item.sku,now]);
    await persistAuditEvent(drizzle(client), { actor, action: "channel_identity.verified_catalog_mapping",
      target: `channel:${account.channelId}:variant:${productVariantId}`,
      changes: { before: { feed: feeds[0] ?? null, listing: listings[0] ?? null },
        after: { productVariantId, ...item } }, context: { ...account } }, { timestamp: now, emitStructuredLog: false });
  }
}
