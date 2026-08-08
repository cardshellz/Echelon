import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { replacementEndpointBase } from "../MarketplaceListingReplacementDialog";

describe("MarketplaceListingReplacementDialog contract", () => {
  const source = readFileSync(
    resolve(process.cwd(), "client/src/components/marketplace/MarketplaceListingReplacementDialog.tsx"),
    "utf8",
  );

  it("uses the explicit direct-channel rebuild endpoint", () => {
    expect(
      replacementEndpointBase({
        kind: "channel",
        channelId: 67,
        productId: 5,
        marketplaceId: "EBAY_US",
      }),
    ).toBe("/api/ebay/listings/push");
  });

  it("previews before execution and resubmits the exact confirmation", () => {
    expect(source).toContain('rebuild: { mode: "preview" }');
    expect(source).toContain('rebuild: { mode: "execute", preview }');
    expect(source).toContain('sourceState: z.enum(["active", "withdrawn"])');
    expect(source).toContain("confirmationToken: z.string()");
  });

  it("does not expose legacy compensation or manual recovery controls", () => {
    expect(source).not.toContain("manual_recovery_required");
    expect(source).not.toContain("recovering");
    expect(source).not.toContain("compensation");
    expect(source).toContain("Archived - removed");
  });
});
