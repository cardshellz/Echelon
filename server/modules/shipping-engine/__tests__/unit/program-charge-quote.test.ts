import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  loadCharges: vi.fn(),
}));
vi.mock("../../../../db", () => {
  const chain: Record<string, unknown> = {};
  for (const name of [
    "select",
    "from",
    "innerJoin",
    "where",
    "limit",
    "orderBy",
  ])
    chain[name] = () => chain;
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(state.rows.shift()).then(resolve);
  return { db: chain, pool: {} };
});
vi.mock("../../infrastructure/shared-configuration.repository", () => ({
  SharedShippingConfigurationRepository: class {
    loadCharges = state.loadCharges;
  },
}));
vi.mock("../../infrastructure/product-rate-policy.repository", () => ({
  loadProductRateRules: async () => new Map(),
}));
import { quoteShipmentRates } from "../../application/rate-quote.service";

describe("program charges in the actual rate orchestration", () => {
  const at = new Date("2026-09-09T12:00:00Z");
  beforeEach(() => {
    state.rows = [
      [{ id: 1, code: "configured", zoneSetId: 1 }],
      [],
      [
        {
          rateTableId: 5,
          serviceLevelId: 1,
          serviceLevelCode: "standard",
          displayName: "Standard",
          description: null,
          fulfillmentMode: "parcel",
          pricingBasis: "shipment_weight",
          sortOrder: 1,
          promiseMinBusinessDays: null,
          promiseMaxBusinessDays: null,
          currency: "USD",
          originWarehouseId: null,
          destinationCountry: "US",
          destinationRegion: "PA",
          postalPrefix: null,
          minMeasure: 0,
          maxMeasure: 10000,
          maxShipmentWeightGrams: null,
          chargeModel: "fixed_band",
          rateCents: 800,
          perStartedPoundCents: null,
        },
      ],
    ];
    state.loadCharges.mockReset().mockResolvedValue({
      revision: 3,
      charges: {
        markup: { bps: 100, fixedCents: 0, minCents: null, maxCents: null },
        insurance: { bps: 200, fixedCents: 0, minCents: null, maxCents: null },
      },
    });
  });
  it.each(["dropship", "shopify", "internal"] as const)(
    "applies the selected program once for %s",
    async (channel) => {
      const result = await quoteShipmentRates(
        {
          rateBookId: 1,
          rateContext: {
            pricingChannel: channel,
            purpose:
              channel === "dropship"
                ? "vendor_fulfillment_charge"
                : "customer_checkout",
          },
          originWarehouseId: 1,
          destCountry: "US",
          destRegion: "PA",
          destPostal: "16046",
          parcels: [{ billableWeightGrams: 635 }, { billableWeightGrams: 635 }],
        },
        { quotedAt: at },
      );
      expect(result.quotes[0]).toMatchObject({
        totalCents: 824,
        ratedMeasure: 1270,
        programCharges: {
          revision: 3,
          baseCents: 800,
          markupCents: 8,
          insuranceCents: 16,
          totalCents: 824,
        },
      });
      expect(state.loadCharges).toHaveBeenCalledExactlyOnceWith(1, at);
      expect(state.rows).toEqual([]);
    },
  );
  it("does not manufacture a quote when the required fee revision is unavailable", async () => {
    state.loadCharges.mockRejectedValue(
      new Error("SHIPPING_CHARGE_POLICY_REQUIRED"),
    );
    await expect(
      quoteShipmentRates(
        {
          rateBookId: 1,
          rateContext: {
            pricingChannel: "dropship",
            purpose: "vendor_fulfillment_charge",
          },
          originWarehouseId: 1,
          destCountry: "US",
          destRegion: "PA",
          destPostal: "16046",
          parcels: [{ billableWeightGrams: 635 }],
        },
        { quotedAt: at },
      ),
    ).rejects.toThrow("SHIPPING_CHARGE_POLICY_REQUIRED");
  });
});
