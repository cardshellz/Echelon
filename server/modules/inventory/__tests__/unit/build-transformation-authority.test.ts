import { describe, expect, it, vi } from "vitest";

import { BuildExecutionRepository } from "../../infrastructure/build-execution.repository";
import {
  assertBuildAuthorizationSnapshot,
  type BuildAuthorization,
} from "../../domain/transformation-execution-authority";

const MODEL_HASH = "a".repeat(64);
const RECIPE_HASH = "b".repeat(64);
const AUTHORIZED_AT = new Date("2026-09-13T22:00:00.000Z");

function sqlText(query: any): string {
  if (typeof query === "string") return query;
  if (Array.isArray(query)) return query.map(sqlText).join("");
  if (Array.isArray(query?.value)) return query.value.join("");
  if (Array.isArray(query?.queryChunks)) return query.queryChunks.map(sqlText).join("");
  return "";
}

function authorization(): BuildAuthorization {
  return {
    runtime: { authority: "canonical", revision: "5", activationRunId: "4" },
    productId: 50,
    headRevision: "7",
    modelId: 6,
    modelVersion: 3,
    modelDefinitionHash: MODEL_HASH,
    bindingId: 8,
    bindingDefinitionHash: RECIPE_HASH,
    relationshipRole: "component_build",
    warehouseId: null,
    request: {
      recipeId: 9,
      recipeCode: "ASSEMBLE-P5",
      recipeVersion: 2,
      recipeType: "assembly",
      warehouseId: 1,
      outputProductId: 50,
      outputVariantId: 105,
      outputUnitsPerVariant: 5,
      outputQty: 1,
      components: [{
        componentVariantId: 101,
        componentProductId: 51,
        componentUnitsPerVariant: 1,
        componentQty: 5,
      }],
    },
  };
}

function draftOrder() {
  return {
    id: 91,
    system_number: "BLD-00000091",
    recipe_id: 9,
    recipe_code: "ASSEMBLE-P5",
    recipe_version: 2,
    recipe_type: "assembly",
    output_product_id: 50,
    output_variant_id: 105,
    output_units_per_variant: 5,
    output_qty_per_build: 1,
    planned_builds: 1,
    completed_builds: 0,
    warehouse_id: 1,
    output_location_id: 30,
    status: "draft",
    transformation_authority: null,
  };
}

function component() {
  return {
    id: 92,
    build_order_id: 91,
    recipe_component_id: 93,
    component_variant_id: 101,
    component_product_id: 51,
    component_units_per_variant: 1,
    qty_per_build: 5,
    planned_qty: 5,
    consumed_qty: 0,
    source_location_id: 21,
  };
}

function releasedCanonicalOrder() {
  return {
    ...draftOrder(),
    status: "released",
    transformation_authority: "canonical",
    transformation_authority_revision: "5",
    transformation_activation_run_id: "4",
    transformation_model_head_revision: "7",
    transformation_model_id: 6,
    transformation_model_version: 3,
    transformation_model_definition_hash: MODEL_HASH,
    transformation_recipe_binding_id: 8,
    transformation_recipe_definition_hash: RECIPE_HASH,
    transformation_authorized_at: AUTHORIZED_AT,
    transformation_authorized_by: "operator-1",
  };
}

