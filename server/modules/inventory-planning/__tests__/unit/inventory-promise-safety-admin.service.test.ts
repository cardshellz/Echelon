import { describe, expect, it, vi } from "vitest";

import {
  InventoryPromiseSafetyAdminService,
  type InventoryPromiseSafetyAdminStore,
} from "../../application/inventory-promise-safety-admin.service";

const CALCULATED_AT = new Date("2026-08-30T12:30:00.000Z");

describe("InventoryPromiseSafetyAdminService", () => {
  it("creates a complete deterministic demand refresh command", async () => {
    const store = fakeStore();
    store.refreshDemandEvidence.mockImplementation(async (command) => ({
      productId: command.productId,
      methodVersion: "irreversible_consumption_v1_28d",
      windowStartedAt: command.windowStartedAt.toISOString(),
      windowEndedAt: command.windowEndedAt.toISOString(),
      calculatedAt: command.calculatedAt.toISOString(),
      createdSnapshots: 2,
      reusedSnapshots: 0,
      trustedSnapshots: 1,
      untrustedSnapshots: 1,
      alreadyApplied: false,
    }));
    const service = new InventoryPromiseSafetyAdminService(store, { now: () => CALCULATED_AT });

    await service.refreshDemandEvidence(10, {
      changeReason: "Recalculate after review",
      idempotencyKey: "demand-refresh-1",
    }, "operator-1");

    expect(store.refreshDemandEvidence).toHaveBeenCalledWith(expect.objectContaining({
      productId: 10,
      actorId: "operator-1",
      changeReason: "Recalculate after review",
      idempotencyKey: "demand-refresh-1",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      windowStartedAt: new Date("2026-08-02T00:00:00.000Z"),
      windowEndedAt: new Date("2026-08-30T00:00:00.000Z"),
      calculatedAt: CALCULATED_AT,
    }));
  });

  it("forwards optimistic draft evidence and an auditable request hash", async () => {
    const store = fakeStore();
    store.updatePromiseSafetyPolicyDraft.mockResolvedValue({
      policyId: 5,
      version: 2,
      scopeKey: "network:variant:101",
      definitionHash: "b".repeat(64),
      alreadyApplied: false,
    });
    const service = new InventoryPromiseSafetyAdminService(store, { now: () => CALCULATED_AT });

    await service.updatePolicyDraft(5, {
      expectedVersion: 2,
      expectedDefinitionHash: "a".repeat(64),
      expectedHeadRevision: "4",
      value: { policyMode: "fixed_units", fixedUnits: 7 },
      changeReason: "Protect seven units",
      idempotencyKey: "safety-update-1",
    }, "operator-1");

    expect(store.updatePromiseSafetyPolicyDraft).toHaveBeenCalledWith(expect.objectContaining({
      policyId: 5,
      expectedVersion: 2,
      expectedDefinitionHash: "a".repeat(64),
      expectedHeadRevision: "4",
      actorId: "operator-1",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      occurredAt: CALCULATED_AT,
    }));
  });

  it("rejects an invalid policy identifier before reaching persistence", async () => {
    const store = fakeStore();
    const service = new InventoryPromiseSafetyAdminService(store, { now: () => CALCULATED_AT });

    await expect(service.updatePolicyDraft(0, {
      expectedVersion: 2,
      expectedDefinitionHash: "a".repeat(64),
      expectedHeadRevision: "4",
      value: { policyMode: "off" },
      changeReason: "Disable the floor",
      idempotencyKey: "safety-update-invalid",
    }, "operator-1")).rejects.toMatchObject({
      code: "INVENTORY_PROMISE_SAFETY_INVALID_POLICY_ID",
    });
    expect(store.updatePromiseSafetyPolicyDraft).not.toHaveBeenCalled();
  });
});

function fakeStore() {
  return {
    getPromiseSafetyAdminView: vi.fn<InventoryPromiseSafetyAdminStore["getPromiseSafetyAdminView"]>(),
    refreshDemandEvidence: vi.fn<InventoryPromiseSafetyAdminStore["refreshDemandEvidence"]>(),
    updatePromiseSafetyPolicyDraft: vi.fn<InventoryPromiseSafetyAdminStore["updatePromiseSafetyPolicyDraft"]>(),
  };
}
