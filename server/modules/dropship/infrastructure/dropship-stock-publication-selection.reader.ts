import { createHash } from "node:crypto";
import { z } from "zod";
import {
  stockPublicationSelectionSchema,
  type StockPublicationSelection,
  type StockSelectionQueryClient,
} from "@shared/types/stock-publication-selection";
import { readCatalogStockSelectionFacts, type CatalogStockSelectionFacts } from "../../catalog/catalog-stock-selection.reader";
import { parseCatalogVariantUomType } from "../domain/listing-tiers";
import { DropshipError } from "../domain/errors";
import type { DropshipCatalogExposureRule } from "../domain/catalog-exposure";
import {
  decideDropshipStockPublicationSelection,
  type DropshipStockSelectionCandidate,
} from "../domain/stock-publication-selection";
import type { DropshipVendorVariantOverride } from "../domain/vendor-selection";

const id = z.number().int().positive().max(2_147_483_647);
const inputSchema = z.object({
  storeConnectionId: id, productId: id, productVariantIds: z.array(id), now: z.date(),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.productVariantIds).size !== input.productVariantIds.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["productVariantIds"], message: "Variant IDs must be unique." });
});
const configSchema = z.object({
  listingMode: z.enum(["draft_first", "live", "manual_only"]),
  inventoryMode: z.enum(["managed_quantity_sync", "manual_quantity", "disabled"]),
  isActive: z.boolean(),
});
const storeSchema = z.object({
  id, vendorId: id, platform: z.string(), externalAccountId: z.string().nullable(),
  providerEnvironment: z.string().nullable(), status: z.string(), config: configSchema.nullable(),
});
const targetSchema = z.object({
  id, scopeType: z.enum(["catalog", "product_line", "category", "product", "variant"]),
  action: z.enum(["include", "exclude"]), productLineId: id.nullable(), productId: id.nullable(),
  productVariantId: id.nullable(), category: z.string().nullable(),
});
const exposureRuleSchema = targetSchema.extend({ startsAt: z.date().nullable(), endsAt: z.date().nullable() });
const pickSchema = z.object({ productVariantId: id });
const overrideSchema = z.object({ productVariantId: id, enabledOverride: z.boolean().nullable() });
/** The open states of a listing end request (PLAN-C v4.1 §3: one open end per listing; a failed end stays open). */
export const OPEN_LISTING_END_STATES = ["pending", "ending", "failed"] as const;
/** A bigint end request id as node-postgres returns it (text), read as a safe integer. */
const endRequestId = z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)
  .refine(Number.isSafeInteger, { message: "End request ids must be safe integers." });
/**
 * The listing as this reader decides and fingerprints it. Not strict: the
 * shared listing SQL also returns the store id, #1900's end facts and PR C's
 * end request facts for the selection effects reader, and they are dropped
 * here, so this reader's fingerprint is byte for byte what it was before the
 * SQL was shared (PLAN-B v4.1 V21, R6). The one PR C fact it reads is the
 * open end's state (PLAN-C v4.1 §7), which reaches the fingerprint only as
 * `endOpen: true` on a listing with an open end. Zod builds the parsed object
 * in this key order.
 */
const listingSchema = z.object({
  id, productVariantId: id,
  status: z.enum(["not_listed", "preview_ready", "queued", "pushing", "active", "paused", "ended", "failed", "blocked", "drift_detected"]),
  externalListingId: z.string().min(1).nullable(), externalOfferId: z.string().min(1).nullable(),
  livePushItemId: id.nullable(),
  vendorQuantityLimit: z.number().int().min(0).max(2_147_483_647).nullable(),
  openEndState: z.enum(OPEN_LISTING_END_STATES).nullable(),
});
/** A row of DROPSHIP_STOCK_LISTING_ROWS_SQL with every column it returns (the selection effects reader's parse). */
export const dropshipStockListingRowSchema = listingSchema.extend({
  storeConnectionId: id,
  marketplaceEndedAt: z.date().nullable(),
  marketplaceIssueCodes: z.array(z.string()),
  openEndId: endRequestId.nullable(),
  pushInFlight: z.boolean(),
});
export type DropshipStockListingRow = z.infer<typeof dropshipStockListingRowSchema>;

