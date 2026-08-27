import { describe, expect, it, vi } from "vitest";

import type {
  PlannerShadowRunDto,
  SupplySnapshotContentDto,
} from "@shared/types/inventory-availability-planner";
import { sealSupplySnapshot } from "../../domain/inventory-availability-planner";
import {
  InventoryAvailabilityShadowService,
  InventoryAvailabilityShadowServiceError,
} from "../../application/inventory-availability-shadow.service";
import type {
  InventoryAvailabilityShadowStore,
  PersistPlannerShadowRunInput,
} from "../../infrastructure/inventory-availability-shadow.repository";

const HASH = "a".repeat(64);
const CAPTURED_AT = "2026-08-27T12:00:00.000Z";
const COMPLETED_AT = new Date("2026-08-27T12:00:01.000Z");

describe("inventory availability shadow service", () => {
  it("compares every active target variant at warehouse and network scope from one snapshot", async () => {
    const snapshot = sealSupplySnapshot(content());
    const store = fakeStore(snapshot);
    const service = new InventoryAvailabilityShadowService(store, { now: () => COMPLETED_AT });

    const result = await service.runProductShadow(
      10,
      { idempotencyKey: "shadow-run-1" },
      "operator-1",
    );

    expect(store.captureSupplySnapshot).toHaveBeenCalledTimes(1);
    expect(store.captureSupplySnapshot).toHaveBeenCalledWith(10);
    expect(store.persistShadowRun).toHaveBeenCalledTimes(1);
    const persisted = store.persistShadowRun.mock.calls[0]![0];
    expect(persisted).toMatchObject({
      snapshot,
      requestedBy: "operator-1",
      idempotencyKey: "shadow-run-1",
      completedAt: COMPLETED_AT,
    });
    expect(persisted.results).toHaveLength(2);
    expect(persisted.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        warehouseId: null,
        productVariantId: 101,
        legacyAtpUnits: "10",
        proposedAtpUnits: "7",
        differenceUnits: "-3",
        classifications: expect.arrayContaining(["aggregate_claim_clamp"]),
      }),
      expect.objectContaining({
        warehouseId: 1,
        productVariantId: 101,
        legacyAtpUnits: "10",
        proposedAtpUnits: "7",
        differenceUnits: "-3",
      }),
    ]));
    expect(result.results).toEqual(persisted.results);
  });

  it("rejects malformed boundaries before taking a database snapshot", async () => {
    const store = fakeStore(sealSupplySnapshot(content()));
    const service = new InventoryAvailabilityShadowService(store, { now: () => COMPLETED_AT });

    await expect(service.runProductShadow(0, { idempotencyKey: "valid" }, "operator-1"))
      .rejects.toMatchObject({ code: "INVENTORY_AVAILABILITY_INVALID_ID" });
    await expect(service.runProductShadow(10, { idempotencyKey: "" }, "operator-1"))
      .rejects.toMatchObject({ code: "INVENTORY_AVAILABILITY_INVALID_INPUT" });
    await expect(service.runProductShadow(10, { idempotencyKey: "valid" }, " "))
      .rejects.toMatchObject({ code: "INVENTORY_AVAILABILITY_ACTOR_REQUIRED" });
    expect(store.captureSupplySnapshot).not.toHaveBeenCalled();
  });

  it("classifies an absent latest run without inventing evidence", async () => {
    const store = fakeStore(sealSupplySnapshot(content()));
    store.getLatestShadowRun.mockResolvedValue(null);
    const service = new InventoryAvailabilityShadowService(store);

    await expect(service.getLatestProductShadow(10)).rejects.toEqual(
      expect.objectContaining<Partial<InventoryAvailabilityShadowServiceError>>({
        status: 404,
        code: "INVENTORY_AVAILABILITY_SHADOW_RUN_NOT_FOUND",
      }),
    );
  });

  it("rejects an invalid injected clock rather than persisting unauditable time", async () => {
    const store = fakeStore(sealSupplySnapshot(content()));
    const service = new InventoryAvailabilityShadowService(store, {
      now: () => new Date("invalid"),
    });

    await expect(service.runProductShadow(10, { idempotencyKey: "shadow-run-2" }, "operator-1"))
      .rejects.toMatchObject({ code: "INVENTORY_AVAILABILITY_INVALID_CLOCK" });
    expect(store.persistShadowRun).not.toHaveBeenCalled();
  });
});

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
    inventoryPositions: [
      {
        inventoryLevelId: 1,
        warehouseLocationId: 11,
        productVariantId: 101,
        variantQty: "2",
        reservedQty: "5",
        pickedQty: "0",
        packedQty: "0",
      },
      {
        inventoryLevelId: 2,
        warehouseLocationId: 11,
        productVariantId: 101,
        variantQty: "10",
        reservedQty: "0",
        pickedQty: "0",
        packedQty: "0",
      },
    ],
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

function fakeStore(snapshot: ReturnType<typeof sealSupplySnapshot>) {
  const runFrom = (input: PersistPlannerShadowRunInput): PlannerShadowRunDto => ({
    runId: "1",
    productId: input.snapshot.productId,
    legacyInventoryStrategy: input.snapshot.legacyInventoryStrategy,
    status: input.results.some((entry) => entry.readinessState === "blocked") ? "blocked" : "completed",
    snapshotFingerprint: input.snapshot.snapshotFingerprint,
    capturedAt: input.snapshot.capturedAt,
    completedAt: input.completedAt.toISOString(),
    requestedBy: input.requestedBy,
    modelId: 501,
    modelVersion: 1,
    modelDefinitionHash: HASH,
    blockerCodes: [],
    results: input.results,
    alreadyApplied: false,
  });
  return {
    captureSupplySnapshot: vi.fn<InventoryAvailabilityShadowStore["captureSupplySnapshot"]>()
      .mockResolvedValue(snapshot),
    persistShadowRun: vi.fn<InventoryAvailabilityShadowStore["persistShadowRun"]>()
      .mockImplementation(async (input) => runFrom(input)),
    getLatestShadowRun: vi.fn<InventoryAvailabilityShadowStore["getLatestShadowRun"]>()
      .mockResolvedValue(null),
  };
}
