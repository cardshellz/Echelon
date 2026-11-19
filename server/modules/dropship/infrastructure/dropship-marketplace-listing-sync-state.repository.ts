import type { PoolClient } from "pg";
import {
  MARKETPLACE_ISSUE_CODES,
  type MarketplaceIssueCode,
  type MarketplaceSyncedBaseline,
} from "../domain/marketplace-sync-decision";
import {
  MARKETPLACE_ATTEMPT_EVENT_TYPE,
  MARKETPLACE_BASELINE_EVENT_TYPES,
  MARKETPLACE_PUSH_COMPLETED_EVENT_TYPE,
  MARKETPLACE_SYNCED_EVENT_TYPE,
  type MarketplaceSyncEvent,
} from "../domain/marketplace-sync-history";
import { MARKETPLACE_SYNC_ACTOR } from "../domain/marketplace-sync-keys";
import { marketplaceSyncError, MARKETPLACE_SYNC_CODES } from "../domain/marketplace-sync-errors";

/**
 * eBay sync-back's state on the listing row (dropship_vendor_listings, the
 * columns of migration *_dropship_ebay_sync_back.sql) and its sync events.
 * Every function runs on the caller's client inside the caller's
 * transaction and takes no lock of its own: the sync use case holds the
 * plan's lock order (§6.5: request key, store, owner rows, the listing FOR
 * UPDATE) before calling a writer. Writers that change what the vendor sees
 * write their audit row in the same statement batch, so the audit commits or
 * rolls back with the change. Compare-and-set writers answer whether they
 * applied; they never overwrite a value another writer changed.
 */
type Client = Pick<PoolClient, "query">;

export interface MarketplaceListingSyncState {
  listingId: number;
  vendorId: number;
  storeConnectionId: number;
  productVariantId: number;
  platform: string;
  status: string;
  externalListingId: string | null;
  externalOfferId: string | null;
  pushedQuantity: number;
  lastPushedAt: Date | null;
  observedMarketplacePriceCents: number | null;
  lastMarketplaceSyncAt: Date | null;
  driftDetectedAt: Date | null;
  marketplaceSyncAttemptedAt: Date | null;
  issueCodes: MarketplaceIssueCode[];
  marketplaceEndedAt: Date | null;
  observedFulfillmentPolicyId: string | null;
  vendorQuantityLimit: number | null;
  quantityBaseline: { quantity: number; at: Date } | null;
  observedQuantity: { quantity: number; at: Date } | null;
}

interface StateRow {
  id: number; vendor_id: number; store_connection_id: number; product_variant_id: number; platform: string; status: string;
  external_listing_id: string | null; external_offer_id: string | null; pushed_quantity: number; last_pushed_at: Date | null;
  observed_marketplace_price_cents: string | number | null; last_marketplace_sync_at: Date | null; drift_detected_at: Date | null;
  marketplace_sync_attempted_at: Date | null; marketplace_issue_codes: string[]; marketplace_ended_at: Date | null;
  observed_fulfillment_policy_id: string | null; vendor_quantity_limit: number | null;
  marketplace_quantity_baseline: number | null; marketplace_quantity_baseline_at: Date | null;
  observed_marketplace_quantity: number | null; observed_marketplace_quantity_at: Date | null;
}

const STATE_COLUMNS = `id, vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id, external_offer_id,
  pushed_quantity, last_pushed_at, observed_marketplace_price_cents, last_marketplace_sync_at, drift_detected_at,
  marketplace_sync_attempted_at, marketplace_issue_codes, marketplace_ended_at, observed_fulfillment_policy_id,
  vendor_quantity_limit, marketplace_quantity_baseline, marketplace_quantity_baseline_at, observed_marketplace_quantity, observed_marketplace_quantity_at`;

