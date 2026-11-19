import { describe, expect, it } from "vitest";
import {
  decideLiveListingZeroQuantityUpdate,
  LIVE_LISTING_ZERO_QUANTITY_STATUSES,
  type LiveListingZeroQuantityListing,
} from "../../domain/live-listing-zero-quantity";
import { DEMOTED_LIVE_LISTING_STATUSES, LIVE_LISTING_STATUSES } from "../../domain/listing-live-status";
import { MARKETPLACE_QUANTITY_UNAVAILABLE_BLOCKER } from "../../domain/marketplace-sync-sweep";

const live: LiveListingZeroQuantityListing = { status: "active", externalListingId: "110001", externalOfferId: "OFFER-1" };
const onlyQuantity = [MARKETPLACE_QUANTITY_UNAVAILABLE_BLOCKER];

describe("decideLiveListingZeroQuantityUpdate", () => {
  it("sends 0 for a live listing whose only blocker is the quantity one", () => {
    expect(decideLiveListingZeroQuantityUpdate({ blockers: onlyQuantity, listing: live }))
      .toEqual({ kind: "send_zero", externalListingId: "110001", externalOfferId: "OFFER-1" });
  });

  it("accepts every live and demoted-live status, and trims the recorded ids", () => {
    for (const status of [...LIVE_LISTING_STATUSES, ...DEMOTED_LIVE_LISTING_STATUSES]) {
      expect(decideLiveListingZeroQuantityUpdate({ blockers: onlyQuantity,
        listing: { status, externalListingId: " 110001 ", externalOfferId: " OFFER-1 " } }))
        .toEqual({ kind: "send_zero", externalListingId: "110001", externalOfferId: "OFFER-1" });
    }
    expect([...LIVE_LISTING_ZERO_QUANTITY_STATUSES].sort())
      .toEqual([...LIVE_LISTING_STATUSES, ...DEMOTED_LIVE_LISTING_STATUSES].sort());
  });

  it("treats a repeated quantity blocker as the only blocker", () => {
    expect(decideLiveListingZeroQuantityUpdate({ blockers: [...onlyQuantity, ...onlyQuantity], listing: live }).kind).toBe("send_zero");
  });

  it.each([
    ["not selected", "variant_not_selected"],
    ["tier off", "listing_tier_not_on_sale"],
    ["store blocked", "store_connection_not_launch_ready"],
    ["missing price", "vendor_retail_price_required"],
  ])("refuses a live listing whose quantity blocker comes with another blocker (%s)", (_name, other) => {
    expect(decideLiveListingZeroQuantityUpdate({ blockers: [MARKETPLACE_QUANTITY_UNAVAILABLE_BLOCKER, other], listing: live }))
      .toEqual({ kind: "refuse", reason: "other_blockers" });
  });

  it("refuses when the quantity blocker is absent (nothing to zero, or another block only)", () => {
    expect(decideLiveListingZeroQuantityUpdate({ blockers: [], listing: live })).toEqual({ kind: "refuse", reason: "no_quantity_blocker" });
    expect(decideLiveListingZeroQuantityUpdate({ blockers: ["variant_not_selected"], listing: live }))
      .toEqual({ kind: "refuse", reason: "no_quantity_blocker" });
  });

  it.each(["ended", "not_listed", "pushing", "draft"])("refuses a listing in a status that is not live (%s)", (status) => {
    expect(decideLiveListingZeroQuantityUpdate({ blockers: onlyQuantity, listing: { ...live, status } }))
      .toEqual({ kind: "refuse", reason: "not_live" });
  });

  it("refuses a listing without an external listing id: never creates a listing at 0", () => {
    for (const externalListingId of [null, "", "   "]) {
      expect(decideLiveListingZeroQuantityUpdate({ blockers: onlyQuantity, listing: { ...live, status: "blocked", externalListingId } }))
        .toEqual({ kind: "refuse", reason: "not_published" });
    }
  });

  it("refuses a listing without a recorded offer id (the write targets that offer)", () => {
    for (const externalOfferId of [null, "", "  "]) {
      expect(decideLiveListingZeroQuantityUpdate({ blockers: onlyQuantity, listing: { ...live, externalOfferId } }))
        .toEqual({ kind: "refuse", reason: "no_offer" });
    }
  });

  it("refuses when no listing row exists", () => {
    expect(decideLiveListingZeroQuantityUpdate({ blockers: onlyQuantity, listing: null })).toEqual({ kind: "refuse", reason: "no_listing" });
  });

  it("does not mutate its input", () => {
    const blockers = Object.freeze([...onlyQuantity]);
    const listing = Object.freeze({ ...live });
    decideLiveListingZeroQuantityUpdate({ blockers, listing });
    expect(listing).toEqual(live);
  });
});