/**
 * The listing as the stock decision receives it from either reader: the row,
 * plus `endOpen: true` while an end request is open (PLAN-C v4.1 §7, D42).
 * One function for SPR and the effects reader, so both decide a listing from
 * the same facts.
 */
export function withListingEndState<Row extends { openEndState: (typeof OPEN_LISTING_END_STATES)[number] | null }>(row: Row):
  Row & { endOpen?: true } {
  return row.openEndState === null ? row : { ...row, endOpen: true };
}

/**
 * The vendor's listing rows of these sizes on these stores, each with its
 * newest saved live push for that exact destination: ONE text for this
 * reader (one store) and the selection effects reader (every store of the
 * vendor), so the two can never decide a listing from different facts
 * (PLAN-B v4.1 §7.7, V21; R5). $1 vendor id, $2 store ids, $3 size ids. A
 * listing counts only on its own store's platform. Ordered by store, then
 * size; one store's rows are therefore in size order, as before.
 *
 * PR C (PLAN-C v4.1 §4.2 item 4, §7) adds the listing's open end request (at
 * most one: the open-end unique index) and whether a push may be on its way
 * to eBay: a `processing` item, or a `queued` one stale recovery put back
 * after a worker died mid-send (`result.staleRecovery`), which may have
 * reached eBay unrecorded. A plain `queued` item is not in flight: the
 * push-time selection check blocks an unpicked size before eBay. The EXISTS
 * joins jobs on vendor, store and size like the intent lateral, because job
 * items have no listing index.
 */
export const DROPSHIP_STOCK_LISTING_ROWS_SQL = `SELECT vl.id, vl.store_connection_id AS "storeConnectionId",
    vl.product_variant_id AS "productVariantId",vl.status,vl.external_listing_id AS "externalListingId",
    vl.external_offer_id AS "externalOfferId", intent.id AS "livePushItemId",
    vl.vendor_quantity_limit AS "vendorQuantityLimit",
    vl.marketplace_ended_at AS "marketplaceEndedAt", vl.marketplace_issue_codes AS "marketplaceIssueCodes",
    open_end.id::text AS "openEndId", open_end.state AS "openEndState",
    EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items fi
      INNER JOIN dropship.dropship_listing_push_jobs fj ON fj.id=fi.job_id
      WHERE fj.vendor_id=vl.vendor_id AND fj.store_connection_id=vl.store_connection_id
        AND fi.product_variant_id=vl.product_variant_id AND fi.listing_id=vl.id
        AND (fi.status='processing' OR (fi.status='queued' AND fi.result ? 'staleRecovery'))) AS "pushInFlight"
    FROM dropship.dropship_vendor_listings vl
    INNER JOIN dropship.dropship_store_connections listing_store
      ON listing_store.id=vl.store_connection_id AND listing_store.platform=vl.platform
    LEFT JOIN LATERAL (SELECT ji.id FROM dropship.dropship_listing_push_job_items ji
      INNER JOIN dropship.dropship_listing_push_jobs j ON j.id=ji.job_id
      WHERE j.vendor_id=vl.vendor_id AND j.store_connection_id=vl.store_connection_id
        AND ji.product_variant_id=vl.product_variant_id AND ji.listing_id=vl.id
        AND j.job_type='push' AND ji.action='push' AND j.status<>'cancelled' AND ji.status<>'cancelled'
        AND ji.result->'listingIntent'->>'listingMode'='live'
        AND ji.result->'listingIntent'->>'inventoryMode'='managed_quantity_sync'
        AND ji.result->'listingIntent'->>'productVariantId'=vl.product_variant_id::text
        AND ji.result->'listingIntent'->>'platform'=vl.platform
        AND (vl.status<>'ended' OR ji.created_at>vl.updated_at)
      ORDER BY ji.id DESC LIMIT 1) intent ON true
    LEFT JOIN dropship.dropship_listing_end_requests open_end
      ON open_end.listing_id=vl.id AND open_end.state IN ('pending','ending','failed')
    WHERE vl.vendor_id=$1 AND vl.store_connection_id=ANY($2::integer[]) AND vl.product_variant_id=ANY($3::integer[])
    ORDER BY vl.store_connection_id, vl.product_variant_id`;