/** One listing's sync state; `forUpdate` locks the row (the adoption transaction's step 4). Null when it does not exist. */
export async function readMarketplaceListingSyncStateWithClient(client: Client, listingId: number,
  options: { forUpdate?: boolean } = {}): Promise<MarketplaceListingSyncState | null> {
  const result = await client.query<StateRow>(`SELECT ${STATE_COLUMNS} FROM dropship.dropship_vendor_listings WHERE id = $1
    ${options.forUpdate ? "FOR UPDATE" : ""}`, [listingId]);
  return result.rows[0] ? mapState(result.rows[0]) : null;
}

/** The sweep read this listing at `at` (successfully or not): it moves to the back of its store's order. */
export async function recordMarketplaceSyncAttemptWithClient(client: Client, listingId: number, at: Date): Promise<void> {
  await client.query(`UPDATE dropship.dropship_vendor_listings SET marketplace_sync_attempted_at = $2 WHERE id = $1`, [listingId, at]);
}

/** Due now (NULL): the next sweep reads these first (completeItem, parked orders, the IP hook, §6.2). */
export async function markListingsMarketplaceSyncDueWithClient(client: Client, listingIds: readonly number[]): Promise<number> {
  if (listingIds.length === 0) return 0;
  const result = await client.query(`UPDATE dropship.dropship_vendor_listings SET marketplace_sync_attempted_at = NULL
    WHERE id = ANY($1::int[]) AND marketplace_sync_attempted_at IS NOT NULL`, [[...new Set(listingIds)]]);
  return result.rowCount ?? 0;
}

/** What eBay shows that later reads and pushes compare with (the live-policy rule reads observed_fulfillment_policy_id, §4.3). */
export async function recordMarketplaceObservedFieldsWithClient(client: Client, input: {
  listingId: number; observedPriceCents: number; observedFulfillmentPolicyId: string | null; syncedAt: Date;
}): Promise<void> {
  await client.query(`UPDATE dropship.dropship_vendor_listings SET observed_marketplace_price_cents = $2,
      observed_fulfillment_policy_id = COALESCE($3, observed_fulfillment_policy_id), last_marketplace_sync_at = $4
    WHERE id = $1`, [input.listingId, input.observedPriceCents, input.observedFulfillmentPolicyId, input.syncedAt]);
}

/**
 * Adds and removes issue codes in one atomic update. drift_detected_at is the
 * first sighting of the open set: set when it becomes non-empty, cleared when
 * it empties. Codes are stored sorted, so equal sets are equal arrays.
 */
export async function updateMarketplaceIssueCodesWithClient(client: Client, input: {
  listingId: number; add: readonly MarketplaceIssueCode[]; remove: readonly MarketplaceIssueCode[]; at: Date;
}): Promise<MarketplaceIssueCode[]> {
  for (const code of [...input.add, ...input.remove]) {
    if (!(MARKETPLACE_ISSUE_CODES as readonly string[]).includes(code)) {
      throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "Unknown marketplace issue code.", "fatal", { code });
    }
  }
  const result = await client.query<{ marketplace_issue_codes: string[] }>(`WITH next AS (
      SELECT COALESCE(array_agg(code ORDER BY code), '{}'::text[]) AS codes FROM (
        SELECT unnest(l.marketplace_issue_codes) AS code FROM dropship.dropship_vendor_listings l WHERE l.id = $1
        UNION SELECT unnest($2::text[])) merged
      WHERE code <> ALL($3::text[]))
    UPDATE dropship.dropship_vendor_listings l SET marketplace_issue_codes = next.codes,
      drift_detected_at = CASE WHEN next.codes = '{}'::text[] THEN NULL ELSE COALESCE(l.drift_detected_at, $4) END
    FROM next WHERE l.id = $1 RETURNING l.marketplace_issue_codes`, [input.listingId, [...input.add], [...input.remove], input.at]);
  if (!result.rows[0]) throw listingNotFound(input.listingId);
  return result.rows[0].marketplace_issue_codes as MarketplaceIssueCode[];
}

export interface QuantityObservation { quantity: number; at: Date }

/**
 * Saves the read's Qe for a later decision (§6.4), only when the saved one is
 * still `expected` (null: none is saved). Answers whether it applied.
 */
