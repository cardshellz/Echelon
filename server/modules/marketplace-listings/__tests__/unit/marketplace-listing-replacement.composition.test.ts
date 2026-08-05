import { describe, expect, it } from "vitest";

import { marketplaceListingReplacementExecutionEnabled } from "../../../../marketplace-listing-replacement.composition";

describe("marketplace listing replacement rollout gate", () => {
  it("defaults execution off", () => {
    expect(marketplaceListingReplacementExecutionEnabled({})).toBe(false);
  });

  it("requires the exact explicit true value", () => {
    expect(
      marketplaceListingReplacementExecutionEnabled({
        MARKETPLACE_LISTING_REPLACEMENT_EXECUTION_ENABLED: "true",
      }),
    ).toBe(true);
    expect(
      marketplaceListingReplacementExecutionEnabled({
        MARKETPLACE_LISTING_REPLACEMENT_EXECUTION_ENABLED: "TRUE",
      }),
    ).toBe(false);
  });
});
