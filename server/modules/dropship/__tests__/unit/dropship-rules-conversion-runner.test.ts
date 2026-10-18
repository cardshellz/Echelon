import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RulesConversionTickResult } from "../../application/dropship-rules-conversion-job-service";
import { DropshipError } from "../../domain/errors";

const mocks = vi.hoisted(() => ({
  withAdvisoryLock: vi.fn(),
  startDropshipWorkerSchedule: vi.fn(),
  runOnce: vi.fn(),
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
vi.mock("../../infrastructure/dropship-rules-conversion.factory", () => ({
  createDropshipRulesConversionJobServiceFromEnv: () => ({ runOnce: mocks.runOnce }),
}));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { logger } from "../../../../platform/observability/logger";
import {
  DROPSHIP_RULES_CONVERSION_INTERVAL_MS,
  DROPSHIP_RULES_CONVERSION_LOCK_ID,
  isDropshipRulesConversionWorkerEnabled,
  resolveDropshipRulesConversionIntervalMs,
  runDropshipRulesConversionTick,
  startDropshipRulesConversionWorker,
} from "../../infrastructure/dropship-rules-conversion-runner";
import { resolveDropshipWorkerSchedule } from "../../infrastructure/dropship-worker-schedule";

const TICK: RulesConversionTickResult = { jobKey: "rules-conversion-job:2026-10-16T09", plannerVersion: 1, storesChecked: 2, converted: 1,
  notClean: 1, tooLarge: 0, notEligible: 0, failed: 0, deferred: 0, costSourceFailed: 0, deadLettered: 0, alreadyConverted: 0, skipped: 0, elapsedMs: 40 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startDropshipWorkerSchedule.mockReturnValue({ handle: { stop: vi.fn() }, initialDelayMs: 240_000 });
  mocks.withAdvisoryLock.mockImplementation(async (_lockId: number, fn: () => Promise<unknown>) => fn());
  mocks.runOnce.mockResolvedValue(TICK);
});

/** The run function the worker handed its schedule. */
function scheduledRun(): () => Promise<void> {
  expect(mocks.startDropshipWorkerSchedule).toHaveBeenCalledOnce();
  return mocks.startDropshipWorkerSchedule.mock.calls[0][0].run;
}

describe("the rules conversion worker (PR 11e2, plan 9.2, 9.4, 13.1)", () => {
  it("is on by default; only an explicit true in either switch turns it off", () => {
    expect(isDropshipRulesConversionWorkerEnabled({})).toBe(true);
    expect(isDropshipRulesConversionWorkerEnabled({ DROPSHIP_RULES_CONVERSION_WORKER_DISABLED: "false", DISABLE_SCHEDULERS: "1" })).toBe(true);
    expect(isDropshipRulesConversionWorkerEnabled({ DISABLE_SCHEDULERS: "true" })).toBe(false);
    expect(isDropshipRulesConversionWorkerEnabled({ DROPSHIP_RULES_CONVERSION_WORKER_DISABLED: "true" })).toBe(false);
    // No opt-in flag exists (the owner's rule): an "enabled" variable changes nothing.
    expect(isDropshipRulesConversionWorkerEnabled({ DROPSHIP_RULES_CONVERSION_WORKER_ENABLED: "false" })).toBe(true);
  });

  it.each([
    ["DISABLE_SCHEDULERS", { DISABLE_SCHEDULERS: "true" }],
    ["DROPSHIP_RULES_CONVERSION_WORKER_DISABLED", { DROPSHIP_RULES_CONVERSION_WORKER_DISABLED: "true" }],
  ])("starts nothing when %s is true", (_label, environment) => {
    startDropshipRulesConversionWorker(environment);
    expect(mocks.startDropshipWorkerSchedule).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("runs hourly on the rulesConversion schedule (240 s after boot) and says so once", () => {
    const environment = {};
    startDropshipRulesConversionWorker(environment);

    expect(DROPSHIP_RULES_CONVERSION_INTERVAL_MS).toBe(3_600_000);
    expect(mocks.startDropshipWorkerSchedule).toHaveBeenCalledExactlyOnceWith({
      name: "rulesConversion", intervalMs: 3_600_000, run: expect.any(Function), environment });
    expect(resolveDropshipWorkerSchedule("rulesConversion", {})).toEqual({
      initialDelayMs: 240_000, initialDelayEnvironmentVariable: "DROPSHIP_RULES_CONVERSION_WORKER_INITIAL_DELAY_MS" });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.rules_conversion_worker_started", {
      outcome: "started", interval_ms: 3_600_000, initial_delay_ms: 240_000, lock_id: 736217,
      schedulingMode: "completion_delayed_non_overlapping" });
  });

  it("reads a whole interval override from 1 ms to one day, and falls back to hourly for anything else", () => {
    for (const [configured, intervalMs] of [["900000", 900_000], ["1", 1], ["86400000", 86_400_000]] as const) {
      expect(resolveDropshipRulesConversionIntervalMs({ DROPSHIP_RULES_CONVERSION_WORKER_INTERVAL_MS: configured })).toBe(intervalMs);
    }
    // Over a day, and over the 2,147,483,647 ms a Node timer takes (which it would run after 1 ms instead).
    for (const configured of ["", "0", "-5", "1.5", "soon", "86400001", "2147483648", "3000000000"]) {
      expect(resolveDropshipRulesConversionIntervalMs({ DROPSHIP_RULES_CONVERSION_WORKER_INTERVAL_MS: configured })).toBe(3_600_000);
    }
  });

  it("runs each tick under advisory lock 736217 through the pinned-client runner", async () => {
    startDropshipRulesConversionWorker({});
    await scheduledRun()();

    expect(DROPSHIP_RULES_CONVERSION_LOCK_ID).toBe(736217);
    expect(mocks.withAdvisoryLock).toHaveBeenCalledExactlyOnceWith(736217, expect.any(Function));
    expect(mocks.runOnce).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("runs no tick when another process holds the lock", async () => {
    mocks.withAdvisoryLock.mockResolvedValue(null);
    startDropshipRulesConversionWorker({});
    await scheduledRun()();
    expect(mocks.runOnce).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a failed tick once with the scheduler's failure context, at ERROR, and never throws to the scheduler", async () => {
    mocks.runOnce.mockRejectedValue(new Error("stores could not be listed"));
    startDropshipRulesConversionWorker({});
    await expect(scheduledRun()()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.rules_conversion_tick_failed", {
      outcome: "failed", error_code: "DROPSHIP_RULES_CONVERSION_TICK_FAILED", error_class: "fatal", lock_id: 736217,
      context: expect.objectContaining({ error: "stores could not be listed", errorName: "Error" }) });
  });

  it("logs a tick the database could not serve at WARN: retryable, retried next hour", async () => {
    mocks.withAdvisoryLock.mockRejectedValue(new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Listing settings couldn't be reached right now.",
      { failure: "pool_acquire_timeout", retryable: true, classification: "transient" }));
    startDropshipRulesConversionWorker({});
    await scheduledRun()();

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.rules_conversion_tick_failed", expect.objectContaining({
      outcome: "deferred", error_code: "DROPSHIP_LISTING_SETTINGS_BUSY", error_class: "transient" }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    // pg-pool's own words when no connection frees in time (the lock pool holds 8).
    ["the lock pool has no free connection in time", new Error("timeout exceeded when trying to connect")],
    ["the server ended the lock pool's session", Object.assign(new Error("terminating connection due to administrator command"),
      { code: "57P01" })],
    ["the lock pool's socket was reset", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
  ])("logs a raw lock-runner failure at WARN when %s: retryable, retried next hour", async (_label, raw) => {
    mocks.withAdvisoryLock.mockRejectedValue(raw);
    startDropshipRulesConversionWorker({});
    await expect(scheduledRun()()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.rules_conversion_tick_failed", {
      outcome: "deferred", error_code: "DROPSHIP_LISTING_SETTINGS_BUSY", error_class: "transient", lock_id: 736217,
      // The context describes the error as thrown, not the mapped one.
      context: expect.objectContaining({ error: raw.message, errorName: "Error" }) });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a raw server error that is not a connection failure at ERROR", async () => {
    mocks.withAdvisoryLock.mockRejectedValue(Object.assign(new Error("permission denied for function pg_try_advisory_lock"),
      { code: "42501" }));
    startDropshipRulesConversionWorker({});
    await scheduledRun()();

    expect(logger.error).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.rules_conversion_tick_failed", expect.objectContaining({
      outcome: "failed", error_code: "DROPSHIP_RULES_CONVERSION_TICK_FAILED", error_class: "fatal" }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("runs one tick through the given service, and lets its failure surface", async () => {
    const runOnce = vi.fn(async () => TICK);
    await expect(runDropshipRulesConversionTick({ service: { runOnce } })).resolves.toEqual(TICK);
    await expect(runDropshipRulesConversionTick({ service: { runOnce: async () => { throw new Error("down"); } } })).rejects.toThrow("down");
  });

  it("starts after the first-mark worker's phase, on a phase and a lock no other worker uses", () => {
    const names = ["listingPush", "orderProcessing", "ebayOrderIntake", "returnIntake", "returnsMaintenance", "usdcWatcher", "costDetection",
      "categoryMarks", "rulesConversion"] as const;
    const delays = names.map((name) => resolveDropshipWorkerSchedule(name, {}).initialDelayMs);
    expect(new Set(delays).size).toBe(names.length);
    expect(resolveDropshipWorkerSchedule("rulesConversion", {}).initialDelayMs)
      .toBeGreaterThan(resolveDropshipWorkerSchedule("categoryMarks", {}).initialDelayMs);
    const runners = ["dropship-listing-push-job-runner.ts", "dropship-order-processing-runner.ts", "dropship-ebay-order-intake-runner.ts",
      "dropship-return-intake-runner.ts", "dropship-returns-maintenance-runner.ts", "dropship-usdc-watcher-runner.ts",
      "dropship-cost-detection-runner.ts", "dropship-category-marks-runner.ts"];
    for (const file of runners) {
      expect(readFileSync(resolve(process.cwd(), "server/modules/dropship/infrastructure", file), "utf8")).not.toMatch(/\b736217\b/);
    }
  });

  it("is started by the server after the first-mark worker, inside the dropship workers' scheduler switch (plan 9.2)", () => {
    const index = readFileSync(resolve(process.cwd(), "server/index.ts"), "utf8");
    const block = /if \(!schedulersDisabled\(\)\) \{\n([\s\S]*?)\n\s*\} else \{\n\s*logSchedulerDisabled\("scheduler", "Dropship workers"\);/.exec(index);
    expect(block).not.toBeNull();
    const started = block![1].split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    expect(started.slice(-2)).toEqual(["startDropshipCategoryMarksWorker();", "startDropshipRulesConversionWorker();"]);
    // Started nowhere else (one start per process).
    expect(index.match(/startDropshipRulesConversionWorker\(\)/g)).toHaveLength(1);
  });
});
