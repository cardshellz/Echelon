import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";

import {
  InventoryAvailabilityRuntimeAtpError,
  type InventoryAvailabilityRuntimeAtpExecutor,
} from "../../application/inventory-availability-runtime-atp.service";
import {
  INVENTORY_LEGACY_ADMIN_CONTROLS,
  InventoryLegacyAdminControlService,
} from "../../application/inventory-legacy-admin-control.service";
import { sendInventoryLegacyAdminControlError } from "../../interfaces/http/inventory-legacy-admin-control.error";

describe("InventoryLegacyAdminControlService", () => {
  it("runs the existing writer on the transaction that pins legacy authority", async () => {
    const work = vi.fn(async (received: typeof transaction) => ({ id: 91, received }));
    const service = new InventoryLegacyAdminControlService(executor("legacy"));

    await expect(service.executeLegacyWrite(
      INVENTORY_LEGACY_ADMIN_CONTROLS.channelAllocation,
      work,
    )).resolves.toEqual({ id: 91, received: transaction });

    expect(work).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledWith(transaction);
  });

  it("rejects a legacy writer before it can mutate data under canonical authority", async () => {
    const work = vi.fn(async () => ({ id: 91 }));
    const service = new InventoryLegacyAdminControlService(executor("canonical"));

    await expect(service.executeLegacyWrite(
      INVENTORY_LEGACY_ADMIN_CONTROLS.channelAllocation,
      work,
    )).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_LEGACY_CONTROL_NOT_AUTHORITATIVE",
      context: {
        authority: "canonical",
        authorityRevision: "9",
        activationRunId: "44",
        controlKind: "channel_allocation",
        operation: "legacy_channel_allocation_configuration",
        replacementEndpoint: "/api/inventory-planning/admin/channel-exposure/policy-draft",
      },
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("allows a proven no-op payload under canonical authority without authorizing a legacy mutation", async () => {
    const work = vi.fn(async () => ({ id: 91, changed: false }));
    const service = new InventoryLegacyAdminControlService(executor("canonical"));

    await expect(service.executeGuardedLegacyWrite(
      INVENTORY_LEGACY_ADMIN_CONTROLS.inventoryStrategy,
      work,
    )).resolves.toEqual({ id: 91, changed: false });

    expect(work).toHaveBeenCalledOnce();
  });

  it("rejects a real guarded mutation under canonical authority at the assertion boundary", async () => {
    const mutation = vi.fn();
    const service = new InventoryLegacyAdminControlService(executor("canonical"));

    await expect(service.executeGuardedLegacyWrite(
      INVENTORY_LEGACY_ADMIN_CONTROLS.inventoryStrategy,
      async (guard) => {
        guard.assertLegacyMutation();
        mutation();
      },
    )).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_LEGACY_CONTROL_NOT_AUTHORITATIVE",
    });

    expect(mutation).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy", "legacy result"],
    ["canonical", "canonical result"],
  ] as const)("selects only the %s read implementation", async (authority, expected) => {
    const legacy = vi.fn(async () => "legacy result");
    const canonical = vi.fn(async () => "canonical result");
    const service = new InventoryLegacyAdminControlService(executor(authority));

    await expect(service.executeAuthorityAwareRead({ legacy, canonical })).resolves.toBe(expected);
    expect(legacy).toHaveBeenCalledTimes(authority === "legacy" ? 1 : 0);
    expect(canonical).toHaveBeenCalledTimes(authority === "canonical" ? 1 : 0);
  });

  it("retires a legacy allocation read before its scalar ATP path runs", async () => {
    const work = vi.fn(async () => "legacy grid");
    const service = new InventoryLegacyAdminControlService(executor("canonical"));

    await expect(service.executeLegacyRead(
      INVENTORY_LEGACY_ADMIN_CONTROLS.channelAllocationRead,
      work,
    )).rejects.toMatchObject({
      status: 410,
      code: "INVENTORY_LEGACY_ADMIN_READ_RETIRED",
      context: expect.objectContaining({
        replacementEndpoint: "/api/inventory-planning/admin/channel-exposure",
      }),
    });
    expect(work).not.toHaveBeenCalled();
  });
});

describe("sendInventoryLegacyAdminControlError", () => {
  it("writes the complete structured canonical-control conflict", async () => {
    const service = new InventoryLegacyAdminControlService(executor("canonical"));
    const error = await service.executeLegacyWrite(
      INVENTORY_LEGACY_ADMIN_CONTROLS.inventoryStrategy,
      vi.fn(async () => undefined),
    ).catch((caught) => caught);
    const response = fakeResponse();

    expect(sendInventoryLegacyAdminControlError(response.value, error)).toBe(true);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: "INVENTORY_LEGACY_CONTROL_NOT_AUTHORITATIVE",
        message: "This legacy inventory control is read-only after canonical inventory authority activation.",
        context: expect.objectContaining({
          controlKind: "inventory_strategy",
          authorityRevision: "9",
          activationRunId: "44",
        }),
      },
    });
  });

  it("classifies an invalid runtime authority as a structured unavailable response", () => {
    const response = fakeResponse();
    const error = new InventoryAvailabilityRuntimeAtpError(
      "INVENTORY_ATP_RUNTIME_AUTHORITY_INVALID",
      "The authority singleton is invalid.",
      { authority: "unexpected" },
    );

    expect(sendInventoryLegacyAdminControlError(response.value, error)).toBe(true);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: "INVENTORY_ATP_RUNTIME_AUTHORITY_INVALID",
        message: "The authority singleton is invalid.",
        context: { authority: "unexpected" },
      },
    });
  });

  it("leaves unrelated failures to the owning route", () => {
    const response = fakeResponse();
    expect(sendInventoryLegacyAdminControlError(response.value, new Error("boom"))).toBe(false);
    expect(response.status).not.toHaveBeenCalled();
  });
});

const transaction = Object.freeze({ id: "pinned-transaction" });

function executor(
  authority: "legacy" | "canonical",
): InventoryAvailabilityRuntimeAtpExecutor<typeof transaction> {
  return {
    execute: (work) => work({
      authority,
      authorityRevision: "9",
      activationRunId: authority === "canonical" ? "44" : null,
      legacy: {} as never,
      captureActiveSupplySnapshot: vi.fn(),
      getProductIdsByVariantIds: vi.fn(),
    }, transaction),
  };
}

function fakeResponse() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return {
    value: { status } as unknown as Response,
    status,
    json,
  };
}
