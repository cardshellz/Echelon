import { describe, expect, it, vi } from "vitest";
import { EbayListingPushService, EbayListingPushSkipped, ebayListingPushFailure, ebayListingPushRequestSchema } from "../../ebay-listing-push.service";

describe("shared eBay publication batch", () => {
  it.each(["EBAY_CATALOG_PHOTO_REQUIRED", "EBAY_LISTING_PREFLIGHT_FAILED", "STOCK_LISTING_ATP_NOT_READY", "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED", "EBAY_AUTH_REQUIRED"])(
    "isolates %s and emits its actionable result before continuing other products", async code => {
      const execute = vi.fn(async (id: number) => {
        if (id === 1) throw Object.assign(new Error("The first product cannot proceed."), { code });
        return { productId: id, productName: "Second", success: true, status: "success" as const, variantCount: 2, listingId: "listing-2" };
      });
      const onProduct = vi.fn();
      const result = await new EbayListingPushService({ execute }).push({ productIds: [1, 2] }, { onProduct });
      expect(result.summary).toEqual({ succeeded: 1, failed: 1, skipped: 0, total: 2 });
      expect(result.results[0]).toMatchObject({ productId: 1, success: false, code, issue: { code } });
      expect(result.results[0].issue?.nextStep).toBeTruthy();
      expect(result.results[1].listingId).toBe("listing-2");
      expect(onProduct).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls.map(args => args[0])).toEqual([1, 2]);
    });

  it("stops only between completed product workflows when the stream disconnects", async () => {
    let cancelled = false;
    const execute = vi.fn(async (id: number) => {
      cancelled = true;
      return { productId: id, productName: "Finished", success: true, status: "success" as const, variantCount: 1 };
    });
    const result = await new EbayListingPushService({ execute }).push({ productIds: [1, 2] }, { cancelled: () => cancelled });
    expect(result.summary).toMatchObject({ total: 1, succeeded: 1 });
    expect(result.cancelled).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("counts exclusions separately and redacts sensitive provider diagnostics", async () => {
    const execute = vi.fn(async () => { throw new EbayListingPushSkipped("Product is excluded."); });
    const result = await new EbayListingPushService({ execute }).push({ productIds: [1] });
    expect(result.summary).toEqual({ succeeded: 0, failed: 0, skipped: 1, total: 1 });
    expect(ebayListingPushFailure(1, new Error("Authorization: Bearer secret https://user:pass@example.com" )).error).not.toContain("secret");
  });

  it.each([[1, 1], [0], [-1], [2_147_483_648], [], Array.from({ length: 501 }, (_, i) => i + 1)].map(productIds => ({ productIds })))("rejects invalid scope before provider work", async ({ productIds }) => {
    const execute = vi.fn();
    await expect(new EbayListingPushService({ execute }).push({ productIds })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a reviewed confirmation for another product", () => {
    expect(ebayListingPushRequestSchema.safeParse({ productIds: [1], updateExisting: { mode: "execute", preview: {
      productId: 2, groupKey: "group", currentExternalListingId: "listing", sourceState: "active", currentSkus: ["sku"],
      activeSkus: ["sku"], inactiveSkus: [], desiredSkus: ["sku"], addedSkus: [], removedSkus: [], rebuildRequired: false,
      confirmationToken: "a".repeat(64),
    } } }).success).toBe(false);
  });

  it("does not expose database query details as a provider diagnostic", () => {
    const failure = ebayListingPushFailure(20, Object.assign(new Error("duplicate key: confidential database value"), { code: "23505" }));
    expect(failure.code).toBe("EBAY_LISTING_OPERATION_FAILED");
    expect(failure.issue?.action.kind).toBe("contact_support");
    expect(JSON.stringify(failure)).not.toContain("confidential");
  });
});
