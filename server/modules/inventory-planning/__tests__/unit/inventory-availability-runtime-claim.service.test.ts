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
    const refund = {
      orderId: 42,
      sourceEventId: "refund:901",
      releaseTargets: [
        { orderItemId: 12, quantity: 2 },
        { orderItemId: 11, quantity: 1 },
      ],
      reason: "refund demand changed",
    };

    await service.reserveOrder(42, "user:7");
    await service.releaseOrderReservation(42, "cancelled", "user:7", { disposition: "cancel" });
    await service.reconcileOrderDemand(reconcile);
    await service.reconcileRefundOrderDemand(refund);
    const cycleCount = {
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 7,
      countedQty: 4,
      reasonCode: "shrinkage",
      actor: "user:7",
      reason: "approved physical count",
    };
    await service.reconcileCycleCountInventory(cycleCount);

    expect(legacy.reserveOrder).toHaveBeenCalledWith(42, "user:7", undefined);
    expect(legacy.releaseOrderReservation).toHaveBeenCalledWith(
      42,
      "cancelled",
      "user:7",
      { disposition: "cancel" },
    );
    expect(legacy.reconcileOrderDemand).toHaveBeenCalledWith(reconcile);
    expect(legacy.reconcileRefundOrderDemand).toHaveBeenCalledWith({
      ...refund,
      releaseTargets: [
        { orderItemId: 11, quantity: 1 },
        { orderItemId: 12, quantity: 2 },
      ],
    });
    expect(legacy.reconcileCycleCountInventory).toHaveBeenCalledWith(cycleCount);
  });

  it("routes a complete counted item to canonical reconciliation without legacy fallback", async () => {
    const result = {
      outcome: "cycle_count_reconciled" as const,
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 7,
      quantityBefore: 10,
      quantityAfter: 4,
      quantityDelta: -6,
      adjustmentTransactionId: 901,
      displacedOrderIds: [42],
      idempotentReplay: false,
    };
    const canonical = {
      claimOrder: vi.fn(),
      replaceOrderClaim: vi.fn(),
      releaseOrderClaim: vi.fn(),
      reconcileCycleCount: vi.fn(async () => result),
    };
    const legacy = fakeLegacy();
    const service = new AuthorityAwareReservationService(executor({ authority: "canonical", canonical, legacy }));

    await expect(service.reconcileCycleCountInventory({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 7,
      countedQty: 4,
      reasonCode: "shrinkage",
      actor: "user:7",
      reason: "approved physical count",
    })).resolves.toEqual(result);
    expect(canonical.reconcileCycleCount).toHaveBeenCalledOnce();
    expect(legacy.reconcileCycleCountInventory).not.toHaveBeenCalled();
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
      replaceOrderClaim: vi.fn(),
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
      replaceOrderClaim: vi.fn(),
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
      expectedClaimId: "70",
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

  it("atomically replaces changed canonical demand using the exact active claim", async () => {
    const currentPlan = canonicalPlan();
    const replacementPlan = {
      ...canonicalPlan(),
      requestKey: "order:42:availability:revision:4",
      lines: [
        { lineKey: "order-item:11", targetVariantId: 101, requestedQty: "1", plannedQty: "1", shortfallQty: "0" },
      ],
      operations: [],
    } satisfies ClaimPlanDto;
    const canonical = {
      claimOrder: vi.fn(),
      replaceOrderClaim: vi.fn(async () => ({
        outcome: "replaced" as const,
        orderId: 42,
        supersededClaimId: "70",
        supersededClaimKey: currentPlan.requestKey,
        supersededRevision: 3,
        replacementClaim: {
          claimId: "71",
          claimKey: replacementPlan.requestKey,
          revision: 4,
          runtimeAuthorityRevision: "9",
          plan: replacementPlan,
        },
        releasedResourceQty: "52",
        releasedLotQty: "52",
        idempotentReplay: false,
      })),
      releaseOrderClaim: vi.fn(),
    };
    const service = new AuthorityAwareReservationService(executor({
      authority: "canonical",
      canonical,
      getLatestClaim: vi.fn(async () => ({
        claimId: "70",
        revision: 3,
        status: "active",
        plan: currentPlan,
      })),
      getVariantMetadata: vi.fn(async () => new Map([
        [101, { productVariantId: 101, sku: "EA", unitsPerVariant: 1 }],
      ])),
    }));

    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:900",
      demandChanged: true,
      reason: "order edited",
    })).resolves.toEqual({
      reconciled: true,
      release: { released: 2, failed: [] },
      reservation: {
        orderId: 42,
        reserved: 1,
        promised: 0,
        failed: [],
        totalBaseUnits: 1,
        totalPromisedBaseUnits: 0,
      },
    });
    expect(canonical.replaceOrderClaim).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 42,
      expectedClaimId: "70",
      idempotencyKey: expect.stringMatching(
        /^inventory-runtime:reconcile-order-demand-replace:[0-9a-f]{64}$/,
      ),
    }));
    expect(canonical.releaseOrderClaim).not.toHaveBeenCalled();
  });

  it("reconciles every refunded line through one canonical replacement", async () => {
    const currentPlan = canonicalPlan();
    const replacementPlan = {
      ...canonicalPlan(),
      requestKey: "order:42:availability:revision:4",
      lines: [
        { lineKey: "order-item:11", targetVariantId: 101, requestedQty: "2", plannedQty: "1", shortfallQty: "1" },
        { lineKey: "order-item:12", targetVariantId: 102, requestedQty: "1", plannedQty: "1", shortfallQty: "0" },
      ],
      operations: [],
    } satisfies ClaimPlanDto;
    const canonical = {
      claimOrder: vi.fn(),
      replaceOrderClaim: vi.fn(async () => ({
        outcome: "replaced" as const,
        orderId: 42,
        supersededClaimId: "70",
        supersededClaimKey: currentPlan.requestKey,
        supersededRevision: 3,
        replacementClaim: {
          claimId: "71",
          claimKey: replacementPlan.requestKey,
          revision: 4,
          runtimeAuthorityRevision: "9",
          plan: replacementPlan,
        },
        releasedResourceQty: "26",
        releasedLotQty: "26",
        idempotentReplay: false,
      })),
      releaseOrderClaim: vi.fn(),
    };
    const legacy = fakeLegacy();
    const service = new AuthorityAwareReservationService(executor({
      authority: "canonical",
      legacy,
      canonical,
      getLatestClaim: vi.fn(async () => ({
        claimId: "70",
        revision: 3,
        status: "active",
        plan: currentPlan,
      })),
      getVariantMetadata: vi.fn(async () => new Map([
        [101, { productVariantId: 101, sku: "EA", unitsPerVariant: 1 }],
        [102, { productVariantId: 102, sku: "C25", unitsPerVariant: 25 }],
      ])),
    }));

    await expect(service.reconcileRefundOrderDemand({
      orderId: 42,
      sourceEventId: "refund:901",
      releaseTargets: [
        { orderItemId: 12, quantity: 5 },
        { orderItemId: 11, quantity: 1 },
      ],
      reason: "Shopify refund 901 demand reconciliation",
    })).resolves.toEqual({ releasedReservationQuantity: 2 });

    expect(canonical.replaceOrderClaim).toHaveBeenCalledTimes(1);
    expect(canonical.replaceOrderClaim).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 42,
      expectedClaimId: "70",
      idempotencyKey: expect.stringMatching(
        /^inventory-runtime:reconcile-order-demand-replace:[0-9a-f]{64}$/,
      ),
    }));
    expect(legacy.releaseOrderItemReservation).not.toHaveBeenCalled();
    expect(legacy.reconcileRefundOrderDemand).not.toHaveBeenCalled();
  });

  it("releases the exact active claim only after locked demand is proven empty", async () => {
    const plan = canonicalPlan();
    const canonical = {
      claimOrder: vi.fn(),
      replaceOrderClaim: vi.fn(async () => {
        throw Object.assign(new Error("no remaining demand"), {
          code: "REPLACEMENT_ORDER_NOT_CLAIMABLE",
          context: { warehouseStatus: "ready" },
        });
      }),
      releaseOrderClaim: vi.fn(async () => ({
        outcome: "released" as const,
        claimId: "70",
        claimKey: plan.requestKey,
        orderId: 42,
        status: "released" as const,
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

    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:901",
      demandChanged: true,
      reason: "all physical order lines removed",
    })).resolves.toEqual({
      reconciled: true,
      release: { released: 2, failed: [] },
      reservation: {
        orderId: 42,
        reserved: 0,
        promised: 0,
        failed: [],
        totalBaseUnits: 0,
        totalPromisedBaseUnits: 0,
      },
    });
    expect(canonical.releaseOrderClaim).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 42,
      disposition: "release",
      expectedClaimId: "70",
      expectedWarehouseStatus: "ready",
      requireNoClaimableDemand: true,
      idempotencyKey: expect.stringMatching(
        /^inventory-runtime:reconcile-order-demand-release:[0-9a-f]{64}$/,
      ),
    }));
  });

  it("reports only event-attributed target units when a refund removes the last claimable demand", async () => {
    const plan = canonicalPlan();
    const canonical = {
      claimOrder: vi.fn(),
      replaceOrderClaim: vi.fn(async () => {
        throw Object.assign(new Error("no remaining demand"), {
          code: "REPLACEMENT_ORDER_NOT_CLAIMABLE",
          context: { warehouseStatus: "ready" },
        });
      }),
      releaseOrderClaim: vi.fn(async () => ({
        outcome: "released" as const,
        claimId: "70",
        claimKey: plan.requestKey,
        orderId: 42,
        status: "released" as const,
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

    await expect(service.reconcileRefundOrderDemand({
      orderId: 42,
      sourceEventId: "refund:remove-last-demand",
      releaseTargets: [
        { orderItemId: 11, quantity: 2 },
        { orderItemId: 12, quantity: 1 },
      ],
      reason: "all remaining physical demand refunded",
    })).resolves.toEqual({ releasedReservationQuantity: 3 });
    expect(canonical.releaseOrderClaim).toHaveBeenCalledTimes(1);
  });

  it("cancels the exact active claim when the locked order is cancelled", async () => {
    const plan = canonicalPlan();
    const canonical = {
      claimOrder: vi.fn(),
      replaceOrderClaim: vi.fn(async () => {
        throw Object.assign(new Error("order cancelled"), {
          code: "REPLACEMENT_ORDER_NOT_CLAIMABLE",
          context: { warehouseStatus: "cancelled" },
        });
      }),
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

    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:cancelled-901",
      demandChanged: true,
      reason: "order cancelled",
    })).resolves.toMatchObject({
      reconciled: true,
      release: { released: 2, failed: [] },
    });
    expect(canonical.releaseOrderClaim).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 42,
      disposition: "cancel",
      expectedClaimId: "70",
      expectedWarehouseStatus: "cancelled",
      requireNoClaimableDemand: true,
    }));
  });

  it("records an unchanged canonical demand event without replacing or releasing", async () => {
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
      replaceOrderClaim: vi.fn(async () => {
        throw Object.assign(new Error("demand unchanged"), { code: "ORDER_DEMAND_UNCHANGED" });
      }),
      releaseOrderClaim: vi.fn(),
    };
    const service = new AuthorityAwareReservationService(executor({
      authority: "canonical",
      canonical,
      getLatestClaim: vi.fn(async () => ({ claimId: "70", revision: 3, status: "active", plan })),
      getVariantMetadata: vi.fn(async () => new Map([
        [101, { productVariantId: 101, sku: "EA", unitsPerVariant: 1 }],
        [102, { productVariantId: 102, sku: "C25", unitsPerVariant: 25 }],
      ])),
    }));

    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:902",
      demandChanged: false,
      reason: "retry after WMS demand persisted",
    })).resolves.toMatchObject({
      reconciled: false,
      release: { released: 0, failed: [] },
    });
    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:902",
      demandChanged: true,
      reason: "retry after WMS demand persisted",
    })).resolves.toMatchObject({ reconciled: false });
    expect(canonical.claimOrder).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 42,
      idempotencyKey: expect.stringMatching(
        /^inventory-runtime:reconcile-order-demand-unchanged:[0-9a-f]{64}$/,
      ),
    }));
    const replacementKeys = canonical.replaceOrderClaim.mock.calls.map(
      ([input]) => (input as { idempotencyKey: string }).idempotencyKey,
    );
    const replayKeys = canonical.claimOrder.mock.calls.map(
      ([input]) => (input as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(replacementKeys).size).toBe(1);
    expect(new Set(replayKeys).size).toBe(1);
    expect(canonical.releaseOrderClaim).not.toHaveBeenCalled();
  });

  it("reports zero released refund demand when the canonical plan is unchanged", async () => {
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
      replaceOrderClaim: vi.fn(async () => {
        throw Object.assign(new Error("demand unchanged"), { code: "ORDER_DEMAND_UNCHANGED" });
      }),
      releaseOrderClaim: vi.fn(),
    };
    const service = new AuthorityAwareReservationService(executor({
      authority: "canonical",
      canonical,
      getLatestClaim: vi.fn(async () => ({ claimId: "70", revision: 3, status: "active", plan })),
      getVariantMetadata: vi.fn(async () => new Map([
        [101, { productVariantId: 101, sku: "EA", unitsPerVariant: 1 }],
        [102, { productVariantId: 102, sku: "C25", unitsPerVariant: 25 }],
      ])),
    }));

    await expect(service.reconcileRefundOrderDemand({
      orderId: 42,
      sourceEventId: "refund:902",
      releaseTargets: [{ orderItemId: 11, quantity: 1 }],
      reason: "refund replay",
    })).resolves.toEqual({ releasedReservationQuantity: 0 });
    expect(canonical.replaceOrderClaim).toHaveBeenCalledTimes(1);
    expect(canonical.releaseOrderClaim).not.toHaveBeenCalled();
  });

  it("keeps a failed canonical demand reconciliation retryable without legacy fallback", async () => {
    const plan = canonicalPlan();
    const canonical = {
      claimOrder: vi.fn(),
      replaceOrderClaim: vi.fn(async () => {
        throw Object.assign(new Error("no remaining demand"), {
          code: "REPLACEMENT_ORDER_NOT_CLAIMABLE",
          context: { warehouseStatus: "ready" },
        });
      }),
      releaseOrderClaim: vi.fn(async () => {
        throw Object.assign(new Error("demand returned"), {
          code: "ORDER_STILL_HAS_CLAIMABLE_DEMAND",
        });
      }),
    };
    const legacy = fakeLegacy();
    const service = new AuthorityAwareReservationService(executor({
      authority: "canonical",
      legacy,
      canonical,
      getLatestClaim: vi.fn(async () => ({ claimId: "70", revision: 3, status: "active", plan })),
    }));

    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:903",
      demandChanged: true,
      reason: "concurrent demand change",
    })).rejects.toMatchObject({
      code: "CANONICAL_DEMAND_RECONCILIATION_FAILED",
      context: expect.objectContaining({
        orderId: 42,
        sourceEventId: "webhook_inbox:903",
        causeCode: "ORDER_STILL_HAS_CLAIMABLE_DEMAND",
      }),
    });
    await expect(service.reconcileRefundOrderDemand({
      orderId: 42,
      sourceEventId: "refund:903",
      releaseTargets: [{ orderItemId: 11, quantity: 1 }],
      reason: "concurrent refund demand change",
    })).rejects.toMatchObject({
      code: "CANONICAL_DEMAND_RECONCILIATION_FAILED",
      context: expect.objectContaining({
        orderId: 42,
        sourceEventId: "refund:903",
        causeCode: "ORDER_STILL_HAS_CLAIMABLE_DEMAND",
      }),
    });
    expect(legacy.reconcileOrderDemand).not.toHaveBeenCalled();
    expect(legacy.reconcileRefundOrderDemand).not.toHaveBeenCalled();
  });

  it("rejects a caller-owned transaction after canonical cutover", async () => {
    const service = new AuthorityAwareReservationService(executor({ authority: "canonical" }));

    await expect(service.reserveOrder(42, undefined, {})).rejects.toMatchObject({
      code: "CANONICAL_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
    });
    await expect(service.reconcileCycleCountInventory({
      cycleCountId: 8,
      cycleCountItemId: 81,
      productVariantId: 101,
      warehouseLocationId: 7,
      countedQty: 4,
      reasonCode: "shrinkage",
      actor: "user:7",
      reason: "approved physical count",
      dbOverride: {},
    })).rejects.toMatchObject({
      code: "CANONICAL_EXTERNAL_CYCLE_COUNT_TRANSACTION_UNSUPPORTED",
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
    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:904",
      demandChanged: true,
      reason: "order edited",
      dbOverride: {},
    })).rejects.toMatchObject({
      code: "CANONICAL_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
    });
    await expect(service.reconcileRefundOrderDemand({
      orderId: 42,
      sourceEventId: "refund:904",
      releaseTargets: [{ orderItemId: 11, quantity: 1 }],
      reason: "refund",
      dbOverride: {},
    })).rejects.toMatchObject({
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
        replaceOrderClaim: vi.fn(),
        releaseOrderClaim: vi.fn(),
        reconcileCycleCount: vi.fn(),
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
    reconcileRefundOrderDemand: vi.fn(async (command) => ({
      releasedReservationQuantity: command.releaseTargets.reduce(
        (total, target) => total + target.quantity,
        0,
      ),
    })),
    reconcileCycleCountInventory: vi.fn(async (command) => ({
      outcome: "cycle_count_reconciled" as const,
      cycleCountId: command.cycleCountId,
      cycleCountItemId: command.cycleCountItemId,
      productVariantId: command.productVariantId,
      warehouseLocationId: command.warehouseLocationId,
      quantityBefore: command.countedQty,
      quantityAfter: command.countedQty,
      quantityDelta: 0,
      adjustmentTransactionId: null,
      displacedOrderIds: [],
      idempotentReplay: false,
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
