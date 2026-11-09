import {
  decideLiveListingZeroQuantityUpdate,
  type LiveListingZeroQuantityListing,
  type LiveListingZeroQuantityRefusal,
} from "../domain/live-listing-zero-quantity";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";

/** The listing a zero-quantity update is for, as the caller resolved it. */
export interface DropshipLiveListingZeroQuantityTarget {
  vendorId: number;
  storeConnectionId: number;
  listingId: number;
  productVariantId: number;
  sku: string;
}

/**
 * The marketplace's quantity-only write: 0 for the listing's recorded offer,
 * nothing else (no price, content or policy). Throws when nothing provably
 * reached the marketplace, or when the outcome is unknown; the caller retries.
 */
export interface DropshipLiveListingZeroQuantitySender {
  sendZeroQuantity(input: DropshipLiveListingZeroQuantityTarget & {
    externalOfferId: string;
  }): Promise<{ sku: string; offerId: string }>;
}

/**
 * Records the sent 0 as the listing's settled push (pushed_quantity = 0,
 * last_pushed_at = now), so the push baseline and eBay sync-back's quantity
 * baseline read 0 from now. One transaction under the listing's row lock; it
 * refuses (throws, retryable) when the listing stopped being live on the same
 * offer while the 0 was being sent.
 */
export interface DropshipLiveListingZeroQuantitySettlement extends DropshipLiveListingZeroQuantityTarget {
  externalOfferId: string;
  actorId: string;
  reason: string;
  now: Date;
}

export interface DropshipLiveListingZeroQuantityRepository {
  settleZeroQuantity(input: DropshipLiveListingZeroQuantitySettlement): Promise<{ pushedQuantityBefore: number; lastPushedAtBefore: Date | null }>;
}

export interface DropshipLiveListingZeroQuantityServiceDependencies {
  sender: DropshipLiveListingZeroQuantitySender;
  repository: DropshipLiveListingZeroQuantityRepository;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export type DropshipLiveListingZeroQuantityOutcome =
  | { outcome: "sent"; externalOfferId: string }
  | { outcome: "refused"; reason: LiveListingZeroQuantityRefusal };

/**
 * A live listing whose current preview is blocked ONLY because Card Shellz
 * has none to sell gets 0 on the marketplace (domain/live-listing-zero-quantity).
 * Every other case is refused, unchanged, and the caller keeps its own refusal.
 * Idempotent: a replay sends the same 0 to the same offer and settles 0 again.
 */
export class DropshipLiveListingZeroQuantityService {
  constructor(private readonly deps: DropshipLiveListingZeroQuantityServiceDependencies) {}

  async publishZeroIfLive(input: {
    target: DropshipLiveListingZeroQuantityTarget;
    blockers: readonly string[];
    listing: LiveListingZeroQuantityListing | null;
    actorId: string;
    /** Why the update ran (e.g. the catch-up's job key), kept on the audit row. */
    reason: string;
    /**
     * A caller that must settle its own record with the listing in ONE transaction (the push worker: its item and
     * the listing) settles here instead of the repository's own transaction. Same writes, same conflict refusal.
     */
    settle?: DropshipLiveListingZeroQuantityRepository["settleZeroQuantity"];
  }): Promise<DropshipLiveListingZeroQuantityOutcome> {
    const decision = decideLiveListingZeroQuantityUpdate({ blockers: input.blockers, listing: input.listing });
    if (decision.kind === "refuse") return { outcome: "refused", reason: decision.reason };
    const sent = await this.deps.sender.sendZeroQuantity({ ...input.target, externalOfferId: decision.externalOfferId });
    const settle = input.settle ?? ((settlement: DropshipLiveListingZeroQuantitySettlement) => this.deps.repository.settleZeroQuantity(settlement));
    const before = await settle({
      ...input.target,
      externalOfferId: decision.externalOfferId,
      actorId: input.actorId,
      reason: input.reason,
      now: this.deps.clock.now(),
    });
    // INFO: a state transition (the listing's marketplace quantity went to 0), not an anomaly (CLAUDE.md section 10).
    this.deps.logger.info({
      code: "DROPSHIP_LIVE_LISTING_ZERO_QUANTITY_SENT",
      message: "A live listing with no stock to sell was set to quantity 0 on the marketplace.",
      context: {
        action: "dropship.listing_quantity.zero_sent",
        outcome: "sent",
        vendorId: input.target.vendorId,
        storeConnectionId: input.target.storeConnectionId,
        listingId: input.target.listingId,
        productVariantId: input.target.productVariantId,
        sku: sent.sku,
        externalOfferId: sent.offerId,
        externalListingId: decision.externalListingId,
        actor: input.actorId,
        reason: input.reason,
        before: { pushedQuantity: before.pushedQuantityBefore, lastPushedAt: before.lastPushedAtBefore?.toISOString() ?? null },
        after: { pushedQuantity: 0 },
      },
    });
    return { outcome: "sent", externalOfferId: decision.externalOfferId };
  }
}
