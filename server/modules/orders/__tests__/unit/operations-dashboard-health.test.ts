import { describe, expect, it, vi } from "vitest";

vi.mock("../../../warehouse/settings.resolver", () => ({
  getSettingsForWarehouse: vi.fn(async () => null),
}));

import { OperationsDashboardService } from "../../operations-dashboard.service";

describe("OperationsDashboardService pick/replen health", () => {
  it("returns counts and drill-down rows for pick/replen cleanup", async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          rows: [
            { type: "stuck_replen", count: "2" },
            { type: "short_pick_unresolved", count: 1 },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{
            type: "stuck_replen",
            source_id: "121",
            priority: "1",
            task_id: "121",
            exception_id: null,
            cycle_count_id: null,
            order_id: "900",
            order_number: "#900",
            order_item_id: "500",
            variant_id: "100",
            sku: "SKU-1",
            name: "Test SKU",
            location_id: "1",
            location_code: "A-01",
            source_location_code: "B-01",
            status: "blocked",
            exception_reason: "source_empty",
            qty: "4",
            age_hours: "12",
            created_at: "2026-05-12T01:00:00.000Z",
            detail: "source_empty",
            action: "resolve_blocker",
          }],
        }),
    };
    const service = new OperationsDashboardService(db as any);

    const result = await service.getPickReplenHealth({
      warehouseId: 1,
      filter: "stuck_replen",
      search: "SKU-1",
      page: 1,
      pageSize: 25,
    });

    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(result.counts).toMatchObject({
      stuck_replen: 2,
      stale_replen_no_demand: 0,
      short_pick_unresolved: 1,
      duplicate_replen: 0,
    });
    expect(result.total).toBe(2);
    expect(result.pageSize).toBe(25);
    expect(result.items).toEqual([expect.objectContaining({
      id: "stuck_replen-121",
      type: "stuck_replen",
      priority: 1,
      taskId: 121,
      orderId: 900,
      orderNumber: "#900",
      orderItemId: 500,
      variantId: 100,
      sku: "SKU-1",
      locationId: 1,
      locationCode: "A-01",
      sourceLocationCode: "B-01",
      status: "blocked",
      exceptionReason: "source_empty",
      qty: 4,
      ageHours: 12,
      action: "resolve_blocker",
    })]);
  });

  it("falls back to all when the filter is not recognized", async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ type: "stuck_replen", count: "1" }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const service = new OperationsDashboardService(db as any);

    const result = await service.getPickReplenHealth({
      filter: "not_real",
      pageSize: 1000,
    });

    expect(result.total).toBe(1);
    expect(result.pageSize).toBe(100);
  });

  it("maps stale no-demand replen rows as cleanup work", async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          rows: [{ type: "stale_replen_no_demand", count: "1" }],
        })
        .mockResolvedValueOnce({
          rows: [{
            type: "stale_replen_no_demand",
            source_id: "977",
            priority: "4",
            task_id: "977",
            exception_id: null,
            cycle_count_id: null,
            order_id: null,
            order_number: null,
            order_item_id: null,
            variant_id: "161",
            sku: "SHLZ-TOP-55PT-SLIM-BLU-C1000",
            name: "Slim Blue Case",
            location_id: "1259",
            location_code: "H-01",
            source_location_code: "H-01",
            status: "blocked",
            exception_reason: "no_source_stock",
            qty: "0",
            age_hours: "12",
            created_at: "2026-05-12T01:00:00.000Z",
            detail: "no active demand and no executable replen quantity",
            action: "cancel_no_demand",
          }],
        }),
    };
    const service = new OperationsDashboardService(db as any);

    const result = await service.getPickReplenHealth({
      filter: "stale_replen_no_demand",
    });

    expect(result.counts.stale_replen_no_demand).toBe(1);
    expect(result.total).toBe(1);
    expect(result.items).toEqual([expect.objectContaining({
      id: "stale_replen_no_demand-977",
      type: "stale_replen_no_demand",
      priority: 4,
      taskId: 977,
      sku: "SHLZ-TOP-55PT-SLIM-BLU-C1000",
      qty: 0,
      detail: "no active demand and no executable replen quantity",
      action: "cancel_no_demand",
    })]);
  });
});
