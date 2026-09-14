import { describe, expect, it, vi } from "vitest";

import { BreakAssemblyUseCases } from "../../application/break-assembly.use-cases";

const runtime = Object.freeze({ authority: "canonical" as const, revision: "7", activationRunId: "11" });
const source = {
  id: 125,
  productId: 10,
  sku: "C25",
  name: "Case 25",
  unitsPerVariant: 25,
  hierarchyLevel: 3,
  parentVariantId: null,
};
const destination = {
  id: 105,
  productId: 10,
  sku: "P5",
  name: "Pack 5",
  unitsPerVariant: 5,
  hierarchyLevel: 2,
  parentVariantId: null,
};

function queuedSelectDb(resultSets: unknown[][]) {
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: async () => resultSets.shift() ?? [],
      }),
    })),
  };
}

function authorization() {
  return Object.freeze({
    runtime,
    productId: 10,
    operation: "break_pack" as const,
    headRevision: "0",
    modelId: 501,
    modelVersion: 2,
    modelDefinitionHash: "a".repeat(64),
    pathId: 601,
    inputQty: 2,
    outputQty: 10,
  });
}

describe("canonical manual package-conversion reads", () => {
  it("marks a fractional directed-path batch invalid in preview", async () => {
    const db = queuedSelectDb([[source], [destination]]);
    const authority = {
      readRuntime: vi.fn(async () => runtime),
      authorizePackageConversion: vi.fn(async () => authorization()),
    };
    const service = new BreakAssemblyUseCases(db as any, {} as any, () => new Date(0), authority as any);

    await expect(service.getConversionPreview({
      sourceVariantId: source.id,
      targetVariantId: destination.id,
      qty: 1,
      direction: "break",
    })).resolves.toMatchObject({
      isValid: false,
      sourceQtyToRemove: 1,
      targetQtyToAdd: 5,
      validationError: expect.stringContaining("whole-number repetition"),
    });
  });

  it("lists only the inventory covered by whole active path batches", async () => {
    const db = queuedSelectDb([
      [source, destination],
      [{ productVariantId: source.id, warehouseLocationId: 9, variantQty: 3 }],
    ]);
    const authority = {
      readRuntime: vi.fn(async () => runtime),
      authorizePackageConversion: vi.fn(async () => authorization()),
    };
    const service = new BreakAssemblyUseCases(db as any, {} as any, () => new Date(0), authority as any);

    await expect(service.getBreakableVariants(10, 9)).resolves.toEqual([{
      variant: source,
      currentQty: 3,
      canBreakInto: [{ targetVariant: destination, resultQty: 10 }],
    }]);
  });
});
