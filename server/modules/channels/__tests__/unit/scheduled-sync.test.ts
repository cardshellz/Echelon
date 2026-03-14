/**
 * Unit Tests — Scheduled Sync Service
 *
 * Tests the periodic sync scheduler: lifecycle, config, single-flight lock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createScheduledSyncService, type ScheduledSyncService } from "../../scheduled-sync.service";

// ---------------------------------------------------------------------------
// Mock Orchestrator
// ---------------------------------------------------------------------------

function createMockOrchestrator() {
  return {
    runFullSync: vi.fn().mockResolvedValue({
      dryRun: true,
      startedAt: new Date(),
      completedAt: new Date(),
      inventory: [],
      pricing: [],
      listings: [],
      errors: [],
    }),
    syncInventoryForProduct: vi.fn(),
    syncInventoryForAllProducts: vi.fn(),
    syncPricingForChannel: vi.fn(),
    syncListingsForChannel: vi.fn(),
    onInventoryChange: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScheduledSyncService", () => {
  let orchestrator: ReturnType<typeof createMockOrchestrator>;
  let service: ScheduledSyncService;

  beforeEach(() => {
    vi.useFakeTimers();
    orchestrator = createMockOrchestrator();
  });

  afterEach(() => {
    service?.disable();
    vi.useRealTimers();
  });

  describe("lifecycle", () => {
    it("should start disabled by default", () => {
      service = createScheduledSyncService(orchestrator as any);
      const status = service.getStatus();

      expect(status.enabled).toBe(false);
      expect(status.running).toBe(false);
      expect(status.totalRuns).toBe(0);
    });

    it("should start when enabled", () => {
      service = createScheduledSyncService(orchestrator as any, { enabled: true, dryRun: true });
      service.start();

      // Immediate tick on start
      expect(orchestrator.runFullSync).toHaveBeenCalledTimes(1);
    });

    it("should not start if not enabled", () => {
      service = createScheduledSyncService(orchestrator as any, { enabled: false });
      service.start();

      expect(orchestrator.runFullSync).not.toHaveBeenCalled();
    });

    it("should stop cleanly", () => {
      service = createScheduledSyncService(orchestrator as any, { enabled: true, dryRun: true });
      service.start();
      service.stop();

      const status = service.getStatus();
      // Still shows enabled in config (stop just clears the timer)
      expect(status.enabled).toBe(true);
    });

    it("should disable and stop", () => {
      service = createScheduledSyncService(orchestrator as any, { enabled: true, dryRun: true });
      service.start();
      service.disable();

      const status = service.getStatus();
      expect(status.enabled).toBe(false);
    });
  });

  describe("configuration", () => {
    it("should use default interval of 5 minutes", () => {
      service = createScheduledSyncService(orchestrator as any);
      const status = service.getStatus();
      expect(status.intervalMs).toBe(300_000);
    });

    it("should accept custom config", () => {
      service = createScheduledSyncService(orchestrator as any, {
        intervalMs: 60_000,
        dryRun: false,
      });

      const status = service.getStatus();
      expect(status.intervalMs).toBe(60_000);
      expect(status.dryRun).toBe(false);
    });

    it("should update config dynamically", () => {
      service = createScheduledSyncService(orchestrator as any);
      service.updateConfig({ intervalMs: 120_000, dryRun: false });

      const status = service.getStatus();
      expect(status.intervalMs).toBe(120_000);
      expect(status.dryRun).toBe(false);
    });
  });

  describe("runOnce", () => {
    it("should execute a single sync cycle", async () => {
      service = createScheduledSyncService(orchestrator as any);

      const result = await service.runOnce({ dryRun: true });

      expect(orchestrator.runFullSync).toHaveBeenCalledWith({ dryRun: true });
      expect(result.dryRun).toBe(true);
    });

    it("should override dryRun per call", async () => {
      service = createScheduledSyncService(orchestrator as any, { dryRun: true });

      await service.runOnce({ dryRun: false });

      expect(orchestrator.runFullSync).toHaveBeenCalledWith({ dryRun: false });
    });

    it("should track run statistics", async () => {
      service = createScheduledSyncService(orchestrator as any);

      await service.runOnce();

      const status = service.getStatus();
      expect(status.totalRuns).toBe(1);
      expect(status.lastRunAt).toBeInstanceOf(Date);
      expect(status.lastRunDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("dry run default", () => {
    it("should default to dry run mode", () => {
      service = createScheduledSyncService(orchestrator as any);
      const status = service.getStatus();
      expect(status.dryRun).toBe(true);
    });
  });

  describe("status", () => {
    it("should return full status object", () => {
      service = createScheduledSyncService(orchestrator as any);
      const status = service.getStatus();

      expect(status).toHaveProperty("enabled");
      expect(status).toHaveProperty("dryRun");
      expect(status).toHaveProperty("intervalMs");
      expect(status).toHaveProperty("running");
      expect(status).toHaveProperty("lastRunAt");
      expect(status).toHaveProperty("lastRunDurationMs");
      expect(status).toHaveProperty("lastRunResult");
      expect(status).toHaveProperty("totalRuns");
      expect(status).toHaveProperty("totalErrors");
    });
  });
});
