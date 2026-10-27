import { describe, expect, it } from "vitest";

import {
  DEMOTED_LIVE_LISTING_STATUSES,
  isLiveListingStatus,
  LIVE_LISTING_STATUSES,
} from "../../domain/listing-live-status";
import {
  admittedWhilePushing,
  decideListingOrderAcceptability,
  assertNoMarketplaceVariationLines,
  isUnsupportedMarketplaceVariationLine,
  listingEndedBeforeOrderError,
  ORDER_LINE_VARIATION_UNSUPPORTED_CODE,
  ORDER_LISTING_ENDED_BEFORE_ORDER_CODE,
  ORDER_LISTING_ENDED_BEFORE_ORDER_MESSAGE,
  parseIntakeOrderedAt,
  PUSH_PROGRESS_LISTING_STATUSES,
} from "../../domain/order-listing-acceptability";

/** Every value the listing status CHECK allows (migrations/0086_dropship_v2_foundation.sql:284). */
const ALL_STATUSES = [
  "not_listed", "preview_ready", "queued", "pushing", "active", "paused", "ended", "failed", "blocked", "drift_detected",
] as const;

const EXPECTED: Record<(typeof ALL_STATUSES)[number], { withId: boolean; withoutId: boolean }> = {
  active: { withId: true, withoutId: true },
  drift_detected: { withId: true, withoutId: true },
  paused: { withId: true, withoutId: true },
  queued: { withId: true, withoutId: false },
  pushing: { withId: true, withoutId: false },
  failed: { withId: true, withoutId: false },
  blocked: { withId: true, withoutId: false },
  // An ended listing refuses unless both its end time and the order's time prove the order came first (below).
  ended: { withId: false, withoutId: false },
  not_listed: { withId: false, withoutId: false },
  preview_ready: { withId: false, withoutId: false },
};

describe("decideListingOrderAcceptability (step 1 plan S2-5 §4.7)", () => {
  it.each(ALL_STATUSES.flatMap((status) => [
    { status, externalListingId: "110012345678" as string | null, expected: EXPECTED[status].withId },
    { status, externalListingId: null as string | null, expected: EXPECTED[status].withoutId },
  ]))("$status with listing id $externalListingId → acceptable $expected", ({ status, externalListingId, expected }) => {
    expect(decideListingOrderAcceptability({ status, externalListingId }).acceptable).toBe(expected);
  });

  it("keeps the long-standing reason for the statuses that always took orders", () => {
    for (const status of ["active", "drift_detected", "paused"]) {
      const decision = decideListingOrderAcceptability({ status, externalListingId: null });
      expect(decision).toEqual({ acceptable: true, reason: "listing_orderable" });
      expect(admittedWhilePushing(decision)).toBe(false);
    }
  });

  it("admits a push-progress listing only because it is live on the marketplace", () => {
    const decision = decideListingOrderAcceptability({ status: "queued", externalListingId: "110012345678" });
    expect(decision).toEqual({ acceptable: true, reason: "listing_live_on_marketplace" });
    expect(admittedWhilePushing(decision)).toBe(true);
  });

  it.each(["", "   ", "\t"])("treats a blank listing id (%j) as no listing", (externalListingId) => {
    expect(decideListingOrderAcceptability({ status: "failed", externalListingId })).toEqual({
      acceptable: false,
      reason: "listing_not_on_marketplace",
    });
  });

  it("names why it refuses", () => {
    expect(decideListingOrderAcceptability({ status: "ended", externalListingId: "1" }).reason).toBe("listing_ended");
    expect(decideListingOrderAcceptability({ status: "not_listed", externalListingId: "1" }).reason)
      .toBe("listing_status_not_orderable");
    expect(decideListingOrderAcceptability({ status: "something_new", externalListingId: "1" }))
      .toEqual({ acceptable: false, reason: "listing_status_not_orderable" });
  });

  // One source of truth with the live-status rule (rebase of PR A onto PR 1b):
  // the statuses that always take orders are LIVE_LISTING_STATUSES, and every
  // status 1b names as written over a live listing is a push-progress status,
  // so a demoted row that still has its marketplace id keeps taking orders.
  it("reads the statuses that always take orders from the live-status rule", () => {
    for (const status of ALL_STATUSES) {
      const decision = decideListingOrderAcceptability({ status, externalListingId: null });
      expect(decision.acceptable && decision.reason === "listing_orderable").toBe(isLiveListingStatus(status));
    }
    for (const status of LIVE_LISTING_STATUSES) {
      expect(decideListingOrderAcceptability({ status, externalListingId: "110012345678" }))
        .toEqual({ acceptable: true, reason: "listing_orderable" });
    }
  });

  it("admits every status the live-status rule calls a demotion only with a marketplace id", () => {
    for (const status of DEMOTED_LIVE_LISTING_STATUSES) {
      expect(PUSH_PROGRESS_LISTING_STATUSES.has(status)).toBe(true);
      expect(decideListingOrderAcceptability({ status, externalListingId: "110012345678" }))
        .toEqual({ acceptable: true, reason: "listing_live_on_marketplace" });
      expect(decideListingOrderAcceptability({ status, externalListingId: "  " }))
        .toEqual({ acceptable: false, reason: "listing_not_on_marketplace" });
    }
    expect([...PUSH_PROGRESS_LISTING_STATUSES].sort()).toEqual([...DEMOTED_LIVE_LISTING_STATUSES, "pushing"].sort());
  });

  it("does not mutate its input", () => {
    const input = Object.freeze({ status: "pushing", externalListingId: "110012345678" });
    expect(() => decideListingOrderAcceptability(input)).not.toThrow();
  });
});

