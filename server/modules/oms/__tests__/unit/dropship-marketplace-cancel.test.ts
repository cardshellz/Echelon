import { describe, expect, it, vi } from "vitest";

import {
  decideMarketplaceCancelVerdict,
  DropshipMarketplaceCancelStopError,
  stopOrderForMarketplaceCancel,
  type DropshipMarketplaceCancelStopDeps,
} from "../../dropship-marketplace-cancel";

/**
 * OMS's stop for an accepted dropship order eBay cancelled (eBay sync-back
 * plan v4 §7.2): the verdict from the shipment and WMS order rows, and the
 * paths that must write nothing. The cancel steps themselves run against
 * PostgreSQL in __tests__/integration/dropship-marketplace-cancel.integration.test.ts.
 */
const shipment = (overrides: Partial<{ id: number; status: string; trackingNumber: string | null; shippedAt: Date | null }>) => ({
  id: 1, status: "cancelled", trackingNumber: null, shippedAt: null, ...overrides });

describe("decideMarketplaceCancelVerdict", () => {
  it("calls an order stopped only when every shipment is cancelled or voided with no label and every WMS order is cancelled", () => {
    expect(decideMarketplaceCancelVerdict({ wmsOrders: [{ id: 1, warehouseStatus: "cancelled" }],
      shipments: [shipment({ status: "cancelled" }), shipment({ id: 2, status: "voided" })] })).toBe("stopped");
    expect(decideMarketplaceCancelVerdict({ wmsOrders: [], shipments: [] })).toBe("stopped");
  });

  it("does not call an order stopped when a label was bought: the tracking number survives the cancel", () => {
    expect(decideMarketplaceCancelVerdict({ wmsOrders: [{ id: 1, warehouseStatus: "cancelled" }],
      shipments: [shipment({ trackingNumber: "1Z999" })] })).toBe("not_stopped");
    // A blank tracking number is no label.
    expect(decideMarketplaceCancelVerdict({ wmsOrders: [{ id: 1, warehouseStatus: "cancelled" }],
      shipments: [shipment({ trackingNumber: "  " })] })).toBe("stopped");
  });

  it("does not call an order stopped while a shipment or WMS order is still open", () => {
    expect(decideMarketplaceCancelVerdict({ wmsOrders: [{ id: 1, warehouseStatus: "ready" }], shipments: [] })).toBe("not_stopped");
    expect(decideMarketplaceCancelVerdict({ wmsOrders: [{ id: 1, warehouseStatus: null }], shipments: [] })).toBe("not_stopped");
    expect(decideMarketplaceCancelVerdict({ wmsOrders: [{ id: 1, warehouseStatus: "cancelled" }],
      shipments: [shipment({ status: "planned" })] })).toBe("not_stopped");
  });

  it("checks for a shipped order first, by shipment status, ship time or WMS status", () => {
    for (const status of ["shipped", "returned", "lost"]) {
      expect(decideMarketplaceCancelVerdict({ wmsOrders: [{ id: 1, warehouseStatus: "cancelled" }], shipments: [shipment({ status })] }), status)
        .toBe("already_shipped");
    }
    expect(decideMarketplaceCancelVerdict({ wmsOrders: [{ id: 1, warehouseStatus: "cancelled" }],
      shipments: [shipment({ shippedAt: new Date("2026-10-22T00:00:00.000Z") })] })).toBe("already_shipped");
    for (const warehouseStatus of ["shipped", "partially_shipped"]) {
      expect(decideMarketplaceCancelVerdict({ wmsOrders: [{ id: 1, warehouseStatus }], shipments: [] }), warehouseStatus).toBe("already_shipped");
    }
  });
});

describe("stopOrderForMarketplaceCancel without a database write", () => {
  const deps = (rows: Array<Array<Record<string, unknown>>>): DropshipMarketplaceCancelStopDeps & { execute: ReturnType<typeof vi.fn> } => {
    const execute = vi.fn(async () => ({ rows: rows.shift() ?? [] }));
    return { db: { execute }, execute, reservation: { releaseOrderReservation: vi.fn() } as never, clock: () => new Date("2026-10-22T12:00:00.000Z") };
  };

  it("refuses an OMS order id that is not a positive integer as a fatal caller defect, before any read", async () => {
    const stop = deps([]);
    for (const omsOrderId of [0, -3, 1.5]) {
      const failure = await stopOrderForMarketplaceCancel({ omsOrderId }, stop).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(DropshipMarketplaceCancelStopError);
      expect(failure).toMatchObject({ code: "OMS_DROPSHIP_MARKETPLACE_CANCEL_INPUT_INVALID", classification: "fatal" });
    }
    expect(stop.execute).not.toHaveBeenCalled();
  });

  it("answers not_found for a missing OMS order after one read", async () => {
    const stop = deps([[]]);
    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 9 }, stop)).toEqual({ kind: "not_found", shipments: [] });
    expect(stop.execute).toHaveBeenCalledTimes(1);
  });

  it("answers already_shipped from the reads alone and writes nothing", async () => {
    const stop = deps([[{ id: 9, status: "confirmed" }], [{ id: 1009, warehouse_status: "shipped" }],
      [{ id: 2009, status: "shipped", tracking_number: "1Z1", shipped_at: "2026-10-21T00:00:00.000Z" }]]);
    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 9 }, stop)).toEqual({ kind: "already_shipped",
      shipments: [{ id: 2009, status: "shipped", hadTracking: true, mode: "untouched", reason: null }] });
    expect(stop.execute).toHaveBeenCalledTimes(3);
  });
});
