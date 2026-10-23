import { parseMarketplaceListingObservation, type MarketplaceListingObservation } from "../domain/marketplace-listing-observation";
import {
  chooseQuantityBaseline,
  decideMarketplaceQuantity,
  quantitySalesWindows,
  type QuantityBaseline,
  type SalesWindow,
} from "../domain/marketplace-quantity-decision";
import {
  decideMarketplaceSync,
  fulfillmentPolicyVerdictHash,
  MARKETPLACE_IDENTITY_ISSUE_CODES,
  type MarketplaceIssueCode,
  type MarketplaceListingRead,
  type MarketplacePushGuard,
  type MarketplacePushPassthrough,
  type MarketplaceSyncDecision,
  type MarketplaceSyncEchelon,
  type MarketplaceSyncNoticeKind,
  type MarketplaceSyncTrigger,
  type PolicyField,
} from "../domain/marketplace-sync-decision";
import {
  classifyMarketplaceSyncError,
  marketplaceSyncError,
  MARKETPLACE_SYNC_CODES,
  type MarketplaceSyncErrorClassification,
} from "../domain/marketplace-sync-errors";
import {
  marketplaceSyncOursFromHistory,
  newestMarketplaceSyncEventId,
  marketplaceSyncSentTextFromHistory,
  storedIntentSku,
  type MarketplaceSyncEvent,
} from "../domain/marketplace-sync-history";
import { MARKETPLACE_PUSH_STOP_WORDS } from "../domain/marketplace-sync-words";
import {
  marketplaceQuantityLimitKey,
  marketplaceQuantityRestoreJobKey,
  MARKETPLACE_SYNC_ACTOR,
} from "../domain/marketplace-sync-keys";
import {
  dropObservationWrites,
  isRepublishWanted,
  isStockOutEndProven,
  marketplaceSyncStoreListingCap,
  publishableQuantity,
  quantityDecisionWrites,
  MARKETPLACE_SYNC_MAX_NOTICE_BATCHES_PER_TICK,
  MARKETPLACE_SYNC_MAX_OBSERVATIONS_PER_STORE_TICK,
  MARKETPLACE_SYNC_MAX_POLICY_CHECKS_PER_STORE_TICK,
  MARKETPLACE_SYNC_PREVIEW_CHUNK,
  MARKETPLACE_SYNC_TICK_BUDGET_MS,
  type QuantityDecisionWrites,
} from "../domain/marketplace-sync-sweep";
import { describeMarketplaceSyncNoticeBatch } from "../domain/marketplace-sync-words";
import { DropshipError } from "../domain/errors";
import type { DropshipEbayFulfillmentPolicyGuard } from "./dropship-ebay-fulfillment-policy-guard";
import type { DropshipListingPreviewRow } from "./dropship-listing-preview-service";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type { DropshipClock, DropshipNotificationSender } from "./dropship-ports";

/**
 * eBay sync-back's scheduled job (plan v4 §6, owner rules 1, 4, 5 and 7):
 * every 15 minutes, for every launch-ready eBay store, read the store's live
 * listings back from eBay (GET only), oldest read first and at most
 * max(50, ceil(live/24)) per store, and keep what the vendor owns:
 * - price: adopted as the size's own fixed price through W9 as the system,
 *   with a below-cost notice when it is under what Card Shellz charges;
 * - shipping, return and payment policy: adopted into the size's policy row;
 * - quantity (rule 1): a number sales cannot explain becomes, changes or
 *   clears the listing's vendor limit, and Echelon's ATP goes back with one
 *   restore push per store per tick when eBay shows more than Echelon would
 *   publish. No quantity notice.
 * Title, description, photos, item specifics, condition and category are not
 * looked at (owner rules 2 and 3). A listing eBay ended for lack of stock
 * joins the restore push when stock returns; one the vendor ended is marked
 * ended; a relist is followed. Each store's live shipping policies are
 * checked, and the tick ends by sending the notice outbox (rule 7 kinds only).
 *
 * Orchestration only: the decisions are the domain's pure functions, the
 * writes are the repository's (one transaction per listing, under the plan's
 * lock order), eBay reads are the provider's, and "what Card Shellz would send
 * now" (E, and ATP as today) is the push pipeline's own listing preview. The
 * clock is injected. Errors are classified (classifyMarketplaceSyncError): a
 * store eBay throttles or whose token fails stops for the tick, a listing whose
 * read got no answer waits for the next tick, a lost race is read again first
 * next tick, an expected terminal condition is DEBUG, a permanent failure of
 * our own dead-letters the listing (never retried), and a broken invariant
 * aborts the tick.
 */

/** A launch-ready eBay store the sweep reads (connected, set up, with tokens). */
export interface MarketplaceSyncStore {
  vendorId: number;
  storeConnectionId: number;
  /** The active listing configuration's marketplace (the policy check asks eBay on it); null when not configured. */
  marketplaceId: string | null;
  /** Listings the sweep would read, for the per-tick cap. */
  liveListingCount: number;
  salesLedgerSince: Date | null;
  lastOrderSyncAt: Date | null;
}

/** One listing as the sweep needs it, read in one snapshot outside any write (every write reads it again under its locks). */
export interface MarketplaceSyncListing {
  listingId: number;
  vendorId: number;
  storeConnectionId: number;
  productVariantId: number;
  status: string;
  externalListingId: string | null;
  externalOfferId: string;
  pushedQuantity: number;
  lastPushedAt: Date | null;
  issueCodes: MarketplaceIssueCode[];
  marketplaceEndedAt: Date | null;
  vendorQuantityLimit: number | null;
  quantityBaseline: { quantity: number; at: Date } | null;
  observedQuantity: { quantity: number; at: Date } | null;
  /** A push job item of this listing is queued or processing (other than the one asking, for a push pre-read). */
  hasOpenPushItem: boolean;
  /** A push was attempted after the newest completed one (hasUnsettledPushAttempt): its quantity may or may not be on eBay. */
  pushAttemptUnsettled: boolean;
  events: MarketplaceSyncEvent[];
  /** The newest completed job item's stored intent (what Card Shellz last pushed), or null. */
  storedIntent: unknown;
}

/** The writes of one listing's read, applied by the repository in one transaction under the plan's lock order (§6.5). */
export interface MarketplaceListingSyncWrite {
  /** What read the listing: the scheduled sweep, or the push pre-read of one job item. */
  trigger: "sweep" | "push";
  /** The push pre-read's own job item: it does not count as an open push when the observation is saved. Null for the sweep. */
  excludeJobItemId: number | null;
  listingId: number;
  vendorId: number;
  storeConnectionId: number;
  productVariantId: number;
  externalOfferId: string;
  observedAt: Date;
  /** SB4: the newest sync event id the decision was made on; a newer one means it may be stale (a lost race). */
  expectedNewestEventId: number | null;
  decision: MarketplaceSyncDecision;
  /** Card Shellz's B for price as the decision had it: kept when W9 refuses the vendor's price. */
  oursPriceBaseline: number | null;
  /** The price to adopt through W9 and the price revision the preview read (E's), or null. */
  price: { priceCents: number; expectedRevisionId: number | null } | null;
  /** The policy ids to adopt into the size's policy row, or null. */
  policies: Partial<Record<PolicyField, string>> | null;
  /** What eBay shows that later reads and pushes compare with; null when the read gave no usable answer. */
  observed: { priceCents: number; fulfillmentPolicyId: string | null } | null;
  /** Qe to save for a quantity decision (compare-and-set against `expectedObservation`), or null. */
  saveObservation: { quantity: number; at: Date } | null;
  expectedObservation: { quantity: number; at: Date } | null;
  /**
   * The quantity decided on this very read (§6.4: a raise, or a number sales
   * explain; a lowering always waits for the order poll), applied in the same
   * transaction once the observation is saved (§6.5). Absent or null: none.
   */
  quantity?: MarketplaceQuantityDecisionWrite | null;
}

