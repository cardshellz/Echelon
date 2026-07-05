import { describe, expect, it } from "vitest";
import {
  CENTS_PER_USD,
  GRAMS_PER_POUND,
  findBandOverlaps,
  findUnknownZones,
  parseRateTableCsv,
  type RateTableImportRow,
} from "../../domain/rate-table-import";

function row(overrides: Partial<RateTableImportRow> = {}): RateTableImportRow {
  return {
    originWarehouseId: null,
    destinationZone: "US-48",
    minWeightGrams: 0,
    maxWeightGrams: 1000,
    rateCents: 899,
    ...overrides,
  };
}

describe("parseRateTableCsv", () => {
  describe("pounds/USD dialect", () => {
    it("parses rows and converts lb→grams and usd→cents with rounding", () => {
      const result = parseRateTableCsv(
        "zone,min_lb,max_lb,rate_usd\nUS-48,0,1,8.99\nUS-48,1.001,5,12.50\n",
      );
      expect(result.dialect).toBe("pounds");
      expect(result.errors).toEqual([]);
      expect(result.rows).toEqual([
        {
          originWarehouseId: null,
          destinationZone: "US-48",
          minWeightGrams: 0,
          maxWeightGrams: 454, // 453.59237 rounds to 454
          rateCents: 899,
        },
        {
          originWarehouseId: null,
          destinationZone: "US-48",
          minWeightGrams: 454, // 1.001 lb = 454.045... rounds to 454
          maxWeightGrams: 2268, // 2267.96... rounds to 2268
          rateCents: 1250,
        },
      ]);
    });

    it("rounds half-pound weights to the nearest gram", () => {
      const result = parseRateTableCsv("zone,min_lb,max_lb,rate_usd\nUS-48,0,0.5,4.15\n");
      expect(result.rows[0].maxWeightGrams).toBe(Math.round(0.5 * GRAMS_PER_POUND)); // 227
      expect(result.rows[0].maxWeightGrams).toBe(227);
      expect(result.rows[0].rateCents).toBe(Math.round(4.15 * CENTS_PER_USD)); // 415
    });

    it("accepts a case-insensitive header with surrounding whitespace", () => {
      const result = parseRateTableCsv("ZONE, Min_LB , MAX_lb , Rate_USD\nUS-48, 0, 1, 8.99\n");
      expect(result.dialect).toBe("pounds");
      expect(result.errors).toEqual([]);
      expect(result.rows).toHaveLength(1);
    });
  });

  describe("grams/cents dialect", () => {
    it("parses storage-unit rows without conversion", () => {
      const result = parseRateTableCsv("zone,min_g,max_g,rate_cents\nUS-HIPRAK,0,1000,1599\n");
      expect(result.dialect).toBe("grams");
      expect(result.errors).toEqual([]);
      expect(result.rows).toEqual([
        {
          originWarehouseId: null,
          destinationZone: "US-HIPRAK",
          minWeightGrams: 0,
          maxWeightGrams: 1000,
          rateCents: 1599,
        },
      ]);
    });

    it("rejects fractional values in the grams dialect", () => {
      const result = parseRateTableCsv("zone,min_g,max_g,rate_cents\nUS-48,0,1000.5,899\n");
      expect(result.rows).toEqual([]);
      expect(result.errors).toEqual([
        { line: 2, message: "min_g, max_g and rate_cents must be whole numbers" },
      ]);
    });
  });

  describe("warehouse_id column", () => {
    it("parses a warehouse-scoped row and treats blank as table-wide", () => {
      const result = parseRateTableCsv(
        "zone,min_g,max_g,rate_cents,warehouse_id\nUS-48,0,1000,899,3\nUS-48,1001,2000,999,\n",
      );
      expect(result.errors).toEqual([]);
      expect(result.rows[0].originWarehouseId).toBe(3);
      expect(result.rows[1].originWarehouseId).toBeNull();
    });

    it("reports a non-integer warehouse_id with its line number", () => {
      const result = parseRateTableCsv(
        "zone,min_g,max_g,rate_cents,warehouse_id\nUS-48,0,1000,899,abc\n",
      );
      expect(result.rows).toEqual([]);
      expect(result.errors).toEqual([{ line: 2, message: 'invalid warehouse_id "abc"' }]);
    });
  });

  describe("row-level errors", () => {
    it("reports bad rows with physical line numbers and keeps good rows", () => {
      const result = parseRateTableCsv(
        [
          "zone,min_lb,max_lb,rate_usd",
          "US-48,0,1,8.99", // line 2 — good
          ",0,1,8.99", // line 3 — missing zone
          "US-48,x,1,8.99", // line 4 — bad min
          "US-48,2,1,8.99", // line 5 — max < min
          "US-48,1,2,-1", // line 6 — negative rate
          "US-48,5,10,19.99", // line 7 — good
        ].join("\n"),
      );
      expect(result.rows).toHaveLength(2);
      expect(result.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
      expect(result.errors[0].message).toBe("zone is required");
      expect(result.errors[1].message).toContain("invalid min weight");
      expect(result.errors[2].message).toBe("max weight must be >= min weight");
      expect(result.errors[3].message).toBe("rate must be zero or greater");
    });

    it("counts blank lines when numbering errors", () => {
      const result = parseRateTableCsv("zone,min_g,max_g,rate_cents\n\nUS-48,0,bad,899\n");
      expect(result.errors).toEqual([{ line: 3, message: 'invalid max weight "bad"' }]);
    });

    it("rejects an unrecognized header", () => {
      const result = parseRateTableCsv("zone,weight,price\nUS-48,1,8.99\n");
      expect(result.dialect).toBeNull();
      expect(result.rows).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].line).toBe(1);
      expect(result.errors[0].message).toContain("unrecognized header");
    });

    it("rejects an empty CSV", () => {
      const result = parseRateTableCsv("\n\n");
      expect(result.errors).toEqual([
        { line: 1, message: "CSV is empty — a header row is required" },
      ]);
    });

    it("enforces the row cap", () => {
      const csv =
        "zone,min_g,max_g,rate_cents\n" +
        "US-48,0,10,100\nUS-48,11,20,200\nUS-48,21,30,300\n";
      const result = parseRateTableCsv(csv, { maxRows: 2 });
      expect(result.rows).toEqual([]);
      expect(result.errors).toEqual([
        { line: 4, message: "too many rows — the import limit is 2" },
      ]);
    });
  });
});

