import { describe, expect, it } from "vitest";
import {
  describeMeasureRange,
  destinationGroupTemplateById,
  diffRateRows,
  emitDraftRows,
  findDestinationGroupTemplate,
  groupDisplayName,
  groupsFromLayout,
  groupsFromRows,
  layoutFromGroups,
  poundsFromGrams,
  serializeRowsToCsv,
  validateRateGroups,
  ALL_REGION_CODES,
  CONTIGUOUS_US,
  DESTINATION_GROUP_TEMPLATES,
  DESTINATION_REGION_TEMPLATES,
  HIPRAK_REGIONS,
  type DraftRow,
  type RateGroup,
} from "../rate-table-model";

const GRAMS_PER_POUND = 453.59237;

describe("pound formatting", () => {
  it("recovers operator-entered whole-pound boundaries after gram conversion", () => {
    expect(poundsFromGrams(Math.round(50 * GRAMS_PER_POUND))).toBe("50");
    expect(describeMeasureRange(
      "shipment_weight",
      Math.round(GRAMS_PER_POUND) + 1,
      Math.round(5 * GRAMS_PER_POUND),
    )).toBe("1–5 lb");
  });

  it("preserves common ounce increments", () => {
    expect(poundsFromGrams(Math.round(0.125 * GRAMS_PER_POUND))).toBe("0.125");
  });
});

describe("destination group templates", () => {
  it("partitions every supported US state and territory exactly once", () => {
    const assigned = DESTINATION_REGION_TEMPLATES.flatMap((template) => template.regions);

    expect(new Set(assigned).size).toBe(assigned.length);
    expect([...assigned].sort()).toEqual([...ALL_REGION_CODES].sort());
  });

  it("uses stable unique IDs and finds templates independent of state order", () => {
    const ids = DESTINATION_GROUP_TEMPLATES.map((template) => template.id);
    const mountainWest = destinationGroupTemplateById("mountain-west");

    expect(new Set(ids).size).toBe(ids.length);
    expect(mountainWest).not.toBeNull();
    expect(findDestinationGroupTemplate([...mountainWest!.regions].reverse())?.id)
      .toBe("mountain-west");
    expect(findDestinationGroupTemplate(["PA", "CA"])).toBeNull();
    expect(destinationGroupTemplateById("unknown")).toBeNull();
  });

  it("provides the exact destination set supported by the HIPRAK zone rules", () => {
    const hiprak = destinationGroupTemplateById("hiprak");

    expect(hiprak).not.toBeNull();
    expect(hiprak?.name).toBe("HIPRAK (AK, HI, PR, VI)");
    expect(hiprak?.regions).toEqual(HIPRAK_REGIONS);
    expect(hiprak?.regions).not.toContain("AS");
    expect(hiprak?.regions).not.toContain("GU");
    expect(hiprak?.regions).not.toContain("MP");
    expect(findDestinationGroupTemplate(["VI", "PR", "HI", "AK"])?.id).toBe("hiprak");
  });
});

function group(overrides: Partial<RateGroup> = {}): RateGroup {
  return {
    id: "group-1",
    name: "",
    originWarehouseId: null,
    regions: ["PA"],
    zipEntries: [],
    bands: [
      {
        id: "band-1",
        maxMeasure: "1",
        rateUsd: "8.99",
        maxShipmentWeightLb: "",
      },
    ],
    ...overrides,
  };
}

function draftRow(overrides: Partial<DraftRow> = {}): DraftRow {
  return {
    originWarehouseId: null,
    destinationCountry: "US",
    destinationRegion: "PA",
    postalPrefix: null,
    minMeasure: 0,
    maxMeasure: 454,
    maxShipmentWeightGrams: null,
    rateCents: 899,
    ...overrides,
  };
}

