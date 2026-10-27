import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type { SaveListingPriceInput } from "../../../../shared/dropship/listing-price";
import { saveListingPriceInTransaction } from "../application/dropship-listing-price-service";
import type {
  MarketplaceListingSyncWrite,
  MarketplaceListingSyncWriteResult,
  MarketplacePushSentFields,
  MarketplaceQuantityDecisionWrite,
  MarketplaceSyncListing,
  MarketplaceSyncNoticeBatchRecord,
  MarketplaceSyncPolicyCheckWrite,
  MarketplaceSyncRepository,
  MarketplaceSyncStore,
} from "../application/dropship-marketplace-sync-service";
import { DropshipError } from "../domain/errors";
import type { SalesWindow } from "../domain/marketplace-quantity-decision";
import { decideFulfillmentPolicyCheckNotice, marketplaceSyncNotice } from "../domain/marketplace-sync-decision";
import { classifyMarketplaceSyncError, marketplaceSyncError, MARKETPLACE_SYNC_CODES } from "../domain/marketplace-sync-errors";
import {
  marketplacePolicyAdoptionKey,
  marketplacePolicySubjectKey,
  marketplacePriceAdoptionKey,
  MARKETPLACE_SYNC_ACTOR,
} from "../domain/marketplace-sync-keys";
import { hasUnsettledPushAttempt, MARKETPLACE_ATTEMPT_EVENT_TYPE } from "../domain/marketplace-sync-history";
import { decisionWithoutPriceAdoption, MARKETPLACE_SYNC_SWEPT_STATUSES } from "../domain/marketplace-sync-sweep";
import { adoptListingPolicyRowWithClient } from "./dropship-ebay-listing-policy-adoption.writer";
import {
  setFulfillmentPolicyNotifiedVerdictWithClient,
  upsertFulfillmentPolicyCheckWithClient,
} from "./dropship-ebay-fulfillment-policy-checks.repository";
import { sumMarketplaceSalesWithClient } from "./dropship-listing-marketplace-sales.repository";
import { listingPriceTransactionForClient } from "./dropship-listing-price.repository";
import { LISTING_SELECTION_LOCK_SQL, STORE_LOCK_SQL, SYSTEM_OWNER_SQL } from "./dropship-listing-setting-writes.repository";
import {
  applyMarketplaceListingStatusWithClient,
  applyVendorQuantityLimitWithClient,
  clearQuantityObservationWithClient,
  deadLetterMarketplaceListingWithClient,
  insertMarketplaceSyncedEventWithClient,
  markListingsMarketplaceSyncDueWithClient,
  readMarketplaceListingSyncStateWithClient,
  readMarketplaceSyncEventsWithClient,
  readNewestCompletedListingIntentWithClient,
  readNewestMarketplaceSyncEventIdWithClient,
  recordMarketplaceObservedFieldsWithClient,
  recordMarketplaceSyncAttemptWithClient,
  saveQuantityObservationWithClient,
  updateMarketplaceIssueCodesWithClient,
  type MarketplaceListingSyncState,
} from "./dropship-marketplace-listing-sync-state.repository";
import { recordPreviousMarketplaceIdWithClient } from "./dropship-marketplace-previous-ids.repository";
import {
  claimMarketplaceSyncNoticeBatchesWithClient,
  deadLetterMarketplaceSyncNoticeBatchWithClient,
  enqueueMarketplaceSyncNoticesWithClient,
  listUnsentMarketplaceSyncNoticeBatchesWithClient,
  markMarketplaceSyncNoticeBatchSentWithClient,
} from "./dropship-marketplace-sync-notices.repository";

/**
 * eBay sync-back's persistence for its sweep (plan v4 §6): which stores and
 * listings it reads, what it needs to know about each, and the transactions
 * that apply one decision. Every write path is one transaction in the plan's
 * lock order (§6.5): the store lock (the one every queue, price and settings
 * writer takes first), the owner rows FOR SHARE, the selection SHARE locks and
 * the size FOR SHARE when a price is adopted (W9 needs them), the listing row
 * FOR UPDATE, then W9's price row, then the policy feature lock and the size's
 * policy row. Audit rows and outbox notices commit or roll back with their
 * change. Reads outside a write decide nothing on their own: every write
 * re-reads under its locks and compares-and-sets.
 *
 * Writes only dropship tables, through their writers: W9's price transaction,
 * the size policy writer, and the S1 sync-state, notice and policy-check
 * functions.
 */
