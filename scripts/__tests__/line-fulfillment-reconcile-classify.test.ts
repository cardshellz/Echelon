/**
 * Unit tests for the Phase 1 reconciliation classifier
 * (scripts/lib/line-fulfillment-reconcile-classify.ts).
 *
 * The cases mirror real patterns the 2026-06-15 prod dry-run surfaced, so the
 * decision table is pinned to the data it was designed against and the eventual
 * `deriveWmsFromLines` (Phase 3) can be built on the same semantics.
 */
import { describe, it, expect } from "vitest";
import {
  deriveNewModel,
  deriveCurrentModel,
  classify,
  FLAGGED,
  type ReconcileInput,
} from "../lib/line-fulfillment-reconcile-classify";

// Minimal builder — defaults to a clean fully-shipped single-line order.
function row(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    warehouse_status: "shipped",
    n_shippable: 1, n_fully: 1, n_any: 1,
    n_ship: 1, n_shipped: 1, n_onhold: 0, n_cancelled: 0, n_open_other: 0,
    ...over,
  };
}

describe("deriveNewModel", () => {
  it("no shippable lines → no_ship (digital / zero-qty / all-cancelled)", () => {
    expect(deriveNewModel(row({ n_shippable: 0, n_fully: 0, n_any: 0 }))).toBe("no_ship");
  });
  it("every shippable line fully covered → shipped", () => {
    expect(deriveNewModel(row({ n_shippable: 3, n_fully: 3, n_any: 3 }))).toBe("shipped");
  });
  it("some lines shipped, not all fully → partially_shipped", () => {
    expect(deriveNewModel(row({ n_shippable: 6, n_fully: 5, n_any: 5 }))).toBe("partially_shipped");
  });
  it("no line shipped → ready", () => {
    expect(deriveNewModel(row({ n_shippable: 2, n_fully: 0, n_any: 0 }))).toBe("ready");
  });
});

describe("deriveCurrentModel mirrors production deriveWmsFromShipments", () => {
  it("THE CORE BUG: one shipped + rest cancelled → current says 'shipped'", () => {
    // #56986 shape: 2 shipments, 1 shipped + 1 cancelled. The shipment-set model
    // sees anyShipped && !anyOpen → 'shipped', hiding the un-shipped unit.
    expect(deriveCurrentModel(row({ n_ship: 2, n_shipped: 1, n_cancelled: 1 }))).toBe("shipped");
  });
  it("…while the new line-qty model on the same order says 'partially_shipped'", () => {
    // ordered 27, shipped 26 → 4 of 5 lines fully, 1 short.
    expect(deriveNewModel(row({ n_shippable: 5, n_fully: 4, n_any: 5 }))).toBe("partially_shipped");
  });
  it("no shipment rows → 'ready'", () => {
    expect(deriveCurrentModel(row({ n_ship: 0, n_shipped: 0 }))).toBe("ready");
  });
  it("any on_hold shipment → 'on_hold'", () => {
    expect(deriveCurrentModel(row({ n_ship: 2, n_shipped: 1, n_onhold: 1 }))).toBe("on_hold");
  });
});