describe("validateRateGroups", () => {
  it("expands shared parcel bands across selected states", () => {
    const result = validateRateGroups([
      group({
        regions: ["PA", "OH"],
        bands: [
          { id: "band-1", maxMeasure: "1", rateUsd: "8.99", maxShipmentWeightLb: "" },
          { id: "band-2", maxMeasure: "5", rateUsd: "12.99", maxShipmentWeightLb: "" },
        ],
      }),
    ], "shipment_weight");

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toMatchObject({
      destinationRegion: "PA",
      minMeasure: 0,
      maxMeasure: Math.round(GRAMS_PER_POUND),
      rateCents: 899,
    });
    expect(result.rows[1]).toMatchObject({
      minMeasure: Math.round(GRAMS_PER_POUND) + 1,
      maxMeasure: Math.round(5 * GRAMS_PER_POUND),
      rateCents: 1299,
    });
  });

  it("supports different state schedules inside one shipping option", () => {
    const result = validateRateGroups([
      group({
        id: "pa-rates",
        name: "Pennsylvania",
        regions: ["PA"],
        bands: [
          { id: "pa-1lb", maxMeasure: "1", rateUsd: "5.99", maxShipmentWeightLb: "" },
        ],
      }),
      group({
        id: "ca-rates",
        name: "California",
        regions: ["CA"],
        bands: [
          { id: "ca-1lb", maxMeasure: "1", rateUsd: "8.99", maxShipmentWeightLb: "" },
        ],
      }),
    ], "shipment_weight");

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      expect.objectContaining({ destinationRegion: "PA", rateCents: 599 }),
      expect.objectContaining({ destinationRegion: "CA", rateCents: 899 }),
    ]);
  });

  it("builds contiguous pallet bands with an optional total-weight ceiling", () => {
    const result = validateRateGroups([
      group({
        bands: [
          { id: "band-1", maxMeasure: "1", rateUsd: "189", maxShipmentWeightLb: "2500" },
          { id: "band-2", maxMeasure: "3", rateUsd: "299", maxShipmentWeightLb: "" },
        ],
      }),
    ], "pallet_count");

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      expect.objectContaining({
        minMeasure: 1,
        maxMeasure: 1,
        maxShipmentWeightGrams: Math.round(2500 * GRAMS_PER_POUND),
        rateCents: 18900,
      }),
      expect.objectContaining({
        minMeasure: 2,
        maxMeasure: 3,
        maxShipmentWeightGrams: null,
        rateCents: 29900,
      }),
    ]);
  });

  it("keeps global and warehouse-specific schedules in separate scopes", () => {
    const result = validateRateGroups([
      group(),
      group({ id: "group-2", originWarehouseId: 1 }),
    ], "shipment_weight");

    expect(result.errors).toEqual([]);
    expect(result.rows.map((row) => row.originWarehouseId)).toEqual([null, 1]);
  });

  it("rejects fractional pallet bands and ZIP overrides without a statewide fallback", () => {
    const result = validateRateGroups([
      group({
        regions: [],
        zipEntries: [{ id: "zip-1", state: "PA", prefixes: ["160"] }],
        bands: [{ id: "band-1", maxMeasure: "1.5", rateUsd: "189", maxShipmentWeightLb: "" }],
      }),
    ], "pallet_count");

    expect(result.rows).toEqual([]);
    expect(result.errors.some((error) => error.includes("pallet limits must be whole numbers"))).toBe(true);
    expect(result.errors.some((error) => error.includes("PA ZIP overrides require a statewide fallback"))).toBe(true);
  });

  it("attributes issues to the owning group for remediation links", () => {
    const result = validateRateGroups([
      group({ id: "alpha", regions: ["PA"] }),
      group({ id: "beta", regions: ["PA"] }),
    ], "shipment_weight");

    expect(result.rows).toEqual([]);
    expect(result.issues.some((issue) => issue.groupId === "beta")).toBe(true);
  });
});

describe("emitDraftRows (incomplete-draft persistence)", () => {
  it("emits complete bands and skips bands missing a charge", () => {
    const rows = emitDraftRows([
      group({
        bands: [
          { id: "band-1", maxMeasure: "1", rateUsd: "8.99", maxShipmentWeightLb: "" },
          { id: "band-2", maxMeasure: "5", rateUsd: "", maxShipmentWeightLb: "" },
          { id: "band-3", maxMeasure: "20", rateUsd: "15.99", maxShipmentWeightLb: "" },
        ],
      }),
    ], "shipment_weight");

    // Band 2 has no charge but still anchors band 3's lower bound.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      minMeasure: Math.round(5 * GRAMS_PER_POUND) + 1,
      maxMeasure: Math.round(20 * GRAMS_PER_POUND),
      rateCents: 1599,
    });
  });

  it("stops emitting after a band with an unusable upper limit", () => {
    const rows = emitDraftRows([
      group({
        bands: [
          { id: "band-1", maxMeasure: "1", rateUsd: "8.99", maxShipmentWeightLb: "" },
          { id: "band-2", maxMeasure: "oops", rateUsd: "12.99", maxShipmentWeightLb: "" },
          { id: "band-3", maxMeasure: "20", rateUsd: "15.99", maxShipmentWeightLb: "" },
        ],
      }),
    ], "shipment_weight");

    expect(rows).toHaveLength(1);
    expect(rows[0].rateCents).toBe(899);
  });

  it("emits nothing for a group with no destinations", () => {
    const rows = emitDraftRows([group({ regions: [], zipEntries: [] })], "shipment_weight");
    expect(rows).toEqual([]);
  });
});

