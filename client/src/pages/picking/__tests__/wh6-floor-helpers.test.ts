import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  groupMappedPickerOrders,
  isDefiniteCommandRejection,
  mapPickerOrder,
  type OrderWithItems,
} from "../picking-types-and-helpers";
import { buildReplenTaskRetryRequest } from "../../replen-task-retry-model";
import { replenishmentTaskPatchSchema } from "@shared/types/replenishment-task-command";

describe("WH-6 floor command & walk-path helpers", () => {
  it("treats all non-in-progress 4xx/409 responses as definite rejections while retaining in-progress and 5xx", () => {
    expect(isDefiniteCommandRejection(400, { error: "Invalid qty" })).toBe(true);
    expect(isDefiniteCommandRejection(404, { error: "Order item not found" })).toBe(true);
    expect(isDefiniteCommandRejection(409, { code: "LOCATION_FROZEN", commandRejected: true })).toBe(true);
    expect(isDefiniteCommandRejection(409, { code: "PICK_CORRECTION_OPEN" })).toBe(true);
    expect(isDefiniteCommandRejection(409, { code: "PICKING_COMMAND_IN_PROGRESS" })).toBe(false);
    expect(isDefiniteCommandRejection(409, { code: "FINANCIAL_COMMAND_IN_PROGRESS" })).toBe(false);
    expect(isDefiniteCommandRejection(409, { ambiguous: true })).toBe(false);
    expect(isDefiniteCommandRejection(500, { error: "Database connection reset" })).toBe(false);
    expect(isDefiniteCommandRejection(503, null)).toBe(false);
  });

  it("sorts mapped and combined picker order items by Zone -> Aisle -> Bay -> Level -> Bin", () => {
    const rawOrder = {
      id: 700,
      orderNumber: "#700",
      customerName: "Walk Path Tester",
      warehouseStatus: "ready",
      priority: 100,
      onHold: 0,
      items: [
        {
          id: 1,
          orderId: 700,
          sku: "SKU-UNASSIGNED",
          name: "Unassigned Item",
          quantity: 1,
          pickedQuantity: 0,
          fulfilledQuantity: 0,
          status: "pending",
          location: "UNASSIGNED",
          requiresShipping: 1,
          sourcePlan: { status: "confirmation_only" },
        },
        {
          id: 2,
          orderId: 700,
          sku: "SKU-B2",
          name: "Aisle B Item",
          quantity: 1,
          pickedQuantity: 0,
          fulfilledQuantity: 0,
          status: "pending",
          location: "FWD-B-01-A-01",
          requiresShipping: 1,
          sourcePlan: {
            status: "ready",
            productVariantId: 20,
            warehouseLocationId: 202,
            warehouseId: 1,
            locationCode: "FWD-B-01-A-01",
          },
        },
        {
          id: 3,
          orderId: 700,
          sku: "SKU-A10",
          name: "Aisle A Bay 10",
          quantity: 1,
          pickedQuantity: 0,
          fulfilledQuantity: 0,
          status: "pending",
          location: "FWD-A-10-A-01",
          requiresShipping: 1,
          sourcePlan: {
            status: "ready",
            productVariantId: 30,
            warehouseLocationId: 203,
            warehouseId: 1,
            locationCode: "FWD-A-10-A-01",
          },
        },
        {
          id: 4,
          orderId: 700,
          sku: "SKU-A2",
          name: "Aisle A Bay 02",
          quantity: 1,
          pickedQuantity: 0,
          fulfilledQuantity: 0,
          status: "pending",
          location: "FWD-A-02-A-01",
          requiresShipping: 1,
          sourcePlan: {
            status: "ready",
            productVariantId: 40,
            warehouseLocationId: 204,
            warehouseId: 1,
            locationCode: "FWD-A-02-A-01",
          },
        },
      ],
    } as unknown as OrderWithItems;

    const mapped = mapPickerOrder(rawOrder);
    expect(mapped.items.map((it) => it.sku)).toEqual([
      "SKU-A2",
      "SKU-A10",
      "SKU-B2",
      "SKU-UNASSIGNED",
    ]);

    const combinedParent = { ...mapped, id: "700", combinedGroupId: 9, combinedRole: "parent", items: [mapped.items[2]] };
    const combinedChild = { ...mapped, id: "701", orderNumber: "#701", combinedGroupId: 9, combinedRole: "child", items: [mapped.items[0]] };
    const grouped = groupMappedPickerOrders([combinedParent, combinedChild]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].items.map((it) => it.sku)).toEqual(["SKU-A2", "SKU-B2"]);
  });

  it("accepts replenishment task retry payloads and source-location changes in replenishmentTaskPatchSchema", () => {
    const retryPayload = {
      commandId: randomUUID(),
      expectedRevision: 2,
      expectedStatus: "blocked" as const,
      ...buildReplenTaskRetryRequest(),
    };
    const parsedRetry = replenishmentTaskPatchSchema.parse(retryPayload);
    expect(parsedRetry.status).toBe("pending");
    expect(parsedRetry.exceptionReason).toBeNull();

    const sourceChangePayload = {
      commandId: randomUUID(),
      expectedRevision: 3,
      expectedStatus: "pending" as const,
      fromLocationId: 42,
    };
    const parsedSourceChange = replenishmentTaskPatchSchema.parse(sourceChangePayload);
    expect(parsedSourceChange.fromLocationId).toBe(42);
  });
});
