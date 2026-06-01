import { describe, it, expect, vi } from "vitest";
import { createReservationService } from "../../reservation.service";

/**
 * Phase 3 (H1): reserveForOrder must skip frozen bins when selecting
 * the reservation location, and the fallback must filter by
 * variant_qty > 0 at unfrozen locations only.
 *
 * These are behavioral unit tests against the ReservationService. The
 * underlying Drizzle queries are mocked at the db layer.
 */

function makeHarness() {
  const reserveCalls: any[] = [];

  const mockInventoryCore = {
    reserveForOrder: vi.fn(async (params: any) => {
      reserveCalls.push(params);
      return true;
    }),
  };

  const mockChannelSync = {
    queueSyncAfterInventoryChange: vi.fn().mockResolvedValue(undefined),
  };

  const mockAtpService = {
    getAtpPerVariant: vi.fn().mockResolvedValue([
      { productVariantId: 1, sku: "TEST-SKU", atpUnits: 10, unitsPerVariant: 1 },
    ]),
  };

  return { mockInventoryCore, mockChannelSync, mockAtpService, reserveCalls };
}

describe("ReservationService.reserveForOrder freeze-check (H1)", () => {
  it("passes the selected location to inventoryCore.reserveForOrder", async () => {
    const { mockInventoryCore, mockChannelSync, mockAtpService, reserveCalls } = makeHarness();

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ warehouseLocationId: 42 }]),
    };

    const mockDb: any = {
      select: vi.fn(() => selectChain),
      transaction: async (fn: any) => fn(mockDb),
    };

    const svc = createReservationService(mockDb, mockInventoryCore, mockChannelSync, mockAtpService);

    const result = await svc.reserveForOrder(100, 1, 3, 500, 600);

    expect(result.reserved).toBe(3);
    expect(reserveCalls).toHaveLength(1);
    expect(reserveCalls[0].warehouseLocationId).toBe(42);
  });

  it("returns zero if no unfrozen location is found", async () => {
    const { mockInventoryCore, mockChannelSync, mockAtpService, reserveCalls } = makeHarness();

    // First select (product_locations): empty — no assigned bin
    // Second select (fallback inventory_levels): also empty
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };

    const mockDb: any = {
      select: vi.fn(() => selectChain),
      transaction: async (fn: any) => fn(mockDb),
    };

    const svc = createReservationService(mockDb, mockInventoryCore, mockChannelSync, mockAtpService);

    const result = await svc.reserveForOrder(100, 1, 3, 500, 600);

    expect(result.reserved).toBe(0);
    expect(result.shortfall).toBe(3);
    expect(reserveCalls).toHaveLength(0);
  });
});
