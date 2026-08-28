import { describe, expect, it, vi } from "vitest";

import type { ClaimSupplySnapshotContentDto } from "@shared/types/inventory-availability-planner";
import {
  planCanonicalClaim,
  sealClaimSupplySnapshot,
} from "../../domain/inventory-availability-planner";
import {
  InventoryAvailabilityClaimSimulationRepositoryError,
  PostgresInventoryAvailabilityClaimSimulationRepository,
} from "../../infrastructure/inventory-availability-claim-simulation.repository";

const HASH = "a".repeat(64);
const COMPLETED_AT = new Date("2026-08-28T19:00:01.000Z");

describe("Postgres inventory availability claim-simulation repository", () => {
  it("persists immutable simulation evidence without operational inventory writes", async () => {
    const input = fixture();
    const client = fakeClient(input, { insertedId: "21" });
    const repository = new PostgresInventoryAvailabilityClaimSimulationRepository(
      { connect: vi.fn(async () => client) } as never,
    );

    const result = await repository.persistClaimSimulation(input);

    expect(result).toMatchObject({
      simulationRunId: "21",
      operationalWriteAttempted: false,
      legacyLivePathRetained: true,
      alreadyApplied: false,
    });
    const statements = client.query.mock.calls.map((call) => String(call[0]));
    expect(statements.some((sql) => /UPDATE\s+inventory\.inventory_levels/i.test(sql))).toBe(false);
    expect(statements.some((sql) => /INSERT\s+INTO\s+inventory\.inventory_transactions/i.test(sql))).toBe(false);
    expect(statements).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
  });

  it("rejects reuse of an idempotency key for a different request hash", async () => {
    const input = fixture();
    const client = fakeClient(input, { insertedId: null, storedRequestHash: "b".repeat(64) });
    const repository = new PostgresInventoryAvailabilityClaimSimulationRepository(
      { connect: vi.fn(async () => client) } as never,
    );

    await expect(repository.persistClaimSimulation(input)).rejects.toEqual(
      expect.objectContaining<Partial<InventoryAvailabilityClaimSimulationRepositoryError>>({
        code: "IDEMPOTENCY_KEY_REUSED",
      }),
    );
    expect(client.query.mock.calls.some((call) => String(call[0]) === "ROLLBACK")).toBe(true);
  });
});

function fixture() {
  const snapshot = sealClaimSupplySnapshot(content());
  const claim = {
    requestKey: "order:repository-1",
    scope: { kind: "warehouse" as const, warehouseId: 1 },
    lines: [{ lineKey: "line:1", targetVariantId: 101, requestedQty: "2" }],
  };
  return {
    snapshot,
    claim,
    plan: planCanonicalClaim(snapshot, claim),
    requestHash: HASH,
    idempotencyKey: "claim-repository-1",
    reason: "Persist simulation evidence",
    requestedBy: "operator-1",
    completedAt: COMPLETED_AT,
  };
}

function fakeClient(
  input: ReturnType<typeof fixture>,
  options: { insertedId: string | null; storedRequestHash?: string },
) {
  const query = vi.fn(async (statement: unknown) => {
    const sql = String(statement).trim();
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("INSERT INTO inventory.planner_claim_simulation_runs")) {
      return { rows: options.insertedId === null ? [] : [{ id: options.insertedId }] };
    }
    if (sql.includes("FROM inventory.planner_claim_simulation_runs")) return { rows: [{
      id: options.insertedId ?? "21",
      request_hash: options.storedRequestHash ?? input.requestHash,
      request_payload: input.claim,
      plan_payload: input.plan,
      requested_by: input.requestedBy,
      reason: input.reason,
      captured_at: input.snapshot.capturedAt,
      completed_at: input.completedAt,
    }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, release: vi.fn() };
}

function content(): ClaimSupplySnapshotContentDto {
  return {
    schemaVersion: "inventory_availability_claim_snapshot_v1",
    capturedAt: "2026-08-28T19:00:00.000Z",
    rootProducts: [{ productId: 10, legacyInventoryStrategy: "physical_only" }],
    variants: [{ id: 101, productId: 10, sku: "EA", name: "Each", unitsPerVariant: 1, isActive: true }],
    warehouses: [{ id: 1, code: "LEON", isActive: true, hubWarehouseId: null }],
    locations: [{
      id: 11, warehouseId: 1, code: "PICK", locationType: "pick", isPickable: true,
      isActive: true, isFrozen: false, promisePolicy: null,
    }],
    inventoryPositions: [{
      inventoryLevelId: 1,
      warehouseLocationId: 11,
      productVariantId: 101,
      variantQty: "3",
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
