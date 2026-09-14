import { describe, expect, it, vi } from "vitest";

import { createSyncSettingsService } from "../../sync-settings.service";

function settings(globalEnabled: boolean) {
  return {
    id: 1,
    singletonKey: true,
    globalEnabled,
    sweepIntervalMinutes: 15,
    revision: 7n,
    changedBy: "operator-1",
    changeReason: "Reviewed state",
    lastSweepAt: null,
    lastSweepDurationMs: null,
    createdAt: new Date("2026-09-14T00:00:00.000Z"),
    updatedAt: new Date("2026-09-14T00:00:00.000Z"),
  };
}

function selectWithLimit(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({ limit: vi.fn(async () => rows) }),
    }),
  };
}

function selectWhere(rows: unknown[]) {
  return {
    from: () => ({ where: vi.fn(async () => rows) }),
  };
}

describe("SyncSettingsService exact effective legacy state", () => {
  it("serializes the singleton revision without losing bigint precision", async () => {
    const db = { select: vi.fn(() => selectWithLimit([settings(true)])) };

    await expect(createSyncSettingsService(db).getGlobalSettings()).resolves.toMatchObject({
      globalEnabled: true,
      revision: "7",
    });
  });

  it("fails closed when more than one global row is observed", async () => {
    const db = { select: vi.fn(() => selectWithLimit([settings(true), { ...settings(false), id: 2 }])) };

    await expect(createSyncSettingsService(db).getGlobalSettings()).rejects.toThrow(
      "Exactly one global sync-settings row is required",
    );
  });

  it("fails closed without mutating when the global singleton is missing", async () => {
    const insert = vi.fn();
    const db = { select: vi.fn(() => selectWithLimit([])), insert };

    await expect(createSyncSettingsService(db).getGlobalSettings()).rejects.toThrow(
      "Exactly one global sync-settings row is required",
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("resolves live, dry-run, disabled, and malformed active channels exactly", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(selectWithLimit([settings(true)]))
        .mockReturnValueOnce(selectWhere([
          { id: 1, name: "Shopify", provider: "shopify", syncEnabled: true, syncMode: "live" },
          { id: 2, name: "eBay", provider: "ebay", syncEnabled: true, syncMode: "dry_run" },
          { id: 3, name: "Paused", provider: "shopify", syncEnabled: false, syncMode: "live" },
          { id: 4, name: "Malformed", provider: "ebay", syncEnabled: true, syncMode: "surprise" },
        ])),
    };

    await expect(createSyncSettingsService(db).listEffectiveSyncStates()).resolves.toEqual([
      { channelId: 1, channelName: "Shopify", provider: "shopify", shouldSync: true, dryRun: false, reason: "Live sync active" },
      { channelId: 2, channelName: "eBay", provider: "ebay", shouldSync: true, dryRun: true, reason: "Channel in dry-run mode" },
      { channelId: 3, channelName: "Paused", provider: "shopify", shouldSync: false, dryRun: false, reason: "Channel sync disabled" },
      { channelId: 4, channelName: "Malformed", provider: "ebay", shouldSync: false, dryRun: false, reason: "Channel sync mode invalid" },
    ]);
  });

  it("marks every active legacy channel stopped when global publication is off", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(selectWithLimit([settings(false)]))
        .mockReturnValueOnce(selectWhere([
          { id: 1, name: "Shopify", provider: "shopify", syncEnabled: true, syncMode: "live" },
        ])),
    };

    await expect(createSyncSettingsService(db).listEffectiveSyncStates()).resolves.toEqual([
      { channelId: 1, channelName: "Shopify", provider: "shopify", shouldSync: false, dryRun: false, reason: "Global sync disabled" },
    ]);
  });
});