export interface MarketplaceListingSyncWriteResult {
  price: "none" | "adopted" | "replayed" | "refused_limit" | "refused_terminal";
  policies: "none" | "saved" | "replayed";
  observationSaved: boolean;
  /** Whether the quantity decision committed with the read (false: overtaken by another writer); null when none was asked or saved. */
  quantityApplied: boolean | null;
  syncedEventId: number | null;
  noticesWritten: number;
  status: { ended: boolean; reactivated: boolean; relinked: boolean };
  /** The decision as written: a W9 refusal changes its price, issues and notices (decisionWithoutPriceAdoption). */
  decision: MarketplaceSyncDecision;
}

export interface MarketplaceQuantityDecisionWrite {
  listingId: number;
  storeConnectionId: number;
  /** The decided observation: every write is a compare-and-set on it. */
  observation: { quantity: number; at: Date };
  /** The limit the decision saw (compare-and-set). */
  expectedLimit: number | null;
  writes: QuantityDecisionWrites;
  /** The key the limit change records in its audit row. */
  idempotencyKey: string;
  decidedAt: Date;
}

export interface MarketplaceSyncPolicyCheckWrite {
  vendorId: number;
  storeConnectionId: number;
  fulfillmentPolicyId: string;
  compatible: boolean;
  issueCodes: string[];
  verdictHash: string;
  listingCount: number;
  checkedAt: Date;
}

export interface MarketplaceSyncNoticeBatchRecord {
  batchKey: string;
  vendorId: number;
  storeConnectionId: number;
  kind: MarketplaceSyncNoticeKind;
  critical: boolean;
  payloads: Record<string, unknown>[];
}

/** What a push writes to eBay (the provider's resolved values), recorded with its attempt (SB3). */
export interface MarketplacePushSentFields {
  priceCents: number;
  currency: string;
  sku: string;
  fulfillmentPolicyId: string;
  returnPolicyId: string;
  paymentPolicyId: string;
  /** Fingerprints (sha256Hex) of the title and description the push writes, or carries forward (review OR-1); never the text. */
  titleHash: string;
  descriptionHash: string;
}

export interface MarketplaceSyncRepository {
  /** Launch-ready eBay stores, the one whose listing was read longest ago first. */
  listSweepStores(): Promise<MarketplaceSyncStore[]>;
  /** One launch-ready eBay store, as listSweepStores reads it; null when it is not one (any more). */
  loadStore(storeConnectionId: number): Promise<MarketplaceSyncStore | null>;
  /** Listings of the store with a saved quantity observation, oldest observation first. */
  listObservedListingIds(input: { storeConnectionId: number; limit: number }): Promise<number[]>;
  /** Listings of the store to read from eBay, never read or read longest ago first. */
  listDueListingIds(input: { storeConnectionId: number; limit: number }): Promise<number[]>;
  /** `excludeJobItemId`: the asking push item, not counted as an open push. */
  loadListing(listingId: number, options?: { excludeJobItemId?: number | null }): Promise<MarketplaceSyncListing | null>;
  recordAttempt(listingId: number, at: Date): Promise<void>;
  markListingsDue(listingIds: readonly number[]): Promise<void>;
  applyListingSync(input: MarketplaceListingSyncWrite): Promise<MarketplaceListingSyncWriteResult>;
  applyQuantityDecision(input: MarketplaceQuantityDecisionWrite): Promise<{ applied: boolean }>;
  sumSales(input: { listingId: number; all: SalesWindow; live: SalesWindow }): Promise<{ all: number; live: number }>;
  /** A permanent failure of our own on one listing: issue sync_requires_review and an audit row; the sweep stops reading it. */
  deadLetterListing(input: { listingId: number; failureCode: string; at: Date }): Promise<void>;
  /** The store's distinct live shipping policies, the one checked longest ago first. */
  listObservedPolicies(input: { storeConnectionId: number; limit: number }): Promise<Array<{ fulfillmentPolicyId: string; listingCount: number }>>;
  /** Stores a fresh verdict and, in the same transaction, the one critical notice a newly incompatible verdict sends. */
  applyPolicyCheck(input: MarketplaceSyncPolicyCheckWrite): Promise<{ notified: boolean }>;
  claimNoticeBatches(): Promise<number>;
  listUnsentNoticeBatches(limit: number): Promise<MarketplaceSyncNoticeBatchRecord[]>;
  markNoticeBatchSent(input: { batchKey: string; sentAt: Date }): Promise<number>;
  deadLetterNoticeBatch(input: { batchKey: string; failureCode: string; at: Date }): Promise<number>;
  /** The listing_push_attempted event, written just before a push's first eBay write (SB3). */
  recordPushAttempt(input: { listingId: number; jobId: number; jobItemId: number; sent: MarketplacePushSentFields; at: Date }): Promise<void>;
}

/** eBay's raw answers for one listing (the provider's readLiveListing). */
export type MarketplaceLiveListingRaw =
  | { kind: "read"; offer: unknown; inventoryItem: unknown }
  | { kind: "offer_missing" };

export interface MarketplaceLiveListingReader {
  readLiveListing(input: { vendorId: number; storeConnectionId: number; offerId: string; sku: string }): Promise<MarketplaceLiveListingRaw>;
}

/** The preview row fields that say what Card Shellz would send now (E) and ATP as today. */
export type MarketplaceSyncPreviewRow = Pick<DropshipListingPreviewRow,
  "productVariantId" | "sku" | "title" | "priceCents" | "priceSettingRevisionId" | "marketplaceQuantity" | "businessPolicySelection"
  | "economics">;

export interface MarketplaceSyncPreviewPort {
  generatePreview(input: {
    vendorId: number; storeConnectionId: number; productVariantIds: number[];
    actor: { actorType: "system"; actorId: string };
  }): Promise<{ rows: MarketplaceSyncPreviewRow[] }>;
}

export type MarketplaceSyncRestoreOutcome =
  | { queued: true; jobId: number; idempotentReplay: boolean }
  | { queued: false; code: string };

/** One ordinary push job (current preview, system actor) that puts Echelon's quantity back (§6.4). */
export interface MarketplaceSyncRestorePort {
  queueRestore(input: { vendorId: number; storeConnectionId: number; productVariantIds: number[]; idempotencyKey: string }): Promise<MarketplaceSyncRestoreOutcome>;
}

/** B per listing from Card Shellz's own last quantity write (marketplacePublishBaseline). */
export interface MarketplaceQuantityBaselinePort {
  readPublishBaselines(input: { storeConnectionId: number; listings: readonly MarketplaceSyncListing[] }): Promise<Map<number, QuantityBaseline | null>>;
}

export interface MarketplaceSyncLogger {
  debug(action: string, data?: Record<string, unknown>): void;
  info(action: string, data?: Record<string, unknown>): void;
  warn(action: string, data?: Record<string, unknown>): void;
  error(action: string, data?: Record<string, unknown>): void;
}

export interface DropshipMarketplaceSyncServiceDependencies {
  repository: MarketplaceSyncRepository;
  reader: MarketplaceLiveListingReader;
  previews: MarketplaceSyncPreviewPort;
  restores: MarketplaceSyncRestorePort;
  baselines: MarketplaceQuantityBaselinePort;
  policyGuard: Pick<DropshipEbayFulfillmentPolicyGuard, "evaluateForStoreConnection">;
  notifications: DropshipNotificationSender;
  clock: DropshipClock;
  logger: MarketplaceSyncLogger;
  /** Tests shorten it; production uses MARKETPLACE_SYNC_TICK_BUDGET_MS. */
  tickBudgetMs?: number;
}

export interface MarketplaceSyncTickResult {
  stores: number;
  storesStopped: number;
  reads: number;
  readFailures: number;
  priceAdoptions: number;
  policyAdoptions: number;
  quantityDecisions: number;
  limitChanges: number;
  restoreJobs: number;
  deadLettered: number;
  policyChecks: number;
  noticesSent: number;
  noticesDeadLettered: number;
  budgetExhausted: boolean;
}