type Client = Pick<PoolClient, "query">;

const VARIANT_SHARE_SQL = `SELECT pv.id FROM catalog.product_variants pv JOIN catalog.products p ON p.id = pv.product_id
  WHERE pv.id = $1 FOR SHARE OF pv, p`;

/** A listing's open end request (PR C: pending, ending, or failed and waiting for staff), as a subquery body. */
function openListingEndSql(listingId: "l.id" | "$1"): string {
  return `SELECT 1 FROM dropship.dropship_listing_end_requests open_end
    WHERE open_end.listing_id = ${listingId} AND open_end.state IN ('pending', 'ending', 'failed')`;
}

/**
 * Listings the sweep reads (§6.2): eBay, with our saved offer id; for sale
 * with a published item number (a staged draft records its offer id as its
 * item number, dropship-ebay-listing-push.provider.ts, and is left out), or
 * ended by a read; not dead-lettered; no job item queued or running (its write
 * would race the read); no open end request (PR C, PLAN-C v4.1 §9 I1: a read
 * between Card Shellz's withdraw and its finish would otherwise record the
 * withdrawn offer as the vendor's own end). `$1` is the store, `$2` the swept
 * statuses.
 */
const SWEPT_LISTING_PREDICATE = `l.store_connection_id = $1 AND l.platform = 'ebay'
  AND l.external_offer_id IS NOT NULL AND btrim(l.external_offer_id) <> ''
  AND NOT ('sync_requires_review' = ANY(l.marketplace_issue_codes))
  AND ((l.status = ANY($2::text[]) AND l.external_listing_id IS NOT NULL AND btrim(l.external_listing_id) <> ''
      AND l.external_listing_id IS DISTINCT FROM l.external_offer_id)
    OR (l.status = 'ended' AND l.marketplace_ended_at IS NOT NULL))
  AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items item
    WHERE item.listing_id = l.id AND item.status IN ('queued', 'processing'))
  AND NOT EXISTS (${openListingEndSql("l.id")})`;

/** The same predicate for the store in the row `sc`, with the statuses as $1. */
const STORE_LISTING_PREDICATE = SWEPT_LISTING_PREDICATE.replaceAll("$1", "sc.id").replaceAll("$2", "$1");

/**
 * Launch-ready eBay stores (the order intake's own predicate: a store that
 * needs re-authorization or is disconnected is never read), with their swept
 * listing count and the oldest attempt among them (a never-read listing counts
 * as oldest; a store with none sorts last). $1: the swept statuses.
 */
const STORE_SELECT = `SELECT sc.id, sc.vendor_id, sc.marketplace_sales_ledger_since, sc.last_order_sync_at,
    NULLIF(btrim(lc.marketplace_config ->> 'marketplaceId'), '') AS marketplace_id,
    (SELECT count(*)::int FROM dropship.dropship_vendor_listings l WHERE ${STORE_LISTING_PREDICATE}) AS live_count,
    (SELECT min(COALESCE(l.marketplace_sync_attempted_at, '-infinity'::timestamptz)) FROM dropship.dropship_vendor_listings l
      WHERE ${STORE_LISTING_PREDICATE}) AS oldest_attempt
  FROM dropship.dropship_store_connections sc
  LEFT JOIN dropship.dropship_store_listing_configs lc ON lc.store_connection_id = sc.id AND lc.is_active = true
  WHERE sc.platform = 'ebay' AND sc.status = 'connected' AND sc.setup_status = 'ready'
    AND sc.access_token_ref IS NOT NULL AND sc.refresh_token_ref IS NOT NULL`;

