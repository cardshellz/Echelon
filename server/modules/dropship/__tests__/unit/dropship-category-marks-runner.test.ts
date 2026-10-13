import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CategoryMarksTickResult } from "../../application/dropship-category-marks-job-service";
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
vi.mock("../../infrastructure/dropship-category-marks.factory", () => ({
  createDropshipCategoryMarksJobServiceFromEnv: () => ({ runOnce: mocks.runOnce }),
}));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { logger } from "../../../../platform/observability/logger";
import {
  DROPSHIP_CATEGORY_MARKS_INTERVAL_MS,
  DROPSHIP_CATEGORY_MARKS_LOCK_ID,
  isDropshipCategoryMarksWorkerEnabled,
  resolveDropshipCategoryMarksIntervalMs,
  runDropshipCategoryMarksTick,
  startDropshipCategoryMarksWorker,
} from "../../infrastructure/dropship-category-marks-runner";
import { resolveDropshipWorkerSchedule } from "../../infrastructure/dropship-worker-schedule";

const TICK: CategoryMarksTickResult = { jobKey: "category-marks:2026-10-13T09", storesScanned: 1, vendorsScanned: 1, vendorsFailed: 0,
  storesFailed: 0, insertedCount: 2, elapsedMs: 40 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startDropshipWorkerSchedule.mockReturnValue({ handle: { stop: vi.fn() }, initialDelayMs: 180_000 });
  mocks.withAdvisoryLock.mockImplementation(async (_lockId: number, fn: () => Promise<unknown>) => fn());
  mocks.runOnce.mockResolvedValue(TICK);
});

/** The run function the worker handed its schedule. */
function scheduledRun(): () => Promise<void> {
  expect(mocks.startDropshipWorkerSchedule).toHaveBeenCalledOnce();
  return mocks.startDropshipWorkerSchedule.mock.calls[0][0].run;
}