describe("classify decision table", () => {
  it("stale_partial: stored partially_shipped, lines fully shipped (#57921)", () => {
    const r = row({ warehouse_status: "partially_shipped", n_shippable: 2, n_fully: 2, n_any: 2 });
    expect(classify(r, deriveNewModel(r))).toBe("stale_partial");
  });

  it("over_reported (short-ship): stored shipped, one unit short (#56986 family)", () => {
    const r = row({
      warehouse_status: "shipped",
      n_shippable: 5, n_fully: 4, n_any: 5,
      n_ship: 2, n_shipped: 1, n_cancelled: 1,
    });
    expect(deriveNewModel(r)).toBe("partially_shipped");
    expect(classify(r, deriveNewModel(r))).toBe("over_reported");
  });

  it("over_reported (no line linkage): shipped shipment, 0 units credited", () => {
    // eBay/oms header-only shipments: n_shipped=1 but no shippable line covered.
    const r = row({
      warehouse_status: "shipped",
      n_shippable: 1, n_fully: 0, n_any: 0,
      n_ship: 1, n_shipped: 1,
    });
    expect(deriveNewModel(r)).toBe("ready");
    expect(classify(r, deriveNewModel(r))).toBe("over_reported");
  });

  it("cancelled_but_shipped: stored cancelled but lines shipped (truth wins)", () => {
    const r = row({
      warehouse_status: "cancelled",
      n_shippable: 1, n_fully: 1, n_any: 1,
      n_ship: 2, n_shipped: 1, n_cancelled: 1,
    });
    expect(classify(r, deriveNewModel(r))).toBe("cancelled_but_shipped");
  });

  it("cancelled_overlay: stored cancelled, nothing shipped → not flagged", () => {
    const r = row({
      warehouse_status: "cancelled",
      n_shippable: 1, n_fully: 0, n_any: 0,
      n_ship: 1, n_shipped: 0, n_cancelled: 1,
    });
    expect(classify(r, deriveNewModel(r))).toBe("cancelled_overlay");
  });

  it("legacy_preserve: stored shipped, NO shipment rows → cutover must not downgrade", () => {
    // 48,783 prod orders: zero-qty/legacy lines, stored shipped, no shipments.
    const r = row({
      warehouse_status: "shipped",
      n_shippable: 1, n_fully: 0, n_any: 0,
      n_ship: 0, n_shipped: 0,
    });
    expect(classify(r, deriveNewModel(r))).toBe("legacy_preserve");
  });

  it("legacy_unfulfilled: no shipments, stored not shipped-ish", () => {
    const r = row({
      warehouse_status: "ready",
      n_shippable: 1, n_fully: 0, n_any: 0,
      n_ship: 0, n_shipped: 0,
    });
    expect(classify(r, deriveNewModel(r))).toBe("legacy_unfulfilled");
  });

  it("missed_fulfillment: in-warehouse status but lines shipped", () => {
    const r = row({
      warehouse_status: "packed",
      n_shippable: 2, n_fully: 2, n_any: 2,
      n_ship: 1, n_shipped: 1,
    });
    expect(classify(r, deriveNewModel(r))).toBe("missed_fulfillment");
  });

  it("hold_but_shipped vs hold_overlay", () => {
    const shipped = row({ warehouse_status: "on_hold", n_shippable: 1, n_fully: 1, n_any: 1, n_ship: 1, n_shipped: 1 });
    expect(classify(shipped, deriveNewModel(shipped))).toBe("hold_but_shipped");
    const idle = row({ warehouse_status: "on_hold", n_shippable: 1, n_fully: 0, n_any: 0, n_ship: 1, n_shipped: 0, n_open_other: 1 });
    expect(classify(idle, deriveNewModel(idle))).toBe("hold_overlay");
  });

  it("no_ship_lines: zero shippable lines regardless of stored status", () => {
    const r = row({ warehouse_status: "shipped", n_shippable: 0, n_fully: 0, n_any: 0, n_ship: 0, n_shipped: 0 });
    expect(classify(r, deriveNewModel(r))).toBe("no_ship_lines");
  });

  it("match: stored agrees with line truth", () => {
    const r = row({ warehouse_status: "shipped", n_shippable: 1, n_fully: 1, n_any: 1, n_ship: 1, n_shipped: 1 });
    expect(classify(r, deriveNewModel(r))).toBe("match");
  });

  it("only the intended buckets are flagged as actionable", () => {
    expect([...FLAGGED].sort()).toEqual(
      ["cancelled_but_shipped", "hold_but_shipped", "missed_fulfillment", "other_mismatch", "over_reported", "stale_partial"],
    );
  });
});
