import { randomUUID } from "crypto";
import { z } from "zod";
import type { VariantSalesEligibility } from "@shared/catalog/variant-sales-eligibility";
import { isCustomerSellableVariant } from "@shared/catalog/variant-sales-eligibility";
import { isInventoryManagedVariant } from "@shared/catalog/variant-inventory-eligibility";
import { QuantityPublicationAdmissionError, type PublicationTransactionGuard } from "../inventory-planning/publication-transaction-guard";
import { readQuantityProviderFinality, sameQuantityProviderScope, type QuantityPublicationScope } from "../inventory-planning/quantity-publication-finality";

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
  release(error?: Error): void;
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

/** The exact persisted copies read before the worker plans a provider write.
 * Comparing only their coalesced values would hide a changed secondary copy. */
export interface VariantAvailabilityMappingSnapshot {
  productId: number;
  catalogSku: string | null;
  feed: { id: number; productId: string | null; variantId: string | null; inventoryItemId: string | null; sku: string | null } | null;
  listing: { id: number; productId: string | null; variantId: string | null; sku: string | null } | null;
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
  mappingSnapshot: VariantAvailabilityMappingSnapshot;
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
  feed_product_id: string | null;
  feed_variant_id: string | null;
  feed_inventory_item_id: string | null;
  feed_sku: string | null;
  listing_product_id: string | null;
  listing_variant_id: string | null;
  listing_sku: string | null;
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

/** Lock and compare every saved identity copy, including absent rows. The
 * enclosing caller holds update locks on the Catalog FK parents and then the
 * queue, so a concurrent mapping insert cannot create an unobserved row. */
async function availabilityMappingMatches(client: SqlQueryable, channelId: number, variantId: number,
  expected: VariantAvailabilityMappingSnapshot): Promise<boolean> {
  const variant = (await client.query<{ product_id: number; sku: string | null }>(
    "SELECT product_id,sku FROM catalog.product_variants WHERE id=$1", [variantId])).rows[0];
  const feeds = (await client.query<{ id: number; channel_product_id: string | null; channel_variant_id: string | null;
    channel_inventory_item_id: string | null; channel_sku: string | null }>(`
    SELECT id,channel_product_id,channel_variant_id,channel_inventory_item_id,channel_sku
    FROM channels.channel_feeds WHERE channel_id=$1 AND product_variant_id=$2 FOR SHARE NOWAIT`, [channelId, variantId])).rows;
  const listings = (await client.query<{ id: number; external_product_id: string | null; external_variant_id: string | null;
    external_sku: string | null }>(`
    SELECT id,external_product_id,external_variant_id,external_sku
    FROM channels.channel_listings WHERE channel_id=$1 AND product_variant_id=$2 FOR SHARE NOWAIT`, [channelId, variantId])).rows;
  if (!variant || variant.product_id !== expected.productId || variant.sku !== expected.catalogSku
    || feeds.length > 1 || listings.length > 1 || (feeds.length === 1) !== (expected.feed !== null)
    || (listings.length === 1) !== (expected.listing !== null)) return false;
  const feed = feeds[0];
  const listing = listings[0];
  return (!expected.feed || (feed.id === expected.feed.id && feed.channel_product_id === expected.feed.productId
    && feed.channel_variant_id === expected.feed.variantId && feed.channel_inventory_item_id === expected.feed.inventoryItemId
    && feed.channel_sku === expected.feed.sku))
    && (!expected.listing || (listing.id === expected.listing.id && listing.external_product_id === expected.listing.productId
      && listing.external_variant_id === expected.listing.variantId && listing.external_sku === expected.listing.sku));
}

/** Pin a queue claim and its exact saved mapping in the inventory owner's
 * existing admission/enqueue transaction. This closes the gap between the
 * worker's earlier context read and the point at which work can be sent. */
export function availabilityClaimPublicationGuard(
  claim: ClaimedVariantAvailabilitySync,
  context: VariantAvailabilityContext,
): PublicationTransactionGuard {
  const expected = {
    channelId: toPositiveInteger(claim.channelId, "channelId"),
    productVariantId: toPositiveInteger(claim.productVariantId, "productVariantId"),
    revision: toPositiveInteger(claim.revision, "revision"),
    attemptCount: toPositiveInteger(claim.attemptCount, "attemptCount"),
    desiredActive: claim.desiredActive,
    leaseToken: claim.leaseToken,
    requestKind: claim.requestKind,
    channelProvider: context.channelProvider,
    channelStatus: context.channelStatus,
    channelSyncEnabled: context.channelSyncEnabled,
    channelSyncMode: context.channelSyncMode,
    productId: context.productId,
    catalogRequiresShipping: context.catalogRequiresShipping,
    catalogTrackInventory: context.catalogTrackInventory,
    catalogSalesEligibility: context.catalogSalesEligibility,
    catalogProductActive: context.catalogProductActive,
    catalogProductStatus: context.catalogProductStatus,
    catalogVariantActive: context.catalogVariantActive,
    productExcluded: context.productExcluded,
    variantExcluded: context.variantExcluded,
    productOverrideIsListed: context.productOverrideIsListed,
    variantOverrideIsListed: context.variantOverrideIsListed,
    mapping: { ...context.mappingSnapshot,
      feed: context.mappingSnapshot.feed ? { ...context.mappingSnapshot.feed } : null,
      listing: context.mappingSnapshot.listing ? { ...context.mappingSnapshot.listing } : null },
  };
  if (context.channelId !== expected.channelId || context.productVariantId !== expected.productVariantId) {
    throw new Error("Availability context does not match its claim");
  }
  const assertClaim: PublicationTransactionGuard = async (client,publication) => {
    // Catalog archive/reactivation takes parent then variant before the queue.
    // Use the same order to avoid sending a stale availability decision.
    const catalog = (await client.query<{ active: boolean | null }>(
      "SELECT channels.lock_availability_catalog($1) AS active", [expected.productVariantId])).rows[0];
    if (!catalog || catalog.active === null) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_CATALOG_BUSY",
        "The catalog is changing; retry the saved availability update.");
    }
    // Existing override rows are locked below. Lock both FK parents for update
    // as well, so inserting an absent override cannot race the decision.
    const parent = (await client.query<{ is_active: boolean; status: string | null; ebay_listing_excluded: boolean | null }>(`
      SELECT is_active,status,ebay_listing_excluded FROM catalog.products WHERE id=$1 FOR UPDATE NOWAIT`, [expected.productId])).rows[0];
    const variant = (await client.query<{ product_id: number; sku: string | null; is_active: boolean; requires_shipping: boolean;
      track_inventory: boolean | null; sales_eligibility: VariantSalesEligibility; ebay_listing_excluded: boolean | null }>(`
      SELECT product_id,sku,is_active,requires_shipping,track_inventory,sales_eligibility,ebay_listing_excluded
      FROM catalog.product_variants WHERE id=$1 FOR UPDATE NOWAIT`, [expected.productVariantId])).rows[0];
    const channel = (await client.query<{ provider: string; status: string; sync_enabled: boolean; sync_mode: string }>(`
      SELECT provider,status,sync_enabled,sync_mode FROM channels.channels WHERE id=$1 FOR SHARE NOWAIT`, [expected.channelId])).rows[0];
    if (!channel || channel.provider !== expected.channelProvider || channel.status !== expected.channelStatus
      || channel.sync_enabled !== expected.channelSyncEnabled || channel.sync_mode !== expected.channelSyncMode) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_CHANNEL_CHANGED",
        "The channel connection or sync settings changed before this availability update was admitted. Retry current work.");
    }
    const row = (await client.query<{ desired_active: boolean; attempt_count: number; enqueued_revision: string | number | null; request_kind: string | null }>(`
      SELECT q.desired_active,q.attempt_count,q.enqueued_revision,CASE WHEN q.enqueued_revision=q.revision THEN q.request_kind ELSE NULL END AS request_kind
      FROM channels.channel_variant_availability_sync q
      WHERE q.channel_id=$1 AND q.product_variant_id=$2 AND q.revision=$3
        AND q.status='processing' AND q.lease_token=$4::uuid
      FOR SHARE OF q NOWAIT`, [expected.channelId, expected.productVariantId, expected.revision, expected.leaseToken])).rows[0];
    if (!row || row.desired_active !== expected.desiredActive || row.attempt_count !== expected.attemptCount
      || row.request_kind !== expected.requestKind) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_CLAIM_CHANGED",
        "The saved availability update was replaced or its lease expired. Retry current work.");
    }
    const internalOnlyRepair = expected.requestKind === "stock_repair" && !expected.desiredActive
      && (!catalog.active || (variant && !isCustomerSellableVariant({ salesEligibility: variant.sales_eligibility })));
    if (!parent || !variant || variant.product_id !== expected.productId
      || parent.is_active !== expected.catalogProductActive || parent.status !== expected.catalogProductStatus
      || parent.ebay_listing_excluded !== expected.productExcluded || variant.is_active !== expected.catalogVariantActive
      || variant.ebay_listing_excluded !== expected.variantExcluded
      || variant.requires_shipping !== expected.catalogRequiresShipping
      || variant.track_inventory !== expected.catalogTrackInventory
      || variant.sales_eligibility !== expected.catalogSalesEligibility
      || (!internalOnlyRepair && (!catalog.active || catalog.active !== expected.desiredActive))) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_CATALOG_CHANGED",
        "The catalog changed before this availability update was admitted. Retry current work.");
    }
    const productOverrides = (await client.query<{ is_listed: number | null }>(`
      SELECT is_listed FROM channels.channel_product_overrides WHERE channel_id=$1 AND product_id=$2 FOR SHARE NOWAIT`,
    [expected.channelId, expected.productId])).rows;
    const variantOverrides = (await client.query<{ is_listed: number | null }>(`
      SELECT is_listed FROM channels.channel_variant_overrides WHERE channel_id=$1 AND product_variant_id=$2 FOR SHARE NOWAIT`,
    [expected.channelId, expected.productVariantId])).rows;
    if (productOverrides.length > 1 || variantOverrides.length > 1
      || (productOverrides[0]?.is_listed ?? null) !== expected.productOverrideIsListed
      || (variantOverrides[0]?.is_listed ?? null) !== expected.variantOverrideIsListed) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_SELECTION_CHANGED",
        "Channel inclusion changed before this availability update was admitted. Retry current work.");
    }
    if (!await availabilityMappingMatches(client, expected.channelId, expected.productVariantId, expected.mapping)) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_MAPPING_CHANGED",
        "The saved channel link changed before this update was admitted. Retry current work.");
    }
    // A prior request is bound to the account, environment and exact provider
    // scope actually admitted by Inventory. An unchanged SKU alone cannot
    // authorize replay on a reconnected seller account.
    const priorWork = { channel_id: expected.channelId,product_variant_id: expected.productVariantId,revision: expected.revision,
      attempt_count: row.attempt_count,enqueued_revision: row.enqueued_revision,lease_token: expected.leaseToken,before_state: null };
    const prior = await availabilityAttemptFinality(client,priorWork);
    if (prior.hasAttempts && (!await availabilityClaimHistoryIsComplete(client,priorWork) || !prior.allFinal || !publication || !publication.environment
      || prior.destinations.some(destination => !destination.environment || destination.environment !== publication.environment
        || !publication.scopes.some(scope => sameQuantityProviderScope(scope,destination.scope))))) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_SCOPE_CHANGED",
        "The saved channel account or listing scope cannot be verified for this earlier update. Review the connection before continuing.");
    }
    // A SERIALIZABLE publication transaction can start well before this check,
    // and mapping locks can wait. Check the database clock after taking the
    // locks, rather than accepting a lease based on transaction start time.
    const lease = (await client.query<{ live: boolean }>(`
      SELECT lease_expires_at>clock_timestamp() AS live FROM channels.channel_variant_availability_sync
      WHERE channel_id=$1 AND product_variant_id=$2`, [expected.channelId, expected.productVariantId])).rows[0];
    if (lease?.live !== true) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_CLAIM_CHANGED",
        "The saved availability update's lease expired. Retry current work.");
    }
  };
  const guard: PublicationTransactionGuard = async (client,publication) => {
    try { await assertClaim(client,publication); }
    catch (error) {
      if (error instanceof QuantityPublicationAdmissionError) throw error;
      const sqlState = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
      throw Object.assign(new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_GUARD_FAILED",
        "The saved availability update could not be checked safely. Retry current work.", { sqlState }), { cause: error });
    }
  };
  guard.recordProviderAttempt = async (client, attemptId, publication) => {
    if (!publication.environment || publication.scopes.length !== 1 || publication.providerJournaled !== true)
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_SCOPE_UNVERIFIED",
        "The channel account or provider request journal could not be verified. No provider request was sent.");
    const scope = publication.scopes[0];
    const savedSku = expected.mapping.listing?.sku ?? expected.mapping.feed?.sku ?? expected.mapping.catalogSku;
    if (scope.destinationKind !== "channel_connection" || scope.providerKey !== expected.channelProvider.toLowerCase()
      || !savedSku || scope.externalInventoryItemId !== savedSku) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_SCOPE_CHANGED",
        "The requested provider item does not match this saved channel link. No provider request was sent.");
    }
    const connection = await client.query(`SELECT id FROM channels.channel_connections
      WHERE id=$1 AND channel_id=$2 FOR SHARE NOWAIT`, [scope.connectionId,expected.channelId]);
    if (connection.rows.length !== 1) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_SCOPE_CHANGED",
        "The requested provider connection does not belong to this channel. No provider request was sent.");
    }
    const claimed = await client.query(`SELECT 1 FROM channels.channel_variant_availability_claims
      WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3 AND lease_token=$4::uuid AND attempt_count=$5`,
    [expected.channelId,expected.productVariantId,expected.revision,expected.leaseToken,expected.attemptCount]);
    if (claimed.rows.length !== 1) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_SCOPE_UNVERIFIED",
        "The saved availability claim has no durable ownership receipt. No provider request was sent.");
    }
    await client.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping,provider_environment)
      VALUES($1,$2,$3,$4,$5::uuid,$6,$7,$8::jsonb,$9)`,
    [attemptId, expected.channelId, expected.productVariantId, expected.revision, expected.leaseToken,
      expected.desiredActive, expected.requestKind, JSON.stringify(expected.mapping),publication.environment]);
  };
  return guard;
}

/** Catalog archive/reactivation locks product then variant before changing the
 * queue. Take the same order before projecting a provider acknowledgement. */
async function lockAvailabilityCatalog(client: SqlClient, variantId: number): Promise<{ archived: boolean }> {
  const parent = (await client.query<{ id: number; is_active: boolean | null; status: string | null }>(`
    SELECT p.id,p.is_active,p.status FROM catalog.products p
    JOIN catalog.product_variants v ON v.product_id=p.id WHERE v.id=$1 FOR UPDATE OF p NOWAIT
  `, [toPositiveInteger(variantId, "productVariantId")])).rows[0];
  const variant = (await client.query<{ product_id: number; is_active: boolean | null }>(
    "SELECT product_id,is_active FROM catalog.product_variants WHERE id=$1 FOR UPDATE NOWAIT", [variantId])).rows[0];
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

// Bound the database work for requests whose provider outcome remains unknown.
const AVAILABILITY_REVIEW_RECHECK_SECONDS = 60;
const MAX_AVAILABILITY_BATCH_SIZE = 100;
const MAX_ATTEMPTS_PER_AVAILABILITY_REVISION = 1000;

interface LockedAvailabilityWork {
  channel_id: number;
  product_variant_id: number;
  revision: string | number;
  attempt_count: number;
  enqueued_revision: string | number | null;
  lease_token: string | null;
  before_state: unknown;
}

/** A terminal request says nothing about an unrecorded older claimant. Modern
 * claims are receipted with their lease in the same transaction as the claim. */
async function availabilityClaimHistoryIsComplete(client: SqlQueryable, work: LockedAvailabilityWork): Promise<boolean> {
  const row = (await client.query<{ complete: boolean }>(`
    SELECT channels.has_complete_availability_claim_history($1,$2,$3,$4,$5) AS complete`,
  [work.channel_id,work.product_variant_id,work.revision,work.attempt_count,work.enqueued_revision])).rows[0];
  return row?.complete === true;
}

const savedMappingSchema = z.object({
  productId: z.number().int().positive().max(2_147_483_647),catalogSku: z.string().nullable(),
  feed: z.object({ id: z.number().int().positive().max(2_147_483_647),productId: z.string().nullable(),
    variantId: z.string().nullable(),inventoryItemId: z.string().nullable(),sku: z.string().nullable() }).strict().nullable(),
  listing: z.object({ id: z.number().int().positive().max(2_147_483_647),productId: z.string().nullable(),
    variantId: z.string().nullable(),sku: z.string().nullable() }).strict().nullable(),
}).strict();

/** The queue owns claim associations; Inventory interprets the attempts.
 * Too much or incomplete evidence is retained for review, never guessed. */
async function availabilityAttemptFinality(client: SqlQueryable, work: LockedAvailabilityWork): Promise<{
  hasAttempts: boolean; allFinal: boolean; unresolvedLease: string | null; latestLease: string | null;
  mappings: VariantAvailabilityMappingSnapshot[];
  destinations: Array<{ scope: QuantityPublicationScope;
    environment: "production" | "sandbox" | null }>;
}> {
  const attempts = (await client.query<{ attempt_id: string; lease_token: string; source_mapping: unknown;
    provider_environment: "production" | "sandbox" | null }>(`
    SELECT attempt_id::text,lease_token::text,source_mapping,provider_environment FROM channels.channel_variant_availability_attempts
    WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3
    ORDER BY attempt_id DESC LIMIT $4`,
  [work.channel_id,work.product_variant_id,work.revision,MAX_ATTEMPTS_PER_AVAILABILITY_REVISION + 1])).rows;
  if (!attempts.length) return { hasAttempts: false,allFinal: false,unresolvedLease: null,latestLease: null,mappings: [],destinations: [] };
  if (attempts.length > MAX_ATTEMPTS_PER_AVAILABILITY_REVISION)
    return { hasAttempts: true,allFinal: false,unresolvedLease: attempts[0].lease_token,latestLease: attempts[0].lease_token,mappings: [],destinations: [] };
  const finality = await readQuantityProviderFinality(client,attempts.map(attempt => attempt.attempt_id));
  const mappings = attempts.map(attempt => savedMappingSchema.safeParse(attempt.source_mapping));
  const unresolvedIndex = attempts.findIndex((attempt,index) => finality.get(attempt.attempt_id)?.final !== true || !mappings[index].success);
  return { hasAttempts: true,allFinal: unresolvedIndex < 0,
    unresolvedLease: unresolvedIndex < 0 ? null : attempts[unresolvedIndex].lease_token,latestLease: attempts[0].lease_token,
    mappings: mappings.flatMap(mapping => mapping.success ? [mapping.data] : []),
    destinations: attempts.flatMap(attempt => {
      const scope = finality.get(attempt.attempt_id)?.scope;
      return scope ? [{ scope,environment: attempt.provider_environment }] : [];
    }) };
}

async function availabilityAttemptMappingsCurrent(client: SqlClient, work: LockedAvailabilityWork,
  mappings: readonly VariantAvailabilityMappingSnapshot[]): Promise<boolean> {
  // The queue row is already locked. Catalog uses the opposite order, so all
  // Catalog/mapping locks are NOWAIT; a conflict aborts and retries the batch.
  await lockAvailabilityCatalog(client,work.product_variant_id);
  for (const mapping of mappings) {
    if (!await availabilityMappingMatches(client,work.channel_id,work.product_variant_id,mapping)) return false;
  }
  return true;
}

async function recordAvailabilityReviewDecision(client: SqlClient, work: LockedAvailabilityWork,
  leaseToken: string | null, disposition: "provider_attempt_unsettled" | "provider_attempt_final" | "provider_scope_changed" | "legacy_attempt_history_unverified", after: unknown): Promise<void> {
  await client.query(`INSERT INTO channels.channel_variant_availability_decisions
    (channel_id,product_variant_id,revision,lease_token,disposition,before_state,after_state,occurred_at)
    VALUES($1,$2,$3,$4::uuid,$5,$6::jsonb,$7::jsonb,transaction_timestamp())`,
  [work.channel_id,work.product_variant_id,work.revision,leaseToken,disposition,
    JSON.stringify(work.before_state),JSON.stringify(after)]);
}

async function parkUnverifiedAvailabilityHistory(client: SqlClient, work: LockedAvailabilityWork): Promise<void> {
  const after = (await client.query<{ after_state: unknown }>(`UPDATE channels.channel_variant_availability_sync q
    SET status='needs_review',lease_token=NULL,lease_expires_at=NULL,completed_at=NULL,
      last_error='An older stock update has no complete claim history. Its outcome must be checked before this listing can be transferred or updated.',
      updated_at=transaction_timestamp()
    WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3 RETURNING to_jsonb(q) AS after_state`,
  [work.channel_id,work.product_variant_id,work.revision])).rows[0];
  if (!after) throw new Error("Availability history review lost its locked request.");
  await recordAvailabilityReviewDecision(client,work,work.lease_token,"legacy_attempt_history_unverified",after.after_state);
}

export async function claimVariantAvailabilitySyncs(
  dbPool: SqlPool,
  input: { batchSize: number; leaseSeconds: number },
): Promise<ClaimedVariantAvailabilitySync[]> {
  const batchSize = Math.min(toPositiveInteger(input.batchSize, "batchSize"),MAX_AVAILABILITY_BATCH_SIZE);
  const leaseSeconds = toPositiveInteger(input.leaseSeconds, "leaseSeconds");
  const leaseToken = randomUUID();
  const client = await dbPool.connect();
  let discard: Error | undefined;
  try {
    await client.query("BEGIN");
    // An older process can finish a lease during rolling deployment without
    // knowing about the follow-up. Recover it before claiming this batch.
    await client.query("SELECT channels.promote_completed_availability_followups($1,transaction_timestamp())",
      [Math.min(batchSize, 1000)]);
    // Ask Inventory's finality owner before resuming a parked request. Deferral
    // bounds rechecks without discarding unresolved or ordered follow-up work.
    const reviews = (await client.query<LockedAvailabilityWork & { decision_lease: string }>(`
      SELECT q.channel_id,q.product_variant_id,q.revision,q.attempt_count,q.enqueued_revision,q.lease_token::text,
        to_jsonb(q) AS before_state,decision.lease_token::text AS decision_lease
      FROM channels.channel_variant_availability_sync q
      JOIN LATERAL (
        SELECT d.disposition,d.lease_token FROM channels.channel_variant_availability_decisions d
        WHERE d.channel_id=q.channel_id AND d.product_variant_id=q.product_variant_id AND d.revision=q.revision
          AND d.disposition IN ('provider_attempt_unsettled','provider_attempt_final','provider_scope_changed','legacy_attempt_history_unverified')
        ORDER BY d.id DESC LIMIT 1
      ) decision ON decision.disposition='provider_attempt_unsettled'
      WHERE q.status='needs_review' AND q.next_attempt_at<=transaction_timestamp()
      ORDER BY q.next_attempt_at,q.updated_at,q.channel_id,q.product_variant_id
      FOR UPDATE OF q SKIP LOCKED LIMIT $1
    `,[batchSize])).rows;
    for (const review of reviews) {
      if (!await availabilityClaimHistoryIsComplete(client,review)) {
        await parkUnverifiedAvailabilityHistory(client,review);
        continue;
      }
      const evidence = await availabilityAttemptFinality(client,review);
      const mappingsCurrent = evidence.hasAttempts && evidence.allFinal
        ? await availabilityAttemptMappingsCurrent(client,review,evidence.mappings) : false;
      if (!mappingsCurrent) {
        await client.query(`UPDATE channels.channel_variant_availability_sync SET
          next_attempt_at=transaction_timestamp()+($4::integer * interval '1 second'),updated_at=transaction_timestamp(),
          last_error=CASE WHEN $5::boolean THEN 'The saved channel link changed after a previous request. Review the saved and current links before continuing.' ELSE last_error END
          WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3`,
        [review.channel_id,review.product_variant_id,review.revision,AVAILABILITY_REVIEW_RECHECK_SECONDS,evidence.hasAttempts && evidence.allFinal]);
        continue;
      }
      const updated = (await client.query<{ after_state: unknown }>(`UPDATE channels.channel_variant_availability_sync q
        SET status='retryable',next_attempt_at=transaction_timestamp(),last_error=NULL,updated_at=transaction_timestamp()
        WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3 RETURNING to_jsonb(q) AS after_state`,
      [review.channel_id,review.product_variant_id,review.revision])).rows[0];
      if (!updated) throw new Error("Availability recovery lost its locked request.");
      await recordAvailabilityReviewDecision(client,review,review.decision_lease,"provider_attempt_final",updated.after_state);
    }
    // Lease expiry is not proof that a provider request stopped. A crash can
    // leave a linked attempt running, uncertain, or already acknowledged with
    // no local receipt. Preserve it for recovery instead of sending it again.
    const due = (await client.query<LockedAvailabilityWork>(`
      SELECT q.channel_id,q.product_variant_id,q.revision,q.attempt_count,q.enqueued_revision,q.lease_token::text,to_jsonb(q) AS before_state
      FROM channels.channel_variant_availability_sync q
      WHERE (q.status IN ('pending','retryable') AND q.next_attempt_at<=transaction_timestamp())
        OR (q.status='processing' AND q.lease_expires_at<=transaction_timestamp())
      ORDER BY q.next_attempt_at,q.updated_at,q.channel_id,q.product_variant_id
      FOR UPDATE OF q SKIP LOCKED LIMIT $1
    `,[batchSize])).rows;
    const claimed: ClaimRow[] = [];
    for (const work of due) {
      if (!await availabilityClaimHistoryIsComplete(client,work)) {
        await parkUnverifiedAvailabilityHistory(client,work);
        continue;
      }
      const evidence = await availabilityAttemptFinality(client,work);
      const mappingsCurrent = evidence.hasAttempts && evidence.allFinal
        ? await availabilityAttemptMappingsCurrent(client,work,evidence.mappings) : !evidence.hasAttempts;
      if (!mappingsCurrent) {
        const priorLease = evidence.unresolvedLease ?? evidence.latestLease;
        if (!priorLease) throw new Error("An unresolved availability attempt has no lease evidence.");
        const parked = (await client.query<{ after_state: unknown }>(`UPDATE channels.channel_variant_availability_sync q
          SET status='needs_review',lease_token=NULL,lease_expires_at=NULL,completed_at=NULL,
            last_error=CASE WHEN NULLIF(q.last_error,'') IS NULL THEN $4
              ELSE left($4 || ' Previous error: ' || q.last_error,2000) END,
            updated_at=transaction_timestamp()
          WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3 RETURNING to_jsonb(q) AS after_state`,
        [work.channel_id,work.product_variant_id,work.revision,evidence.allFinal
          ? "The saved channel link changed after a previous request. Review the saved and current links before continuing."
          : "A previous channel request needs to be checked before another stock update can be sent."])).rows[0];
        if (!parked) throw new Error("Availability review lost its locked request.");
        await recordAvailabilityReviewDecision(client,work,priorLease,"provider_attempt_unsettled",parked.after_state);
        continue;
      }
      const row = (await client.query<ClaimRow>(`UPDATE channels.channel_variant_availability_sync q
        SET status='processing',attempt_count=q.attempt_count+1,lease_token=$4::uuid,
          lease_expires_at=transaction_timestamp()+($5::integer * interval '1 second'),last_error=NULL,updated_at=transaction_timestamp()
        WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3
        RETURNING q.channel_id,q.product_variant_id,q.desired_active,q.revision,q.attempt_count,q.lease_token,
          CASE WHEN q.enqueued_revision=q.revision THEN q.request_kind ELSE NULL END AS request_kind`,
      [work.channel_id,work.product_variant_id,work.revision,leaseToken,leaseSeconds])).rows[0];
      if (!row) throw new Error("Availability claim lost its locked request.");
      await client.query(`INSERT INTO channels.channel_variant_availability_claims
        (channel_id,product_variant_id,revision,lease_token,attempt_count) VALUES($1,$2,$3,$4::uuid,$5)`,
      [row.channel_id,row.product_variant_id,row.revision,row.lease_token,row.attempt_count]);
      claimed.push(row);
    }
    await client.query("COMMIT");

    return claimed.map((row) => ({
      channelId: row.channel_id,
      productVariantId: row.product_variant_id,
      desiredActive: row.desired_active,
      revision: toPositiveInteger(row.revision, "revision"),
      attemptCount: row.attempt_count,
      leaseToken: row.lease_token,
      requestKind: row.request_kind,
    }));
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) {
      discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      throw new AggregateError([error,rollbackError],"Availability claim and rollback both failed.");
    }
    throw error;
  } finally {
    client.release(discard);
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
      feed_row.channel_product_id AS feed_product_id,
      feed_row.channel_variant_id AS feed_variant_id,
      feed_row.channel_inventory_item_id AS feed_inventory_item_id,
      feed_row.channel_sku AS feed_sku,
      listing_row.external_product_id AS listing_product_id,
      listing_row.external_variant_id AS listing_variant_id,
      listing_row.external_sku AS listing_sku,
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
    mappingSnapshot: { productId: row.product_id, catalogSku: row.catalog_sku,
      feed: row.feed_id === null ? null : { id: row.feed_id, productId: row.feed_product_id,
        variantId: row.feed_variant_id, inventoryItemId: row.feed_inventory_item_id, sku: row.feed_sku },
      listing: row.listing_id === null ? null : { id: row.listing_id, productId: row.listing_product_id,
        variantId: row.listing_variant_id, sku: row.listing_sku } },
  };
}

export async function supersedeAvailabilityClaim(
  dbPool: SqlPool,
  claim: ClaimedVariantAvailabilitySync,
  desiredActive: boolean,
): Promise<"superseded" | "needs_review"> {
  if (typeof desiredActive !== "boolean") throw new Error("desiredActive must be a boolean");
  const client = await dbPool.connect();
  let discard: Error | undefined;
  try {
    await client.query("BEGIN");
    await lockAvailabilityCatalog(client,claim.productVariantId);
    const work = (await client.query<LockedAvailabilityWork>(`SELECT q.channel_id,q.product_variant_id,q.revision,
      q.attempt_count,q.enqueued_revision,q.lease_token::text,to_jsonb(q) AS before_state
      FROM channels.channel_variant_availability_sync q
      WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3 AND status='processing' AND lease_token=$4::uuid FOR UPDATE`,
    [claim.channelId,claim.productVariantId,claim.revision,claim.leaseToken])).rows[0];
    if (!work) throw new Error("Superseding availability claim lost its lease or revision");
    const completeHistory = await availabilityClaimHistoryIsComplete(client,work);
    const attempts = completeHistory ? await availabilityAttemptFinality(client,work) : null;
    const currentAttempt = (await client.query(`SELECT 1 FROM channels.channel_variant_availability_attempts
      WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3 AND lease_token=$4::uuid LIMIT 1`,
    [claim.channelId,claim.productVariantId,claim.revision,claim.leaseToken])).rows.length > 0;
    const previousFinal = completeHistory && !currentAttempt && !!attempts
      && (!attempts.hasAttempts || (attempts.allFinal && await availabilityAttemptMappingsCurrent(client,work,attempts.mappings)));
    const result = await client.query<{ rescheduled: boolean }>(
      "SELECT channels.reschedule_variant_availability_claim($1,$2,$3,$4,$5,transaction_timestamp(),$6) AS rescheduled",
      [claim.channelId,claim.productVariantId,claim.revision,claim.leaseToken,desiredActive,previousFinal]);
    if (result.rows[0]?.rescheduled !== true) throw new Error("Superseding availability claim lost its lease or revision");
    const status = (await client.query<{ status: string }>(`SELECT status FROM channels.channel_variant_availability_sync
      WHERE channel_id=$1 AND product_variant_id=$2`,[claim.channelId,claim.productVariantId])).rows[0]?.status;
    if (!status) throw new Error("Superseded availability request disappeared.");
    await client.query("COMMIT");
    return status === "needs_review" ? "needs_review" : "superseded";
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) {
      discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      throw new AggregateError([error,rollbackError],"Availability replanning and rollback both failed.");
    }
    throw error;
  } finally { client.release(discard); }
}

type AvailabilityAcknowledgement = "synced" | "claim_changed" | "needs_review";
type AvailabilityAcknowledgementDisposition = "provider_acknowledged_projected"
  | "provider_acknowledged_claim_changed" | "provider_acknowledged_mapping_changed" | "provider_acknowledged_projection_failed";
type AvailabilityAcknowledgementResult = { quantity: number; feedActive: boolean; externalProductId: string | null;
  externalVariantId: string | null; externalInventoryItemId: string | null; externalSku: string | null };

async function readAvailabilityAcknowledgement(client: SqlQueryable, claim: ClaimedVariantAvailabilitySync,
  input: AvailabilityAcknowledgementResult, source: VariantAvailabilityMappingSnapshot): Promise<AvailabilityAcknowledgement | null> {
  const saved = (await client.query<{ disposition: AvailabilityAcknowledgementDisposition; matches: boolean }>(`
    SELECT disposition,(before_state->'sourceMapping'=$5::jsonb AND before_state->'acknowledgedResult'=$6::jsonb) AS matches
    FROM channels.channel_variant_availability_decisions
    WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3 AND lease_token=$4::uuid
      AND disposition IN ('provider_acknowledged_mapping_changed','provider_acknowledged_claim_changed',
        'provider_acknowledged_projected','provider_acknowledged_projection_failed')`,
  [claim.channelId,claim.productVariantId,claim.revision,claim.leaseToken,JSON.stringify(source),JSON.stringify(input)])).rows;
  if (saved.length === 0) return null;
  if (saved.length !== 1 || saved[0].matches !== true) {
    throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_ACKNOWLEDGEMENT_CONFLICT",
      "A previous acknowledgement for this saved update has different evidence. Review the saved request.");
  }
  return saved[0].disposition === "provider_acknowledged_projected" ? "synced"
    : saved[0].disposition === "provider_acknowledged_claim_changed" ? "claim_changed" : "needs_review";
}

/** Every completed callback keeps one immutable, replay-checked receipt, even
 * if its lease was replaced while the provider request was in flight. */
async function recordAvailabilityAcknowledgement(client: SqlQueryable, claim: ClaimedVariantAvailabilitySync,
  input: AvailabilityAcknowledgementResult, source: VariantAvailabilityMappingSnapshot,
  disposition: AvailabilityAcknowledgementDisposition, before: unknown, after: unknown): Promise<AvailabilityAcknowledgement> {
  await client.query(`INSERT INTO channels.channel_variant_availability_decisions
    (channel_id,product_variant_id,revision,lease_token,disposition,before_state,after_state,occurred_at)
    VALUES($1,$2,$3,$4::uuid,$5,$6::jsonb,$7::jsonb,transaction_timestamp()) ON CONFLICT DO NOTHING`,
  [claim.channelId,claim.productVariantId,claim.revision,claim.leaseToken,disposition,
    JSON.stringify({ queue: before ?? null,sourceMapping: source,acknowledgedResult: input }),JSON.stringify(after ?? null)]);
  const saved = await readAvailabilityAcknowledgement(client,claim,input,source);
  if (saved === null) throw new Error("Availability acknowledgement was not saved");
  return saved;
}

export async function markVariantAvailabilitySynced(
  dbPool: SqlPool,
  claim: ClaimedVariantAvailabilitySync,
  input: AvailabilityAcknowledgementResult,
  source: VariantAvailabilityMappingSnapshot,
): Promise<AvailabilityAcknowledgement> {
  const client = await dbPool.connect();
  let discard: Error | undefined;
  try {
    await client.query("BEGIN");
    const catalog = await lockAvailabilityCatalog(client, claim.productVariantId);
    const lock = await client.query(`
      SELECT revision, status, lease_token,to_jsonb(q) AS before_state
      FROM channels.channel_variant_availability_sync
      AS q
      WHERE channel_id = $1 AND product_variant_id = $2
      FOR UPDATE
    `, [claim.channelId, claim.productVariantId]);
    const current = lock.rows[0] as { revision?: string | number; status?: string; lease_token?: string; before_state?: unknown } | undefined;
    const replay = await readAvailabilityAcknowledgement(client,claim,input,source);
    if (replay !== null) { await client.query("COMMIT"); return replay; }
    if (
      !current ||
      toPositiveInteger(current.revision ?? 0, "revision") !== claim.revision ||
      current.status !== "processing" ||
      current.lease_token !== claim.leaseToken
    ) {
      const outcome = await recordAvailabilityAcknowledgement(client,claim,input,source,
        "provider_acknowledged_claim_changed",current?.before_state,current?.before_state);
      await client.query("COMMIT");
      return outcome;
    }

    // An acknowledged provider write may have been sent before the link was
    // edited. Keep its exact attempt evidence and ordered follow-ups, but never
    // project that old response onto a different current link.
    if (!await availabilityMappingMatches(client, claim.channelId, claim.productVariantId, source)) {
      const after = await client.query<{ after_state: unknown }>(`UPDATE channels.channel_variant_availability_sync AS q
        SET status='needs_review',lease_token=NULL,lease_expires_at=NULL,completed_at=NULL,
            last_error='A previous stock update completed after this channel link changed. Review the saved and current links before continuing.',
            updated_at=transaction_timestamp()
        WHERE channel_id=$1 AND product_variant_id=$2 RETURNING to_jsonb(q) AS after_state`,
      [claim.channelId, claim.productVariantId]);
      const outcome = await recordAvailabilityAcknowledgement(client,claim,input,source,
        "provider_acknowledged_mapping_changed",current.before_state,after.rows[0].after_state);
      await client.query("COMMIT");
      return outcome;
    }

    // Mapping inserts written by this exact completion are projections of the
    // current claim, not a new request. Other concurrent writers retain a follow-up.
    await client.query("SELECT set_config('echelon.availability_completion_lease',$1,true)", [claim.leaseToken]);
    await client.query(`
      UPDATE channels.channel_feeds
      SET is_active = $3,
          last_synced_qty = $4,
          last_synced_at = transaction_timestamp(),
          updated_at = transaction_timestamp()
      WHERE channel_id = $1 AND product_variant_id = $2
    `, [
      claim.channelId,
      claim.productVariantId,
      input.feedActive && !catalog.archived ? 1 : 0,
      input.quantity,
    ]);

    // A stock acknowledgement establishes neither a listing nor its identity.
    // Only update the quantity projection on a mapping that already exists.
    await client.query(`
      UPDATE channels.channel_listings SET last_synced_qty=$3,
        last_synced_at=transaction_timestamp(),updated_at=transaction_timestamp()
      WHERE channel_id=$1 AND product_variant_id=$2
    `, [claim.channelId,claim.productVariantId,input.quantity]);

    const completed = await client.query<{ completed: boolean }>(
      "SELECT channels.complete_variant_availability_claim($1,$2,$3,$4,true,$5,transaction_timestamp()) AS completed",
      [claim.channelId, claim.productVariantId, claim.revision, claim.leaseToken, input.quantity]);
    if (completed.rows[0]?.completed !== true) throw new Error("Completing availability sync lost its lease or revision");
    const after = (await client.query<{ state: unknown }>(`SELECT to_jsonb(q) AS state FROM channels.channel_variant_availability_sync q
      WHERE channel_id=$1 AND product_variant_id=$2`, [claim.channelId,claim.productVariantId])).rows[0]?.state;
    const outcome = await recordAvailabilityAcknowledgement(client,claim,input,source,
      "provider_acknowledged_projected",current.before_state,after);
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) {
      discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      throw new AggregateError([error,rollbackError],"Availability acknowledgement and rollback both failed.");
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

/** If projection fails after a provider acknowledgement, save that result
 * without re-sending it. Lock only the queue here: the original projection
 * failure can be a busy Catalog lock, and this path never waits for Catalog. */
export async function retainVariantAvailabilityAcknowledgement(
  dbPool: SqlPool, claim: ClaimedVariantAvailabilitySync, input: AvailabilityAcknowledgementResult,
  source: VariantAvailabilityMappingSnapshot,
): Promise<AvailabilityAcknowledgement> {
  const client = await dbPool.connect();
  let discard: Error | undefined;
  try {
    await client.query("BEGIN");
    const current = (await client.query<{ revision: string | number; status: string; lease_token: string | null; before_state: unknown }>(`
      SELECT revision,status,lease_token,to_jsonb(q) AS before_state FROM channels.channel_variant_availability_sync q
      WHERE channel_id=$1 AND product_variant_id=$2 FOR UPDATE`, [claim.channelId,claim.productVariantId])).rows[0];
    const replay = await readAvailabilityAcknowledgement(client,claim,input,source);
    if (replay !== null) { await client.query("COMMIT"); return replay; }
    if (!current || toPositiveInteger(current.revision, "revision") !== claim.revision
      || current.status !== "processing" || current.lease_token !== claim.leaseToken) {
      const outcome = await recordAvailabilityAcknowledgement(client,claim,input,source,
        "provider_acknowledged_claim_changed",current?.before_state,current?.before_state);
      await client.query("COMMIT"); return outcome;
    }
    const after = (await client.query<{ after_state: unknown }>(`UPDATE channels.channel_variant_availability_sync q
      SET status='needs_review',lease_token=NULL,lease_expires_at=NULL,completed_at=NULL,
        last_error='The channel confirmed a stock update, but Echelon could not save its result. Review the saved request before continuing.',
        updated_at=transaction_timestamp() WHERE channel_id=$1 AND product_variant_id=$2 RETURNING to_jsonb(q) AS after_state`,
    [claim.channelId,claim.productVariantId])).rows[0];
    const outcome = await recordAvailabilityAcknowledgement(client,claim,input,source,
      "provider_acknowledged_projection_failed",current.before_state,after.after_state);
    await client.query("COMMIT"); return outcome;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) {
      discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      throw new AggregateError([error,rollbackError],"Availability receipt retention and rollback both failed.");
    }
    throw error;
  } finally { client.release(discard); }
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
  let discard: Error | undefined;
  try {
    await client.query("BEGIN");
    const catalog = await lockAvailabilityCatalog(client, claim.productVariantId);
    const lock = await client.query<{ desired_active: boolean; request_kind: string | null }>(`
      SELECT desired_active,CASE WHEN enqueued_revision=revision THEN request_kind ELSE NULL END AS request_kind
      FROM channels.channel_variant_availability_sync
      WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3
        AND status='processing' AND lease_token=$4::uuid FOR UPDATE
    `, [claim.channelId, claim.productVariantId, claim.revision, claim.leaseToken]);
    if (lock.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    const current = lock.rows[0];
    const lease = (await client.query<{ live: boolean }>(`
      SELECT lease_expires_at>clock_timestamp() AS live FROM channels.channel_variant_availability_sync
      WHERE channel_id=$1 AND product_variant_id=$2`, [claim.channelId, claim.productVariantId])).rows[0];
    if (current.desired_active !== claim.desiredActive || current.request_kind !== claim.requestKind || lease?.live !== true) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_CLAIM_CHANGED",
        "The saved availability update changed or its lease expired. Retry current work.");
    }
    const variant = (await client.query<{ requires_shipping: boolean; track_inventory: boolean | null;
      sales_eligibility: VariantSalesEligibility }>(`
      SELECT requires_shipping,track_inventory,sales_eligibility FROM catalog.product_variants WHERE id=$1`,
    [claim.productVariantId])).rows[0];
    const internalOnlyRepair = claim.requestKind === "stock_repair" && !claim.desiredActive
      && (catalog.archived || (variant && !isCustomerSellableVariant({ salesEligibility: variant.sales_eligibility })));
    const stillNotApplicable = variant && (!isInventoryManagedVariant({ requiresShipping: variant.requires_shipping,
      trackInventory: variant.track_inventory }) || (!isCustomerSellableVariant({ salesEligibility: variant.sales_eligibility })
      && !internalOnlyRepair));
    if (!stillNotApplicable || (catalog.archived && !internalOnlyRepair)) {
      throw new QuantityPublicationAdmissionError("VARIANT_AVAILABILITY_CATALOG_CHANGED",
        "The variant changed before the availability update was completed. Retry current work.");
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
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) {
      discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      throw new AggregateError([error,rollbackError],"Availability completion and rollback both failed.");
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

export async function markVariantAvailabilityFailed(
  dbPool: SqlPool,
  claim: ClaimedVariantAvailabilitySync,
  error: unknown,
): Promise<"retryable" | "superseded" | "needs_review"> {
  if (error instanceof QuantityPublicationAdmissionError
    && (error.code === "VARIANT_AVAILABILITY_SCOPE_CHANGED" || error.code === "VARIANT_AVAILABILITY_SCOPE_UNVERIFIED")) {
    return parkAvailabilityScopeChange(dbPool,claim,error);
  }
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

/** Do not hot-loop or retarget an older update when its account is no longer
 * the one Inventory admitted. The shared lifecycle must resolve this evidence. */
async function parkAvailabilityScopeChange(dbPool: SqlPool, claim: ClaimedVariantAvailabilitySync,
  error: QuantityPublicationAdmissionError): Promise<"needs_review" | "superseded"> {
  const client = await dbPool.connect();
  let discard: Error | undefined;
  try {
    await client.query("BEGIN");
    const work = (await client.query<LockedAvailabilityWork>(`SELECT channel_id,product_variant_id,revision,attempt_count,enqueued_revision,lease_token::text,to_jsonb(q) AS before_state
      FROM channels.channel_variant_availability_sync q WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3
        AND status='processing' AND lease_token=$4::uuid FOR UPDATE`,
    [claim.channelId,claim.productVariantId,claim.revision,claim.leaseToken])).rows[0];
    if (!work) { await client.query("COMMIT"); return "superseded"; }
    const after = (await client.query<{ after_state: unknown }>(`UPDATE channels.channel_variant_availability_sync q
      SET status='needs_review',lease_token=NULL,lease_expires_at=NULL,completed_at=NULL,last_error=$4,updated_at=transaction_timestamp()
      WHERE channel_id=$1 AND product_variant_id=$2 AND revision=$3 RETURNING to_jsonb(q) AS after_state`,
    [claim.channelId,claim.productVariantId,claim.revision,error.message.slice(0,2000)])).rows[0];
    if (!after) throw new Error("Availability scope review lost its locked request.");
    await recordAvailabilityReviewDecision(client,work,claim.leaseToken,"provider_scope_changed",after.after_state);
    await client.query("COMMIT");
    return "needs_review";
  } catch (failure) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) {
      discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      throw new AggregateError([failure,rollbackError],"Availability scope review and rollback both failed.");
    }
    throw failure;
  } finally { client.release(discard); }
}