export async function saveQuantityObservationWithClient(client: Client, input: {
  listingId: number; observation: QuantityObservation; expected: QuantityObservation | null;
}): Promise<boolean> {
  const result = await client.query(`UPDATE dropship.dropship_vendor_listings
    SET observed_marketplace_quantity = $2, observed_marketplace_quantity_at = $3
    WHERE id = $1 AND ${observationIs("$4", "$5")}`,
  [input.listingId, input.observation.quantity, input.observation.at, input.expected?.quantity ?? null, input.expected?.at ?? null]);
  return result.rowCount === 1;
}

/** Clears a decided or dropped observation, only when it is still the one decided. */
export async function clearQuantityObservationWithClient(client: Client, input: {
  listingId: number; expected: QuantityObservation;
}): Promise<boolean> {
  const result = await client.query(`UPDATE dropship.dropship_vendor_listings
    SET observed_marketplace_quantity = NULL, observed_marketplace_quantity_at = NULL
    WHERE id = $1 AND ${observationIs("$2", "$3")}`, [input.listingId, input.expected.quantity, input.expected.at]);
  return result.rowCount === 1;
}

/** A decided change of the listing's vendor limit (marketplace-quantity-decision.ts set_limit / clear_limit). */
export type VendorQuantityLimitChange = { kind: "set"; limit: number } | { kind: "clear" };

/**
 * Applies a decided vendor limit change (§6.4, owner rule 1): eBay's number
 * becomes the limit, or the limit is cleared. One compare-and-set on the
 * decided observation and on the limit the decision saw, so a replay or a
 * concurrent decision changes nothing; the observation is cleared and, when
 * eBay's number stands (`baseline` not null), it becomes the limit baseline
 * B. The audit row (actor system) records the before and after limit and the
 * key the observation gives. Answers whether it applied.
 */
export async function applyVendorQuantityLimitWithClient(client: Client, input: {
  listingId: number; decidedObservation: QuantityObservation; expectedLimit: number | null; change: VendorQuantityLimitChange;
  baseline: QuantityObservation | null; changedAt: Date; idempotencyKey: string;
}): Promise<{ applied: boolean }> {
  const limitAfter = input.change.kind === "set" ? input.change.limit : null;
  if (limitAfter !== null && (!Number.isSafeInteger(limitAfter) || limitAfter < 0)) {
    throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "A vendor limit must be a whole number.", "fatal", { limitAfter });
  }
  const result = await client.query<{ vendor_id: number; store_connection_id: number }>(`
    UPDATE dropship.dropship_vendor_listings
    SET vendor_quantity_limit = $4::integer,
      marketplace_quantity_baseline = CASE WHEN $6::timestamptz IS NULL THEN marketplace_quantity_baseline ELSE $5::integer END,
      marketplace_quantity_baseline_at = COALESCE($6::timestamptz, marketplace_quantity_baseline_at),
      observed_marketplace_quantity = NULL, observed_marketplace_quantity_at = NULL
    WHERE id = $1 AND ${observationIs("$2", "$3")} AND vendor_quantity_limit IS NOT DISTINCT FROM $7::integer
    RETURNING vendor_id, store_connection_id`,
  [input.listingId, input.decidedObservation.quantity, input.decidedObservation.at, limitAfter,
    input.baseline?.quantity ?? null, input.baseline?.at ?? null, input.expectedLimit]);
  const row = result.rows[0];
  if (!row) return { applied: false };
  await insertListingAudit(client, { vendorId: row.vendor_id, storeConnectionId: row.store_connection_id, listingId: input.listingId,
    eventType: input.change.kind === "set" ? "listing_quantity_limit_saved" : "listing_quantity_limit_cleared", ...systemActor(),
    payload: { before: { vendorQuantityLimit: input.expectedLimit }, after: { vendorQuantityLimit: limitAfter },
      observedQuantity: input.decidedObservation.quantity, observedAt: input.decidedObservation.at.toISOString(),
      idempotencyKey: input.idempotencyKey }, at: input.changedAt });
  return { applied: true };
}

