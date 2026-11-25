import { describe, expect, it } from "vitest";
import { buildWalkPathKey, compareWalkPath, sortByWalkPath } from "../walk-path";

describe("warehouse walk-path sorting (Zone -> Aisle -> Bay -> Level -> Bin)", () => {
  it("sorts structured location hierarchy naturally without zig-zagging across numeric bays or bins", () => {
    const locations = [
      { id: 4, sku: "SKU-4", code: "FWD-A-10-A-01", zone: "FWD", aisle: "A", bay: "10", level: "A", bin: "1" },
      { id: 2, sku: "SKU-2", code: "FWD-A-02-B-01", zone: "FWD", aisle: "A", bay: "02", level: "B", bin: "01" },
      { id: 1, sku: "SKU-1", code: "FWD-A-02-A-02", zone: "FWD", aisle: "A", bay: "2", level: "A", bin: "2" },
      { id: 5, sku: "SKU-5", code: "BULK-C-01-A-01", zone: "BULK", aisle: "C", bay: "01", level: "A", bin: "01" },
      { id: 3, sku: "SKU-3", code: "FWD-A-02-A-10", zone: "FWD", aisle: "A", bay: "02", level: "A", bin: "10" },
    ];

    const sorted = sortByWalkPath(locations, (item) => item);
    expect(sorted.map((item) => item.code)).toEqual([
      "BULK-C-01-A-01",
      "FWD-A-02-A-02",
      "FWD-A-02-A-10",
      "FWD-A-02-B-01",
      "FWD-A-10-A-01",
    ]);
  });

  it("parses structured location codes into Zone -> Aisle -> Bay -> Level -> Bin when explicit columns are absent", () => {
    const items = [
      { id: 10, sku: "SKU-UNASSIGNED", code: "UNASSIGNED" },
      { id: 11, sku: "SKU-B1", code: "FWD-B-01-A-01" },
      { id: 12, sku: "SKU-A10", code: "FWD-A-10-A-01" },
      { id: 13, sku: "SKU-A2", code: "FWD-A-02-A-01" },
      { id: 14, sku: "SKU-CONFIRM", code: "", isUnassigned: true },
    ];

    const sorted = sortByWalkPath(items, (item) => item);
    expect(sorted.map((item) => item.sku)).toEqual([
      "SKU-A2",
      "SKU-A10",
      "SKU-B1",
      "SKU-CONFIRM",
      "SKU-UNASSIGNED",
    ]);
  });

  it("treats zero-padded and unpadded numeric segments identically and breaks ties deterministically", () => {
    const keyPadded = buildWalkPathKey({ code: "A-01-B-02" });
    const keyUnpadded = buildWalkPathKey({ code: "A-1-B-2" });
    expect(keyPadded.bay).toBe(keyUnpadded.bay);
    expect(keyPadded.bin).toBe(keyUnpadded.bin);

    const sameBinItems = [
      { id: 99, sku: "Z-SKU", code: "A-01-A-01" },
      { id: 42, sku: "A-SKU", code: "A-01-A-01" },
      { id: 12, sku: "A-SKU", code: "A-01-A-01" },
    ];
    expect(sortByWalkPath(sameBinItems, (x) => x).map((x) => x.id)).toEqual([12, 42, 99]);
    expect(compareWalkPath({ code: "UNASSIGNED" }, { code: "Z-99-Z-99" })).toBeGreaterThan(0);
  });
});
