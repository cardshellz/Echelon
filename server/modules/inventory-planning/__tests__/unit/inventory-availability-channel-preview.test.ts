import { describe, expect, it } from "vitest";

import type { PlannerShadowRunDto } from "@shared/types/inventory-availability-planner";
import type {
  ProductAllocationResult,
  VariantChannelAllocation,
} from "../../../channels/allocation-engine.service";
import {
  inventoryAvailabilityChannelPreviewTestables,
} from "../../infrastructure/inventory-availability-channel-preview.repository";

const HASH = "a".repeat(64);

function run(): PlannerShadowRunDto {
  const captured: PlannerShadowRunDto = {
    runId: "9",
    productId: 10,
    legacyInventoryStrategy: "physical_fungible",
    status: "completed",
    snapshotFingerprint: HASH,
    capturedAt: "2026-08-28T12:00:00.000Z",
    completedAt: "2026-08-28T12:00:01.000Z",
    requestedBy: "operator-1",
    modelId: 50,
    modelVersion: 1,
    modelDefinitionHash: HASH,
    blockerCodes: [],
    alreadyApplied: false,
    results: [{
      warehouseId: null,
      warehouseCodeSnapshot: null,
      productVariantId: 11,
      productVariantSkuSnapshot: "P5",
      productVariantNameSnapshot: "Pack 5",
      productVariantUnitsPerVariantSnapshot: 5,
      legacyAtpUnits: "20",
      legacyAtpBaseUnits: "104",
      proposedAtpUnits: "18",
      differenceUnits: "-2",
      readinessState: "ready",
      classifications: ["directed_transformation"],
      proposedProjection: {
        targetVariantId: 11,
        scope: { kind: "network" },
        status: "ready",
        atpUnits: "18",
        atpBaseUnits: "90",
        exactPhysicalUnits: "0",
        claimedUnits: "0",
        protectedUnits: "0",
        directUnits: "0",
        convertibleUnits: "18",
        buildableUnits: "0",
        snapshotFingerprint: HASH,
        modelEvidence: [{
          productId: 10,
          modelId: 50,
          version: 1,
          definitionHash: HASH,
          lifecycleSelection: "draft_head",
        }],
        safetyEvidence: [],
        blockers: [],
      },
    }],
  };
  captured.results.push({
    ...captured.results[0]!,
    warehouseId: 1,
    warehouseCodeSnapshot: "MAIN",
    proposedProjection: {
      ...captured.results[0]!.proposedProjection,
      scope: { kind: "warehouse", warehouseId: 1 },
    },
  });
  return captured;
}

function allocation(
  allocatedUnits: number,
  warehouseScopeSource: VariantChannelAllocation["warehouseScopeSource"],
): ProductAllocationResult {
  return {
    productId: 10,
    totalAtpBase: allocatedUnits * 5,
    blocked: [],
    allocations: [{
      channelId: 36,
      channelName: "Shopify",
      channelProvider: "shopify",
      channelPriority: 1,
      productVariantId: 11,
      sku: "P5",
      unitsPerVariant: 5,
      allocatedUnits,
      allocatedBase: allocatedUnits * 5,
      method: "mirror",
      reason: "Multi-warehouse breakdown.",
      warehouseScopeSource,
      warehouseBreakdown: [{ warehouseId: 1, qty: allocatedUnits }],
    }],
  };
}

describe("inventory availability channel preview", () => {
  it("compares publication quantities without claiming any runtime or provider write", () => {
    const preview = inventoryAvailabilityChannelPreviewTestables.compareAllocations(
      run(),
      allocation(20, "explicit"),
      allocation(18, "explicit"),
      [],
    );

    expect(preview).toMatchObject({
      runtimeAuthorityChanged: false,
      providerWriteAttempted: false,
      allocationAuditWritten: false,
      policyAuthority: "legacy_channel_allocation_rules",
      blockers: [],
      rows: [{
        channelId: 36,
        legacyAtpUnits: "20",
        proposedAtpUnits: "18",
        legacyPublishedUnits: "20",
        proposedPublishedUnits: "18",
        differenceUnits: "-2",
      }],
    });
  });

  it("blocks activation review when a channel inherits all active warehouses", () => {
    const preview = inventoryAvailabilityChannelPreviewTestables.compareAllocations(
      run(),
      allocation(20, "legacy_all_active_fallback"),
      allocation(18, "legacy_all_active_fallback"),
      [],
    );

    expect(preview.blockers).toEqual([
      expect.objectContaining({ code: "LEGACY_WAREHOUSE_SCOPE_FALLBACK", severity: "blocking" }),
    ]);
  });

  it("refuses to compare mismatched channel/variant allocation shapes", () => {
    const proposed = allocation(18, "explicit");
    proposed.allocations[0]!.channelId = 67;

    const preview = inventoryAvailabilityChannelPreviewTestables.compareAllocations(
      run(),
      allocation(20, "explicit"),
      proposed,
      [],
    );

    expect(preview.rows).toEqual([]);
    expect(preview.blockers).toEqual([
      expect.objectContaining({ code: "CHANNEL_ALLOCATION_SHAPE_MISMATCH" }),
    ]);
  });

  it("blocks when current channel scope references a warehouse absent from the sealed shadow", () => {
    const legacy = allocation(20, "explicit");
    const proposed = allocation(18, "explicit");
    legacy.allocations[0]!.warehouseBreakdown[0]!.warehouseId = 2;
    proposed.allocations[0]!.warehouseBreakdown[0]!.warehouseId = 2;

    const preview = inventoryAvailabilityChannelPreviewTestables.compareAllocations(
      run(),
      legacy,
      proposed,
      [],
    );

    expect(preview.blockers).toEqual([
      expect.objectContaining({
        code: "CHANNEL_WAREHOUSE_MISSING_FROM_SHADOW",
        context: { warehouseIds: [2] },
      }),
    ]);
  });

  it("rejects allocation arithmetic that leaves JavaScript's safe integer range", () => {
    const unsafe = allocation(18, "explicit");
    unsafe.allocations[0]!.allocatedBase = Number.MAX_SAFE_INTEGER + 1;

    expect(() => inventoryAvailabilityChannelPreviewTestables.assertSafeAllocationResult(
      unsafe,
      "proposed",
    )).toThrow(/safe integer range/);
  });
});
