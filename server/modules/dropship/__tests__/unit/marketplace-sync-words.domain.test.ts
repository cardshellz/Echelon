import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKETPLACE_SYNC_NOTICE_KINDS, type MarketplaceSyncNoticeKind } from "../../domain/marketplace-sync-decision";
import {
  describeMarketplaceSyncNotice,
  MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN,
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
      .toBe(`${ITEM} sells for $6.50 on eBay, below its Card Shellz cost of $7.00. You lose $0.50 on each sale before eBay fees and shipping. We won't change your price. `
        + "If you didn't mean to sell it for less than it costs you, raise its price on eBay.");
  });

  it("name an incompatible policy's reasons in words", () => {
    const text = describeMarketplaceSyncNotice("policy_incompatible", { policyName: "Intl", listingCount: 3,
      reasons: ["international_direct_shipping_unsupported", "local_pickup_unsupported"] });
    expect(text.split("\n").slice(0, 3)).toEqual([
      'Card Shellz can\'t ship orders under your eBay shipping policy "Intl", which 3 of your listings use:',
      "- It offers international shipping, and Card Shellz ships only within the US. Remove the international shipping services from it.",
      "- It offers local pickup, which Card Shellz can't do. Turn off local pickup in it.",
    ]);
  });

  it("say Card Shellz can no longer update a listing whose custom label changed, went missing or became a variation", () => {
    expect(words("sku_changed", { ours: "A", theirs: "B" }))
      .toBe(`The custom label of ${ITEM} on eBay changed from A to B. Card Shellz can't update this listing until it's A again. `
        + "To fix it, change the listing's custom label on eBay back to A.");
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
      message: `The custom label of ${ITEM} on eBay changed from A to B. Card Shellz can't update this listing until it's A again. `
        + "To fix it, change the listing's custom label on eBay back to A.",
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

describe("the shipping policy notice (owner report: which policy, which listings, what's wrong, what to do, where)", () => {
  const LINKS = { listingSettingsUrl: "https://cardshellz.io/catalog/setup" };
  const listing = (index: number) => ({ externalListingId: String(123456789000 + index), title: `Toploaders 3x4 · ${index} pack`,
    sku: `TL-${index}` });
  const policy = (payload: Record<string, unknown> = {}) => describeMarketplaceSyncNotice("policy_incompatible", {
    fulfillmentPolicyId: "6200000000", policyName: "X", listingCount: 2, reasons: ["domestic_shipping_service_required"],
    supportedServiceNames: ["USPS Ground Advantage"], requiredHandlingTimeBusinessDays: 2, marketplaceEnvironment: "production",
    listings: [listing(1), listing(2)], ...payload }, LINKS);

  it("says what's wrong, lists the listings with their eBay pages, numbers the fixes with links, and says what happens meanwhile", () => {
    expect(policy()).toBe([
      'Card Shellz can\'t ship orders under your eBay shipping policy "X", which 2 of your listings use:',
      "- It has no US shipping service. Add a standard US service such as USPS Ground Advantage, or pick a different policy.",
      "",
      "Affected listings:",
      "- Toploaders 3x4 · 1 pack (SKU TL-1), eBay item 123456789001: https://www.ebay.com/itm/123456789001",
      "- Toploaders 3x4 · 2 pack (SKU TL-2), eBay item 123456789002: https://www.ebay.com/itm/123456789002",
      "",
      "To fix it:",
      '1. Edit the policy "X" in eBay Seller Hub > Account > Business policies: https://www.ebay.com/sh/sell-preferences/business-policies',
      "2. Or choose a shipping policy Card Shellz can ship for these products in Card Shellz, Catalog > Listing settings: "
        + "https://cardshellz.io/catalog/setup",
      "",
      "Until then, your listings stay up on eBay and Card Shellz keeps updating them, but orders that need this shipping can't be filled.",
    ].join("\n"));
  });

  it("never says \"you chose\" or shows the policy id; without a name it says \"your eBay shipping policy\"", () => {
    for (const policyName of [undefined, null, "", "   ", 7]) {
      const text = policy({ policyName });
      expect(text).not.toContain("you chose");
      expect(text).not.toContain("6200000000");
      expect(text.split("\n")[0]).toBe("Card Shellz can't ship orders under your eBay shipping policy that 2 of your listings use:");
      expect(text).toContain("1. Edit the policy in eBay Seller Hub > Account > Business policies: ");
    }
  });

  it("says \"uses\" for one listing, and leaves the count out when it is unknown", () => {
    const one = policy({ listingCount: 1, listings: [listing(1)] });
    expect(one.split("\n")[0]).toBe('Card Shellz can\'t ship orders under your eBay shipping policy "X", which 1 of your listings uses:');
    expect(one).not.toContain("more");
    expect(policy({ listingCount: null }).split("\n")[0]).toBe('Card Shellz can\'t ship orders under your eBay shipping policy "X":');
  });

  it(`names at most ${MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN} listings and counts the rest`, () => {
    const listings = Array.from({ length: MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN + 3 }, (_, index) => listing(index + 1));
    const text = policy({ listingCount: 12, listings });
    expect(text.match(/eBay item \d+/g)).toHaveLength(MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN);
    expect(text).toContain(`- and ${12 - MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN} more\n`);
    expect(text).toContain("eBay item 123456789005");
    expect(text).not.toContain("eBay item 123456789006");
  });

  it("links sandbox listings to eBay's sandbox and names the policies page without a production link there", () => {
    const text = policy({ marketplaceEnvironment: "sandbox" });
    expect(text).toContain("eBay item 123456789001: https://sandbox.ebay.com/itm/123456789001");
    expect(text).toContain('1. Edit the policy "X" in eBay Seller Hub > Account > Business policies.\n');
    expect(text).not.toContain("www.ebay.com");
  });

  it("names Listing settings in words when the portal URL is not configured, and skips listings without a usable item number", () => {
    const text = describeMarketplaceSyncNotice("policy_incompatible", { policyName: "X", listingCount: 2,
      reasons: ["local_pickup_unsupported"], listings: [{ externalListingId: "abc", title: "Bad", sku: "B" }, { externalListingId: "123456789",
        title: "", sku: null }] });
    expect(text).toContain("Catalog > Listing settings, in your Card Shellz dropship portal.");
    expect(text).not.toContain("Bad");
    expect(text).toContain("- A listing, eBay item 123456789: https://www.ebay.com/itm/123456789\n- and 1 more");
  });

  const REASONS: Array<[string, string]> = [
    ["domestic_shipping_service_required", "It has no US shipping service. Add a standard US service such as USPS Ground Advantage, or pick a different policy."],
    ["international_direct_shipping_unsupported", "It offers international shipping, and Card Shellz ships only within the US. Remove the international shipping services from it."],
    ["local_pickup_unsupported", "It offers local pickup, which Card Shellz can't do. Turn off local pickup in it."],
    ["pickup_drop_off_unsupported", "It offers pickup or drop-off, which Card Shellz can't do. Turn off pickup and drop-off in it."],
    ["freight_shipping_unsupported", "It uses freight shipping, which Card Shellz can't do. Use a standard package service instead such as USPS Ground Advantage."],
    ["handling_time_too_short", "Its handling time is shorter than Card Shellz needs. Set it to at least 2 business days, or pick a different policy."],
    ["handling_time_missing", "It has no handling time. Set one of at least 2 business days, or pick a different policy."],
    ["handling_time_unit_unsupported", "Its handling time isn't set in business days. Set it in business days, to at least 2 business days, or pick a different policy."],
    ["shipping_option_type_unsupported", "It has a kind of shipping option Card Shellz doesn't offer. Keep only US (domestic) shipping options in it."],
    ["marketplace_missing", "eBay didn't say which eBay site it is for. Use a policy made for the eBay site your store sells on."],
    ["marketplace_mismatch", "It is for a different eBay site than your store. Use a policy made for the eBay site your store sells on."],
    ["destination_coverage_incomplete", "Card Shellz couldn't confirm every US place it ships to, so it couldn't check this policy. This part is on Card Shellz's side, and it checks again on its own."],
    ["shipping_service_unsupported:USPSPriority", "It uses the shipping service USPSPriority, which Card Shellz doesn't ship with. Replace it with a service Card Shellz ships with such as USPS Ground Advantage."],
  ];
  it.each(REASONS)("words the reason %s as what the policy does and what to change", (reason, sentence) => {
    expect(policy({ reasons: [reason] }).split("\n")[1]).toBe(`- ${sentence}`);
  });

  it("covers every issue code the compatibility check can raise", () => {
    const source = readFileSync(resolve(process.cwd(), "server/modules/dropship/domain/ebay-fulfillment-policy-compatibility.ts"), "utf8");
    const codes = [...source.matchAll(/issue\(\s*[`"]([a-z_]+)[:`"]/g)].map((match) => match[1]);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) {
      const reason = code === "shipping_service_unsupported" ? "shipping_service_unsupported:FedExGround" : code;
      expect(REASONS.some(([known]) => known.split(":")[0] === reason.split(":")[0]), code).toBe(true);
      expect(policy({ reasons: [reason] })).not.toContain("a setting Card Shellz can't ship under");
    }
  });

  it("names only Card Shellz's own services, never one it was not given, and never echoes an odd service code", () => {
    expect(policy({ supportedServiceNames: [] }).split("\n")[1])
      .toBe("- It has no US shipping service. Add a standard US service, or pick a different policy.");
    expect(policy({ supportedServiceNames: ["USPS Ground Advantage", "UPS Ground", "FedEx Ground", "FedEx 2Day"] }).split("\n")[1])
      .toBe("- It has no US shipping service. Add a standard US service such as USPS Ground Advantage, UPS Ground or FedEx Ground, or pick a different policy.");
    expect(policy({ reasons: ["shipping_service_unsupported:<b>x</b>"] }).split("\n")[1]).toContain("It uses a shipping service, which");
    expect(policy({ requiredHandlingTimeBusinessDays: null, reasons: ["handling_time_too_short"] }).split("\n")[1])
      .toBe("- Its handling time is shorter than Card Shellz needs. Set a longer handling time, or pick a different policy.");
  });

  it("falls back to one plain sentence for unknown or missing reasons, never to a code or a prototype key", () => {
    for (const reasons of [undefined, [], ["toString"], ["__proto__", 4]]) {
      expect(policy({ reasons }).split("\n")[1])
        .toBe("- It has a setting Card Shellz can't ship under. Check its shipping services, handling time and pickup options.");
    }
  });

  it("keeps policy notices in one batch apart by a blank line", () => {
    const one = { policyName: "A", listingCount: 1, reasons: ["local_pickup_unsupported"] };
    const message = describeMarketplaceSyncNoticeBatch("policy_incompatible", [one, { ...one, policyName: "B" }], LINKS).message;
    expect(message).toContain("can't be filled.\n\nCard Shellz can't ship orders under your eBay shipping policy \"B\"");
  });
});
