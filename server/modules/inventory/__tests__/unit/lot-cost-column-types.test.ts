/**
 * Type contract for the money columns on inventory.inventory_lots.
 *
 * 2026-09-04 incident: packaging_cost_cents was the table's only NUMERIC(10,4)
 * cost column (migration 098 landed one day after migration 0576 aligned the
 * rest to bigint). Postgres pads a numeric to its declared scale on the wire,
 * so the column read back as "0.0000" where every sibling read back as "0".
 * The FIFO lot cost normalizer parses these values with BigInt(), which rejects
 * any string carrying a decimal point, so inventory transfers, replenishment
 * moves, case breaks and cycle-count moves all failed with
 * "packaging_cost_cents is not an integer mill value" on a value that was zero.
 *
 * Invariants protected here:
 *   1. Every lot money column is declared bigint. A numeric declaration
 *      reintroduces the padded wire format the normalizer cannot parse.
 *   2. The normalizer's contract is integer-shaped input only. It must accept
 *      what a bigint column returns (number or unpadded string) and still
 *      reject genuinely malformed values, so a future type drift fails loudly
 *      rather than silently rounding money.
 */
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { inventoryLots } from "@shared/schema";
import { normalizeBuildLotCosts } from "../../infrastructure/build.repository";

/** Whole-cent display mirrors. Sub-cent precision lives in the *_mills columns. */
const CENT_COLUMNS = [
  "unitCostCents",
  "poUnitCostCents",
  "packagingCostCents",
  "landedCostCents",
  "totalUnitCostCents",
] as const;

/** Authoritative per-unit cost, 1/100 of a cent. */
const MILL_COLUMNS = [
  "unitCostMills",
  "poUnitCostMills",
  "packagingCostMills",
  "landedCostMills",
  "totalUnitCostMills",
] as const;

function sqlTypeOf(columnName: string): string {
  const columns = getTableColumns(inventoryLots) as Record<string, { getSQLType(): string }>;
  const column = columns[columnName];
  if (!column) throw new Error(`inventory_lots has no column named ${columnName}`);
  return column.getSQLType();
}

describe("inventory_lots money column declarations", () => {
  it.each([...CENT_COLUMNS, ...MILL_COLUMNS])("declares %s as bigint", (columnName) => {
    expect(sqlTypeOf(columnName)).toBe("bigint");
  });

  it("declares no lot money column as numeric", () => {
    const numericMoneyColumns = [...CENT_COLUMNS, ...MILL_COLUMNS]
      .filter((columnName) => sqlTypeOf(columnName).startsWith("numeric"));
    expect(numericMoneyColumns).toEqual([]);
  });
});

/**
 * `lot()` mirrors the snake_case shape the normalizer is called with, using the
 * value shapes a bigint column actually produces: Drizzle `mode: "number"`
 * yields a JS number, and a raw pg read of the same column yields an unpadded
 * string.
 */
function lot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    unit_cost_cents: 0,
    po_unit_cost_cents: 0,
    packaging_cost_cents: 0,
    landed_cost_cents: 0,
    total_unit_cost_cents: 0,
    unit_cost_mills: 0,
    po_unit_cost_mills: 0,
    packaging_cost_mills: 0,
    landed_cost_mills: 0,
    total_unit_cost_mills: 0,
    ...overrides,
  };
}

describe("lot cost normalization against real column wire formats", () => {
  it("accepts the zero-valued lot that broke every transfer", () => {
    // 2211 of 2227 production lots carry zero packaging cost in both columns.
    // Under NUMERIC(10,4) this arrived as "0.0000" and threw; under bigint it
    // arrives as "0" or 0 and must normalize cleanly.
    expect(() => normalizeBuildLotCosts(lot({ packaging_cost_cents: "0" }))).not.toThrow();
    expect(() => normalizeBuildLotCosts(lot({ packaging_cost_cents: 0 }))).not.toThrow();
  });

  it.each([
    ["raw pg string", "125"],
    ["drizzle number", 125],
  ])("reads a non-zero packaging cost from a bigint column as %s", (_label, value) => {
    const result = normalizeBuildLotCosts(lot({
      total_unit_cost_cents: 500,
      packaging_cost_cents: value,
    }));

    // 125 cents -> 12500 mills; PO is the remainder of the 500-cent total.
    expect(result.packagingMills).toBe(BigInt(12500));
    expect(result.totalMills).toBe(BigInt(50000));
    expect(result.poMills).toBe(BigInt(37500));
  });

  it("still rejects a decimal-padded value, so a type regression fails loudly", () => {
    // This is the exact production failure. It must never silently round: a
    // half cent quietly dropped is a money bug, and the mills columns are where
    // sub-cent precision belongs.
    expect(() => normalizeBuildLotCosts(lot({ packaging_cost_cents: "0.0000" })))
      .toThrowError(expect.objectContaining({ code: "INVALID_BUILD_COST" }));
  });

  it("treats a null cost column as zero rather than throwing", () => {
    expect(normalizeBuildLotCosts(lot({ packaging_cost_cents: null })).packagingMills)
      .toBe(BigInt(0));
  });
});
