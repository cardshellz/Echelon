import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { listingChangesEndpointBase } from "../MarketplaceListingChangesDialog";

describe("MarketplaceListingChangesDialog contract", () => {
  const source = readFileSync(
    resolve(process.cwd(), "client/src/components/marketplace/MarketplaceListingChangesDialog.tsx"),
    "utf8",
  );

  it("uses the owning direct-channel listing endpoint", () => {
    expect(
      listingChangesEndpointBase({
        kind: "channel",
        channelId: 67,
        productId: 5,
        marketplaceId: "EBAY_US",
      }),
    ).toBe("/api/ebay/listings/push");
  });

  it("previews live membership before either explicit action", () => {
    expect(source).toContain('rebuild: { mode: "preview" }');
    expect(source).toContain('updateExisting: { mode: "execute" as const, preview }');
    expect(source).toContain('rebuild: { mode: "execute" as const, preview }');
    expect(source).toContain('sourceState: z.enum(["active", "withdrawn"])');
    expect(source).toContain("confirmationToken: z.string()");
  });

  it("recommends preserving the listing and labels replacement as a last resort", () => {
    expect(source).toContain("Review eBay listing changes");
    expect(source).toContain("Update existing listing");
    expect(source).toContain("Replace listing instead");
    expect(source).toContain("Replace listing is a last resort.");
    expect(source).toContain("keeps listing ID");
  });

  it("supports verification without mutation when live membership already matches", () => {
    expect(source).toContain("Save verified state");
    expect(source).toContain("refreshListingAnalysis");
    expect(source).toContain("expectedObservationHash");
  });

  it("does not expose legacy compensation or manual recovery controls", () => {
    expect(source).not.toContain("manual_recovery_required");
    expect(source).not.toContain("recovering");
    expect(source).not.toContain("compensation");
  });
});