/** Read the exact destination's current listing intent through Dropship's rules.
 * No ATP, credentials, photos, provider requests, locks or writes. The caller can
 * use its existing transaction to obtain a consistent publication snapshot. */
export async function readDropshipListingStockSelection(client: StockSelectionQueryClient, raw: {
  storeConnectionId: number; productId: number; productVariantIds: readonly number[]; now: Date;
}): Promise<StockPublicationSelection> {
  const input = inputSchema.parse(raw);
  const productVariantIds = [...input.productVariantIds].sort((a, b) => a - b);
  const stores = (await client.query(`SELECT sc.id, sc.vendor_id AS "vendorId", sc.platform,
    sc.external_account_id AS "externalAccountId", sc.provider_environment AS "providerEnvironment", sc.status,
    CASE WHEN lc.id IS NULL THEN NULL ELSE jsonb_build_object('listingMode',lc.listing_mode,
      'inventoryMode',lc.inventory_mode,'isActive',lc.is_active) END AS config
    FROM dropship.dropship_store_connections sc
    LEFT JOIN dropship.dropship_store_listing_configs lc ON lc.store_connection_id=sc.id AND lc.platform=sc.platform
    WHERE sc.id=$1`, [input.storeConnectionId])).rows;
  if (stores.length > 1) throw new DropshipError("DROPSHIP_STOCK_SELECTION_AMBIGUOUS",
    "Multiple listing configurations describe this store connection.");
  const rawStore = stores[0];
  if (!rawStore) throw new DropshipError("DROPSHIP_STOCK_STORE_NOT_FOUND",
    "The selected Dropship store connection no longer exists.", { storeConnectionId: input.storeConnectionId });
  const store = storeSchema.parse(rawStore);
  const catalog = await readCatalogStockSelectionFacts(client, { productId: input.productId, productVariantIds });
  const rules = await readDropshipStockExposureRules(client);
  const pickedIds = await readDropshipStockPickedVariantIds(client, store.vendorId, productVariantIds);
  const overrides = await readDropshipStockOverrides(client, store.vendorId, productVariantIds);
  const listings = z.array(listingSchema).parse(productVariantIds.length ? (await client.query(DROPSHIP_STOCK_LISTING_ROWS_SQL,
    [store.vendorId, [store.id], productVariantIds])).rows : []);
  if ([listings, overrides].some(rows => new Set(rows.map(row => row.productVariantId)).size !== rows.length))
    throw new DropshipError("DROPSHIP_STOCK_SELECTION_AMBIGUOUS", "Multiple saved selections or listings describe this store variant.");
  const decisionListings = listings.map(withListingEndState);
  const variants = productVariantIds.map(productVariantId => {
    const candidate = dropshipStockSelectionCandidate(catalog.product, catalog.variants.find(row => row.id === productVariantId) ?? null,
      productVariantId);
    return decideDropshipStockPublicationSelection({
      productVariantId,
      candidate,
      rules, picked: pickedIds.has(productVariantId),
      override: overrides.find(row => row.productVariantId === productVariantId) ?? null,
      listing: decisionListings.find(row => row.productVariantId === productVariantId) ?? null,
      config: store.config, storePaused: store.status === "paused", now: input.now,
    });
  });
  // Fingerprints describe effective intent and exact identity, not the time a
  // preview happened or a changing stock balance. Scheduled rules affect it when
  // their effective decision changes.
  // The vendor limit (eBay sync-back) and an open end (PR C, §7) join the fingerprint only when a listing has
  // them, so every fingerprint without either is byte for byte the one main computed. The end's state is not in
  // it: pending, ending and failed all hold the listing at zero.
  const fingerprintListings = listings.map(({ vendorQuantityLimit, openEndState, ...listing }) => {
    const limited = vendorQuantityLimit === null ? listing : { ...listing, vendorQuantityLimit };
    return openEndState === null ? limited : { ...limited, endOpen: true };
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({
    productId: input.productId, store, catalog, listings: fingerprintListings,
    // Additive listing status metadata must not invalidate existing stock proofs.
    variants: variants.map(({ listingSelected: _listingSelected, ...stockDecision }) => stockDecision),
  })).digest("hex");
  return stockPublicationSelectionSchema.parse({ productId: input.productId, fingerprint, variants });
}

/** Card Shellz's active catalog exposure rules, in the order every stock decision applies them. */
export async function readDropshipStockExposureRules(client: StockSelectionQueryClient): Promise<DropshipCatalogExposureRule[]> {
  return z.array(exposureRuleSchema).parse((await client.query(`SELECT id,scope_type AS "scopeType",action,
    product_line_id AS "productLineId",product_id AS "productId",product_variant_id AS "productVariantId",category,
    starts_at AS "startsAt",ends_at AS "endsAt" FROM dropship.dropship_catalog_rules
    WHERE is_active=true ORDER BY priority ASC,id ASC`)).rows);
}

/** The vendor's one-time picks among these sizes (PLAN-B v4.1 §9 row 4): bounded by the ids, like the overrides. */
export async function readDropshipStockPickedVariantIds(client: StockSelectionQueryClient, vendorId: number,
  productVariantIds: readonly number[]): Promise<Set<number>> {
  const picks = z.array(pickSchema).parse(productVariantIds.length ? (await client.query(`SELECT
    product_variant_id AS "productVariantId" FROM dropship.dropship_vendor_selected_variants
    WHERE vendor_id=$1 AND product_variant_id=ANY($2::integer[]) ORDER BY product_variant_id`,
  [vendorId, productVariantIds])).rows : []);
  return new Set(picks.map(row => row.productVariantId));
}

/** The vendor's overrides of these sizes, in size order (at most one per size: the caller refuses duplicates). */
export async function readDropshipStockOverrides(client: StockSelectionQueryClient, vendorId: number,
  productVariantIds: readonly number[]): Promise<DropshipVendorVariantOverride[]> {
  return z.array(overrideSchema).parse(productVariantIds.length ? (await client.query(`SELECT
    product_variant_id AS "productVariantId",enabled_override AS "enabledOverride"
    FROM dropship.dropship_vendor_variant_overrides WHERE vendor_id=$1 AND product_variant_id=ANY($2::integer[])
    ORDER BY product_variant_id`, [vendorId, productVariantIds])).rows : []);
}

/** The stock decision's catalog candidate of one size from the catalog's facts; null unless both exist. */
export function dropshipStockSelectionCandidate(product: CatalogStockSelectionFacts["product"],
  variant: CatalogStockSelectionFacts["variants"][number] | null, productVariantId: number): DropshipStockSelectionCandidate | null {
  return product && variant ? {
    productId: product.id, productVariantId, productLineIds: product.productLineIds,
    category: product.category, productIsActive: product.isActive, productStatus: product.status, variantIsActive: variant.isActive,
    variantUomType: parseCatalogVariantUomType(variant.uomType, { productVariantId }),
    requiresShipping: variant.requiresShipping, trackInventory: variant.trackInventory,
    salesEligibility: variant.salesEligibility,
  } : null;
}