/**
 * Dead-letters one listing for the sweep (CLAUDE.md §6, permanent): a failure
 * of Card Shellz's own (a defect or a refusal no retry can fix) adds the issue
 * sync_requires_review, which the sweep's selection skips, so it is never
 * retried, and writes one audit row (severity error, actor system) with the
 * failure's code for the person who reviews it. Answers whether it applied.
 */
export async function deadLetterMarketplaceListingWithClient(client: Client, input: {
  listingId: number; failureCode: string; at: Date;
}): Promise<boolean> {
  const state = await readMarketplaceListingSyncStateWithClient(client, input.listingId, { forUpdate: true });
  if (!state) return false;
  await updateMarketplaceIssueCodesWithClient(client, { listingId: input.listingId, add: ["sync_requires_review"], remove: [], at: input.at });
  await recordMarketplaceSyncAttemptWithClient(client, input.listingId, input.at);
  await client.query(`INSERT INTO dropship.dropship_audit_events
    (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
    VALUES ($1, $2, 'dropship_vendor_listing', $3, 'listing_marketplace_sync_dead_lettered', $4, $5, 'error', $6::jsonb, $7)`,
  [state.vendorId, state.storeConnectionId, String(input.listingId), MARKETPLACE_SYNC_ACTOR.actorType, MARKETPLACE_SYNC_ACTOR.actorId,
    JSON.stringify({ failureCode: input.failureCode.slice(0, 120), requiresReview: true }), input.at]);
  return true;
}

/**
 * What a read proved about the listing's life on eBay (SB7, SB8, SB6), each
 * part a guarded update with its audit row: the vendor's end (status 'ended'),
 * a read-ended listing on sale again (back to 'active'), and a relist (the
 * new item number, only while the old one is still ours). The previous item
 * number itself is kept by recordPreviousMarketplaceIdWithClient.
 */
export async function applyMarketplaceListingStatusWithClient(client: Client, input: {
  listingId: number; at: Date; endListing: boolean; reactivate: boolean;
  relink: { previousListingId: string | null; listingId: string } | null;
}): Promise<{ ended: boolean; reactivated: boolean; relinked: boolean }> {
  let ended = false;
  let reactivated = false;
  let relinked = false;
  if (input.endListing) {
    const result = await client.query<{ vendor_id: number; store_connection_id: number; before_status: string }>(`
      UPDATE dropship.dropship_vendor_listings l SET status = 'ended', marketplace_ended_at = $2, updated_at = $2
      FROM dropship.dropship_vendor_listings before WHERE l.id = $1 AND before.id = l.id AND l.status <> 'ended'
      RETURNING l.vendor_id, l.store_connection_id, before.status AS before_status`, [input.listingId, input.at]);
    const row = result.rows[0];
    if (row) {
      ended = true;
      await insertListingAudit(client, { vendorId: row.vendor_id, storeConnectionId: row.store_connection_id, listingId: input.listingId,
        eventType: "listing_marketplace_ended", ...systemActor(), payload: { before: { status: row.before_status }, after: { status: "ended" } },
        at: input.at });
    }
  }
  if (input.reactivate) {
    const result = await client.query<{ vendor_id: number; store_connection_id: number }>(`UPDATE dropship.dropship_vendor_listings
      SET status = 'active', marketplace_ended_at = NULL, updated_at = $2
      WHERE id = $1 AND status = 'ended' AND marketplace_ended_at IS NOT NULL RETURNING vendor_id, store_connection_id`, [input.listingId, input.at]);
    const row = result.rows[0];
    if (row) {
      reactivated = true;
      await insertListingAudit(client, { vendorId: row.vendor_id, storeConnectionId: row.store_connection_id, listingId: input.listingId,
        eventType: "listing_marketplace_relisted", ...systemActor(), payload: { before: { status: "ended" }, after: { status: "active" } },
        at: input.at });
    }
  }
  if (input.relink) {
    const result = await client.query<{ vendor_id: number; store_connection_id: number }>(`UPDATE dropship.dropship_vendor_listings
      SET external_listing_id = $3, updated_at = $4
      WHERE id = $1 AND external_listing_id IS NOT DISTINCT FROM $2 RETURNING vendor_id, store_connection_id`,
    [input.listingId, input.relink.previousListingId, input.relink.listingId, input.at]);
    const row = result.rows[0];
    if (row) {
      relinked = true;
      await insertListingAudit(client, { vendorId: row.vendor_id, storeConnectionId: row.store_connection_id, listingId: input.listingId,
        eventType: "listing_marketplace_relinked", ...systemActor(),
        payload: { before: { externalListingId: input.relink.previousListingId }, after: { externalListingId: input.relink.listingId } },
        at: input.at });
    }
  }
  return { ended, reactivated, relinked };
}

