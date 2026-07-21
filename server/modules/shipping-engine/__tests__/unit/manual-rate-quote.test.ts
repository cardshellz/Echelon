import { describe, expect, it, vi } from "vitest";
import {
  ManualRateQuoteError,
  runManualRateQuote,
  type ManualRateQuoteDependencies,
  type ManualRateQuoteInput,
} from "../../application/manual-rate-quote.service";
import { manualRateQuoteRequestSchema } from "../../interfaces/http/manual-rate-quote.routes";

const FIXED_NOW = new Date("2026-07-20T15:30:00.000Z");

const VALID_INPUT: ManualRateQuoteInput = {
  expectedRateBookId: 12,
  pricingChannel: "shopify",
  ratePurpose: "customer_checkout",
  originWarehouseId: 1,
  destinationCountry: "US",
  destinationRegion: "Pennsylvania",
  destinationPostalCode: "16066-1234",
  billableWeightGrams: 454,
};

function dependencies(
  overrides: Partial<ManualRateQuoteDependencies> = {},
): ManualRateQuoteDependencies {
  return {
    now: () => FIXED_NOW,
    quoteShipmentRates: vi.fn(async () => ({
      rateBook: { id: 12, code: "shopify-retail-default" },
      zone: "LOCAL",
      quotes: [{
        serviceLevelId: 1,
        serviceLevelCode: "standard",
        displayName: "Standard Shipping",
        description: null,
        fulfillmentMode: "parcel",
        pricingBasis: "shipment_weight",
        totalCents: 799,
        currency: "USD",
        promiseMinBusinessDays: 3,
        promiseMaxBusinessDays: 7,
        ratedMeasure: 454,
        maxShipmentWeightGrams: null,
      }],
      warnings: [],
    })),
    ...overrides,
  };
}

describe("runManualRateQuote", () => {
  it("tests the active runtime assignment and persists a manual snapshot", async () => {
    const deps = dependencies();

    const result = await runManualRateQuote(VALID_INPUT, deps);

    expect(result).toMatchObject({
      outcome: "quoted",
      testedAt: FIXED_NOW.toISOString(),
      rateOwner: "echelon",
      destination: { country: "US", region: "PA", postalCode: "16066" },
      rateBook: { id: 12, code: "shopify-retail-default" },
      quotes: [{ totalCents: 799, currency: "USD" }],
    });
    expect(deps.quoteShipmentRates).toHaveBeenCalledWith({
      rateContext: { pricingChannel: "shopify", purpose: "customer_checkout" },
      originWarehouseId: 1,
      destCountry: "US",
      destRegion: "PA",
      destPostal: "16066",
      parcels: [{ billableWeightGrams: 454 }],
    }, {
      quotedAt: FIXED_NOW,
      persistSnapshot: true,
    });
  });

  it("surfaces when runtime routing selects a different program", async () => {
    const deps = dependencies({
      quoteShipmentRates: vi.fn(async () => ({
        rateBook: { id: 99, code: "warehouse-override" },
        zone: null,
        quotes: [],
        warnings: [],
      })),
    });

    const result = await runManualRateQuote(VALID_INPUT, deps);

    expect(result.outcome).toBe("rate_book_mismatch");
    expect(result.warnings).toContain(
      "Runtime assignment selected rate book 99, not expected rate book 12.",
    );
  });

  it("refuses non-US tests without calling the Echelon rate engine", async () => {
    const deps = dependencies();

    await expect(runManualRateQuote({
      ...VALID_INPUT,
      destinationCountry: "DK",
      destinationRegion: "Hovedstaden",
      destinationPostalCode: "2100",
    }, deps)).rejects.toMatchObject<Partial<ManualRateQuoteError>>({
      code: "SHIPPING_RATE_TEST_US_ONLY",
    });
    expect(deps.quoteShipmentRates).not.toHaveBeenCalled();
  });
});

describe("manualRateQuoteRequestSchema", () => {
  it("accepts a complete bounded request and rejects unchecked fields", () => {
    const request = {
      expectedRateBookId: 12,
      pricingChannel: "shopify",
      ratePurpose: "customer_checkout",
      originWarehouseId: 1,
      destination: { country: "US", region: "PA", postalCode: "16066" },
      billableWeightGrams: 454,
    };

    expect(manualRateQuoteRequestSchema.safeParse(request).success).toBe(true);
    expect(manualRateQuoteRequestSchema.safeParse({ ...request, ignored: true }).success).toBe(false);
    expect(manualRateQuoteRequestSchema.safeParse({
      ...request,
      billableWeightGrams: 453.5,
    }).success).toBe(false);
  });
});
