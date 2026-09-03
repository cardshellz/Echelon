import { describe, expect, it, vi } from "vitest";

import type {
  CanonicalAvailabilityClaimBuildHandoffResult,
  CanonicalAvailabilityClaimOperationExecutionResult,
  CanonicalAvailabilityClaimPickResult,
  CanonicalAvailabilityClaimReplacementResult,
  CanonicalAvailabilityClaimResult,
} from "@shared/types/inventory-availability-claims";

import type { InventoryAvailabilityClaimStore } from "../../application/inventory-availability-claim.port";
import {
  InventoryAvailabilityClaimService,
  InventoryAvailabilityClaimServiceError,
} from "../../application/inventory-availability-claim.service";

const noClaimResult: CanonicalAvailabilityClaimResult = {
  outcome: "no_claim_required",
  orderId: 70,
  idempotentReplay: false,
};

const replacementResult: CanonicalAvailabilityClaimReplacementResult = {
  outcome: "replaced",
  orderId: 70,
  supersededClaimId: "9",
  supersededClaimKey: "order:70:availability:revision:1",
  supersededRevision: 1,
  replacementClaim: {
    claimId: "10",
    claimKey: "order:70:availability:revision:2",
    revision: 2,
    runtimeAuthorityRevision: "3",
    plan: {
      requestKey: "order:70:availability:revision:2",
      scope: { kind: "warehouse", warehouseId: 1 },
      status: "satisfied",
      lines: [{
        lineKey: "order-item:71",
        targetVariantId: 101,
        requestedQty: "2",
        plannedQty: "2",
        shortfallQty: "0",
      }],
      resourceClaims: [],
      operations: [],
      fulfillmentGroups: [],
      modelEvidence: [],
      blockers: [],
      snapshotFingerprint: "a".repeat(64),
    },
  },
  releasedResourceQty: "3",
  releasedLotQty: "3",
  idempotentReplay: false,
};

const executionResult: CanonicalAvailabilityClaimOperationExecutionResult = {
  outcome: "executed",
  claimId: "10",
  claimOperationId: "11",
  operationKey: "operation:11",
  outputResourceId: "12",
  producedQty: "2",
  committedQty: "2",
  surplusQty: "0",
  totalInputCostMills: "1500",
  idempotentReplay: false,
};

const handoffResult: CanonicalAvailabilityClaimBuildHandoffResult = {
  outcome: "build_handed_off",
  claimId: "10",
  claimOperationId: "11",
  operationKey: "operation:11",
  buildOrderId: 80,
  buildSystemNumber: "BLD-80",
  adoptedReservationQty: "2",
  idempotentReplay: false,
};

const pickResult: CanonicalAvailabilityClaimPickResult = {
  outcome: "picked",
  claimId: "10",
  claimLineId: "13",
  orderId: 70,
  orderItemId: 71,
  warehouseLocationIds: [5],
  quantity: "1",
  reconciledQuantity: "0",
  totalCostMills: "750",
  idempotentReplay: false,
};

const unpickResult: CanonicalAvailabilityClaimPickResult = {
  outcome: "unpicked",
  claimId: "10",
  claimLineId: "13",
  orderId: 70,
  orderItemId: 71,
  warehouseLocationIds: [5],
  quantity: "1",
  reservationRestored: true,
  totalCostMills: "750",
  idempotentReplay: false,
};

const audit = {
  idempotencyKey: "event:order-70:1",
  actor: "oms-order-sync",
  reason: "Accepted order demand changed",
};

function makeStore(): InventoryAvailabilityClaimStore {
  return {
    claimOrder: vi.fn(async () => noClaimResult),
    replaceOrderClaim: vi.fn(async () => replacementResult),
    releaseOrderClaim: vi.fn(async () => noClaimResult),
    executePackageOperation: vi.fn(async () => executionResult),
    executeBuildOperation: vi.fn(async () => executionResult),
    handoffBuildOperation: vi.fn(async () => handoffResult),
    pickClaimLine: vi.fn(async () => pickResult),
    unpickClaimLine: vi.fn(async () => unpickResult),
  };
}

