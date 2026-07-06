import { describe, it, expect, vi } from "vitest";
import { createManualSyncRunner, type ManualSyncServices } from "../../manual-sync-runner";

function makeServices(overrides: Partial<Record<string, any>> = {}): ManualSyncServices {
  return {
    echelonOrchestrator: {
      runFullSync: vi.fn().mockResolvedValue({
        inventory: [
          {
            channelId: 1,
            channelName: "Shopify DTC",
            variantsPushed: 3,
            variantsErrored: 1,
            details: [
              { sku: "A", variantId: 10, previousQty: 5, allocatedQty: 7, status: "success" },
              { sku: "B", variantId: 11, previousQty: null, allocatedQty: 2, status: "error", error: "boom" },
            ],
          },
        ],
      }),
      ...overrides.echelonOrchestrator,
    },
    syncSettings: {
      writeSyncLog: vi.fn().mockResolvedValue(undefined),
      updateLastSweep: vi.fn().mockResolvedValue(undefined),
      ...overrides.syncSettings,
    },
  } as ManualSyncServices;
}

describe("manual sync runner", () => {
  it("returns immediately and completes the sweep in the background", async () => {
    let now = 1_000;
    const runner = createManualSyncRunner(() => now);
    const services = makeServices();

    expect(runner.trigger(services)).toBe("started");
    expect(runner.getStatus().running).toBe(true);

    now = 43_000; // 42s sweep — longer than Heroku's 30s router limit
    await runner.whenIdle();

    const status = runner.getStatus();
    expect(status.running).toBe(false);
    expect(status.lastError).toBeNull();
    expect(status.lastResult).toEqual({ channels: 1, pushed: 3, errors: 1, durationMs: 42_000 });
    expect((services.syncSettings.updateLastSweep as any)).toHaveBeenCalledWith(42_000);
    // one log line per detail, stamped as a manual run
    expect((services.syncSettings.writeSyncLog as any)).toHaveBeenCalledTimes(2);
    expect((services.syncSettings.writeSyncLog as any).mock.calls[0][0]).toMatchObject({
      action: "inventory_push",
      source: "manual",
      status: "pushed",
    });
    expect((services.syncSettings.writeSyncLog as any).mock.calls[1][0]).toMatchObject({
      status: "error",
      errorMessage: "boom",
    });
  });

  it("refuses to overlap manual sweeps", async () => {
    const runner = createManualSyncRunner(() => 0);
    let release!: () => void;
    const services = makeServices({
      echelonOrchestrator: {
        runFullSync: vi.fn().mockReturnValue(
          new Promise((resolve) => {
            release = () => resolve({ inventory: [] });
          }),
        ),
      },
    });

    expect(runner.trigger(services)).toBe("started");
    expect(runner.trigger(services)).toBe("already_running");

    release();
    await runner.whenIdle();
    expect(runner.trigger(services)).toBe("started"); // idle again → allowed
  });

  it("surfaces a background failure via status instead of swallowing it", async () => {
    const runner = createManualSyncRunner(() => 0);
    const services = makeServices({
      echelonOrchestrator: {
        runFullSync: vi.fn().mockRejectedValue(new Error("orchestrator exploded")),
      },
    });

    runner.trigger(services);
    await runner.whenIdle();

    const status = runner.getStatus();
    expect(status.running).toBe(false);
    expect(status.lastError).toBe("orchestrator exploded");
    expect(status.lastResult).toBeNull();
  });

  it("a failed sweep does not wedge the runner", async () => {
    const runner = createManualSyncRunner(() => 0);
    const failing = makeServices({
      echelonOrchestrator: { runFullSync: vi.fn().mockRejectedValue(new Error("nope")) },
    });
    runner.trigger(failing);
    await runner.whenIdle();

    const healthy = makeServices();
    expect(runner.trigger(healthy)).toBe("started");
    await runner.whenIdle();
    expect(runner.getStatus().lastError).toBeNull();
    expect(runner.getStatus().lastResult?.pushed).toBe(3);
  });
});
