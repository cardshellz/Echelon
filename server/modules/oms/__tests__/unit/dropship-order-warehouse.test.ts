/**
 * A Dropship order must ship from the warehouse acceptance pinned, never from
 * the generic router, and a pinned warehouse that is missing, inactive or not
 * an enabled Dropship OMS assignment must fail the sync loudly.
 */
import { describe, expect, it } from "vitest";
import {
  decideDropshipOrderWarehouse,
  hasDropshipAcceptanceStamp,
  isDropshipOmsOrder,
  WmsDropshipWarehouseError,
  type DropshipOrderWarehouseFacts,
} from "../../dropship-order-warehouse";

const LEON = { id: 1, isActive: 1, warehouseType: "operations" };

function facts(overrides: Partial<DropshipOrderWarehouseFacts> = {}): DropshipOrderWarehouseFacts {
  return {
    omsOrderId: 1001,
    omsOrderChannelId: 103,
    dropshipOmsChannelId: 103,
    hasDropshipAcceptanceStamp: true,
    omsOrderWarehouseId: 1,
    warehouse: LEON,
    enabledForChannel: true,
    ...overrides,
  };
}

function failure(input: DropshipOrderWarehouseFacts): WmsDropshipWarehouseError {
  try {
    decideDropshipOrderWarehouse(input);
  } catch (error) {
    if (error instanceof WmsDropshipWarehouseError) return error;
    throw error;
  }
  throw new Error("expected the decision to refuse the order");
}

describe("isDropshipOmsOrder", () => {
  it("recognizes an order on the Dropship OMS channel", () => {
    expect(isDropshipOmsOrder({ omsOrderChannelId: 103, dropshipOmsChannelId: 103, hasDropshipAcceptanceStamp: false })).toBe(true);
  });

  it("recognizes an acceptance-stamped order even when the channel could not be resolved", () => {
    expect(isDropshipOmsOrder({ omsOrderChannelId: 103, dropshipOmsChannelId: null, hasDropshipAcceptanceStamp: true })).toBe(true);
  });

  it("leaves other channels to the router, including when the Dropship channel is unresolved", () => {
    expect(isDropshipOmsOrder({ omsOrderChannelId: 1, dropshipOmsChannelId: 103, hasDropshipAcceptanceStamp: false })).toBe(false);
    expect(isDropshipOmsOrder({ omsOrderChannelId: 1, dropshipOmsChannelId: null, hasDropshipAcceptanceStamp: false })).toBe(false);
    expect(isDropshipOmsOrder({ omsOrderChannelId: null, dropshipOmsChannelId: null, hasDropshipAcceptanceStamp: false })).toBe(false);
  });
});

describe("hasDropshipAcceptanceStamp", () => {
  it("only accepts an object stamp under the dropship key", () => {
    expect(hasDropshipAcceptanceStamp({ dropship: { intakeId: 1 }, marketplace: {} })).toBe(true);
    expect(hasDropshipAcceptanceStamp({ dropship: "yes" })).toBe(false);
    expect(hasDropshipAcceptanceStamp({ dropship: [1] })).toBe(false);
    expect(hasDropshipAcceptanceStamp({ marketplace: {} })).toBe(false);
    expect(hasDropshipAcceptanceStamp(null)).toBe(false);
    expect(hasDropshipAcceptanceStamp("dropship")).toBe(false);
  });
});

describe("decideDropshipOrderWarehouse", () => {
  it("pins the accepted warehouse and carries its type for the WMS status decision", () => {
    expect(decideDropshipOrderWarehouse(facts({ warehouse: { id: 1, isActive: 1, warehouseType: "3pl" } }))).toEqual({
      kind: "pinned",
      warehouseId: 1,
      warehouseType: "3pl",
    });
  });

  it("returns not_dropship for other channels without looking at the warehouse facts", () => {
    expect(decideDropshipOrderWarehouse(facts({
      omsOrderChannelId: 1, dropshipOmsChannelId: 103, hasDropshipAcceptanceStamp: false,
      omsOrderWarehouseId: null, warehouse: null, enabledForChannel: false,
    }))).toEqual({ kind: "not_dropship" });
  });

  it.each([
    ["no warehouse", facts({ omsOrderWarehouseId: null, warehouse: null }), "WMS_SYNC_DROPSHIP_WAREHOUSE_REQUIRED"],
    ["a non-positive warehouse id", facts({ omsOrderWarehouseId: 0, warehouse: null }), "WMS_SYNC_DROPSHIP_WAREHOUSE_REQUIRED"],
    ["a warehouse that no longer exists", facts({ warehouse: null }), "WMS_SYNC_DROPSHIP_WAREHOUSE_INACTIVE"],
    ["an inactive warehouse", facts({ warehouse: { ...LEON, isActive: 0 } }), "WMS_SYNC_DROPSHIP_WAREHOUSE_INACTIVE"],
    ["a warehouse row that does not match the pinned id", facts({ warehouse: { ...LEON, id: 35 } }), "WMS_SYNC_DROPSHIP_WAREHOUSE_INACTIVE"],
    ["a warehouse not enabled for Dropship OMS", facts({ enabledForChannel: false }), "WMS_SYNC_DROPSHIP_WAREHOUSE_NOT_ALLOCATED"],
  ])("refuses %s as a permanent error instead of routing elsewhere", (_label, input, code) => {
    const error = failure(input);
    expect(error.code).toBe(code);
    expect(error.classification).toBe("permanent");
    expect(error.context).toMatchObject({ omsOrderId: 1001, channelId: 103 });
  });
});
