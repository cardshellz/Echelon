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
  type MarketplaceSyncNoticeLinks,
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
    expect(text.split("\n").slice(0, 4)).toEqual([
      'Your eBay shipping policy "Intl" has settings Card Shellz can\'t ship under:',
      "- It offers shipping to buyers outside the US. Card Shellz only ships to addresses in the US.",
      "- It offers local pickup. Card Shellz ships every order from its warehouse, so a buyer can't pick it up in person.",
      "So orders on the 3 listings below can't be shipped.",
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

describe("the shipping policy notice as a guided fix (owner report)", () => {
  const LINKS: MarketplaceSyncNoticeLinks = { listingSettingsUrl: "https://cardshellz.io/catalog/setup" };
  const POLICIES_URL = "https://www.ebay.com/sh/sell-preferences/business-policies";
  const listing = (index: number) => ({ externalListingId: String(123456789000 + index), title: `Toploaders 3x4 · ${index} pack`,
    sku: `TL-${index}` });
  const policy = (payload: Record<string, unknown> = {}, links = LINKS) => describeMarketplaceSyncNotice("policy_incompatible", {
    fulfillmentPolicyId: "6200000000", policyName: "X", listingCount: 2, reasons: ["domestic_shipping_service_required"],
    supportedServiceNames: ["USPS Ground Advantage"], requiredHandlingTimeBusinessDays: 2, marketplaceEnvironment: "production",
    listings: [listing(1), listing(2)], ...payload }, links);
  const steps = (text: string) => text.split("\n").filter((line) => /^\d\. /.test(line));

  it("explains the domestic problem plainly, lists the listings, numbers the clicks, offers Listing settings and says what happens meanwhile", () => {
    expect(policy()).toBe([
      'Your eBay shipping policy "X" doesn\'t offer any shipping to buyers in the US. Card Shellz ships every order from the US by '
        + "USPS Ground Advantage, so orders on the 2 listings below can't be shipped.",
      "",
      "Affected listings:",
      "- Toploaders 3x4 · 1 pack (SKU TL-1), eBay item 123456789001: https://www.ebay.com/itm/123456789001",
      "- Toploaders 3x4 · 2 pack (SKU TL-2), eBay item 123456789002: https://www.ebay.com/itm/123456789002",
      "",
      "How to fix it (about 2 minutes):",
      `1. Open your shipping policies on eBay: Seller Hub > Account > Business policies (${POLICIES_URL}), and find "X" in the list.`,
      "2. Under Domestic shipping, add a service, for example USPS Ground Advantage.",
      "3. Save. eBay updates every listing that uses this policy.",
      "Card Shellz checks the policy again, usually within about 15 minutes. You don't need to do anything else.",
      "",
      "Or, instead: in Card Shellz, go to Catalog > Listing settings (https://cardshellz.io/catalog/setup) and choose a shipping policy "
        + "Card Shellz can ship for these products or their category. Card Shellz sends it to these listings the next time it sends them "
        + "to eBay: when you publish them, or when Card Shellz updates them.",
      "",
      "Until it's fixed: your listings stay up on eBay and Card Shellz keeps updating them, but orders that need this shipping can't be filled.",
    ].join("\n"));
  });

  it("never says \"you chose\" or shows the policy id; without a name it says \"Your eBay shipping policy\"", () => {
    for (const policyName of [undefined, null, "", "   ", 7]) {
      const text = policy({ policyName });
      expect(text).not.toContain("you chose");
      expect(text).not.toContain("6200000000");
      expect(text.startsWith("Your eBay shipping policy doesn't offer any shipping to buyers in the US.")).toBe(true);
      expect(steps(text)[0]).toContain("and find the shipping policy these listings use.");
    }
  });

  it("says \"the listing below\" for one listing, and \"these listings\" when the count is unknown", () => {
    const one = policy({ listingCount: 1, listings: [listing(1)] });
    expect(one.split("\n")[0]).toContain("so orders on the listing below can't be shipped.");
    expect(one).not.toContain("more");
    expect(policy({ listingCount: null }).split("\n")[0]).toContain("so orders on these listings can't be shipped.");
  });

  it(`names at most ${MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN} listings and counts the rest`, () => {
    const listings = Array.from({ length: MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN + 3 }, (_, index) => listing(index + 1));
    const text = policy({ listingCount: 12, listings });
    expect(text.match(/eBay item \d+/g)).toHaveLength(MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN);
    expect(text).toContain(`- and ${12 - MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN} more\n`);
    expect(text).not.toContain("eBay item 123456789006");
  });

  it("links sandbox listings to eBay's sandbox and names the policies page without a production link there", () => {
    const text = policy({ marketplaceEnvironment: "sandbox" });
    expect(text).toContain("eBay item 123456789001: https://sandbox.ebay.com/itm/123456789001");
    expect(steps(text)[0]).toBe('1. Open your shipping policies on eBay: Seller Hub > Account > Business policies, and find "X" in the list.');
    expect(text).not.toContain("www.ebay.com");
  });

  it("names Listing settings in words when the portal URL is not configured, and skips listings without a usable item number", () => {
    const text = policy({ listings: [{ externalListingId: "abc", title: "Bad", sku: "B" }, { externalListingId: "123456789", title: "", sku: null }] },
      { listingSettingsUrl: null });
    expect(text).toContain("go to Catalog > Listing settings in your Card Shellz dropship portal and choose");
    expect(text).not.toContain("Bad");
    expect(text).toContain("- A listing, eBay item 123456789: https://www.ebay.com/itm/123456789\n- and 1 more");
  });

  const REASONS: Array<[string, string, string]> = [
    ["domestic_shipping_service_required", "doesn't offer any shipping to buyers in the US. Card Shellz ships every order from the US by USPS Ground Advantage",
      "Under Domestic shipping, add a service, for example USPS Ground Advantage."],
    ["international_direct_shipping_unsupported", "offers shipping to buyers outside the US. Card Shellz only ships to addresses in the US",
      "Under International shipping, remove every international service."],
    ["local_pickup_unsupported", "offers local pickup. Card Shellz ships every order from its warehouse, so a buyer can't pick it up in person",
      "Turn off local pickup."],
    ["pickup_drop_off_unsupported", "offers pickup or drop-off at a store. Card Shellz ships every order from its warehouse and can't hand items over at a store",
      "Turn off the pickup and drop-off option."],
    ["freight_shipping_unsupported", "uses freight shipping. Card Shellz ships orders as packages by USPS Ground Advantage, not by freight",
      "Under Domestic shipping, replace freight with a package service, for example USPS Ground Advantage."],
    ["handling_time_too_short", "promises to ship faster than Card Shellz can. Card Shellz needs 2 business days to get an order out",
      "Set Handling time to 2 business days or more."],
    ["handling_time_missing", "doesn't have a handling time. Card Shellz needs 2 business days to get an order out",
      "Set Handling time to 2 business days or more."],
    ["handling_time_unit_unsupported", "sets its handling time in something other than business days. Card Shellz counts handling time in business days and needs 2 business days",
      "Set Handling time in business days, 2 business days or more."],
    ["shipping_option_type_unsupported", "has a kind of shipping option Card Shellz doesn't offer. Card Shellz only ships with US (domestic) shipping services",
      "Keep only Domestic shipping services in the policy."],
    ["marketplace_missing", "doesn't say which eBay site it's for. Card Shellz can only check a policy made for the eBay site your store sells on",
      "Use a shipping policy made for the same eBay site as your store."],
    ["marketplace_mismatch", "is for a different eBay site than the one your store sells on. Card Shellz can only ship under a policy made for your store's eBay site",
      "Use a shipping policy made for the same eBay site as your store."],
    ["shipping_service_unsupported:USPSPriority", "uses a shipping service Card Shellz doesn't ship with (eBay calls it \"USPSPriority\"). Card Shellz ships every order by USPS Ground Advantage",
      "Under Domestic shipping, remove that service and add one Card Shellz ships with, for example USPS Ground Advantage."],
  ];
  it.each(REASONS)("explains %s in a seller's words and gives its click", (reason, problem, fix) => {
    const text = policy({ reasons: [reason] });
    expect(text.split("\n")[0]).toBe(`Your eBay shipping policy "X" ${problem}, so orders on the 2 listings below can't be shipped.`);
    expect(steps(text)).toEqual([expect.stringMatching(/^1\. Open your shipping policies on eBay/), `2. ${fix}`,
      "3. Save. eBay updates every listing that uses this policy."]);
    expect(text).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it("asks nothing of the vendor when the only problem is on Card Shellz's side", () => {
    const text = policy({ reasons: ["destination_coverage_incomplete"] });
    expect(text.split("\n")[0]).toBe('Your eBay shipping policy "X" couldn\'t be checked. Card Shellz\'s own list of the US places it ships to is '
      + "incomplete right now. This part is on Card Shellz's side, so orders on the 2 listings below can't be shipped.");
    expect(steps(text)).toEqual([]);
    expect(text).toContain("You don't need to change anything. Card Shellz checks the policy again");
    expect(text).not.toContain("Listing settings");
  });

  it("numbers one click per distinct fix when the policy has several problems", () => {
    const text = policy({ reasons: ["local_pickup_unsupported", "handling_time_too_short", "handling_time_missing"] });
    expect(steps(text).map((step) => step.slice(0, 2))).toEqual(["1.", "2.", "3.", "4."]);
    expect(steps(text)[1]).toBe("2. Turn off local pickup.");
    expect(steps(text)[2]).toBe("3. Set Handling time to 2 business days or more.");
  });

  it("covers every issue code the compatibility check can raise", () => {
    const source = readFileSync(resolve(process.cwd(), "server/modules/dropship/domain/ebay-fulfillment-policy-compatibility.ts"), "utf8");
    const codes = [...source.matchAll(/issue\(\s*[`"]([a-z_]+)[:`"]/g)].map((match) => match[1]);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) {
      const reason = code === "shipping_service_unsupported" ? "shipping_service_unsupported:FedExGround" : code;
      expect(policy({ reasons: [reason] })).not.toContain("a setting Card Shellz can't ship under");
    }
  });

  it("names only the store's own services, never one it was not given, and never echoes an odd service code", () => {
    expect(policy({ supportedServiceNames: [] }).split("\n")[0]).toContain("ships every order from the US with a US shipping service,");
    expect(steps(policy({ supportedServiceNames: [] }))[1]).toBe("2. Under Domestic shipping, add a service.");
    expect(policy({ supportedServiceNames: ["USPS Ground Advantage", "UPS Ground", "FedEx Ground", "FedEx 2Day"] }).split("\n")[0])
      .toContain("by USPS Ground Advantage, UPS Ground or FedEx Ground, so orders");
    expect(policy({ reasons: ["shipping_service_unsupported:<b>x</b>"] })).not.toContain("<b>");
    expect(steps(policy({ requiredHandlingTimeBusinessDays: null, reasons: ["handling_time_too_short"] }))[1])
      .toBe("2. Set Handling time to a few business days or more.");
  });

  it("falls back to one plain reason for unknown or missing reasons, never to a code or a prototype key", () => {
    for (const reasons of [undefined, [], ["toString"], ["__proto__", 4]]) {
      expect(policy({ reasons }).split("\n")[0]).toBe('Your eBay shipping policy "X" has a setting Card Shellz can\'t ship under. '
        + "Card Shellz couldn't match it to how it ships orders, so orders on the 2 listings below can't be shipped.");
    }
  });

  it("keeps policy notices in one batch apart by a blank line", () => {
    const one = { policyName: "A", listingCount: 1, reasons: ["local_pickup_unsupported"] };
    const message = describeMarketplaceSyncNoticeBatch("policy_incompatible", [one, { ...one, policyName: "B" }], LINKS).message;
    expect(message).toContain("can't be filled.\n\nYour eBay shipping policy \"B\"");
  });

  it("confirms a fixed policy in one short line, with or without its name", () => {
    expect(describeMarketplaceSyncNoticeBatch("policy_fixed", [{ fulfillmentPolicyId: "6200000000", policyName: "X", listingCount: 2 }]))
      .toEqual({ title: "Your eBay shipping policy works with Card Shellz again",
        message: 'Your eBay shipping policy "X" now works with Card Shellz. No action needed.' });
    expect(describeMarketplaceSyncNotice("policy_fixed", {})).toBe("Your eBay shipping policy now works with Card Shellz. No action needed.");
  });
});
