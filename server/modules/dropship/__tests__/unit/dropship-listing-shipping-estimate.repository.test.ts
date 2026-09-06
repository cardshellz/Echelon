import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
import { PgListingShippingEstimateContextReader } from "../../infrastructure/dropship-listing-shipping-estimate.repository";

describe("listing shipping estimate context reader", () => {
  it("binds member and store ownership in a SELECT-only query", async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows: [{ vendor_id: 10, store_connection_id: 22, vendor_status: "onboarding", entitlement_status: "active", store_status: "connected", config: { orderProcessing: { defaultWarehouseId: 3 } } }] }));
    const reader = new PgListingShippingEstimateContextReader({ query } as unknown as Pool);
    expect(await reader.loadForMember("member-1", 22)).toEqual({ vendorId: 10, storeConnectionId: 22, vendorStatus: "onboarding", entitlementStatus: "active", storeStatus: "connected", defaultWarehouseId: 3, warehouseConfigError: null });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][1]).toEqual(["member-1", 22]);
    const statement = query.mock.calls[0][0];
    expect(statement).toMatch(/WHERE v\.member_id = \$1 AND sc\.id = \$2/);
    expect(statement).toContain("sc.vendor_id = v.id");
    expect(statement).not.toMatch(/\b(INSERT|UPDATE|DELETE|BEGIN|COMMIT|FOR UPDATE)\b/i);
    expect(statement).not.toMatch(/wallet|token|password/i);
  });
  it("returns no context for wrong member/store without provisioning", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const reader = new PgListingShippingEstimateContextReader({ query } as unknown as Pool);
    expect(await reader.loadForMember("other-member", 22)).toBeNull();
    expect(query).toHaveBeenCalledOnce();
  });
  it.each([
    [null, null, false],
    [{ defaultWarehouseId: 2, orderProcessing: { defaultWarehouseId: 3 } }, 2, false],
    [{ warehouseId: 4 }, 4, false],
    [{ dropshipOrderProcessing: { defaultWarehouseId: "5" } }, 5, false],
    [{ defaultWarehouseId: -1, orderProcessing: { defaultWarehouseId: 3 } }, null, true],
    [{ orderProcessing: { defaultWarehouseId: "invalid" } }, null, true],
  ])("uses the order-processing warehouse resolver for %j", async (config, defaultWarehouseId, invalid) => {
    const query = vi.fn(async () => ({ rows: [{ vendor_id: 10, store_connection_id: 22, vendor_status: "active", entitlement_status: "active", store_status: "connected", config }] }));
    const reader = new PgListingShippingEstimateContextReader({ query } as unknown as Pool);
    const result = await reader.loadForMember("member-1", 22);
    expect(result?.defaultWarehouseId).toBe(defaultWarehouseId);
    expect(result?.warehouseConfigError !== null).toBe(invalid);
  });
});
