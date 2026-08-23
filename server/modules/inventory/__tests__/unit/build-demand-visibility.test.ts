import { describe, expect, it, vi } from "vitest";

import { BuildQueryRepository } from "../../infrastructure/build-query.repository";

describe("BuildQueryRepository order demand visibility", () => {
  it("attaches the owning WMS order demand to every build in its dependency graph", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 501,
          system_number: "BLD-00501",
          recipe_id: 10,
          recipe_code: "QUAD-BOX-TOP-P5",
          recipe_version: 1,
          recipe_type: "conversion",
          output_product_id: 20,
          output_units_per_variant: 5,
          output_variant_id: 21,
          output_sku: "QUAD-BOX-TOP-P5",
          output_name: "Pack of 5",
          output_qty_per_build: 1,
          planned_builds: 2,
          completed_builds: 0,
          warehouse_id: 1,
          warehouse_name: "Main",
          output_location_id: 100,
          output_location_code: "BUILD-OUT",
          status: "released",
          failure_count: 0,
          created_at: "2026-08-23T12:00:00Z",
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          build_order_id: 501,
          dependency_depth: 1,
          id: 77,
          order_id: 900,
          order_number: "#62000",
          order_item_id: 901,
          sku: "QUAD-BOX-TOP-P5",
          requested_qty: 2,
          promised_qty: 2,
          status: "awaiting_build",
          root_build_order_id: 502,
        }],
      });
    const repository = new BuildQueryRepository({ execute } as any);

    const [order] = await repository.listOrders(1);

    expect(order.demand).toEqual({
      id: 77,
      orderId: 900,
      orderNumber: "#62000",
      orderItemId: 901,
      sku: "QUAD-BOX-TOP-P5",
      requestedQty: 2,
      promisedQty: 2,
      status: "awaiting_build",
      rootBuildOrderId: 502,
      dependencyDepth: 1,
    });
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
