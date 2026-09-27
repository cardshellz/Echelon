import { describe, expect, it } from "vitest";
import {
  listingCatalogItemSchema,
  listingDraftItemSchema,
} from "@shared/types/channel-listing-publication";
import {
  addDraftItems,
  dollarsToCents,
  mergeRetryDraftItems,
  money,
  previewRulePrice,
} from "../model";
import { resolveFieldSchema } from "../SchemaFields";

const catalog = (variantId = 1) =>
  listingCatalogItemSchema.parse({
    variantId,
    productId: 10,
    sku: `SKU-${variantId}`,
    name: "Card sleeves",
    variantName: "Pack 100",
    unitLabel: "1 pack = 100 sleeves",
    productType: "sleeves",
    title: "Card sleeves",
    description: null,
    brand: null,
    images: [],
    identifier: null,
    priceCents: 499,
    basePriceCents: 499,
    priceSource: "catalog_variant",
    appliedRule: null,
    appliedRuleScope: null,
    eligible: true,
    alreadyLinked: false,
    sourceHash: "a".repeat(64),
  });

describe("explicit publication selection", () => {
  it("adds exact chosen variants once without auto-selecting siblings or mutating input", () => {
    const original = [
      listingDraftItemSchema.parse({ variantId: 1, title: "Saved override" }),
    ];
    const result = addDraftItems(original, [
      catalog(1),
      catalog(2),
      catalog(2),
    ]);
    expect(result.map((item) => item.variantId)).toEqual([1, 2]);
    expect(result[0].title).toBe("Saved override");
    expect(original).toHaveLength(1);
    expect(result[1].productType).toBe("");
  });
  it("excludes unavailable and already-linked variants", () => {
    expect(
      addDraftItems(
        [],
        [
          { ...catalog(1), eligible: false },
          { ...catalog(2), alreadyLinked: true },
        ],
      ),
    ).toEqual([]);
  });
  it("rejects exceeding the draft cap without modifying the previous selection", () => {
    const existing = Array.from({ length: 100 }, (_, i) =>
      listingDraftItemSchema.parse({ variantId: i + 1 }),
    );
    expect(() => addDraftItems(existing, [catalog(101)])).toThrow(
      "at most 100",
    );
    expect(existing).toHaveLength(100);
  });
  it("merges retryable failures without overwriting unsaved item edits", () => {
    const current = [
      listingDraftItemSchema.parse({
        variantId: 1,
        title: "My unsaved correction",
      }),
    ];
    const retry = [
      listingDraftItemSchema.parse({
        variantId: 1,
        title: "Old submitted title",
      }),
      listingDraftItemSchema.parse({ variantId: 26, priceOverrideCents: 549 }),
    ];
    expect(mergeRetryDraftItems(current, retry)).toEqual([
      current[0],
      retry[1],
    ]);
    expect(current).toHaveLength(1);
  });
});

describe("exact monetary preview", () => {
  it("parses decimal strings without floating point rounding or scientific notation", () => {
    expect(dollarsToCents("1.01")).toBe(101);
    expect(dollarsToCents("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    for (const input of [
      "0",
      "-1",
      "1.001",
      "1e3",
      "NaN",
      "90071992547409.92",
      "9".repeat(10_000),
    ])
      expect(dollarsToCents(input)).toBeNull();
    expect(money(Number.MAX_SAFE_INTEGER)).toBe("$90071992547409.91");
  });
  it("rounds a percentage to the nearest cent and bounds overflow", () => {
    expect(
      previewRulePrice(catalog(), { type: "percentage", value: "10" }),
    ).toBe(549);
    expect(previewRulePrice(catalog(), { type: "fixed", value: "2.01" })).toBe(
      700,
    );
    expect(
      previewRulePrice(catalog(), { type: "override", value: "3.99" }),
    ).toBe(399);
    expect(
      previewRulePrice(
        { ...catalog(), basePriceCents: Number.MAX_SAFE_INTEGER },
        { type: "percentage", value: "10" },
      ),
    ).toBeNull();
  });
  it("preserves explicit and more-specific prices even when rules have identical values", () => {
    expect(
      previewRulePrice(
        { ...catalog(), priceSource: "channel_pricing", priceCents: 777 },
        { type: "override", value: "1" },
      ),
    ).toBe(777);
    expect(
      previewRulePrice(
        {
          ...catalog(),
          appliedRuleScope: "variant",
          appliedRule: { type: "percentage", value: "10" },
          priceCents: 549,
        },
        { type: "percentage", value: "20" },
      ),
    ).toBe(549);
  });
});

describe("provider schema editor references", () => {
  it("resolves bounded local references and inherited required fields", () => {
    const root = {
      definitions: { country: { type: "string", enum: ["US", "CA"] } },
    };
    expect(
      resolveFieldSchema(
        { $ref: "#/definitions/country", title: "Country" },
        root,
      ),
    ).toMatchObject({ type: "string", enum: ["US", "CA"], title: "Country" });
    expect(
      resolveFieldSchema(
        {
          allOf: [
            { properties: { first: { type: "string" } }, required: ["first"] },
            {
              properties: { second: { type: "number" } },
              required: ["second"],
            },
          ],
        },
        {},
      ),
    ).toMatchObject({
      required: ["first", "second"],
      properties: { first: { type: "string" }, second: { type: "number" } },
    });
  });
  it("does not resolve remote references or recurse without a bound", () => {
    expect(
      resolveFieldSchema({ $ref: "https://example.com/schema" }, {}),
    ).toEqual({ $ref: "https://example.com/schema" });
    expect(() =>
      resolveFieldSchema({ $ref: "#/loop" }, { loop: { $ref: "#/loop" } }),
    ).not.toThrow();
  });
});
