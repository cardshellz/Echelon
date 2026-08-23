import { describe, expect, it, vi } from "vitest";

import { createReservationService } from "../../reservation.service";

function selectRows(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(async () => rows),
    })),
  };
}

describe("ReservationService build-aware order status", () => {
  it("reports order-scoped physical reservation and unfinished build promise separately", async () => {
    const db = {
      select: vi.fn(() => selectRows([{
        id: 44,
        orderId: 12,
        sku: "QUAD-BOX-TOP-P5",
        quantity: 2,
      }])),
      execute: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            delta_sum: 0,
            legacy_reserves: 0,
            picked_units: 0,
            unreserved_units: 0,
          }],
        })
        .mockResolvedValueOnce({
          rows: [{ promised_qty: 2, status: "awaiting_build" }],
        }),
    };
    const service = createReservationService(
      db as any,
      {},
      { queueSyncAfterInventoryChange: vi.fn() },
      {},
    );

    await expect(service.getOrderReservationStatus(12)).resolves.toEqual([{
      sku: "QUAD-BOX-TOP-P5",
      orderItemId: 44,
      reservedQty: 0,
      promisedQty: 2,
      demandStatus: "awaiting_build",
      isReserved: false,
      isPromised: true,
    }]);
  });

  it("derives physical reservation from this order item's ledger, not global SKU counters", async () => {
    const db = {
      select: vi.fn(() => selectRows([{
        id: 45,
        orderId: 13,
        sku: "PHYSICAL-P5",
        quantity: 3,
      }])),
      execute: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            delta_sum: 3,
            legacy_reserves: 0,
            picked_units: 0,
            unreserved_units: 0,
          }],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const service = createReservationService(
      db as any,
      {},
      { queueSyncAfterInventoryChange: vi.fn() },
      {},
    );

    const [status] = await service.getOrderReservationStatus(13);

    expect(status).toMatchObject({
      reservedQty: 3,
      promisedQty: 0,
      demandStatus: null,
      isReserved: true,
      isPromised: false,
    });
  });
});