interface StoreTickState {
  /** The sweep, or one push item's pre-read (its fields go on every log line). */
  trigger: "sweep" | "push";
  logFields: Record<string, unknown>;
  store: MarketplaceSyncStore;
  rows: Map<number, MarketplaceSyncPreviewRow>;
  baselines: Map<number, QuantityBaseline | null>;
  /** Listings to put back (or republish) with the store's one restore push this tick, by listing id. */
  restores: Map<number, { productVariantId: number; newestEventId: number }>;
  stopped: boolean;
}

/** One push job item's pre-read (plan v4 §5 step 2). */
export interface MarketplacePrePushInput {
  vendorId: number;
  storeConnectionId: number;
  listingId: number;
  productVariantId: number;
  jobId: number;
  jobItemId: number;
  /** Only an item the vendor's own press created, never re-queued (SB9): it may relist a listing the vendor ended. */
  relistAllowed: boolean;
}

/** What the push may write after its pre-read, and what it must re-check and carry. */
export interface MarketplacePrePushResult {
  /** The item number to push to: the one eBay shows now when it relisted under a new one (SB6). */
  externalListingId: string | null;
  externalOfferId: string;
  guard: MarketplacePushGuard;
  passthrough: MarketplacePushPassthrough;
  liveFulfillmentPolicyId: string | null;
}

/** The pre-read's own outcomes: passed to the worker as they are, never re-classified. */
const PUSH_PRE_READ_OWN_CODES: ReadonlySet<string> = new Set([
  MARKETPLACE_SYNC_CODES.quantityPending, MARKETPLACE_SYNC_CODES.endedOnEbay, MARKETPLACE_SYNC_CODES.identityUnproven,
  MARKETPLACE_SYNC_CODES.nothingToCompare, MARKETPLACE_SYNC_CODES.listingNotFound, MARKETPLACE_SYNC_CODES.storeUnavailable,
  MARKETPLACE_SYNC_CODES.requiresReview,
]);

/** How a quantity observation came out: decided (whatever it wrote), or waiting for the order poll. */
type QuantityOutcome = "none" | "decided" | "waiting";
/** One listing's sync: its decision, its quantity outcome, and whether it shows not on sale at a 0 that is not proven ours (MS2). */
interface SyncedListing { decision: MarketplaceSyncDecision; quantity: QuantityOutcome; unprovenStockOut: boolean }

/**
 * A quantity decision made before its write (§6.4): what to write and the log
 * line it ends with, or the order poll it waits for. `dropped`: Echelon's ATP
 * is unknown (no preview row), so the observation is only dropped.
 */
type QuantityPlan =
  | { kind: "waiting"; line: Record<string, unknown> }
  | { kind: "decide"; write: MarketplaceQuantityDecisionWrite; writes: QuantityDecisionWrites; line: Record<string, unknown>;
    decisionKind: string; dropped: boolean };

/** The notification service's refusal of a key reused for other words (dropship-notification.repository.ts): it was sent. */
const NOTIFICATION_IDEMPOTENCY_CONFLICT = "DROPSHIP_NOTIFICATION_IDEMPOTENCY_CONFLICT";

export class DropshipMarketplaceSyncService {
  constructor(private readonly deps: DropshipMarketplaceSyncServiceDependencies) {}

