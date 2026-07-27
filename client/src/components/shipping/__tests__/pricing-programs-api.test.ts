import { describe, expect, it } from "vitest";
import {
  PRICING_FLOW_CHOICES,
  assignmentLabel,
  buildProgramOverviews,
  countStaleRateTableCoverages,
  effectiveRateTableCoverages,
  findEditorRateGroup,
  pricingFlowKey,
  pricingFlowLabel,
  productRuleRevisionStatus,
  rateTableCoveragesForGroup,
  rateTableRegionCount,
  type ProgramDestinationGroup,
  type RateBookAssignment,
  type RateTableCoverage,
  type RateTableSummary,
  type RateTablesResponse,
} from "../pricing-programs/api";
import type { RateGroup } from "../rate-table-model";

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

function destination(destinationRegion: string) {
  return {
    destinationCountry: "US",
    destinationRegion,
    postalPrefix: null,
  };
}

function coverage(input: {
  id: number;
  rateTableId: number;
  destinationGroupId: number;
  destinationGroupName: string;
  sortOrder: number;
  regions: string[];
}): RateTableCoverage {
  return {
    id: input.id,
    rateTableId: input.rateTableId,
    destinationGroupId: input.destinationGroupId,
    originWarehouseId: null,
    availability: "offered",
    destinationGroupLockVersion: 1,
    destinationGroupName: input.destinationGroupName,
    name: input.destinationGroupName,
    sortOrder: input.sortOrder,
    rateRowCount: input.regions.length,
    destinations: input.regions.map(destination),
  };
}

function legacyLayoutGroup(name: string, regions: string[]) {
  return {
    name,
    originWarehouseId: null,
    regions,
    zipEntries: [],
    availability: "offered",
    pricingModel: "weight_bands",
    baseChargeUsd: "",
    perStartedPoundUsd: "",
    bands: [{
      maxMeasure: "1",
      rateUsd: "8.99",
      maxShipmentWeightLb: "",
      openEnded: false,
    }],
  };
}

