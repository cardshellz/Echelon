import { describe, expect, it } from "vitest";

import {
  DEFAULT_SALES_STATUS,
  levelSetting,
  resolveSalesStatus,
  salesStatusScopeKey,
  type SalesStatusValue,
} from "../sales-status-resolution";

const SHOPIFY = 36;
const EBAY = 67;
const PRODUCT = 11;
const SKU = 22;

function entry(scope: { channelId: number | null; productVariantId: number | null }, status: SalesStatusValue) {
  return { scopeKey: salesStatusScopeKey({ ...scope, productId: PRODUCT }), status };
}

const skuOnShopify = (status: SalesStatusValue) => entry({ channelId: SHOPIFY, productVariantId: SKU }, status);
const skuEverywhere = (status: SalesStatusValue) => entry({ channelId: null, productVariantId: SKU }, status);
const productOnShopify = (status: SalesStatusValue) => entry({ channelId: SHOPIFY, productVariantId: null }, status);
const productEverywhere = (status: SalesStatusValue) => entry({ channelId: null, productVariantId: null }, status);

function resolve(channelId: number, entries: Array<{ scopeKey: string; status: SalesStatusValue }>) {
  return resolveSalesStatus({ channelId, productId: PRODUCT, productVariantId: SKU, entries });
}

describe("sales status scope keys", () => {
  it("names all-channel and channel scopes for products and SKUs", () => {
    expect(salesStatusScopeKey({ channelId: null, productId: 11, productVariantId: null })).toBe("all:product:11");
    expect(salesStatusScopeKey({ channelId: 36, productId: 11, productVariantId: null })).toBe("channel:36:product:11");
    expect(salesStatusScopeKey({ channelId: null, productId: 11, productVariantId: 22 })).toBe("all:variant:22");
    expect(salesStatusScopeKey({ channelId: 36, productId: 11, productVariantId: 22 })).toBe("channel:36:variant:22");
  });

  it("keys a SKU setting by the SKU alone, so it follows the SKU", () => {
    expect(salesStatusScopeKey({ channelId: 36, productId: 11, productVariantId: 22 }))
      .toBe(salesStatusScopeKey({ channelId: 36, productId: 99, productVariantId: 22 }));
  });

  it("reads one level's channel exception before its all-channels setting", () => {
    const entries = [productEverywhere("stopped"), productOnShopify("selling")];
    expect(levelSetting(entries, { channelId: SHOPIFY, productId: PRODUCT, productVariantId: null })).toBe(entries[1]);
    expect(levelSetting(entries, { channelId: EBAY, productId: PRODUCT, productVariantId: null })).toBe(entries[0]);
    expect(levelSetting(entries, { channelId: EBAY, productId: PRODUCT, productVariantId: SKU })).toBeNull();
  });
});

describe("resolveSalesStatus (owner decision 2026-11-07: a stop always wins)", () => {
  it("defaults to Selling with no source when nothing is set", () => {
    expect(resolve(SHOPIFY, [])).toEqual({ status: DEFAULT_SALES_STATUS, source: null, stoppedByProduct: false });
    expect(DEFAULT_SALES_STATUS).toBe("selling");
  });

  it("stops a product everywhere except the channel with a Selling exception", () => {
    const entries = [productEverywhere("stopped"), productOnShopify("selling")];
    expect(resolve(SHOPIFY, entries)).toEqual({ status: "selling", source: entries[1], stoppedByProduct: false });
    expect(resolve(EBAY, entries)).toEqual({ status: "stopped", source: entries[0], stoppedByProduct: true });
  });

  it("lets a stopped product stop every SKU, and no SKU setting override it", () => {
    const entries = [productEverywhere("stopped"), skuOnShopify("selling")];
    expect(resolve(SHOPIFY, entries)).toEqual({ status: "stopped", source: entries[0], stoppedByProduct: true });
  });

  it("stops a product's SKUs only on the channel where the product is stopped", () => {
    const entries = [productOnShopify("stopped")];
    expect(resolve(SHOPIFY, entries)).toEqual({ status: "stopped", source: entries[0], stoppedByProduct: true });
    expect(resolve(EBAY, entries)).toEqual({ status: "selling", source: null, stoppedByProduct: false });
  });

  it("stops a SKU on its own while the product sells, everywhere except its own Selling exception", () => {
    const entries = [skuEverywhere("stopped"), skuOnShopify("selling")];
    expect(resolve(SHOPIFY, entries)).toEqual({ status: "selling", source: entries[1], stoppedByProduct: false });
    expect(resolve(EBAY, entries)).toEqual({ status: "stopped", source: entries[0], stoppedByProduct: false });
  });

  it("names the product as the reason when both the product and the SKU are stopped", () => {
    const entries = [skuEverywhere("stopped"), productEverywhere("stopped")];
    expect(resolve(EBAY, entries)).toEqual({ status: "stopped", source: entries[1], stoppedByProduct: true });
  });

  it("ignores settings for other products and SKUs", () => {
    const other = [
      { scopeKey: "all:product:12", status: "stopped" as const },
      { scopeKey: "all:variant:23", status: "stopped" as const },
      { scopeKey: "channel:36:variant:23", status: "stopped" as const },
    ];
    expect(resolve(SHOPIFY, other)).toEqual({ status: "selling", source: null, stoppedByProduct: false });
  });

  it("sells only when both levels sell, across all 81 combinations of the four scopes", () => {
    const makers = [skuOnShopify, skuEverywhere, productOnShopify, productEverywhere];
    const choices = [null, "selling", "stopped"] as const;
    for (let code = 0; code < 81; code += 1) {
      const picked = makers.map((_, index) => choices[Math.floor(code / 3 ** index) % 3]);
      const entries = makers.flatMap((make, index) => picked[index] ? [make(picked[index]!)] : []);
      // Each level reads its channel setting before its all-channels setting.
      const skuLevel = picked[0] ?? picked[1];
      const productLevel = picked[2] ?? picked[3];
      const expected = skuLevel === "stopped" || productLevel === "stopped" ? "stopped" : "selling";
      const result = resolve(SHOPIFY, entries);
      expect(result.status, JSON.stringify(picked)).toBe(expected);
      expect(result.stoppedByProduct, JSON.stringify(picked)).toBe(productLevel === "stopped");
    }
  });
});
