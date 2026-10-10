import { describe, expect, it } from "vitest";
import {
  LISTING_SETTINGS_ATTENTION_CODES,
  MAX_LISTING_SETTINGS_ATTENTION_ITEMS,
  listingSettingsSummarySchema,
  type ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import { LISTING_SETTINGS_SEND_TIMING } from "../dropship-catalog-steps";
import { DropshipApiError } from "../dropship-ops-surface";
import {
  ATTENTION_STRIP_WORDS,
  LISTING_SETTINGS_HEADER_WORDS,
  OLDER_SETTINGS_WORDS,
  attentionLines,
  attentionStripContent,
  listingSettingsTitle,
  sendTimingLines,
} from "../dropship-listing-settings-attention";

/** A raw code or enum value leaking into vendor words: snake_case or a DROPSHIP_ code. */
const RAW_CODE = /\b[a-z]+_[a-z_]+\b|DROPSHIP_/;

const GENERATED_AT = "2026-10-09T12:00:00.000Z";
const STORE = "Marz Cards";

type AttentionItem = ListingSettingsSummary["attention"]["items"][number];

/** A summary the server could send: checked against the shared contract. */
function summary(overrides: {
  items?: AttentionItem[];
  total?: number;
  missingPolicy?: ListingSettingsSummary["rail"]["missingPolicy"];
  storeStatus?: string;
  /** The store policies that are set, by kind; a kind left out is not set. */
  policyIds?: Partial<Record<"shipping" | "return" | "payment", string>>;
} = {}): ListingSettingsSummary {
  const items = overrides.items ?? [];
  const policy = (kind: "shipping" | "return" | "payment") => ({ policyId: overrides.policyIds?.[kind] ?? null, verification: "not_checked" });
  return listingSettingsSummarySchema.parse({
    storeConnectionId: 22,
    storeStatus: overrides.storeStatus ?? "connected",
    access: { allowed: true },
    catalog: { state: "ok", products: 3, sizes: 9 },
    storeDefaults: {
      price: { recipe: null, groupRules: 0 },
      shippingPolicy: policy("shipping"),
      returnPolicy: policy("return"),
      paymentPolicy: policy("payment"),
      ebayCategory: { category: null, groupRules: 0 },
      description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
    },
    counts: { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0, belowCost: 0, cannotPrice: 0, paused: 0 },
    attention: { items, total: overrides.total ?? items.length },
    rail: { state: "all_set", productsNeedingFix: 0, missingPolicy: overrides.missingPolicy ?? null },
    generatedAt: GENERATED_AT,
  });
}

const TOO_LARGE = listingSettingsSummarySchema.parse({
  ...summary(),
  catalog: { state: "too_large", limit: 10_000 },
  counts: null,
  attention: { items: [], total: 0 },
  rail: { state: "too_many_sizes", productsNeedingFix: 0, missingPolicy: null },
});

const item = (code: AttentionItem["code"], extra: Partial<AttentionItem> = {}): AttentionItem => ({
  code, count: 1, productId: null, productName: null, ...extra,
});
const RECONNECT = item("reconnect_store");
const POLICIES = item("choose_store_policies", { count: 3 });
const OWN_TEXT = item("own_text_needs_check", { count: 4 });
const NO_CATEGORY = item("no_ebay_category", { count: 2, productId: 11, productName: "Shellz Pro Toploader 35pt" });
const CANT_PRICE = item("size_cannot_be_priced", { productId: 12, productName: "Easy Glide Soft Sleeves" });
const TIE = item("description_group_conflict", { productId: 13, productName: "Team Bags" });

const NO_BANNER = { bannerShown: false, storeName: STORE };
const BANNER = { bannerShown: true, storeName: STORE };

describe("attentionLines", () => {
  it("keeps the server's order and never re-sorts", () => {
    const orders: AttentionItem[][] = [
      [POLICIES, NO_CATEGORY, CANT_PRICE],
      [CANT_PRICE, NO_CATEGORY, POLICIES],
      [TIE, OWN_TEXT, NO_CATEGORY],
    ];
    for (const items of orders) {
      const { lines } = attentionLines(summary({ items, missingPolicy: "shipping" }), NO_BANNER);
      expect(lines.map((line) => line.code)).toEqual(items.map((entry) => entry.code));
    }
  });

  it("drops reconnect_store while a banner shows, and keeps it with its words when none does (refresh_failed)", () => {
    const shown = summary({ items: [RECONNECT, NO_CATEGORY], storeStatus: "needs_reauth" });
    expect(attentionLines(shown, BANNER).lines.map((line) => line.code)).toEqual(["no_ebay_category"]);

    // refresh_failed has no banner kind, but the summary still adds the line.
    const refreshFailed = summary({ items: [RECONNECT, NO_CATEGORY], storeStatus: "refresh_failed" });
    const { lines } = attentionLines(refreshFailed, NO_BANNER);
    expect(lines.map((line) => line.code)).toEqual(["reconnect_store", "no_ebay_category"]);
    expect(lines[0]).toEqual({
      key: "reconnect_store",
      code: "reconnect_store",
      text: "Reconnect eBay for Marz Cards.",
      action: { kind: "link", link: { label: "Reconnect eBay", href: "/onboarding", external: false } },
    });
  });

  it("says each code in the vendor's words with its one button", () => {
    const { lines } = attentionLines(summary({ items: [POLICIES, OWN_TEXT, NO_CATEGORY], missingPolicy: "return" }), NO_BANNER);
    expect(lines).toEqual([
      {
        key: "choose_store_policies",
        code: "choose_store_policies",
        text: "Choose your shipping, return and payment policies. Nothing can be listed until you do.",
        action: { kind: "open_store_default", label: "Choose", field: "return" },
      },
      {
        key: "own_text_needs_check",
        code: "own_text_needs_check",
        text: "Card Shellz updated 4 products that have your own text. Check that it still fits.",
        action: { kind: "show_products", label: "Show products", show: "needs_fix" },
      },
      {
        key: "no_ebay_category:11",
        code: "no_ebay_category",
        text: "Shellz Pro Toploader 35pt can't be listed: it has no eBay category.",
        action: { kind: "open_product", label: "Fix", productId: 11, fix: "no_ebay_category" },
      },
    ]);
    const more = attentionLines(summary({ items: [CANT_PRICE, TIE] }), NO_BANNER).lines;
    expect(more.map((line) => [line.text, line.action])).toEqual([
      ["Easy Glide Soft Sleeves can't be listed: a size can't be priced.", { kind: "open_product", label: "Fix", productId: 12, fix: "size_cannot_be_priced" }],
      ["Team Bags: two older description rules tie, so neither's text is used.", { kind: "open_product", label: "Fix", productId: 13, fix: "description_group_conflict" }],
    ]);
  });

  it("names the one missing policy and opens it, and opens Shipping when the line names none", () => {
    const one = attentionLines(summary({ items: [item("choose_store_policies", { count: 1 })], missingPolicy: "payment",
      policyIds: { shipping: "ship-1", return: "return-1" } }), NO_BANNER).lines[0];
    expect(one.text).toBe("Choose your payment policy. Nothing can be listed until you do.");
    expect(one.action).toEqual({ kind: "open_store_default", label: "Choose", field: "payment" });

    // The store defaults name the one missing policy when the rail doesn't.
    const fromDefaults = attentionLines(summary({ items: [item("choose_store_policies", { count: 1 })], missingPolicy: null,
      policyIds: { shipping: "ship-1", payment: "pay-1" } }), NO_BANNER).lines[0];
    expect(fromDefaults.text).toBe("Choose your return policy. Nothing can be listed until you do.");
    expect(fromDefaults.action).toEqual({ kind: "open_store_default", label: "Choose", field: "return" });

    // A summary that says one is missing but doesn't say which names none, rather than one that is set.
    const unnamed = attentionLines(summary({ items: [item("choose_store_policies", { count: 1 })], missingPolicy: null }), NO_BANNER).lines[0];
    expect(unnamed.text).toBe("Choose your missing store policies. Nothing can be listed until you do.");
    expect(unnamed.action).toEqual({ kind: "open_store_default", label: "Choose", field: "shipping" });
  });

  it("names exactly the two missing policies, never one that is set", () => {
    const line = (policyIds: Partial<Record<"shipping" | "return" | "payment", string>>, missingPolicy: "shipping" | "return") =>
      attentionLines(summary({ items: [item("choose_store_policies", { count: 2 })], missingPolicy, policyIds }), NO_BANNER).lines[0];
    const returnAndPayment = line({ shipping: "ship-1" }, "return");
    expect(returnAndPayment.text).toBe("Choose your return and payment policies. Nothing can be listed until you do.");
    expect(returnAndPayment.action).toEqual({ kind: "open_store_default", label: "Choose", field: "return" });
    expect(line({ return: "return-1" }, "shipping").text).toBe("Choose your shipping and payment policies. Nothing can be listed until you do.");
    expect(line({ payment: "pay-1" }, "shipping").text).toBe("Choose your shipping and return policies. Nothing can be listed until you do.");

    // A rail that names a policy the store defaults show as set: Choose opens the first one the line names.
    const railSet = line({ shipping: "ship-1" }, "shipping");
    expect(railSet.text).toBe("Choose your return and payment policies. Nothing can be listed until you do.");
    expect(railSet.action).toEqual({ kind: "open_store_default", label: "Choose", field: "return" });

    // Two counted while the store defaults show another number: no policy is named.
    const disagree = attentionLines(summary({ items: [item("choose_store_policies", { count: 2 })], missingPolicy: "shipping" }), NO_BANNER).lines[0];
    expect(disagree.text).toBe("Choose your missing store policies. Nothing can be listed until you do.");
    expect(disagree.action).toEqual({ kind: "open_store_default", label: "Choose", field: "shipping" });
  });

  it("says one product in the singular", () => {
    const { lines } = attentionLines(summary({ items: [item("own_text_needs_check", { count: 1 })] }), NO_BANNER);
    expect(lines[0].text).toBe("Card Shellz updated 1 product that has your own text. Check that it still fits.");
  });

  it("shows the products that need a fix when a product line has no product, and names an unnamed product plainly", () => {
    const orphan = attentionLines(summary({ items: [item("no_ebay_category", { productId: null, productName: "Lost" })] }), NO_BANNER).lines[0];
    expect(orphan.action).toEqual({ kind: "show_products", label: "Fix", show: "needs_fix" });
    const unnamed = attentionLines(summary({ items: [item("no_ebay_category", { productId: 9, productName: "   " })] }), NO_BANNER).lines[0];
    expect(unnamed.text).toBe("A product can't be listed: it has no eBay category.");
    expect(unnamed.key).toBe("no_ebay_category:9");
  });

  it("adds \"And N more.\" [See all] only when the summary holds more than it sent", () => {
    const full = summary({ items: [NO_CATEGORY, CANT_PRICE, TIE], total: 7 });
    expect(attentionLines(full, NO_BANNER).more).toEqual({
      count: 4, text: "And 4 more.", action: { kind: "show_products", label: "See all", show: "needs_fix" },
    });
    expect(attentionLines(summary({ items: [NO_CATEGORY, CANT_PRICE, TIE], total: 4 }), NO_BANNER).more?.text).toBe("And 1 more.");
    expect(attentionLines(summary({ items: [NO_CATEGORY], total: 1 }), NO_BANNER).more).toBeNull();
    // A dropped reconnect line was sent, so it never changes the count of lines not sent.
    const reconnectFirst = summary({ items: [RECONNECT, NO_CATEGORY, CANT_PRICE], total: 5 });
    expect(attentionLines(reconnectFirst, BANNER).more?.count).toBe(2);
    expect(attentionLines(reconnectFirst, NO_BANNER).more?.count).toBe(2);
  });

  it("gives every line a key unique among those shown", () => {
    const { lines } = attentionLines(summary({ items: [NO_CATEGORY, item("no_ebay_category", { productId: 14, productName: "B" }), CANT_PRICE] }), NO_BANNER);
    expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
  });

  it("speaks plainly for every code, with a blank store name", () => {
    expect(MAX_LISTING_SETTINGS_ATTENTION_ITEMS).toBe(3);
    for (const code of LISTING_SETTINGS_ATTENTION_CODES) {
      const entry = item(code, { productId: 5, productName: "Toploader" });
      const { lines } = attentionLines(summary({ items: [entry], missingPolicy: "shipping" }), { bannerShown: false, storeName: "  " });
      expect(lines, code).toHaveLength(1);
      expect(lines[0].text, code).not.toMatch(RAW_CODE);
      expect(lines[0].text.trim(), code).toBe(lines[0].text);
    }
    const reconnect = attentionLines(summary({ items: [RECONNECT] }), { bannerShown: false, storeName: " " }).lines[0];
    expect(reconnect.text).toBe("Reconnect eBay for your eBay store.");
  });

  it("never changes the summary it reads", () => {
    const input = summary({ items: [RECONNECT, NO_CATEGORY], total: 4 });
    const before = JSON.stringify(input);
    attentionLines(input, BANNER);
    attentionStripContent({ data: input }, BANNER);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("attentionStripContent", () => {
  it("says it is checking while the summary loads", () => {
    expect(attentionStripContent({}, NO_BANNER)).toEqual({ state: "loading", text: "Checking your products…" });
    expect(attentionStripContent({ data: undefined, error: null }, NO_BANNER).state).toBe("loading");
  });

  it("says it couldn't check when the latest read failed, even over an older answer", () => {
    const failed = { state: "failed", text: "Couldn't check your products.", retryLabel: "Try again" };
    expect(attentionStripContent({ error: new DropshipApiError({ status: 503, code: null, message: "down" }) }, NO_BANNER)).toEqual(failed);
    expect(attentionStripContent({ data: summary({ items: [NO_CATEGORY] }), error: new Error("refetch failed") }, NO_BANNER)).toEqual(failed);
  });

  it("shows nothing when the selection is too large to check; the banner says why", () => {
    expect(attentionStripContent({ data: TOO_LARGE }, BANNER)).toEqual({ state: "not_checked" });
  });

  it("says nothing needs the vendor when there are no lines, or only the line the banner already says", () => {
    const empty = { state: "empty", text: "✓ Nothing here needs you. Step 3 checks the rest, like stock, photos and your wallet." };
    expect(attentionStripContent({ data: summary() }, NO_BANNER)).toEqual(empty);
    expect(attentionStripContent({ data: summary({ items: [RECONNECT], storeStatus: "needs_reauth" }) }, BANNER)).toEqual(empty);
  });

  it("lists the lines and the more line", () => {
    const content = attentionStripContent({ data: summary({ items: [NO_CATEGORY, CANT_PRICE, TIE], total: 5 }) }, NO_BANNER);
    expect(content.state).toBe("lines");
    if (content.state !== "lines") return;
    expect(content.lines).toHaveLength(3);
    expect(content.more?.text).toBe("And 2 more.");
  });
});

describe("header words", () => {
  it("titles the step for the store, and \"Listing settings\" on a phone or with no store name", () => {
    expect(listingSettingsTitle("Marz Cards", false)).toBe("Listing settings for Marz Cards");
    expect(listingSettingsTitle(" Marz Cards ", false)).toBe("Listing settings for Marz Cards");
    expect(listingSettingsTitle("Marz Cards", true)).toBe("Listing settings");
    expect(listingSettingsTitle("  ", false)).toBe("Listing settings");
  });

  it("keeps the record's timing line and the plan's intro", () => {
    expect(LISTING_SETTINGS_HEADER_WORDS.timing).toBe(LISTING_SETTINGS_SEND_TIMING);
    expect(LISTING_SETTINGS_HEADER_WORDS.timing).toBe(
      "Saved settings go to eBay the next time a listing is sent: when you publish it, or when Card Shellz updates it.",
    );
    expect(LISTING_SETTINGS_HEADER_WORDS.timingPhone).toBe("Saved settings go to eBay the next time a listing is sent.");
    expect(LISTING_SETTINGS_HEADER_WORDS.intro).toBe("Set your store defaults once. Give any size an exact price in Products.");
  });

  it("explains when settings are sent, adding the one-store line only for a vendor with more than one eBay store", () => {
    const base = [
      "A listing goes to eBay when you publish it in step 3.",
      "Card Shellz also re-sends your live listings to keep their stock right.",
      "Each time, your settings are used as they are at that moment.",
    ];
    expect(sendTimingLines(STORE, 1)).toEqual(base);
    expect(sendTimingLines(STORE, 0)).toEqual(base);
    expect(sendTimingLines(STORE, 2)).toEqual([...base, "These settings are for Marz Cards only. Each store has its own."]);
    expect(sendTimingLines(" ", 3).at(-1)).toBe("These settings are for this store only. Each store has its own.");
    // A count that isn't a whole number is not "more than one store".
    for (const odd of [1.5, Number.NaN, Number.POSITIVE_INFINITY, -2]) expect(sendTimingLines(STORE, odd)).toEqual(base);
    // No cost-policy sentence (S2 dropped).
    expect(sendTimingLines(STORE, 2).join(" ")).not.toMatch(/cost/i);
  });

  it("keeps every fixed word plain", () => {
    const words = [
      ...Object.values(LISTING_SETTINGS_HEADER_WORDS),
      ...Object.values(ATTENTION_STRIP_WORDS),
      ...Object.values(OLDER_SETTINGS_WORDS),
    ];
    for (const text of words) {
      expect(text).not.toMatch(RAW_CODE);
      expect(text.trim()).toBe(text);
    }
    expect(OLDER_SETTINGS_WORDS).toEqual({
      title: "Older settings",
      intro: "Per-size policies and shelves, group rules and text templates. They still work.",
      show: "Show older settings",
      hide: "Hide older settings",
    });
  });
});