/** The price writer the adoption transaction calls (W9 in production). */
export interface MarketplaceSyncPriceWriter {
  adoptPrice(client: Client, input: {
    vendorId: number; storeConnectionId: number; productVariantId: number; priceCents: number; expectedRevisionId: number | null;
    idempotencyKey: string; now: Date;
  }): Promise<"adopted" | "replayed">;
}

/**
 * W9 (plan v4 §1.3): the vendor's own save path, as the system. It authorizes
 * the store, vendor and entitlement and the size's selection, checks Card
 * Shellz's price limits, replays a saved key, and saves a fixed revision with
 * its audit row (actor_type system). The save input is built here, not parsed
 * by the vendor schema, which refuses the reserved `ebay-sync:` prefix (SB34).
 */
export const w9MarketplacePriceWriter: MarketplaceSyncPriceWriter = {
  async adoptPrice(client, input) {
    const target = { storeConnectionId: input.storeConnectionId, productVariantId: input.productVariantId };
    const save: SaveListingPriceInput = { priceCents: input.priceCents, pricingMode: "fixed", expectedRevisionId: input.expectedRevisionId,
      idempotencyKey: input.idempotencyKey };
    const tx = listingPriceTransactionForClient(client, { ...target, vendorId: input.vendorId, memberId: MARKETPLACE_SYNC_ACTOR.actorId,
      idempotencyKey: input.idempotencyKey, actorType: "system" });
    const requestHash = sha256(JSON.stringify({ operation: "listing_price_ebay_sync_v1", ...target, priceCents: input.priceCents,
      expectedRevisionId: input.expectedRevisionId }));
    const result = await saveListingPriceInTransaction(tx, target, save, requestHash, input.now);
    return result.idempotentReplay ? "replayed" : "adopted";
  },
};

export class PgDropshipMarketplaceSyncRepository implements MarketplaceSyncRepository {
  constructor(private readonly dbPool: Pool = defaultPool, private readonly priceWriter: MarketplaceSyncPriceWriter = w9MarketplacePriceWriter) {}

  async listSweepStores(): Promise<MarketplaceSyncStore[]> {
    // The store whose listing was read longest ago goes first, so a tick that runs out of time never starves the same stores.
    const result = await this.dbPool.query<StoreRow>(`${STORE_SELECT} ORDER BY oldest_attempt ASC NULLS LAST, sc.id ASC`,
      [MARKETPLACE_SYNC_SWEPT_STATUSES]);
    return result.rows.map((row) => ({ vendorId: row.vendor_id, storeConnectionId: row.id, marketplaceId: row.marketplace_id,
      liveListingCount: row.live_count, salesLedgerSince: row.marketplace_sales_ledger_since, lastOrderSyncAt: row.last_order_sync_at }));
  }

  async loadStore(storeConnectionId: number): Promise<MarketplaceSyncStore | null> {
    const result = await this.dbPool.query<StoreRow>(`${STORE_SELECT} AND sc.id = $2`, [MARKETPLACE_SYNC_SWEPT_STATUSES, storeConnectionId]);
    const row = result.rows[0];
    return row ? { vendorId: row.vendor_id, storeConnectionId: row.id, marketplaceId: row.marketplace_id,
      liveListingCount: row.live_count, salesLedgerSince: row.marketplace_sales_ledger_since, lastOrderSyncAt: row.last_order_sync_at } : null;
  }

  async listObservedListingIds(input: { storeConnectionId: number; limit: number }): Promise<number[]> {
    const result = await this.dbPool.query<{ id: number }>(`SELECT l.id FROM dropship.dropship_vendor_listings l
      WHERE ${SWEPT_LISTING_PREDICATE} AND l.observed_marketplace_quantity IS NOT NULL
      ORDER BY l.observed_marketplace_quantity_at ASC, l.id ASC LIMIT $3`,
    [input.storeConnectionId, MARKETPLACE_SYNC_SWEPT_STATUSES, input.limit]);
    return result.rows.map((row) => row.id);
  }

