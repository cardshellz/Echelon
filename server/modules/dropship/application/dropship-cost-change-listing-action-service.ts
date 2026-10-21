import { z } from "zod";
import type { DropshipCostChangePolicySettings } from "../../../../shared/dropship/cost-change-policy";
import type { ListingPricingMode } from "../../../../shared/dropship/listing-price";
import type { PricingProfileState } from "../../../../shared/dropship/pricing-rules";
import {
  COST_ACTIONABLE_LISTING_STATUSES,
  classifyCostChangeListingPrice,
  costChangeHoldIdempotencyKey,
  costChangeListingActionValues,
  costChangeListingFollowUpNoticeIdempotencyKey,
  costChangeListingNoticeIdempotencyKey,
  costChangeRecheckHoldIdempotencyKey,
  costChangeRecheckRepriceIdempotencyKey,
  costChangeReleaseIdempotencyKey,
  costChangeRepriceIdempotencyKey,
  decideCostChangeHoldRelease,
  decideCostChangeListingAction,
  idSetHash,
  judgeAgainstPublishedPrice,
  type CostChangeHoldReleaseDetail,
  type CostChangeHoldReleaseReason,
  type CostChangeListingAction,
  type CostChangeListingNoticeKind,
  type CostChangeListingPriceClassification,
  type CostChangeListingPriceSource,
} from "../domain/cost-change-listing-action";
import { costChangeNoticeChannels } from "../domain/cost-change-notice";
import { DropshipError } from "../domain/errors";
import type { DropshipCostChangePolicyReader } from "./dropship-cost-detection-service";
import type { DropshipListingVariantHoldGate } from "./dropship-listing-tier-service";
import { formatNotificationCurrency } from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import { withRulePriceLimitCheck, type DropshipPricingPolicyRecord } from "./dropship-listing-preview-service";
import { EMPTY_LISTING_SETTING_LAYERS, type ListingSettingLayers } from "./dropship-listing-setting-layers";
import { createRulePriceResolver, NO_PRICING_PROFILE_STATE, rulePriceContextOf } from "./dropship-rule-price";
import type { DropshipClock, DropshipLogger, DropshipNotificationSender } from "./dropship-ports";

/**
 * Listing actions when a .ops cost increase takes effect
 * (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, C5).
 *
 * The pass walks increases that are in force and not yet acted on, one vendor
 * at a time. Every listing of the increase's variant is decided by the pure
 * rules in domain/cost-change-listing-action.ts under the policy in force:
 * rule-priced listings are queued for a new price through a system push job
 * or left for the vendor's review; every other listing is judged against the
 * cost and, when under water, recorded, warned about, or paused through the
 * inventory-planning SKU hold. The vendor is told once per kind, the sends go
 * before the record, and the record is one transaction: the entry row that
 * marks the increase done commits with its listing rows and holds.
 *
 * A second phase reviews live pauses and releases a hold once the price
 * buyers see covers the cost in force again, or the listing is no longer
 * live. A live listing is judged at the lower of its settings price and the
 * price its last completed push published (judgeAgainstPublishedPrice): a
 * queued, blocked or failed update leaves the listing live and orderable at
 * the published price.
 *
 * Before the first phase, a recheck judges once, on the facts in force, an
 * increase that was skipped because the listing read queued, failed or
 * blocked and is live now: before the live status fix an earlier queue or
 * failed push wrote those statuses over listings that stayed live on the
 * marketplace, and the live status repair has since restored them. The SKU
 * hold at inventory planning has one holder and any release deletes it, so a
 * hold the listing tier reconciler owns is never released from here, and a
 * hold of ours that a tier release deleted is re-asserted.
 *
 * ASSUMPTION: .ops costs and listing prices are USD (the Shopify store's
 * currency); neither carries a currency column.
 */

export const DEFAULT_COST_LISTING_ACTION_ENTRIES_PER_PASS = 50;
export const MAX_COST_LISTING_ACTION_ENTRIES_PER_PASS = 500;
export const DEFAULT_COST_LISTING_HOLDS_PER_PASS = 200;
export const MAX_COST_LISTING_HOLDS_PER_PASS = 2000;
/** The most variants one reprice push job names: the push contract's own bound. */
export const COST_REPRICE_VARIANTS_PER_JOB = 500;
/** How many listings one notice lists in full; the rest are counted. */
export const COST_LISTING_NOTICE_LISTED = 10;
export const COST_LISTING_NOTICE_PAYLOAD_LISTINGS = 100;
/** Admin pages of listing actions, newest first. */
export const COST_LISTING_ACTION_PAGE_LIMIT = 50;
/** The vendor's portal lists their listing actions of the last month, bounded. */
export const VENDOR_COST_LISTING_ACTION_VIEW_LIMIT = 200;
export const VENDOR_COST_LISTING_ACTION_RECENT_DAYS = 30;
/** The actor inventory planning records as the holder of a cost-change pause. */
export const COST_CHANGE_HOLD_ACTOR_ID = "dropship-cost-changes";
export const COST_CHANGE_PUSH_ACTOR_ID = "dropship-cost-changes";
const MAX_STORE_CONNECTIONS_PER_VENDOR = 100;
const COST_LISTING_CURRENCY = "USD";
const COST_CHANGE_HOLD_REASON = "Dropship cost change: listing price under the .ops cost";

export interface EffectiveCostIncrease {
  entryId: number;
  vendorId: number;
  productVariantId: number;
  fromCents: number;
  unitCostCents: number;
  effectiveAt: Date;
  policyId: number | null;
  /** The entry in force for the same vendor and variant; differs from entryId when a later increase overtook this one. */
  inForceEntryId: number;
}

export interface CostActionListing {
  listingId: number;
  storeConnectionId: number;
  productVariantId: number;
  status: string;
  vendorRetailPriceCents: number | null;
  /** The price the listing's last completed push published (buyers see it); null when none is on record. */
  publishedPriceCents: number | null;
  platform: string;
  variantSku: string | null;
  variantName: string;
  productName: string;
}

export interface CostActionSavedPrice {
  storeConnectionId: number;
  productVariantId: number;
  overridePriceCents: number | null;
  pricingMode: ListingPricingMode | null;
}

export interface CostActionCandidate {
  productVariantId: number;
  productId: number;
  category: string | null;
  /** The product's Card Shellz category (`catalog.products.category_id`); null when it has none. */
  categoryId: number | null;
  productLineIds: readonly number[];
  defaultRetailPriceCents: number | null;
}

/** Everything the decision needs about one vendor's listings of the named variants. */
export interface CostActionVendorFacts {
  listings: CostActionListing[];
  savedPrices: CostActionSavedPrice[];
  /** Pricing rules per store connection; absent when the store has none. */
  profiles: Map<number, PricingProfileState>;
  /**
   * The product and category listing settings of the named variants, per
   * store connection with listings (an entry for every such store, empty when
   * it has none). A product's or a category's own price prices a listing by
   * rule even in a store with no pricing rules.
   */
  layersByStore: Map<number, ListingSettingLayers>;
  candidates: Map<number, CostActionCandidate>;
  /** The active Card Shellz price limits, which decide whether an `inherit` listing can use its rule price. */
  pricingPolicies: readonly DropshipPricingPolicyRecord[];
}

export interface NewCostChangeListingHold {
  storeConnectionId: number;
  productVariantId: number;
  listingId: number;
  entryId: number;
  listingPriceCents: number;
  unitCostCents: number;
  holdIdempotencyKey: string;
  heldAt: Date;
}

