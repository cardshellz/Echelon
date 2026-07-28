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
    loadCatalogShippingFactsBySku: vi.fn(async () => new Map()),
    quoteCartShipment: vi.fn(async () => ({
      ok: false, code: "INVALID_SHIPMENT", errors: ["not configured"],
    })),
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
      testedShipment: {
        basis: "weight",
        billableWeightGrams: 454,
        lines: [],
      },
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

  it("resolves catalog lines and runs the production shipment quote path", async () => {
    const loadCatalogShippingFactsBySku = vi.fn(async () => new Map([
      ["PACK-1", {
        productVariantId: 20,
        weightGrams: 500,
        shippingGroupCode: "storage-boxes",
        shipsInOwnContainer: false,
      }],
    ]));
    const quoteCartShipment = vi.fn(async () => ({
      ok: true as const,
      parcelPlan: {
        provider: { name: "channel-weight", version: "1.0.0" },
        strategy: "single_weight_based_shipment",
        rateSelectionWeightGrams: 1_000,
        parcels: [{
          sequence: 1,
          source: "channel_weight" as const,
          actualWeightGrams: 1_000,
          billableWeightGrams: 1_000,
          dimensions: null,
          shippingGroupCode: null,
        }],
        warnings: [],
      },
      rates: {
        rateBook: { id: 12, code: "shopify-retail-default" },
        zone: "LOCAL",
        quotes: [{
          serviceLevelId: 1,
          serviceLevelCode: "standard",
          displayName: "Standard Shipping",
          description: null,
          fulfillmentMode: "parcel" as const,
          pricingBasis: "shipment_weight" as const,
          totalCents: 1_799,
          currency: "USD",
          promiseMinBusinessDays: 3,
          promiseMaxBusinessDays: 7,
          ratedMeasure: 1_000,
          maxShipmentWeightGrams: null,
          chargeModel: "fixed_band" as const,
          perStartedPoundCents: null,
          billablePounds: null,
          rateTableId: 7,
          productPolicyApplied: true,
          calculationTrace: [{
            kind: "base_charge" as const,
            ruleId: 3,
            label: "Storage Box Packs",
            amountCents: 1_799,
            skus: ["PACK-1"],
          }],
        }],
        warnings: [],
      },
    }));
    const deps = dependencies({
      loadCatalogShippingFactsBySku,
      quoteCartShipment,
    });

    const result = await runManualRateQuote({
      ...VALID_INPUT,
      billableWeightGrams: undefined,
      lines: [{ sku: " PACK-1 ", quantity: 2 }],
    }, deps);

    expect(loadCatalogShippingFactsBySku).toHaveBeenCalledWith(["PACK-1"]);
    expect(quoteCartShipment).toHaveBeenCalledWith({
      channel: "shopify",
      ratePurpose: "customer_checkout",
      originWarehouseId: 1,
      destination: {
        country: "US",
        region: "PA",
        postalCode: "16066",
      },
      lines: [{
        sku: "PACK-1",
        productVariantId: 20,
        quantity: 2,
        unitWeightGrams: 500,
        weightSource: "echelon_catalog",
        shippingGroupCode: "storage-boxes",
        shipsInOwnContainer: false,
      }],
      quotedAt: FIXED_NOW,
      persistSnapshot: true,
    });
    expect(deps.quoteShipmentRates).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "quoted",
      testedShipment: {
        basis: "catalog_lines",
        billableWeightGrams: 1_000,
        lines: [{
          sku: "PACK-1",
          productVariantId: 20,
          quantity: 2,
          unitWeightGrams: 500,
        }],
      },
      quotes: [{
        totalCents: 1_799,
        productPolicyApplied: true,
      }],
    });
  });

  it("reports an intentional product restriction as a blocked shipment", async () => {
    const deps = dependencies({
      loadCatalogShippingFactsBySku: vi.fn(async () => new Map([
        ["CASE-1", {
          productVariantId: 20,
          weightGrams: 5_000,
          shippingGroupCode: "storage-boxes",
          shipsInOwnContainer: true,
        }],
        ["PACK-1", {
          productVariantId: 21,
          weightGrams: 500,
          shippingGroupCode: "storage-boxes",
          shipsInOwnContainer: false,
        }],
      ])),
      quoteCartShipment: vi.fn(async () => ({
        ok: true as const,
        parcelPlan: {
          provider: { name: "channel-weight", version: "1.0.0" },
          strategy: "single_weight_based_shipment",
          rateSelectionWeightGrams: 5_500,
          parcels: [{
            sequence: 1,
            source: "channel_weight" as const,
            actualWeightGrams: 5_500,
            billableWeightGrams: 5_500,
            dimensions: null,
            shippingGroupCode: null,
          }],
          warnings: [],
        },
        rates: {
          rateBook: { id: 12, code: "shopify-retail-default" },
          zone: "HI",
          quotes: [],
          serviceLevelExclusions: [{
            serviceLevelId: 1,
            serviceLevelCode: "standard",
            displayName: "Standard Shipping",
            code: "BLOCKED" as const,
            message: "Storage Box Cases blocks this shipment destination.",
            ruleId: 44,
          }],
          warnings: [
            "standard: [BLOCKED] Storage Box Cases blocks this shipment destination.",
            "no active service-level rate covers US HI 96815",
          ],
        },
      })),
    });

    const result = await runManualRateQuote({
      ...VALID_INPUT,
      destinationRegion: "HI",
      destinationPostalCode: "96815",
      billableWeightGrams: undefined,
      lines: [
        { sku: "CASE-1", quantity: 1 },
        { sku: "PACK-1", quantity: 1 },
      ],
    }, deps);

    expect(result.outcome).toBe("blocked");
    expect(result.quotes).toEqual([]);
    expect(result.serviceLevelExclusions).toEqual([expect.objectContaining({
      code: "BLOCKED",
      ruleId: 44,
      message: "Storage Box Cases blocks this shipment destination.",
    })]);
  });

  it("rejects unknown catalog SKUs before invoking the quote engine", async () => {
    const deps = dependencies();

    await expect(runManualRateQuote({
      ...VALID_INPUT,
      billableWeightGrams: undefined,
      lines: [{ sku: "UNKNOWN", quantity: 1 }],
    }, deps)).rejects.toMatchObject<Partial<ManualRateQuoteError>>({
      code: "SHIPPING_RATE_TEST_SKU_NOT_FOUND",
      context: { skus: ["UNKNOWN"] },
    });
    expect(deps.quoteCartShipment).not.toHaveBeenCalled();
    expect(deps.quoteShipmentRates).not.toHaveBeenCalled();
  });

  it("rejects catalog SKUs without a canonical weight", async () => {
    const deps = dependencies({
      loadCatalogShippingFactsBySku: vi.fn(async () => new Map([
        ["MISSING-WEIGHT", {
          productVariantId: 21,
          weightGrams: null,
          shippingGroupCode: null,
          shipsInOwnContainer: false,
        }],
      ])),
    });

    await expect(runManualRateQuote({
      ...VALID_INPUT,
      billableWeightGrams: undefined,
      lines: [{ sku: "MISSING-WEIGHT", quantity: 1 }],
    }, deps)).rejects.toMatchObject<Partial<ManualRateQuoteError>>({
      code: "SHIPPING_RATE_TEST_SKU_WEIGHT_MISSING",
      context: { skus: ["MISSING-WEIGHT"] },
    });
    expect(deps.quoteCartShipment).not.toHaveBeenCalled();
    expect(deps.quoteShipmentRates).not.toHaveBeenCalled();
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
    expect(manualRateQuoteRequestSchema.safeParse({
      ...request,
      billableWeightGrams: undefined,
      lines: [{ sku: "PACK-1", quantity: 2 }],
    }).success).toBe(true);
    expect(manualRateQuoteRequestSchema.safeParse({
      ...request,
      lines: [{ sku: "PACK-1", quantity: 2 }],
    }).success).toBe(false);
    expect(manualRateQuoteRequestSchema.safeParse({
      ...request,
      billableWeightGrams: undefined,
    }).success).toBe(false);
  });
});