function rateTable(overrides: Partial<RateTableSummary> = {}): RateTableSummary {
  return {
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
    coverages: [],
    rowCount: 0,
    regionCount: 0,
    stateCount: 0,
    zipOverrideCount: 0,
    productRuleCount: 0,
    minMeasure: null,
    maxMeasure: null,
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

describe("destination-group editor selection", () => {
  const group = (
    id: string,
    destinationGroupId: number | null,
    name: string,
    regions: string[],
    originWarehouseId: number | null = null,
  ): RateGroup => ({
    id,
    destinationGroupId,
    destinationGroupLockVersion: 1,
    name,
    originWarehouseId,
    regions,
    zipEntries: [],
    availability: "offered",
    pricingModel: "weight_bands",
    baseChargeUsd: "",
    perStartedPoundUsd: "",
    bands: [],
  });

  it("selects the clicked persisted group instead of the first editor group", () => {
    const military = group("military", 11, "Military mail", ["AA", "AE", "AP"]);
    const hiprak = group("hiprak", 12, "Alaska and Hawaii", ["AK", "HI"]);

    expect(findEditorRateGroup(
      [military, hiprak],
      { id: 12, key: "id:12" },
    )).toBe(hiprak);
  });

  it("prefers the all-warehouse scope when a group has overrides", () => {
    const warehouseOverride = group(
      "warehouse-override",
      12,
      "Alaska and Hawaii",
      ["AK", "HI"],
      2,
    );
    const defaultScope = group(
      "default",
      12,
      "Alaska and Hawaii",
      ["AK", "HI"],
    );

    expect(findEditorRateGroup(
      [warehouseOverride, defaultScope],
      { id: 12, key: "id:12" },
    )).toBe(defaultScope);
  });

  it("uses the stable derived key for a legacy group without a persisted ID", () => {
    const military = group("military", null, "Military mail", ["AA", "AE", "AP"]);
    const hiprak = group("hiprak", null, "Alaska and Hawaii", ["AK", "HI"]);

    expect(findEditorRateGroup(
      [military, hiprak],
      { id: null, key: "derived:alaska and hawaii|US|AK|,US|HI|" },
    )).toBe(hiprak);
  });

  it("returns null when the clicked group is absent from the draft", () => {
    const military = group("military", 11, "Military mail", ["AA", "AE", "AP"]);

    expect(findEditorRateGroup(
      [military],
      { id: 12, key: "id:12" },
    )).toBeNull();
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

  it("reconciles legacy live groups with current definitions without hiding live-only coverage", () => {
    const southeastRegions = ["AL", "FL", "GA", "KY", "MS", "NC", "SC", "TN"];
    const midwestRegions = [
      "IL", "IN", "IA", "KS", "MI", "MN", "MO", "NE", "ND", "OH", "SD", "WI",
    ];
    const currentDefinitions = [
      {
        id: 51,
        name: "Military mail (APO/FPO/DPO)",
        regions: ["AA", "AE", "AP"],
      },
      {
        id: 52,
        name: "AL, FL, GA + 17 more",
        regions: [...southeastRegions, ...midwestRegions],
      },
      { id: 53, name: "South Central", regions: ["AR", "LA", "OK", "TX"] },
      {
        id: 54,
        name: "Mountain West",
        regions: ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY"],
      },
      { id: 55, name: "West Coast", regions: ["CA", "OR", "WA"] },
      {
        id: 56,
        name: "Northeast",
        regions: ["CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY", "PA"],
      },
      {
        id: 57,
        name: "Mid-Atlantic",
        regions: ["DE", "DC", "MD", "VA", "WV"],
      },
      {
        id: 58,
        name: "Alaska and Hawaii",
        regions: ["AK", "AS", "GU", "HI", "MP", "PR", "VI"],
      },
    ];
    const legacyLiveDefinitions = [
      // PA is intentionally absent so the compatibility row also proves drift detection.
      { name: "Northeast", regions: ["CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY"] },
      { name: "Mid-Atlantic", regions: ["DE", "DC", "MD", "VA", "WV"] },
      { name: "Southeast", regions: southeastRegions },
      { name: "South Central", regions: ["AR", "LA", "OK", "TX"] },
      { name: "Midwest", regions: midwestRegions },
      { name: "Mountain West", regions: ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY"] },
      { name: "West Coast", regions: ["CA", "OR", "WA"] },
      { name: "Military mail (APO/FPO/DPO)", regions: ["AA", "AE", "AP"] },
      { name: "Alaska and Hawaii", regions: ["AK", "AS", "GU", "HI", "MP", "PR", "VI"] },
    ];
    const active = rateTable({
      id: 301,
      status: "active",
      metadata: {
        draftLayout: {
          version: 1,
          groups: legacyLiveDefinitions.map((group) =>
            legacyLayoutGroup(group.name, group.regions)),
        },
      },
      rowCount: 58,
      regionCount: 58,
      stateCount: 58,
    });
    const draft = rateTable({
      id: 302,
      status: "draft",
      createdAt: "2026-07-02T00:00:00.000Z",
      coverages: currentDefinitions.map((group, index) =>
        coverage({
          id: 501 + index,
          rateTableId: 302,
          destinationGroupId: group.id,
          destinationGroupName: group.name,
          sortOrder: index,
          regions: group.regions,
        })),
    });
    const historical = rateTable({
      id: 303,
      status: "superseded",
      createdAt: "2026-06-01T00:00:00.000Z",
      metadata: {
        draftLayout: {
          version: 1,
          groups: [legacyLayoutGroup("Historical only", ["OH"])],
        },
      },
    });
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
      destinationGroups: currentDefinitions.map((group, index) => ({
          id: group.id,
          rateBookId: 21,
          name: group.name,
          status: "active" as const,
          sortOrder: index,
          lockVersion: 1,
          destinations: group.regions.map(destination),
        })),
      rateTables: [active, draft, historical],
    };

    const program = buildProgramOverviews(response)[0];
    expect(program).toBeDefined();
    expect(program!.destinationGroups).toHaveLength(10);
    for (const sharedName of [
      "Military mail (APO/FPO/DPO)",
      "South Central",
      "Mountain West",
      "West Coast",
      "Northeast",
      "Mid-Atlantic",
      "Alaska and Hawaii",
    ]) {
      expect(
        program!.destinationGroups.filter((group) => group.name === sharedName),
      ).toHaveLength(1);
    }
    expect(
      program!.destinationGroups.some((group) => group.name === "Historical only"),
    ).toBe(false);

    const northeast = program!.destinationGroups.find(
      (group) => group.name === "Northeast",
    ) as ProgramDestinationGroup;
    expect(northeast).toMatchObject({
      id: 56,
      hasCurrentDefinition: true,
      appearsInLiveRevision: true,
      appearsInDraftRevision: true,
    });
    const northeastLiveCoverages = rateTableCoveragesForGroup(active, northeast);
    expect(northeastLiveCoverages).toHaveLength(1);
    expect(countStaleRateTableCoverages(
      northeastLiveCoverages,
      northeast,
    )).toBe(1);

    const southeast = program!.destinationGroups.find(
      (group) => group.name === "Southeast",
    );
    expect(southeast).toMatchObject({
      id: null,
      hasCurrentDefinition: false,
      appearsInLiveRevision: true,
      appearsInDraftRevision: false,
    });
    expect(
      program!.destinationGroups
        .filter((group) => !group.hasCurrentDefinition)
        .map((group) => group.name)
        .sort(),
    ).toEqual(["Midwest", "Southeast"]);
  });
});
