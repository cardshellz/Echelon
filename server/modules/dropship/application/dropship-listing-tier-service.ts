import { createHash } from "node:crypto";
import { z } from "zod";
import type { DropshipVendorStatus } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import {
  DROPSHIP_LISTING_TIERS,
  evaluateDropshipListingTierEligibility,
  heldListingTiersFor,
  listingTierHoldIdempotencyKeyFor,
  listingTierNotificationKeyFor,
  listingTiersAlreadyOn,
  type DropshipEnforcedListingTierMinimums,
  type DropshipListingTier,
  type DropshipListingTierEligibility,
  type DropshipListingTierStatus,
  type DropshipVendorListingTierFunding,
} from "../domain/listing-tiers";
import {
  formatNotificationCurrency,
  formatNotificationDate,
  sendDropshipNotificationSafely,
} from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";

/**
 * Listing tiers: which of a vendor's tiers are on, and keeping the
 * marketplace in step with that.
 *
 * The rules are pure (`domain/listing-tiers.ts`); this service supplies the
 * clock, the policy history, the wallet facts, the last recorded decision and
 * the side effects:
 * - `resolveForVendor` answers the vendor-facing and preview surfaces. It
 *   reads the last decision (a tier on at the last check stays on while the
 *   reserve covers it) and never writes.
 * - `reconcileListingTiers` runs on the hourly maintenance tick. Per vendor it
 *   decides the held tiers, records the decision (and the tiers it left on)
 *   with a bumped revision when the held tiers changed, tells the vendor once
 *   per change, and asks inventory planning to hold or release the listed SKUs of
 *   each tier per store connection. A deferral (a provider quantity request
 *   in flight) leaves the decision recorded but not applied, and the next
 *   tick retries the same revision under the same idempotency keys.
 * - A raise still in its grace period is announced once per vendor, tier and
 *   policy version to the vendors it would catch.
 *
 * Standing (a paused vendor) holds a whole store; the tier holds are SKU-level
 * and independent, so a vendor who resumes comes back with the right tiers.
 */

const DEFAULT_RECONCILE_LIMIT = 100;
const MAX_RECONCILE_LIMIT = 1000;
/** A vendor with more store connections or listings than this is a data fault, not a batch. */
const MAX_STORE_CONNECTIONS_PER_VENDOR = 100;

export const reconcileDropshipListingTiersInputSchema = z.object({
  workerId: z.string().trim().min(1).max(120),
  limit: z.number().int().positive().max(MAX_RECONCILE_LIMIT).optional(),
}).strict();
export type ReconcileDropshipListingTiersInput = z.infer<typeof reconcileDropshipListingTiersInputSchema>;

export interface DropshipVendorListingTierHoldRecord {
  vendorId: number;
  /** Tiers whose listed SKUs must publish zero, in tier order. */
  heldTiers: DropshipListingTier[];
  /** Bumped on every change of held tiers; keys the planner commands and the notices. */
  revision: number;
  /** True once every store connection carries the holds and releases this revision asks for. */
  applied: boolean;
  /**
   * The tiers the current rule found on at this decision; null on a row the
   * September rule wrote (migration 0706), which this rule does not trust.
   */
  tiersOn: DropshipListingTier[] | null;
  detail: string | null;
  evaluatedAt: Date;
  appliedAt: Date | null;
}

export interface DropshipListingTierVendorRecord {
  vendorId: number;
  status: DropshipVendorStatus;
  tierHold: DropshipVendorListingTierHoldRecord | null;
}

