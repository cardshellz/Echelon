import { describe, expect, it, vi } from "vitest";
import { BuildUseCases } from "../../application/build.use-cases";

function createSubject() {
  const repository = {
    createRecipe: vi.fn(async (input) => input),
    createOrder: vi.fn(async (input) => input),
    releaseOrder: vi.fn(),
    executeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    reverseRun: vi.fn(),
  };
  const changes = { listAffectedVariantIds: vi.fn(async () => []) };
  const queries = { listProductRelationships: vi.fn(), listRecipes: vi.fn(), listOrders: vi.fn(), getOrder: vi.fn() };
  return {
    subject: new BuildUseCases(repository as any, changes as any, queries as any),
    repository,
    changes,
    queries,
  };
}

describe("BuildUseCases input boundary", () => {
  it("defaults a valid recipe to draft and normalizes its code", async () => {
    const { subject, repository } = createSubject();

    await subject.createRecipe({
      code: " storage-box-5 ",
      name: "Pack five storage boxes",
      recipeType: "conversion",
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
      recipeType: "conversion",
      outputVariantId: 20,
      outputQty: 1,
      components: undefined as any,
      status: "draft",
    })).rejects.toMatchObject({ code: "INVALID_BUILD_INPUT" });
    expect(repository.createRecipe).not.toHaveBeenCalled();
  });

  it("rejects a recipe without an explicit classification", async () => {
    const { subject, repository } = createSubject();

    await expect(subject.createRecipe({
      code: "BOX-5",
      name: "Pack five",
      recipeType: undefined as any,
      outputVariantId: 20,
      outputQty: 1,
      components: [{ componentVariantId: 10, qtyPerBuild: 5 }],
      status: "draft",
    })).rejects.toMatchObject({ code: "INVALID_BUILD_RECIPE_TYPE" });
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
  });

  it("validates and posts an idempotent partial execution command", async () => {
    const { subject, repository, changes } = createSubject();
    const notification = vi.fn();
    subject.onInventoryChange(notification);
    changes.listAffectedVariantIds.mockResolvedValue([10, 20]);
    repository.executeOrder.mockResolvedValue({
      buildOrderId: 7,
      buildRunId: 9,
      runNumber: 2,
      systemNumber: "BLD-7",
      status: "in_progress",
      runStatus: "posted",
      buildsCompleted: 3,
      completedBuilds: 5,
      plannedBuilds: 10,
      outputVariantId: 20,
      outputQty: 3,
      totalComponentCostMills: "1200",
      alreadyPosted: false,
    });

    await subject.executeOrder({
      buildOrderId: 7,
      buildsCompleted: 3,
      idempotencyKey: "build-run-command-9",
      actorId: "user-1",
    });

    expect(repository.executeOrder).toHaveBeenCalledWith({
      buildOrderId: 7,
      buildsCompleted: 3,
      idempotencyKey: "build-run-command-9",
      actorId: "user-1",
    });
    expect(changes.listAffectedVariantIds).toHaveBeenCalledWith(7);
    expect(notification).toHaveBeenCalledTimes(2);
    expect(notification).toHaveBeenCalledWith(10, "build_completed");
    expect(notification).toHaveBeenCalledWith(20, "build_completed");
  });

  it("rejects invalid partial execution input before repository access", async () => {
    const { subject, repository } = createSubject();

    await expect(subject.executeOrder({
      buildOrderId: 7,
      buildsCompleted: 0,
      idempotencyKey: "short",
    })).rejects.toMatchObject({ code: "INVALID_BUILD_INPUT" });
    expect(repository.executeOrder).not.toHaveBeenCalled();
  });

  it("does not repeat inventory notifications for an idempotent run retry", async () => {
    const { subject, repository, changes } = createSubject();
    subject.onInventoryChange(vi.fn());
    repository.executeOrder.mockResolvedValue({
      buildOrderId: 7,
      buildRunId: 9,
      alreadyPosted: true,
    });

    await subject.executeOrder({
      buildOrderId: 7,
      buildsCompleted: 1,
      idempotencyKey: "build-run-command-9",
    } as any);

    expect(changes.listAffectedVariantIds).not.toHaveBeenCalled();
  });

  it("requires a reason when cancelling unfinished build work", async () => {
    const { subject, repository } = createSubject();

    await expect(subject.cancelOrder({
      buildOrderId: 7,
      reason: "   ",
    })).rejects.toMatchObject({ code: "INVALID_BUILD_INPUT" });
    expect(repository.cancelOrder).not.toHaveBeenCalled();
  });

  it("validates a reversal command and notifies affected inventory", async () => {
    const { subject, repository, changes } = createSubject();
    const notification = vi.fn();
    subject.onInventoryChange(notification);
    changes.listAffectedVariantIds.mockResolvedValue([10]);
    repository.reverseRun.mockResolvedValue({
      buildOrderId: 7,
      buildRunId: 9,
      reversalId: 2,
      systemNumber: "BLD-7",
      status: "released",
      restoredComponentQty: 5,
      removedOutputQty: 1,
      alreadyReversed: false,
    });

    await subject.reverseRun({
      buildOrderId: 7,
      buildRunId: 9,
      idempotencyKey: "build-reversal-command-2",
      reason: "Incorrect physical count",
    });

    expect(repository.reverseRun).toHaveBeenCalledWith(expect.objectContaining({
      buildOrderId: 7,
      buildRunId: 9,
      reason: "Incorrect physical count",
    }));
    expect(notification).toHaveBeenCalledWith(10, "build_reversed");
  });

});
