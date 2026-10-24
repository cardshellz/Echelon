import { describe, expect, it } from "vitest";
import { saveContentProfileInputSchema, saveListingContentInputSchema } from "../../../../../shared/dropship/listing-content";
import { saveListingPriceInputSchema } from "../../../../../shared/dropship/listing-price";
import {
  isReservedConversionKey,
  isReservedMarketplaceSyncKey,
  MARKETPLACE_SYNC_KEY_PREFIX,
  RESERVED_CONVERSION_KEY_MESSAGE,
  RESERVED_MARKETPLACE_SYNC_KEY_MESSAGE,
} from "../../../../../shared/dropship/listing-rules-conversion-keys";
import { listingSettingRequestKeySchema } from "../../../../../shared/dropship/listing-setting-values";
import { DropshipError } from "../../domain/errors";
import { isReservedListingPushJobKey } from "../../domain/listing-push-run";
import {
  MARKETPLACE_SYNC_ACTOR,
  marketplaceBelowCostSubjectKey,
  marketplaceItemSubjectKey,
  marketplaceListingSubjectKey,
  marketplaceNoticeBatchKey,
  marketplacePolicyAdoptionKey,
  marketplacePolicySubjectKey,
  marketplacePriceAdoptionKey,
  marketplaceQuantityLimitKey,
  marketplaceQuantityRestoreJobKey,
  shortHash,
  utcDay,
} from "../../domain/marketplace-sync-keys";

const KEY = /^[A-Za-z0-9:_-]+$/;
const AT = new Date("2026-10-22T23:59:59.999Z");

function issues(schema: { safeParse(value: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } } }, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error!.issues.map((issue) => issue.message);
}