describe("an order on a listing sync-back saw end (eBay sync-back plan v4 §7.3 step 8)", () => {
  const endedAt = new Date("2026-10-20T12:00:00.000Z");
  const ended = (orderedAt: Date | null, marketplaceEndedAt: Date | null = endedAt) =>
    decideListingOrderAcceptability({ status: "ended", externalListingId: "110012345678", marketplaceEndedAt, orderedAt });

  it("accepts an order placed before the end, or at the very time sync-back saw it", () => {
    // FF-3: before the rule, every order on an ended listing was refused.
    expect(ended(new Date("2026-10-20T11:59:59.999Z"))).toEqual({ acceptable: true, reason: "ordered_before_listing_ended" });
    expect(ended(endedAt)).toEqual({ acceptable: true, reason: "ordered_before_listing_ended" });
    // Not a push-progress admission: the shipping rules for a listing being pushed do not apply.
    expect(admittedWhilePushing(ended(endedAt))).toBe(false);
  });

  it("refuses an order placed after the end", () => {
    expect(ended(new Date("2026-10-20T12:00:00.001Z"))).toEqual({ acceptable: false, reason: "listing_ended" });
  });

  it("refuses when either time is missing: no time, no proof", () => {
    expect(ended(null)).toEqual({ acceptable: false, reason: "listing_ended" });
    expect(ended(new Date("2026-10-19T00:00:00.000Z"), null)).toEqual({ acceptable: false, reason: "listing_ended" });
    expect(decideListingOrderAcceptability({ status: "ended", externalListingId: "1" })).toEqual({ acceptable: false, reason: "listing_ended" });
  });

  it("does not let the times change any other status", () => {
    const times = { marketplaceEndedAt: endedAt, orderedAt: new Date("2026-10-19T00:00:00.000Z") };
    for (const status of ALL_STATUSES.filter((entry) => entry !== "ended")) {
      expect(decideListingOrderAcceptability({ status, externalListingId: "110012345678", ...times }))
        .toEqual(decideListingOrderAcceptability({ status, externalListingId: "110012345678" }));
    }
  });
});

// PR C (PLAN-C v4.1 §8): Card Shellz's own end leaves marketplace_ended_at NULL; its end request's ended_at is the time.
describe("an order on a listing Card Shellz ended (PLAN-C v4.1 §8)", () => {
  const listingEndedAt = new Date("2026-10-25T12:00:00.000Z");
  const ended = (orderedAt: Date | null, times: { marketplaceEndedAt?: Date | null; listingEndedAt?: Date | null } = { listingEndedAt }) =>
    decideListingOrderAcceptability({ status: "ended", externalListingId: "110012345678", orderedAt, ...times });

  it("accepts an order placed before Card Shellz's end, or at its very time", () => {
    expect(ended(new Date("2026-10-25T11:59:59.999Z"))).toEqual({ acceptable: true, reason: "ordered_before_listing_ended" });
    expect(ended(listingEndedAt)).toEqual({ acceptable: true, reason: "ordered_before_listing_ended" });
  });

  it("refuses an order placed after it, and an order with no time (no proof)", () => {
    expect(ended(new Date("2026-10-25T12:00:00.001Z"))).toEqual({ acceptable: false, reason: "listing_ended" });
    expect(ended(null)).toEqual({ acceptable: false, reason: "listing_ended" });
    expect(ended(new Date("2026-10-24T00:00:00.000Z"), { listingEndedAt: null })).toEqual({ acceptable: false, reason: "listing_ended" });
  });

  it("judges by the vendor's end when sync-back recorded one (it is the newer: a completed push clears it)", () => {
    const vendorEndedAt = new Date("2026-10-26T12:00:00.000Z");
    const between = new Date("2026-10-26T00:00:00.000Z");
    expect(ended(between, { marketplaceEndedAt: vendorEndedAt, listingEndedAt })).toEqual({ acceptable: true, reason: "ordered_before_listing_ended" });
    expect(ended(between, { marketplaceEndedAt: new Date("2026-10-25T18:00:00.000Z"), listingEndedAt: vendorEndedAt }))
      .toEqual({ acceptable: false, reason: "listing_ended" });
  });

  it("does not let Card Shellz's end time change any other status", () => {
    for (const status of ALL_STATUSES.filter((entry) => entry !== "ended")) {
      expect(decideListingOrderAcceptability({ status, externalListingId: "110012345678", listingEndedAt, orderedAt: new Date("2026-10-26T00:00:00Z") }))
        .toEqual(decideListingOrderAcceptability({ status, externalListingId: "110012345678" }));
    }
  });
});