  /**
   * The push-time rule (plan v4 §5 step 2), before one job item writes to
   * eBay: a quantity observation saved by an earlier attempt is decided first;
   * then the listing is read from eBay and what the vendor owns is adopted in
   * one transaction (price, policies, status, ids), exactly as the sweep
   * adopts it. A lower number on eBay that waits for the order poll pauses the
   * push with nothing written (QUANTITY_PENDING); a read that does not prove
   * the listing is ours, or a vendor's end the item may not relist, stops it
   * for good. Otherwise it answers the ids to push to, the guard the
   * connector re-checks just before its first write, and what the push
   * carries unchanged (Best Offer terms, and a vendor's own title or
   * description, owner rule 2).
   */
  async syncListingBeforePush(input: MarketplacePrePushInput): Promise<MarketplacePrePushResult> {
    try {
      return await this.preReadForPush(input);
    } catch (error) {
      if (error instanceof DropshipError && PUSH_PRE_READ_OWN_CODES.has(error.code)) throw error;
      // A needed adoption lost a race or met a passing database refusal (§5): the push pauses, nothing written, and its
      // next attempt reads eBay again. eBay's own refusals keep their codes: the worker pauses or fails them as before.
      const classified = classifyMarketplaceSyncError(error);
      if (classified.handling === "retry_next_tick") {
        // PROPOSED (sync-back): kept on the job item while it waits.
        throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.adoptionRetry,
          "Card Shellz could not save what it read from eBay just now; this listing will be checked again shortly.", "transient",
          { listingId: input.listingId, jobItemId: input.jobItemId,
            causeCode: error instanceof DropshipError ? error.code : classified.code });
      }
      if (classified.handling === "review" && !isMarketplaceAnswer(error)) {
        // Permanent and Card Shellz's own (CLAUDE.md §6): dead-lettered once, as the sweep does, and the push fails for
        // good instead of being filed retryable. eBay's own refusals keep their codes for the worker to file.
        await this.deps.repository.deadLetterListing({ listingId: input.listingId, failureCode: classified.code, at: this.deps.clock.now() });
        this.logClassified("dropship.marketplace_sync.listing_dead_lettered", classified, { listing_id: input.listingId,
          vendor_id: input.vendorId, store_connection_id: input.storeConnectionId, trigger: "push", job_id: input.jobId,
          job_item_id: input.jobItemId, outcome: "requires_review" });
        throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.requiresReview, MARKETPLACE_PUSH_STOP_WORDS[MARKETPLACE_SYNC_CODES.requiresReview],
          "permanent", { listingId: input.listingId, jobItemId: input.jobItemId, causeCode: classified.code });
      }
      throw error;
    }
  }

  private async preReadForPush(input: MarketplacePrePushInput): Promise<MarketplacePrePushResult> {
    const logFields = { trigger: "push", job_id: input.jobId, job_item_id: input.jobItemId };
    const store = await this.deps.repository.loadStore(input.storeConnectionId);
    if (!store || store.vendorId !== input.vendorId) {
      // PROPOSED (sync-back): kept on the job item.
      throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.storeUnavailable, "The store cannot be read from eBay now.", "transient",
        { storeConnectionId: input.storeConnectionId, ...logFields });
    }
    let listing = await this.loadPushListing(input);
    if (listing.issueCodes.includes("sync_requires_review")) {
      // Dead-lettered (never retried): no read and no push until a person clears the flag.
      throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.requiresReview, MARKETPLACE_PUSH_STOP_WORDS[MARKETPLACE_SYNC_CODES.requiresReview],
        "permanent", { listingId: listing.listingId, ...logFields });
    }
    const state = await this.preparePushState(store, listing, logFields);
    const result = emptyTickResult();
    if (listing.observedQuantity) {
      if (await this.decideQuantity(state, listing, result) === "waiting") await this.pausePending(listing, state);
      listing = await this.loadPushListing(input);
      state.baselines = await this.deps.baselines.readPublishBaselines({ storeConnectionId: store.storeConnectionId, listings: [listing] });
    }
    const synced = await this.syncListing(state, listing, result,
      { kind: "push", relistAllowed: input.relistAllowed,
        lastSentText: marketplaceSyncSentTextFromHistory({ events: listing.events, storedIntent: listing.storedIntent }) }, input.jobItemId);
    if (synced === null) {
      // No SKU to read the listing by: the push's own refresh refuses it the same way (variant_sku_required).
      throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.nothingToCompare, MARKETPLACE_PUSH_STOP_WORDS[MARKETPLACE_SYNC_CODES.nothingToCompare],
        "permanent", { listingId: listing.listingId, ...logFields });
    }
    if (synced.quantity === "waiting") await this.pausePending(listing, state);
    const push = synced.decision.push;
    if (!push) {
      throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "A push pre-read gave no push decision.", "fatal",
        { listingId: listing.listingId });
    }
    if (push.kind === "stop") {
      this.deps.logger.info("dropship.marketplace_sync.push_stopped", { ...listingFields(listing, state), outcome: "stopped",
        error_code: push.code });
      throw marketplaceSyncError(push.code, MARKETPLACE_PUSH_STOP_WORDS[push.code], "permanent",
        { listingId: listing.listingId, ...logFields });
    }
    if (synced.unprovenStockOut && !input.relistAllowed) {
      // Review MS2: a 0 not on sale that is not Card Shellz's own may be the vendor's end; only the vendor's own press relists it.
      const code = MARKETPLACE_SYNC_CODES.endedOnEbay;
      this.deps.logger.info("dropship.marketplace_sync.push_stopped", { ...listingFields(listing, state), outcome: "stopped",
        error_code: code, reason: "stock_out_unproven" });
      throw marketplaceSyncError(code, MARKETPLACE_PUSH_STOP_WORDS[code], "permanent", { listingId: listing.listingId, ...logFields });
    }
    const externalListingId = synced.decision.status.relink?.listingId ?? listing.externalListingId;
    this.deps.logger.info("dropship.marketplace_sync.push_checked", { ...listingFields(listing, state), outcome: "proceed",
      external_listing_id_after: externalListingId, kept_vendor_title: push.passthrough.title !== null,
      kept_vendor_description: push.passthrough.description !== null, best_offer_carried: push.passthrough.bestOfferTerms !== null });
    return { externalListingId, externalOfferId: listing.externalOfferId, guard: push.guard, passthrough: push.passthrough,
      liveFulfillmentPolicyId: push.liveFulfillmentPolicyId };
  }

  /** The listing_push_attempted event of one push, just before its first eBay write (SB3). */
  async recordPushAttempt(input: { listingId: number; jobId: number; jobItemId: number; sent: MarketplacePushSentFields }): Promise<void> {
    await this.deps.repository.recordPushAttempt({ ...input, at: this.deps.clock.now() });
  }

  private async loadPushListing(input: MarketplacePrePushInput): Promise<MarketplaceSyncListing> {
    const listing = await this.deps.repository.loadListing(input.listingId, { excludeJobItemId: input.jobItemId });
    if (!listing || listing.vendorId !== input.vendorId || listing.storeConnectionId !== input.storeConnectionId
      || listing.productVariantId !== input.productVariantId) {
      // PROPOSED (sync-back): kept on the job item.
      throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.listingNotFound, "The listing is no longer the one this push was queued for.",
        "permanent", { listingId: input.listingId, jobItemId: input.jobItemId });
    }
    return listing;
  }

  /** E and ATP for one push's listing (the preview, as the system) and B; a failure here fails the pre-read, never skips it. */
  private async preparePushState(store: MarketplaceSyncStore, listing: MarketplaceSyncListing,
    logFields: Record<string, unknown>): Promise<StoreTickState> {
    const preview = await this.deps.previews.generatePreview({ vendorId: store.vendorId, storeConnectionId: store.storeConnectionId,
      productVariantIds: [listing.productVariantId],
      actor: { actorType: MARKETPLACE_SYNC_ACTOR.actorType, actorId: MARKETPLACE_SYNC_ACTOR.actorId } });
    const rows = new Map(preview.rows.map((row) => [row.productVariantId, row]));
    const baselines = await this.deps.baselines.readPublishBaselines({ storeConnectionId: store.storeConnectionId, listings: [listing] });
    return { trigger: "push", logFields, store, rows, baselines, restores: new Map(), stopped: false };
  }

  /**
   * A lower number on eBay waits for the order poll (§5): the observation stays
   * saved, the listing is due first for the sweep, and the push pauses with
   * nothing written; its next attempt decides the saved observation first.
   */
  private async pausePending(listing: MarketplaceSyncListing, state: StoreTickState): Promise<never> {
    await this.deps.repository.markListingsDue([listing.listingId]);
    this.deps.logger.debug("dropship.marketplace_sync.quantity_pending", { ...listingFields(listing, state), outcome: "push_paused" });
    // PROPOSED (sync-back): kept on the job item while it waits.
    throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.quantityPending,
      "A lower quantity on eBay is waiting for the order check before this listing is updated.", "transient",
      { listingId: listing.listingId, ...state.logFields });
  }

  async runSweepTick(): Promise<MarketplaceSyncTickResult> {
    const startedAt = this.deps.clock.now();
    const deadline = startedAt.getTime() + (this.deps.tickBudgetMs ?? MARKETPLACE_SYNC_TICK_BUDGET_MS);
    const result = emptyTickResult();
    for (const store of await this.deps.repository.listSweepStores()) {
      if (this.pastDeadline(deadline)) {
        result.budgetExhausted = true;
        break;
      }
      result.stores += 1;
      if (await this.sweepStore(store, deadline, result)) result.storesStopped += 1;
    }
    await this.sendNotices(result);
    const quiet = result.reads === 0 && result.quantityDecisions === 0 && result.noticesSent === 0 && result.restoreJobs === 0;
    const line = { outcome: result.budgetExhausted ? "budget_exhausted" : "completed", trigger: "sweep", ...tickLogFields(result),
      elapsed_ms: Math.max(0, this.deps.clock.now().getTime() - startedAt.getTime()) };
    if (quiet) this.deps.logger.debug("dropship.marketplace_sync.tick", line);
    else this.deps.logger.info("dropship.marketplace_sync.tick", line);
    return result;
  }

  /** One store's part of a tick. Answers whether the store stopped early. A failure of the store's own reads skips it. */
  private async sweepStore(store: MarketplaceSyncStore, deadline: number, result: MarketplaceSyncTickResult): Promise<boolean> {
    try {
      const observedIds = await this.deps.repository.listObservedListingIds({ storeConnectionId: store.storeConnectionId,
        limit: MARKETPLACE_SYNC_MAX_OBSERVATIONS_PER_STORE_TICK });
      const dueIds = await this.deps.repository.listDueListingIds({ storeConnectionId: store.storeConnectionId,
        limit: marketplaceSyncStoreListingCap(store.liveListingCount) });
      const listings: MarketplaceSyncListing[] = [];
      for (const id of [...new Set([...observedIds, ...dueIds])]) {
        const listing = await this.deps.repository.loadListing(id);
        if (listing) listings.push(listing);
      }
      const state = listings.length > 0 ? await this.prepareStore(store, listings) : null;
      if (state) {
        try {
          for (const listing of listings) {
            if (state.stopped) break;
            if (this.pastDeadline(deadline)) {
              result.budgetExhausted = true;
              break;
            }
            await this.guardListing(state, listing, result, () => this.processListing(state, listing, result));
          }
        } finally {
          await this.queueRestore(state, result);
        }
        if (state.stopped) return true;
      }
      if (!this.pastDeadline(deadline)) await this.checkPolicies(store, result);
      return false;
    } catch (error) {
      const classified = classifyMarketplaceSyncError(error);
      if (classified.handling === "abort_tick") throw error;
      this.logClassified("dropship.marketplace_sync.store_failed", classified, { ...storeFields(store), outcome: "skipped" });
      return true;
    }
  }

  /**
   * E and ATP for the store's listings (the push pipeline's own preview, as
   * the system) and B for their quantity. A store the preview refuses (its
   * vendor, membership or store may not list now) or cannot compute is
   * skipped this tick.
   */
  private async prepareStore(store: MarketplaceSyncStore, listings: readonly MarketplaceSyncListing[]): Promise<StoreTickState | null> {
    const variantIds = [...new Set(listings.map((listing) => listing.productVariantId))];
    const rows = new Map<number, MarketplaceSyncPreviewRow>();
    try {
      for (let index = 0; index < variantIds.length; index += MARKETPLACE_SYNC_PREVIEW_CHUNK) {
        const preview = await this.deps.previews.generatePreview({ vendorId: store.vendorId, storeConnectionId: store.storeConnectionId,
          productVariantIds: variantIds.slice(index, index + MARKETPLACE_SYNC_PREVIEW_CHUNK),
          actor: { actorType: MARKETPLACE_SYNC_ACTOR.actorType, actorId: MARKETPLACE_SYNC_ACTOR.actorId } });
        for (const row of preview.rows) rows.set(row.productVariantId, row);
      }
    } catch (error) {
      // A refusal that names its resolution is the store's own access rule (expected); anything else is classified.
      const classified = error instanceof DropshipError && typeof error.context?.resolution === "string"
        ? { classification: "expected", handling: "ignore", code: error.code, logLevel: "debug" } as const
        : classifyMarketplaceSyncError(error);
      if (classified.handling === "abort_tick") throw error;
      this.logClassified("dropship.marketplace_sync.store_preview_failed", classified, { ...storeFields(store), outcome: "skipped" });
      return null;
    }
    const baselines = await this.deps.baselines.readPublishBaselines({ storeConnectionId: store.storeConnectionId, listings });
    return { trigger: "sweep", logFields: { trigger: "sweep" }, store, rows, baselines, restores: new Map(), stopped: false };
  }

  /** A saved observation is decided before its listing is read again (§6.2); otherwise the listing is read and synced. */
  private async processListing(state: StoreTickState, listing: MarketplaceSyncListing, result: MarketplaceSyncTickResult): Promise<void> {
    if (listing.observedQuantity) {
      await this.decideQuantity(state, listing, result);
      return;
    }
    await this.syncListing(state, listing, result, { kind: "sweep" }, null);
  }

  /** Runs one listing's work and classifies what it throws: the listing's outcome, or the store's stop. */
  private async guardListing(state: StoreTickState, listing: MarketplaceSyncListing, result: MarketplaceSyncTickResult,
    work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      const classified = classifyMarketplaceSyncError(error);
      const fields = { ...listingFields(listing, state), outcome: classified.handling };
      switch (classified.handling) {
        case "abort_tick":
          this.logClassified("dropship.marketplace_sync.listing_failed", classified, fields);
          throw error;
        case "stop_store":
        case "skip_store":
          state.stopped = true;
          this.logClassified("dropship.marketplace_sync.store_stopped", classified, fields);
          return;
        case "skip_listing":
          // No answer from eBay (or the database): the listing stays first in line for the next tick.
          result.readFailures += 1;
          this.logClassified("dropship.marketplace_sync.listing_skipped", classified, fields);
          return;
        case "retry_next_tick":
          // A race was lost: decided again from a fresh read, first thing next tick, never written from a stale decision.
          await this.deps.repository.markListingsDue([listing.listingId]);
          this.logClassified("dropship.marketplace_sync.listing_deferred", classified, fields);
          return;
        case "ignore":
        case "flag_price_limit":
          await this.deps.repository.recordAttempt(listing.listingId, this.deps.clock.now());
          this.logClassified("dropship.marketplace_sync.listing_not_synced", classified, fields);
          return;
        case "review":
          // Permanent and ours: dead-lettered once, never retried (CLAUDE.md §6).
          await this.deps.repository.deadLetterListing({ listingId: listing.listingId, failureCode: classified.code, at: this.deps.clock.now() });
          result.deadLettered += 1;
          this.logClassified("dropship.marketplace_sync.listing_dead_lettered", classified, { ...fields, outcome: "requires_review" });
          return;
      }
    }
  }

  /**
   * Read one listing from eBay, decide (pure), and apply the decision in one
   * transaction (§6.5); then decide the quantity the read saved. Null when
   * Card Shellz has nothing to compare the listing with (no preview row or
   * SKU), which reads nothing.
   */
  private async syncListing(state: StoreTickState, listing: MarketplaceSyncListing, result: MarketplaceSyncTickResult,
    trigger: MarketplaceSyncTrigger, excludeJobItemId: number | null): Promise<SyncedListing | null> {
    const row = state.rows.get(listing.productVariantId);
    const sku = storedIntentSku(listing.storedIntent) ?? row?.sku?.trim() ?? null;
    if (!row || !sku) {
      // Nothing Card Shellz would send (a size gone from the catalog, or no SKU): nothing to compare. Read again next pass.
      await this.deps.repository.recordAttempt(listing.listingId, this.deps.clock.now());
      this.deps.logger.debug("dropship.marketplace_sync.listing_not_synced", { ...listingFields(listing, state),
        outcome: row ? "no_sku" : "no_preview_row" });
      return null;
    }
    const raw = await this.deps.reader.readLiveListing({ vendorId: listing.vendorId, storeConnectionId: listing.storeConnectionId,
      offerId: listing.externalOfferId, sku });
    const observedAt = this.deps.clock.now();
    result.reads += 1;
    const read = toListingRead(raw, listing.externalOfferId);
    const ours = marketplaceSyncOursFromHistory({ events: listing.events, storedIntent: listing.storedIntent });
    const baseline = state.baselines.get(listing.listingId) ?? null;
    const decision = decideMarketplaceSync({
      trigger,
      read,
      observedAt,
      listing: {
        listingId: listing.listingId, itemLabel: itemLabelOf(row), sku, externalListingId: listing.externalListingId,
        status: listing.status, issueCodes: listing.issueCodes, marketplaceEndedAt: listing.marketplaceEndedAt,
        latestPublishedQuantity: baseline?.quantity ?? listing.pushedQuantity,
      },
      ours,
      echelon: marketplaceSyncEchelonFromPreview(row),
    });
    const observation = read.kind === "observed" ? read.observation : null;
    const saveObservation = quantityObservationToSave(observation, decision, listing, observedAt);
    // §6.5: the quantity this read decides at once commits with its price and policy adoptions, in one transaction.
    const quantityListing: MarketplaceSyncListing | null = saveObservation === null ? null : { ...listing,
      status: decision.status.endListing ? "ended" : decision.status.reactivate ? "active" : listing.status,
      issueCodes: decision.issues.after, observedQuantity: saveObservation };
    const quantityPlan = quantityListing === null ? null : await this.planQuantity(state, quantityListing);
    const write = await this.deps.repository.applyListingSync({
      trigger: state.trigger, excludeJobItemId,
      listingId: listing.listingId, vendorId: listing.vendorId, storeConnectionId: listing.storeConnectionId,
      productVariantId: listing.productVariantId, externalOfferId: listing.externalOfferId, observedAt,
      expectedNewestEventId: newestMarketplaceSyncEventId(listing.events),
      decision,
      oursPriceBaseline: ours.priceCents.baseline,
      price: decision.price.kind === "adopt" ? { priceCents: decision.price.priceCents, expectedRevisionId: row.priceSettingRevisionId ?? null } : null,
      policies: decision.policies.kind === "adopt" ? decision.policies.changes : null,
      observed: observation ? { priceCents: observation.priceCents, fulfillmentPolicyId: observation.policies.fulfillmentPolicyId } : null,
      saveObservation,
      expectedObservation: listing.observedQuantity,
      quantity: quantityPlan?.kind === "decide" ? quantityPlan.write : null,
    });
    if (write.price === "adopted") result.priceAdoptions += 1;
    if (write.policies === "saved") result.policyAdoptions += 1;
    this.logSynced(state, listing, write, observation);
    const statusAfter = write.status.ended ? "ended" : write.status.reactivated ? "active" : listing.status;
    // Review MS2: eBay's own out-of-stock end needs Card Shellz's own settled 0; the limit is the one this read's decision left.
    const unprovenStockOut = observation !== null && !observation.live && write.decision.issues.after.includes("ended_out_of_stock")
      && !isStockOutEndProven({ observedQuantity: observation.quantity.observed, observedAt,
        baseline: chooseQuantityBaseline(baseline, listing.quantityBaseline) });
    const limitChange = write.quantityApplied === true && quantityPlan?.kind === "decide" ? quantityPlan.writes.limitChange : null;
    const limitAfter = limitChange === null ? listing.vendorQuantityLimit : limitChange.kind === "set" ? limitChange.limit : null;
    // A push republishes by itself: only the sweep adds the listing to its store's restore push.
    if (state.trigger === "sweep" && isRepublishWanted({ issuesAfter: write.decision.issues.after, listingStatus: statusAfter,
      publishableQuantity: publishableQuantity(row.marketplaceQuantity, limitAfter), stockOutProven: !unprovenStockOut })) {
      this.addRestore(state, listing, write.syncedEventId);
      this.deps.logger.info("dropship.marketplace_sync.republish", { ...listingFields(listing, state), outcome: "restore_queued" });
    }
    let quantity: QuantityOutcome = "none";
    if (write.observationSaved && quantityListing && quantityPlan) {
      if (quantityPlan.kind === "waiting") {
        // Expected: the order poll has not covered the read yet; ops health warns after two hours (§10).
        this.deps.logger.debug("dropship.marketplace_sync.quantity_pending", quantityPlan.line);
        quantity = "waiting";
      } else {
        this.finishQuantity(state, quantityListing, quantityPlan, write.quantityApplied === true, result);
        quantity = "decided";
      }
    }
    return { decision: write.decision, quantity, unprovenStockOut };
  }

  /** Decides one saved quantity observation (§6.4, owner rule 1) and applies its writes in one transaction. */
  private async decideQuantity(state: StoreTickState, listing: MarketplaceSyncListing, result: MarketplaceSyncTickResult): Promise<QuantityOutcome> {
    const plan = await this.planQuantity(state, listing);
    if (plan === null) return "none";
    if (plan.kind === "waiting") {
      // Expected: the order poll has not covered the read yet; ops health warns after two hours (§10).
      this.deps.logger.debug("dropship.marketplace_sync.quantity_pending", plan.line);
      return "waiting";
    }
    const applied = await this.deps.repository.applyQuantityDecision(plan.write);
    this.finishQuantity(state, listing, plan, applied.applied, result);
    return "decided";
  }

  /**
   * Decides a quantity observation (§6.4, owner rule 1) without writing it:
   * the sales since Card Shellz's baseline are read, the rest is the domain's
   * pure decision. Null without an observation.
   */
  private async planQuantity(state: StoreTickState, listing: MarketplaceSyncListing): Promise<QuantityPlan | null> {
    const observation = listing.observedQuantity;
    if (!observation) return null;
    const row = state.rows.get(listing.productVariantId);
    const baseline = chooseQuantityBaseline(state.baselines.get(listing.listingId) ?? null, listing.quantityBaseline);
    const fields: Record<string, unknown> = { ...listingFields(listing, state), observed_quantity: observation.quantity,
      observed_at: observation.at.toISOString(), baseline_at: baseline?.at.toISOString() ?? null,
      vendor_quantity_limit: listing.vendorQuantityLimit, atp_quantity: row?.marketplaceQuantity ?? null };
    const idempotencyKey = marketplaceQuantityLimitKey({ listingId: listing.listingId, observedAt: observation.at, quantity: observation.quantity });
    const write = (writes: QuantityDecisionWrites): MarketplaceQuantityDecisionWrite => ({ listingId: listing.listingId,
      storeConnectionId: listing.storeConnectionId, observation, expectedLimit: listing.vendorQuantityLimit, writes, idempotencyKey,
      decidedAt: this.deps.clock.now() });
    if (!row) {
      // Echelon's ATP is unknown without its preview row: nothing is decided on an unknown number. The observation is
      // dropped so the listing is read again (and a fresh one saved) instead of waiting here for good.
      const writes = dropObservationWrites();
      return { kind: "decide", write: write(writes), writes, line: { ...fields, outcome: "dropped_no_preview_row" }, decisionKind: "dropped",
        dropped: true };
    }
    const sales = baseline && baseline.at.getTime() <= observation.at.getTime()
      ? await this.deps.repository.sumSales({ listingId: listing.listingId, ...quantitySalesWindows(baseline.at, observation.at) })
      : { all: 0, live: 0 };
    const decision = decideMarketplaceQuantity({
      observed: observation, baseline, sales,
      listingLive: listing.status !== "ended" && !listing.issueCodes.includes("ended_out_of_stock"),
      salesLedgerSince: state.store.salesLedgerSince, lastOrderSyncAt: state.store.lastOrderSyncAt,
      vendorQuantityLimit: listing.vendorQuantityLimit, atpQuantity: row.marketplaceQuantity,
    });
    const decided = { ...fields, decision: decision.kind, ...("reason" in decision ? { reason: decision.reason } : {}),
      ...("expected" in decision ? { expected_low: decision.expected.low, expected_high: decision.expected.high } : {}) };
    const writes = quantityDecisionWrites(decision, listing.issueCodes);
    if (writes === null) return { kind: "waiting", line: { ...decided, outcome: "waiting" } };
    return { kind: "decide", write: write(writes), writes, line: decided, decisionKind: decision.kind, dropped: false };
  }

  /** After a quantity decision's write: the counts, the store's restore push (sweep only), and the log line. */
  private finishQuantity(state: StoreTickState, listing: MarketplaceSyncListing, plan: Extract<QuantityPlan, { kind: "decide" }>,
    applied: boolean, result: MarketplaceSyncTickResult): void {
    if (plan.dropped) {
      this.deps.logger.debug("dropship.marketplace_sync.quantity_decided", plan.line);
      return;
    }
    result.quantityDecisions += 1;
    if (!applied) {
      // Another writer moved the observation or the limit first: the next read decides again.
      this.deps.logger.debug("dropship.marketplace_sync.quantity_decided", { ...plan.line, outcome: "observation_changed" });
      return;
    }
    const { writes } = plan;
    const limitAfter = writes.limitChange === null ? listing.vendorQuantityLimit
      : writes.limitChange.kind === "set" ? writes.limitChange.limit : null;
    if (writes.limitChange !== null) result.limitChanges += 1;
    // A push publishes min(ATP, limit) itself: only the sweep queues its store's restore push.
    if (writes.restore === "queue" && state.trigger === "sweep") this.addRestore(state, listing, newestMarketplaceSyncEventId(listing.events));
    const transition = writes.limitChange !== null || writes.restore !== "none";
    const line = { ...plan.line, outcome: writes.restore === "blocked" ? "restore_blocked" : writes.restore === "queue" ? "restore_queued" : plan.decisionKind,
      before: { vendor_quantity_limit: listing.vendorQuantityLimit }, after: { vendor_quantity_limit: limitAfter } };
    if (writes.restore === "blocked") {
      // Staff only (owner rule 1: no quantity notice): Echelon has none to publish but eBay shows some, and a push cannot send 0.
      this.deps.logger.warn("dropship.marketplace_sync.quantity_decided", { ...line, error_code: "DROPSHIP_LISTING_QUANTITY_RESTORE_BLOCKED",
        error_class: "permanent" });
    } else if (transition) {
      this.deps.logger.info("dropship.marketplace_sync.quantity_decided", line);
    } else {
      this.deps.logger.debug("dropship.marketplace_sync.quantity_decided", line);
    }
  }

  private addRestore(state: StoreTickState, listing: MarketplaceSyncListing, eventId: number | null): void {
    const existing = state.restores.get(listing.listingId);
    const newestEventId = Math.max(existing?.newestEventId ?? 0, eventId ?? 0, newestMarketplaceSyncEventId(listing.events) ?? 0);
    state.restores.set(listing.listingId, { productVariantId: listing.productVariantId, newestEventId });
  }

  /**
   * The store's one restore push this tick (§6.4, SB-C1): an ordinary push job
   * of the sizes to put back, queued from the current preview by the system,
   * keyed by the listings and the newest sync event it saw, so a replay queues
   * nothing new. A store that may not take a push now is expected (DEBUG);
   * the next read sees eBay still high and queues it again.
   */
  private async queueRestore(state: StoreTickState, result: MarketplaceSyncTickResult): Promise<void> {
    const entries = [...state.restores.entries()].sort(([left], [right]) => left - right);
    state.restores.clear();
    for (let index = 0; index < entries.length; index += MARKETPLACE_SYNC_PREVIEW_CHUNK) {
      const chunk = entries.slice(index, index + MARKETPLACE_SYNC_PREVIEW_CHUNK);
      const listingIds = chunk.map(([listingId]) => listingId);
      const idempotencyKey = marketplaceQuantityRestoreJobKey({ storeConnectionId: state.store.storeConnectionId, listingIds,
        maxEventId: Math.max(0, ...chunk.map(([, entry]) => entry.newestEventId)) });
      const fields = { ...storeFields(state.store), listing_ids: listingIds, idempotency_key: idempotencyKey };
      try {
        const outcome = await this.deps.restores.queueRestore({ vendorId: state.store.vendorId, storeConnectionId: state.store.storeConnectionId,
          productVariantIds: chunk.map(([, entry]) => entry.productVariantId), idempotencyKey });
        if (outcome.queued) {
          if (!outcome.idempotentReplay) result.restoreJobs += 1;
          this.deps.logger.info("dropship.marketplace_sync.restore_job", { ...fields, outcome: outcome.idempotentReplay ? "replayed" : "queued",
            job_id: outcome.jobId });
        } else {
          this.deps.logger.debug("dropship.marketplace_sync.restore_job", { ...fields, outcome: "refused", error_code: outcome.code });
        }
      } catch (error) {
        const classified = classifyMarketplaceSyncError(error);
        if (classified.handling === "abort_tick") throw error;
        this.logClassified("dropship.marketplace_sync.restore_job", classified, { ...fields, outcome: "failed" });
      }
    }
  }

  /**
   * Each live shipping policy of the store, checked fresh once a tick (§6.3,
   * owner rule 4): the verdict is stored, and one that turns incompatible (or
   * another incompatible one) is told to the vendor once, critically, in the
   * same transaction, and to staff (WARN, ops health). The listings keep the
   * policy: nothing on them changes. A check that got no answer keeps the
   * previous verdict and sends nothing.
   */
  private async checkPolicies(store: MarketplaceSyncStore, result: MarketplaceSyncTickResult): Promise<void> {
    if (!store.marketplaceId) return;
    const policies = await this.deps.repository.listObservedPolicies({ storeConnectionId: store.storeConnectionId,
      limit: MARKETPLACE_SYNC_MAX_POLICY_CHECKS_PER_STORE_TICK });
    for (const policy of policies) {
      const fields = { ...storeFields(store), fulfillment_policy_id: policy.fulfillmentPolicyId, listing_count: policy.listingCount };
      try {
        const preflight = await this.deps.policyGuard.evaluateForStoreConnection({ vendorId: store.vendorId,
          storeConnectionId: store.storeConnectionId, marketplaceId: store.marketplaceId, fulfillmentPolicyId: policy.fulfillmentPolicyId,
          fresh: true });
        const issueCodes = [...new Set(preflight.issues.map((issue) => issue.code))].sort();
        const written = await this.deps.repository.applyPolicyCheck({ vendorId: store.vendorId, storeConnectionId: store.storeConnectionId,
          fulfillmentPolicyId: policy.fulfillmentPolicyId, compatible: preflight.compatible, issueCodes,
          verdictHash: fulfillmentPolicyVerdictHash(issueCodes), listingCount: policy.listingCount, checkedAt: this.deps.clock.now() });
        result.policyChecks += 1;
        if (written.notified) {
          this.deps.logger.warn("dropship.marketplace_sync.policy_incompatible", { ...fields, outcome: "notified",
            error_code: "DROPSHIP_LISTING_POLICY_INCOMPATIBLE", error_class: "permanent", issue_codes: issueCodes });
        }
      } catch (error) {
        const classified = classifyMarketplaceSyncError(error);
        if (classified.handling === "abort_tick") throw error;
        this.logClassified("dropship.marketplace_sync.policy_check_failed", classified, { ...fields, outcome: "kept_previous" });
        if (classified.handling === "stop_store" || classified.handling === "skip_store") return;
      }
    }
  }

  /**
   * The notice outbox (§6.6): claim what is pending, send each batch with its
   * key as the notification's idempotency key, then mark it sent. A passing
   * failure leaves the batch for the next tick (same key, so the notification
   * service replays instead of sending twice); a refusal no retry can fix
   * dead-letters the batch; a key the notification service already holds for
   * other words was sent before: marked sent, with a warning.
   */
  private async sendNotices(result: MarketplaceSyncTickResult): Promise<void> {
    try {
      await this.deps.repository.claimNoticeBatches();
    } catch (error) {
      const classified = classifyMarketplaceSyncError(error);
      if (classified.handling === "abort_tick") throw error;
      this.logClassified("dropship.marketplace_sync.notice_claim_failed", classified, { outcome: "deferred" });
    }
    const batches = await this.deps.repository.listUnsentNoticeBatches(MARKETPLACE_SYNC_MAX_NOTICE_BATCHES_PER_TICK);
    for (const batch of batches) {
      const words = describeMarketplaceSyncNoticeBatch(batch.kind, batch.payloads);
      const fields = { vendor_id: batch.vendorId, store_connection_id: batch.storeConnectionId, batch_key: batch.batchKey, kind: batch.kind,
        notice_count: batch.payloads.length };
      try {
        await this.deps.notifications.send({
          vendorId: batch.vendorId,
          eventType: marketplaceSyncNoticeEventType(batch.kind, batch.critical),
          critical: batch.critical,
          title: words.title,
          message: words.message,
          // Facts only: the words are in the message.
          payload: { kind: batch.kind, storeConnectionId: batch.storeConnectionId, noticeCount: batch.payloads.length,
            listingIds: listingIdsOf(batch.payloads) },
          idempotencyKey: batch.batchKey,
        });
        await this.deps.repository.markNoticeBatchSent({ batchKey: batch.batchKey, sentAt: this.deps.clock.now() });
        result.noticesSent += 1;
        this.deps.logger.info("dropship.marketplace_sync.notice_sent", { ...fields, outcome: "sent" });
      } catch (error) {
        if (error instanceof DropshipError && error.code === NOTIFICATION_IDEMPOTENCY_CONFLICT) {
          await this.deps.repository.markNoticeBatchSent({ batchKey: batch.batchKey, sentAt: this.deps.clock.now() });
          this.deps.logger.warn("dropship.marketplace_sync.notice_sent", { ...fields, outcome: "already_sent", error_code: error.code,
            error_class: "permanent" });
          continue;
        }
        const failure = classifyNoticeFailure(error);
        if (failure.classification === "fatal") throw error;
        if (failure.classification === "permanent") {
          await this.deps.repository.deadLetterNoticeBatch({ batchKey: batch.batchKey, failureCode: failure.code, at: this.deps.clock.now() });
          result.noticesDeadLettered += 1;
          this.deps.logger.error("dropship.marketplace_sync.notice_dead_lettered", { ...fields, outcome: "requires_review",
            error_code: failure.code, error_class: "permanent" });
          continue;
        }
        this.deps.logger.warn("dropship.marketplace_sync.notice_send_failed", { ...fields, outcome: "deferred", error_code: failure.code,
          error_class: "transient" });
      }
    }
  }

  private logSynced(state: StoreTickState, listing: MarketplaceSyncListing, write: MarketplaceListingSyncWriteResult,
    observation: MarketplaceListingObservation | null): void {
    const { decision } = write;
    const changed = write.price === "adopted" || write.policies === "saved" || write.status.ended || write.status.reactivated
      || write.status.relinked || decision.issues.add.length > 0 || decision.issues.remove.length > 0;
    const fields = {
      ...listingFields(listing, state), outcome: changed ? "changed" : "unchanged",
      price: write.price, policies: write.policies, status: write.status,
      issues_added: decision.issues.add, issues_removed: decision.issues.remove, notices_written: write.noticesWritten,
      observation_saved: write.observationSaved, observed_quantity: observation?.quantity.observed ?? null,
      listing_live: observation?.live ?? null,
    };
    // A first sighting of an issue is WARN; a change is INFO; a read that changed nothing is DEBUG (CLAUDE.md §10).
    if (decision.issues.add.length > 0 || write.price === "refused_limit") this.deps.logger.warn("dropship.marketplace_sync.listing_synced", fields);
    else if (changed) this.deps.logger.info("dropship.marketplace_sync.listing_synced", fields);
    else this.deps.logger.debug("dropship.marketplace_sync.listing_synced", fields);
  }

  private logClassified(action: string, classified: MarketplaceSyncErrorClassification, fields: Record<string, unknown>): void {
    this.deps.logger[classified.logLevel](action, { error_code: classified.code, error_class: classified.classification, ...fields });
  }

  private pastDeadline(deadline: number): boolean {
    return this.deps.clock.now().getTime() >= deadline;
  }
}