describe("sync-back system keys (plan v4 §6.6)", () => {
  it("builds every revision and job key under the reserved prefix, key-safe and at most 200 characters", () => {
    const keys = [
      marketplacePriceAdoptionKey({ listingId: 77, priceCents: 1400, expectedRevisionId: 12 }),
      marketplacePriceAdoptionKey({ listingId: 77, priceCents: 1400, expectedRevisionId: null }),
      marketplacePolicyAdoptionKey({ listingId: 77, fulfillmentPolicyId: "F-9", returnPolicyId: "R-1", paymentPolicyId: "P-1", expectedRevisionId: null }),
      marketplaceQuantityLimitKey({ listingId: 77, observedAt: AT, quantity: 0 }),
      marketplaceQuantityRestoreJobKey({ storeConnectionId: 22, listingIds: [77, 5, 77], maxEventId: 901 }),
    ];
    for (const key of keys) {
      expect(key.startsWith(MARKETPLACE_SYNC_KEY_PREFIX)).toBe(true);
      expect(key).toMatch(KEY);
      expect(key.length).toBeLessThanOrEqual(200);
    }
    expect(keys[0]).toBe("ebay-sync:price:77:1400:12");
    expect(keys[1]).toBe("ebay-sync:price:77:1400:none");
    expect(keys[3]).toBe(`ebay-sync:qty-limit:77:${AT.getTime()}:0`);
  });

  it("is deterministic and tells changes apart", () => {
    const policy = (fulfillmentPolicyId: string, expectedRevisionId: number | null) => marketplacePolicyAdoptionKey({
      listingId: 77, fulfillmentPolicyId, returnPolicyId: "R-1", paymentPolicyId: "P-1", expectedRevisionId });
    expect(policy("F-9", null)).toBe(policy("F-9", null));
    expect(policy("F-9", null)).not.toBe(policy("F-8", null));
    expect(policy("F-9", null)).not.toBe(policy("F-9", 4));
    // A restore job is one per set of sizes, in any order.
    expect(marketplaceQuantityRestoreJobKey({ storeConnectionId: 22, listingIds: [5, 77], maxEventId: 9 }))
      .toBe(marketplaceQuantityRestoreJobKey({ storeConnectionId: 22, listingIds: [77, 5], maxEventId: 9 }));
  });

  it("puts each notice batch's id range in its key, so a late row never joins a batch already sent", () => {
    expect(marketplaceNoticeBatchKey({ kind: "price_below_cost", storeConnectionId: 22, minNoticeId: 4, maxNoticeId: 9 }))
      .toBe("ebay-sync:price_below_cost:22:4-9");
    expect(marketplaceNoticeBatchKey({ kind: "sku_changed", storeConnectionId: 22, minNoticeId: 10, maxNoticeId: 10 }))
      .toBe("ebay-sync:sku_changed:22:10-10");
  });

  it("builds subject keys per listing, per day for below cost, per policy verdict and per item", () => {
    expect(marketplaceListingSubjectKey(77, "price", "1400", "1")).toBe("listing:77:price:1400:1");
    expect(marketplaceBelowCostSubjectKey(77, AT)).toBe("below-cost:77:2026-10-22");
    expect(marketplacePolicySubjectKey("F-9", "b".repeat(64), new Date(1_700_000_000_000)))
      .toBe(`policy:${shortHash("F-9")}:${"b".repeat(16)}:1700000000000`);
    expect(marketplaceItemSubjectKey("110000000001")).toBe("item:110000000001");
    expect(utcDay(new Date("2026-10-23T00:00:00.000Z"))).toBe("2026-10-23");
    expect(shortHash("x")).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each([
    ["a zero listing id", () => marketplacePriceAdoptionKey({ listingId: 0, priceCents: 1, expectedRevisionId: null })],
    ["a fractional price", () => marketplacePriceAdoptionKey({ listingId: 1, priceCents: 1.5, expectedRevisionId: null })],
    ["a negative quantity", () => marketplaceQuantityLimitKey({ listingId: 1, observedAt: AT, quantity: -1 })],
    ["an invalid instant", () => marketplaceQuantityLimitKey({ listingId: 1, observedAt: new Date(Number.NaN), quantity: 1 })],
    ["an empty restore job", () => marketplaceQuantityRestoreJobKey({ storeConnectionId: 1, listingIds: [], maxEventId: 1 })],
    ["a reversed batch range", () => marketplaceNoticeBatchKey({ kind: "sku_changed", storeConnectionId: 1, minNoticeId: 5, maxNoticeId: 4 })],
    ["a kind with capitals", () => marketplaceNoticeBatchKey({ kind: "Price", storeConnectionId: 1, minNoticeId: 1, maxNoticeId: 1 })],
    ["an item id with a space", () => marketplaceItemSubjectKey("1 2")],
    ["a part with a slash", () => marketplaceListingSubjectKey(1, "a/b")],
    ["a key over 200 characters", () => marketplaceListingSubjectKey(1, "x".repeat(200))],
  ])("refuses %s as a defect (fatal), never as data", (_name, build) => {
    let caught: unknown;
    try { build(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DropshipError);
    expect(caught).toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_KEY_INVALID", context: { classification: "fatal", retryable: false } });
  });

  it("writes as the system actor", () => {
    expect(MARKETPLACE_SYNC_ACTOR).toEqual({ actorType: "system", actorId: "system:ebay-sync-back" });
  });
});

describe("the reserved `ebay-sync:` prefix (SB34)", () => {
  it("is reserved, leading spaces and all, and only as a prefix", () => {
    expect(isReservedMarketplaceSyncKey("ebay-sync:price:77:1400:none")).toBe(true);
    expect(isReservedMarketplaceSyncKey("  ebay-sync:x")).toBe(true);
    expect(isReservedMarketplaceSyncKey("listing-content:ebay-sync:x")).toBe(false);
    expect(isReservedMarketplaceSyncKey("EBAY-SYNC:x")).toBe(false);
    // It is not a conversion key: each refusal keeps its own words.
    expect(isReservedConversionKey("ebay-sync:x")).toBe(false);
  });

  it("is refused by the content, template, listing-settings and W9 price key schemas", () => {
    const content = { customText: null, expectedRevisionId: null, expectedCatalogHash: "a".repeat(64), expectedProfileRevisionId: null };
    expect(issues(saveListingContentInputSchema, { ...content, idempotencyKey: "ebay-sync:content:77:abc" })).toEqual([RESERVED_MARKETPLACE_SYNC_KEY_MESSAGE]);
    expect(issues(saveListingContentInputSchema, { ...content, idempotencyKey: "listing-content:4f2e" })).toEqual([]);
    const profile = { expectedRevisionId: null, profile: { defaultTemplate: { introduction: "", footer: "" }, groups: [] } };
    expect(issues(saveContentProfileInputSchema, { ...profile, idempotencyKey: "ebay-sync:x" })).toEqual([RESERVED_MARKETPLACE_SYNC_KEY_MESSAGE]);
    expect(issues(listingSettingRequestKeySchema, "ebay-sync:policy:77:abc")).toEqual([RESERVED_MARKETPLACE_SYNC_KEY_MESSAGE]);
    expect(issues(saveListingPriceInputSchema, { priceCents: 1400, pricingMode: "fixed", expectedRevisionId: null,
      idempotencyKey: "ebay-sync:price:77:1400:none" })).toEqual([RESERVED_MARKETPLACE_SYNC_KEY_MESSAGE]);
    expect(issues(saveListingPriceInputSchema, { priceCents: 1400, pricingMode: "fixed", expectedRevisionId: null,
      idempotencyKey: "listing-price:77" })).toEqual([]);
  });

  it("keeps the conversion refusal and its words unchanged", () => {
    expect(issues(listingSettingRequestKeySchema, "rules-conversion:22")).toEqual([RESERVED_CONVERSION_KEY_MESSAGE]);
    expect(issues(listingSettingRequestKeySchema, "lc:abc:kind:1")).toEqual([RESERVED_CONVERSION_KEY_MESSAGE]);
  });

  it("is refused for a vendor's push job, as a run chunk's key is", () => {
    expect(isReservedListingPushJobKey("ebay-sync:quantity:22:abc:9")).toBe(true);
    expect(isReservedListingPushJobKey("dropship-run:10:7:0")).toBe(true);
    expect(isReservedListingPushJobKey("listing-push-0001")).toBe(false);
  });
});
