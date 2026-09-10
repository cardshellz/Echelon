import { describe, expect, it } from "vitest";
import {
  eligiblePackagingBoxes,
  packagingBrandingAllowed,
  assertSuiteBranding,
  resolveChannelSuite,
} from "../../domain/channel-packaging";
import {
  packingPermission,
  permittedPlanBoxIds,
} from "../../domain/packing-permission";
import {
  saveCatalogBoxSchema,
  saveChannelPackagingSchema,
  type ChannelPackagingPolicy,
} from "@shared/shipping/packaging-policy";

const policy: ChannelPackagingPolicy = {
  channelId: 11,
  revision: 1,
  defaultSuiteId: 1,
  requirement: "unbranded",
  overrides: [{ warehouseId: 2, suiteId: 2 }],
};
const boxes = [
  {
    id: 1,
    isActive: true,
    branding: "unbranded" as const,
    availabilityReviewed: true,
    warehouseIds: [1, 2],
  },
  {
    id: 2,
    isActive: true,
    branding: "branded" as const,
    availabilityReviewed: true,
    warehouseIds: [1],
  },
  {
    id: 3,
    isActive: true,
    branding: "unclassified" as const,
    availabilityReviewed: true,
    warehouseIds: [1],
  },
  {
    id: 4,
    isActive: true,
    branding: "unbranded" as const,
    availabilityReviewed: false,
    warehouseIds: [1],
  },
  {
    id: 5,
    isActive: false,
    branding: "unbranded" as const,
    availabilityReviewed: true,
    warehouseIds: [1],
  },
];
describe("channel packaging authority", () => {
  it("selects one warehouse override without unioning default boxes", () => {
    expect(resolveChannelSuite(policy, 1)).toEqual({
      suiteId: 1,
      source: "default",
    });
    expect(resolveChannelSuite(policy, 2)).toEqual({
      suiteId: 2,
      source: "warehouse",
    });
  });
  it("intersects explicit physical availability and branding permission", () => {
    expect(
      eligiblePackagingBoxes(boxes, 1, "unbranded").map((b) => b.id),
    ).toEqual([1]);
    expect(eligiblePackagingBoxes(boxes, 1, "any").map((b) => b.id)).toEqual([
      1, 2, 3,
    ]);
    expect(eligiblePackagingBoxes(boxes, 2, "any").map((b) => b.id)).toEqual([
      1,
    ]);
    expect(eligiblePackagingBoxes(boxes, 3, "any")).toEqual([]);
    expect(boxes[0].warehouseIds).toEqual([1, 2]);
  });
  it("does not infer white-label branding from unclassified data", () => {
    expect(packagingBrandingAllowed("unbranded", "unclassified")).toBe(false);
    expect(() => assertSuiteBranding("unbranded", boxes)).toThrow(/unbranded/);
    expect(() => assertSuiteBranding("any", boxes)).not.toThrow();
  });
  it.each([0, -1, 1.2, NaN, Infinity])(
    "rejects invalid warehouse %s",
    (warehouse) => {
      expect(() => resolveChannelSuite(policy, warehouse)).toThrow();
    },
  );
  it("rejects duplicate assignments", () => {
    expect(() =>
      resolveChannelSuite(
        { ...policy, overrides: [...policy.overrides, ...policy.overrides] },
        2,
      ),
    ).toThrow(/Conflicting/);
    expect(
      saveChannelPackagingSchema.safeParse({
        ...policy,
        expectedRevision: 0,
        commandId: "e9329d01-6a48-42e3-8ee3-dcebf2c84c4b",
      }).success,
    ).toBe(false);
  });
});

describe("manual packing permissions", () => {
  const snapshot = {
    channelId: 11,
    warehouseId: 1,
    requirement: "unbranded",
    boxes: [{ id: 1 }],
  };
  it("rejects a globally stocked branded box outside the plan", () =>
    expect(packingPermission(snapshot, 1, 2).allowed).toBe(false));
  it("checks the predicted box when no override was entered", () =>
    expect(packingPermission(snapshot, 2, null).allowed).toBe(false));
  it("permits the chosen white-label box", () =>
    expect(packingPermission(snapshot, 1, 1)).toMatchObject({
      allowed: true,
      canonical: true,
      warehouseId: 1,
    }));
  it("does not permit SIOC to bypass white-label packing", () =>
    expect(packingPermission(snapshot, null, null).allowed).toBe(false));
  it("keeps legacy plans confirmable as planned but requires regeneration for substitution", () => {
    expect(packingPermission(null, 1, null).allowed).toBe(true);
    expect(packingPermission(null, 1, 2).allowed).toBe(false);
    expect(permittedPlanBoxIds(null, [1, 1, null])).toEqual([1]);
  });
  it.each([
    { boxes: "all" },
    { channelId: 11, boxes: [{ id: 1 }] },
    { channelId: 11, warehouseId: 1, boxes: [{ id: 1 }] },
  ])("fails closed for malformed snapshot grants %o", (invalid) => {
    expect(permittedPlanBoxIds(invalid, [1])).toEqual([]);
    expect(packingPermission(invalid, 1, null).allowed).toBe(false);
  });
});

describe("catalog command boundary", () => {
  const box = {
    code: "W",
    name: "White",
    kind: "box",
    lengthMm: 100,
    widthMm: 100,
    heightMm: 100,
    tareWeightGrams: 0,
    costCents: 0,
    fillFactorBps: 10000,
    isActive: true,
    branding: "unbranded",
    expectedRevision: 0,
    commandId: "e9329d01-6a48-42e3-8ee3-dcebf2c84c4b",
  };
  it("allows zero cost without warehouse writes", () =>
    expect(saveCatalogBoxSchema.parse(box).costCents).toBe(0));
  it.each([
    { costCents: 0.1 },
    { costCents: -1 },
    { costCents: 2_147_483_648 },
    { warehouseIds: [1, 1] },
    { outerLengthMm: 20 },
    { commandId: undefined },
    { unexpected: true },
  ])("rejects invalid catalog edits %o", (change) => {
    expect(saveCatalogBoxSchema.safeParse({ ...box, ...change }).success).toBe(
      false,
    );
  });
});