/**
 * The listing's sync events Ours is built from (SB3) and the quantity's
 * settled check (hasUnsettledPushAttempt): the newest baseline event, the
 * newest completed push, and every attempt after the older of the two.
 * Bounded: a listing has one baseline per push or sync, and attempts only
 * between them.
 */
export async function readMarketplaceSyncEventsWithClient(client: Client, listingId: number): Promise<MarketplaceSyncEvent[]> {
  const result = await client.query<{ id: number; event_type: string; payload: unknown; created_at: Date }>(`
    WITH baseline AS (
      SELECT max(id) FILTER (WHERE event_type = ANY($2::text[])) AS id,
        max(id) FILTER (WHERE event_type = $4) AS completed_id
      FROM dropship.dropship_listing_sync_events
      WHERE listing_id = $1 AND (event_type = ANY($2::text[]) OR event_type = $4))
    SELECT e.id, e.event_type, e.payload, e.created_at FROM dropship.dropship_listing_sync_events e, baseline
    WHERE e.listing_id = $1 AND ((e.id = baseline.id) OR (e.id = baseline.completed_id)
      OR (e.event_type = $3 AND e.id > COALESCE(LEAST(baseline.id, baseline.completed_id), 0)))
    ORDER BY e.id`, [listingId, [...MARKETPLACE_BASELINE_EVENT_TYPES], MARKETPLACE_ATTEMPT_EVENT_TYPE,
    MARKETPLACE_PUSH_COMPLETED_EVENT_TYPE]);
  return result.rows.map((row) => ({ id: row.id, eventType: row.event_type, payload: row.payload, createdAt: row.created_at }));
}

/**
 * The newest id among the sync events a decision is made on (SB4: the
 * baseline events and the push attempts, readMarketplaceSyncEventsWithClient):
 * the observation compare-and-set's value. Other events of the listing (a
 * failed, blocked or skipped push) change nothing a decision read, so they
 * never make a read stale; counting them would refuse every read of a
 * listing whose newest event is one of them, for good.
 */
export async function readNewestMarketplaceSyncEventIdWithClient(client: Client, listingId: number): Promise<number | null> {
  const result = await client.query<{ id: number | null }>(
    `SELECT max(id) AS id FROM dropship.dropship_listing_sync_events WHERE listing_id = $1 AND event_type = ANY($2::text[])`,
    [listingId, [...MARKETPLACE_BASELINE_EVENT_TYPES, MARKETPLACE_ATTEMPT_EVENT_TYPE]]);
  return result.rows[0]?.id ?? null;
}

