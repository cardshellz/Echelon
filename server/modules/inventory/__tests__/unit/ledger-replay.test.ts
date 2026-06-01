/**
 * Unit tests — Phase 0 ledger replay (pure, no DB).
 *
 * These pin the on-hand replay CONVENTIONS derived from the write sites in
 * inventory.use-cases.ts / returns.service.ts / inventory.routes.ts. If a
 * future change alters how a transaction type writes its delta/locations,
 * one of these will break — which is the point.
 */

import { describe, it, expect } from "vitest";
import {
  ledgerRowToCellDeltas,
  replayLedger,
  reconcile,
  cellKey,
  type LedgerRow,
  type LevelRow,
} from "../../reconcile/ledger-replay";

function row(overrides: Partial<LedgerRow>): LedgerRow {
  return {
    transactionType: "adjustment",
    variantQtyDelta: 0,
    productVariantId: 1,
    fromLocationId: null,
    toLocationId: null,
    ...overrides,
  };
}

describe("ledgerRowToCellDeltas — per-type conventions", () => {
  it("receipt: +qty to toLocationId", () => {
    const out = ledgerRowToCellDeltas(
      row({ transactionType: "receipt", variantQtyDelta: 5, toLocationId: 10 }),
    );
    expect(out).toEqual([{ productVariantId: 1, warehouseLocationId: 10, delta: 5 }]);
  });

  it("pick: -qty from fromLocationId", () => {
    const out = ledgerRowToCellDeltas(
      row({ transactionType: "pick", variantQtyDelta: -3, fromLocationId: 10 }),
    );
    expect(out).toEqual([{ productVariantId: 1, warehouseLocationId: 10, delta: -3 }]);
  });

  it("ship: -qty from fromLocationId", () => {
    const out = ledgerRowToCellDeltas(
      row({ transactionType: "ship", variantQtyDelta: -2, fromLocationId: 7 }),
    );
    expect(out).toEqual([{ productVariantId: 1, warehouseLocationId: 7, delta: -2 }]);
  });

  it("unpick: +qty back to fromLocationId", () => {
    const out = ledgerRowToCellDeltas(
      row({ transactionType: "unpick", variantQtyDelta: 4, fromLocationId: 7 }),
    );
    expect(out).toEqual([{ productVariantId: 1, warehouseLocationId: 7, delta: 4 }]);
  });

  it("adjustment negative: uses fromLocationId, signed", () => {
    const out = ledgerRowToCellDeltas(
      row({ transactionType: "adjustment", variantQtyDelta: -6, fromLocationId: 3 }),
    );
    expect(out).toEqual([{ productVariantId: 1, warehouseLocationId: 3, delta: -6 }]);
  });

  it("adjustment positive: uses toLocationId, signed", () => {
    const out = ledgerRowToCellDeltas(
      row({ transactionType: "adjustment", variantQtyDelta: 6, toLocationId: 3 }),
    );
    expect(out).toEqual([{ productVariantId: 1, warehouseLocationId: 3, delta: 6 }]);
  });

  it("transfer: from -= delta, to += delta (positive delta, dual location)", () => {
    const out = ledgerRowToCellDeltas(
      row({ transactionType: "transfer", variantQtyDelta: 8, fromLocationId: 1, toLocationId: 2 }),
    );
    expect(out).toEqual([
      { productVariantId: 1, warehouseLocationId: 1, delta: -8 },
      { productVariantId: 1, warehouseLocationId: 2, delta: 8 },
    ]);
  });

  it("sku_correction out leg: -qty from fromLocationId", () => {
    const out = ledgerRowToCellDeltas(
      row({ transactionType: "sku_correction", variantQtyDelta: -5, fromLocationId: 9, productVariantId: 100 }),
    );
    expect(out).toEqual([{ productVariantId: 100, warehouseLocationId: 9, delta: -5 }]);
  });

  it("sku_correction in leg: +qty to toLocationId", () => {
    const out = ledgerRowToCellDeltas(
      row({ transactionType: "sku_correction", variantQtyDelta: 5, toLocationId: 9, productVariantId: 200 }),
    );
    expect(out).toEqual([{ productVariantId: 200, warehouseLocationId: 9, delta: 5 }]);
  });
});