/**
 * Qe is saved for a decision (§6.4) only when the read proved the listing is
 * ours, no push of it is queued or running (its baseline would not be
 * settled), the vendor has not ended it (Echelon publishes nothing to an
 * ended listing, so its quantity says nothing about a limit), and eBay shows
 * it on sale or at 0 (a listing not on sale with stock is the vendor's end,
 * SB7, never a quantity).
 */
function quantityObservationToSave(observation: MarketplaceListingObservation | null, decision: MarketplaceSyncDecision,
  listing: MarketplaceSyncListing, observedAt: Date): { quantity: number; at: Date } | null {
  if (!observation || listing.hasOpenPushItem) return null;
  if (decision.issues.after.some((code) => MARKETPLACE_IDENTITY_ISSUE_CODES.includes(code))) return null;
  const endedAfter = decision.status.endListing || (listing.status === "ended" && !decision.status.reactivate);
  if (endedAfter || (!observation.live && observation.quantity.observed > 0)) return null;
  return { quantity: observation.quantity.observed, at: observedAt };
}

/** The order-side notice kinds (owner rule 7d): sent under the order event types, never the listing ones (review ARCH-8). */
const ORDER_NOTICE_KINDS: ReadonlySet<MarketplaceSyncNoticeKind> = new Set(["order_cancel_refunded", "order_cancel_not_stopped", "unknown_item_number"]);