// DC14 (PLAN-C v4.1 §8 step 3): every listing_ended refusal, sync-back's included, is one review code.
describe("the refusal of an order whose listing had ended before it", () => {
  const base = { context: { intakeId: 7 }, lineIndex: 1, listingId: 501, listingStatus: "ended" };
  const orderedAt = new Date("2026-10-26T00:00:00.000Z");

  it("is permanent, for review, never retried, in the vendor's words, naming Card Shellz's end", () => {
    const error = listingEndedBeforeOrderError({ ...base, marketplaceEndedAt: null, listingEndedAt: new Date("2026-10-25T12:00:00.000Z"), orderedAt });
    expect(error.code).toBe(ORDER_LISTING_ENDED_BEFORE_ORDER_CODE);
    expect(ORDER_LISTING_ENDED_BEFORE_ORDER_CODE).toBe("DROPSHIP_ORDER_LISTING_ENDED_BEFORE_ORDER");
    expect(error.message).toBe(ORDER_LISTING_ENDED_BEFORE_ORDER_MESSAGE);
    expect(error.message).toBe("This order is for an eBay listing that was ended before the order was placed. Card Shellz will review it.");
    expect(error.context).toEqual({ intakeId: 7, lineIndex: 1, listingId: 501, listingStatus: "ended",
      endedAt: "2026-10-25T12:00:00.000Z", orderedAt: "2026-10-26T00:00:00.000Z", endSource: "card_shellz_end",
      requiresReview: true, retryable: false, classification: "permanent" });
  });

  it("names the vendor's end when sync-back saw it, and no end when neither time is known", () => {
    const vendorEnd = listingEndedBeforeOrderError({ ...base, marketplaceEndedAt: new Date("2026-10-25T09:00:00.000Z"),
      listingEndedAt: new Date("2026-10-24T00:00:00.000Z"), orderedAt });
    expect(vendorEnd.context).toMatchObject({ endSource: "marketplace_end", endedAt: "2026-10-25T09:00:00.000Z" });
    const unknown = listingEndedBeforeOrderError({ ...base, marketplaceEndedAt: null, listingEndedAt: null, orderedAt: null });
    expect(unknown.context).toMatchObject({ endSource: "unknown", endedAt: null, orderedAt: null, requiresReview: true });
  });
});

describe("a line sold from a multi-variation eBay listing (plan v4 §7.3 step 7)", () => {
  // Review ARCH-10: the canonical flag the marketplace's mapper sets, never a marketplace's own id field.
  it("is refused only when the mapper marked the line as sold from a multi-variation listing", () => {
    expect(isUnsupportedMarketplaceVariationLine({ marketplaceVariation: true })).toBe(true);
    // A marketplace id alone (the eBay mapper's externalOfferId) never decides it.
    const idOnly: { marketplaceVariation?: boolean; externalOfferId?: string } = { externalOfferId: "variation-1" };
    expect(isUnsupportedMarketplaceVariationLine(idOnly)).toBe(false);
    expect(isUnsupportedMarketplaceVariationLine({})).toBe(false);
    expect(ORDER_LINE_VARIATION_UNSUPPORTED_CODE).toBe("DROPSHIP_ORDER_LINE_VARIATION_UNSUPPORTED");
  });

  it("refuses the whole order once, for good, in the vendor's words, naming the line", () => {
    expect(() => assertNoMarketplaceVariationLines([{ externalListingId: "L0" }, { externalListingId: "L1", marketplaceVariation: true }],
      { intakeId: 7 })).toThrow(expect.objectContaining({ code: "DROPSHIP_ORDER_LINE_VARIATION_UNSUPPORTED",
      message: "This order has an item sold from an eBay listing with several sizes or options. Card Shellz lists each size on its own, so it can't fill this order.",
      context: { intakeId: 7, lineIndex: 1, externalListingId: "L1", retryable: false } }));
    expect(() => assertNoMarketplaceVariationLines([{ externalListingId: "L0" }], { intakeId: 7 })).not.toThrow();
  });

  it("reads an intake's order time, or none when it is missing or not a time", () => {
    expect(parseIntakeOrderedAt("2026-10-22T12:00:00.000Z")).toEqual(new Date("2026-10-22T12:00:00.000Z"));
    expect(parseIntakeOrderedAt(undefined)).toBeNull();
    expect(parseIntakeOrderedAt("not a time")).toBeNull();
  });
});
