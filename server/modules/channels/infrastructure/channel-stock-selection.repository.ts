import { z } from "zod";
import { ebayListingSyncJobSchema } from "@shared/types/ebay-listing-sync";
import type { StockSelectionQueryClient, StockPublicationSelection } from "@shared/types/stock-publication-selection";
import { readCatalogStockSelectionFacts } from "../../catalog/catalog-stock-selection.reader";
import { resolveChannelStockSelection, type ChannelStockSelectionFacts } from "../channel-stock-selection.domain";

export type { StockSelectionQueryClient, StockPublicationSelection } from "@shared/types/stock-publication-selection";
const id = z.number().int().positive().max(2_147_483_647);
const text = z.string().trim().min(1).nullable();
const override = z.union([z.literal(0), z.literal(1)]).nullable();
const inputSchema = z.object({ channelId: id, channelConnectionId: id, productId: id, productVariantIds: z.array(id) }).strict()
  .refine(input => new Set(input.productVariantIds).size === input.productVariantIds.length, "Requested variant IDs must be unique.");
const memberSchema = z.object({ variantId: id, sku: z.string().min(1), offerId: text, listingId: text });
const jobSchema = z.object({ id: z.string().uuid(), operation: ebayListingSyncJobSchema.shape.operation, state: ebayListingSyncJobSchema.shape.state,
  identity: z.object({ channelId: id, connectionId: id, productId: id, accountId: z.string().min(1).optional(), variants: z.array(memberSchema) }),
  provider_identity: z.object({ channelId: id, connectionId: id, productId: id, accountId: z.string().min(1).optional(), variants: z.array(memberSchema) }).nullable() });
const feedSchema = z.object({ product_variant_id: id, is_active: z.union([z.literal(0), z.literal(1)]), quarantined: z.boolean(),
  channel_variant_id: text, channel_inventory_item_id: text, channel_sku: text });
const listingSchema = z.object({ product_variant_id: id, sync_status: z.string().nullable(), external_product_id: text,
  external_variant_id: text, external_sku: text });

export class ChannelStockSelectionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ChannelStockSelectionError"; }
}

/** Published Channels read interface. No provider calls, quantities, writes, or
 * independent membership setting. Every query uses the caller's transaction. */
export async function readChannelStockSelection(client: StockSelectionQueryClient,
  raw: { channelId: number; channelConnectionId: number; productId: number; productVariantIds: readonly number[] }): Promise<StockPublicationSelection> {
  return resolveChannelStockSelection(await readChannelStockSelectionFacts(client, raw));
}

