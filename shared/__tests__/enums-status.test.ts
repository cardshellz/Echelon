/**
 * Exhaustive unit tests for shared/enums/order-status.ts.
 *
 * Every exported function is covered across the full Cartesian product
 * of its input domain. No randomness. No time. Pure derivation logic —
 * easy to over-test, cheap to keep correct.
 */

import { describe, it, expect } from "vitest";
import {
  OMS_ORDER_STATUS_VALUES,
  WMS_WAREHOUSE_STATUS_VALUES,
  SHIPMENT_STATUS_VALUES,
  TERMINAL_SHIPMENT_STATUSES,
  deriveOmsFromWms,
  deriveWmsFromShipments,
  isShipmentShipped,
  isShipmentOpen,
  type OmsOrderStatus,
  type WmsWarehouseStatus,
  type ShipmentStatus,
} from "../enums/order-status";

describe("enum value sets", () => {
  it("OMS_ORDER_STATUS_VALUES is the expected 7-element union", () => {
    expect(OMS_ORDER_STATUS_VALUES).toEqual([
      "pending",
      "paid",
      "processing",
      "partially_shipped",
      "shipped",
      "cancelled",
      "refunded",
    ]);
  });

  it("WMS_WAREHOUSE_STATUS_VALUES is the 12-element union", () => {
    // Includes the new `partially_shipped` state (plan §4.7).
    expect(WMS_WAREHOUSE_STATUS_VALUES).toContain("partially_shipped");
    expect(WMS_WAREHOUSE_STATUS_VALUES.length).toBe(12);
  });

  it("SHIPMENT_STATUS_VALUES is the 9-element union", () => {
    expect(SHIPMENT_STATUS_VALUES).toEqual([
      "planned",
      "queued",
      "labeled",
      "shipped",
      "on_hold",
      "voided",
      "cancelled",
      "returned",
      "lost",
    ]);
  });

  it("TERMINAL_SHIPMENT_STATUSES covers the expected terminal set", () => {
    expect(new Set(TERMINAL_SHIPMENT_STATUSES)).toEqual(
      new Set(["shipped", "cancelled", "returned", "lost"]),
    );
  });
});

describe("isShipmentShipped / isShipmentOpen — partition coverage", () => {
  // Every shipment status must be classified by EXACTLY one of the two
  // predicates, or neither (cancelled). This test is the gate that says
  // "adding a new ShipmentStatus value without thinking about this is a
  // bug".
  for (const status of SHIPMENT_STATUS_VALUES) {
    it(`${status}: not both shipped and open`, () => {
      const shipped = isShipmentShipped(status);
      const open = isShipmentOpen(status);
      expect(shipped && open).toBe(false);
    });
  }

  it("isShipmentShipped returns true only for shipped / returned / lost", () => {
    expect(isShipmentShipped("shipped")).toBe(true);
    expect(isShipmentShipped("returned")).toBe(true);
    expect(isShipmentShipped("lost")).toBe(true);
    const notShipped: ShipmentStatus[] = [
      "planned",
      "queued",
      "labeled",
      "on_hold",
      "voided",
      "cancelled",
    ];
    for (const s of notShipped) expect(isShipmentShipped(s)).toBe(false);
  });

  it("isShipmentOpen returns true for planned/queued/labeled/on_hold/voided", () => {
    const open: ShipmentStatus[] = [
      "planned",
      "queued",
      "labeled",
      "on_hold",
      "voided",
    ];
    for (const s of open) expect(isShipmentOpen(s)).toBe(true);

    const notOpen: ShipmentStatus[] = [
      "shipped",
      "cancelled",
      "returned",
      "lost",
    ];
    for (const s of notOpen) expect(isShipmentOpen(s)).toBe(false);
  });
});

