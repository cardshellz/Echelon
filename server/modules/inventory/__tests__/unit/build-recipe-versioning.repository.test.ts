import { describe, expect, it, vi } from "vitest";
import { BuildRepository, type UpdateBuildRecipeInput } from "../../infrastructure/build.repository";

const NOW = new Date("2026-08-24T14:30:00.000Z");

function command(overrides: Partial<UpdateBuildRecipeInput> = {}): UpdateBuildRecipeInput {
  return {
    recipeId: 41,
    expectedVersion: 1,
    name: "Assemble box",
    status: "active",
    recipeType: "assembly",
    outputVariantId: 300,
    outputQty: 1,
    notes: "Use one of each component.",
    components: [
      { componentVariantId: 101, qtyPerBuild: 1 },
      { componentVariantId: 102, qtyPerBuild: 1 },
    ],
    changeReason: "Supplier changed the component specification.",
    idempotencyKey: "recipe-edit-command-41",
    changeRequestHash: "a".repeat(64),
    actorId: "admin-42",
    changedAt: NOW,
    ...overrides,
  };
}

describe("BuildRepository recipe versioning", () => {
  it("commits the successor definition and immutable audit event in one transaction", async () => {
    const current = {
      id: 41,
      code: "QUAD-BOX-EA",
      name: "Assemble old box",
      version: 1,
      status: "active",
      recipe_type: "assembly",
      output_variant_id: 300,
      output_product_id: 30,
      output_units_per_variant: 1,
      output_qty: 1,
      notes: null,
    };
    const successor = {
      ...current,
      id: 42,
      name: "Assemble box",
      version: 2,
      status: "active",
      notes: "Use one of each component.",
      supersedes_recipe_id: 41,
      change_reason: "Supplier changed the component specification.",
      change_idempotency_key: "recipe-edit-command-41",
      change_request_hash: "a".repeat(64),
    };
    const results = [
      { rows: [] },
      { rows: [] },
      { rows: [current] },
      { rows: [{ id: 41, version: 1, status: "active" }] },
      { rows: [
        { component_variant_id: 101, component_product_id: 11, component_units_per_variant: 1, qty: 1 },
        { component_variant_id: 102, component_product_id: 12, component_units_per_variant: 1, qty: 1 },
      ] },
      { rows: [
        { id: 300, is_active: true, product_id: 30, units_per_variant: 1 },
        { id: 101, is_active: true, product_id: 11, units_per_variant: 1 },
        { id: 102, is_active: true, product_id: 12, units_per_variant: 1 },
      ] },
      { rows: [{ id: 30, inventory_strategy: "recipe_managed" }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [successor] },
      { rows: [] },
      { rows: [] },
    ];
    const execute = vi.fn(async () => {
      const next = results.shift();
      if (!next) throw new Error("Unexpected repository query");
      return next;
    });
    const auditValues = vi.fn(async () => undefined);
    const tx = {
      execute,
      update: vi.fn(),
      insert: vi.fn(() => ({ values: auditValues })),
      transaction: vi.fn(),
    };
    const db = {
      ...tx,
      transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const repository = new BuildRepository(db as any);

    const result = await repository.updateRecipe(command());

    expect(result).toMatchObject({
      id: 42,
      version: 2,
      alreadyApplied: false,
      previousOutputVariantId: 300,
    });
    expect(results).toHaveLength(0);
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      actor: "admin-42",
      action: "inventory.build_recipe.version_created",
      target: "inventory.build_recipe:QUAD-BOX-EA",
      changes: expect.objectContaining({
        before: expect.objectContaining({ recipeId: 41, version: 1 }),
        after: expect.objectContaining({ recipeId: 42, version: 2 }),
      }),
      context: expect.objectContaining({
        changeReason: "Supplier changed the component specification.",
        sourceRecipeId: 41,
        newRecipeId: 42,
      }),
    }));
  });

  it("rejects a stale editor before definition or audit writes", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 41, code: "QUAD-BOX-EA", version: 1, status: "active" }] })
      .mockResolvedValueOnce({ rows: [{ id: 42, version: 2, status: "active" }] });
    const auditValues = vi.fn();
    const tx = {
      execute,
      update: vi.fn(),
      insert: vi.fn(() => ({ values: auditValues })),
      transaction: vi.fn(),
    };
    const db = {
      ...tx,
      transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const repository = new BuildRepository(db as any);

    await expect(repository.updateRecipe(command())).rejects.toMatchObject({
      code: "BUILD_RECIPE_VERSION_CONFLICT",
    });
    expect(execute).toHaveBeenCalledTimes(4);
    expect(auditValues).not.toHaveBeenCalled();
  });

  it("rejects idempotency-key reuse for a different edit payload", async () => {
    const persisted = {
      id: 42,
      code: "QUAD-BOX-EA",
      version: 2,
      output_variant_id: 300,
      change_idempotency_key: "recipe-edit-command-41",
      change_request_hash: "b".repeat(64),
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [persisted] });
    const auditValues = vi.fn();
    const tx = {
      execute,
      update: vi.fn(),
      insert: vi.fn(() => ({ values: auditValues })),
      transaction: vi.fn(),
    };
    const db = {
      ...tx,
      transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const repository = new BuildRepository(db as any);

    await expect(repository.updateRecipe(command())).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(auditValues).not.toHaveBeenCalled();
  });
  it("returns an identical idempotent retry without creating another version", async () => {
    const persisted = {
      id: 42,
      code: "QUAD-BOX-EA",
      version: 2,
      output_variant_id: 300,
      change_idempotency_key: "recipe-edit-command-41",
      change_request_hash: "a".repeat(64),
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [persisted] });
    const auditValues = vi.fn();
    const tx = {
      execute,
      update: vi.fn(),
      insert: vi.fn(() => ({ values: auditValues })),
      transaction: vi.fn(),
    };
    const db = {
      ...tx,
      transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const repository = new BuildRepository(db as any);

    await expect(repository.updateRecipe(command())).resolves.toMatchObject({
      id: 42,
      version: 2,
      alreadyApplied: true,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(auditValues).not.toHaveBeenCalled();
  });
});