export interface DropshipListingTierRepository {
  /** Vendors whose listings can be on a marketplace (active or paused), oldest first. */
  listVendorsForReview(input: { limit: number }): Promise<DropshipListingTierVendorRecord[]>;
  /** One vendor's status and last decision, whatever the status; null when the vendor does not exist. */
  getVendor(vendorId: number): Promise<DropshipListingTierVendorRecord | null>;
  /** Store connections that can carry listings (anything not disconnected). */
  listStoreConnectionIds(vendorId: number): Promise<number[]>;
  /** Every listing row of the store, whatever its status, grouped by the tier its SKU sells in. */
  listListingVariantIdsByTier(input: { vendorId: number; storeConnectionId: number }): Promise<Record<DropshipListingTier, number[]>>;
  /**
   * Records the held tiers and, as `tiersOn`, the tiers this decision left
   * on. An unchanged set only refreshes `evaluatedAt` and `tiersOn`; a
   * changed set bumps the revision, clears `applied`, and commits an audit
   * row with it.
   */
  recordHeldTiers(input: {
    vendorId: number;
    heldTiers: readonly DropshipListingTier[];
    detail: string | null;
    now: Date;
  }): Promise<{ changed: boolean; record: DropshipVendorListingTierHoldRecord }>;
  /** Marks the revision applied (or not, with why); a stale revision is left alone and reported false. */
  recordApplied(input: {
    vendorId: number;
    revision: number;
    applied: boolean;
    detail: string | null;
    now: Date;
  }): Promise<boolean>;
}

export interface DropshipVendorListingTierFundingSnapshot extends DropshipVendorListingTierFunding {
  currency: string;
}

export interface DropshipListingTierFundingReader {
  readTierFunding(vendorId: number): Promise<DropshipVendorListingTierFundingSnapshot>;
}

export interface DropshipListingTierPolicyReader {
  resolveListingTierMinimums(now: Date): Promise<DropshipEnforcedListingTierMinimums>;
}

export type DropshipListingVariantHoldGateOutcome =
  | {
      applied: true;
      targetCount: number;
      publicationRows: number;
      changedProductVariantIds: number[];
      blockedProductIds: number[];
    }
  /** The command was refused for now (busy, concurrent change); retry on the next tick. */
  | { applied: false; code: string; message: string };

export interface DropshipListingVariantHoldGate {
  /** The most SKUs one command may name; longer lists are chunked. */
  maxVariantsPerCommand: number;
  holdVariants(input: {
    storeConnectionId: number;
    productVariantIds: readonly number[];
    reason: string;
    idempotencyKey: string;
  }): Promise<DropshipListingVariantHoldGateOutcome>;
  releaseVariants(input: {
    storeConnectionId: number;
    productVariantIds: readonly number[];
    reason: string;
    idempotencyKey: string;
  }): Promise<DropshipListingVariantHoldGateOutcome>;
}

export interface DropshipVendorListingTierView {
  vendorId: number;
  minimums: DropshipEnforcedListingTierMinimums;
  eligibility: DropshipListingTierEligibility;
  funding: DropshipVendorListingTierFundingSnapshot;
  generatedAt: Date;
}

export type DropshipListingTierApplyOutcome =
  | { outcome: "applied"; storeConnectionIds: number[]; blockedProductIds: number[] }
  /** Inventory planning refused for now; the same revision is retried next tick. */
  | { outcome: "deferred"; storeConnectionId: number; code: string; message: string }
  /** No publication hold gate is configured; the decision is recorded only. */
  | { outcome: "unavailable" }
  /** The gate failed outright; logged at ERROR, the same revision is retried next tick. */
  | { outcome: "failed"; error: string };

type DropshipListingTierGateOutcome = Extract<DropshipListingTierApplyOutcome, { outcome: "applied" | "deferred" }>;

export interface DropshipListingTierVendorChange {
  vendorId: number;
  heldTiers: DropshipListingTier[];
  /** Whether this tick changed the held tiers. */
  changed: boolean;
  revision: number;
  apply: DropshipListingTierApplyOutcome | null;
  graceNoticesSent: DropshipListingTier[];
}

export interface DropshipListingTierReconcileResult {
  scannedCount: number;
  changedCount: number;
  appliedCount: number;
  deferredCount: number;
  unavailableCount: number;
  failedCount: number;
  graceNoticeCount: number;
}

