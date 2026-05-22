import { describe, expect, it } from "vitest";

import {
  buildPlans,
  chooseCanonical,
  decideRow,
  parseFlags,
} from "../cleanup-duplicate-wms-orders";

function row(overrides: Record<string, unknown> = {}) {
  return {
    oms_order_id: 184362,
    external_order_number: "#57785",
    oms_status: "confirmed",
    oms_fulfillment_status: "unfulfilled",
    wms_order_id: 202373,
    order_number: "#57785",
    warehouse_id: 1,
    warehouse_status: "ready",
    created_at: "2026-05-20 20:17:50.476",
    updated_at: "2026-05-20 20:18:39.234",
    cancelled_at: null,
    completed_at: null,
    tracking_number: null,
    item_count: 2,
    unit_quantity: 14,
    picked_quantity: 0,
    fulfilled_quantity: 0,
    item_signature: "305000=10|305001=4",
    shipment_count: 1,
    active_shipment_count: 1,
    active_shipstation_count: 1,
    shipped_shipment_count: 0,
    shipments: [
      {
        id: 1505,
        status: "queued",
        shipstation_order_id: 739771876,
        shipstation_order_key: "echelon-wms-shp-1505",
        tracking_number: null,
        requires_review: false,
      },
    ],
    ...overrides,
  } as any;
}

describe("cleanup-duplicate-wms-orders", () => {
  it("defaults to dry-run and parses scoped flags", () => {
    expect(parseFlags([])).toMatchObject({
      mode: "dry-run",
      limit: 25,
      omsOrderId: null,
      orderNumber: null,
      cancelShipStation: false,
    });

    expect(parseFlags(["--execute", "--oms-order-id=184362", "--cancel-shipstation"])).toMatchObject({
      mode: "execute",
      limit: 1,
      omsOrderId: 184362,
      cancelShipStation: true,
    });

    expect(parseFlags(["--order-number=#57785"]).orderNumber).toBe("#57785");
  });

  it("rejects conflicting or invalid flags", () => {
    expect(() => parseFlags(["--execute", "--dry-run"])).toThrow(/Cannot pass both/);
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--oms-order-id=abc"])).toThrow(/positive integer/);
  });

  it("keeps the row with shipped evidence as canonical", () => {
    const candidate = chooseCanonical([
      row({ wms_order_id: 10, shipment_count: 1, active_shipstation_count: 1 }),
      row({
        wms_order_id: 11,
        warehouse_status: "shipped",
        shipment_count: 1,
        active_shipment_count: 0,
        active_shipstation_count: 0,
        shipped_shipment_count: 1,
        shipments: [
          {
            id: 200,
            status: "shipped",
            shipstation_order_id: 123,
            shipstation_order_key: "echelon-wms-shp-200",
            tracking_number: "1ZTRACK",
            requires_review: false,
          },
        ],
      }),
    ]);

    expect(candidate.wms_order_id).toBe(11);
  });

  it("requires explicit ShipStation cancellation before retiring active duplicate SS work", () => {
    const canonical = row({ wms_order_id: 202373 });
    const duplicate = row({ wms_order_id: 202374 });

    expect(decideRow(duplicate, canonical, parseFlags(["--dry-run"]))).toMatchObject({
      action: "needs_shipstation_cancel",
      shipstationOrderIds: [739771876],
    });

    expect(decideRow(duplicate, canonical, parseFlags(["--execute", "--cancel-shipstation"]))).toMatchObject({
      action: "retire_after_shipstation_cancel",
      shipstationOrderIds: [739771876],
    });
  });

  it("refuses automatic cleanup when duplicate item coverage differs", () => {
    const canonical = row({ wms_order_id: 1, item_signature: "A=1" });
    const duplicate = row({ wms_order_id: 2, item_signature: "B=1", shipments: [] });

    expect(decideRow(duplicate, canonical, parseFlags([]))).toMatchObject({
      action: "manual_review",
      reason: "item coverage differs from canonical row",
    });
  });

  it("builds one plan per duplicate OMS order", () => {
    const plans = buildPlans([
      row({ wms_order_id: 1, shipment_count: 0, active_shipment_count: 0, active_shipstation_count: 0, shipments: [] }),
      row({ wms_order_id: 2, shipment_count: 0, active_shipment_count: 0, active_shipstation_count: 0, shipments: [] }),
    ], parseFlags([]));

    expect(plans).toHaveLength(1);
    expect(plans[0].canonical.wms_order_id).toBe(1);
    expect(plans[0].decisions.map((decision) => decision.action)).toEqual(["keep", "retire_db_only"]);
  });
});
