import { describe, expect, it } from "vitest";
import {
  bulkBoxBrandingSchema,
  warehouseAvailabilitySchema,
  warehouseSuiteAssignmentSchema,
} from "@shared/shipping/packaging-policy";
import { planWarehouseSuiteAssignment } from "../../domain/warehouse-suite-assignment";
const commandId = "123e4567-e89b-42d3-a456-426614174000";
describe("warehouse packaging command contracts", () => {
  it("plans deterministic selected-warehouse changes without mutating input", () => {
    const current = Object.freeze([
      Object.freeze({ warehouseId: 2, suiteId: 20 }),
      Object.freeze({ warehouseId: 1, suiteId: 10 }),
    ]);
    expect(
      planWarehouseSuiteAssignment(current, {
        warehouseIds: [3, 2],
        suiteId: 30,
        replaceExisting: false,
      }),
    ).toEqual({
      changed: 1,
      skipped: 1,
      overrides: [
        { warehouseId: 1, suiteId: 10 },
        { warehouseId: 2, suiteId: 20 },
        { warehouseId: 3, suiteId: 30 },
      ],
    });
    expect(
      planWarehouseSuiteAssignment(current, {
        warehouseIds: [2],
        suiteId: null,
        replaceExisting: true,
      }),
    ).toEqual({
      changed: 1,
      skipped: 0,
      overrides: [{ warehouseId: 1, suiteId: 10 }],
    });
    expect(
      planWarehouseSuiteAssignment(current, {
        warehouseIds: [2],
        suiteId: 20,
        replaceExisting: true,
      }).changed,
    ).toBe(0);
    expect(current).toEqual([
      { warehouseId: 2, suiteId: 20 },
      { warehouseId: 1, suiteId: 10 },
    ]);
  });
  const availability = {
    commandId,
    warehouses: [{ id: 1, revision: 0 }],
    boxIds: [1],
    available: true,
  };
  it.each([
    { warehouses: [] },
    { boxIds: [] },
    { boxIds: [1, 1] },
    { boxIds: [0] },
    {
      warehouses: [
        { id: 1, revision: 0 },
        { id: 1, revision: 1 },
      ],
    },
    { warehouses: [{ id: 1, revision: -1 }] },
    { available: "true" },
    { commandId: "bad" },
    { extra: true },
  ])("rejects malformed availability %o", (change) =>
    expect(
      warehouseAvailabilitySchema.safeParse({ ...availability, ...change })
        .success,
    ).toBe(false),
  );
  it("bounds bulk work and accepts 100 warehouses", () => {
    const warehouses = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      revision: 0,
    }));
    expect(
      warehouseAvailabilitySchema.safeParse({ ...availability, warehouses })
        .success,
    ).toBe(true);
    expect(
      warehouseAvailabilitySchema.safeParse({
        ...availability,
        warehouses: [...warehouses, { id: 101, revision: 0 }],
        boxIds: Array.from({ length: 1000 }, (_, i) => i + 1),
      }).success,
    ).toBe(false);
  });
  it("requires explicit exception replacement and strict branding classification", () => {
    expect(
      warehouseSuiteAssignmentSchema.safeParse({
        commandId,
        channelId: 1,
        expectedRevision: 1,
        warehouseIds: [1],
        suiteId: null,
      }).success,
    ).toBe(false);
    expect(
      bulkBoxBrandingSchema.safeParse({
        commandId,
        boxes: [{ id: 1, revision: 1 }],
        branding: "white",
      }).success,
    ).toBe(false);
    expect(
      bulkBoxBrandingSchema.parse({
        commandId,
        boxes: [{ id: 1, revision: 1 }],
        branding: "unbranded",
      }).boxes,
    ).toHaveLength(1);
  });
});