export interface CostChangeListingActionRecord {
  entryId: number;
  storeConnectionId: number;
  productVariantId: number;
  listingId: number;
  listingStatus: string;
  priceSource: CostChangeListingPriceSource;
  listingPriceCents: number | null;
  unitCostCents: number;
  action: CostChangeListingAction;
  detail: string | null;
  pushJobId: number | null;
  /** The hold placed for this listing, by the key the repository resolves to its row. */
  holdKey: { storeConnectionId: number; productVariantId: number } | null;
  policyId: number | null;
  decidedAt: Date;
}

/**
 * A listing action recorded as skipped_inactive_listing while the listing
 * read queued, failed or blocked, whose listing is active now and whose
 * increase is still the cost in force (listSkippedListingRechecks).
 */
export interface SkippedListingRecheckCandidate {
  actionId: number;
  /** The status the skipped decision recorded. */
  skippedListingStatus: string;
  listingId: number;
  storeConnectionId: number;
  /** The increase the skipped action was decided for; it is the one in force. */
  increase: EffectiveCostIncrease;
}

/** A recheck's decision for one skipped listing action, recorded as its audit row (recordListingRechecks). */
export interface CostChangeListingRecheckRecord {
  actionId: number;
  entryId: number;
  storeConnectionId: number;
  productVariantId: number;
  listingId: number;
  skippedListingStatus: string;
  listingStatus: string;
  priceSource: CostChangeListingPriceSource;
  listingPriceCents: number | null;
  unitCostCents: number;
  action: CostChangeListingAction;
  detail: string | null;
  pushJobId: number | null;
  holdKey: { storeConnectionId: number; productVariantId: number } | null;
  policyId: number | null;
  decidedAt: Date;
}

export interface CostChangeEntryActionRecord {
  entryId: number;
  productVariantId: number;
  listingCount: number;
  actionCounts: Partial<Record<CostChangeListingAction, number>>;
  supersededByEntryId: number | null;
  policyId: number | null;
  decidedAt: Date;
}

export interface ActiveCostChangeListingHold {
  holdId: number;
  vendorId: number;
  storeConnectionId: number;
  productVariantId: number;
  listingId: number;
  entryId: number;
  listingPriceCents: number;
  unitCostCents: number;
  heldAt: Date;
}

/**
 * A pause put back because the hold review had released it only as
 * "listing no longer live" while an earlier queued or failed push had written
 * a non-live status over a listing that stayed live on its marketplace.
 */
export interface RestoredCostChangeListingHold {
  holdId: number;
  releasedHoldId: number;
  vendorId: number;
  storeConnectionId: number;
  productVariantId: number;
  listingId: number;
  entryId: number;
  releasedAt: Date;
  /** The listing's last completed push before the release (published live). */
  basisJobItemId: number;
  /** The newer push item, created before the release, whose queue or failure had made the listing read as not live. */
  demotingJobItemId: number;
}

/** A listing action as the vendor's portal shows it. */
export interface VendorCostChangeListingActionView {
  actionId: number;
  entryId: number;
  listingId: number;
  storeConnectionId: number;
  platform: string;
  productVariantId: number;
  /** The size's product: the portal's link to its price in Listing settings opens on `?product=&size=` (PR 10h, D13b). */
  productId: number;
  variantSku: string | null;
  variantName: string;
  productName: string;
  action: CostChangeListingAction;
  detail: string | null;
  listingPriceCents: number | null;
  unitCostCents: number;
  pushJobId: number | null;
  decidedAt: Date;
  /** For a pause: when and why it was released; null while it holds. */
  holdReleasedAt: Date | null;
  holdReleaseReason: CostChangeHoldReleaseReason | null;
}

/** A listing action as staff see it. */
export interface DropshipCostChangeListingActionView extends VendorCostChangeListingActionView {
  vendorId: number;
  vendorBusinessName: string | null;
  listingStatus: string;
  priceSource: CostChangeListingPriceSource;
  policyId: number | null;
}

export interface DropshipCostChangeListingActionPage {
  items: DropshipCostChangeListingActionView[];
  nextBeforeId: number | null;
  generatedAt: Date;
}

export const listDropshipCostChangeListingActionsInputSchema = z.object({
  limit: z.number().int().min(1).max(COST_LISTING_ACTION_PAGE_LIMIT).optional(),
  beforeId: z.number().int().positive().optional(),
}).strict();

export interface DropshipCostChangeListingActionRepository {
  listVendorListingActions(input: { vendorId: number; since: Date; limit: number }): Promise<VendorCostChangeListingActionView[]>;
  listListingActions(input: { limit: number; beforeId: number | null }): Promise<DropshipCostChangeListingActionView[]>;
  /** Increases in force and not yet acted on, oldest first, grouped by vendor id order. */
  listEffectiveIncreasesWithoutAction(input: { now: Date; limit: number }): Promise<EffectiveCostIncrease[]>;
  loadVendorFacts(input: { vendorId: number; productVariantIds: readonly number[] }): Promise<CostActionVendorFacts>;
  /** One transaction: holds, then listing rows naming them, then the entry rows that mark the increases done. */
  recordEntryActions(input: {
    vendorId: number;
    entries: readonly CostChangeEntryActionRecord[];
    listingActions: readonly CostChangeListingActionRecord[];
    holds: readonly NewCostChangeListingHold[];
  }): Promise<{ entriesRecorded: number; listingActionsRecorded: number; holdsRecorded: number }>;
  listActiveHolds(input: { limit: number }): Promise<ActiveCostChangeListingHold[]>;
  /**
   * Puts back (as a new live hold, with its audit row) a pause released as
   * listing_inactive only because a queued or failed push had demoted a
   * listing that stayed live; the review then judges it like any other hold.
   * Idempotent: a released hold with any later hold for its listing is never
   * restored again.
   */
  restoreHoldsReleasedWhileListingDemoted(input: { now: Date; workerId: string; limit: number }): Promise<RestoredCostChangeListingHold[]>;
  /** Skipped listing actions to judge again (see SkippedListingRecheckCandidate), oldest first per vendor. */
  listSkippedListingRechecks(input: { now: Date; limit: number }): Promise<SkippedListingRecheckCandidate[]>;
  /** One vendor's recheck decisions and the holds they placed, in one transaction; a replay records nothing twice. */
  recordListingRechecks(input: {
    vendorId: number;
    workerId: string;
    rechecks: readonly CostChangeListingRecheckRecord[];
    holds: readonly NewCostChangeListingHold[];
  }): Promise<{ rechecksRecorded: number; holdsRecorded: number }>;
  /** The cost in force per variant (the latest entry in effect and not withdrawn); absent when the variant has no schedule. */
  costInForce(input: { vendorId: number; productVariantIds: readonly number[]; now: Date }): Promise<Map<number, number>>;
  releaseHolds(input: {
    holdIds: readonly number[];
    reason: CostChangeHoldReleaseReason;
    detail: CostChangeHoldReleaseDetail;
    releasedAt: Date;
    releaseIdempotencyKey: string;
  }): Promise<number>;
}

export type CostChangeRepriceOutcome =
  | {
      queued: true;
      jobId: number;
      jobStatus: string;
      idempotentReplay: boolean;
      items: Array<{ productVariantId: number; status: string; errorCode: string | null }>;
    }
  /** The store cannot take a push now (account, membership or store state); the code names why. */
  | { queued: false; code: string; message: string };

