import { describe, expect, it, vi } from "vitest";

import { InventoryPublicationWorkCoordinator } from "../../application/inventory-publication-work-coordinator.service";

const GLOBAL_ON = {
  id: 1,
  singletonKey: true,
  globalEnabled: true,
  sweepIntervalMinutes: 15,
  revision: "1",
  changedBy: "migration",
  changeReason: "test",
  lastSweepAt: null,
  lastSweepDurationMs: null,
  createdAt: new Date("2026-09-14T00:00:00.000Z"),
  updatedAt: new Date("2026-09-14T00:00:00.000Z"),
};

function channel(channelId: number, overrides: Record<string, unknown> = {}) {
  return {
    channelId,
    channelName: `Channel ${channelId}`,
    provider: "shopify",
    shouldSync: true,
    dryRun: false,
    reason: "Live sync active",
    ...overrides,
  };
}

function result(channelId: number) {
  return {
    channelId,
    channelName: `Channel ${channelId}`,
    dryRun: false,
    products: 1,
    variantsPushed: 1,
    variantsSkipped: 0,
    variantsErrored: 0,
    details: [],
  };
}

function setup(input: {
  globalEnabled?: boolean;
  authority?: "legacy" | "canonical";
  states?: ReturnType<typeof channel>[];
} = {}) {
  const authority = { readAuthority: vi.fn(async () => input.authority ?? "legacy" as const) };
  const effectiveState = {
    getGlobalSettings: vi.fn(async () => ({
      ...GLOBAL_ON,
      globalEnabled: input.globalEnabled ?? true,
    })),
    listEffectiveSyncStates: vi.fn(async () => input.states ?? [channel(1)]),
  };
  const orchestrator = {
    syncInventoryForProduct: vi.fn(async () => [result(99)]),
    syncInventoryForChannelProduct: vi.fn(async (channelId: number) => [result(channelId)]),
    syncInventoryForAllProducts: vi.fn(async (_config: unknown, _trigger: string, channelId?: number) => [
      result(channelId ?? 99),
    ]),
  };
  return {
    authority,
    effectiveState,
    orchestrator,
    coordinator: new InventoryPublicationWorkCoordinator(authority, effectiveState, orchestrator),
  };
}

describe("InventoryPublicationWorkCoordinator", () => {
  it("creates no work while the durable global stop is active", async () => {
    const test = setup({ globalEnabled: false, authority: "canonical" });

    await expect(test.coordinator.syncAllProducts("scheduled_sync")).resolves.toEqual({
      authority: null,
      inventory: [],
      skippedReason: "PUBLICATION_GLOBAL_STOP_ACTIVE",
    });
    expect(test.authority.readAuthority).not.toHaveBeenCalled();
    expect(test.effectiveState.listEffectiveSyncStates).not.toHaveBeenCalled();
    expect(test.orchestrator.syncInventoryForAllProducts).not.toHaveBeenCalled();
  });

  it("uses canonical authority once and never consults legacy channel flags", async () => {
    const test = setup({
      authority: "canonical",
      states: [channel(1, { shouldSync: false, reason: "Channel sync disabled" })],
    });

    await expect(test.coordinator.syncProduct(42, "inventory_changed")).resolves.toMatchObject({
      authority: "canonical",
      skippedReason: null,
    });
    expect(test.orchestrator.syncInventoryForProduct).toHaveBeenCalledWith(
      42,
      { dryRun: false },
      "inventory_changed",
    );
    expect(test.effectiveState.listEffectiveSyncStates).not.toHaveBeenCalled();
    expect(test.orchestrator.syncInventoryForChannelProduct).not.toHaveBeenCalled();
  });

  it("runs only exact effective legacy channels with each channel's resolved mode", async () => {
    const test = setup({ states: [
      channel(1),
      channel(2, { dryRun: true, reason: "Channel in dry-run mode" }),
      channel(3, { shouldSync: false, reason: "Channel sync disabled" }),
      channel(4, { shouldSync: false, reason: "Channel sync mode invalid" }),
    ] });

    const resolved = await test.coordinator.syncProduct(42, "inventory_changed");

    expect(resolved.inventory.map((item) => item.channelId)).toEqual([1, 2]);
    expect(test.orchestrator.syncInventoryForChannelProduct.mock.calls).toEqual([
      [1, 42, { dryRun: false }, "inventory_changed"],
      [2, 42, { dryRun: true }, "inventory_changed"],
    ]);
    expect(test.orchestrator.syncInventoryForProduct).not.toHaveBeenCalled();
  });

  it("does not let a selected disabled legacy channel broaden into another channel", async () => {
    const test = setup({ states: [
      channel(1),
      channel(2, { shouldSync: false, reason: "Channel sync disabled" }),
    ] });

    await expect(test.coordinator.syncChannelProducts(2, "manual_channel_sync")).resolves.toEqual({
      authority: "legacy",
      inventory: [],
      skippedReason: "Channel sync disabled",
    });
    expect(test.orchestrator.syncInventoryForAllProducts).not.toHaveBeenCalled();
  });

  it("scopes a canonical channel request without reading obsolete legacy state", async () => {
    const test = setup({ authority: "canonical" });

    await test.coordinator.syncChannelProducts(8, "manual_channel_sync");

    expect(test.orchestrator.syncInventoryForAllProducts).toHaveBeenCalledWith(
      { dryRun: false },
      "manual_channel_sync",
      8,
    );
    expect(test.effectiveState.listEffectiveSyncStates).not.toHaveBeenCalled();
  });

  it("rejects invalid identifiers before any state read or work creation", async () => {
    const test = setup();

    await expect(test.coordinator.syncProduct(0, "bad_input")).rejects.toThrow(
      "productId must be a positive PostgreSQL integer",
    );
    await expect(test.coordinator.syncChannelProducts(Number.NaN, "bad_input")).rejects.toThrow(
      "channelId must be a positive PostgreSQL integer",
    );
    expect(test.effectiveState.getGlobalSettings).not.toHaveBeenCalled();
  });
});
