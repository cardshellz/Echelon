import { describe, expect, it, vi } from "vitest";
import {
  applyPricingRule,
  parseDollarPriceToCents,
  resolveChannelListingPrice,
} from "../../channel-pricing-resolver";

function createMockDb(responses: unknown[][]) {
  const pending = [...responses];
  const select = vi.fn(() => {
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(pending.shift() ?? []).then(resolve, reject),
    };
    return query;
  });
  return { select };
}

describe("channel pricing resolver", () => {
  it("parses dollar prices to integer cents without float math", () => {
    expect(parseDollarPriceToCents("5.49")).toBe(549);
    expect(parseDollarPriceToCents("219.99")).toBe(21999);
    expect(parseDollarPriceToCents("0.009")).toBeNull();
  });

  it("uses explicit channel pricing without applying pricing rules again", async () => {
    const db = createMockDb([
      [{ price: 1234 }],
    ]);

    const result = await resolveChannelListingPrice(db as any, {
      channelId: 67,
      productId: 232,
      variantId: 463,
      fallbackCatalogPriceCents: null,
    });

    expect(result).toMatchObject({
      priceCents: 1234,
      basePriceCents: 1234,
      source: "channel_pricing",
      appliedRule: null,
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("uses retail cache as the default base before channel pricing rules", async () => {
    const db = createMockDb([
      [],
      [{ sku: "SHLZ-TOP-180PT-BLU-P10", shopifyVariantId: "62745849495711", catalogPriceCents: null }],
      [{ price: "5.49" }],
      [],
      [],
      [{ productType: "toploaders" }],
      [],
      [{ id: 1, scope: "channel", scopeId: null, ruleType: "percentage", value: "15.00" }],
    ]);

    const result = await resolveChannelListingPrice(db as any, {
      channelId: 67,
      productId: 232,
      variantId: 463,
      fallbackCatalogPriceCents: null,
    });

    expect(result).toMatchObject({
      priceCents: 631,
      basePriceCents: 549,
      source: "retail_cache",
      appliedRule: {
        id: 1,
        scope: "channel",
        ruleType: "percentage",
        value: "15.00",
      },
    });
  });

  it("falls back to catalog price only when channel and retail cache prices are missing", async () => {
    const db = createMockDb([
      [],
      [{ sku: "SKU-1", shopifyVariantId: null, catalogPriceCents: 2500 }],
      [],
      [],
      [],
      [{ productType: null }],
      [],
    ]);

    const result = await resolveChannelListingPrice(db as any, {
      channelId: 67,
      productId: 10,
      variantId: 20,
      fallbackCatalogPriceCents: null,
    });

    expect(result).toMatchObject({
      priceCents: 2500,
      basePriceCents: 2500,
      source: "catalog_variant",
      appliedRule: null,
    });
  });

  it("applies fixed and override rules in cents", () => {
    expect(applyPricingRule(1000, "fixed", "2.50")).toBe(1250);
    expect(applyPricingRule(1000, "override", "9.99")).toBe(999);
  });
});