describe("draft layout round-trip", () => {
  it("restores names, destinations, and raw band text exactly", () => {
    const original = [
      group({
        name: "Contiguous US",
        regions: [...CONTIGUOUS_US],
        zipEntries: [{ id: "zip-1", state: "PA", prefixes: ["160", "161"] }],
        bands: [
          { id: "band-1", maxMeasure: "1", rateUsd: "8.99", maxShipmentWeightLb: "" },
          { id: "band-2", maxMeasure: "", rateUsd: "", maxShipmentWeightLb: "" },
        ],
      }),
    ];
    const restored = groupsFromLayout({ draftLayout: layoutFromGroups(original) });

    expect(restored).not.toBeNull();
    expect(restored).toHaveLength(1);
    expect(restored![0].name).toBe("Contiguous US");
    expect(restored![0].regions).toEqual([...CONTIGUOUS_US]);
    expect(restored![0].zipEntries[0]).toMatchObject({ state: "PA", prefixes: ["160", "161"] });
    // The unfinished band survives save/reopen with its raw text intact.
    expect(restored![0].bands[1]).toMatchObject({ maxMeasure: "", rateUsd: "" });
  });

  it("returns null for metadata without a layout", () => {
    expect(groupsFromLayout({ source: "admin-import" })).toBeNull();
    expect(groupsFromLayout(null)).toBeNull();
  });
});

describe("groupsFromRows", () => {
  it("rebuilds visual groups from an existing draft without duplicating schedules", () => {
    const groups = groupsFromRows([
      draftRow({ destinationRegion: "PA", minMeasure: 1, maxMeasure: 1, rateCents: 18900 }),
      draftRow({ destinationRegion: "OH", minMeasure: 1, maxMeasure: 1, rateCents: 18900 }),
    ], "pallet_count");

    expect(groups).toHaveLength(1);
    expect(groups[0].originWarehouseId).toBeNull();
    expect(groups[0].regions.sort()).toEqual(["OH", "PA"]);
    expect(groups[0].bands).toEqual([
      expect.objectContaining({ maxMeasure: "1", rateUsd: "189.00" }),
    ]);
  });
});

describe("groupDisplayName", () => {
  it("labels well-known destination sets", () => {
    expect(groupDisplayName(group({ regions: [...CONTIGUOUS_US] }), 0)).toBe("Contiguous US");
    expect(groupDisplayName(group({ regions: ["AK", "HI"] }), 0)).toBe("Alaska and Hawaii");
    expect(groupDisplayName(group({ regions: ["PA"] }), 0)).toBe("Pennsylvania");
    expect(groupDisplayName(group({ name: "Local PA rates" }), 0)).toBe("Local PA rates");
  });
});

describe("serializeRowsToCsv", () => {
  it("writes parcel rows in business units", () => {
    const csv = serializeRowsToCsv([
      draftRow({
        minMeasure: 0,
        maxMeasure: Math.round(GRAMS_PER_POUND),
        rateCents: 899,
      }),
      draftRow({
        postalPrefix: "160",
        minMeasure: 0,
        maxMeasure: Math.round(GRAMS_PER_POUND),
        rateCents: 799,
      }),
    ], "shipment_weight");

    const lines = csv.split("\n");
    expect(lines[0]).toBe("state,zip_prefix,min_lb,max_lb,rate_usd");
    expect(lines).toContain("PA,,0,1,8.99");
    expect(lines).toContain("PA,160,0,1,7.99");
  });

  it("adds an origin_warehouse column only when scoped rows exist", () => {
    const csv = serializeRowsToCsv([
      draftRow({ originWarehouseId: 7, minMeasure: 1, maxMeasure: 2, rateCents: 18900, maxShipmentWeightGrams: null }),
    ], "pallet_count", new Map([[7, "LEON"]]));

    const lines = csv.split("\n");
    expect(lines[0]).toBe("state,zip_prefix,min_pallets,max_pallets,max_total_lb,rate_usd,origin_warehouse");
    expect(lines[1]).toBe("PA,,1,2,,189.00,LEON");
  });
});

describe("diffRateRows", () => {
  it("reports price changes, new bands, and coverage deltas", () => {
    const active = [
      draftRow({ rateCents: 899 }),
      draftRow({ destinationRegion: "OH", rateCents: 999 }),
    ];
    const next = [
      draftRow({ rateCents: 949 }),
      draftRow({ destinationRegion: "NY", rateCents: 899 }),
    ];
    const diff = diffRateRows(next, active, "shipment_weight");

    expect(diff.identical).toBe(false);
    expect(diff.changedCount).toBe(1);
    expect(diff.changedRates[0]).toMatchObject({ fromCents: 899, toCents: 949 });
    expect(diff.addedScopes).toEqual(["NY statewide"]);
    expect(diff.removedScopes).toEqual(["OH statewide"]);
  });

  it("recognizes identical revisions", () => {
    const rows = [draftRow()];
    expect(diffRateRows(rows, [draftRow()], "shipment_weight").identical).toBe(true);
  });
});