export interface DropshipCostChangeRepricePort {
  queueReprice(input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantIds: readonly number[];
    idempotencyKey: string;
    actorId: string;
  }): Promise<CostChangeRepriceOutcome>;
}

/** The SKU hold gate, plus a read of who holds which SKU so a release never takes another actor's hold. */
export interface DropshipCostChangeHoldGate extends DropshipListingVariantHoldGate {
  listHeldVariants(input: { storeConnectionId: number; productVariantIds: readonly number[] }): Promise<Map<number, { heldBy: string }>>;
}

export interface DropshipCostListingActionPassResult {
  vendorsProcessed: number;
  vendorsFailed: number;
  entriesDecided: number;
  entriesSuperseded: number;
  listingsDecided: number;
  actions: Record<CostChangeListingAction, number>;
  repriceJobsQueued: number;
  holdsPlaced: number;
  noticesSent: number;
  /** Increases skipped while a listing read as not live, judged again now that it is live. */
  rechecks: DropshipCostRecheckResult;
  holds: DropshipCostHoldReviewResult;
}

export interface DropshipCostRecheckResult {
  rechecked: number;
  vendorsFailed: number;
  repriceJobsQueued: number;
  holdsPlaced: number;
  noticesSent: number;
}

export interface DropshipCostHoldReviewResult {
  /** Pauses put back before the review because a demoted (still live) listing had released them; reviewed in the same pass. */
  restored: number;
  reviewed: number;
  released: number;
  reasserted: number;
  /** Holds whose command inventory planning refused for now; reviewed again next pass. */
  deferred: number;
  vendorsFailed: number;
  noticesSent: number;
}

export const runDropshipCostListingActionPassInputSchema = z.object({
  workerId: z.string().trim().min(1).max(200),
  entriesPerPass: z.number().int().min(1).max(MAX_COST_LISTING_ACTION_ENTRIES_PER_PASS).optional(),
  holdsPerPass: z.number().int().min(1).max(MAX_COST_LISTING_HOLDS_PER_PASS).optional(),
}).strict();

interface PolicyInForce {
  policyId: number | null;
  settings: DropshipCostChangePolicySettings;
}

interface PendingDecision {
  entry: EffectiveCostIncrease;
  listing: CostActionListing;
  price: CostChangeListingPriceClassification;
  action: CostChangeListingAction;
  detail: string | null;
  pushJobId: number | null;
  hold: NewCostChangeListingHold | null;
  /** Set when the decision re-judges a skipped listing action (the recheck pass). */
  recheck?: SkippedListingRecheckCandidate;
}

/**
 * The idempotency keys of a decision's sends: its reprice push job, its hold
 * command and its notices. A first decision keys them by the increases; a
 * recheck by the skipped actions it re-judges, apart from any first decision.
 */
interface DecisionKeys {
  reprice(storeConnectionId: number, chunk: readonly PendingDecision[]): string;
  hold(storeConnectionId: number, chunk: readonly PendingDecision[], productVariantIds: readonly number[]): string;
  notice(kind: CostChangeListingNoticeKind, rows: readonly PendingDecision[]): string;
}

function firstDecisionKeys(vendorId: number): DecisionKeys {
  return {
    reprice: (storeConnectionId, chunk) => costChangeRepriceIdempotencyKey({
      vendorId, storeConnectionId, entryIds: chunk.map((decision) => decision.entry.entryId),
    }),
    hold: (storeConnectionId, chunk, productVariantIds) => costChangeHoldIdempotencyKey({
      storeConnectionId, entryIds: chunk.map((decision) => decision.entry.entryId), productVariantIds,
    }),
    notice: (kind, rows) => costChangeListingNoticeIdempotencyKey({ vendorId, kind, ids: rows.map((decision) => decision.entry.entryId) }),
  };
}

function recheckDecisionKeys(vendorId: number): DecisionKeys {
  const actionIds = (rows: readonly PendingDecision[]) => rows.map((decision) => recheckOf(decision).actionId);
  return {
    reprice: (storeConnectionId, chunk) => costChangeRecheckRepriceIdempotencyKey({ vendorId, storeConnectionId, actionIds: actionIds(chunk) }),
    hold: (storeConnectionId, chunk, productVariantIds) => costChangeRecheckHoldIdempotencyKey({
      storeConnectionId, actionIds: actionIds(chunk), productVariantIds,
    }),
    notice: (kind, rows) => costChangeListingFollowUpNoticeIdempotencyKey({ vendorId, kind, basis: "recheck", ids: actionIds(rows) }),
  };
}

function recheckOf(decision: PendingDecision): SkippedListingRecheckCandidate {
  if (!decision.recheck) {
    throw new DropshipError("DROPSHIP_COST_CHANGE_RECHECK_MISSING", "A recheck decision lost the skipped action it re-judges.",
      { classification: "fatal", listingId: decision.listing.listingId, entryId: decision.entry.entryId });
  }
  return decision.recheck;
}