describe("InventoryAvailabilityClaimService", () => {
  it("validates and delegates every canonical claim lifecycle command", async () => {
    const store = makeStore();
    const service = new InventoryAvailabilityClaimService(store);

    await expect(service.claimOrder({ orderId: 70, ...audit })).resolves.toEqual(noClaimResult);
    await expect(service.replaceOrderClaim({
      orderId: 70,
      expectedClaimId: "9",
      ...audit,
    })).resolves.toEqual(replacementResult);
    await expect(service.releaseOrderClaim({
      orderId: 70,
      disposition: "cancel",
      ...audit,
    })).resolves.toEqual(noClaimResult);
    await expect(service.executePackageOperation({
      claimId: "10",
      operationKey: "operation:11",
      ...audit,
    })).resolves.toEqual(executionResult);
    await expect(service.executeBuildOperation({
      claimId: "10",
      operationKey: "operation:11",
      ...audit,
    })).resolves.toEqual(executionResult);
    await expect(service.handoffBuildOperation({
      claimId: "10",
      operationKey: "operation:11",
      ...audit,
    })).resolves.toEqual(handoffResult);
    await expect(service.pickClaimLine({
      claimId: "10",
      orderItemId: 71,
      warehouseLocationId: 5,
      quantity: "1",
      locationStrategy: "strict",
      ...audit,
    })).resolves.toEqual(pickResult);
    await expect(service.unpickClaimLine({
      claimId: "10",
      orderItemId: 71,
      quantity: "1",
      ...audit,
    })).resolves.toEqual(unpickResult);

    expect(store.claimOrder).toHaveBeenCalledWith({ orderId: 70, ...audit });
    expect(store.replaceOrderClaim).toHaveBeenCalledWith({
      orderId: 70,
      expectedClaimId: "9",
      ...audit,
    });
    expect(store.releaseOrderClaim).toHaveBeenCalledWith({
      orderId: 70,
      disposition: "cancel",
      ...audit,
    });
    expect(store.executePackageOperation).toHaveBeenCalledTimes(1);
    expect(store.executeBuildOperation).toHaveBeenCalledTimes(1);
    expect(store.handoffBuildOperation).toHaveBeenCalledTimes(1);
    expect(store.pickClaimLine).toHaveBeenCalledTimes(1);
    expect(store.unpickClaimLine).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed commands before invoking the store", async () => {
    const store = makeStore();
    const service = new InventoryAvailabilityClaimService(store);

    await expect(service.replaceOrderClaim({
      orderId: 70,
      expectedClaimId: "0",
      ...audit,
      unexpected: true,
    })).rejects.toEqual(expect.objectContaining<Partial<InventoryAvailabilityClaimServiceError>>({
      code: "INVALID_CANONICAL_CLAIM_COMMAND",
      context: expect.objectContaining({ operation: "replace_order_claim" }),
    }));
    expect(store.replaceOrderClaim).not.toHaveBeenCalled();
  });

  it("fails closed when a store returns an invalid result", async () => {
    const store = makeStore();
    store.claimOrder = vi.fn(async () => ({ outcome: "claimed", orderId: 70 }) as never);
    const service = new InventoryAvailabilityClaimService(store);

    await expect(service.claimOrder({ orderId: 70, ...audit })).rejects.toEqual(
      expect.objectContaining<Partial<InventoryAvailabilityClaimServiceError>>({
        code: "INVALID_CANONICAL_CLAIM_RESULT",
        context: expect.objectContaining({ operation: "claim_order" }),
      }),
    );
  });

  it("preserves classified store failures for the caller", async () => {
    const store = makeStore();
    const failure = new Error("canonical authority is inactive");
    store.claimOrder = vi.fn(async () => { throw failure; });
    const service = new InventoryAvailabilityClaimService(store);

    await expect(service.claimOrder({ orderId: 70, ...audit })).rejects.toBe(failure);
  });
});