/** Channels-internal source facts shared by selection and exact source fencing. */
export async function readChannelStockSelectionFacts(client: StockSelectionQueryClient,
  raw: { channelId: number; channelConnectionId: number; productId: number; productVariantIds: readonly number[] }): Promise<ChannelStockSelectionFacts> {
  const input = inputSchema.parse(raw);
  const context = z.array(z.object({ channel_id: id, connection_id: id.nullable(), provider: z.enum(["shopify", "ebay", "walmart"]) })).parse(
    (await client.query(`SELECT c.id AS channel_id,cc.id AS connection_id,lower(c.provider) AS provider
      FROM channels.channels c LEFT JOIN channels.channel_connections cc ON cc.channel_id=c.id WHERE c.id=$1 ORDER BY cc.id`, [input.channelId])).rows);
  if (context.length !== 1 || context[0].connection_id !== input.channelConnectionId)
    throw new ChannelStockSelectionError("CHANNEL_SELECTION_CONNECTION_UNRESOLVED", "Channel selection requires its one exact saved connection. Review the destination before publishing stock.");
  const provider = context[0].provider;
  const catalog = await readCatalogStockSelectionFacts(client, { productId: input.productId, productVariantIds: input.productVariantIds });
  const productOverrides = z.array(z.object({ is_listed: override })).parse((await client.query(
    "SELECT is_listed FROM channels.channel_product_overrides WHERE channel_id=$1 AND product_id=$2", [input.channelId, input.productId])).rows);
  const variantOverrides = z.array(z.object({ product_variant_id: id, is_listed: override })).parse((await client.query(
    "SELECT product_variant_id,is_listed FROM channels.channel_variant_overrides WHERE channel_id=$1 AND product_variant_id=ANY($2::integer[]) ORDER BY product_variant_id",
    [input.channelId, input.productVariantIds])).rows);
  const feeds = z.array(feedSchema).parse((await client.query(`SELECT product_variant_id,is_active,quarantined_at IS NOT NULL AS quarantined,
    channel_variant_id,channel_inventory_item_id,channel_sku FROM channels.channel_feeds WHERE channel_id=$1 AND product_variant_id=ANY($2::integer[]) ORDER BY product_variant_id`,
  [input.channelId, input.productVariantIds])).rows);
  const listings = z.array(listingSchema).parse((await client.query(`SELECT product_variant_id,sync_status,external_product_id,external_variant_id,external_sku
    FROM channels.channel_listings WHERE channel_id=$1 AND product_variant_id=ANY($2::integer[]) ORDER BY product_variant_id`, [input.channelId, input.productVariantIds])).rows);
  const types = provider === "ebay" && catalog.product?.productType ? z.array(z.object({ listing_enabled: z.boolean() })).parse((await client.query(
    "SELECT listing_enabled FROM ebay.ebay_category_mappings WHERE channel_id=$1 AND product_type_slug=$2", [input.channelId, catalog.product.productType])).rows) : [];
  const jobRows = provider === "ebay" ? (await client.query(`SELECT id::text,operation,state,identity,provider_identity FROM channels.ebay_listing_sync_jobs
    WHERE channel_id=$1 AND connection_id=$2 AND product_id=$3 AND error_code IS DISTINCT FROM 'EBAY_SYNC_SOURCE_SUPERSEDED'
    ORDER BY created_at DESC,id DESC LIMIT 1`, [input.channelId, input.channelConnectionId, input.productId])).rows : [];
  const job = jobRows.length ? jobSchema.parse(jobRows[0]) : null;
  if (job && (job.identity.channelId !== input.channelId || job.identity.connectionId !== input.channelConnectionId || job.identity.productId !== input.productId))
    throw new ChannelStockSelectionError("CHANNEL_SELECTION_JOB_SCOPE_CHANGED", "The saved listing request has a different product or connection identity. Review it before publishing stock.");
  if (productOverrides.length > 1 || types.length > 1 || [feeds, listings, variantOverrides].some(rows => new Set(rows.map(row => row.product_variant_id)).size !== rows.length))
    throw new ChannelStockSelectionError("CHANNEL_SELECTION_AMBIGUOUS", "Multiple saved channel selections or identities describe one variant. Review those mappings before publishing stock.");
  const facts: ChannelStockSelectionFacts = { ...input, provider, catalog,
    productIsListed: productOverrides[0]?.is_listed ?? null, typeListingEnabled: types[0]?.listing_enabled ?? null,
    latestJob: job ? { id: job.id, operation: job.operation, state: job.state, accountId: job.identity.accountId, members: job.identity.variants,
      verifiedMembers: job.provider_identity?.channelId === input.channelId && job.provider_identity.connectionId === input.channelConnectionId
        && job.provider_identity.productId === input.productId && job.provider_identity.accountId === job.identity.accountId
        ? job.provider_identity.variants : [] } : null,
    variants: input.productVariantIds.map(productVariantId => {
      const feed = feeds.find(row => row.product_variant_id === productVariantId);
      const listing = listings.find(row => row.product_variant_id === productVariantId);
      return { productVariantId, variantIsListed: variantOverrides.find(row => row.product_variant_id === productVariantId)?.is_listed ?? null,
        feed: feed ? { active: feed.is_active === 1, quarantined: feed.quarantined, externalVariantId: feed.channel_variant_id,
          externalInventoryItemId: feed.channel_inventory_item_id, externalSku: feed.channel_sku } : null,
        listing: listing ? { status: listing.sync_status, externalProductId: listing.external_product_id,
          externalVariantId: listing.external_variant_id, externalSku: listing.external_sku } : null };
    }) };
  return facts;
}

import { hasListingWorkObligation, type ListingWorkPhase } from "../../marketplace-listings/domain/listing-work-obligation";

/** The sync owner explicitly supersedes only idle jobs without a publication
 * barrier. Those retained historical refusals carry no remaining execution duty. */
export async function hasOutstandingEbayListingWork(client: StockSelectionQueryClient,
  input: {channelId:number;connectionId:number;productId:number}):Promise<boolean> {
  return (await readOutstandingEbayListingWork(client,input)).length>0;
}

export async function readOutstandingEbayListingWork(client: StockSelectionQueryClient,
  input: {channelId:number;connectionId:number;productId:number}) {
  const rows = await client.query<{ id:string; operation:string; state:string; error_code:string|null; settled:boolean }>(
    `SELECT j.id::text,j.operation,j.state,j.error_code,
      EXISTS(SELECT 1 FROM channels.ebay_listing_sync_settlements s WHERE s.failed_job_id=j.id) settled
      FROM channels.ebay_listing_sync_jobs j WHERE channel_id=$1 AND connection_id=$2 AND product_id=$3`,
    [id.parse(input.channelId),id.parse(input.connectionId),id.parse(input.productId)]);
  return rows.rows.filter(row => {
    const phase: ListingWorkPhase = row.settled || row.error_code === "EBAY_SYNC_SOURCE_SUPERSEDED" ? "settled"
      : row.state === "completed" ? "completed" : row.state === "needs_attention" ? "attention" : "pending";
    return hasListingWorkObligation(phase);
  });
}
