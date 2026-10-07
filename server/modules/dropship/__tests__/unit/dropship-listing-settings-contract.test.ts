import { describe, expect, it } from "vitest";
import {
  LISTING_SETTINGS_FIELD_SETTINGS,
  LISTING_SETTINGS_FIELDS,
  LISTING_SETTINGS_PAGE_SIZE,
  LISTING_SETTINGS_SETTING_KEYS,
  MAX_LISTING_SETTINGS_PAGE,
  listingSettingsPricesInputSchema,
  listingSettingsPricesResponseSchema,
  listingSettingsProductInputSchema,
  listingSettingsProductSettingsSchema,
  listingSettingsProductsInputSchema,
  listingSettingsSizePriceSchema,
  listingSettingsSummarySchema,
} from "../../../../../shared/dropship/listing-settings";

const sizePrice = {
  productVariantId: 11, productId: 7, productName: "Toploader 35pt", sizeName: "Pack of 25", sku: "TL-35-25",
  priceCents: 1_499, source: "exact", rule: null, basis: null, basisAmountCents: null, issue: null,
  costCents: 1_200, belowCostByCents: null, limits: [], pausedSince: null, settingRevisionId: 3,
} as const;

const summary = {
  storeConnectionId: 5, storeStatus: "connected", access: { allowed: true },
  catalog: { state: "ok", products: 2, sizes: 3 },
  storeDefaults: {
    price: { recipe: null, groupRules: 0 },
    shippingPolicy: { policyId: "123", verification: "not_checked" },
    returnPolicy: { policyId: null, verification: "not_checked" },
    paymentPolicy: { policyId: null, verification: "not_checked" },
    ebayCategory: { category: null, groupRules: 0 },
    description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
  },
  counts: { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0,
    exactPrices: 1, belowCost: 0, cannotPrice: 0, paused: 0 },
  attention: { items: [{ code: "choose_store_policies", count: 2, productId: null, productName: null }], total: 1 },
  rail: { state: "choose_policy", productsNeedingFix: 0, missingPolicy: "return" },
  generatedAt: "2026-10-06T12:00:00.000Z",
} as const;

