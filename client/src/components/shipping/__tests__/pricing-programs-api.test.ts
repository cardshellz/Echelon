import { describe, expect, it } from "vitest";
import {
  PRICING_FLOW_CHOICES,
  assignmentLabel,
  buildProgramOverviews,
  effectiveRateTableCoverages,
  pricingFlowKey,
  pricingFlowLabel,
  productRuleRevisionStatus,
  rateTableRegionCount,
  type RateBookAssignment,
  type RateTableSummary,
  type RateTablesResponse,
} from "../pricing-programs/api";

function assignment(overrides: Partial<RateBookAssignment> = {}): RateBookAssignment {
  return {
    id: 1,
    pricingChannel: "shopify",
    ratePurpose: "customer_checkout",
    originWarehouseId: null,
    originWarehouseName: null,
    isActive: true,
    ...overrides,
  };
}

describe("pricing program business-flow labels", () => {
  it("offers only supported runtime pricing flows", () => {
    expect(PRICING_FLOW_CHOICES.map((choice) => choice.value)).toEqual([
      "shopify:customer_checkout",
      "internal:customer_checkout",
      "dropship:vendor_fulfillment_charge",
    ]);
  });

  it("maps persisted channel and purpose values to operator labels", () => {
    const shopify = assignment();
    const dropship = assignment({
      pricingChannel: "dropship",
      ratePurpose: "vendor_fulfillment_charge",
      originWarehouseId: 1,
      originWarehouseName: "LEON",
    });

    expect(pricingFlowKey(shopify)).toBe("shopify:customer_checkout");
    expect(pricingFlowLabel(shopify)).toBe("Shopify checkout");
    expect(assignmentLabel(dropship)).toBe("Dropship vendor fulfillment · LEON");
  });

  it("preserves a readable fallback for an existing custom assignment", () => {
    expect(pricingFlowLabel(assignment({
      pricingChannel: "partner_portal",
      ratePurpose: "customer_checkout",
    }))).toBe("Partner Portal customer checkout");
  });
});

describe("pricing program product-rule status", () => {
  it("keeps live and draft rule counts separate", () => {
    expect(productRuleRevisionStatus({
      active: { productRuleCount: 2 },
      draft: { productRuleCount: 3 },
    })).toEqual({ liveCount: 2, draftCount: 3 });
  });

  it("distinguishes a missing revision from a revision with zero rules", () => {
    expect(productRuleRevisionStatus({
      active: null,
      draft: { productRuleCount: 0 },
    })).toEqual({ liveCount: null, draftCount: 0 });
  });
});

describe("rateTableRegionCount", () => {
  it("prefers the corrected region count and supports the legacy state count", () => {
    expect(rateTableRegionCount({ regionCount: 52, stateCount: 50 })).toBe(52);
    expect(rateTableRegionCount({ stateCount: 52 })).toBe(52);
  });
});

describe("pricing program coverage aggregation", () => {
  it("keeps every warehouse scope while showing one reusable destination group", () => {
    const rateTable: RateTableSummary = {
      id: 301,
      rateBookId: 21,
      serviceLevelId: 8,
      pricingBasis: "shipment_weight",
      currency: "USD",
      status: "active",
      effectiveFrom: "2026-07-01T00:00:00.000Z",
      effectiveTo: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      metadata: null,
      rateBook: null,
      serviceLevel: null,
      coverages: [
        {
          id: 401,
          rateTableId: 301,
          destinationGroupId: 51,
          originWarehouseId: null,
          availability: "offered",
          destinationGroupLockVersion: 3,
          destinationGroupName: "Lower 48",
          name: "Lower 48",
          sortOrder: 0,
          rateRowCount: 4,
          destinations: [
            {
              destinationCountry: "US",
              destinationRegion: "PA",
              postalPrefix: null,
            },
          ],
        },
        {
          id: 402,
          rateTableId: 301,
          destinationGroupId: 51,
          originWarehouseId: 2,
          availability: "offered",
          destinationGroupLockVersion: 3,
          destinationGroupName: "Lower 48",
          name: "Lower 48",
          sortOrder: 0,
          rateRowCount: 5,
          destinations: [
            {
              destinationCountry: "US",
              destinationRegion: "PA",
              postalPrefix: null,
            },
          ],
        },
      ],
      rowCount: 9,
      regionCount: 1,
      stateCount: 1,
      zipOverrideCount: 0,
      productRuleCount: 0,
      minMeasure: 0,
      maxMeasure: 10,
    };
    const response: RateTablesResponse = {
      rateBooks: [{
        id: 21,
        code: "retail",
        name: "Retail shipping",
        status: "active",
        zoneSetId: null,
        metadata: null,
        assignments: [],
      }],
      serviceLevels: [{
        id: 8,
        code: "standard",
        displayName: "Standard shipping",
        description: null,
        fulfillmentMode: "parcel",
        promiseMinBusinessDays: 3,
        promiseMaxBusinessDays: 7,
        sortOrder: 0,
        isActive: true,
      }],
      destinationGroups: [{
        id: 51,
        rateBookId: 21,
        name: "Lower 48",
        status: "active",
        sortOrder: 0,
        lockVersion: 3,
        destinations: [
          {
            destinationCountry: "US",
            destinationRegion: "PA",
            postalPrefix: null,
          },
        ],
      }],
      rateTables: [rateTable],
    };

    expect(
      effectiveRateTableCoverages(rateTable).map((coverage) => ({
        warehouseId: coverage.originWarehouseId,
        rateRows: coverage.rateRowCount,
      })),
    ).toEqual([
      { warehouseId: null, rateRows: 4 },
      { warehouseId: 2, rateRows: 5 },
    ]);
    expect(buildProgramOverviews(response)[0]?.destinationGroups).toHaveLength(1);
  });
});
