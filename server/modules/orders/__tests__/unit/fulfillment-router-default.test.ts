import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ getDefaultFulfillmentWarehouse: vi.fn() }));
vi.mock("../../../warehouse/infrastructure/warehouse.repository", () => ({
  getDefaultFulfillmentWarehouse: h.getDefaultFulfillmentWarehouse,
}));

import { createFulfillmentRouterService } from "../../fulfillment-router.service";

// Minimal chainable drizzle stub. orderBy resolves the rules query; limit
// resolves the getWarehouse() lookup.
function makeDb({ rules = [] as any[], warehouse = undefined as any }) {
  const db: any = {
    select: () => db,
    from: () => db,
    where: () => db,
    orderBy: () => Promise.resolve(rules),
    limit: () => Promise.resolve(warehouse ? [warehouse] : []),
  };
  return db;
}

describe("FulfillmentRouterService — default fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("falls back to the default FULFILLMENT warehouse when no rule matches", async () => {
    h.getDefaultFulfillmentWarehouse.mockResolvedValue({
      id: 1, code: "LEON", warehouseType: "operations", inventorySourceType: "internal", isActive: 1,
    });
    const router = createFulfillmentRouterService(makeDb({ rules: [] }));

    const result = await router.routeOrder({ channelId: 1, country: "US", skus: ["ESS-TOP"] });

    expect(result).toMatchObject({ warehouseId: 1, warehouseCode: "LEON", warehouseType: "operations", matchedRule: null });
    expect(h.getDefaultFulfillmentWarehouse).toHaveBeenCalledOnce();
  });

  it("returns null when there is no usable default fulfillment warehouse", async () => {
    h.getDefaultFulfillmentWarehouse.mockResolvedValue(undefined);
    const router = createFulfillmentRouterService(makeDb({ rules: [] }));
    expect(await router.routeOrder({ channelId: 1 })).toBeNull();
  });

  it("a matching rule wins over the default (default fallback not consulted)", async () => {
    const router = createFulfillmentRouterService(makeDb({
      rules: [{ id: 7, matchType: "default", matchValue: null, warehouseId: 1, isActive: 1 }],
      warehouse: { id: 1, code: "LEON", warehouseType: "operations", inventorySourceType: "internal", isActive: 1 },
    }));
    const result = await router.routeOrder({ channelId: 1 });
    expect(result).toMatchObject({ warehouseId: 1, matchedRule: { id: 7, matchType: "default" } });
    expect(h.getDefaultFulfillmentWarehouse).not.toHaveBeenCalled();
  });
});

// Source-level guards for the structural invariants of this fix (the filter
// logic lives in SQL, which a mock can't exercise; and the routing-before-insert
// ordering is the regression we're guarding against).
describe("routing-at-ingestion — structural guards", () => {
  const REPO_SRC = readFileSync(resolve(__dirname, "../../../warehouse/infrastructure/warehouse.repository.ts"), "utf-8");
  const WMS_SRC = readFileSync(resolve(__dirname, "../../../oms/wms-sync.service.ts"), "utf-8");

  it("default fulfillment warehouse excludes storage hubs and is deterministic", () => {
    expect(REPO_SRC).toMatch(/getDefaultFulfillmentWarehouse/);
    expect(REPO_SRC).toMatch(/inArray\(warehouses\.warehouseType, \["operations", "3pl"\]\)/);
    expect(REPO_SRC).toMatch(/orderBy\(asc\(warehouses\.id\)\)/);
  });

  it("wms-sync routes BEFORE insert and assigns warehouse_id on the row", () => {
    expect(WMS_SRC).toMatch(/routeOrder\(\{/);                 // builds a context, not an id
    expect(WMS_SRC).toMatch(/warehouseId: routedWarehouseId/); // set at insert time
    expect(WMS_SRC).not.toMatch(/routeOrder\(newWmsOrder\.id\)/); // the old broken no-op is gone
  });
});
