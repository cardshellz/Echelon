import { describe, expect, it, vi } from "vitest";

import {
  InventoryAvailabilityActivationService,
  InventoryAvailabilityActivationServiceError,
} from "../../application/inventory-availability-activation.service";

const HASH = "a".repeat(64);
const NOW = new Date("2026-09-01T18:00:00.000Z");

describe("InventoryAvailabilityActivationService", () => {
  it("creates a deterministic role-attributed prepare command", async () => {
    const store = storeMock();
    const service = new InventoryAvailabilityActivationService(store, { now: () => NOW });
    const request = {
      sourceDryRunId: "7",
      expectedDryRunResultHash: HASH,
      idempotencyKey: "prepare-1",
      reason: "Conservatively prepare the reviewed catalog",
    };

    await service.prepare(request, "operator-1");

    expect(store.prepare).toHaveBeenCalledWith(expect.objectContaining({
      ...request,
      actor: "operator-1",
      occurredAt: NOW,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("requires a reason and valid source dry-run evidence", async () => {
    const service = new InventoryAvailabilityActivationService(storeMock(), { now: () => NOW });

    await expect(service.prepare({ sourceDryRunId: "0" }, "operator-1"))
      .rejects.toEqual(expect.objectContaining<Partial<InventoryAvailabilityActivationServiceError>>({
        status: 400,
        code: "INVENTORY_AVAILABILITY_INVALID_ACTIVATION_PREPARE",
      }));
  });

  it("supports an idempotent pre-authority abort command", async () => {
    const store = storeMock();
    const service = new InventoryAvailabilityActivationService(store, { now: () => NOW });
    const request = {
      activationRunId: "12",
      idempotencyKey: "abort-1",
      reason: "Stop before runtime authority cutover",
    };

    await service.abort(request, "operator-1");

    expect(store.abort).toHaveBeenCalledWith(expect.objectContaining({
      ...request,
      actor: "operator-1",
      occurredAt: NOW,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("returns the durable open preparation after an operator reload", async () => {
    const service = new InventoryAvailabilityActivationService(storeMock(), { now: () => NOW });

    await expect(service.getOpenStatus()).resolves.toEqual(expect.objectContaining({
      activationRunId: "12",
      state: "publishing",
      runtimeAuthority: "legacy",
    }));
  });
});

function storeMock() {
  return {
    prepare: vi.fn(async () => ({
      activationRunId: "12",
      commandType: "prepare" as const,
      state: "publishing" as const,
      sourceDryRunId: "7",
      revalidationDryRunId: null,
      conservativePublicationRows: 1,
      fullPublicationRows: 0,
      runtimeAuthority: "legacy" as const,
      alreadyApplied: false,
    })),
    abort: vi.fn(async () => ({
      activationRunId: "12",
      commandType: "abort" as const,
      state: "failed" as const,
      sourceDryRunId: "7",
      revalidationDryRunId: null,
      conservativePublicationRows: 1,
      fullPublicationRows: 0,
      runtimeAuthority: "legacy" as const,
      alreadyApplied: false,
    })),
    getStatus: vi.fn(async () => ({
      activationRunId: "12",
      state: "publishing" as const,
      sourceDryRunId: "7",
      runtimeAuthority: "legacy" as const,
      providerWriteAttempted: false,
      configurationFrozen: true,
      outbox: {
        total: 1,
        queued: 1,
        leased: 0,
        verified: 0,
        retryableOrDrifted: 0,
        deadLetter: 0,
        cancelled: 0,
      },
    })),
    getOpenStatus: vi.fn(async () => ({
      activationRunId: "12",
      state: "publishing" as const,
      sourceDryRunId: "7",
      runtimeAuthority: "legacy" as const,
      providerWriteAttempted: false,
      configurationFrozen: true,
      outbox: {
        total: 1,
        queued: 1,
        leased: 0,
        verified: 0,
        retryableOrDrifted: 0,
        deadLetter: 0,
        cancelled: 0,
      },
    })),
  };
}
