import { describe, expect, it } from "vitest";
import {
  deriveWmsPickingProgress,
  pickingReadinessBlockers,
  type WmsPickingProgressLine,
} from "@shared/wms-picking-progress";
import { selectPickingSource } from "@shared/picking-source-plan";

const line: WmsPickingProgressLine = {
  id: 1,
  sku: "P10",
  quantity: 2,
  pickedQuantity: 2,
  requiresShipping: true,
  onHold: false,
  status: "completed",
  inventoryTracking: true,
  catalogProductId: 1,
  location: "A1",
};
const project = (
  lines: WmsPickingProgressLine[],
  currentStatus = "in_progress",
  additionalBlockers: string[] = [],
) =>
  deriveWmsPickingProgress({
    currentStatus,
    postPickStatus: "ready_to_ship",
    lines,
    additionalBlockers,
  });

describe("operation-owned WMS picking progress", () => {
  it("requires exact physical progress and bin evidence", () => {
    expect(project([line])).toMatchObject({
      status: "ready_to_ship",
      pickedCount: 2,
      completeNonShipping: true,
    });
    expect(project([{ ...line, pickedQuantity: 1 }]).status).toBe("exception");
    expect(project([{ ...line, location: "UNASSIGNED" }]).status).toBe(
      "exception",
    );
    expect(project([{ ...line, status: "short" }]).status).toBe("exception");
  });
  it("exempts only catalog-linked untracked confirmations from bin evidence", () => {
    expect(
      project([{ ...line, location: "U", inventoryTracking: false }]).status,
    ).toBe("ready_to_ship");
    expect(
      project([
        {
          ...line,
          location: "U",
          inventoryTracking: false,
          catalogProductId: null,
        },
      ]).status,
    ).toBe("exception");
  });
  it("includes active shipment blockers and excludes held/cancelled demand", () => {
    expect(project([line], "in_progress", ["replen task blocked"]).status).toBe(
      "exception",
    );
    expect(
      project([
        line,
        { ...line, id: 2, onHold: true, status: "pending", pickedQuantity: 0 },
      ]).status,
    ).toBe("ready_to_ship");
    expect(
      pickingReadinessBlockers([{ ...line, status: "cancelled" }]),
    ).toEqual(["order has no shippable items"]);
  });
  it.each([
    "shipped",
    "partially_shipped",
    "cancelled",
    "completed",
    "on_hold",
    "awaiting_3pl",
  ])("preserves %s custody/lifecycle state", (status) => {
    expect(
      project([{ ...line, pickedQuantity: 0, status: "pending" }], status)
        .status,
    ).toBe(status);
  });
  it("rejects duplicate line identities, invalid quantities and aggregate overflow", () => {
    expect(() => project([line, line])).toThrow("Duplicate");
    expect(() => project([{ ...line, pickedQuantity: -1 }])).toThrow();
    expect(() =>
      project([
        { ...line, quantity: 2_147_483_647 },
        { ...line, id: 2 },
      ]),
    ).toThrow();
  });
});

const location = (id: number, warehouseId: number | null = 1) => ({
  id,
  warehouseId,
  code: "A1",
  isPickable: 1,
  isActive: 1,
  cycleCountFreezeId: null,
  locationType: "pick",
});
describe("one picking source selector", () => {
  it("retains the assigned source even when another bin has more stock", () => {
    const locations = [location(1), { ...location(2), code: "B1" }];
    expect(
      selectPickingSource({
        assignedCode: "A1",
        warehouseId: 1,
        quantity: 5,
        locations,
        levels: [
          { warehouseLocationId: 1, variantQty: 0 },
          { warehouseLocationId: 2, variantQty: 100 },
        ],
      }).id,
    ).toBe(1);
  });
  it("disambiguates identical codes with the exact warehouse and refuses ambiguity without it", () => {
    const locations = [location(1, 1), location(2, 2)];
    expect(
      selectPickingSource({
        assignedCode: "A1",
        warehouseId: 2,
        quantity: 1,
        locations,
        levels: [],
      }).id,
    ).toBe(2);
    expect(() =>
      selectPickingSource({
        assignedCode: "A1",
        warehouseId: null,
        quantity: 1,
        locations,
        levels: [],
      }),
    ).toThrow("exact warehouse");
  });
  it("rejects stale source IDs, inactive/frozen/wrong-warehouse sources", () => {
    const input = {
      assignedCode: "A1",
      warehouseId: 1,
      quantity: 1,
      levels: [],
    };
    expect(() =>
      selectPickingSource({
        ...input,
        explicitLocationId: 2,
        locations: [location(1), { ...location(2), code: "B1" }],
      }),
    ).toThrow("differs");
    for (const invalid of [
      { ...location(1), isActive: 0 },
      { ...location(1), cycleCountFreezeId: 1 },
      location(1, 2),
    ])
      expect(() =>
        selectPickingSource({ ...input, locations: [invalid] }),
      ).toThrow("No active");
  });
  it("selects capacity only for an unassigned line, with deterministic priority/ties", () => {
    expect(
      selectPickingSource({
        assignedCode: "U",
        warehouseId: 1,
        quantity: 5,
        locations: [
          location(3),
          location(2),
          { ...location(1), locationType: "pallet" },
        ],
        levels: [1, 2, 3].map((id) => ({
          warehouseLocationId: id,
          variantQty: 5,
        })),
      }).id,
    ).toBe(2);
  });
});
