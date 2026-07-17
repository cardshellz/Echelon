import { describe, expect, it } from "vitest";
import {
  selectServiceLevelRates,
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
    rateCents: 899,
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
});