describe("ledgerRowToCellDeltas — skipped (non-on-hand) types", () => {
  it("reserve contributes nothing (delta 0, reserved bucket only)", () => {
    expect(ledgerRowToCellDeltas(row({ transactionType: "reserve", variantQtyDelta: 0, toLocationId: 5 }))).toEqual([]);
  });

  it("unreserve contributes nothing", () => {
    expect(ledgerRowToCellDeltas(row({ transactionType: "unreserve", variantQtyDelta: 0, fromLocationId: 5 }))).toEqual([]);
  });

  it("reserve_move contributes nothing (reserved bucket; paired transfer moves on-hand)", () => {
    expect(
      ledgerRowToCellDeltas(row({ transactionType: "reserve_move", variantQtyDelta: 3, fromLocationId: 1, toLocationId: 2 })),
    ).toEqual([]);
  });

  it("return contributes nothing (paired receipt/adjustment already moved on-hand)", () => {
    expect(ledgerRowToCellDeltas(row({ transactionType: "return", variantQtyDelta: 4, toLocationId: 5 }))).toEqual([]);
  });

  it("null productVariantId is unattributable → skipped", () => {
    expect(ledgerRowToCellDeltas(row({ transactionType: "receipt", variantQtyDelta: 5, toLocationId: 5, productVariantId: null }))).toEqual([]);
  });

  it("zero delta on an on-hand type → no effect", () => {
    expect(ledgerRowToCellDeltas(row({ transactionType: "adjustment", variantQtyDelta: 0, fromLocationId: 5 }))).toEqual([]);
  });
});

describe("replayLedger — accumulation", () => {
  it("sums a realistic life cycle to the correct on-hand", () => {
    const rows: LedgerRow[] = [
      row({ transactionType: "receipt", variantQtyDelta: 100, toLocationId: 1 }),
      row({ transactionType: "transfer", variantQtyDelta: 40, fromLocationId: 1, toLocationId: 2 }),
      row({ transactionType: "pick", variantQtyDelta: -10, fromLocationId: 2 }),
      row({ transactionType: "ship", variantQtyDelta: -5, fromLocationId: 2 }),
      row({ transactionType: "adjustment", variantQtyDelta: -3, fromLocationId: 1 }),
      // noise that must NOT affect on-hand:
      row({ transactionType: "reserve", variantQtyDelta: 0, toLocationId: 1 }),
      row({ transactionType: "return", variantQtyDelta: 7, toLocationId: 1 }),
    ];
    const expected = replayLedger(rows);
    // loc1: 100 - 40 (transfer out) - 3 (adj) = 57
    expect(expected.get(cellKey(1, 1))).toBe(57);
    // loc2: +40 (transfer in) - 10 (pick) - 5 (ship) = 25
    expect(expected.get(cellKey(1, 2))).toBe(25);
  });
});

describe("reconcile — variance detection", () => {
  it("reports zero variance when levels match replay", () => {
    const expected = replayLedger([
      row({ transactionType: "receipt", variantQtyDelta: 50, toLocationId: 1 }),
    ]);
    const levels: LevelRow[] = [{ productVariantId: 1, warehouseLocationId: 1, variantQty: 50 }];
    const result = reconcile(expected, levels);
    expect(result.variances).toEqual([]);
    expect(result.totalAbsDrift).toBe(0);
    expect(result.cellsChecked).toBe(1);
  });

  it("detects a level that drifted above the ledger (e.g. unledgered write — finding C4)", () => {
    const expected = replayLedger([
      row({ transactionType: "receipt", variantQtyDelta: 50, toLocationId: 1 }),
    ]);
    // Actual is higher than ledger explains — like the receiving case-break
    // raw UPDATE that writes no ledger row.
    const levels: LevelRow[] = [{ productVariantId: 1, warehouseLocationId: 1, variantQty: 47 }];
    const result = reconcile(expected, levels);
    expect(result.variances).toEqual([
      { productVariantId: 1, warehouseLocationId: 1, expected: 50, actual: 47, diff: -3 },
    ]);
    expect(result.totalAbsDrift).toBe(3);
  });

  it("detects a ledger-only cell with no level row", () => {
    const expected = replayLedger([
      row({ transactionType: "receipt", variantQtyDelta: 10, toLocationId: 99 }),
    ]);
    const result = reconcile(expected, []);
    expect(result.variances).toEqual([
      { productVariantId: 1, warehouseLocationId: 99, expected: 10, actual: 0, diff: -10 },
    ]);
  });

  it("detects a level-only cell with no ledger history", () => {
    const expected = new Map<string, number>();
    const levels: LevelRow[] = [{ productVariantId: 2, warehouseLocationId: 5, variantQty: 12 }];
    const result = reconcile(expected, levels);
    expect(result.variances).toEqual([
      { productVariantId: 2, warehouseLocationId: 5, expected: 0, actual: 12, diff: 12 },
    ]);
  });

  it("sorts variances by largest absolute drift first", () => {
    const expected = replayLedger([
      row({ transactionType: "receipt", variantQtyDelta: 10, toLocationId: 1 }),
      row({ transactionType: "receipt", variantQtyDelta: 10, toLocationId: 2 }),
    ]);
    const levels: LevelRow[] = [
      { productVariantId: 1, warehouseLocationId: 1, variantQty: 12 }, // diff +2
      { productVariantId: 1, warehouseLocationId: 2, variantQty: 2 }, // diff -8
    ];
    const result = reconcile(expected, levels);
    expect(result.variances.map((v) => v.warehouseLocationId)).toEqual([2, 1]);
    expect(result.totalAbsDrift).toBe(10);
  });
});
