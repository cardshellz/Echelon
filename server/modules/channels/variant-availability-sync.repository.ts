import { randomUUID } from "crypto";
import type { VariantSalesEligibility } from "@shared/catalog/variant-sales-eligibility";

export interface SqlQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

export interface SqlQueryable {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
}

export interface SqlClient extends SqlQueryable {
  release(): void;
}

export interface SqlPool extends SqlQueryable {
  connect(): Promise<SqlClient>;
}

export interface ClaimedVariantAvailabilitySync {
  channelId: number;
  productVariantId: number;
  desiredActive: boolean;
  revision: number;
  attemptCount: number;
  leaseToken: string;
  /** Null is a legacy request whose original purpose was not recorded. */
  requestKind: "catalog_activation" | "stock_repair" | null;
}

export interface VariantAvailabilityContext {
  channelId: number;
  channelName: string;
  channelProvider: string;
  channelStatus: string;
  channelSyncEnabled: boolean;
  channelSyncMode: string;
  productId: number;
  productVariantId: number;
  catalogSku: string | null;
  catalogVariantActive: boolean;
  catalogRequiresShipping: boolean;
  catalogTrackInventory: boolean | null;
  catalogSalesEligibility: VariantSalesEligibility;
  variantExcluded: boolean | null;
  catalogProductActive: boolean;
  catalogProductStatus: string | null;
  productExcluded: boolean | null;
  productOverrideIsListed: number | null;
  variantOverrideIsListed: number | null;
  feedId: number | null;
  listingId: number | null;
  externalProductId: string | null;
  externalVariantId: string | null;
  externalInventoryItemId: string | null;
  externalSku: string | null;
  previousQuantity: number | null;
}

interface ClaimRow {
  channel_id: number;
  product_variant_id: number;
  desired_active: boolean;
  revision: string | number;
  attempt_count: number;
  lease_token: string;
  request_kind: "catalog_activation" | "stock_repair" | null;
}

interface ContextRow {
  channel_id: number;
  channel_name: string;
  channel_provider: string;
  channel_status: string;
  channel_sync_enabled: boolean;
  channel_sync_mode: string;
  product_id: number;
  product_variant_id: number;
  catalog_sku: string | null;
  catalog_variant_active: boolean;
  catalog_requires_shipping: boolean;
  catalog_track_inventory: boolean | null;
  catalog_sales_eligibility: VariantSalesEligibility;
  variant_excluded: boolean | null;
  catalog_product_active: boolean;
  catalog_product_status: string | null;
  product_excluded: boolean | null;
  product_override_is_listed: number | null;
  variant_override_is_listed: number | null;
  feed_id: number | null;
  listing_id: number | null;
  external_product_id: string | null;
  external_variant_id: string | null;
  external_inventory_item_id: string | null;
  external_sku: string | null;
  previous_quantity: number | null;
}

export interface EnqueueVariantAvailabilitySyncInput {
  channelId: number;
  productVariantId: number;
  desiredActive: boolean;
  requestKind: "catalog_activation" | "stock_repair";
}

function toPositiveInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return parsed;
}

/** Catalog archive/reactivation locks product then variant before changing the
 * queue. Take the same order before projecting a provider acknowledgement. */
async function lockAvailabilityCatalog(client: SqlClient, variantId: number): Promise<{ archived: boolean }> {
  const parent = (await client.query<{ id: number; is_active: boolean | null; status: string | null }>(`
    SELECT p.id,p.is_active,p.status FROM catalog.products p
    JOIN catalog.product_variants v ON v.product_id=p.id WHERE v.id=$1 FOR SHARE OF p NOWAIT
  `, [toPositiveInteger(variantId, "productVariantId")])).rows[0];
  const variant = (await client.query<{ product_id: number; is_active: boolean | null }>(
    "SELECT product_id,is_active FROM catalog.product_variants WHERE id=$1 FOR SHARE NOWAIT", [variantId])).rows[0];
  if (!parent || !variant || variant.product_id !== parent.id)
    throw new Error("The catalog identity changed before the availability acknowledgement.");
  return { archived: parent.is_active !== true || parent.status === "archived" || variant.is_active !== true };
}

export async function enqueueVariantAvailabilitySync(
  dbPool: SqlQueryable,
  input: EnqueueVariantAvailabilitySyncInput,
): Promise<void> {
  const channelId = toPositiveInteger(input.channelId, "channelId");
  const productVariantId = toPositiveInteger(input.productVariantId, "productVariantId");
  if (typeof input.desiredActive !== "boolean") {
    throw new Error("desiredActive must be a boolean");
  }
  if ((input.requestKind !== "catalog_activation" || !input.desiredActive)
    && (input.requestKind !== "stock_repair" || input.desiredActive)) {
    throw new Error("requestKind must match the requested availability operation");
  }

  await dbPool.query(
    "SELECT channels.request_variant_availability_refresh($1,$2,$3,$4)",
    [channelId, productVariantId, input.desiredActive, input.requestKind],
  );
}

