import { describe, expect, it } from "vitest";
import { applyProgramCharges } from "../../domain/program-charges";
import { resolvePackagingAssignment } from "../../domain/packaging-assignment";
import {
  NO_PROGRAM_CHARGES,
  programChargesSchema,
  saveBoxSuiteSchema,
} from "@shared/shipping/configuration";

describe("shared program charges", () => {
  const charges = {
    markup: { bps: 100, fixedCents: 0, minCents: null, maxCents: null },
    insurance: { bps: 200, fixedCents: 0, minCents: null, maxCents: null },
  };
  it("preserves the existing 800 + 8 + 16 cent charge", () => {
    expect(applyProgramCharges(800, charges, 1)).toMatchObject({
      baseCents: 800,
      markupCents: 8,
      insuranceCents: 16,
      totalCents: 824,
      revision: 1,
    });
  });
  it("applies percentage, flat amount and caps in the documented order", () => {
    expect(
      applyProgramCharges(
        999,
        {
          markup: { bps: 100, fixedCents: 50, minCents: 60, maxCents: 70 },
          insurance: NO_PROGRAM_CHARGES.insurance,
        },
        2,
      ).totalCents,
    ).toBe(1059);
  });
  it("supports zero and does not mutate configuration", () => {
    const before = JSON.stringify(charges);
    expect(applyProgramCharges(0, charges, 1).totalCents).toBe(0);
    expect(JSON.stringify(charges)).toBe(before);
    expect(
      applyProgramCharges(Number.MAX_SAFE_INTEGER, NO_PROGRAM_CHARGES, 0)
        .totalCents,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe base %s",
    (base) => {
      expect(() => applyProgramCharges(base, charges, 1)).toThrow();
    },
  );
  it("rejects overflow and contradictory bounds", () => {
    expect(() =>
      applyProgramCharges(Number.MAX_SAFE_INTEGER, charges, 1),
    ).toThrow(expect.objectContaining({ code: 'SHIPPING_CHARGE_OVERFLOW' }));
    expect(
      programChargesSchema.safeParse({
        ...charges,
        markup: { ...charges.markup, minCents: 8, maxCents: 7 },
      }).success,
    ).toBe(false);
  });
});
describe("packaging assignment", () => {
  const assignments = [
    {
      channel: "dropship" as const,
      warehouseId: null,
      suiteId: 1,
      revision: 1,
    },
    { channel: "dropship" as const, warehouseId: 2, suiteId: 2, revision: 1 },
    { channel: "shopify" as const, warehouseId: null, suiteId: 3, revision: 1 },
  ];
  it("replaces the default with an exact override, without combining suites", () => {
    expect(resolvePackagingAssignment(assignments, "dropship", 2).suiteId).toBe(
      2,
    );
    expect(resolvePackagingAssignment(assignments, "dropship", 1).suiteId).toBe(
      1,
    );
    expect(resolvePackagingAssignment(assignments, "shopify", 2).suiteId).toBe(
      3,
    );
  });
  it("fails closed for missing or ambiguous assignments", () => {
    expect(() =>
      resolvePackagingAssignment(assignments, "internal", 1),
    ).toThrow("REQUIRED");
    expect(() =>
      resolvePackagingAssignment(
        [...assignments, assignments[0]],
        "dropship",
        1,
      ),
    ).toThrow("AMBIGUOUS");
    expect(() =>
      resolvePackagingAssignment(assignments, "dropship", 0),
    ).toThrow("WAREHOUSE_REQUIRED");
  });
  it("rejects duplicate and empty suite membership", () => {
    const input = {
      name: "Test",
      boxIds: [1, 1],
      expectedRevision: 0,
      commandId: "123e4567-e89b-42d3-a456-426614174000",
    };
    expect(saveBoxSuiteSchema.safeParse(input).success).toBe(false);
    expect(saveBoxSuiteSchema.safeParse({ ...input, boxIds: [] }).success).toBe(
      false,
    );
  });
});
