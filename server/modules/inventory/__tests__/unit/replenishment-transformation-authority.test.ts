import { describe, expect, it, vi } from "vitest";

import { ReplenishmentUseCases } from "../../application/replenishment.use-cases";
import { TransformationExecutionAuthorityError } from "../../domain/transformation-execution-authority";

const runtime = Object.freeze({ authority: "canonical" as const, revision: "7", activationRunId: "11" });
const source = {
  id: 125,
  productId: 10,
  sku: "C25",
  name: "Case 25",
  unitsPerVariant: 25,
  hierarchyLevel: 3,
  isActive: true,
};
const pick = {
  id: 105,
  productId: 10,
  sku: "P5",
  name: "Pack 5",
  unitsPerVariant: 5,
  hierarchyLevel: 2,
  isActive: true,
};

function queuedSelectDb(rows: unknown[][]) {
  return {
    insert: vi.fn(),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => rows.shift() ?? [],
        }),
      }),
    })),
  };
}

function authorization(inputQty = 1, outputQty = 5) {
  return Object.freeze({
    runtime,
    productId: 10,
    operation: "break_pack" as const,
    headRevision: "0",
    modelId: 501,
    modelVersion: 2,
    modelDefinitionHash: "a".repeat(64),
    pathId: 601,
    inputQty,
    outputQty,
  });
}

describe("canonical replenishment transformation authority", () => {
  it("does not select a configured cross-variant source without the exact directed path", async () => {
    const db = queuedSelectDb([[source]]);
    const authority = {
      readRuntime: vi.fn(async () => runtime),
      authorizePackageConversion: vi.fn(async () => {
        throw new TransformationExecutionAuthorityError(
          "PACKAGE_CONVERSION_PATH_NOT_ALLOWED",
          "No exact path",
        );
      }),
    };
    const service = new ReplenishmentUseCases(db as any, {} as any, () => new Date(0), authority as any);
    const findSourceLocation = vi.spyOn(service as any, "findSourceLocation");

    const result = await (service as any).resolveReplenSourceForNeed({
      tag: "test",
      pickVariant: pick,
      pickVariantId: pick.id,
      warehouseId: 1,
      parentLocationId: null,
      sourceLocationType: "reserve",
      sourcePriority: "fifo",
      sourceHierarchyLevel: 3,
      qtyNeeded: 25,
      configuredSourceVariantId: source.id,
      replenMethod: "full_case",
    });

    expect(result).toMatchObject({
      sourceLocation: null,
      resolvedSourceVariantId: source.id,
      sourceResolutionIssue: { reason: "no_source_variant" },
      conversionAuthorization: null,
    });
    expect(authority.authorizePackageConversion).toHaveBeenCalledWith(expect.objectContaining({
      operation: "break_pack",
      source: expect.objectContaining({ variantId: source.id }),
      destination: expect.objectContaining({ variantId: pick.id }),
    }), runtime);
    expect(findSourceLocation).not.toHaveBeenCalled();
  });

  it("rejects execution quantities that are only a fractional repetition of the active path", async () => {
    const db = queuedSelectDb([[source], [pick]]);
    const authority = {
      authorizePackageConversion: vi.fn(async () => authorization(2, 10)),
    };
    const service = new ReplenishmentUseCases(db as any, {} as any, () => new Date(0), authority as any);
    const task = {
      id: 901,
      replenMethod: "case_break",
      replenRuleId: null,
      sourceProductVariantId: source.id,
      pickProductVariantId: pick.id,
      qtySourceUnits: 1,
      qtyTargetUnits: 25,
    };

    await expect((service as any).planCanonicalTaskExecution(task, runtime))
      .rejects.toMatchObject({ code: "PACKAGE_CONVERSION_QUANTITY_NOT_AUTHORIZED" });
    expect(authority.authorizePackageConversion).toHaveBeenCalledOnce();
  });

  it("does not create a cascade when either directed edge is not explicitly authorized", async () => {
    const grandparent = {
      id: 225,
      productId: 10,
      sku: "C125",
      name: "Case 125",
      unitsPerVariant: 125,
      hierarchyLevel: 4,
      isActive: true,
    };
    const db = queuedSelectDb([[source], [grandparent], [pick]]);
    const authority = {
      readRuntime: vi.fn(async () => runtime),
      authorizePackageConversion: vi.fn()
        .mockResolvedValueOnce(authorization())
        .mockRejectedValueOnce(new TransformationExecutionAuthorityError(
          "PACKAGE_CONVERSION_PATH_NOT_ALLOWED",
          "No exact downstream path",
        )),
    };
    const service = new ReplenishmentUseCases(db as any, {} as any, () => new Date(0), authority as any);
    vi.spyOn(service as any, "findTierDefaultForVariant").mockResolvedValue({
      sourceHierarchyLevel: grandparent.hierarchyLevel,
      sourceLocationType: "reserve",
      replenMethod: "case_break",
      autoReplen: 0,
      priority: 5,
    });
    const findSourceLocation = vi.spyOn(service as any, "findSourceLocation");

    const result = await (service as any).tryCascadeReplen({
      sourceVariantId: source.id,
      pickVariantId: pick.id,
      pickLocationId: 900,
      warehouseId: 1,
      sourceLocationType: "reserve",
      sourcePriority: "fifo",
      ruleId: null,
      productId: 10,
      replenMethod: "case_break",
      whSettings: null,
      taskNotes: "test",
      triggeredBy: "test",
      priority: 5,
      autoReplen: 0,
    });

    expect(result).toBeNull();
    expect(authority.authorizePackageConversion).toHaveBeenNthCalledWith(1, expect.objectContaining({
      source: expect.objectContaining({ variantId: grandparent.id }),
      destination: expect.objectContaining({ variantId: source.id }),
    }), runtime);
    expect(authority.authorizePackageConversion).toHaveBeenNthCalledWith(2, expect.objectContaining({
      source: expect.objectContaining({ variantId: source.id }),
      destination: expect.objectContaining({ variantId: pick.id }),
    }), runtime);
    expect(findSourceLocation).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
