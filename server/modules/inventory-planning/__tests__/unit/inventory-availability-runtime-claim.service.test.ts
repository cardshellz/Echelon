import { describe, expect, it, vi } from "vitest";

import type { ClaimPlanDto } from "@shared/types/inventory-availability-planner";
import type { ReservationServiceContract } from "../../../channels/reservation.service";
import {
  AuthorityAwareReservationService,
  type InventoryAvailabilityRuntimeClaimContext,
  type InventoryAvailabilityRuntimeClaimExecutor,
} from "../../application/inventory-availability-runtime-claim.service";

describe("AuthorityAwareReservationService", () => {
  it("delegates reservation and demand reconciliation unchanged while legacy owns authority", async () => {
    const legacy = fakeLegacy();
    const service = new AuthorityAwareReservationService(executor({ authority: "legacy", legacy }));
    const reconcile = {
      orderId: 42,
      sourceEventId: "webhook_inbox:900",
      demandChanged: true,
      reason: "order edited",
    };

    await service.reserveOrder(42, "user:7");
    await service.releaseOrderReservation(42, "cancelled", "user:7", { disposition: "cancel" });
    await service.reconcileOrderDemand(reconcile);

    expect(legacy.reserveOrder).toHaveBeenCalledWith(42, "user:7", undefined);
    expect(legacy.releaseOrderReservation).toHaveBeenCalledWith(
      42,
      "cancelled",
      "user:7",
      { disposition: "cancel" },
    );
    expect(legacy.reconcileOrderDemand).toHaveBeenCalledWith(reconcile);
  });

  it("claims the complete order and maps canonical direct, build, and shortfall evidence", async () => {
    const plan = canonicalPlan();
    const canonical = {
      claimOrder: vi.fn(async () => ({
        outcome: "claimed" as const,
        claimId: "70",
        claimKey: plan.requestKey,
        orderId: 42,
        revision: 3,
        runtimeAuthorityRevision: "9",
        plan,
        idempotentReplay: false,
      })),
      releaseOrderClaim: vi.fn(),
    };
    const service = new AuthorityAwareReservationService(executor({
      authority: "canonical",
      canonical,
      getLatestClaim: vi.fn(async () => null),
      getVariantMetadata: vi.fn(async () => new Map([
        [101, { productVariantId: 101, sku: "EA", unitsPerVariant: 1 }],
        [102, { productVariantId: 102, sku: "C25", unitsPerVariant: 25 }],
      ])),
    }));

    await expect(service.reserveOrder(42, "user:7")).resolves.toEqual({
      orderId: 42,
      reserved: 1,
      promised: 1,
      failed: [{
        sku: "EA",
        orderItemId: 11,
        reason: "Canonical claim shortfall: planned 2 of 3 variant units (shortfall: 1)",
      }],
      totalBaseUnits: 2,
      totalPromisedBaseUnits: 50,
    });
    expect(canonical.claimOrder).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 42,
      actor: "user:7",
      reason: "Reserve order inventory",
      idempotencyKey: expect.stringMatching(/^inventory-runtime:claim-order:[0-9a-f]{64}$/),
    }));
  });

  it("uses the exact latest claim identity for a canonical cancellation", async () => {
    const plan = canonicalPlan();
    const canonical = {
      claimOrder: vi.fn(),
      releaseOrderClaim: vi.fn(async () => ({
        outcome: "released" as const,
        claimId: "70",
        claimKey: plan.requestKey,
        orderId: 42,
        status: "cancelled" as const,
        releasedResourceQty: "52",
        releasedLotQty: "52",
        idempotentReplay: false,
      })),
    };
    const service = new AuthorityAwareReservationService(executor({
      authority: "canonical",
      canonical,
      getLatestClaim: vi.fn(async () => ({ claimId: "70", revision: 3, status: "active", plan })),
    }));

    await expect(service.releaseOrderReservation(
      42,
      "shopify cancellation",
      undefined,
      { disposition: "cancel" },
    )).resolves.toEqual({ released: 2, failed: [] });
    expect(canonical.releaseOrderClaim).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 42,
      disposition: "cancel",
      actor: "system:inventory-reservation-runtime",
      idempotencyKey: expect.stringMatching(/^inventory-runtime:release-order-claim:[0-9a-f]{64}$/),
    }));
  });

  it("fails closed for every legacy mutation that lacks a canonical whole-order equivalent", async () => {
    const service = new AuthorityAwareReservationService(executor({ authority: "canonical" }));

    await expect(service.reserveForOrder(10, 101, 1, 42, 11)).rejects.toMatchObject({
      code: "CANONICAL_LINE_RESERVATION_UNSUPPORTED",
      context: expect.objectContaining({ authorityRevision: "9", activationRunId: "44" }),
    });
    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:900",
      demandChanged: true,
      reason: "order edited",
    })).rejects.toMatchObject({ code: "CANONICAL_DEMAND_RECONCILIATION_NOT_ATOMIC" });
    await expect(service.releaseOrderItemReservation({
      orderId: 42,
      orderItemId: 11,
      quantity: 1,
      sourceEventId: "refund:5",
      reason: "refund",
    })).rejects.toMatchObject({ code: "CANONICAL_ITEM_RELEASE_UNSUPPORTED" });
    await expect(service.reallocateOrphaned(101, 2)).rejects.toMatchObject({
      code: "CANONICAL_ORPHAN_REALLOCATION_UNSUPPORTED",
    });
    await expect(service.getOrderReservationStatus(42)).rejects.toMatchObject({
      code: "CANONICAL_RESERVATION_STATUS_PROJECTION_REQUIRED",
    });
  });

  it("rejects a caller-owned transaction after canonical cutover", async () => {
    const service = new AuthorityAwareReservationService(executor({ authority: "canonical" }));

    await expect(service.reserveOrder(42, undefined, {})).rejects.toMatchObject({
      code: "CANONICAL_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
    });
    await expect(service.releaseOrderReservation(
      42,
      "cancelled",
      undefined,
      { disposition: "cancel", dbOverride: {} },
    )).rejects.toMatchObject({
      code: "CANONICAL_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
    });
    await expect(service.autoReserveOnSync("9001", undefined, {})).rejects.toMatchObject({
      code: "CANONICAL_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
    });
  });
});

