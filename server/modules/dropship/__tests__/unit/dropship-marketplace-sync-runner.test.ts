import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";

const mocks = vi.hoisted(() => ({
  withAdvisoryLock: vi.fn(),
  startDropshipWorkerSchedule: vi.fn(),
  runSweepTick: vi.fn(),
}));
vi.mock("../../../../db", () => ({ db: {}, pool: {}, getDatabasePoolSnapshot: () => null }));
vi.mock("../../../../infrastructure/scheduler-lock", () => ({
  withAdvisoryLock: mocks.withAdvisoryLock,
  getSchedulerLockPoolSnapshot: () => null,
}));
vi.mock("../../infrastructure/dropship-worker-schedule", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-worker-schedule")>()),
  startDropshipWorkerSchedule: mocks.startDropshipWorkerSchedule,
}));
vi.mock("../../infrastructure/dropship-marketplace-sync.factory", () => ({
  createDropshipMarketplaceSyncServiceFromEnv: () => ({ runSweepTick: mocks.runSweepTick }),
}));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { logger } from "../../../../platform/observability/logger";
import {
  DROPSHIP_MARKETPLACE_SYNC_BACK_LOCK_ID,
  isDropshipMarketplaceSyncBackWorkerEnabled,
  resolveDropshipMarketplaceSyncBackIntervalMs,
  startDropshipMarketplaceSyncBackWorker,
} from "../../infrastructure/dropship-marketplace-sync-runner";
import { resolveDropshipWorkerSchedule, type DropshipWorkerScheduleName } from "../../infrastructure/dropship-worker-schedule";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startDropshipWorkerSchedule.mockReturnValue({ handle: { stop: vi.fn() }, initialDelayMs: 300_000 });
  mocks.withAdvisoryLock.mockImplementation(async (_lockId: number, fn: () => Promise<unknown>) => fn());
  mocks.runSweepTick.mockResolvedValue({ stores: 1, reads: 2 });
});

function scheduledRun(): () => Promise<void> {
  expect(mocks.startDropshipWorkerSchedule).toHaveBeenCalledOnce();
  return mocks.startDropshipWorkerSchedule.mock.calls[0][0].run;
}

