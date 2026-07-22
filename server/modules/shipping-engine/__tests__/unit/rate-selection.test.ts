import { describe, expect, it } from "vitest";
import {
  selectServiceLevelRates,
  startedPoundsFromGrams,
  type RateCandidateRow,
} from "../../domain/rate-selection";

function row(overrides: Partial<RateCandidateRow> = {}): RateCandidateRow {
  return {
    rateTableId: 1,
    serviceLevelId: 1,
    serviceLevelCode: "standard",
    displayName: "Standard Shipping",
    description: "Economical parcel delivery",
    fulfillmentMode: "parcel",
    pricingBasis: "shipment_weight",
    sortOrder: 10,
    promiseMinBusinessDays: 3,
    promiseMaxBusinessDays: 7,
    currency: "USD",
    originWarehouseId: null,
    destinationCountry: "US",
    destinationRegion: "PA",
    postalPrefix: null,
    minMeasure: 0,
    maxMeasure: 1000,
    maxShipmentWeightGrams: null,
    chargeModel: "fixed_band",
    rateCents: 899,
    perStartedPoundCents: null,
    ...overrides,
  };
}

const INPUT = {
  destinationCountry: "US",
  destinationRegion: "PA",
  destinationPostal: "16066",
  shipmentWeightGrams: 500,
  palletCount: null,
  originWarehouseId: 7,
};

describe("selectServiceLevelRates", () => {
  it("returns no offers for empty input", () => {
    expect(selectServiceLevelRates([], INPUT)).toEqual([]);
  });

  it("returns the matching statewide service level", () => {
    expect(selectServiceLevelRates([row()], INPUT)).toEqual([{
      serviceLevelId: 1,
      serviceLevelCode: "standard",
      displayName: "Standard Shipping",
      description: "Economical parcel delivery",
      fulfillmentMode: "parcel",
      pricingBasis: "shipment_weight",
      sortOrder: 10,
      promiseMinBusinessDays: 3,
      promiseMaxBusinessDays: 7,
      currency: "USD",
      rateCents: 899,
      chargeModel: "fixed_band",
      perStartedPoundCents: null,
      billablePounds: null,
      rateTableId: 1,
      ratedMeasure: 500,
      maxShipmentWeightGrams: null,
      warehouseSpecific: false,
      postalSpecific: false,
    }]);
  });

  it("uses the longest matching ZIP prefix before the statewide fallback", () => {
    const quotes = selectServiceLevelRates([
      row({ rateCents: 500 }),
      row({ postalPrefix: "160", rateCents: 700 }),
      row({ postalPrefix: "16066", rateCents: 900 }),
      row({ postalPrefix: "191", rateCents: 100 }),
    ], INPUT);
    expect(quotes[0]).toMatchObject({ rateCents: 900, postalSpecific: true });
  });

  it("prefers a warehouse-specific row over a cheaper global row", () => {
    const quotes = selectServiceLevelRates([
      row({ originWarehouseId: null, rateCents: 500 }),
      row({ originWarehouseId: 7, rateCents: 950 }),
    ], INPUT);
    expect(quotes[0]).toMatchObject({ rateCents: 950, warehouseSpecific: true });
  });

  it("returns every matching service level in configured order", () => {
    const quotes = selectServiceLevelRates([
      row({
        serviceLevelId: 3,
        serviceLevelCode: "express",
        displayName: "Overnight Shipping",
        sortOrder: 30,
        rateCents: 2999,
      }),
      row(),
      row({
        serviceLevelId: 2,
        serviceLevelCode: "expedited",
        displayName: "Priority Shipping",
        sortOrder: 20,
        rateCents: 1599,
      }),
    ], INPUT);
    expect(quotes.map((quote) => quote.serviceLevelCode)).toEqual([
      "standard",
      "expedited",
      "express",
    ]);
  });

  it("does not quote pallet freight without a pallet count", () => {
    const freight = row({
      serviceLevelId: 4,
      serviceLevelCode: "pallet_freight",
      displayName: "Pallet Freight",
      fulfillmentMode: "freight",
      pricingBasis: "pallet_count",
      minMeasure: 1,
      maxMeasure: 2,
    });
    expect(selectServiceLevelRates([freight], INPUT)).toEqual([]);
  });

  it("quotes pallet freight by pallet count", () => {
    const freight = row({
      serviceLevelId: 4,
      serviceLevelCode: "pallet_freight",
      displayName: "Pallet Freight",
      fulfillmentMode: "freight",
      pricingBasis: "pallet_count",
      minMeasure: 1,
      maxMeasure: 2,
      rateCents: 18900,
    });
    const quotes = selectServiceLevelRates([freight], { ...INPUT, palletCount: 2 });
    expect(quotes[0]).toMatchObject({
      serviceLevelCode: "pallet_freight",
      ratedMeasure: 2,
      rateCents: 18900,
    });
  });

  it("enforces an optional pallet shipment-weight ceiling", () => {
    const freight = row({
      serviceLevelId: 4,
      serviceLevelCode: "pallet_freight",
      fulfillmentMode: "freight",
      pricingBasis: "pallet_count",
      minMeasure: 1,
      maxMeasure: 2,
      maxShipmentWeightGrams: 499,
    });
    expect(selectServiceLevelRates([freight], { ...INPUT, palletCount: 1 })).toEqual([]);
    expect(selectServiceLevelRates([
      { ...freight, maxShipmentWeightGrams: 500 },
    ], { ...INPUT, palletCount: 1 })).toHaveLength(1);
  });

  it("matches a fixed final band with no maximum", () => {
    const quotes = selectServiceLevelRates([
      row({ minMeasure: 908, maxMeasure: null, rateCents: 2499 }),
    ], { ...INPUT, shipmentWeightGrams: 100_000 });

    expect(quotes[0]).toMatchObject({ rateCents: 2499, billablePounds: null });
  });

  it("keeps an exact two-pound boundary in the band ending at two pounds", () => {
    const quotes = selectServiceLevelRates([
      row({ minMeasure: 0, maxMeasure: 907, rateCents: 1000 }),
      row({ minMeasure: 908, maxMeasure: null, rateCents: 2000 }),
    ], { ...INPUT, shipmentWeightGrams: 907 });

    expect(quotes[0]).toMatchObject({ rateCents: 1000 });
  });

  it("charges the base plus each started pound", () => {
    const formula = row({
      minMeasure: 0,
      maxMeasure: null,
      chargeModel: "base_plus_per_started_pound",
      rateCents: 300,
      perStartedPoundCents: 100,
    });

    expect(selectServiceLevelRates([formula], { ...INPUT, shipmentWeightGrams: 0 })[0])
      .toMatchObject({ rateCents: 300, billablePounds: 0 });
    expect(selectServiceLevelRates([formula], { ...INPUT, shipmentWeightGrams: 908 })[0])
      .toMatchObject({ rateCents: 600, billablePounds: 3 });
  });

  it("does not emit an unsafe formula total", () => {
    const formula = row({
      minMeasure: 0,
      maxMeasure: null,
      chargeModel: "base_plus_per_started_pound",
      rateCents: Number.MAX_SAFE_INTEGER,
      perStartedPoundCents: 1,
    });

    expect(selectServiceLevelRates([formula], { ...INPUT, shipmentWeightGrams: 454 })).toEqual([]);
  });
});

describe("startedPoundsFromGrams", () => {
  it.each([
    [0, 0],
    [454, 1],
    [907, 2],
    [908, 3],
  ])("maps %i grams to %i started pounds", (grams, pounds) => {
    expect(startedPoundsFromGrams(grams)).toBe(pounds);
  });
});
