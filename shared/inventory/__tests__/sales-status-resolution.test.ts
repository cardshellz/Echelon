import { describe, expect, it } from "vitest";

import {
  DEFAULT_SALES_STATUS,
  resolveSalesStatus,
  salesStatusPrecedence,
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

  it("lists SKU before product and the channel before all channels", () => {
    expect(salesStatusPrecedence({ channelId: SHOPIFY, productId: PRODUCT, productVariantId: SKU })).toEqual([
      "channel:36:variant:22", "all:variant:22", "channel:36:product:11", "all:product:11",
    ]);
  });
});

describe("resolveSalesStatus (owner precedence 2026-11-07)", () => {
  it("defaults to Selling with no source when nothing is set", () => {
    expect(resolve(SHOPIFY, [])).toEqual({ status: DEFAULT_SALES_STATUS, source: null });
    expect(DEFAULT_SALES_STATUS).toBe("selling");
  });

  it("stops everywhere except the channel with a Selling exception", () => {
    const entries = [productEverywhere("stopped"), productOnShopify("selling")];
    expect(resolve(SHOPIFY, entries)).toEqual({ status: "selling", source: entries[1] });
    expect(resolve(EBAY, entries)).toEqual({ status: "stopped", source: entries[0] });
  });

  it("lets a SKU stopped on all channels beat its product's channel exception", () => {
    const entries = [productEverywhere("stopped"), productOnShopify("selling"), skuEverywhere("stopped")];
    expect(resolve(SHOPIFY, entries)).toEqual({ status: "stopped", source: entries[2] });
  });

  it("lets a SKU channel exception beat the SKU's all-channels setting", () => {
    const entries = [skuEverywhere("stopped"), skuOnShopify("selling")];
    expect(resolve(SHOPIFY, entries).status).toBe("selling");
    expect(resolve(EBAY, entries).status).toBe("stopped");
  });

  it("lets a SKU Selling on all channels override a product stopped on all channels", () => {
    expect(resolve(EBAY, [productEverywhere("stopped"), skuEverywhere("selling")]).status).toBe("selling");
  });

  it("applies a channel exception only to its own channel", () => {
    expect(resolve(EBAY, [skuOnShopify("stopped")])).toEqual({ status: "selling", source: null });
    expect(resolve(SHOPIFY, [skuOnShopify("stopped")]).status).toBe("stopped");
  });

  it("ignores settings for other products and SKUs", () => {
    const other = [
      { scopeKey: "all:product:12", status: "stopped" as const },
      { scopeKey: "all:variant:23", status: "stopped" as const },
      { scopeKey: "channel:36:variant:23", status: "stopped" as const },
    ];
    expect(resolve(SHOPIFY, other)).toEqual({ status: "selling", source: null });
  });

  it("checks every one of the 16 set/unset combinations against the precedence list", () => {
    const scopes = [skuOnShopify, skuEverywhere, productOnShopify, productEverywhere];
    for (let mask = 0; mask < 16; mask += 1) {
      // Alternate statuses so the winner is always identifiable by its status and key.
      const entries = scopes.flatMap((make, index) => (mask & (1 << index))
        ? [make(index % 2 === 0 ? "stopped" : "selling")] : []);
      const winner = scopes.findIndex((_, index) => mask & (1 << index));
      const result = resolve(SHOPIFY, entries);
      if (winner === -1) {
        expect(result).toEqual({ status: "selling", source: null });
      } else {
        expect(result.source?.scopeKey).toBe(salesStatusPrecedence({ channelId: SHOPIFY, productId: PRODUCT, productVariantId: SKU })[winner]);
        expect(result.status).toBe(winner % 2 === 0 ? "stopped" : "selling");
      }
    }
  });
});
