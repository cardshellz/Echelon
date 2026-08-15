import { describe, expect, it, vi } from "vitest";
import { BuildUseCases } from "../../application/build.use-cases";

function createSubject() {
  const repository = {
    createRecipe: vi.fn(async (input) => input),
    createOrder: vi.fn(async (input) => input),
    releaseOrder: vi.fn(),
    executeOrder: vi.fn(),
  };
  const changes = { listAffectedVariantIds: vi.fn(async () => []) };
  const queries = { listProductRelationships: vi.fn(), listRecipes: vi.fn(), listOrders: vi.fn(), getOrder: vi.fn() };
  return {
    subject: new BuildUseCases(repository as any, changes as any, queries as any),
    repository,
    queries,
  };
}

describe("BuildUseCases input boundary", () => {
  it("defaults a valid recipe to draft and normalizes its code", async () => {
    const { subject, repository } = createSubject();

    await subject.createRecipe({
      code: " storage-box-5 ",
      name: "Pack five storage boxes",
      outputVariantId: 20,
      outputQty: 1,
      components: [{ componentVariantId: 10, qtyPerBuild: 5 }],
      status: undefined as any,
    });

    expect(repository.createRecipe).toHaveBeenCalledWith(expect.objectContaining({
      code: "STORAGE-BOX-5",
      status: "draft",
    }));
  });

  it("classifies missing component input instead of leaking a TypeError", async () => {
    const { subject, repository } = createSubject();

    await expect(subject.createRecipe({
      code: "BOX-5",
      name: "Pack five",
      outputVariantId: 20,
      outputQty: 1,
      components: undefined as any,
      status: "draft",
    })).rejects.toMatchObject({ code: "INVALID_BUILD_INPUT" });
    expect(repository.createRecipe).not.toHaveBeenCalled();
  });

  it("classifies missing source locations before repository access", async () => {
    const { subject, repository } = createSubject();

    await expect(subject.createOrder({
      recipeId: 1,
      plannedBuilds: 10,
      warehouseId: 1,
      outputLocationId: 2,
      sourceLocations: undefined as any,
      idempotencyKey: "build-command-1",
    })).rejects.toMatchObject({ code: "INVALID_BUILD_INPUT" });
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

  it("validates and delegates product relationship queries", async () => {
    const { subject, queries } = createSubject();
    queries.listProductRelationships.mockResolvedValue([{ variantId: 11 }]);

    await expect(subject.listProductRelationships(42)).resolves.toEqual([{ variantId: 11 }]);
    expect(queries.listProductRelationships).toHaveBeenCalledWith(42);
  });

  it("rejects invalid product relationship identifiers", async () => {
    const { subject, queries } = createSubject();

    await expect(subject.listProductRelationships(Number.NaN)).rejects.toMatchObject({
      code: "INVALID_BUILD_INPUT",
    });
    expect(queries.listProductRelationships).not.toHaveBeenCalled();
  });});
