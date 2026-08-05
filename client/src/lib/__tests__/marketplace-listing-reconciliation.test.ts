import { describe, expect, it } from "vitest";

import { reconcileMarketplaceListing } from "../marketplace-listing-reconciliation";
import type { MarketplaceListingRegistrationStatus } from "../marketplace-listing-registration-status";

const registration = (
  registeredVariantIds: readonly number[],
  externalListingId = "298148438778",
): MarketplaceListingRegistrationStatus => ({
  status: "registered",
  productId: 33,
  registrationId: 1,
  scopeId: 2,
  providerAccountId: 3,
  publicationId: 4,
  providerPublicationKey: "ARM-ENV-SGL",
  externalListingId,
  registeredVariantIds: [...registeredVariantIds],
  registeredAt: "2026-08-05T17:00:00.000Z",
});

describe("marketplace listing reconciliation", () => {
  it("shows no baseline control for an ordinary listing", () => {
    expect(reconcileMarketplaceListing({
      externalListingId: "298148438778",
      desiredVariantIds: [50, 750],
      registration: null,
    })).toEqual({ kind: "normal" });
  });

  it("reports matching registered membership as up to date", () => {
    expect(reconcileMarketplaceListing({
      externalListingId: "298148438778",
      desiredVariantIds: [750, 50],
      registration: registration([50, 750]),
    })).toEqual({ kind: "up_to_date" });
  });

  it("uses ordinary update when membership only gains variants", () => {
    expect(reconcileMarketplaceListing({
      externalListingId: "298148438778",
      desiredVariantIds: [50, 100, 750],
      registration: registration([50, 750]),
    })).toEqual({ kind: "update_available", addedVariantIds: [100] });
  });

  it("requires replacement when registered membership has a stale variant", () => {
    expect(reconcileMarketplaceListing({
      externalListingId: "298148438778",
      desiredVariantIds: [50, 750],
      registration: registration([50, 700]),
    })).toEqual({
      kind: "replacement_required",
      addedVariantIds: [750],
      staleVariantIds: [700],
    });
  });

  it("fails closed when the listing identity changed", () => {
    expect(reconcileMarketplaceListing({
      externalListingId: "999",
      desiredVariantIds: [50, 750],
      registration: registration([50, 700]),
    })).toEqual({ kind: "verification_required", reason: "listing_changed" });
  });
});