describe("the first-mark worker (plan PR 9, P28, 10.5)", () => {
  it("is on by default; only an explicit true in either switch turns it off", () => {
    expect(isDropshipCategoryMarksWorkerEnabled({})).toBe(true);
    expect(isDropshipCategoryMarksWorkerEnabled({ DROPSHIP_CATEGORY_MARKS_WORKER_DISABLED: "false", DISABLE_SCHEDULERS: "1" })).toBe(true);
    expect(isDropshipCategoryMarksWorkerEnabled({ DISABLE_SCHEDULERS: "true" })).toBe(false);
    expect(isDropshipCategoryMarksWorkerEnabled({ DROPSHIP_CATEGORY_MARKS_WORKER_DISABLED: "true" })).toBe(false);
    // No opt-in flag exists (the owner's rule): an "enabled" variable changes nothing.
    expect(isDropshipCategoryMarksWorkerEnabled({ DROPSHIP_CATEGORY_MARKS_WORKER_ENABLED: "false" })).toBe(true);
  });

  it.each([
    ["DISABLE_SCHEDULERS", { DISABLE_SCHEDULERS: "true" }],
    ["DROPSHIP_CATEGORY_MARKS_WORKER_DISABLED", { DROPSHIP_CATEGORY_MARKS_WORKER_DISABLED: "true" }],
  ])("starts nothing when %s is true", (_label, environment) => {
    startDropshipCategoryMarksWorker(environment);
    expect(mocks.startDropshipWorkerSchedule).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("runs hourly on the categoryMarks schedule (180 s after boot) and says so once", () => {
    const environment = {};
    startDropshipCategoryMarksWorker(environment);

    expect(DROPSHIP_CATEGORY_MARKS_INTERVAL_MS).toBe(3_600_000);
    expect(mocks.startDropshipWorkerSchedule).toHaveBeenCalledExactlyOnceWith({
      name: "categoryMarks", intervalMs: 3_600_000, run: expect.any(Function), environment });
    expect(resolveDropshipWorkerSchedule("categoryMarks", {})).toEqual({
      initialDelayMs: 180_000, initialDelayEnvironmentVariable: "DROPSHIP_CATEGORY_MARKS_WORKER_INITIAL_DELAY_MS" });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_worker_started", {
      outcome: "started", interval_ms: 3_600_000, initial_delay_ms: 180_000, lock_id: 736216,
      schedulingMode: "completion_delayed_non_overlapping" });
  });

  it("reads a whole interval override from 1 ms to one day, and falls back to hourly for anything else", () => {
    for (const [configured, intervalMs] of [["900000", 900_000], ["1", 1], ["86400000", 86_400_000]] as const) {
      expect(resolveDropshipCategoryMarksIntervalMs({ DROPSHIP_CATEGORY_MARKS_WORKER_INTERVAL_MS: configured })).toBe(intervalMs);
    }
    // Over a day, and over the 2,147,483,647 ms a Node timer takes (which it would run after 1 ms instead).
    for (const configured of ["", "0", "-5", "1.5", "soon", "86400001", "2147483648", "3000000000"]) {
      expect(resolveDropshipCategoryMarksIntervalMs({ DROPSHIP_CATEGORY_MARKS_WORKER_INTERVAL_MS: configured })).toBe(3_600_000);
    }
  });

  it("runs each tick under advisory lock 736216 through the pinned-client runner", async () => {
    startDropshipCategoryMarksWorker({});
    await scheduledRun()();

    expect(DROPSHIP_CATEGORY_MARKS_LOCK_ID).toBe(736216);
    expect(mocks.withAdvisoryLock).toHaveBeenCalledExactlyOnceWith(736216, expect.any(Function));
    expect(mocks.runOnce).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("runs no tick when another process holds the lock", async () => {
    mocks.withAdvisoryLock.mockResolvedValue(null);
    startDropshipCategoryMarksWorker({});
    await scheduledRun()();
    expect(mocks.runOnce).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a failed tick once with the scheduler's failure context, at ERROR, and never throws to the scheduler", async () => {
    mocks.runOnce.mockRejectedValue(new Error("stores could not be listed"));
    startDropshipCategoryMarksWorker({});
    await expect(scheduledRun()()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_tick_failed", {
      outcome: "failed", error_code: "DROPSHIP_CATEGORY_MARKS_TICK_FAILED", error_class: "fatal", lock_id: 736216,
      context: expect.objectContaining({ error: "stores could not be listed", errorName: "Error" }) });
  });

  it("logs a tick the database could not serve at WARN: retryable, retried next hour", async () => {
    mocks.withAdvisoryLock.mockRejectedValue(new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Listing settings couldn't be reached right now.",
      { failure: "pool_acquire_timeout", retryable: true, classification: "transient" }));
    startDropshipCategoryMarksWorker({});
    await scheduledRun()();

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_tick_failed", expect.objectContaining({
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
    startDropshipCategoryMarksWorker({});
    await expect(scheduledRun()()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_tick_failed", {
      outcome: "deferred", error_code: "DROPSHIP_LISTING_SETTINGS_BUSY", error_class: "transient", lock_id: 736216,
      // The context describes the error as thrown, not the mapped one.
      context: expect.objectContaining({ error: raw.message, errorName: "Error" }) });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a raw server error that is not a connection failure at ERROR", async () => {
    mocks.withAdvisoryLock.mockRejectedValue(Object.assign(new Error("permission denied for function pg_try_advisory_lock"),
      { code: "42501" }));
    startDropshipCategoryMarksWorker({});
    await scheduledRun()();

    expect(logger.error).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_tick_failed", expect.objectContaining({
      outcome: "failed", error_code: "DROPSHIP_CATEGORY_MARKS_TICK_FAILED", error_class: "fatal" }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("runs one tick through the given service, and lets its failure surface", async () => {
    const runOnce = vi.fn(async () => TICK);
    await expect(runDropshipCategoryMarksTick({ service: { runOnce } })).resolves.toEqual(TICK);
    await expect(runDropshipCategoryMarksTick({ service: { runOnce: async () => { throw new Error("down"); } } })).rejects.toThrow("down");
  });

  it("logs through the platform logger only: no console call in the runner, the job service or its source (plan 10.8 #4)", () => {
    for (const file of [
      "server/modules/dropship/infrastructure/dropship-category-marks-runner.ts",
      "server/modules/dropship/infrastructure/dropship-category-marks.factory.ts",
      "server/modules/dropship/infrastructure/dropship-category-marks-job.source.ts",
      "server/modules/dropship/application/dropship-category-marks-job-service.ts",
    ]) {
      expect(readFileSync(resolve(process.cwd(), file), "utf8")).not.toMatch(/\bconsole\./);
    }
  });
});