  async listDueListingIds(input: { storeConnectionId: number; limit: number }): Promise<number[]> {
    const result = await this.dbPool.query<{ id: number }>(`SELECT l.id FROM dropship.dropship_vendor_listings l
      WHERE ${SWEPT_LISTING_PREDICATE} AND l.observed_marketplace_quantity IS NULL
      ORDER BY l.marketplace_sync_attempted_at ASC NULLS FIRST, l.id ASC LIMIT $3`,
    [input.storeConnectionId, MARKETPLACE_SYNC_SWEPT_STATUSES, input.limit]);
    return result.rows.map((row) => row.id);
  }

  async loadListing(listingId: number, options: { excludeJobItemId?: number | null } = {}): Promise<MarketplaceSyncListing | null> {
    const client = await this.dbPool.connect();
    try {
      // One snapshot for the listing, its open items, its events and its stored intent.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = await readMarketplaceListingSyncStateWithClient(client, listingId);
      if (!state || state.platform !== "ebay" || !state.externalOfferId) {
        await client.query("COMMIT");
        return null;
      }
      const open = await client.query<{ open: boolean }>(`SELECT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items
        WHERE listing_id = $1 AND status IN ('queued', 'processing') AND id IS DISTINCT FROM $2::integer) AS open`,
      [listingId, options.excludeJobItemId ?? null]);
      const events = await readMarketplaceSyncEventsWithClient(client, listingId);
      const storedIntent = await readNewestCompletedListingIntentWithClient(client, listingId);
      await client.query("COMMIT");
      return {
        listingId: state.listingId, vendorId: state.vendorId, storeConnectionId: state.storeConnectionId,
        productVariantId: state.productVariantId, status: state.status, externalListingId: state.externalListingId,
        externalOfferId: state.externalOfferId, pushedQuantity: state.pushedQuantity, lastPushedAt: state.lastPushedAt,
        issueCodes: state.issueCodes, marketplaceEndedAt: state.marketplaceEndedAt, vendorQuantityLimit: state.vendorQuantityLimit,
        quantityBaseline: state.quantityBaseline, observedQuantity: state.observedQuantity, hasOpenPushItem: open.rows[0]?.open === true,
        pushAttemptUnsettled: hasUnsettledPushAttempt(events), events, storedIntent,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAttempt(listingId: number, at: Date): Promise<void> {
    await recordMarketplaceSyncAttemptWithClient(this.dbPool, listingId, at);
  }

  async markListingsDue(listingIds: readonly number[]): Promise<void> {
    await markListingsMarketplaceSyncDueWithClient(this.dbPool, listingIds);
  }

  async applyListingSync(input: MarketplaceListingSyncWrite): Promise<MarketplaceListingSyncWriteResult> {
    return this.inTransaction(async (client) => {
      const state = await lockListing(client, input, { selectionLocks: input.price !== null });
      if (input.trigger === "sweep") await assertNoOpenListingEnd(client, input.listingId);
      // SB4: the decision was made on the listing's events as they were. A newer one (a push completed, another read
      // synced) means it may be stale: it is read again first next tick, never written from here.
      const newest = await readNewestMarketplaceSyncEventIdWithClient(client, input.listingId);
      if (newest !== input.expectedNewestEventId || state.externalOfferId !== input.externalOfferId) {
        throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.observationChanged, "The listing changed since it was read.", "transient",
          { listingId: input.listingId, expectedNewestEventId: input.expectedNewestEventId, newestEventId: newest });
      }
      let decision = input.decision;
      let price: MarketplaceListingSyncWriteResult["price"] = "none";
      if (input.price) {
        price = await this.adoptPrice(client, input, input.price);
        if (price === "refused_limit" || price === "refused_terminal") {
          decision = decisionWithoutPriceAdoption(decision, price === "refused_limit" ? "outside_limit" : "terminal",
            { listingIssueCodes: state.issueCodes, oursPriceBaseline: input.oursPriceBaseline });
        }
      }
      const policies = input.policies && Object.keys(input.policies).length > 0 ? await adoptPolicies(client, input, input.policies) : "none";
      if (input.observed) {
        await recordMarketplaceObservedFieldsWithClient(client, { listingId: input.listingId, observedPriceCents: input.observed.priceCents,
          observedFulfillmentPolicyId: input.observed.fulfillmentPolicyId, syncedAt: input.observedAt });
      }
      if (decision.issues.add.length > 0 || decision.issues.remove.length > 0) {
        await updateMarketplaceIssueCodesWithClient(client, { listingId: input.listingId, add: decision.issues.add,
          remove: decision.issues.remove, at: input.observedAt });
      }
      const status = await applyMarketplaceListingStatusWithClient(client, { listingId: input.listingId, at: input.observedAt,
        endListing: decision.status.endListing, reactivate: decision.status.reactivate, relink: decision.status.relink });
      if (status.relinked && decision.status.relink?.previousListingId) {
        await recordPreviousMarketplaceIdWithClient(client, { listingId: input.listingId,
          externalListingId: decision.status.relink.previousListingId, reason: "relisted", replacedAt: input.observedAt });
      }
      const syncedEventId = decision.syncedBaseline === null ? null : await insertMarketplaceSyncedEventWithClient(client, {
        listingId: input.listingId, baseline: decision.syncedBaseline, trigger: input.trigger, observedAt: input.observedAt,
        externalListingId: status.relinked ? decision.status.relink!.listingId : state.externalListingId, externalOfferId: input.externalOfferId,
      });
      const observationSaved = await saveObservation(client, input, state);
      // §6.5: a quantity decided on this very read (a raise needs no order-poll coverage) commits with the read's
      // adoptions, under the same store lock and listing row lock, compare-and-set on the observation just saved.
      const quantityApplied = observationSaved && input.quantity ? await applyQuantityWritesWithClient(client, input.quantity) : null;
      const noticesWritten = await enqueueMarketplaceSyncNoticesWithClient(client, { vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId, notices: decision.notices, createdAt: input.observedAt });
      await recordMarketplaceSyncAttemptWithClient(client, input.listingId, input.observedAt);
      return { price, policies, observationSaved, quantityApplied, syncedEventId, noticesWritten, status, decision };
    });
  }

  /**
   * W9 inside a savepoint: a refusal for a Card Shellz price limit, or because
   * the vendor, membership or store may not change prices now, undoes only the
   * price and lets the rest of the read commit; anything else (a version
   * conflict, a broken invariant) aborts the whole transaction.
   */
  private async adoptPrice(client: Client, input: MarketplaceListingSyncWrite,
    price: NonNullable<MarketplaceListingSyncWrite["price"]>): Promise<MarketplaceListingSyncWriteResult["price"]> {
    await client.query("SAVEPOINT marketplace_sync_price");
    try {
      const outcome = await this.priceWriter.adoptPrice(client, { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId,
        productVariantId: input.productVariantId, priceCents: price.priceCents, expectedRevisionId: price.expectedRevisionId,
        idempotencyKey: marketplacePriceAdoptionKey({ listingId: input.listingId, priceCents: price.priceCents,
          expectedRevisionId: price.expectedRevisionId }), now: input.observedAt });
      await client.query("RELEASE SAVEPOINT marketplace_sync_price");
      return outcome;
    } catch (error) {
      const handling = classifyMarketplaceSyncError(error).handling;
      if (handling !== "flag_price_limit" && handling !== "ignore") throw error;
      await client.query("ROLLBACK TO SAVEPOINT marketplace_sync_price");
      return handling === "flag_price_limit" ? "refused_limit" : "refused_terminal";
    }
  }

  /** A saved observation decided on its own (§6.2: before its listing is read again), in its own transaction. */
  async applyQuantityDecision(input: MarketplaceQuantityDecisionWrite): Promise<{ applied: boolean }> {
    return this.inTransaction(async (client) => {
      await client.query(STORE_LOCK_SQL, [input.storeConnectionId]);
      return { applied: await applyQuantityWritesWithClient(client, input) };
    });
  }

  async sumSales(input: { listingId: number; all: SalesWindow; live: SalesWindow }): Promise<{ all: number; live: number }> {
    return sumMarketplaceSalesWithClient(this.dbPool, input);
  }

  async deadLetterListing(input: { listingId: number; failureCode: string; at: Date }): Promise<void> {
    await this.inTransaction((client) => deadLetterMarketplaceListingWithClient(client, input));
  }

  async listObservedPolicies(input: { storeConnectionId: number; limit: number }): Promise<Array<{ fulfillmentPolicyId: string; listingCount: number }>> {
    const result = await this.dbPool.query<{ policy_id: string; listing_count: number }>(`
      SELECT l.observed_fulfillment_policy_id AS policy_id, count(*)::int AS listing_count
      FROM dropship.dropship_vendor_listings l
      LEFT JOIN dropship.dropship_ebay_fulfillment_policy_checks c
        ON c.store_connection_id = l.store_connection_id AND c.fulfillment_policy_id = l.observed_fulfillment_policy_id
      WHERE ${SWEPT_LISTING_PREDICATE} AND l.status <> 'ended' AND l.observed_fulfillment_policy_id IS NOT NULL
      GROUP BY l.observed_fulfillment_policy_id, c.checked_at
      ORDER BY c.checked_at ASC NULLS FIRST, l.observed_fulfillment_policy_id ASC LIMIT $3`,
    [input.storeConnectionId, MARKETPLACE_SYNC_SWEPT_STATUSES, input.limit]);
    return result.rows.map((row) => ({ fulfillmentPolicyId: row.policy_id, listingCount: row.listing_count }));
  }

  async applyPolicyCheck(input: MarketplaceSyncPolicyCheckWrite): Promise<{ notified: boolean }> {
    return this.inTransaction(async (client) => {
      // The upsert locks the store's row for this policy, so two checks of it serialize; it keeps the verdict last told.
      const stored = await upsertFulfillmentPolicyCheckWithClient(client, { storeConnectionId: input.storeConnectionId,
        fulfillmentPolicyId: input.fulfillmentPolicyId, compatible: input.compatible, issueCodes: input.issueCodes,
        verdictHash: input.verdictHash, checkedAt: input.checkedAt });
      const decision = decideFulfillmentPolicyCheckNotice({ compatible: input.compatible, verdictHash: input.verdictHash,
        notifiedVerdictHash: stored.notifiedVerdictHash });
      if (decision.kind === "none") return { notified: false };
      let notified = false;
      if (decision.kind === "notify_incompatible") {
        notified = await enqueueMarketplaceSyncNoticesWithClient(client, { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId,
          notices: [marketplaceSyncNotice("policy_incompatible",
            marketplacePolicySubjectKey(input.fulfillmentPolicyId, input.verdictHash, input.checkedAt),
            { fulfillmentPolicyId: input.fulfillmentPolicyId, listingCount: input.listingCount, reasons: input.issueCodes })],
          createdAt: input.checkedAt }) > 0;
      }
      await setFulfillmentPolicyNotifiedVerdictWithClient(client, { storeConnectionId: input.storeConnectionId,
        fulfillmentPolicyId: input.fulfillmentPolicyId, verdictHash: input.verdictHash, notifiedVerdictHash: decision.notifiedVerdictHash });
      return { notified };
    });
  }

  async claimNoticeBatches(): Promise<number> {
    return this.inTransaction(async (client) => (await claimMarketplaceSyncNoticeBatchesWithClient(client)).length);
  }

  async listUnsentNoticeBatches(limit: number): Promise<MarketplaceSyncNoticeBatchRecord[]> {
    return (await listUnsentMarketplaceSyncNoticeBatchesWithClient(this.dbPool, limit)).map((batch) => ({
      batchKey: batch.batchKey, vendorId: batch.vendorId, storeConnectionId: batch.storeConnectionId, kind: batch.kind,
      critical: batch.critical, payloads: batch.payloads,
    }));
  }

  async markNoticeBatchSent(input: { batchKey: string; sentAt: Date }): Promise<number> {
    return markMarketplaceSyncNoticeBatchSentWithClient(this.dbPool, input);
  }

  async deadLetterNoticeBatch(input: { batchKey: string; failureCode: string; at: Date }): Promise<number> {
    return deadLetterMarketplaceSyncNoticeBatchWithClient(this.dbPool, input);
  }

  /**
   * listing_push_attempted (SB3): what one push is about to write, recorded
   * just before its first eBay write, so a later read never takes Card
   * Shellz's own attempted price or policy for the vendor's. Append-only.
   */
  async recordPushAttempt(input: { listingId: number; jobId: number; jobItemId: number; sent: MarketplacePushSentFields; at: Date }): Promise<void> {
    await this.dbPool.query(`INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload, created_at)
      VALUES ($1, $2, 'dropship_worker', $3::jsonb, $4)`,
    [input.listingId, MARKETPLACE_ATTEMPT_EVENT_TYPE, JSON.stringify({ jobId: input.jobId, jobItemId: input.jobItemId, ...input.sent }),
      input.at]);
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Steps 2-4 of the lock order (§6.5): the store lock, the owner rows FOR
 * SHARE, the selection SHARE locks and the size FOR SHARE (only when a price
 * is adopted: W9 needs them), then the listing row FOR UPDATE. A listing that
 * moved store, owner or size since it was read is gone for this write.
 */
async function lockListing(client: Client, input: Pick<MarketplaceListingSyncWrite, "listingId" | "vendorId" | "storeConnectionId" | "productVariantId">,
  options: { selectionLocks: boolean }): Promise<MarketplaceListingSyncState> {
  await client.query(STORE_LOCK_SQL, [input.storeConnectionId]);
  const owner = await client.query<{ vendor_id: number }>(SYSTEM_OWNER_SQL, [input.storeConnectionId]);
  if (owner.rows[0]?.vendor_id !== input.vendorId) throw listingGone(input.listingId);
  if (options.selectionLocks) {
    await client.query(LISTING_SELECTION_LOCK_SQL);
    await client.query(VARIANT_SHARE_SQL, [input.productVariantId]);
  }
  const state = await readMarketplaceListingSyncStateWithClient(client, input.listingId, { forUpdate: true });
  if (!state || state.vendorId !== input.vendorId || state.storeConnectionId !== input.storeConnectionId
    || state.productVariantId !== input.productVariantId) {
    throw listingGone(input.listingId);
  }
  return state;
}

/**
 * PR C (PLAN-C v4.1 §9 I1): a sweep's read decided before an end request
 * opened is never applied. Read under the listing's row lock (lockListing): an
 * end the save inserts needs a key lock on this listing row, so it either
 * committed before this read or waits for this transaction. The sweep's
 * predicate skips the listing from the next tick on. A push's pre-read is not
 * stopped here: the push fence refuses the push itself before it reads.
 */
async function assertNoOpenListingEnd(client: Client, listingId: number): Promise<void> {
  const open = await client.query<{ open: boolean }>(`SELECT EXISTS (${openListingEndSql("$1")}) AS open`,
    [listingId]);
  if (open.rows[0]?.open === true) {
    throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.observationChanged, "The listing changed since it was read.", "transient",
      { listingId, reason: "listing_end_open" });
  }
}

/** Step 6: the size's policy row with the ids the vendor changed, keyed by them and the row's current revision. */
async function adoptPolicies(client: Client, input: MarketplaceListingSyncWrite,
  changes: NonNullable<MarketplaceListingSyncWrite["policies"]>): Promise<"saved" | "replayed"> {
  const current = await client.query<{ revision_id: number }>(`SELECT revision_id FROM dropship.dropship_ebay_listing_policy_overrides
    WHERE vendor_id = $1 AND store_connection_id = $2 AND product_variant_id = $3`, [input.vendorId, input.storeConnectionId, input.productVariantId]);
  const expectedRevisionId = current.rows[0]?.revision_id ?? null;
  const idempotencyKey = marketplacePolicyAdoptionKey({ listingId: input.listingId, fulfillmentPolicyId: changes.fulfillmentPolicyId ?? null,
    returnPolicyId: changes.returnPolicyId ?? null, paymentPolicyId: changes.paymentPolicyId ?? null, expectedRevisionId });
  const requestHash = sha256(JSON.stringify({ operation: "listing_policy_ebay_sync_v1", storeConnectionId: input.storeConnectionId,
    productVariantId: input.productVariantId, changes, expectedRevisionId }));
  const adoption = await adoptListingPolicyRowWithClient(client, { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId,
    productVariantId: input.productVariantId, changes, idempotencyKey, requestHash, now: input.observedAt });
  return adoption.kind;
}

/**
 * One quantity decision's writes (§6.4), on a transaction that holds the
 * store lock: compare-and-set on the decided observation and on the limit the
 * decision saw (applyVendorQuantityLimitWithClient), so a replay or a decision
 * another writer overtook writes nothing. The limit change carries its own
 * audit row. False when nothing was written.
 */
async function applyQuantityWritesWithClient(client: Client, input: MarketplaceQuantityDecisionWrite): Promise<boolean> {
  const state = await readMarketplaceListingSyncStateWithClient(client, input.listingId, { forUpdate: true });
  if (!state || state.storeConnectionId !== input.storeConnectionId || !sameObservation(state.observedQuantity, input.observation)) {
    return false;
  }
  const { writes } = input;
  let applied = false;
  if (writes.limitChange) {
    applied = (await applyVendorQuantityLimitWithClient(client, { listingId: input.listingId, decidedObservation: input.observation,
      expectedLimit: input.expectedLimit, change: writes.limitChange, baseline: writes.baseline, changedAt: input.decidedAt,
      idempotencyKey: input.idempotencyKey })).applied;
  } else if (writes.clearObservation) {
    applied = await clearQuantityObservationWithClient(client, { listingId: input.listingId, expected: input.observation });
  }
  if (!applied) return false;
  if (writes.issues.add.length > 0 || writes.issues.remove.length > 0) {
    await updateMarketplaceIssueCodesWithClient(client, { listingId: input.listingId, add: writes.issues.add, remove: writes.issues.remove,
      at: input.decidedAt });
  }
  return true;
}

/**
 * Saves the read's Qe (§6.4) when the row still holds the observation the
 * decision saw and no push started meanwhile (a push's baseline is not
 * settled). Answers whether it was saved.
 */
async function saveObservation(client: Client, input: MarketplaceListingSyncWrite, state: MarketplaceListingSyncState): Promise<boolean> {
  if (!input.saveObservation || !sameObservation(state.observedQuantity, input.expectedObservation)) return false;
  // The push pre-read's own item is the one asking: it has written nothing yet, so it does not unsettle the read.
  const open = await client.query<{ open: boolean }>(`SELECT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items
    WHERE listing_id = $1 AND status IN ('queued', 'processing') AND id IS DISTINCT FROM $2::integer) AS open`,
  [input.listingId, input.excludeJobItemId]);
  if (open.rows[0]?.open === true) return false;
  return saveQuantityObservationWithClient(client, { listingId: input.listingId, observation: input.saveObservation,
    expected: state.observedQuantity });
}

function sameObservation(left: { quantity: number; at: Date } | null, right: { quantity: number; at: Date } | null): boolean {
  if (left === null || right === null) return left === right;
  return left.quantity === right.quantity && left.at.getTime() === right.at.getTime();
}

function listingGone(listingId: number): DropshipError {
  return marketplaceSyncError(MARKETPLACE_SYNC_CODES.listingNotFound, "The listing is no longer the one that was read.", "permanent", { listingId });
}

interface StoreRow {
  id: number; vendor_id: number; marketplace_id: string | null; live_count: number;
  marketplace_sales_ledger_since: Date | null; last_order_sync_at: Date | null; oldest_attempt: Date | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rollbackQuietly(client: Pick<PoolClient, "query">): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Deliberate: the original failure is the one that matters and is rethrown; a failed ROLLBACK means the connection is gone.
  }
}