export async function claimVariantAvailabilitySyncs(
  dbPool: SqlPool,
  input: { batchSize: number; leaseSeconds: number },
): Promise<ClaimedVariantAvailabilitySync[]> {
  const batchSize = toPositiveInteger(input.batchSize, "batchSize");
  const leaseSeconds = toPositiveInteger(input.leaseSeconds, "leaseSeconds");
  const leaseToken = randomUUID();
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    // An older process can finish a lease during rolling deployment without
    // knowing about the follow-up. Recover it before claiming this batch.
    await client.query("SELECT channels.promote_completed_availability_followups($1,transaction_timestamp())",
      [Math.min(batchSize, 1000)]);
    const result = await client.query<ClaimRow>(`
      WITH candidates AS (
        SELECT channel_id, product_variant_id
        FROM channels.channel_variant_availability_sync
        WHERE (
            (status IN ('pending', 'retryable') AND next_attempt_at <= transaction_timestamp())
            OR
            (status = 'processing' AND lease_expires_at <= transaction_timestamp())
          )
        ORDER BY next_attempt_at, updated_at, channel_id, product_variant_id
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE channels.channel_variant_availability_sync AS availability
      SET status = 'processing',
          attempt_count = availability.attempt_count + 1,
          lease_token = $2::uuid,
          lease_expires_at = transaction_timestamp() + ($3::integer * interval '1 second'),
          last_error = NULL,
          updated_at = transaction_timestamp()
      FROM candidates
      WHERE availability.channel_id = candidates.channel_id
        AND availability.product_variant_id = candidates.product_variant_id
      RETURNING availability.channel_id,
                availability.product_variant_id,
                availability.desired_active,
                availability.revision,
                availability.attempt_count,
                availability.lease_token,
                CASE WHEN availability.enqueued_revision=availability.revision
                  THEN availability.request_kind ELSE NULL END AS request_kind
    `, [batchSize, leaseToken, leaseSeconds]);
    await client.query("COMMIT");

    return result.rows.map((row) => ({
      channelId: row.channel_id,
      productVariantId: row.product_variant_id,
      desiredActive: row.desired_active,
      revision: toPositiveInteger(row.revision, "revision"),
      attemptCount: row.attempt_count,
      leaseToken: row.lease_token,
      requestKind: row.request_kind,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function loadVariantAvailabilityContext(
  dbPool: SqlPool,
  claim: ClaimedVariantAvailabilitySync,
): Promise<VariantAvailabilityContext | null> {
  const result = await dbPool.query<ContextRow>(`
    SELECT
      channel_row.id AS channel_id,
      channel_row.name AS channel_name,
      channel_row.provider AS channel_provider,
      channel_row.status AS channel_status,
      channel_row.sync_enabled AS channel_sync_enabled,
      channel_row.sync_mode AS channel_sync_mode,
      product_row.id AS product_id,
      variant_row.id AS product_variant_id,
      variant_row.sku AS catalog_sku,
      variant_row.is_active AS catalog_variant_active,
      variant_row.requires_shipping AS catalog_requires_shipping,
      variant_row.track_inventory AS catalog_track_inventory,
      variant_row.sales_eligibility AS catalog_sales_eligibility,
      variant_row.ebay_listing_excluded AS variant_excluded,
      product_row.is_active AS catalog_product_active,
      product_row.status AS catalog_product_status,
      product_row.ebay_listing_excluded AS product_excluded,
      product_override.is_listed AS product_override_is_listed,
      variant_override.is_listed AS variant_override_is_listed,
      feed_row.id AS feed_id,
      listing_row.id AS listing_id,
      COALESCE(listing_row.external_product_id, feed_row.channel_product_id) AS external_product_id,
      COALESCE(listing_row.external_variant_id, feed_row.channel_variant_id) AS external_variant_id,
      feed_row.channel_inventory_item_id AS external_inventory_item_id,
      COALESCE(listing_row.external_sku, feed_row.channel_sku, variant_row.sku) AS external_sku,
      COALESCE(listing_row.last_synced_qty, feed_row.last_synced_qty) AS previous_quantity
    FROM channels.channel_variant_availability_sync AS availability
    JOIN channels.channels AS channel_row
      ON channel_row.id = availability.channel_id
    JOIN catalog.product_variants AS variant_row
      ON variant_row.id = availability.product_variant_id
    JOIN catalog.products AS product_row
      ON product_row.id = variant_row.product_id
    LEFT JOIN channels.channel_feeds AS feed_row
      ON feed_row.channel_id = availability.channel_id
     AND feed_row.product_variant_id = availability.product_variant_id
    LEFT JOIN channels.channel_listings AS listing_row
      ON listing_row.channel_id = availability.channel_id
     AND listing_row.product_variant_id = availability.product_variant_id
    LEFT JOIN channels.channel_product_overrides AS product_override
      ON product_override.channel_id = availability.channel_id
     AND product_override.product_id = product_row.id
    LEFT JOIN channels.channel_variant_overrides AS variant_override
      ON variant_override.channel_id = availability.channel_id
     AND variant_override.product_variant_id = availability.product_variant_id
    WHERE availability.channel_id = $1
      AND availability.product_variant_id = $2
      AND availability.revision = $3
      AND availability.status = 'processing'
      AND availability.lease_token = $4::uuid
    LIMIT 1
  `, [claim.channelId, claim.productVariantId, claim.revision, claim.leaseToken]);

  const row = result.rows[0];
  if (!row) return null;
  return {
    channelId: row.channel_id,
    channelName: row.channel_name,
    channelProvider: row.channel_provider,
    channelStatus: row.channel_status,
    channelSyncEnabled: row.channel_sync_enabled,
    channelSyncMode: row.channel_sync_mode,
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    catalogSku: row.catalog_sku,
    catalogVariantActive: row.catalog_variant_active,
    catalogRequiresShipping: row.catalog_requires_shipping,
    catalogTrackInventory: row.catalog_track_inventory,
    catalogSalesEligibility: row.catalog_sales_eligibility,
    variantExcluded: row.variant_excluded,
    catalogProductActive: row.catalog_product_active,
    catalogProductStatus: row.catalog_product_status,
    productExcluded: row.product_excluded,
    productOverrideIsListed: row.product_override_is_listed,
    variantOverrideIsListed: row.variant_override_is_listed,
    feedId: row.feed_id,
    listingId: row.listing_id,
    externalProductId: row.external_product_id,
    externalVariantId: row.external_variant_id,
    externalInventoryItemId: row.external_inventory_item_id,
    externalSku: row.external_sku,
    previousQuantity: row.previous_quantity,
  };
}

export async function supersedeAvailabilityClaim(
  dbPool: SqlPool,
  claim: ClaimedVariantAvailabilitySync,
  desiredActive: boolean,
): Promise<void> {
  if (typeof desiredActive !== "boolean") throw new Error("desiredActive must be a boolean");
  const result = await dbPool.query<{ rescheduled: boolean }>(
    "SELECT channels.reschedule_variant_availability_claim($1,$2,$3,$4,$5,transaction_timestamp()) AS rescheduled",
    [claim.channelId, claim.productVariantId, claim.revision, claim.leaseToken, desiredActive]);
  if (result.rows[0]?.rescheduled !== true) throw new Error("Superseding availability claim lost its lease or revision");
}

export async function markVariantAvailabilitySynced(
  dbPool: SqlPool,
  claim: ClaimedVariantAvailabilitySync,
  input: {
    quantity: number;
    feedActive: boolean;
    externalProductId: string | null;
    externalVariantId: string | null;
    externalInventoryItemId: string | null;
    externalSku: string | null;
  },
): Promise<boolean> {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const catalog = await lockAvailabilityCatalog(client, claim.productVariantId);
    const lock = await client.query(`
      SELECT revision, status, lease_token
      FROM channels.channel_variant_availability_sync
      WHERE channel_id = $1 AND product_variant_id = $2
      FOR UPDATE
    `, [claim.channelId, claim.productVariantId]);
    const current = lock.rows[0] as { revision?: string | number; status?: string; lease_token?: string } | undefined;
    if (
      !current ||
      toPositiveInteger(current.revision ?? 0, "revision") !== claim.revision ||
      current.status !== "processing" ||
      current.lease_token !== claim.leaseToken
    ) {
      await client.query("ROLLBACK");
      return false;
    }

    // Mapping inserts written by this exact completion are projections of the
    // current claim, not a new request. Other concurrent writers retain a follow-up.
    await client.query("SELECT set_config('echelon.availability_completion_lease',$1,true)", [claim.leaseToken]);
    await client.query(`
      UPDATE channels.channel_feeds
      SET channel_variant_id = COALESCE($3, channel_variant_id),
          channel_inventory_item_id = COALESCE($4, channel_inventory_item_id),
          channel_sku = COALESCE($5, channel_sku),
          is_active = $6,
          last_synced_qty = $7,
          last_synced_at = transaction_timestamp(),
          updated_at = transaction_timestamp()
      WHERE channel_id = $1 AND product_variant_id = $2
    `, [
      claim.channelId,
      claim.productVariantId,
      input.externalVariantId,
      input.externalInventoryItemId,
      input.externalSku,
      input.feedActive && !catalog.archived ? 1 : 0,
      input.quantity,
    ]);

    // This queue supports eBay only. A quantity acknowledgement can establish a
    // mapping, but cannot certify publication or erase its existing failure.
    if (input.externalSku || input.externalVariantId || input.externalProductId) {
      await client.query(`
        INSERT INTO channels.channel_listings (
          channel_id,
          product_variant_id,
          external_product_id,
          external_variant_id,
          external_sku,
          last_synced_qty,
          last_synced_at,
          sync_status,
          sync_error,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, transaction_timestamp(), 'pending', NULL,
                  transaction_timestamp(), transaction_timestamp())
        ON CONFLICT (channel_id, product_variant_id)
        DO UPDATE SET
          external_product_id = COALESCE(EXCLUDED.external_product_id, channels.channel_listings.external_product_id),
          external_variant_id = COALESCE(EXCLUDED.external_variant_id, channels.channel_listings.external_variant_id),
          external_sku = COALESCE(EXCLUDED.external_sku, channels.channel_listings.external_sku),
          last_synced_qty = EXCLUDED.last_synced_qty,
          last_synced_at = EXCLUDED.last_synced_at,
          updated_at = transaction_timestamp()
      `, [
        claim.channelId,
        claim.productVariantId,
        input.externalProductId,
        input.externalVariantId,
        input.externalSku,
        input.quantity,
      ]);
    }

    const completed = await client.query<{ completed: boolean }>(
      "SELECT channels.complete_variant_availability_claim($1,$2,$3,$4,true,$5,transaction_timestamp()) AS completed",
      [claim.channelId, claim.productVariantId, claim.revision, claim.leaseToken, input.quantity]);
    if (completed.rows[0]?.completed !== true) throw new Error("Completing availability sync lost its lease or revision");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Complete the legacy trigger queue after canonical publication has been
 * durably handed to the canonical outbox. Provider acknowledgement and
 * readback remain owned exclusively by inventory_publication_outbox.
 */
export async function markVariantAvailabilityDelegated(
  dbPool: SqlPool,
  claim: ClaimedVariantAvailabilitySync,
): Promise<boolean> {
  const completed = await dbPool.query<{ completed: boolean }>(
    "SELECT channels.complete_variant_availability_claim($1,$2,$3,$4,false,NULL,transaction_timestamp()) AS completed",
    [claim.channelId, claim.productVariantId, claim.revision, claim.leaseToken]);
  return completed.rows[0]?.completed === true;
}

/** Complete a claimed repair without publishing an external quantity. */
export async function markVariantAvailabilityNotApplicable(
  dbPool: SqlPool,
  claim: ClaimedVariantAvailabilitySync,
): Promise<boolean> {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    await lockAvailabilityCatalog(client, claim.productVariantId);
    const lock = await client.query(`
      SELECT 1 FROM channels.channel_variant_availability_sync
      WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3
        AND status='processing' AND lease_token=$4::uuid FOR UPDATE
    `, [claim.channelId, claim.productVariantId, claim.revision, claim.leaseToken]);
    if (lock.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(`
      UPDATE channels.channel_feeds
      SET is_active = 0,
          updated_at = transaction_timestamp()
      WHERE channel_id = $1 AND product_variant_id = $2
    `, [claim.channelId, claim.productVariantId]);
    const completed = await client.query<{ completed: boolean }>(
      "SELECT channels.complete_variant_availability_claim($1,$2,$3,$4,false,NULL,transaction_timestamp()) AS completed",
      [claim.channelId, claim.productVariantId, claim.revision, claim.leaseToken]);
    if (completed.rows[0]?.completed !== true) throw new Error("Completing availability sync lost its lease or revision");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function markVariantAvailabilityFailed(
  dbPool: SqlPool,
  claim: ClaimedVariantAvailabilitySync,
  error: unknown,
): Promise<"retryable" | "superseded"> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const retryDelaySeconds = Math.min(30 * (2 ** Math.min(claim.attemptCount - 1, 6)), 1800);
  const result = await dbPool.query(`
    UPDATE channels.channel_variant_availability_sync
    SET status = 'retryable',
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = transaction_timestamp() + ($5::integer * interval '1 second'),
        completed_at = NULL,
        last_error = $6,
        updated_at = transaction_timestamp()
    WHERE channel_id = $1
      AND product_variant_id = $2
      AND revision = $3
      AND status = 'processing'
      AND lease_token = $4::uuid
  `, [
    claim.channelId,
    claim.productVariantId,
    claim.revision,
    claim.leaseToken,
    retryDelaySeconds,
    message,
  ]);
  if (result.rowCount !== 1) return "superseded";
  return "retryable";
}