export class DropshipCostChangeListingActionService {
  constructor(
    private readonly deps: {
      repository: DropshipCostChangeListingActionRepository;
      policy: DropshipCostChangePolicyReader;
      reprice: DropshipCostChangeRepricePort;
      holdGate?: DropshipCostChangeHoldGate;
      notificationSender?: DropshipNotificationSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async runListingActionPass(input: unknown): Promise<DropshipCostListingActionPassResult> {
    const parsed = parseInput(runDropshipCostListingActionPassInputSchema, input);
    const policy = await this.deps.policy.resolvePolicy();
    const now = this.deps.clock.now();
    const result = emptyPassResult();
    // First, so a listing the live status repair restored is judged in the
    // first pass after it (it takes orders again from that repair on).
    result.rechecks = await this.recheckSkippedListings({
      now, workerId: parsed.workerId, policy, limit: parsed.entriesPerPass ?? DEFAULT_COST_LISTING_ACTION_ENTRIES_PER_PASS,
    });
    const entries = await this.deps.repository.listEffectiveIncreasesWithoutAction({
      now, limit: parsed.entriesPerPass ?? DEFAULT_COST_LISTING_ACTION_ENTRIES_PER_PASS,
    });
    for (const [vendorId, vendorEntries] of groupByVendor(entries)) {
      try {
        const outcome = await this.processVendor(vendorId, vendorEntries, policy, now);
        result.vendorsProcessed += 1;
        result.entriesDecided += outcome.entriesDecided;
        result.entriesSuperseded += outcome.entriesSuperseded;
        result.listingsDecided += outcome.listingsDecided;
        result.repriceJobsQueued += outcome.repriceJobsQueued;
        result.holdsPlaced += outcome.holdsPlaced;
        result.noticesSent += outcome.noticesSent;
        for (const action of costChangeListingActionValues) result.actions[action] += outcome.actions[action];
      } catch (error) {
        // Nothing was recorded for the vendor; its increases are picked up again next pass.
        result.vendorsFailed += 1;
        this.deps.logger.warn({
          code: "DROPSHIP_COST_CHANGE_LISTING_ACTION_VENDOR_FAILED",
          message: "A vendor's cost change listing actions could not be applied; they are retried on the next pass.",
          context: {
            action: "cost_change_listing_actions", outcome: "failed", classification: classificationOf(error), workerId: parsed.workerId,
            vendorId, entryIds: vendorEntries.map((entry) => entry.entryId),
            error: error instanceof Error ? error.message : String(error),
            errorCode: error instanceof DropshipError ? error.code : null,
          },
        });
      }
    }
    result.holds = await this.reviewHolds({ limit: parsed.holdsPerPass ?? DEFAULT_COST_LISTING_HOLDS_PER_PASS, now, workerId: parsed.workerId });
    if (result.vendorsProcessed > 0 || result.vendorsFailed > 0 || result.holds.reviewed > 0 || result.holds.vendorsFailed > 0
      || result.rechecks.rechecked > 0 || result.rechecks.vendorsFailed > 0) {
      this.deps.logger.info({
        code: "DROPSHIP_COST_CHANGE_LISTING_ACTION_PASS_COMPLETED",
        message: "Dropship cost change listing action pass completed.",
        context: { action: "cost_change_listing_actions", outcome: "completed", workerId: parsed.workerId, policyId: policy.policyId, ...result },
      });
    }
    return result;
  }

  async listListingActions(input: unknown): Promise<DropshipCostChangeListingActionPage> {
    const parsed = parseInput(listDropshipCostChangeListingActionsInputSchema, input);
    const limit = parsed.limit ?? COST_LISTING_ACTION_PAGE_LIMIT;
    // One more than the page says whether a next page exists, without a count.
    const rows = await this.deps.repository.listListingActions({ limit: limit + 1, beforeId: parsed.beforeId ?? null });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextBeforeId: rows.length > limit && last ? last.actionId : null, generatedAt: this.deps.clock.now() };
  }

  private async processVendor(
    vendorId: number,
    entries: readonly EffectiveCostIncrease[],
    policy: PolicyInForce,
    now: Date,
  ): Promise<Omit<DropshipCostListingActionPassResult, "vendorsProcessed" | "vendorsFailed" | "holds" | "rechecks">> {
    const superseded = entries.filter((entry) => entry.inForceEntryId !== entry.entryId);
    const live = entries.filter((entry) => entry.inForceEntryId === entry.entryId);
    const facts = live.length > 0
      ? await this.deps.repository.loadVendorFacts({ vendorId, productVariantIds: unique(live.map((entry) => entry.productVariantId)) })
      : emptyFacts();
    const storeConnectionIds = unique(facts.listings.map((listing) => listing.storeConnectionId));
    if (storeConnectionIds.length > MAX_STORE_CONNECTIONS_PER_VENDOR) {
      throw new DropshipError("DROPSHIP_COST_CHANGE_STORE_COUNT_INVALID",
        "A vendor has more store connections than cost change listing actions can address in one pass.",
        { classification: "permanent", vendorId, storeConnectionCount: storeConnectionIds.length });
    }

    const decisions: PendingDecision[] = [];
    for (const entry of live) {
      for (const listing of facts.listings.filter((candidate) => candidate.productVariantId === entry.productVariantId)) {
        const price = judgedListingPrice(facts, listing, entry.unitCostCents);
        const action = decideCostChangeListingAction({
          listingStatus: listing.status, price, unitCostCents: entry.unitCostCents, settings: policy.settings,
        });
        decisions.push({ entry, listing, price, action, detail: null, pushJobId: null, hold: null });
      }
    }

    const keys = firstDecisionKeys(vendorId);
    const repriceJobsQueued = await this.queueReprices(vendorId, decisions.filter((decision) => decision.action === "reprice_queued"), keys);
    const holdsPlaced = await this.placeHolds(decisions.filter((decision) => decision.action === "below_cost_paused"), now, keys);
    const noticesSent = await this.notifyVendor(vendorId, decisions, policy, keys);

    const decidedAt = now;
    const entryRecords: CostChangeEntryActionRecord[] = [
      ...superseded.map((entry) => ({
        entryId: entry.entryId, productVariantId: entry.productVariantId, listingCount: 0, actionCounts: {},
        supersededByEntryId: entry.inForceEntryId, policyId: policy.policyId, decidedAt,
      })),
      ...live.map((entry) => {
        const own = decisions.filter((decision) => decision.entry.entryId === entry.entryId);
        return {
          entryId: entry.entryId, productVariantId: entry.productVariantId, listingCount: own.length,
          actionCounts: countActions(own), supersededByEntryId: null, policyId: policy.policyId, decidedAt,
        };
      }),
    ];
    const listingActions: CostChangeListingActionRecord[] = decisions.map((decision) => ({
      entryId: decision.entry.entryId, storeConnectionId: decision.listing.storeConnectionId, productVariantId: decision.listing.productVariantId,
      listingId: decision.listing.listingId, listingStatus: decision.listing.status, priceSource: decision.price.source,
      listingPriceCents: decision.price.priceCents, unitCostCents: decision.entry.unitCostCents, action: decision.action, detail: decision.detail,
      pushJobId: decision.pushJobId,
      holdKey: decision.hold ? { storeConnectionId: decision.hold.storeConnectionId, productVariantId: decision.hold.productVariantId } : null,
      policyId: policy.policyId, decidedAt,
    }));
    await this.deps.repository.recordEntryActions({
      vendorId, entries: entryRecords, listingActions,
      holds: decisions.flatMap((decision) => (decision.hold ? [decision.hold] : [])),
    });

    const actions = emptyActionCounts();
    for (const decision of decisions) actions[decision.action] += 1;
    return {
      entriesDecided: live.length, entriesSuperseded: superseded.length, listingsDecided: decisions.length, actions,
      repriceJobsQueued, holdsPlaced, noticesSent,
    };
  }

  /** One system push job per store connection and chunk of increases; a store that cannot take a push turns the chunk into refusals. */
  private async queueReprices(vendorId: number, decisions: PendingDecision[], keys: DecisionKeys): Promise<number> {
    let jobs = 0;
    for (const [storeConnectionId, storeDecisions] of groupBy(decisions, (decision) => decision.listing.storeConnectionId)) {
      for (const chunk of chunked(storeDecisions, COST_REPRICE_VARIANTS_PER_JOB)) {
        const outcome = await this.deps.reprice.queueReprice({
          vendorId, storeConnectionId,
          productVariantIds: unique(chunk.map((decision) => decision.listing.productVariantId)),
          idempotencyKey: keys.reprice(storeConnectionId, chunk),
          actorId: COST_CHANGE_PUSH_ACTOR_ID,
        });
        if (!outcome.queued) {
          for (const decision of chunk) {
            decision.action = "reprice_refused";
            decision.detail = outcome.code;
          }
          this.deps.logger.info({
            code: "DROPSHIP_COST_CHANGE_REPRICE_REFUSED",
            message: "A store cannot take a reprice push now; the listings are recorded as refused.",
            context: { action: "cost_change_reprice", outcome: "refused", vendorId, storeConnectionId, code: outcome.code, listings: chunk.length },
          });
          continue;
        }
        jobs += outcome.idempotentReplay ? 0 : 1;
        for (const decision of chunk) decision.pushJobId = outcome.jobId;
      }
    }
    return jobs;
  }

  /** Pause through the inventory-planning SKU hold, chunked to its command size; a refusal for now retries the whole vendor next pass. */
  private async placeHolds(decisions: PendingDecision[], now: Date, keys: DecisionKeys): Promise<number> {
    if (decisions.length === 0) return 0;
    const gate = this.deps.holdGate;
    if (!gate) {
      throw new DropshipError("DROPSHIP_COST_CHANGE_HOLD_GATE_MISSING", "No publication hold gate is configured for cost change pauses.",
        { classification: "fatal" });
    }
    let placed = 0;
    for (const [storeConnectionId, storeDecisions] of groupBy(decisions, (decision) => decision.listing.storeConnectionId)) {
      for (const chunk of chunked(storeDecisions, gate.maxVariantsPerCommand)) {
        const productVariantIds = unique(chunk.map((decision) => decision.listing.productVariantId));
        const idempotencyKey = keys.hold(storeConnectionId, chunk, productVariantIds);
        const outcome = await gate.holdVariants({ storeConnectionId, productVariantIds, reason: COST_CHANGE_HOLD_REASON, idempotencyKey });
        if (!outcome.applied) {
          throw new DropshipError("DROPSHIP_COST_CHANGE_HOLD_DEFERRED", "Inventory planning deferred a cost change pause; the vendor is retried next pass.",
            { classification: "transient", storeConnectionId, code: outcome.code, detail: outcome.message });
        }
        for (const decision of chunk) {
          if (decision.price.priceCents === null) continue;
          decision.hold = {
            storeConnectionId, productVariantId: decision.listing.productVariantId, listingId: decision.listing.listingId,
            entryId: decision.entry.entryId, listingPriceCents: decision.price.priceCents, unitCostCents: decision.entry.unitCostCents,
            holdIdempotencyKey: idempotencyKey, heldAt: now,
          };
          placed += 1;
        }
      }
    }
    return placed;
  }

  /** One notice per kind the pass produced, under a key of the increases involved; nothing goes when the policy sends on no channel. */
  private async notifyVendor(vendorId: number, decisions: readonly PendingDecision[], policy: PolicyInForce, keys: DecisionKeys): Promise<number> {
    const channels = costChangeNoticeChannels(policy.settings);
    if (channels.length === 0) return 0;
    const kinds: Array<[CostChangeListingNoticeKind, CostChangeListingAction]> = [
      ["repriced", "reprice_queued"], ["review_needed", "awaiting_review"], ["below_cost", "below_cost_warned"], ["paused", "below_cost_paused"],
    ];
    let sent = 0;
    for (const [kind, action] of kinds) {
      const rows = decisions.filter((decision) => decision.action === action);
      if (rows.length === 0) continue;
      const notice = buildCostChangeListingNotice({
        kind,
        listings: rows.map((decision) => ({
          listing: decision.listing, listingPriceCents: decision.price.priceCents, unitCostCents: decision.entry.unitCostCents,
        })),
      });
      await this.send({
        vendorId, kind, notice, channels,
        idempotencyKey: keys.notice(kind, rows),
        payload: {
          entryIds: unique(rows.map((decision) => decision.entry.entryId)), policyId: policy.policyId,
          ...(rows.some((decision) => decision.recheck) ? { recheckedActionIds: unique(rows.map((decision) => recheckOf(decision).actionId)) } : {}),
        },
      });
      sent += 1;
    }
    return sent;
  }

  private async send(input: {
    vendorId: number;
    kind: CostChangeListingNoticeKind;
    notice: { title: string; message: string; payload: Record<string, unknown> };
    channels: ReturnType<typeof costChangeNoticeChannels>;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.deps.notificationSender) {
      // No sender is wired: the pass must not go on as if the vendor were told.
      throw new DropshipError("DROPSHIP_COST_CHANGE_NOTICE_SENDER_MISSING", "No notification sender is configured for cost change listing notices.",
        { classification: "fatal", vendorId: input.vendorId });
    }
    await this.deps.notificationSender.send({
      vendorId: input.vendorId,
      eventType: listingNoticeEventTypeFor(input.kind),
      critical: false,
      channels: input.channels,
      title: input.notice.title,
      message: input.notice.message,
      payload: { ...input.notice.payload, ...input.payload },
      idempotencyKey: input.idempotencyKey,
    });
  }

  /**
   * Live pauses: release those whose price covers the cost in force or whose
   * listing is no longer live, never taking a hold another actor owns; and
   * re-assert a hold of ours that inventory planning no longer carries.
   */
  private async reviewHolds(input: { limit: number; now: Date; workerId: string }): Promise<DropshipCostHoldReviewResult> {
    const result: DropshipCostHoldReviewResult = { restored: 0, reviewed: 0, released: 0, reasserted: 0, deferred: 0, vendorsFailed: 0, noticesSent: 0 };
    const restoredHoldIds = await this.restoreHoldsReleasedWhileListingDemoted(input);
    result.restored = restoredHoldIds.size;
    const holds = await this.deps.repository.listActiveHolds({ limit: input.limit });
    if (holds.length === 0) return result;
    const gate = this.deps.holdGate;
    if (!gate) {
      throw new DropshipError("DROPSHIP_COST_CHANGE_HOLD_GATE_MISSING", "No publication hold gate is configured for cost change pauses.",
        { classification: "fatal" });
    }
    const policy = await this.deps.policy.resolvePolicy();
    for (const [vendorId, vendorHolds] of groupBy(holds, (hold) => hold.vendorId)) {
      try {
        const outcome = await this.reviewVendorHolds(vendorId, vendorHolds, gate, policy, input.now, restoredHoldIds);
        result.reviewed += vendorHolds.length;
        result.released += outcome.released;
        result.reasserted += outcome.reasserted;
        result.deferred += outcome.deferred;
        result.noticesSent += outcome.noticesSent;
      } catch (error) {
        result.vendorsFailed += 1;
        this.deps.logger.warn({
          code: "DROPSHIP_COST_CHANGE_HOLD_REVIEW_FAILED",
          message: "A vendor's cost change pauses could not be reviewed; they are reviewed again on the next pass.",
          context: {
            action: "cost_change_hold_review", outcome: "failed", classification: classificationOf(error), workerId: input.workerId, vendorId,
            holdIds: vendorHolds.map((hold) => hold.holdId),
            error: error instanceof Error ? error.message : String(error),
            errorCode: error instanceof DropshipError ? error.code : null,
          },
        });
      }
    }
    return result;
  }

  /**
   * Before the review: pauses the review released while an earlier push had
   * made a still-live listing read as not live are put back, so the review
   * below judges them on the facts in force now (release if the price covers
   * the cost, otherwise re-assert the hold at inventory planning). A failure
   * here is logged and retried next pass; the review still runs.
   */
  private async restoreHoldsReleasedWhileListingDemoted(input: { limit: number; now: Date; workerId: string }): Promise<ReadonlySet<number>> {
    try {
      const restored = await this.deps.repository.restoreHoldsReleasedWhileListingDemoted({
        now: input.now, workerId: input.workerId, limit: input.limit,
      });
      for (const hold of restored) {
        // WARN: an anomaly an earlier push left behind, recovered automatically.
        this.deps.logger.warn({
          code: "DROPSHIP_COST_CHANGE_HOLD_RESTORED",
          message: "A below-cost pause released while an earlier push made a live listing read as not live was put back for review.",
          context: {
            action: "cost_change_hold_restore", outcome: "restored", workerId: input.workerId,
            vendorId: hold.vendorId, storeConnectionId: hold.storeConnectionId, productVariantId: hold.productVariantId,
            listingId: hold.listingId, entryId: hold.entryId, holdId: hold.holdId, releasedHoldId: hold.releasedHoldId,
            releasedAt: hold.releasedAt.toISOString(), basisJobItemId: hold.basisJobItemId, demotingJobItemId: hold.demotingJobItemId,
            before: { holdId: null }, after: { holdId: hold.holdId },
          },
        });
      }
      return new Set(restored.map((hold) => hold.holdId));
    } catch (error) {
      this.deps.logger.error({
        code: "DROPSHIP_COST_CHANGE_HOLD_RESTORE_FAILED",
        message: "Pauses released while a live listing read as not live could not be put back; tried again on the next pass.",
        context: {
          action: "cost_change_hold_restore", outcome: "failed", classification: classificationOf(error), workerId: input.workerId,
          error: error instanceof Error ? error.message : String(error),
          errorCode: error instanceof DropshipError ? error.code : null,
        },
      });
      return new Set();
    }
  }

  private async reviewVendorHolds(
    vendorId: number,
    holds: readonly ActiveCostChangeListingHold[],
    gate: DropshipCostChangeHoldGate,
    policy: PolicyInForce,
    now: Date,
    restoredHoldIds: ReadonlySet<number>,
  ): Promise<{ released: number; reasserted: number; deferred: number; noticesSent: number }> {
    const productVariantIds = unique(holds.map((hold) => hold.productVariantId));
    const [facts, costs] = await Promise.all([
      this.deps.repository.loadVendorFacts({ vendorId, productVariantIds }),
      this.deps.repository.costInForce({ vendorId, productVariantIds, now }),
    ]);
    let released = 0;
    let reasserted = 0;
    let deferred = 0;
    const resumed: Array<{ listing: CostActionListing; listingPriceCents: number | null; unitCostCents: number }> = [];
    const resumedHoldIds: number[] = [];
    // Put back this pass and kept: the vendor is told the listing is paused again.
    const repaused: Array<{ listing: CostActionListing; listingPriceCents: number | null; unitCostCents: number }> = [];
    const repausedHoldIds: number[] = [];

    for (const [storeConnectionId, storeHolds] of groupBy(holds, (hold) => hold.storeConnectionId)) {
      const heldNow = await gate.listHeldVariants({ storeConnectionId, productVariantIds: unique(storeHolds.map((hold) => hold.productVariantId)) });
      const releases = new Map<CostChangeHoldReleaseReason, Map<CostChangeHoldReleaseDetail, ActiveCostChangeListingHold[]>>();
      const keep: ActiveCostChangeListingHold[] = [];
      for (const hold of storeHolds) {
        const listing = facts.listings.find((candidate) => candidate.listingId === hold.listingId) ?? null;
        const costInForce = costs.get(hold.productVariantId) ?? null;
        const price = listing && costInForce !== null ? classifyListing(facts, listing, costInForce) : null;
        // Released for its price only once the price buyers see covers the cost: the settings price
        // and the price the last completed push published (a queued or failed raise is not on eBay).
        const reason = decideCostChangeHoldRelease({
          listingStatus: listing?.status ?? "not_listed", priceCents: price?.priceCents ?? null,
          publishedPriceCents: listing?.publishedPriceCents ?? null, costInForceCents: costInForce,
        });
        if (!reason) {
          keep.push(hold);
          if (restoredHoldIds.has(hold.holdId) && listing) {
            repaused.push({ listing, listingPriceCents: judgedPriceCents(price, listing) ?? hold.listingPriceCents, unitCostCents: costInForce ?? hold.unitCostCents });
            repausedHoldIds.push(hold.holdId);
          }
          continue;
        }
        const holder = heldNow.get(hold.productVariantId)?.heldBy ?? null;
        const detail: CostChangeHoldReleaseDetail = holder === null ? "not_held" : holder === COST_CHANGE_HOLD_ACTOR_ID ? "released" : "held_by_other";
        const byDetail = releases.get(reason) ?? new Map<CostChangeHoldReleaseDetail, ActiveCostChangeListingHold[]>();
        byDetail.set(detail, [...(byDetail.get(detail) ?? []), hold]);
        releases.set(reason, byDetail);
        if (reason === "price_covers_cost" && listing) {
          // Listed at what buyers see: the published price (both prices cover the cost).
          resumed.push({ listing, listingPriceCents: listing.publishedPriceCents, unitCostCents: costInForce ?? hold.unitCostCents });
          resumedHoldIds.push(hold.holdId);
        }
      }

      for (const [reason, byDetail] of releases) {
        for (const [detail, group] of byDetail) {
          for (const chunk of chunked(group, gate.maxVariantsPerCommand)) {
            const holdIds = chunk.map((hold) => hold.holdId);
            const releaseIdempotencyKey = costChangeReleaseIdempotencyKey({ storeConnectionId, holdIds });
            if (detail === "released") {
              const outcome = await gate.releaseVariants({
                storeConnectionId, productVariantIds: unique(chunk.map((hold) => hold.productVariantId)),
                reason: `Dropship cost change: ${reason === "price_covers_cost" ? "price covers the .ops cost again" : "listing no longer live"}`,
                idempotencyKey: releaseIdempotencyKey,
              });
              if (!outcome.applied) {
                deferred += chunk.length;
                continue;
              }
            }
            released += await this.deps.repository.releaseHolds({ holdIds, reason, detail, releasedAt: now, releaseIdempotencyKey });
          }
        }
      }

      // A hold of ours that inventory planning no longer carries (a tier release deleted it) is put back.
      const missing = keep.filter((hold) => !heldNow.has(hold.productVariantId));
      for (const chunk of chunked(missing, gate.maxVariantsPerCommand)) {
        const outcome = await gate.holdVariants({
          storeConnectionId, productVariantIds: unique(chunk.map((hold) => hold.productVariantId)), reason: COST_CHANGE_HOLD_REASON,
          // Re-asserting is idempotent in effect, so the key only has to be new per pass.
          idempotencyKey: `dropship-cost-change-hold:${storeConnectionId}:reassert:${idSetHash(chunk.map((hold) => hold.holdId))}:${now.toISOString()}`,
        });
        if (!outcome.applied) {
          deferred += chunk.length;
          continue;
        }
        reasserted += chunk.length;
      }
    }

    let noticesSent = 0;
    const channels = costChangeNoticeChannels(policy.settings);
    if (resumed.length > 0 && channels.length > 0) {
      await this.send({
        vendorId, kind: "resumed", notice: buildCostChangeListingNotice({ kind: "resumed", listings: resumed }), channels,
        idempotencyKey: costChangeListingNoticeIdempotencyKey({ vendorId, kind: "resumed", ids: resumedHoldIds }),
        payload: { holdIds: resumedHoldIds, policyId: policy.policyId },
      });
      noticesSent += 1;
    }
    if (repaused.length > 0 && channels.length > 0) {
      await this.send({
        vendorId, kind: "paused", notice: buildCostChangeListingNotice({ kind: "paused", listings: repaused }), channels,
        idempotencyKey: costChangeListingFollowUpNoticeIdempotencyKey({ vendorId, kind: "paused", basis: "restored_hold", ids: repausedHoldIds }),
        payload: { holdIds: repausedHoldIds, policyId: policy.policyId },
      });
      noticesSent += 1;
    }
    return { released, reasserted, deferred, noticesSent };
  }

  /**
   * Judges once, on the facts in force, each increase recorded as skipped
   * because the listing read queued, failed or blocked, now that the listing
   * is active (listSkippedListingRechecks). It goes through the same paths
   * as a first decision (reprice push job, inventory-planning hold, notices),
   * keyed by the skipped actions so a replay reuses them, and records each
   * decision with the holds it placed in one transaction. Whatever made the
   * listing read as not live then (before the live status fix, mostly an
   * update queued or failed over a listing that stayed live), it sells now
   * and the increase was never judged against it. A vendor that fails is
   * retried next pass; nothing was recorded for it.
   */
  private async recheckSkippedListings(input: { now: Date; workerId: string; policy: PolicyInForce; limit: number }): Promise<DropshipCostRecheckResult> {
    const result: DropshipCostRecheckResult = { rechecked: 0, vendorsFailed: 0, repriceJobsQueued: 0, holdsPlaced: 0, noticesSent: 0 };
    const candidates = await this.deps.repository.listSkippedListingRechecks({ now: input.now, limit: input.limit });
    for (const [vendorId, vendorCandidates] of groupBy(candidates, (candidate) => candidate.increase.vendorId)) {
      try {
        const outcome = await this.recheckVendor(vendorId, vendorCandidates, input);
        result.rechecked += outcome.rechecked;
        result.repriceJobsQueued += outcome.repriceJobsQueued;
        result.holdsPlaced += outcome.holdsPlaced;
        result.noticesSent += outcome.noticesSent;
      } catch (error) {
        result.vendorsFailed += 1;
        this.deps.logger.warn({
          code: "DROPSHIP_COST_CHANGE_RECHECK_VENDOR_FAILED",
          message: "A vendor's skipped cost change listing actions could not be judged again; they are retried on the next pass.",
          context: {
            action: "cost_change_listing_recheck", outcome: "failed", classification: classificationOf(error), workerId: input.workerId,
            vendorId, actionIds: vendorCandidates.map((candidate) => candidate.actionId),
            error: error instanceof Error ? error.message : String(error),
            errorCode: error instanceof DropshipError ? error.code : null,
          },
        });
      }
    }
    return result;
  }

  private async recheckVendor(
    vendorId: number,
    candidates: readonly SkippedListingRecheckCandidate[],
    input: { now: Date; workerId: string; policy: PolicyInForce },
  ): Promise<Omit<DropshipCostRecheckResult, "vendorsFailed">> {
    const facts = await this.deps.repository.loadVendorFacts({
      vendorId, productVariantIds: unique(candidates.map((candidate) => candidate.increase.productVariantId)),
    });
    const decisions: PendingDecision[] = [];
    for (const candidate of candidates) {
      const listing = facts.listings.find((row) => row.listingId === candidate.listingId);
      // Selected while active; one that changed since is judged once it is live again.
      if (!listing || !COST_ACTIONABLE_LISTING_STATUSES.includes(listing.status)) continue;
      const price = judgedListingPrice(facts, listing, candidate.increase.unitCostCents);
      const action = decideCostChangeListingAction({
        listingStatus: listing.status, price, unitCostCents: candidate.increase.unitCostCents, settings: input.policy.settings,
      });
      decisions.push({ entry: candidate.increase, listing, price, action, detail: null, pushJobId: null, hold: null, recheck: candidate });
    }
    if (decisions.length === 0) return { rechecked: 0, repriceJobsQueued: 0, holdsPlaced: 0, noticesSent: 0 };

    const keys = recheckDecisionKeys(vendorId);
    const repriceJobsQueued = await this.queueReprices(vendorId, decisions.filter((decision) => decision.action === "reprice_queued"), keys);
    const holdsPlaced = await this.placeHolds(decisions.filter((decision) => decision.action === "below_cost_paused"), input.now, keys);
    const noticesSent = await this.notifyVendor(vendorId, decisions, input.policy, keys);
    const recorded = await this.deps.repository.recordListingRechecks({
      vendorId,
      workerId: input.workerId,
      rechecks: decisions.map((decision): CostChangeListingRecheckRecord => ({
        actionId: recheckOf(decision).actionId, entryId: decision.entry.entryId, storeConnectionId: decision.listing.storeConnectionId,
        productVariantId: decision.listing.productVariantId, listingId: decision.listing.listingId,
        skippedListingStatus: recheckOf(decision).skippedListingStatus, listingStatus: decision.listing.status,
        priceSource: decision.price.source, listingPriceCents: decision.price.priceCents, unitCostCents: decision.entry.unitCostCents,
        action: decision.action, detail: decision.detail, pushJobId: decision.pushJobId,
        holdKey: decision.hold ? { storeConnectionId: decision.hold.storeConnectionId, productVariantId: decision.hold.productVariantId } : null,
        policyId: input.policy.policyId, decidedAt: input.now,
      })),
      holds: decisions.flatMap((decision) => (decision.hold ? [decision.hold] : [])),
    });
    for (const decision of decisions) {
      // WARN: a decision an earlier push's demotion had skipped, made now automatically.
      this.deps.logger.warn({
        code: "DROPSHIP_COST_CHANGE_LISTING_RECHECKED",
        message: "A cost increase skipped while the listing read as not live was judged again now that the listing is live.",
        context: {
          action: "cost_change_listing_recheck", outcome: decision.action, workerId: input.workerId, vendorId,
          storeConnectionId: decision.listing.storeConnectionId, listingId: decision.listing.listingId,
          productVariantId: decision.listing.productVariantId, entryId: decision.entry.entryId, actionId: recheckOf(decision).actionId,
          pushJobId: decision.pushJobId, listingPriceCents: decision.price.priceCents, unitCostCents: decision.entry.unitCostCents,
          before: { action: "skipped_inactive_listing", listingStatus: recheckOf(decision).skippedListingStatus },
          after: { action: decision.action, listingStatus: decision.listing.status },
        },
      });
    }
    return { rechecked: recorded.rechecksRecorded, repriceJobsQueued, holdsPlaced, noticesSent };
  }
}

/**
 * The price a live listing is judged at: its settings price (classifyListing)
 * held against the price its last completed push published
 * (judgeAgainstPublishedPrice).
 */
export function judgedListingPrice(facts: CostActionVendorFacts, listing: CostActionListing, costCents: number): CostChangeListingPriceClassification {
  return judgeAgainstPublishedPrice(classifyListing(facts, listing, costCents), listing.publishedPriceCents);
}

/** The lower of a settings price and the published one, for a notice; null when the settings price is unknown. */
function judgedPriceCents(price: CostChangeListingPriceClassification | null, listing: CostActionListing): number | null {
  if (!price || price.priceCents === null) return null;
  return listing.publishedPriceCents === null ? price.priceCents : Math.min(price.priceCents, listing.publishedPriceCents);
}

/** The listing's price as the preview would resolve it, with the rule price computed at the cost being judged. */
export function classifyListing(facts: CostActionVendorFacts, listing: CostActionListing, costCents: number): CostChangeListingPriceClassification {
  const saved = facts.savedPrices.find((candidate) =>
    candidate.storeConnectionId === listing.storeConnectionId && candidate.productVariantId === listing.productVariantId) ?? null;
  const candidate = facts.candidates.get(listing.productVariantId) ?? null;
  // The shared resolver the listing preview prices through, at the cost being judged, checked against the same limits.
  const resolver = createRulePriceResolver(rulePriceContextOf(
    facts.profiles.get(listing.storeConnectionId) ?? NO_PRICING_PROFILE_STATE,
    facts.layersByStore.get(listing.storeConnectionId) ?? EMPTY_LISTING_SETTING_LAYERS,
  ));
  const rulePrice = candidate && resolver.covers(candidate)
    ? withRulePriceLimitCheck(candidate, facts.pricingPolicies, resolver.priceAtCost(candidate, costCents))
    : null;
  return classifyCostChangeListingPrice({
    saved: saved ? { overridePriceCents: saved.overridePriceCents, pricingMode: saved.pricingMode ?? undefined } : null,
    existingListingPriceCents: listing.vendorRetailPriceCents,
    defaultPriceCents: candidate?.defaultRetailPriceCents ?? null,
    rulePrice: rulePrice ? { priceCents: rulePrice.priceCents, basis: rulePrice.basis, blockedByLimit: rulePrice.blockedByLimit } : null,
  });
}

export function listingNoticeEventTypeFor(kind: CostChangeListingNoticeKind): string {
  switch (kind) {
    case "repriced":
      return DROPSHIP_NOTIFICATION_EVENTS.COST_CHANGE_LISTINGS_REPRICED;
    case "review_needed":
      return DROPSHIP_NOTIFICATION_EVENTS.COST_CHANGE_LISTINGS_REVIEW_NEEDED;
    case "below_cost":
      return DROPSHIP_NOTIFICATION_EVENTS.COST_CHANGE_LISTINGS_BELOW_COST;
    case "paused":
      return DROPSHIP_NOTIFICATION_EVENTS.COST_CHANGE_LISTINGS_PAUSED;
    case "resumed":
      return DROPSHIP_NOTIFICATION_EVENTS.COST_CHANGE_LISTINGS_RESUMED;
  }
}

/** The words of one listing notice. Pure. */
export function buildCostChangeListingNotice(input: {
  kind: CostChangeListingNoticeKind;
  listings: ReadonlyArray<{ listing: CostActionListing; listingPriceCents: number | null; unitCostCents: number }>;
}): { title: string; message: string; payload: Record<string, unknown> } {
  const rows = [...input.listings].sort((left, right) => left.listing.listingId - right.listing.listingId);
  if (rows.length === 0) throw new RangeError("A listing notice needs at least one listing.");
  const count = rows.length;
  const plural = count === 1 ? "" : "s";
  const money = (cents: number) => formatNotificationCurrency(cents, COST_LISTING_CURRENCY);
  const label = (row: (typeof rows)[number]) => `${row.listing.variantSku?.trim() || row.listing.variantName} (${row.listing.productName})`;
  const listedAt = (row: (typeof rows)[number]) => (row.listingPriceCents === null ? "no price" : `listed at ${money(row.listingPriceCents)}`);
  let title: string;
  let lead: string;
  let line: (row: (typeof rows)[number]) => string;
  let closing: string;
  switch (input.kind) {
    case "repriced":
      title = `${count} listing${plural} repriced for a new .ops cost`;
      lead = `The .ops cost of ${count === 1 ? "this listing" : `these ${count} listings`} went up, and your pricing rules set the new price:`;
      line = (row) => `- ${label(row)}: cost now ${money(row.unitCostCents)}`;
      closing = "The new prices are queued to your store; the push result shows on the Catalog page.";
      break;
    case "review_needed":
      title = `${count} listing${plural} need${count === 1 ? "s" : ""} a price review`;
      lead = `The .ops cost of ${count === 1 ? "this listing" : `these ${count} listings`} went up. Your listing price is unchanged until you review it:`;
      line = (row) => `- ${label(row)}: cost now ${money(row.unitCostCents)}, ${listedAt(row)}`;
      closing = "Queue these listings from the Catalog page to publish the price your pricing rules now give.";
      break;
    case "below_cost":
      title = `${count} listing${plural} priced under the new .ops cost`;
      lead = `${count === 1 ? "This listing sells" : `These ${count} listings sell`} for less than the .ops cost now charged on each order:`;
      line = (row) => `- ${label(row)}: ${listedAt(row)}, cost now ${money(row.unitCostCents)}`;
      closing = "Raise the price on the Catalog page, or each sale is a loss.";
      break;
    case "paused":
      title = `${count} listing${plural} paused: priced under the .ops cost`;
      lead = `${count === 1 ? "This listing publishes" : `These ${count} listings publish`} zero quantity until the price covers the .ops cost:`;
      line = (row) => `- ${label(row)}: ${listedAt(row)}, cost now ${money(row.unitCostCents)}`;
      closing = "Raise the price on the Catalog page to resume selling.";
      break;
    case "resumed":
      title = `${count} paused listing${plural} selling again`;
      lead = `The price now covers the .ops cost, so the quantity is restored for:`;
      line = (row) => `- ${label(row)}: ${listedAt(row)}, cost ${money(row.unitCostCents)}`;
      closing = "Nothing more to do.";
      break;
  }
  const listed = rows.slice(0, COST_LISTING_NOTICE_LISTED).map(line);
  const remainder = count > COST_LISTING_NOTICE_LISTED ? [`- and ${(count - COST_LISTING_NOTICE_LISTED).toLocaleString("en-US")} more`] : [];
  return {
    title,
    message: [lead, ...listed, ...remainder, "", closing].join("\n"),
    payload: {
      kind: input.kind,
      listingCount: count,
      listings: rows.slice(0, COST_LISTING_NOTICE_PAYLOAD_LISTINGS).map((row) => ({
        listingId: row.listing.listingId, storeConnectionId: row.listing.storeConnectionId, productVariantId: row.listing.productVariantId,
        variantSku: row.listing.variantSku, variantName: row.listing.variantName, productName: row.listing.productName,
        listingPriceCents: row.listingPriceCents, unitCostCents: row.unitCostCents,
      })),
    },
  };
}

export function emptyActionCounts(): Record<CostChangeListingAction, number> {
  return Object.fromEntries(costChangeListingActionValues.map((action) => [action, 0])) as Record<CostChangeListingAction, number>;
}

function countActions(decisions: readonly PendingDecision[]): Partial<Record<CostChangeListingAction, number>> {
  const counts: Partial<Record<CostChangeListingAction, number>> = {};
  for (const decision of decisions) counts[decision.action] = (counts[decision.action] ?? 0) + 1;
  return counts;
}

function emptyPassResult(): DropshipCostListingActionPassResult {
  return {
    vendorsProcessed: 0, vendorsFailed: 0, entriesDecided: 0, entriesSuperseded: 0, listingsDecided: 0, actions: emptyActionCounts(),
    repriceJobsQueued: 0, holdsPlaced: 0, noticesSent: 0,
    rechecks: { rechecked: 0, vendorsFailed: 0, repriceJobsQueued: 0, holdsPlaced: 0, noticesSent: 0 },
    holds: { restored: 0, reviewed: 0, released: 0, reasserted: 0, deferred: 0, vendorsFailed: 0, noticesSent: 0 },
  };
}

function emptyFacts(): CostActionVendorFacts {
  return { listings: [], savedPrices: [], profiles: new Map(), layersByStore: new Map(), candidates: new Map(), pricingPolicies: [] };
}

function groupByVendor(entries: readonly EffectiveCostIncrease[]): Map<number, EffectiveCostIncrease[]> {
  return groupBy(entries, (entry) => entry.vendorId);
}

function groupBy<T>(items: readonly T[], key: (item: T) => number): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new DropshipError("DROPSHIP_COST_CHANGE_CHUNK_SIZE_INVALID", "A command size must be a positive integer.", { classification: "fatal", size });
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function unique(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

function classificationOf(error: unknown): string {
  return error instanceof DropshipError && typeof error.context?.classification === "string" ? error.context.classification : "transient";
}

function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError("DROPSHIP_COST_CHANGE_INVALID_INPUT", "Dropship cost change listing action input failed validation.", {
      classification: "permanent",
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })),
    });
  }
  return result.data;
}
