import { describe, expect, it } from "vitest";
import {
  describeListingPushOutcome,
  listingPushJobUrl,
  listingPushNextStep,
  listingPushPollingContinues,
  LISTING_PUSH_MAX_POLLS,
  listingPushStoreLabel,
  parseDropshipListingPushJob,
  type DropshipListingPushItem,
  type DropshipListingPushJob,
} from "../dropship-listing-push-status";

function item(patch: Partial<DropshipListingPushItem> = {}): DropshipListingPushItem {
  return {
    itemId: 1, listingId: 100, productVariantId: 101, sku: "ARM-ENV-SGL-P50", productName: "Armalope Envelope Single Pocket",
    variantName: "Pack of 50", status: "completed", errorCode: null, errorMessage: null, retryable: null,
    externalListingId: "123456789012", listingUrl: "https://www.ebay.com/itm/123456789012", ...patch,
  };
}

function job(patch: Partial<DropshipListingPushJob> = {}): DropshipListingPushJob {
  return {
    jobId: 31, storeConnectionId: 5, platform: "ebay", status: "completed", finished: true,
    createdAt: "2026-09-28T17:55:00.000Z", updatedAt: "2026-09-28T17:55:30.000Z", completedAt: "2026-09-28T17:55:30.000Z",
    items: [item()], ...patch,
  };
}

describe("listing push status transport", () => {
  it("builds the job url only from a valid id and parses the strict response", () => {
    expect(listingPushJobUrl(31)).toBe("/api/dropship/listing-push-jobs/31");
    expect(() => listingPushJobUrl(0)).toThrow("The listing push id is invalid.");
    expect(parseDropshipListingPushJob({ job: job() })).toEqual(job());
    expect(() => parseDropshipListingPushJob({ job: { ...job(), extra: 1 } })).toThrow("The listing push status response was invalid");
    expect(() => parseDropshipListingPushJob({ job: { ...job(), items: [item({ listingUrl: "javascript:alert(1)" })] } })).toThrow();
  });
});

describe("listingPushPollingContinues", () => {
  it("asks again until the job is finished or the answer limit is reached", () => {
    expect(listingPushPollingContinues(undefined, 0)).toBe(true);
    expect(listingPushPollingContinues(job({ status: "processing", finished: false, completedAt: null }), LISTING_PUSH_MAX_POLLS - 1)).toBe(true);
    expect(listingPushPollingContinues(job({ status: "processing", finished: false, completedAt: null }), LISTING_PUSH_MAX_POLLS)).toBe(false);
    expect(listingPushPollingContinues(job(), 1)).toBe(false);
  });
});

describe("describeListingPushOutcome", () => {
  it("says a listing is live, with its page, once the job finished", () => {
    expect(describeListingPushOutcome(job(), "marz_cards")).toEqual({
      tone: "success",
      title: "Live on marz_cards: 1 listing.",
      items: [{ itemId: 1, name: "Armalope Envelope Single Pocket · Pack of 50 · ARM-ENV-SGL-P50", state: "live",
        line: "Live on marz_cards.", nextStep: null, listingUrl: "https://www.ebay.com/itm/123456789012" }],
    });
  });

  it("says a listing is still on its way while the worker runs", () => {
    const outcome = describeListingPushOutcome(job({ status: "processing", finished: false, completedAt: null,
      items: [item({ status: "processing", externalListingId: null, listingUrl: null })] }), null);
    expect(outcome.tone).toBe("pending");
    expect(outcome.title).toBe("Sending 1 listing to eBay. This usually takes under a minute; the result shows here.");
    expect(outcome.items[0]).toMatchObject({ state: "pending", line: "Sending to eBay…", listingUrl: null });
  });

  it("gives the store's reason and the step to take when a listing could not be listed", () => {
    const outcome = describeListingPushOutcome(job({ status: "failed", items: [item({
      status: "failed", errorCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", retryable: false,
      errorMessage: "eBay listing push failed with HTTP 400: 25002 Invalid value for aspect (aspect: Brand)", listingUrl: null,
    })] }), "marz_cards");
    expect(outcome.tone).toBe("failed");
    expect(outcome.title).toBe("Could not list 1 listing on marz_cards.");
    expect(outcome.items[0]).toMatchObject({
      state: "failed",
      line: "Could not list: eBay listing push failed with HTTP 400: 25002 Invalid value for aspect (aspect: Brand)",
      nextStep: "Fix what the store named, then queue the listing again.",
      listingUrl: null,
    });
  });

  it("counts a mixed result", () => {
    const outcome = describeListingPushOutcome(job({ status: "failed", items: [
      item(), item({ itemId: 2, status: "failed", errorCode: "DROPSHIP_LISTING_PREVIEW_DRIFT", errorMessage: "Listing changed.", retryable: false, listingUrl: null }),
      item({ itemId: 3, status: "blocked", errorCode: "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", errorMessage: null, retryable: false, listingUrl: null }),
    ] }), "marz_cards");
    expect(outcome.tone).toBe("partial");
    expect(outcome.title).toBe("1 of 3 listings live on marz_cards; 2 could not be listed.");
    expect(outcome.items[2]).toMatchObject({ line: "Could not list: the store did not say why",
      nextStep: "Your account or store cannot list right now. See the notice at the top of this card." });
  });
});

describe("listingPushNextStep", () => {
  it("separates a temporary store problem from something the vendor must fix", () => {
    expect(listingPushNextStep("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", true)).toBe("This was a temporary problem at the store. Queue the listing again in a few minutes.");
    expect(listingPushNextStep("DROPSHIP_SHOPIFY_LISTING_PUSH_HTTP_ERROR", false)).toBe("Fix what the store named, then queue the listing again.");
    expect(listingPushNextStep("DROPSHIP_LISTING_PRICE_AWAITING_REVIEW", false)).toContain("Check the price on this page");
    expect(listingPushNextStep("SOMETHING_NEW", true)).toContain("Queue the listing again in a few minutes.");
    expect(listingPushNextStep(null, null)).toBe("Fix the reason above and queue the listing again, or contact support with this message.");
  });
});

describe("listingPushStoreLabel", () => {
  it("prefers the store's name, then the marketplace, then plain words", () => {
    expect(listingPushStoreLabel("ebay", " marz_cards ")).toBe("marz_cards");
    expect(listingPushStoreLabel("ebay", null)).toBe("eBay");
    expect(listingPushStoreLabel("shopify", "")).toBe("your store");
  });
});
