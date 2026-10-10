import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { EbayListingSyncError } from "../ebay-listing-sync.domain";
import { EbayListingPushSkipped } from "../ebay-listing-push.service";
import { EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, ebayListingWorkflowLockKey } from "../ebay-listing-workflow-lock";
import type { EbayListingConnectorResult, EbayListingRebuildResult } from "../listing-connectors/ebay-listing.connector";

const nullableText = z.string().nullable();
const MAX_CONCURRENT_PUSH_WORKFLOWS = 4;
const RESERVED_DATABASE_CONNECTIONS = 2;
const CONNECTIONS_PER_PUSH_WORKFLOW = 3;
const productSchema = z.object({
  id: z.number().int().positive(), name: z.string(), sku: nullableText, description: nullableText,
  brand: nullableText, product_type: nullableText, ebay_browse_category_id: nullableText,
  ebay_fulfillment_policy_override: nullableText, ebay_return_policy_override: nullableText,
  ebay_payment_policy_override: nullableText, ebay_listing_excluded: z.boolean().nullable(),
  product_override_is_listed: z.number().int().nullable(),
});
const variantSchema = z.object({
  id: z.number().int().positive(), sku: z.string().trim().min(1).max(100), catalog_sku: z.string().min(1), name: nullableText,
  option1_name: nullableText, option1_value: nullableText, option2_name: nullableText, option2_value: nullableText,
  price_cents: z.number().int().nullable(), compare_at_price_cents: z.number().int().nullable(),
  weight_grams: z.number().nullable(), ebay_weight_grams: z.number().nullable(), barcode: nullableText,
  ebay_fulfillment_policy_override: nullableText, ebay_return_policy_override: nullableText,
  ebay_payment_policy_override: nullableText, external_variant_id: nullableText, external_product_id: nullableText,
  external_sku: nullableText, mapping_exists: z.boolean(),
});
export type EbayPushVariant = z.infer<typeof variantSchema>;
export type EbayPushProduct = z.infer<typeof productSchema>;
const categorySchema = z.object({
  ebay_browse_category_id: nullableText, ebay_store_category_name: nullableText, listing_enabled: z.boolean(),
  fulfillment_policy_override: nullableText, return_policy_override: nullableText, payment_policy_override: nullableText,
});

/** Owns local listing inputs and projections; no provider requests or ATP arithmetic. */
export class PostgresEbayListingPushRepository {
  private activeWorkflows = 0;
  constructor(private readonly pool: Pool, readonly channelId: number, private readonly now: () => Date,
    private readonly maximumConnections: () => number | null) {}