/** The notification event type of one notice batch: its side (listing or order), and whether it is critical. */
export function marketplaceSyncNoticeEventType(kind: MarketplaceSyncNoticeKind, critical: boolean): string {
  if (ORDER_NOTICE_KINDS.has(kind)) {
    return critical ? DROPSHIP_NOTIFICATION_EVENTS.EBAY_ORDER_ACTION_NEEDED : DROPSHIP_NOTIFICATION_EVENTS.EBAY_ORDER_UPDATE;
  }
  return critical ? DROPSHIP_NOTIFICATION_EVENTS.EBAY_LISTING_ACTION_NEEDED : DROPSHIP_NOTIFICATION_EVENTS.EBAY_LISTING_WARNING;
}

/** A send failure: invalid input is permanent; a database failure passes; a broken invariant is fatal. */
function classifyNoticeFailure(error: unknown): { classification: "transient" | "permanent" | "fatal"; code: string } {
  const classified = classifyMarketplaceSyncError(error);
  if (classified.classification === "fatal") return { classification: "fatal", code: classified.code };
  if (error instanceof DropshipError) {
    const transient = error.context?.retryable === true || error.context?.classification === "transient";
    return { classification: transient ? "transient" : "permanent", code: error.code };
  }
  // A send meets the notification path's own I/O, where a raw error may be a lost connection: it is sent again next tick
  // under the same idempotency key (so never twice), as before review MS4. A database refusal (SQLSTATE 23/42) is permanent.
  if (classified.code === "UNEXPECTED_ERROR") return { classification: "transient", code: classified.code };
  return { classification: classified.classification === "permanent" ? "permanent" : "transient", code: classified.code };
}

