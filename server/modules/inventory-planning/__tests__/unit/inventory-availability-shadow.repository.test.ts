import { describe, expect, it, vi } from "vitest";

import type {
  AtpProjectionRequestDto,
  PlannerShadowResultDto,
  SupplySnapshotContentDto,
} from "@shared/types/inventory-availability-planner";
import {
  calculateLegacyAtpBaseFromSnapshot,
  calculateLegacyAtpFromSnapshot,
  classifyShadowDifference,
  projectCanonicalAtp,
  sealSupplySnapshot,
} from "../../domain/inventory-availability-planner";
import {
  InventoryAvailabilityShadowRepositoryError,
  PostgresInventoryAvailabilityShadowRepository,
} from "../../infrastructure/inventory-availability-shadow.repository";

const HASH = "a".repeat(64);
const CAPTURED_AT = "2026-08-27T12:00:00.000Z";
const COMPLETED_AT = new Date("2026-08-27T12:00:01.000Z");

describe("Postgres inventory availability shadow repository", () => {
  it("captures physical, authority, safety, and method-specific demand in one read-only snapshot", async () => {
    const client = fakeSnapshotClient();
    const repository = new PostgresInventoryAvailabilityShadowRepository(
      { connect: vi.fn(async () => client) } as never,
    );

    const snapshot = await repository.captureSupplySnapshot(10);

    expect(snapshot).toMatchObject({
      productId: 10,
      legacyInventoryStrategy: "physical_only",
      claimProjectionSource: "inventory_levels.reserved_qty",
      inventoryPositions: [expect.objectContaining({
        variantQty: "7",
        reservedQty: "2",
        pickedQty: "3",
        packedQty: "1",
      })],
      transformationModels: [expect.objectContaining({
        modelId: 501,
        lifecycleSelection: "draft_head",
      })],
      safetyPolicies: [expect.objectContaining({
        scopeKey: "business",
        policyMode: "off",
      })],
    });
    expect(snapshot.demandEvidence.map((entry) => entry.methodVersion)).toEqual([
      "shipments-v1",
      "shipments-v2",
    ]);
    const demandQuery = client.query.mock.calls.find((call) =>
      String(call[0]).includes("FROM inventory.demand_evidence_snapshots"));
    expect(String(demandQuery?.[0])).toContain("evidence.method_version");
    expect(client.query.mock.calls[0]?.[0]).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("captures claim roots and their shared graph in one repeatable-read transaction", async () => {
    const client = fakeSnapshotClient();
    const repository = new PostgresInventoryAvailabilityShadowRepository(
      { connect: vi.fn(async () => client) } as never,
    );

    const snapshot = await repository.captureClaimSupplySnapshot([101]);

    expect(snapshot).toMatchObject({
      schemaVersion: "inventory_availability_claim_snapshot_v1",
      rootProducts: [{ productId: 10, legacyInventoryStrategy: "physical_only" }],
      inventoryPositions: [expect.objectContaining({ productVariantId: 101, variantQty: "7" })],
    });
    expect(client.query.mock.calls[0]?.[0]).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("persists a complete run and its evidence atomically", async () => {
    const fixture = persistenceFixture();
    const client = fakePersistenceClient(fixture, { insertRunId: "99" });
    const repository = new PostgresInventoryAvailabilityShadowRepository(
      { connect: vi.fn(async () => client) } as never,
    );

    const persisted = await repository.persistShadowRun(fixture.input);

    expect(persisted).toMatchObject({
      runId: "99",
      productId: 10,
      requestedBy: "operator-1",
      alreadyApplied: false,
      results: fixture.results,
    });
    expect(client.query.mock.calls.map((call) => String(call[0]).trim())).toEqual(
      expect.arrayContaining(["BEGIN", "COMMIT"]),
    );
    expect(client.query.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO inventory.planner_shadow_runs"))).toBe(true);
    expect(client.query.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO inventory.planner_shadow_results"))).toBe(true);
    expect(client.query.mock.calls.some((call) => String(call[0]) === "ROLLBACK")).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("replays the immutable existing run without inserting duplicate results", async () => {
    const fixture = persistenceFixture();
    const client = fakePersistenceClient(fixture, { insertRunId: null });
    const repository = new PostgresInventoryAvailabilityShadowRepository(
      { connect: vi.fn(async () => client) } as never,
    );

    const persisted = await repository.persistShadowRun(fixture.input);

    expect(persisted.alreadyApplied).toBe(true);
    expect(client.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO inventory.planner_shadow_results"))).toHaveLength(0);
    expect(client.query.mock.calls.some((call) => String(call[0]) === "COMMIT")).toBe(true);
  });

  it("rolls back when an idempotency key belongs to another product", async () => {
    const fixture = persistenceFixture();
    const client = fakePersistenceClient(fixture, {
      insertRunId: null,
      existingProductId: 11,
    });
    const repository = new PostgresInventoryAvailabilityShadowRepository(
      { connect: vi.fn(async () => client) } as never,
    );

    await expect(repository.persistShadowRun(fixture.input)).rejects.toEqual(
      expect.objectContaining<Partial<InventoryAvailabilityShadowRepositoryError>>({
        code: "IDEMPOTENCY_KEY_REUSED",
      }),
    );
    expect(client.query.mock.calls.some((call) => String(call[0]) === "ROLLBACK")).toBe(true);
    expect(client.query.mock.calls.some((call) => String(call[0]) === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

function persistenceFixture() {
  const snapshot = sealSupplySnapshot(content());
  const requests: AtpProjectionRequestDto[] = [
    { targetVariantId: 101, scope: { kind: "network" } },
    { targetVariantId: 101, scope: { kind: "warehouse", warehouseId: 1 } },
  ];
  const results: PlannerShadowResultDto[] = requests.map((request) => {
    const proposedProjection = projectCanonicalAtp(snapshot, request);
    const legacyAtp = calculateLegacyAtpFromSnapshot(snapshot, request);
    return {
      warehouseId: request.scope.kind === "warehouse" ? request.scope.warehouseId : null,
      warehouseCodeSnapshot: request.scope.kind === "warehouse" ? "LEON" : null,
      productVariantId: request.targetVariantId,
      productVariantSkuSnapshot: "EA",
      productVariantNameSnapshot: "Each",
      productVariantUnitsPerVariantSnapshot: 1,
      legacyAtpUnits: legacyAtp.toString(),
      legacyAtpBaseUnits: calculateLegacyAtpBaseFromSnapshot(snapshot, request).toString(),
      proposedAtpUnits: proposedProjection.atpUnits,
      differenceUnits: (BigInt(proposedProjection.atpUnits) - legacyAtp).toString(),
      readinessState: proposedProjection.status,
      classifications: classifyShadowDifference(snapshot, request, legacyAtp, proposedProjection),
      proposedProjection,
    };
  });
  return {
    snapshot,
    results,
    input: {
      snapshot,
      results,
      requestedBy: "operator-1",
      idempotencyKey: "shadow-repository-1",
      completedAt: COMPLETED_AT,
    },
  };
}

function fakePersistenceClient(
  fixture: ReturnType<typeof persistenceFixture>,
  options: { insertRunId: string | null; existingProductId?: number },
) {
  const runId = options.insertRunId ?? "99";
  const query = vi.fn(async (statement: unknown) => {
    const sql = String(statement).trim();
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("INSERT INTO inventory.planner_shadow_runs")) {
      return { rows: options.insertRunId === null ? [] : [{ id: options.insertRunId }] };
    }
    if (sql.includes("INSERT INTO inventory.planner_shadow_results")) return { rows: [] };
    if (sql.includes("FROM inventory.planner_shadow_runs")) {
      return { rows: [{
        id: runId,
        product_id: options.existingProductId ?? fixture.snapshot.productId,
        model_id: 501,
        model_version: 1,
        model_definition_hash: HASH,
        legacy_inventory_strategy: fixture.snapshot.legacyInventoryStrategy,
        status: "completed",
        snapshot_fingerprint: fixture.snapshot.snapshotFingerprint,
        snapshot_payload: fixture.snapshot,
        blocker_codes: [],
        requested_by: "operator-1",
        captured_at: CAPTURED_AT,
        completed_at: COMPLETED_AT.toISOString(),
      }] };
    }
    if (sql.includes("FROM inventory.planner_shadow_results")) {
      return { rows: fixture.results.map((result) => ({
        warehouse_id: result.warehouseId,
        product_variant_id: result.productVariantId,
        legacy_atp_units: result.legacyAtpUnits,
        proposed_atp_units: result.proposedAtpUnits,
        difference_units: result.differenceUnits,
        readiness_state: result.readinessState,
        classifications: result.classifications,
        proposed_projection: result.proposedProjection,
      })) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, release: vi.fn() };
}

function fakeSnapshotClient() {
  const query = vi.fn(async (statement: unknown) => {
    const sql = String(statement).trim();
    if (sql === "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("transaction_timestamp() AS captured_at")) {
      return { rows: [{ captured_at: CAPTURED_AT }] };
    }
    if (sql.includes("FROM catalog.products") && !sql.includes("JOIN")) {
      return { rows: [{ id: 10, inventory_strategy: "physical_only" }] };
    }
    if (sql.includes("FROM inventory.transformation_model_heads")) {
      return { rows: [{
        product_id: 10,
        draft_model_id: 501,
        active_model_id: null,
        model_id: 501,
        version: 1,
        lifecycle_status: "draft",
        build_to_promise_enabled: false,
        definition_hash: HASH,
        validation_state: "valid",
        validation_errors: [],
      }] };
    }
    if (sql.includes("FROM inventory.transformation_model_paths")) return { rows: [] };
    if (sql.includes("FROM inventory.transformation_recipe_bindings")) return { rows: [] };
    if (sql.includes("FROM inventory.build_recipes")) return { rows: [] };
    if (sql.includes("FROM catalog.product_variants")) {
      return { rows: [{
        id: 101,
        product_id: 10,
        sku: "EA",
        name: "Each",
        units_per_variant: 1,
        is_active: true,
      }] };
    }
    if (sql.includes("FROM warehouse.warehouses")) {
      return { rows: [{ id: 1, code: "LEON", is_active: true, hub_warehouse_id: null }] };
    }
    if (sql.includes("FROM inventory.inventory_levels")) {
      return { rows: [{
        id: 1,
        warehouse_location_id: 11,
        product_variant_id: 101,
        variant_qty: "7",
        reserved_qty: "2",
        picked_qty: "3",
        packed_qty: "1",
      }] };
    }
    if (sql.includes("FROM warehouse.product_locations")) {
      return { rows: [{ product_variant_id: 101, warehouse_id: 1, warehouse_location_id: 11 }] };
    }
    if (sql.includes("FROM warehouse.warehouse_locations AS location")) {
      return { rows: [{
        id: 11,
        warehouse_id: 1,
        code: "PICK-1",
        location_type: "pick",
        is_pickable: true,
        is_active: true,
        cycle_count_freeze_id: null,
        draft_policy_id: null,
        policy_id: null,
      }] };
    }
    if (sql.includes("FROM inventory.promise_safety_policy_heads")) {
      return { rows: [{
        draft_policy_id: 1,
        policy_id: 1,
        version: 1,
        scope_key: "business",
        scope_type: "business",
        product_variant_id: null,
        warehouse_id: null,
        policy_mode: "off",
        fixed_units: null,
        days_of_cover_milli_days: null,
        untrusted_demand_fallback_units: null,
        demand_method_version: null,
        definition_hash: HASH,
      }] };
    }
    if (sql.includes("FROM inventory.demand_evidence_snapshots")) {
      return { rows: ["shipments-v1", "shipments-v2"].map((methodVersion, index) => ({
        id: String(index + 1),
        product_variant_id: 101,
        warehouse_id: 1,
        daily_demand_milli_units: "1000",
        trust_status: "trusted",
        trust_reasons: [],
        method_version: methodVersion,
        input_fingerprint: HASH,
        override_expires_at: null,
        calculated_at: "2026-08-27T11:00:00.000Z",
      })) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, release: vi.fn() };
}

function content(): SupplySnapshotContentDto {
  return {
    schemaVersion: "inventory_availability_snapshot_v1",
    capturedAt: CAPTURED_AT,
    productId: 10,
    legacyInventoryStrategy: "physical_only",
    variants: [
      { id: 101, productId: 10, sku: "EA", name: "Each", unitsPerVariant: 1, isActive: true },
    ],
    warehouses: [{ id: 1, code: "LEON", isActive: true, hubWarehouseId: null }],
    locations: [{
      id: 11,
      warehouseId: 1,
      code: "PICK-1",
      locationType: "pick",
      isPickable: true,
      isActive: true,
      isFrozen: false,
      promisePolicy: null,
    }],
    inventoryPositions: [{
      inventoryLevelId: 1,
      warehouseLocationId: 11,
      productVariantId: 101,
      variantQty: "7",
      reservedQty: "0",
      pickedQty: "0",
      packedQty: "0",
    }],
    safetyPolicies: [{
      policyId: 1,
      version: 1,
      lifecycleSelection: "draft_head",
      scopeKey: "business",
      scopeType: "business",
      productVariantId: null,
      warehouseId: null,
      policyMode: "off",
      fixedUnits: null,
      daysOfCoverMilliDays: null,
      untrustedDemandFallbackUnits: null,
      demandMethodVersion: null,
      definitionHash: HASH,
    }],
    demandEvidence: [],
    transformationModels: [{
      modelId: 501,
      productId: 10,
      version: 1,
      lifecycleSelection: "draft_head",
      lifecycleStatus: "draft",
      buildToPromiseEnabled: false,
      definitionHash: HASH,
      validationState: "valid",
      validationErrors: [],
      paths: [],
      recipeBindings: [],
    }],
    legacyRecipes: [],
    outputLocations: [{ productVariantId: 101, warehouseId: 1, warehouseLocationId: 11 }],
    claimProjectionSource: "inventory_levels.reserved_qty",
  };
}