describe("the eBay sync-back worker (plan v4 §6.1, SB14, SB15)", () => {
  it("is on by default; only an explicit true in either switch turns it off (the kill switch)", () => {
    expect(isDropshipMarketplaceSyncBackWorkerEnabled({})).toBe(true);
    expect(isDropshipMarketplaceSyncBackWorkerEnabled({ DROPSHIP_MARKETPLACE_SYNC_BACK_WORKER_DISABLED: "false", DISABLE_SCHEDULERS: "1" }))
      .toBe(true);
    expect(isDropshipMarketplaceSyncBackWorkerEnabled({ DISABLE_SCHEDULERS: "true" })).toBe(false);
    expect(isDropshipMarketplaceSyncBackWorkerEnabled({ DROPSHIP_MARKETPLACE_SYNC_BACK_WORKER_DISABLED: "true" })).toBe(false);
  });

  it.each([
    ["DISABLE_SCHEDULERS", { DISABLE_SCHEDULERS: "true" }],
    ["DROPSHIP_MARKETPLACE_SYNC_BACK_WORKER_DISABLED", { DROPSHIP_MARKETPLACE_SYNC_BACK_WORKER_DISABLED: "true" }],
  ])("starts nothing when %s is true", (_label, environment) => {
    startDropshipMarketplaceSyncBackWorker(environment);
    expect(mocks.startDropshipWorkerSchedule).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("ticks every 15 minutes on its own phase, 300 s after boot, and says so once", () => {
    const environment = {};
    startDropshipMarketplaceSyncBackWorker(environment);
    expect(mocks.startDropshipWorkerSchedule).toHaveBeenCalledExactlyOnceWith({
      name: "marketplaceSyncBack", intervalMs: 900_000, run: expect.any(Function), environment });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith("dropship.marketplace_sync.worker_started", {
      outcome: "started", interval_ms: 900_000, initial_delay_ms: 300_000, lock_id: 736210,
      schedulingMode: "completion_delayed_non_overlapping" });
    const names: DropshipWorkerScheduleName[] = ["listingPush", "orderProcessing", "ebayOrderIntake", "returnIntake", "returnsMaintenance",
      "usdcWatcher", "costDetection", "categoryMarks", "rulesConversion", "marketplaceSyncBack"];
    const delays = names.map((name) => resolveDropshipWorkerSchedule(name, {}).initialDelayMs);
    expect(new Set(delays).size).toBe(names.length);
  });

  it("reads a whole interval override from 1 ms to one day, else 15 minutes", () => {
    expect(resolveDropshipMarketplaceSyncBackIntervalMs({ DROPSHIP_MARKETPLACE_SYNC_BACK_WORKER_INTERVAL_MS: "60000" })).toBe(60_000);
    for (const configured of ["", "0", "-5", "1.5", "soon", "86400001"]) {
      expect(resolveDropshipMarketplaceSyncBackIntervalMs({ DROPSHIP_MARKETPLACE_SYNC_BACK_WORKER_INTERVAL_MS: configured })).toBe(900_000);
    }
  });

  it("runs each tick under advisory lock 736210 through the pinned-client runner, and no tick when another process holds it", async () => {
    startDropshipMarketplaceSyncBackWorker({});
    await scheduledRun()();
    expect(DROPSHIP_MARKETPLACE_SYNC_BACK_LOCK_ID).toBe(736210);
    expect(mocks.withAdvisoryLock).toHaveBeenCalledExactlyOnceWith(736210, expect.any(Function));
    expect(mocks.runSweepTick).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    mocks.startDropshipWorkerSchedule.mockReturnValue({ handle: { stop: vi.fn() }, initialDelayMs: 300_000 });
    mocks.withAdvisoryLock.mockResolvedValue(null);
    startDropshipMarketplaceSyncBackWorker({});
    await scheduledRun()();
    expect(mocks.runSweepTick).not.toHaveBeenCalled();
  });

  it("logs a failed tick once: a busy database at WARN (retried next interval), anything else at ERROR; never throws to the scheduler", async () => {
    mocks.runSweepTick.mockRejectedValueOnce(Object.assign(new Error("deadlock"), { code: "40P01" }));
    startDropshipMarketplaceSyncBackWorker({});
    await expect(scheduledRun()()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("dropship.marketplace_sync.tick_failed", expect.objectContaining({
      outcome: "deferred", error_code: "40P01", error_class: "transient", lock_id: 736210, context: expect.any(Object) }));

    mocks.runSweepTick.mockRejectedValueOnce(new DropshipError("DROPSHIP_MARKETPLACE_SYNC_INVARIANT_FAILED", "broken", { classification: "fatal" }));
    await scheduledRun()();
    expect(logger.error).toHaveBeenCalledWith("dropship.marketplace_sync.tick_failed", expect.objectContaining({
      outcome: "failed", error_code: "DROPSHIP_MARKETPLACE_SYNC_INVARIANT_FAILED", error_class: "fatal" }));

    mocks.runSweepTick.mockRejectedValueOnce(new Error("no idea"));
    await scheduledRun()();
    expect(logger.error).toHaveBeenLastCalledWith("dropship.marketplace_sync.tick_failed", expect.objectContaining({
      outcome: "failed", error_code: "DROPSHIP_MARKETPLACE_SYNC_TICK_FAILED" }));
  });

  it("is started by the server after the rules conversion worker, inside the dropship workers' scheduler switch, once", () => {
    const index = readFileSync(resolve(process.cwd(), "server/index.ts"), "utf8");
    const block = /if \(!schedulersDisabled\(\)\) \{\n([\s\S]*?)\n\s*\} else \{\n\s*logSchedulerDisabled\("scheduler", "Dropship workers"\);/.exec(index);
    expect(block).not.toBeNull();
    const started = block![1].split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    expect(started.slice(-2)).toEqual(["startDropshipRulesConversionWorker();", "startDropshipMarketplaceSyncBackWorker();"]);
    expect(index.match(/startDropshipMarketplaceSyncBackWorker\(\)/g)).toHaveLength(1);
  });

  it("uses a lock no other worker uses", () => {
    const runners = ["dropship-listing-push-job-runner.ts", "dropship-order-processing-runner.ts", "dropship-ebay-order-intake-runner.ts",
      "dropship-return-intake-runner.ts", "dropship-returns-maintenance-runner.ts", "dropship-usdc-watcher-runner.ts",
      "dropship-cost-detection-runner.ts", "dropship-category-marks-runner.ts", "dropship-rules-conversion-runner.ts"];
    for (const file of runners) {
      expect(readFileSync(resolve(process.cwd(), "server/modules/dropship/infrastructure", file), "utf8")).not.toMatch(/\b736210\b/);
    }
  });
});
