import { describe, expect, it } from "vitest";
import type { ListingPriceSetting } from "@shared/dropship/listing-price";
import {
  LISTING_SETTINGS_PRICE_ISSUES, LISTING_SETTINGS_PRICE_SOURCES,
  type ListingSettingsPriceIssue, type ListingSettingsSizePrice,
} from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import {
  RETAIL_FALLBACK_FIX, builtFromWords, formatCents, isW9RetailFallback, percentText, recipeWords, retailFallbackFixWords, w9OriginWords,
} from "../dropship-listing-settings-price-words";

const RETAIL_20_UP: PricingRecipe = { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" };
const COST_20_PLUS_1: PricingRecipe = { basis: "product_cost", markupBps: 2000, flatCents: 100, rounding: "cent" };
/** No vendor-facing line ever shows a raw code such as `pricing_rule_priority_conflict`. */
const RAW_CODE = /[a-z]+_[a-z_]+/;

function size(patch: Partial<ListingSettingsSizePrice> = {}): ListingSettingsSizePrice {
  return { productVariantId: 11, productId: 7, productName: "Toploader 35pt", sizeName: "Pack of 25", sku: "TL-35-25",
    priceCents: 1_499, source: "exact", rule: null, basis: null, basisAmountCents: null, issue: null,
    costCents: 980, belowCostByCents: null, limits: [], pausedSince: null, settingRevisionId: 3, ...patch };
}

function w9(patch: Partial<ListingPriceSetting> = {}): ListingPriceSetting {
  return { storeConnectionId: 5, productVariantId: 11, revisionId: 3, overridePriceCents: null, effectivePriceCents: 1_250,
    defaultPriceCents: 1_250, source: "catalog_default", pricingMode: "catalog_default", ruleName: null, pricingIssue: null,
    rulePriceCents: null, rulesConfigured: false, ruleBasis: null, productCostCents: 980, updatedAt: null, ...patch };
}

describe("percentText", () => {
  it.each([[2000, "20"], [1250, "12.5"], [1, "0.01"], [0, "0"], [1205, "12.05"], [10, "0.1"], [100, "1"], [1_000_000, "10000"]])(
    "%s basis points read %s", (bps, words) => {
      expect(percentText(bps)).toBe(words);
    });
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("refuses %s", (bps) => {
    expect(() => percentText(bps)).toThrow();
  });
});

describe("recipeWords", () => {
  it("says the store default as the Store defaults card does", () => {
    expect(recipeWords(RETAIL_20_UP)).toBe("Retail price + 20%, round up to .99");
    expect(recipeWords(COST_20_PLUS_1)).toBe("Your cost + 20% plus $1.00, to the cent");
    expect(recipeWords({ basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" })).toBe("Retail price + 0%, to the cent");
    expect(recipeWords({ ...RETAIL_20_UP, markupBps: 1250 })).toBe("Retail price + 12.5%, round up to .99");
  });
  it("is shorter on a phone (C24)", () => {
    expect(recipeWords(RETAIL_20_UP, "phone")).toBe("Retail + 20%, up to .99");
    expect(recipeWords(COST_20_PLUS_1, "phone")).toBe("Your cost + 20% plus $1.00, to the cent");
  });
  it("formats money from integer cents", () => {
    expect(formatCents(1)).toBe("$0.01");
    expect(formatCents(123_456)).toBe("$1234.56");
  });
});

describe("builtFromWords", () => {
  it("names an exact price, the store default and an older group rule with what they start from", () => {
    expect(builtFromWords(size())).toBe("Exact price");
    expect(builtFromWords(size({ source: "rules", basis: "catalog_retail", basisAmountCents: 1_250,
      rule: { kind: "store_default", name: "Store default rule", recipe: RETAIL_20_UP } })))
      .toBe("Store default: retail $12.50 + 20%, up to .99");
    expect(builtFromWords(size({ source: "rules", basis: "catalog_retail", basisAmountCents: 625,
      rule: { kind: "group", name: "Envelopes", recipe: { basis: "catalog_retail", markupBps: 3000, flatCents: 0, rounding: "cent" } } })))
      .toBe("From your older group rule “Envelopes”: retail $6.25 + 30%");
    expect(builtFromWords(size({ source: "rules", basis: "product_cost", basisAmountCents: 980,
      rule: { kind: "group", name: "Sleeves", recipe: COST_20_PLUS_1 } })))
      .toBe("From your older group rule “Sleeves”: your cost $9.80 + 20% plus $1.00");
    // An amount that is not known is left out, never shown as $0.00.
    expect(builtFromWords(size({ source: "rules", basis: "product_cost", basisAmountCents: null,
      rule: { kind: "store_default", name: "Store default rule", recipe: COST_20_PLUS_1 } })))
      .toBe("Store default: your cost + 20% plus $1.00");
    // A zero cost is a real amount.
    expect(builtFromWords(size({ source: "rules", basis: "product_cost", basisAmountCents: 0,
      rule: { kind: "store_default", name: "Store default rule", recipe: COST_20_PLUS_1 } })))
      .toBe("Store default: your cost $0.00 + 20% plus $1.00");
  });

  it("names the last published and retail prices, saved or not", () => {
    expect(builtFromWords(size({ source: "last_published", settingRevisionId: null }))).toBe("Last published price (no store price yet)");
    expect(builtFromWords(size({ source: "catalog_price", settingRevisionId: null }))).toBe("Retail price (no store price yet)");
    expect(builtFromWords(size({ source: "catalog_price", settingRevisionId: 8 }))).toBe("Retail price (kept from before)");
  });

  it("says why a retail fallback uses the retail price, in one of two reasons (L1)", () => {
    const fallback = size({ source: "retail_fallback", priceCents: 1_250 });
    expect(builtFromWords(fallback)).toBe("No pricing rule covers this size, so it uses the retail price ($12.50).");
    expect(retailFallbackFixWords(fallback)).toBe(RETAIL_FALLBACK_FIX);
    expect(`${builtFromWords(fallback)} ${RETAIL_FALLBACK_FIX}`)
      .toBe("No pricing rule covers this size, so it uses the retail price ($12.50). Set a store price or type a price.");
    expect(builtFromWords({ ...fallback, issue: "pricing_rule_priority_conflict" }))
      .toBe("Your pricing rules can't price this size (two older group rules tie), so it uses the retail price ($12.50).");
    expect(builtFromWords({ ...fallback, issue: "pricing_basis_unavailable" }))
      .toBe("Your pricing rules can't price this size (your cost isn't on file), so it uses the retail price ($12.50).");
    expect(builtFromWords({ ...fallback, issue: "pricing_result_out_of_range" }))
      .toBe("Your pricing rules can't price this size (the price it gives is out of range), so it uses the retail price ($12.50).");
    expect(retailFallbackFixWords({ ...fallback, issue: "pricing_rule_priority_conflict" })).toBeNull();
    expect(retailFallbackFixWords(size())).toBeNull();
  });

  it("says why a size can't be priced", () => {
    const none = (issue: ListingSettingsPriceIssue | null, basis: ListingSettingsSizePrice["basis"] = null) =>
      builtFromWords(size({ source: "none", priceCents: null, issue, basis }));
    expect(none("pricing_basis_unavailable", "catalog_retail")).toBe("Can't price: Card Shellz has no retail price for this size");
    expect(none("pricing_basis_unavailable", "product_cost")).toBe("Can't price: your cost isn't on file. Contact support.");
    expect(none("pricing_basis_unavailable")).toBe("Can't price: what the store price starts from isn't on file");
    expect(none("pricing_rule_priority_conflict")).toBe("Can't price: two older group rules tie");
    expect(none("pricing_result_out_of_range")).toBe("Can't price: the rule's price is out of range");
    expect(none("pricing_rules_not_configured")).toBe("Can't price: no store price yet");
    expect(none("price_unavailable")).toBe("Can't price: Card Shellz has no retail price for this size");
    expect(none(null)).toBe("Can't price this size");
  });

  it("never shows a raw code, for every source, rule kind, issue and basis", () => {
    const issues: (ListingSettingsPriceIssue | null)[] = [null, ...LISTING_SETTINGS_PRICE_ISSUES];
    const bases: ListingSettingsSizePrice["basis"][] = [null, "catalog_retail", "product_cost"];
    const rules: ListingSettingsSizePrice["rule"][] = [null,
      { kind: "store_default", name: "Store default rule", recipe: RETAIL_20_UP },
      { kind: "group", name: "Envelopes", recipe: COST_20_PLUS_1 }];
    let checked = 0;
    for (const source of LISTING_SETTINGS_PRICE_SOURCES) {
      for (const issue of issues) {
        for (const basis of bases) {
          for (const rule of rules) {
            const words = builtFromWords(size({ source, issue, basis, rule, basisAmountCents: basis ? 980 : null,
              priceCents: source === "none" ? null : 1_250 }));
            expect(words.length).toBeGreaterThan(0);
            // Group names are the vendor's own text; take them out before looking for codes.
            expect(words.replace("“Envelopes”", "")).not.toMatch(RAW_CODE);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(LISTING_SETTINGS_PRICE_SOURCES.length * issues.length * bases.length * rules.length);
  });
});

describe("w9OriginWords", () => {
  it("names a typed price, the last published price and the retail price", () => {
    expect(w9OriginWords(w9({ source: "override", pricingMode: "fixed", overridePriceCents: 1_499, effectivePriceCents: 1_499 })))
      .toBe("Exact price");
    expect(w9OriginWords(w9({ source: "saved_listing", revisionId: null, pricingMode: "fixed" })))
      .toBe("Last published price (no store price yet)");
    expect(w9OriginWords(w9({ revisionId: null }))).toBe("Retail price (no store price yet)");
    expect(w9OriginWords(w9())).toBe("Retail price (kept from before)");
  });

  it("names the store default with its recipe when given, and an older group rule by name", () => {
    const rules = w9({ source: "rules", pricingMode: "rules", ruleName: "Store default rule", rulesConfigured: true,
      rulePriceCents: 1_599, effectivePriceCents: 1_599, ruleBasis: "catalog_retail" });
    expect(w9OriginWords(rules, RETAIL_20_UP)).toBe("Store default: retail $12.50 + 20%, up to .99");
    expect(w9OriginWords(rules)).toBe("Store default: retail $12.50");
    expect(w9OriginWords({ ...rules, ruleName: "Envelopes", ruleBasis: "product_cost" }))
      .toBe("From your older group rule “Envelopes”: your cost $9.80");
    expect(w9OriginWords({ ...rules, ruleName: "Envelopes", ruleBasis: "product_cost", productCostCents: null }))
      .toBe("From your older group rule “Envelopes”: your cost");
    expect(w9OriginWords({ ...rules, ruleBasis: null })).toBe("Store default");
  });

  it("says why an inherit size uses its retail price (L1)", () => {
    const fallback = w9({ pricingMode: "inherit" });
    expect(isW9RetailFallback(fallback)).toBe(true);
    expect(w9OriginWords(fallback)).toBe("No pricing rule covers this size, so it uses the retail price ($12.50).");
    expect(w9OriginWords({ ...fallback, rulesConfigured: true, pricingIssue: "pricing_rule_priority_conflict" }))
      .toBe("Your pricing rules can't price this size (two older group rules tie), so it uses the retail price ($12.50).");
    expect(w9OriginWords({ ...fallback, rulesConfigured: true, pricingIssue: "pricing_basis_unavailable" }))
      .toBe("Your pricing rules can't price this size (your cost isn't on file), so it uses the retail price ($12.50).");
    // An unknown reason from a newer server is not shown raw.
    expect(w9OriginWords({ ...fallback, rulesConfigured: true, pricingIssue: "some_new_issue" }))
      .toBe("Your pricing rules can't price this size, so it uses the retail price ($12.50).");
    expect(isW9RetailFallback(w9({ pricingMode: "inherit", source: "rules" }))).toBe(false);
    expect(isW9RetailFallback(w9())).toBe(false);
  });

  it("says why a size can't be priced, with the rules' reason only when it follows them", () => {
    const unavailable = w9({ source: "unavailable", effectivePriceCents: null, defaultPriceCents: null });
    expect(w9OriginWords(unavailable)).toBe("Can't price: Card Shellz has no retail price for this size");
    expect(w9OriginWords({ ...unavailable, pricingMode: "inherit" })).toBe("Can't price: Card Shellz has no retail price for this size");
    expect(w9OriginWords({ ...unavailable, pricingMode: "rules" })).toBe("Can't price: no store price yet");
    expect(w9OriginWords({ ...unavailable, pricingMode: "rules", rulesConfigured: true, pricingIssue: "pricing_basis_unavailable", ruleBasis: "product_cost" }))
      .toBe("Can't price: your cost isn't on file. Contact support.");
    expect(w9OriginWords({ ...unavailable, pricingMode: "rules", rulesConfigured: true, pricingIssue: "pricing_rule_priority_conflict" }))
      .toBe("Can't price: two older group rules tie");
    expect(w9OriginWords({ ...unavailable, pricingMode: "rules", rulesConfigured: true, pricingIssue: "something_new" }))
      .toBe("Can't price: Card Shellz has no retail price for this size");
  });

  it("never shows a raw code", () => {
    const issues = [null, ...LISTING_SETTINGS_PRICE_ISSUES, "something_new"];
    const sources: ListingPriceSetting["source"][] = ["override", "catalog_default", "saved_listing", "rules", "unavailable"];
    const modes: ListingPriceSetting["pricingMode"][] = [undefined, "fixed", "catalog_default", "rules", "inherit"];
    for (const source of sources) {
      for (const pricingMode of modes) {
        for (const pricingIssue of issues) {
          for (const rulesConfigured of [true, false]) {
            const words = w9OriginWords(w9({ source, pricingMode, pricingIssue, rulesConfigured, ruleName: "Store default rule",
              ruleBasis: "catalog_retail" }), RETAIL_20_UP);
            expect(words).not.toMatch(RAW_CODE);
          }
        }
      }
    }
  });
});