export class DropshipListingTierService {
  constructor(
    private readonly deps: {
      repository: DropshipListingTierRepository;
      funding: DropshipListingTierFundingReader;
      policy: DropshipListingTierPolicyReader;
      /** Absent in environments without canonical publication; decisions are still recorded. */
      variantHolds?: DropshipListingVariantHoldGate;
      notificationSender?: DropshipNotificationSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  /** The tier standing one vendor sees: which tiers are on, what each takes, what is coming. */
  async resolveForVendor(vendorId: number): Promise<DropshipVendorListingTierView> {
    const id = requireVendorId(vendorId);
    const generatedAt = this.deps.clock.now();
    const [minimums, funding, vendor] = await Promise.all([
      this.deps.policy.resolveListingTierMinimums(generatedAt),
      this.deps.funding.readTierFunding(id),
      this.deps.repository.getVendor(id),
    ]);
    const eligibility = evaluateDropshipListingTierEligibility({ funding, minimums, tiersAlreadyOn: tiersAlreadyOnFor(vendor) });
    return { vendorId: id, minimums, eligibility, funding, generatedAt };
  }

  /** Hourly: decide, record, tell, and apply for every vendor in the batch. */
  async reconcileListingTiers(input: unknown): Promise<DropshipListingTierReconcileResult> {
    const parsed = parseInput(reconcileDropshipListingTiersInputSchema, input);
    const limit = parsed.limit ?? DEFAULT_RECONCILE_LIMIT;
    const now = this.deps.clock.now();
    const minimums = await this.deps.policy.resolveListingTierMinimums(now);
    const vendors = await this.deps.repository.listVendorsForReview({ limit });
    const result: DropshipListingTierReconcileResult = {
      scannedCount: vendors.length,
      changedCount: 0,
      appliedCount: 0,
      deferredCount: 0,
      unavailableCount: 0,
      failedCount: 0,
      graceNoticeCount: 0,
    };
    for (const vendor of vendors) {
      try {
        const change = await this.reconcileVendor(vendor, minimums, now);
        if (change.changed) result.changedCount += 1;
        if (change.apply?.outcome === "applied") result.appliedCount += 1;
        else if (change.apply?.outcome === "deferred") result.deferredCount += 1;
        else if (change.apply?.outcome === "unavailable") result.unavailableCount += 1;
        else if (change.apply?.outcome === "failed") result.failedCount += 1;
        result.graceNoticeCount += change.graceNoticesSent.length;
      } catch (error) {
        result.failedCount += 1;
        this.deps.logger.error({
          code: "DROPSHIP_LISTING_TIER_RECONCILE_FAILED",
          message: "Dropship listing tier reconcile could not decide a vendor's tiers.",
          context: { vendorId: vendor.vendorId, workerId: parsed.workerId, error: errorMessage(error) },
        });
      }
    }
    if (vendors.length > 0) {
      this.deps.logger.info({
        code: "DROPSHIP_LISTING_TIER_RECONCILED",
        message: "Dropship listing tier reconcile finished a batch.",
        context: { workerId: parsed.workerId, ...result },
      });
    }
    return result;
  }

  private async reconcileVendor(
    vendor: DropshipListingTierVendorRecord,
    minimums: DropshipEnforcedListingTierMinimums,
    now: Date,
  ): Promise<DropshipListingTierVendorChange> {
    const funding = await this.deps.funding.readTierFunding(vendor.vendorId);
    const eligibility = evaluateDropshipListingTierEligibility({ funding, minimums, tiersAlreadyOn: tiersAlreadyOnFor(vendor) });
    const heldTiers = heldListingTiersFor(eligibility);
    const recorded = await this.deps.repository.recordHeldTiers({
      vendorId: vendor.vendorId,
      heldTiers,
      detail: describeDecision(eligibility),
      now,
    });
    const record = recorded.record;
    if (recorded.changed) {
      this.deps.logger.info({
        code: "DROPSHIP_LISTING_TIER_HOLD_CHANGED",
        message: "Dropship vendor's held listing tiers changed.",
        context: {
          vendorId: vendor.vendorId,
          revision: record.revision,
          before: vendor.tierHold?.heldTiers ?? [],
          after: record.heldTiers,
          availableBalanceCents: funding.availableBalanceCents,
          pendingBalanceCents: funding.pendingBalanceCents,
          minimumBalanceCents: funding.minimumBalanceCents,
        },
      });
      await this.announceChange(vendor, record, eligibility, funding);
    }
    const apply = record.applied ? null : await this.applySafely(record, now);
    const graceNoticesSent = await this.announceGrace(vendor.vendorId, eligibility, funding, now);
    return {
      vendorId: vendor.vendorId,
      heldTiers: record.heldTiers,
      changed: recorded.changed,
      revision: record.revision,
      apply,
      graceNoticesSent,
    };
  }

  /**
   * Ask inventory planning for the SKU holds and releases this revision needs,
   * store by store and tier by tier, then mark the revision applied. A
   * deferral stops at the first refusal and leaves the row unapplied for the
   * next tick; a failure is logged at ERROR and also retried next tick.
   */
  private async applySafely(record: DropshipVendorListingTierHoldRecord, now: Date): Promise<DropshipListingTierApplyOutcome> {
    const gate = this.deps.variantHolds;
    if (!gate) {
      this.deps.logger.warn({
        code: "DROPSHIP_LISTING_TIER_HOLD_UNAVAILABLE",
        message: "Dropship listing tier holds were recorded but no publication hold gate is configured; the marketplace was not changed.",
        context: { vendorId: record.vendorId, revision: record.revision, heldTiers: record.heldTiers },
      });
      await this.deps.repository.recordApplied({
        vendorId: record.vendorId, revision: record.revision, applied: false, detail: "no publication hold gate configured", now,
      });
      return { outcome: "unavailable" };
    }
    try {
      const outcome = await this.apply(gate, record);
      if (outcome.outcome === "applied") {
        const detail = describeApplied(record.heldTiers, outcome.blockedProductIds);
        await this.deps.repository.recordApplied({ vendorId: record.vendorId, revision: record.revision, applied: true, detail, now });
        this.deps.logger.info({
          code: "DROPSHIP_LISTING_TIER_HOLDS_APPLIED",
          message: "Dropship vendor's listing tier holds are in place on every store.",
          context: { vendorId: record.vendorId, revision: record.revision, heldTiers: record.heldTiers, ...outcome },
        });
      } else {
        const detail = `deferred: ${outcome.code} (store ${outcome.storeConnectionId})`;
        await this.deps.repository.recordApplied({ vendorId: record.vendorId, revision: record.revision, applied: false, detail, now });
        this.deps.logger.warn({
          code: "DROPSHIP_LISTING_TIER_HOLD_DEFERRED",
          message: "Inventory planning deferred a listing tier hold; the next tick retries it.",
          context: { vendorId: record.vendorId, revision: record.revision, ...outcome },
        });
      }
      return outcome;
    } catch (error) {
      const message = errorMessage(error);
      this.deps.logger.error({
        code: "DROPSHIP_LISTING_TIER_HOLD_FAILED",
        message: "Inventory planning could not apply a vendor's listing tier holds; the next tick retries the same revision.",
        context: { vendorId: record.vendorId, revision: record.revision, heldTiers: record.heldTiers, error: message },
      });
      await this.deps.repository.recordApplied({
        vendorId: record.vendorId, revision: record.revision, applied: false, detail: `failed: ${message}`, now,
      });
      return { outcome: "failed", error: message };
    }
  }

  private async apply(
    gate: DropshipListingVariantHoldGate,
    record: DropshipVendorListingTierHoldRecord,
  ): Promise<DropshipListingTierGateOutcome> {
    const storeConnectionIds = await this.deps.repository.listStoreConnectionIds(record.vendorId);
    if (storeConnectionIds.length > MAX_STORE_CONNECTIONS_PER_VENDOR) {
      throw new DropshipError(
        "DROPSHIP_LISTING_TIER_STORE_COUNT_INVALID",
        "A vendor has more store connections than listing tier holds can address in one tick.",
        { vendorId: record.vendorId, storeConnectionCount: storeConnectionIds.length },
      );
    }
    const blockedProductIds = new Set<number>();
    for (const storeConnectionId of storeConnectionIds) {
      const variantIdsByTier = await this.deps.repository.listListingVariantIdsByTier({ vendorId: record.vendorId, storeConnectionId });
      for (const tier of DROPSHIP_LISTING_TIERS) {
        const held = record.heldTiers.includes(tier);
        const command = held ? "hold" : "release";
        for (const chunk of chunkVariantIds(variantIdsByTier[tier], gate.maxVariantsPerCommand)) {
          const request = {
            storeConnectionId,
            productVariantIds: chunk,
            reason: holdReason(record.vendorId, tier, held, record.revision),
            idempotencyKey: listingTierHoldIdempotencyKeyFor({
              vendorId: record.vendorId,
              tierHoldRevision: record.revision,
              tier,
              command,
              storeConnectionId,
              variantSetHash: variantSetHash(chunk),
            }),
          };
          const outcome = command === "hold" ? await gate.holdVariants(request) : await gate.releaseVariants(request);
          if (!outcome.applied) {
            return { outcome: "deferred", storeConnectionId, code: outcome.code, message: outcome.message };
          }
          for (const productId of outcome.blockedProductIds) blockedProductIds.add(productId);
        }
      }
    }
    return { outcome: "applied", storeConnectionIds, blockedProductIds: [...blockedProductIds].sort((a, b) => a - b) };
  }

  /** One notice per tier that changed state, keyed by the revision so a retried tick never repeats it. */
  private async announceChange(
    vendor: DropshipListingTierVendorRecord,
    record: DropshipVendorListingTierHoldRecord,
    eligibility: DropshipListingTierEligibility,
    funding: DropshipVendorListingTierFundingSnapshot,
  ): Promise<void> {
    const before = new Set(vendor.tierHold?.heldTiers ?? []);
    const after = new Set(record.heldTiers);
    for (const tier of DROPSHIP_LISTING_TIERS) {
      if (before.has(tier) === after.has(tier)) continue;
      const held = after.has(tier);
      const status = eligibility[tier];
      await sendDropshipNotificationSafely(this.deps, {
        vendorId: vendor.vendorId,
        eventType: held ? DROPSHIP_NOTIFICATION_EVENTS.LISTING_TIER_HELD : DROPSHIP_NOTIFICATION_EVENTS.LISTING_TIER_RELEASED,
        critical: held,
        channels: ["email", "in_app"],
        title: held ? heldTitle(status) : releasedTitle(tier),
        message: held ? heldMessage(status, funding) : releasedMessage(tier, status, funding),
        payload: {
          vendorId: vendor.vendorId,
          tier,
          revision: record.revision,
          reason: status.reason,
          policyMinimumCents: status.policyMinimumCents,
          minimumCents: status.minimumCents,
          reserveShortfallCents: status.reserveShortfallCents,
          balanceShortfallCents: status.balanceShortfallCents,
          availableBalanceCents: funding.availableBalanceCents,
          pendingBalanceCents: funding.pendingBalanceCents,
          minimumBalanceCents: funding.minimumBalanceCents,
          currency: funding.currency,
        },
        idempotencyKey: listingTierNotificationKeyFor({ vendorId: vendor.vendorId, tier, event: held ? "held" : "released", revision: record.revision }),
      }, {
        code: "DROPSHIP_LISTING_TIER_NOTIFICATION_FAILED",
        message: "Dropship listing tier notification failed after the change was recorded.",
        context: { vendorId: vendor.vendorId, tier, revision: record.revision },
      });
    }
  }

  /**
   * A raise inside its grace period is announced once per vendor, tier and
   * policy version, only to vendors it would catch as things stand.
   */
  private async announceGrace(
    vendorId: number,
    eligibility: DropshipListingTierEligibility,
    funding: DropshipVendorListingTierFundingSnapshot,
    now: Date,
  ): Promise<DropshipListingTier[]> {
    if (!this.deps.notificationSender) return [];
    const sent: DropshipListingTier[] = [];
    for (const tier of DROPSHIP_LISTING_TIERS) {
      const status = eligibility[tier];
      const upcoming = status.upcoming;
      if (!upcoming || !upcoming.affectsVendor || upcoming.enforcesAt.getTime() <= now.getTime()) continue;
      await sendDropshipNotificationSafely(this.deps, {
        vendorId,
        eventType: DROPSHIP_NOTIFICATION_EVENTS.LISTING_TIER_GRACE_NOTICE,
        critical: true,
        channels: ["email", "in_app"],
        title: `The ${tierLabel(tier)} rises to ${formatNotificationCurrency(upcoming.minimumCents, funding.currency)} on ${formatNotificationDate(upcoming.enforcesAt)}`,
        message: graceMessage(tier, status, funding, upcoming.minimumCents, upcoming.enforcesAt),
        payload: {
          vendorId,
          tier,
          policyVersion: upcoming.version,
          currentMinimumCents: status.minimumCents,
          upcomingMinimumCents: upcoming.minimumCents,
          enforcesAt: upcoming.enforcesAt.toISOString(),
          availableBalanceCents: funding.availableBalanceCents,
          pendingBalanceCents: funding.pendingBalanceCents,
          minimumBalanceCents: funding.minimumBalanceCents,
          currency: funding.currency,
        },
        idempotencyKey: listingTierNotificationKeyFor({ vendorId, tier, event: "grace_notice", revision: upcoming.version }),
      }, {
        code: "DROPSHIP_LISTING_TIER_GRACE_NOTICE_FAILED",
        message: "Dropship listing tier grace notice failed; it is retried on the next tick.",
        context: { vendorId, tier, policyVersion: upcoming.version },
      });
      sent.push(tier);
    }
    return sent;
  }
}

/** The tier as vendors see it named: the Pack tier (singles, packs, inner packs) and the Case tier. */
function tierLabel(tier: DropshipListingTier): string {
  return tier === "case" ? "Case tier" : "Pack tier";
}

/** Which listings a tier covers, in the words vendors see. */
function tierListings(tier: DropshipListingTier): string {
  return tier === "case" ? "case listings" : "pack listings";
}

function heldTitle(status: DropshipListingTierStatus): string {
  return `Your ${tierLabel(status.tier)} is not active`;
}

/**
 * Why the tier went off and what turns it back on, from the decision's
 * reason. Every amount is the policy amount: the one the vendor is shown and
 * the one that turns the tier back on.
 */
function heldMessage(status: DropshipListingTierStatus, funding: DropshipVendorListingTierFundingSnapshot): string {
  const amount = formatNotificationCurrency(status.policyMinimumCents, funding.currency);
  const listings = tierListings(status.tier);
  const other = status.tier === "case" ? " Your pack listings are not affected." : "";
  if (status.reason === "autopay_off") {
    return `Autopay is off, so your wallet has no reserve and your ${listings} are paused. Turn on autopay with a reserve of at least ${amount}; they go live again once your balance reaches ${amount}.${other}`;
  }
  if (status.reason === "reserve_below_tier") {
    const reserve = formatNotificationCurrency(funding.minimumBalanceCents ?? 0, funding.currency);
    return `The ${tierLabel(status.tier)} needs a reserve of ${amount}. Your reserve is ${reserve}, so your ${listings} are paused. Raise your reserve to ${amount}; they go live again once your balance also reaches ${amount}.${other}`;
  }
  return `The ${tierLabel(status.tier)} needs ${amount} in your wallet. ${describeCountedBalance(funding)}, so your ${listings} are paused. They go live again once your balance reaches ${amount}.${other}`;
}

function releasedTitle(tier: DropshipListingTier): string {
  return `Your ${tierLabel(tier)} is active again`;
}

function releasedMessage(
  tier: DropshipListingTier,
  status: DropshipListingTierStatus,
  funding: DropshipVendorListingTierFundingSnapshot,
): string {
  const amount = formatNotificationCurrency(status.policyMinimumCents, funding.currency);
  const listings = tierListings(tier);
  return `Your reserve and your balance have both reached ${amount}, so your ${listings} are live again.`;
}

/**
 * Sent only to a vendor the raise would turn off: the tier is on and the
 * reserve is below the raised amount. The balance follows the reserve
 * (autopay tops up to it), so the reserve is the one thing to change.
 */
function graceMessage(
  tier: DropshipListingTier,
  status: DropshipListingTierStatus,
  funding: DropshipVendorListingTierFundingSnapshot,
  upcomingMinimumCents: number,
  enforcesAt: Date,
): string {
  const current = formatNotificationCurrency(status.minimumCents, funding.currency);
  const upcoming = formatNotificationCurrency(upcomingMinimumCents, funding.currency);
  const reserve = funding.minimumBalanceCents === null
    ? "Autopay is off, so you have no reserve"
    : `Your reserve is ${formatNotificationCurrency(funding.minimumBalanceCents, funding.currency)}`;
  const date = formatNotificationDate(enforcesAt);
  return `Card Shellz is raising the ${tierLabel(tier)} from ${current} to ${upcoming} on ${date}. ${reserve}. Raise it to ${upcoming} before then to keep your ${tierListings(tier)} live.`;
}

/** The wallet's money in one clause, naming credits still on their way. */
function describeCountedBalance(funding: DropshipVendorListingTierFundingSnapshot): string {
  const counted = formatNotificationCurrency(funding.availableBalanceCents + funding.pendingBalanceCents, funding.currency);
  return funding.pendingBalanceCents > 0
    ? `Your wallet has ${counted}, including ${formatNotificationCurrency(funding.pendingBalanceCents, funding.currency)} on its way`
    : `Your wallet has ${counted}`;
}

function holdReason(vendorId: number, tier: DropshipListingTier, held: boolean, revision: number): string {
  return `Dropship vendor ${vendorId}: ${tier} tier ${held ? "below" : "meets"} minimum (rev ${revision})`;
}

function describeDecision(eligibility: DropshipListingTierEligibility): string {
  return DROPSHIP_LISTING_TIERS
    .map((tier) => {
      const status = eligibility[tier];
      if (status.eligible) return `${tier}: on${status.alreadyOn ? " (already on)" : ""}`;
      return `${tier}: off (${status.reason}; reserve short ${status.reserveShortfallCents} cents, balance short ${status.balanceShortfallCents} cents)`;
    })
    .join("; ");
}

/** The tiers the last decision left on, for a vendor the rule lets keep them. */
function tiersAlreadyOnFor(vendor: DropshipListingTierVendorRecord | null): DropshipListingTier[] {
  if (!vendor) return [];
  return listingTiersAlreadyOn({
    vendorStatus: vendor.status,
    lastDecision: vendor.tierHold ? { tiersOn: vendor.tierHold.tiersOn } : null,
  });
}

function describeApplied(heldTiers: readonly DropshipListingTier[], blockedProductIds: readonly number[]): string {
  const held = heldTiers.length > 0 ? `held ${heldTiers.join(",")}` : "all tiers released";
  return blockedProductIds.length > 0 ? `${held}; planner blocked products ${blockedProductIds.join(",")}` : held;
}

function chunkVariantIds(ids: readonly number[], size: number): number[][] {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new DropshipError("DROPSHIP_LISTING_TIER_GATE_INVALID", "The publication hold gate reports an invalid command size.", { size });
  }
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let index = 0; index < sorted.length; index += size) chunks.push(sorted.slice(index, index + size));
  return chunks;
}