/** B := V for every field (SB3): the listing_marketplace_synced event. Answers its id. */
export async function insertMarketplaceSyncedEventWithClient(client: Client, input: {
  listingId: number; baseline: MarketplaceSyncedBaseline; trigger: "sweep" | "push"; observedAt: Date;
  externalListingId: string | null; externalOfferId: string;
}): Promise<number> {
  const result = await client.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_sync_events
    (listing_id, event_type, source, payload, created_at) VALUES ($1, $2, 'ebay_sync_back', $3::jsonb, $4) RETURNING id`,
  [input.listingId, MARKETPLACE_SYNCED_EVENT_TYPE, JSON.stringify({ ...input.baseline, trigger: input.trigger,
    externalListingId: input.externalListingId, externalOfferId: input.externalOfferId }), input.observedAt]);
  const id = result.rows[0]?.id;
  if (!id) throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "Sync event insert returned no identity.", "fatal");
  return id;
}

/** The newest completed job item's stored intent for the listing (§4.1 fallback, F13): null when there is none. */
export async function readNewestCompletedListingIntentWithClient(client: Client, listingId: number): Promise<unknown> {
  const result = await client.query<{ intent: unknown }>(`SELECT result -> 'listingIntent' AS intent
    FROM dropship.dropship_listing_push_job_items WHERE listing_id = $1 AND status = 'completed'
    ORDER BY id DESC LIMIT 1`, [listingId]);
  return result.rows[0]?.intent ?? null;
}

function observationIs(quantity: string, at: string, alias?: string): string {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return `${column("observed_marketplace_quantity")} IS NOT DISTINCT FROM ${quantity}::integer
    AND ${column("observed_marketplace_quantity_at")} IS NOT DISTINCT FROM ${at}::timestamptz`;
}

function systemActor() {
  return { actorType: MARKETPLACE_SYNC_ACTOR.actorType, actorId: MARKETPLACE_SYNC_ACTOR.actorId };
}

async function insertListingAudit(client: Client, input: {
  vendorId: number; storeConnectionId: number; listingId: number; eventType: string; actorType: string; actorId: string;
  payload: Record<string, unknown>; at: Date;
}): Promise<void> {
  await client.query(`INSERT INTO dropship.dropship_audit_events
    (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
    VALUES ($1, $2, 'dropship_vendor_listing', $3, $4, $5, $6, 'info', $7::jsonb, $8)`,
  [input.vendorId, input.storeConnectionId, String(input.listingId), input.eventType, input.actorType, input.actorId,
    JSON.stringify(input.payload), input.at]);
}

function listingNotFound(listingId: number) {
  return marketplaceSyncError(MARKETPLACE_SYNC_CODES.listingNotFound, "The listing was not found.", "permanent", { listingId });
}

function mapState(row: StateRow): MarketplaceListingSyncState {
  return {
    listingId: row.id, vendorId: row.vendor_id, storeConnectionId: row.store_connection_id, productVariantId: row.product_variant_id,
    platform: row.platform, status: row.status, externalListingId: row.external_listing_id, externalOfferId: row.external_offer_id,
    pushedQuantity: row.pushed_quantity, lastPushedAt: row.last_pushed_at,
    observedMarketplacePriceCents: row.observed_marketplace_price_cents === null ? null : safeInteger(row.observed_marketplace_price_cents),
    lastMarketplaceSyncAt: row.last_marketplace_sync_at, driftDetectedAt: row.drift_detected_at,
    marketplaceSyncAttemptedAt: row.marketplace_sync_attempted_at,
    issueCodes: row.marketplace_issue_codes.filter((code): code is MarketplaceIssueCode => (MARKETPLACE_ISSUE_CODES as readonly string[]).includes(code)),
    marketplaceEndedAt: row.marketplace_ended_at, observedFulfillmentPolicyId: row.observed_fulfillment_policy_id,
    vendorQuantityLimit: row.vendor_quantity_limit,
    quantityBaseline: row.marketplace_quantity_baseline !== null && row.marketplace_quantity_baseline_at !== null
      ? { quantity: row.marketplace_quantity_baseline, at: row.marketplace_quantity_baseline_at } : null,
    observedQuantity: row.observed_marketplace_quantity !== null && row.observed_marketplace_quantity_at !== null
      ? { quantity: row.observed_marketplace_quantity, at: row.observed_marketplace_quantity_at } : null,
  };
}

/** A bigint column as a JS integer; a value past 2^53 is a broken invariant, never rounded. */
function safeInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "A stored amount is not a safe integer.", "fatal", { value: String(value) });
  }
  return parsed;
}
