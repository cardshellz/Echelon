import { describe, expect, it } from "vitest";
import {
  DEMOTED_LIVE_LISTING_STATUSES,
  LIVE_LISTING_STATUSES,
  decideDemotedLiveListingRestore,
  hasMarketplaceListing,
  isLaterPushItemWrite,
  isLiveListingStatus,
  listingStatusAfterCompletedPush,
  type DemotedLiveListingEvidence,
} from "../../domain/listing-live-status";

const COMPLETED_AT = new Date("2026-10-01T00:00:00.000Z");
const FAILED_AT = new Date("2026-10-02T00:00:00.000Z");

function evidence(patch: Partial<DemotedLiveListingEvidence> = {}): DemotedLiveListingEvidence {
  return {
    listingId: 100,
    status: "failed",
    externalListingId: "123456789012",
    hasInFlightItem: false,
    lastCompletedItem: { itemId: 5, listingMode: "live", wroteAt: COMPLETED_AT },
    latestWrite: { itemId: 9, wroteAt: FAILED_AT },
    ...patch,
  };
}

describe("live listing statuses", () => {
  it("are exactly the statuses orders and quotes accept", () => {
    // dropship-order-acceptance and dropship-order-processing accepted these three before the shared rule.
    expect([...LIVE_LISTING_STATUSES]).toEqual(["active", "paused", "drift_detected"]);
    for (const status of LIVE_LISTING_STATUSES) expect(isLiveListingStatus(status)).toBe(true);
    for (const status of ["not_listed", "preview_ready", "queued", "pushing", "ended", "failed", "blocked", ""]) {
      expect(isLiveListingStatus(status)).toBe(false);
    }
  });

  it("names the statuses a queue, a failed push and an ops retry wrote over live listings", () => {
    expect([...DEMOTED_LIVE_LISTING_STATUSES]).toEqual(["queued", "failed", "blocked"]);
    for (const status of DEMOTED_LIVE_LISTING_STATUSES) expect(isLiveListingStatus(status)).toBe(false);
  });

  it("treats only a non-blank external listing id as a marketplace listing", () => {
    expect(hasMarketplaceListing("123456789012")).toBe(true);
    expect(hasMarketplaceListing(null)).toBe(false);
    expect(hasMarketplaceListing(undefined)).toBe(false);
    expect(hasMarketplaceListing("")).toBe(false);
    expect(hasMarketplaceListing("   ")).toBe(false);
  });

  it("maps a completed push's mode the way completeItem always has", () => {
    expect(listingStatusAfterCompletedPush("live")).toBe("active");
    expect(listingStatusAfterCompletedPush("draft_first")).toBe("paused");
    expect(listingStatusAfterCompletedPush("manual_only")).toBe("paused");
  });
});

describe("decideDemotedLiveListingRestore", () => {
  it("restores active for a listing whose last completed push published it live", () => {
    expect(decideDemotedLiveListingRestore(evidence())).toEqual({ kind: "restore", status: "active", basisItemId: 5 });
    for (const status of DEMOTED_LIVE_LISTING_STATUSES) {
      expect(decideDemotedLiveListingRestore(evidence({ status }))).toMatchObject({ kind: "restore", status: "active" });
    }
  });

  it("restores paused for a listing last saved as a draft", () => {
    expect(decideDemotedLiveListingRestore(evidence({ lastCompletedItem: { itemId: 5, listingMode: "draft_first", wroteAt: COMPLETED_AT } })))
      .toEqual({ kind: "restore", status: "paused", basisItemId: 5 });
    expect(decideDemotedLiveListingRestore(evidence({ lastCompletedItem: { itemId: 5, listingMode: "manual_only", wroteAt: COMPLETED_AT } })))
      .toEqual({ kind: "restore", status: "paused", basisItemId: 5 });
  });

  it("leaves live, never-published and not-demoted listings alone", () => {
    for (const status of ["active", "paused", "drift_detected", "ended", "not_listed", "preview_ready"]) {
      expect(decideDemotedLiveListingRestore(evidence({ status }))).toEqual({ kind: "skip", reason: "not_demoted" });
    }
    expect(decideDemotedLiveListingRestore(evidence({ externalListingId: null }))).toEqual({ kind: "skip", reason: "not_published" });
    expect(decideDemotedLiveListingRestore(evidence({ externalListingId: "  " }))).toEqual({ kind: "skip", reason: "not_published" });
  });

  it("waits for an in-flight push to decide the status itself", () => {
    expect(decideDemotedLiveListingRestore(evidence({ hasInFlightItem: true }))).toEqual({ kind: "skip", reason: "in_flight" });
  });

  it("asks for review instead of guessing when the evidence does not decide a status", () => {
    expect(decideDemotedLiveListingRestore(evidence({ lastCompletedItem: null }))).toMatchObject({
      kind: "requires_review", code: "DROPSHIP_LISTING_LIVE_STATUS_NO_COMPLETED_PUSH",
    });
    for (const listingMode of [null, "", "LIVE", "unknown"]) {
      expect(decideDemotedLiveListingRestore(evidence({ lastCompletedItem: { itemId: 5, listingMode, wroteAt: COMPLETED_AT } }))).toMatchObject({
        kind: "requires_review", code: "DROPSHIP_LISTING_LIVE_STATUS_UNKNOWN_MODE",
      });
    }
    // The current status must have been written after the last completion, by an item that wrote later.
    for (const latestWrite of [null, { itemId: 5, wroteAt: COMPLETED_AT }, { itemId: 9, wroteAt: new Date("2026-09-30T00:00:00.000Z") },
      { itemId: 4, wroteAt: COMPLETED_AT }]) {
      expect(decideDemotedLiveListingRestore(evidence({ latestWrite }))).toMatchObject({
        kind: "requires_review", code: "DROPSHIP_LISTING_LIVE_STATUS_UNEXPLAINED",
      });
    }
  });

  it("orders pushes by when they wrote, not by id: an older item that failed after the newest completion explains the status", () => {
    // Item 4 belongs to an older job, retried after item 5 completed, and failed later (an ops or catch-up retry).
    expect(decideDemotedLiveListingRestore(evidence({ latestWrite: { itemId: 4, wroteAt: FAILED_AT } })))
      .toEqual({ kind: "restore", status: "active", basisItemId: 5 });
    // Two writes in the same instant are ordered by id.
    expect(decideDemotedLiveListingRestore(evidence({ latestWrite: { itemId: 6, wroteAt: COMPLETED_AT } })))
      .toEqual({ kind: "restore", status: "active", basisItemId: 5 });
  });
});

describe("isLaterPushItemWrite", () => {
  it("compares by time first, then by id, and is false for the same write", () => {
    const earlier = { itemId: 9, wroteAt: COMPLETED_AT };
    expect(isLaterPushItemWrite({ itemId: 1, wroteAt: FAILED_AT }, earlier)).toBe(true);
    expect(isLaterPushItemWrite(earlier, { itemId: 1, wroteAt: FAILED_AT })).toBe(false);
    expect(isLaterPushItemWrite({ itemId: 10, wroteAt: COMPLETED_AT }, earlier)).toBe(true);
    expect(isLaterPushItemWrite({ itemId: 8, wroteAt: COMPLETED_AT }, earlier)).toBe(false);
    expect(isLaterPushItemWrite(earlier, earlier)).toBe(false);
    // An unreadable time never counts as later.
    expect(isLaterPushItemWrite({ itemId: 99, wroteAt: new Date(Number.NaN) }, earlier)).toBe(false);
  });
});