describe("findBandOverlaps", () => {
  it("accepts adjacent bands in the same zone", () => {
    const rows = [
      row({ minWeightGrams: 0, maxWeightGrams: 1000 }),
      row({ minWeightGrams: 1001, maxWeightGrams: 2000 }),
    ];
    expect(findBandOverlaps(rows)).toEqual([]);
  });

  it("detects an inclusive boundary overlap in the same zone", () => {
    const rows = [
      row({ minWeightGrams: 0, maxWeightGrams: 1000 }),
      row({ minWeightGrams: 1000, maxWeightGrams: 2000 }),
    ];
    const errors = findBandOverlaps(rows);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("zone US-48");
    expect(errors[0]).toContain("[0, 1000]g (row 1)");
    expect(errors[0]).toContain("[1000, 2000]g (row 2)");
  });

  it("detects exact duplicate bands", () => {
    const rows = [row(), row()];
    expect(findBandOverlaps(rows)).toHaveLength(1);
  });

  it("detects a band fully contained in another", () => {
    const rows = [
      row({ minWeightGrams: 0, maxWeightGrams: 5000 }),
      row({ minWeightGrams: 100, maxWeightGrams: 200 }),
    ];
    expect(findBandOverlaps(rows)).toHaveLength(1);
  });

  it("allows identical bands across different zones", () => {
    const rows = [row({ destinationZone: "US-48" }), row({ destinationZone: "US-HIPRAK" })];
    expect(findBandOverlaps(rows)).toEqual([]);
  });

  it("allows identical bands across different warehouse scopes", () => {
    const rows = [
      row({ originWarehouseId: 1 }),
      row({ originWarehouseId: 2 }),
      row({ originWarehouseId: null }),
    ];
    expect(findBandOverlaps(rows)).toEqual([]);
  });

  it("labels warehouse-scoped overlaps with the warehouse id", () => {
    const rows = [row({ originWarehouseId: 7 }), row({ originWarehouseId: 7 })];
    const errors = findBandOverlaps(rows);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("(warehouse 7)");
  });
});

describe("findUnknownZones", () => {
  it("returns no warnings when every zone is known", () => {
    const rows = [row({ destinationZone: "US-48" }), row({ destinationZone: "US-HIPRAK" })];
    expect(findUnknownZones(rows, ["US-48", "US-HIPRAK"])).toEqual([]);
  });

  it("warns once per distinct unknown zone", () => {
    const rows = [
      row({ destinationZone: "US-48" }),
      row({ destinationZone: "MOON" }),
      row({ destinationZone: "MOON", minWeightGrams: 1001, maxWeightGrams: 2000 }),
    ];
    const warnings = findUnknownZones(rows, ["US-48"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"MOON"');
    expect(warnings[0]).toContain("no matching zone rule");
  });

  it("compares zones case-insensitively", () => {
    const rows = [row({ destinationZone: "us-48" })];
    expect(findUnknownZones(rows, ["US-48"])).toEqual([]);
  });

  it("warns for every zone when no zone rules exist", () => {
    const rows = [row({ destinationZone: "US-48" })];
    expect(findUnknownZones(rows, [])).toHaveLength(1);
  });
});