  async withProductLock<T>(productId: number, work: () => Promise<T>): Promise<T> {
    const key = ebayListingWorkflowLockKey(this.channelId, productId);
    // Each workflow holds its listing lock while the inventory owner may hold
    // admission and evidence connections. Reserve two slots for the saved-sync
    // worker and other short reads; reject excess HTTP work before pool checkout.
    const maximumWorkflows = Math.min(MAX_CONCURRENT_PUSH_WORKFLOWS,
      Math.floor(((this.maximumConnections() ?? 0) - RESERVED_DATABASE_CONNECTIONS) / CONNECTIONS_PER_PUSH_WORKFLOW));
    if (maximumWorkflows < 1)
      throw new EbayListingSyncError("EBAY_LISTING_CAPACITY_CONFIGURATION", "The database connection limit is too small to publish safely. Ask an administrator to configure at least five pooled database connections, then retry.");
    if (this.activeWorkflows >= maximumWorkflows)
      throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "Listing publication capacity is occupied. Wait for current updates to finish, then retry this product.");
    this.activeWorkflows += 1;
    let client: PoolClient | undefined;
    let locked = false; let discard = false;
    try {
      client = await this.pool.connect();
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1::integer, hashtext($2)) AS locked", [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, key]);
      locked = lock.rows[0]?.locked === true;
      if (!locked) throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY", "This product already has a listing update in progress. Wait for its result, then retry if needed.");
      return await work();
    } finally {
      if (locked && client) {
        try { await client.query("SELECT pg_advisory_unlock($1::integer, hashtext($2))", [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, key]); }
        catch { discard = true; }
      }
      client?.release(discard);
      this.activeWorkflows -= 1;
    }
  }

  async readProduct(productId: number): Promise<EbayPushProduct> {
    const rows = await this.pool.query(`SELECT p.id, p.name, p.sku, p.description, p.brand, p.product_type, p.ebay_browse_category_id,
      p.ebay_fulfillment_policy_override, p.ebay_return_policy_override, p.ebay_payment_policy_override,
      p.ebay_listing_excluded, cpo.is_listed AS product_override_is_listed
      FROM catalog.products p LEFT JOIN channels.channel_product_overrides cpo
      ON cpo.product_id = p.id AND cpo.channel_id = $2 WHERE p.id = $1 AND p.is_active = true`, [productId, this.channelId]);
    if (!rows.rows[0]) throw new EbayListingSyncError("EBAY_LISTING_PREFLIGHT_FAILED", `Product ${productId} is missing or inactive. Open the product and activate it before publishing.`);
    const product = productSchema.parse(rows.rows[0]);
    if (product.ebay_listing_excluded || product.product_override_is_listed === 0)
      throw new EbayListingPushSkipped("This product is excluded from eBay. Enable it in the listing feed before publishing.");
    return product;
  }

  async readVariants(productId: number): Promise<EbayPushVariant[]> {
    const rows = await this.pool.query(`SELECT pv.id, COALESCE(cl.external_sku, pv.sku) AS sku, pv.sku AS catalog_sku,
      pv.name, pv.option1_name, pv.option1_value, pv.option2_name, pv.option2_value,
      pv.price_cents, pv.compare_at_price_cents, pv.weight_grams::float8 AS weight_grams, pv.barcode,
      COALESCE(cvo.weight_override, pv.weight_grams)::float8 AS ebay_weight_grams,
      pv.ebay_fulfillment_policy_override, pv.ebay_return_policy_override, pv.ebay_payment_policy_override,
      cl.external_variant_id, cl.external_product_id, cl.external_sku, (cl.product_variant_id IS NOT NULL) AS mapping_exists
      FROM catalog.product_variants pv LEFT JOIN channels.channel_variant_overrides cvo
      ON cvo.product_variant_id = pv.id AND cvo.channel_id = $2
      LEFT JOIN channels.channel_listings cl ON cl.product_variant_id = pv.id AND cl.channel_id = $2
      WHERE pv.product_id = $1 AND pv.sku IS NOT NULL AND pv.is_active = true AND pv.sales_eligibility = 'sellable'
      AND COALESCE(pv.ebay_listing_excluded, false) = false AND COALESCE(cvo.is_listed, 1) <> 0
      ORDER BY pv.position, pv.id`, [productId, this.channelId]);
    const variants = z.array(variantSchema).max(250).parse(rows.rows);
    if (variants.length === 0) throw new EbayListingPushSkipped("No variants are included for eBay. Include an active, sellable variant in the listing feed before publishing.");
    if (new Set(variants.map(variant => variant.sku)).size !== variants.length)
      throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID", "Two variants have the same saved eBay SKU. Review their listing mappings before publishing.");
    return variants;
  }

  async readCategory(productType: string | null) {
    if (!productType) return null;
    const result = await this.pool.query(`SELECT ebay_browse_category_id, ebay_store_category_name, listing_enabled,
      fulfillment_policy_override, return_policy_override, payment_policy_override FROM ebay.ebay_category_mappings
      WHERE channel_id = $1 AND product_type_slug = $2`, [this.channelId, productType]);
    const category = result.rows[0] ? categorySchema.parse(result.rows[0]) : null;
    if (category?.listing_enabled === false)
      throw new EbayListingPushSkipped("This product type is disabled for eBay. Enable its type in the listing feed before publishing.");
    return category;
  }

  async readAspects(product: EbayPushProduct): Promise<Record<string, string[]>> {
    const aspects: Record<string, string[]> = product.brand ? { Brand: [product.brand] } : {};
    if (product.product_type) {
      const defaults = await this.pool.query<{ aspect_name: string; aspect_value: string }>(
        "SELECT aspect_name, aspect_value FROM ebay.ebay_type_aspect_defaults WHERE product_type_slug = $1", [product.product_type]);
      for (const row of defaults.rows) aspects[row.aspect_name] = [row.aspect_value];
    }
    const overrides = await this.pool.query<{ aspect_name: string; aspect_value: string }>(
      "SELECT aspect_name, aspect_value FROM ebay.ebay_product_aspect_overrides WHERE product_id = $1", [product.id]);
    for (const row of overrides.rows) aspects[row.aspect_name] = [row.aspect_value];
    return aspects;
  }

  async currentListingIds(productId: number): Promise<string[]> {
    const result = await this.pool.query<{ external_product_id: string }>(`SELECT DISTINCT cl.external_product_id
      FROM channels.channel_listings cl JOIN catalog.product_variants pv ON pv.id = cl.product_variant_id
      WHERE cl.channel_id = $1 AND pv.product_id = $2 AND cl.external_product_id IS NOT NULL`, [this.channelId, productId]);
    return result.rows.map(row => row.external_product_id);
  }

  async projectSuccess(productId: number, variants: readonly EbayPushVariant[], result: EbayListingConnectorResult | EbayListingRebuildResult,
    prices: ReadonlyMap<number, number>, removedSkus: readonly string[] = []): Promise<void> {
    const now = this.now();
    await this.transaction(async client => {
      await this.assertSourceMapping(client, productId, variants);
      if (removedSkus.length) {
        const priorListingId = "previousExternalListingId" in result ? result.previousExternalListingId : null;
        if (!priorListingId) throw new EbayListingSyncError("EBAY_SYNC_PROJECTION_IDENTITY_CHANGED", "The rebuilt listing did not identify its previous listing. Review the mapping before clearing removed variants.");
        const removed = await client.query<{ external_sku: string; external_product_id: string | null }>(`SELECT cl.external_sku,cl.external_product_id
          FROM channels.channel_listings cl JOIN catalog.product_variants pv ON pv.id=cl.product_variant_id
          WHERE cl.channel_id=$1 AND pv.product_id=$2 AND cl.external_sku=ANY($3::text[]) ORDER BY cl.product_variant_id FOR UPDATE OF cl`,
        [this.channelId, productId, removedSkus]);
        for (const row of removed.rows) if (row.external_product_id !== priorListingId) throw this.mappingChanged(row.external_sku);
        await client.query(`UPDATE channels.channel_listings cl SET external_product_id = NULL,
        external_variant_id = NULL, external_url = NULL, sync_status = 'synced', sync_error = NULL, last_synced_at = $4, updated_at = $4
        FROM catalog.product_variants pv WHERE pv.id = cl.product_variant_id AND cl.channel_id = $1
        AND pv.product_id = $2 AND cl.external_sku = ANY($3::text[]) AND cl.external_product_id=$5`,
        [this.channelId, productId, removedSkus, now, priorListingId]);
      }
      for (const variant of variants) {
        const offerId = result.externalOfferIds[variant.id];
        const price = prices.get(variant.id);
        if (!offerId || !result.externalProductId || !Number.isSafeInteger(price))
          throw new EbayListingSyncError("EBAY_SYNC_PERSISTENCE_FAILED", `eBay publication returned incomplete identity or price evidence for SKU ${variant.sku}. Retry to verify its existing offer.`);
        // Quantity is deliberately absent: admission may have replaced the draft's
        // ATP snapshot. Only its inventory owner can project acknowledged quantity.
        const projected = await client.query(`INSERT INTO channels.channel_listings(channel_id, product_variant_id, external_product_id,
          external_variant_id, external_sku, external_url, last_synced_price, sync_status, sync_error, last_synced_at, created_at, updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'synced',NULL,$8,$8,$8) ON CONFLICT(channel_id, product_variant_id) DO UPDATE SET
          external_product_id=EXCLUDED.external_product_id, external_variant_id=EXCLUDED.external_variant_id,
          external_sku=EXCLUDED.external_sku, external_url=EXCLUDED.external_url, last_synced_price=EXCLUDED.last_synced_price,
          sync_status='synced', sync_error=NULL, last_synced_at=EXCLUDED.last_synced_at, updated_at=EXCLUDED.updated_at
          WHERE $9::boolean RETURNING product_variant_id`,
        [this.channelId, variant.id, result.externalProductId, offerId, variant.sku,
          `https://www.ebay.com/itm/${result.externalProductId}`, price, now, variant.mapping_exists]);
        // A concurrent writer can insert an absent mapping after our SELECT.
        // ON CONFLICT must not adopt that new row without a new source read.
        if (projected.rowCount !== 1) throw this.mappingChanged(variant.sku);
      }
    });
  }

  private mappingChanged(sku: string): EbayListingSyncError {
    return new EbayListingSyncError("EBAY_SYNC_PROJECTION_IDENTITY_CHANGED",
      `The saved mapping or catalog identity for SKU ${sku} changed while eBay was being updated. Review its current mapping and retry; no partial local projection was saved.`);
  }

  private async assertSourceMapping(client: PoolClient, productId: number, variants: readonly EbayPushVariant[]): Promise<void> {
    const ids = variants.map(variant => variant.id);
    const local = await client.query<{ id: number; product_id: number; sku: string }>(
      "SELECT id,product_id,sku FROM catalog.product_variants WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE", [ids]);
    const mappings = await client.query<{ product_variant_id: number; external_sku: string | null; external_variant_id: string | null; external_product_id: string | null }>(
      "SELECT product_variant_id,external_sku,external_variant_id,external_product_id FROM channels.channel_listings WHERE channel_id=$1 AND product_variant_id=ANY($2::integer[]) ORDER BY product_variant_id FOR UPDATE", [this.channelId, ids]);
    for (const variant of variants) {
      const current = local.rows.find(row => row.id === variant.id);
      const mapping = mappings.rows.find(row => row.product_variant_id === variant.id);
      if (!current || current.product_id !== productId || current.sku !== variant.catalog_sku
        || Boolean(mapping) !== variant.mapping_exists
        || (mapping && (mapping.external_sku !== variant.external_sku
          || mapping.external_variant_id !== variant.external_variant_id || mapping.external_product_id !== variant.external_product_id)))
        throw this.mappingChanged(variant.sku);
    }
  }

  async recordFailure(productId: number, message: string): Promise<void> {
    await this.pool.query(`INSERT INTO channels.channel_listings(channel_id, product_variant_id, sync_status, sync_error, created_at, updated_at)
      SELECT $1,pv.id,'error',$3,$4,$4 FROM catalog.product_variants pv WHERE pv.product_id=$2 AND pv.sku IS NOT NULL
      AND pv.is_active=true AND pv.sales_eligibility='sellable'
      ON CONFLICT(channel_id, product_variant_id) DO UPDATE SET sync_status='error', sync_error=EXCLUDED.sync_error, updated_at=EXCLUDED.updated_at`,
    [this.channelId, productId, message.slice(0, 1000), this.now()]);
  }

  private async transaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect(); let discard = false;
    try { await client.query("BEGIN"); await work(client); await client.query("COMMIT"); }
    catch (error) { try { await client.query("ROLLBACK"); } catch { discard = true; } throw error; }
    finally { client.release(discard); }
  }
}