/** eBay's raw answers as the decision's read: observed (validated), the offer gone, or unreadable. */
function toListingRead(raw: MarketplaceLiveListingRaw, offerId: string): MarketplaceListingRead {
  if (raw.kind === "offer_missing") return { kind: "offer_missing" };
  const parsed = parseMarketplaceListingObservation({ offer: raw.offer, inventoryItem: raw.inventoryItem, expectedOfferId: offerId });
  return parsed.kind === "observed" ? { kind: "observed", observation: parsed.observation } : { kind: "unreadable", reason: parsed.reason };
}

/**
 * E (§4.1): what Card Shellz would send now, from the push pipeline's own
 * preview row, and what it charges the vendor for one unit (the below-cost
 * notice) when the cost is known.
 */
export function marketplaceSyncEchelonFromPreview(row: MarketplaceSyncPreviewRow): MarketplaceSyncEchelon {
  return {
    priceCents: row.priceCents,
    fulfillmentPolicyId: row.businessPolicySelection?.fulfillmentPolicyId ?? null,
    returnPolicyId: row.businessPolicySelection?.returnPolicyId ?? null,
    paymentPolicyId: row.businessPolicySelection?.paymentPolicyId ?? null,
    unitCostCents: row.economics?.productCostStatus === "available" ? row.economics.vendorProductCostCents : null,
  };
}

