import { describe, expect, it } from "vitest";

import {
  DEMOTED_LIVE_LISTING_STATUSES,
  isLiveListingStatus,
  LIVE_LISTING_STATUSES,
} from "../../domain/listing-live-status";
import {
  admittedWhilePushing,
  decideListingOrderAcceptability,
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
  // PR C adds the rule for orders placed before an end; in A an ended listing refuses.
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