function executor(input: {
  authority: "legacy" | "canonical";
  legacy?: ReservationServiceContract;
  canonical?: InventoryAvailabilityRuntimeClaimContext["canonical"];
  getLatestClaim?: InventoryAvailabilityRuntimeClaimContext["getLatestClaim"];
  getVariantMetadata?: InventoryAvailabilityRuntimeClaimContext["getVariantMetadata"];
}): InventoryAvailabilityRuntimeClaimExecutor {
  return {
    execute: (work) => work({
      authority: input.authority,
      authorityRevision: "9",
      activationRunId: input.authority === "canonical" ? "44" : null,
      legacy: input.legacy ?? fakeLegacy(),
      canonical: input.canonical ?? {
        claimOrder: vi.fn(),
        releaseOrderClaim: vi.fn(),
      },
      getLatestClaim: input.getLatestClaim ?? vi.fn(async () => null),
      getVariantMetadata: input.getVariantMetadata ?? vi.fn(async () => new Map()),
      getOrderIdByShopifyOrderId: vi.fn(async () => null),
    }),
  };
}

function fakeLegacy(): ReservationServiceContract {
  const reservation = {
    orderId: 42,
    reserved: 1,
    promised: 0,
    failed: [],
    totalBaseUnits: 1,
    totalPromisedBaseUnits: 0,
  };
  return {
    reserveForOrder: vi.fn(async () => ({ reserved: 1, promised: 0, shortfall: 0 })),
    reserveOrder: vi.fn(async () => reservation),
    releaseOrderReservation: vi.fn(async () => ({ released: 1, failed: [] })),
    releaseOrderItemReservation: vi.fn(async (params) => ({
      orderId: params.orderId,
      orderItemId: params.orderItemId,
      productVariantId: 101,
      requestedQuantity: params.quantity,
      previouslyReleasedQuantity: 0,
      releasedQuantity: params.quantity,
      openReservationAfter: 0,
      idempotentReplay: false,
    })),
    reconcileOrderDemand: vi.fn(async () => ({
      reconciled: true,
      release: { released: 1, failed: [] },
      reservation,
    })),
    reallocateOrphaned: vi.fn(async () => ({ released: 0, reallocated: 0, failed: 0 })),
    getOrderReservationStatus: vi.fn(async () => []),
    autoReserveOnSync: vi.fn(async () => reservation),
  };
}

function canonicalPlan(): ClaimPlanDto {
  return {
    requestKey: "order:42:availability:revision:3",
    scope: { kind: "warehouse", warehouseId: 1 },
    status: "partial",
    lines: [
      { lineKey: "order-item:11", targetVariantId: 101, requestedQty: "3", plannedQty: "2", shortfallQty: "1" },
      { lineKey: "order-item:12", targetVariantId: 102, requestedQty: "2", plannedQty: "2", shortfallQty: "0" },
    ],
    resourceClaims: [],
    operations: [{
      lineKey: "order-item:12",
      warehouseId: 1,
      operationKey: "build:12",
      parentOperationKey: null,
      operationType: "component_build",
      authorityId: 5,
      sourceVariantIds: [101],
      inputs: [{ sourceVariantId: 101, requiredQty: "50" }],
      destinationVariantId: 102,
      plannedExecutions: "2",
      outputQty: "2",
      committedOutputQty: "2",
      outputLocationId: 7,
    }],
    fulfillmentGroups: [],
    modelEvidence: [],
    blockers: [],
    snapshotFingerprint: "a".repeat(64),
  };
}