/** The words a notice names a size by: its title and SKU, as the preview has them. */
function itemLabelOf(row: MarketplaceSyncPreviewRow): string {
  const title = row.title.trim();
  const sku = row.sku?.trim();
  if (!title) return sku ? `SKU ${sku}` : "a listing";
  return sku ? `${title} (SKU ${sku})` : title;
}

function listingIdsOf(payloads: readonly Record<string, unknown>[]): number[] {
  return [...new Set(payloads.map((payload) => payload.listingId).filter((id): id is number => Number.isSafeInteger(id)))].slice(0, 100);
}

function storeFields(store: MarketplaceSyncStore): Record<string, unknown> {
  return { vendor_id: store.vendorId, store_connection_id: store.storeConnectionId, trigger: "sweep" };
}

function listingFields(listing: MarketplaceSyncListing, state: Pick<StoreTickState, "logFields">): Record<string, unknown> {
  return { vendor_id: listing.vendorId, store_connection_id: listing.storeConnectionId, listing_id: listing.listingId,
    product_variant_id: listing.productVariantId, external_listing_id: listing.externalListingId,
    external_offer_id: listing.externalOfferId, ...state.logFields };
}

/** An eBay HTTP answer (it carries eBay's status), as opposed to a failure of Card Shellz's own. */
function isMarketplaceAnswer(error: unknown): boolean {
  return error instanceof DropshipError && typeof error.context?.status === "number";
}

function emptyTickResult(): MarketplaceSyncTickResult {
  return { stores: 0, storesStopped: 0, reads: 0, readFailures: 0, priceAdoptions: 0, policyAdoptions: 0, quantityDecisions: 0,
    limitChanges: 0, restoreJobs: 0, deadLettered: 0, policyChecks: 0, noticesSent: 0, noticesDeadLettered: 0, budgetExhausted: false };
}

function tickLogFields(result: MarketplaceSyncTickResult): Record<string, unknown> {
  return { stores: result.stores, stores_stopped: result.storesStopped, reads: result.reads, read_failures: result.readFailures,
    price_adoptions: result.priceAdoptions, policy_adoptions: result.policyAdoptions, quantity_decisions: result.quantityDecisions,
    limit_changes: result.limitChanges, restore_jobs: result.restoreJobs, dead_lettered: result.deadLettered,
    policy_checks: result.policyChecks, notices_sent: result.noticesSent, notices_dead_lettered: result.noticesDeadLettered };
}