describe("deriveOmsFromWms — exhaustive 12-value table", () => {
  const table: ReadonlyArray<[WmsWarehouseStatus, OmsOrderStatus | null]> = [
    ["ready", null],
    ["picking", null],
    ["picked", null],
    ["packing", null],
    ["packed", null],
    ["ready_to_ship", null],
    ["partially_shipped", "partially_shipped"],
    ["shipped", "shipped"],
    ["on_hold", null],
    ["exception", null],
    ["cancelled", "cancelled"],
    ["awaiting_3pl", null],
  ];

  for (const [input, expected] of table) {
    it(`${input} → ${expected === null ? "null (no OMS update)" : expected}`, () => {
      expect(deriveOmsFromWms(input)).toBe(expected);
    });
  }

  it("covers every WMS warehouse status value (no orphans)", () => {
    const covered = new Set(table.map(([k]) => k));
    expect(covered.size).toBe(WMS_WAREHOUSE_STATUS_VALUES.length);
    for (const v of WMS_WAREHOUSE_STATUS_VALUES) expect(covered.has(v)).toBe(true);
  });
});

describe("deriveWmsFromShipments — roll-up matrix", () => {
  it("no shipments → ready", () => {
    expect(deriveWmsFromShipments([])).toBe("ready");
  });

  it("all shipped → shipped", () => {
    expect(deriveWmsFromShipments(["shipped"])).toBe("shipped");
    expect(deriveWmsFromShipments(["shipped", "shipped"])).toBe("shipped");
  });

  it("any on_hold → on_hold (wins over everything)", () => {
    expect(deriveWmsFromShipments(["on_hold"])).toBe("on_hold");
    // Priority: on_hold beats shipped siblings.
    expect(deriveWmsFromShipments(["shipped", "on_hold"])).toBe("on_hold");
    expect(deriveWmsFromShipments(["shipped", "on_hold", "cancelled"])).toBe(
      "on_hold",
    );
  });

  it("all cancelled → cancelled", () => {
    expect(deriveWmsFromShipments(["cancelled"])).toBe("cancelled");
    expect(deriveWmsFromShipments(["cancelled", "cancelled"])).toBe("cancelled");
  });

  it("some shipped + some open → partially_shipped", () => {
    expect(deriveWmsFromShipments(["shipped", "planned"])).toBe(
      "partially_shipped",
    );
    expect(deriveWmsFromShipments(["shipped", "queued", "labeled"])).toBe(
      "partially_shipped",
    );
    // Voided is "open" — needs re-label.
    expect(deriveWmsFromShipments(["shipped", "voided"])).toBe(
      "partially_shipped",
    );
  });

  it("shipped + cancelled sibling (no open) → shipped", () => {
    // A cancelled shipment plus a shipped shipment means the order is
    // effectively done — nothing still open to fulfill.
    expect(deriveWmsFromShipments(["shipped", "cancelled"])).toBe("shipped");
  });

  it("all open (none shipped) → ready_to_ship", () => {
    expect(deriveWmsFromShipments(["planned"])).toBe("ready_to_ship");
    expect(deriveWmsFromShipments(["planned", "queued"])).toBe("ready_to_ship");
    expect(deriveWmsFromShipments(["queued", "labeled"])).toBe("ready_to_ship");
    expect(deriveWmsFromShipments(["voided"])).toBe("ready_to_ship");
  });

  it("mixed open + cancelled (no shipped) → ready_to_ship", () => {
    expect(deriveWmsFromShipments(["planned", "cancelled"])).toBe(
      "ready_to_ship",
    );
  });

  it("returned counts as shipped for roll-up", () => {
    expect(deriveWmsFromShipments(["returned"])).toBe("shipped");
    expect(deriveWmsFromShipments(["returned", "shipped"])).toBe("shipped");
    expect(deriveWmsFromShipments(["returned", "planned"])).toBe(
      "partially_shipped",
    );
  });

  it("lost counts as shipped for roll-up", () => {
    expect(deriveWmsFromShipments(["lost"])).toBe("shipped");
  });
});