/** A short, stable fingerprint of the exact SKU set a command names. */
function variantSetHash(ids: readonly number[]): string {
  return createHash("sha256").update(ids.join(","), "utf8").digest("hex").slice(0, 16);
}

function requireVendorId(vendorId: unknown): number {
  if (!Number.isSafeInteger(vendorId) || (vendorId as number) <= 0) {
    throw new DropshipError("DROPSHIP_LISTING_TIER_INVALID_INPUT", "A positive vendor id is required.", { vendorId });
  }
  return vendorId as number;
}

function parseInput<TSchema extends z.ZodTypeAny>(schema: TSchema, input: unknown): z.infer<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError("DROPSHIP_LISTING_TIER_INVALID_INPUT", "Dropship listing tier input failed validation.", { issues: result.error.issues });
  }
  return result.data as z.infer<TSchema>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function makeDropshipListingTierLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipListingTierEvent("info", event),
    warn: (event) => logDropshipListingTierEvent("warn", event),
    error: (event) => logDropshipListingTierEvent("error", event),
  };
}

export const systemDropshipListingTierClock: DropshipClock = {
  now: () => new Date(),
};

function logDropshipListingTierEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
  const payload = JSON.stringify({ code: event.code, message: event.message, context: event.context ?? {} });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}