describe("listing settings contracts", () => {
  it("fills the list defaults and trims the search", () => {
    expect(listingSettingsProductsInputSchema.parse({ storeConnectionId: 5, search: "  sleeve  " }))
      .toEqual({ storeConnectionId: 5, search: "sleeve", show: "all", page: 0 });
    expect(listingSettingsPricesInputSchema.parse({ storeConnectionId: 5 }))
      .toEqual({ storeConnectionId: 5, search: "", show: "all", page: 0 });
  });

  it("covers every row of the largest selection with its pages, and no more", () => {
    expect((MAX_LISTING_SETTINGS_PAGE + 1) * LISTING_SETTINGS_PAGE_SIZE).toBe(10_000);
    expect(listingSettingsPricesInputSchema.safeParse({ storeConnectionId: 5, page: MAX_LISTING_SETTINGS_PAGE }).success).toBe(true);
    expect(listingSettingsPricesInputSchema.safeParse({ storeConnectionId: 5, page: MAX_LISTING_SETTINGS_PAGE + 1 }).success).toBe(false);
  });

  it.each([
    ["an unknown field", { storeConnectionId: 5, vendorId: 9 }],
    ["a negative page", { storeConnectionId: 5, page: -1 }],
    ["a fractional page", { storeConnectionId: 5, page: 1.5 }],
    ["an unknown filter", { storeConnectionId: 5, show: "everything" }],
    ["a search over 100 characters", { storeConnectionId: 5, search: "x".repeat(101) }],
    ["a store id of 0", { storeConnectionId: 0 }],
    ["a store id beyond the integer column", { storeConnectionId: 2_147_483_648 }],
  ])("refuses %s", (_case, input) => {
    expect(listingSettingsProductsInputSchema.safeParse(input).success).toBe(false);
  });

  it("refuses a price filter the Prices tab does not have", () => {
    expect(listingSettingsPricesInputSchema.safeParse({ storeConnectionId: 5, show: "sizes_differ" }).success).toBe(false);
  });

  it("accepts a priced size and refuses a loss of zero cents or a money value in dollars", () => {
    expect(listingSettingsSizePriceSchema.parse(sizePrice)).toEqual(sizePrice);
    expect(listingSettingsSizePriceSchema.safeParse({ ...sizePrice, belowCostByCents: 0 }).success).toBe(false);
    expect(listingSettingsSizePriceSchema.safeParse({ ...sizePrice, priceCents: 14.99 }).success).toBe(false);
    expect(listingSettingsSizePriceSchema.safeParse({ ...sizePrice, priceCents: 0 }).success).toBe(false);
  });

  it("caps a page at 50 rows", () => {
    const page = (rows: number) => ({ storeConnectionId: 5, page: 0, pageSize: 50, total: rows,
      rows: Array.from({ length: rows }, (_, index) => ({ ...sizePrice, productVariantId: index + 1 })),
      generatedAt: "2026-10-06T12:00:00.000Z" });
    expect(listingSettingsPricesResponseSchema.safeParse(page(50)).success).toBe(true);
    expect(listingSettingsPricesResponseSchema.safeParse(page(51)).success).toBe(false);
  });

  it("accepts a summary, and a too-large selection without counts", () => {
    expect(listingSettingsSummarySchema.parse(summary)).toEqual(summary);
    const tooLarge = { ...summary, catalog: { state: "too_large", limit: 10_000 }, counts: null,
      rail: { state: "too_many_sizes", productsNeedingFix: 0, missingPolicy: null } };
    expect(listingSettingsSummarySchema.parse(tooLarge)).toEqual(tooLarge);
  });

  it("accepts a blocked access decision only with a known code and resolution", () => {
    const blocked = { allowed: false, code: "DROPSHIP_LISTING_STORE_BLOCKED", resolution: "reconnect_store", message: "Reconnect." };
    expect(listingSettingsSummarySchema.safeParse({ ...summary, access: blocked }).success).toBe(true);
    expect(listingSettingsSummarySchema.safeParse({ ...summary, access: { ...blocked, resolution: "try_again" } }).success).toBe(false);
  });

  it("shows at most three attention lines", () => {
    const item = { code: "no_ebay_category", count: 1, productId: 7, productName: "Toploader 35pt" };
    expect(listingSettingsSummarySchema.safeParse({ ...summary, attention: { items: [item, item, item], total: 9 } }).success).toBe(true);
    expect(listingSettingsSummarySchema.safeParse({ ...summary, attention: { items: [item, item, item, item], total: 9 } }).success).toBe(false);
  });
});

describe("listing settings contracts: one product", () => {
  const value = (source: string, ruleName: string | null) =>
    [{ value: { policyId: "F1" }, sources: [{ source, ruleName, productVariantIds: [11] }] }];

  it("takes a store and a product, nothing else", () => {
    expect(listingSettingsProductInputSchema.parse({ storeConnectionId: 5, productId: 7 })).toEqual({ storeConnectionId: 5, productId: 7 });
    expect(listingSettingsProductInputSchema.safeParse({ storeConnectionId: 5, productId: 0 }).success).toBe(false);
    expect(listingSettingsProductInputSchema.safeParse({ storeConnectionId: 5, productId: 7, page: 1 }).success).toBe(false);
  });

  it("lists every setting once, and maps every row field to its settings", () => {
    expect(Object.keys(listingSettingsProductSettingsSchema.shape)).toEqual([...LISTING_SETTINGS_SETTING_KEYS]);
    expect(Object.keys(LISTING_SETTINGS_FIELD_SETTINGS)).toEqual([...LISTING_SETTINGS_FIELDS]);
    expect(Object.values(LISTING_SETTINGS_FIELD_SETTINGS).flat().sort()).toEqual([...LISTING_SETTINGS_SETTING_KEYS].sort());
  });

  it("names a group rule, and only a group rule", () => {
    const policy = listingSettingsProductSettingsSchema.shape.shippingPolicy;
    expect(policy.safeParse(value("group_rule", "Toploaders")).success).toBe(true);
    expect(policy.safeParse(value("group_rule", null)).success).toBe(false);
    expect(policy.safeParse(value("store_default", "Toploaders")).success).toBe(false);
    expect(policy.safeParse([]).success).toBe(false);
  });
});
