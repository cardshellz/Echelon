import { describe, expect, it, vi } from "vitest";

import type { ClaimSupplySnapshotContentDto } from "@shared/types/inventory-availability-planner";
import { sealClaimSupplySnapshot } from "../../domain/inventory-availability-planner";
import {
  InventoryAvailabilityClaimSimulationService,
  InventoryAvailabilityClaimSimulationServiceError,
} from "../../application/inventory-availability-claim-simulation.service";

const HASH = "a".repeat(64);
const COMPLETED_AT = new Date("2026-08-28T16:00:01.000Z");

describe("inventory availability claim simulation service", () => {
  it("captures and persists one non-writing whole-order plan", async () => {
    const snapshot = sealClaimSupplySnapshot(content());
    const snapshotStore = { captureClaimSupplySnapshot: vi.fn(async () => snapshot) };
    const simulationStore = {
      persistClaimSimulation: vi.fn(async (input: any) => ({
        simulationRunId: "9",
        requestHash: input.requestHash,
        requestedBy: input.requestedBy,
        reason: input.reason,
        capturedAt: input.snapshot.capturedAt,
        completedAt: input.completedAt.toISOString(),
        claim: input.claim,
        plan: input.plan,
        legacyLivePathRetained: true as const,
        operationalWriteAttempted: false as const,
        alreadyApplied: false,
      })),
    };
    const service = new InventoryAvailabilityClaimSimulationService(
      snapshotStore,
      simulationStore,
      { now: () => COMPLETED_AT },
    );

    const result = await service.runSimulation({
      idempotencyKey: "claim-simulation-1",
      reason: "Phase 4 synthetic basket evidence",
      claim: {
        requestKey: "order:synthetic-1",
        scope: { kind: "warehouse", warehouseId: 1 },
        lines: [{ lineKey: "line:1", targetVariantId: 101, requestedQty: "3" }],
      },
    }, "operator-1");

    expect(snapshotStore.captureClaimSupplySnapshot).toHaveBeenCalledWith([101]);
    expect(result).toMatchObject({
      simulationRunId: "9",
      requestedBy: "operator-1",
      legacyLivePathRetained: true,
      operationalWriteAttempted: false,
      plan: { status: "satisfied", lines: [{ plannedQty: "3", shortfallQty: "0" }] },
    });
    expect(simulationStore.persistClaimSimulation).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "claim-simulation-1",
      requestedBy: "operator-1",
      completedAt: COMPLETED_AT,
    }));
  });

  it("rejects duplicate line keys and unauthenticated actors before capture", async () => {
    const snapshotStore = { captureClaimSupplySnapshot: vi.fn() };
    const service = new InventoryAvailabilityClaimSimulationService(
      snapshotStore,
      { persistClaimSimulation: vi.fn() },
    );
    await expect(service.runSimulation({
      idempotencyKey: "claim-simulation-2",
      reason: "Invalid duplicate lines",
      claim: {
        requestKey: "order:duplicate",
        scope: { kind: "network" },
        lines: [
          { lineKey: "same", targetVariantId: 101, requestedQty: "1" },
          { lineKey: "same", targetVariantId: 101, requestedQty: "1" },
        ],
      },
    }, "operator-1")).rejects.toEqual(expect.objectContaining<Partial<InventoryAvailabilityClaimSimulationServiceError>>({
      code: "INVENTORY_AVAILABILITY_INVALID_CLAIM_SIMULATION",
      status: 400,
    }));
    await expect(service.runSimulation({
      idempotencyKey: "claim-simulation-3",
      reason: "Missing actor",
      claim: {
        requestKey: "order:no-actor",
        scope: { kind: "network" },
        lines: [{ lineKey: "line", targetVariantId: 101, requestedQty: "1" }],
      },
    }, " ")).rejects.toEqual(expect.objectContaining({
      code: "INVENTORY_AVAILABILITY_ACTOR_REQUIRED",
      status: 401,
    }));
    expect(snapshotStore.captureClaimSupplySnapshot).not.toHaveBeenCalled();
  });
});

function content(): ClaimSupplySnapshotContentDto {
  return {
    schemaVersion: "inventory_availability_claim_snapshot_v1",
    capturedAt: "2026-08-28T16:00:00.000Z",
    rootProducts: [{ productId: 10, legacyInventoryStrategy: "physical_only" }],
    variants: [{ id: 101, productId: 10, sku: "EA", name: "Each", unitsPerVariant: 1, isActive: true }],
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
      variantQty: "5",
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
