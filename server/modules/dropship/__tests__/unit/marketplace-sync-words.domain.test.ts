import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKETPLACE_SYNC_NOTICE_KINDS, type MarketplaceSyncNoticeKind } from "../../domain/marketplace-sync-decision";
import {
  describeMarketplaceSyncNotice,
  describeMarketplaceSyncNoticeBatch,
  dollars,
  MARKETPLACE_SYNC_MESSAGE_MAX_CHARS,
  MARKETPLACE_SYNC_NOTICE_TITLES,
} from "../../domain/marketplace-sync-words";

const ITEM = "Toploaders 3x4 · 100 pack";
const words = (kind: MarketplaceSyncNoticeKind, payload: Record<string, unknown> = {}) =>
  describeMarketplaceSyncNotice(kind, { itemLabel: ITEM, ...payload });

describe("sync-back vendor words (plan v4 §10, owner rule 7, PROPOSED)", () => {
  it("are marked PROPOSED (sync-back) in their one file", () => {
    const source = readFileSync(resolve(process.cwd(), "server/modules/dropship/domain/marketplace-sync-words.ts"), "utf8");
    expect(source.split("\n")[0]).toBe("// PROPOSED (sync-back)");
  });

  it("have a title and words for every notice kind, with no code, id field name or placeholder in them", () => {
    for (const kind of Object.keys(MARKETPLACE_SYNC_NOTICE_KINDS) as MarketplaceSyncNoticeKind[]) {
      const text = words(kind);
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/DROPSHIP_|undefined|null|NaN|\{|\}|[a-z]+_[a-z]+/);
      expect(MARKETPLACE_SYNC_NOTICE_TITLES[kind]).toBeTruthy();
    }
  });

  it("name the loss of a below-cost price in dollars, from integer cents", () => {
    expect(words("price_below_cost", { priceCents: 650, unitCostCents: 700 }))
      .toBe(`${ITEM} sells for $6.50 on eBay, below its Card Shellz cost of $7.00. You lose $0.50 on each sale before eBay fees and shipping. We won't change your price.`);
  });

  it("name an incompatible policy's reasons in words", () => {
    expect(describeMarketplaceSyncNotice("policy_incompatible", { policyName: "Intl", listingCount: 3,
      reasons: ["international_direct_shipping_unsupported", "local_pickup_unsupported"] }))
      .toContain('Your eBay shipping policy "Intl" (3 listings) promises international shipping and local pickup, which Card Shellz can\'t do.');
  });

  it("say Card Shellz can no longer update a listing whose custom label changed, went missing or became a variation", () => {
    expect(words("sku_changed", { ours: "A", theirs: "B" }))
      .toBe(`The custom label of ${ITEM} on eBay changed from A to B. Card Shellz can't update this listing until it's A again.`);
    expect(words("offer_missing")).toContain("so we can't update it.");
    expect(words("variation_unsupported")).toContain("We've stopped updating it.");
  });

  it("OR-7: tell a listing type change apart from a multi-variation listing", () => {
    expect(words("variation_unsupported", { reason: "group" })).toContain("is now part of a multi-variation listing on eBay");
    const format = words("variation_unsupported", { reason: "format" });
    expect(format).not.toContain("multi-variation");
    expect(format).toBe(`The eBay listing type of ${ITEM} changed to one Card Shellz can't update, so we've stopped updating it. `
      + `Publish the size from Card Shellz again as a fixed-price listing.`);
    expect(MARKETPLACE_SYNC_NOTICE_TITLES.variation_unsupported).not.toContain("multi-variation");
  });

  it("show money as dollars from integer cents only", () => {
    expect(dollars(0)).toBe("$0.00");
    expect(dollars(5)).toBe("$0.05");
    expect(dollars(123456789)).toBe("$1,234,567.89");
    expect(dollars(1.5)).toBe("an unknown amount");
    expect(dollars(-1)).toBe("an unknown amount");
    expect(dollars("12")).toBe("an unknown amount");
  });

  it("title a batch by its kind, with one line per row", () => {
    expect(describeMarketplaceSyncNoticeBatch("sku_changed", [{ itemLabel: ITEM, ours: "A", theirs: "B" }])).toEqual({
      title: "An eBay custom label changed",
      message: `The custom label of ${ITEM} on eBay changed from A to B. Card Shellz can't update this listing until it's A again.`,
    });
    expect(describeMarketplaceSyncNoticeBatch("offer_missing", [{ itemLabel: "One" }, { itemLabel: "Two" }]).message)
      .toBe(`${words("offer_missing", { itemLabel: "One" })}\n${words("offer_missing", { itemLabel: "Two" })}`);
  });

  it("keep a batch inside the notification's message limit and count the rest", () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ itemLabel: `Item ${index}` }));
    const batch = describeMarketplaceSyncNoticeBatch("offer_missing", many);
    expect(batch.message.length).toBeLessThanOrEqual(MARKETPLACE_SYNC_MESSAGE_MAX_CHARS);
    expect(batch.message).toMatch(/\nAnd \d+ more like this\.$/);
  });

  it("fall back to plain words for a missing item name", () => {
    expect(describeMarketplaceSyncNotice("offer_missing", {})).toContain("Card Shellz can't find a listing on your eBay account");
  });
});