describe("manual build transformation authority", () => {
  it("pins the active canonical binding before reserving and freezes it on release", async () => {
    const auth = authorization();
    const released = releasedCanonicalOrder();
    const execute = vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("cutover_admission_fence")) return { rows: [{ epoch: "1" }] };
      if (text.includes("quantity_ledger_opening")) return { rows: [] };
      if (text.includes("availability_claim_build_handoffs")) return { rows: [] };
      if (text.includes("SELECT id, status, transformation_authority")) {
        return { rows: [{ id: 91, status: "draft", transformation_authority: null }] };
      }
      if (text.includes("SELECT *") && text.includes("inventory.build_orders")) return { rows: [draftOrder()] };
      if (text.includes("SELECT *") && text.includes("inventory.build_order_components")) return { rows: [component()] };
      if (text.includes("SUM(reserved_qty - consumed_qty - released_qty)")) return { rows: [{ active_qty: 0 }] };
      if (text.includes("SELECT id, variant_qty, reserved_qty") && text.includes("inventory.inventory_levels")) {
        return { rows: [{ id: 11, variant_qty: 5, reserved_qty: 0 }] };
      }
      if (text.includes("SELECT id, qty_on_hand, qty_reserved") && text.includes("inventory.inventory_lots")) {
        return { rows: [{ id: 12, qty_on_hand: 5, qty_reserved: 0 }] };
      }
      if (text.includes("INSERT INTO inventory.inventory_transactions")) {
        return { rows: [{ id: 13, created_at: AUTHORIZED_AT }] };
      }
      if (text.includes("UPDATE inventory.build_orders") && text.includes("transformation_authority = 'canonical'")) {
        return { rows: [released] };
      }
      return { rows: [] };
    });
    const pinBuildOrder = vi.fn(async () => auth);
    const assertBuildSnapshot = vi.fn();
    const transformationAuthority = {
      pinBuildOrder,
      validatePinnedBuildOrder: vi.fn(),
      assertBuildSnapshot,
    } as any;
    const repository = new BuildExecutionRepository({
      execute,
      update: vi.fn(),
      transaction: async (work: any) => work({ execute, update: vi.fn(), transaction: vi.fn() }),
    } as any, {
      loadActiveBuildVariantFacts: vi.fn(async () => new Map([
        [105, { variantId: 105, productId: 50, unitsPerVariant: 5 }],
        [101, { variantId: 101, productId: 51, unitsPerVariant: 1 }],
      ])),
      normalizeBuildLotCosts: vi.fn(),
      buildMillsToRoundedCents: vi.fn(),
      transformationAuthority,
    });

    await expect(repository.releaseOrder(91, "operator-1")).resolves.toEqual(released);

    expect(pinBuildOrder).toHaveBeenCalledOnce();
    expect(assertBuildSnapshot).toHaveBeenCalledWith(auth, auth.request);
    const statements = execute.mock.calls.map(([query]) => sqlText(query));
    const authorityIndex = statements.findIndex((text) => text.includes("SELECT id, status, transformation_authority"));
    const orderLockIndex = statements.findIndex((text) => text.includes("SELECT *") && text.includes("inventory.build_orders"));
    const reserveIndex = statements.findIndex((text) => text.includes("INSERT INTO inventory.build_component_reservations"));
    expect(authorityIndex).toBeGreaterThanOrEqual(0);
    expect(orderLockIndex).toBeGreaterThan(authorityIndex);
    expect(reserveIndex).toBeGreaterThan(orderLockIndex);
    expect(statements.some((text) => text.includes("transformation_recipe_binding_id"))).toBe(true);
  });

  it("replays release from frozen authority without consulting the current active binding", async () => {
    const auth = authorization();
    const released = releasedCanonicalOrder();
    const execute = vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("cutover_admission_fence")) return { rows: [{ epoch: "1" }] };
      if (text.includes("quantity_ledger_opening")) return { rows: [] };
      if (text.includes("availability_claim_build_handoffs")) return { rows: [] };
      if (text.includes("SELECT id, status, transformation_authority")) {
        return { rows: [{ id: 91, status: "released", transformation_authority: "canonical" }] };
      }
      if (text.includes("SELECT *") && text.includes("inventory.build_orders")) return { rows: [released] };
      if (text.includes("SELECT *") && text.includes("inventory.build_order_components")) return { rows: [component()] };
      if (text.includes("SUM(reserved_qty - consumed_qty - released_qty)")) return { rows: [{ active_qty: 5 }] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const validatePinnedBuildOrder = vi.fn(async () => auth);
    const pinBuildOrder = vi.fn();
    const repository = new BuildExecutionRepository({
      execute,
      update: vi.fn(),
      transaction: async (work: any) => work({ execute, update: vi.fn(), transaction: vi.fn() }),
    } as any, {
      loadActiveBuildVariantFacts: vi.fn(async () => new Map([
        [105, { variantId: 105, productId: 50, unitsPerVariant: 5 }],
        [101, { variantId: 101, productId: 51, unitsPerVariant: 1 }],
      ])),
      normalizeBuildLotCosts: vi.fn(),
      buildMillsToRoundedCents: vi.fn(),
      transformationAuthority: {
        pinBuildOrder,
        validatePinnedBuildOrder,
        assertBuildSnapshot: vi.fn(),
      } as any,
    });

    await expect(repository.releaseOrder(91, "operator-1")).resolves.toEqual(released);

    expect(validatePinnedBuildOrder).toHaveBeenCalledOnce();
    expect(pinBuildOrder).not.toHaveBeenCalled();
    const statements = execute.mock.calls.map(([query]) => sqlText(query));
    expect(statements).not.toContain(expect.stringContaining("INSERT INTO inventory.build_component_reservations"));
    expect(statements).not.toContain(expect.stringContaining("UPDATE inventory.build_orders"));
  });

  it("fails a pre-cutover released build closed after canonical activation", async () => {
    const auth = authorization();
    const execute = vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("cutover_admission_fence")) return { rows: [{ epoch: "1" }] };
      if (text.includes("quantity_ledger_opening")) return { rows: [] };
      if (text.includes("availability_claim_build_handoffs")) return { rows: [] };
      if (text.includes("SELECT id, status, transformation_authority")) {
        return { rows: [{ id: 91, status: "released", transformation_authority: null }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new BuildExecutionRepository({
      execute,
      update: vi.fn(),
      transaction: async (work: any) => work({ execute, update: vi.fn(), transaction: vi.fn() }),
    } as any, {
      loadActiveBuildVariantFacts: vi.fn(),
      normalizeBuildLotCosts: vi.fn(),
      buildMillsToRoundedCents: vi.fn(),
      transformationAuthority: {
        pinBuildOrder: vi.fn(async () => auth),
        validatePinnedBuildOrder: vi.fn(),
      } as any,
    });

    await expect(repository.releaseOrder(91, "operator-1")).rejects.toMatchObject({
      code: "BUILD_CANONICAL_AUTHORIZATION_MISSING",
      context: { buildOrderId: 91, status: "released" },
    });
    expect(execute.mock.calls.map(([query]) => sqlText(query)))
      .not.toContain(expect.stringContaining("INSERT INTO inventory.build_component_reservations"));
  });

  it("replays a terminal pre-cutover run without granting new execution authority", async () => {
    const legacyCompleted = { ...draftOrder(), status: "completed", completed_builds: 1 };
    const postedRun = {
      id: 99,
      build_order_id: 91,
      run_number: 1,
      builds_completed: 1,
      output_qty: 1,
      total_component_cost_mills: "625",
      status: "posted",
    };
    const execute = vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("cutover_admission_fence")) return { rows: [{ epoch: "1" }] };
      if (text.includes("quantity_ledger_opening")) return { rows: [{ command_id: "1" }] };
      if (text.includes("SAVEPOINT inventory_quantity_context")
        || text.includes("RELEASE SAVEPOINT inventory_quantity_context")) return { rows: [] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("availability_claim_build_handoffs")) return { rows: [] };
      if (text.includes("FROM inventory.build_runs")) return { rows: [postedRun] };
      if (text.includes("SELECT *") && text.includes("inventory.build_orders")) return { rows: [legacyCompleted] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const validatePinnedBuildOrder = vi.fn();
    const repository = new BuildExecutionRepository({
      execute,
      update: vi.fn(),
      transaction: async (work: any) => work({ execute, update: vi.fn(), transaction: vi.fn() }),
    } as any, {
      loadActiveBuildVariantFacts: vi.fn(),
      normalizeBuildLotCosts: vi.fn(),
      buildMillsToRoundedCents: vi.fn(),
      transformationAuthority: { validatePinnedBuildOrder } as any,
    });

    await expect(repository.executeOrder({
      buildOrderId: 91,
      buildsCompleted: 1,
      idempotencyKey: "build-run:legacy:91:1",
      actorId: "operator-1",
    })).resolves.toMatchObject({ buildOrderId: 91, buildRunId: 99, alreadyPosted: true });

    expect(validatePinnedBuildOrder).not.toHaveBeenCalled();
    const statements = execute.mock.calls.map(([query]) => sqlText(query));
    expect(statements).not.toContain(expect.stringContaining("INSERT INTO inventory.build_runs"));
    expect(statements).not.toContain(expect.stringContaining("UPDATE inventory.build_orders"));
  });

  it("reasserts the frozen binding against the locked order components before execution", async () => {
    const auth = authorization();
    const released = releasedCanonicalOrder();
    const changedComponent = { ...component(), qty_per_build: 4, planned_qty: 4 };
    const execute = vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("cutover_admission_fence")) return { rows: [{ epoch: "1" }] };
      if (text.includes("quantity_ledger_opening")) return { rows: [] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("availability_claim_build_handoffs")) return { rows: [] };
      if (text.includes("FROM inventory.build_runs")) return { rows: [] };
      if (text.includes("SELECT *") && text.includes("inventory.build_orders")) return { rows: [released] };
      if (text.includes("SELECT *") && text.includes("inventory.build_order_components")) {
        return { rows: [changedComponent] };
      }
      if (text.includes("UPDATE inventory.build_orders") && text.includes("failure_code")) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const assertBuildSnapshot = vi.fn(assertBuildAuthorizationSnapshot);
    const repository = new BuildExecutionRepository({
      execute,
      update: vi.fn(),
      transaction: async (work: any) => work({ execute, update: vi.fn(), transaction: vi.fn() }),
    } as any, {
      loadActiveBuildVariantFacts: vi.fn(),
      normalizeBuildLotCosts: vi.fn(),
      buildMillsToRoundedCents: vi.fn(),
      transformationAuthority: {
        validatePinnedBuildOrder: vi.fn(async () => auth),
        assertBuildSnapshot,
      } as any,
    });

    await expect(repository.executeOrder({
      buildOrderId: 91,
      buildsCompleted: 1,
      idempotencyKey: "build-run:canonical:91:1",
      actorId: "operator-1",
    })).rejects.toMatchObject({ code: "BUILD_AUTHORIZATION_SNAPSHOT_CHANGED" });

    expect(assertBuildSnapshot).toHaveBeenCalledOnce();
    expect(assertBuildSnapshot.mock.calls[0]?.[1].components).toEqual([expect.objectContaining({
      componentVariantId: 101,
      componentQty: 4,
    })]);
    const statements = execute.mock.calls.map(([query]) => sqlText(query));
    expect(statements).not.toContain(expect.stringContaining("INSERT INTO inventory.build_runs"));
    expect(statements).not.toContain(expect.stringContaining("INSERT INTO inventory.build_component_reservations"));
  });
});
