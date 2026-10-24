import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogArrivalsTickResult } from "../../application/dropship-catalog-arrivals-service";

const mocks = vi.hoisted(() => ({
  withAdvisoryLock: vi.fn(),
  startDropshipWorkerSchedule: vi.fn(),
  runTick: vi.fn(),
  recordTickFailure: vi.fn(),
  createService: vi.fn(),
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
vi.mock("../../infrastructure/dropship-catalog-arrivals.factory", () => ({
  createDropshipCatalogArrivalsServiceFromEnv: mocks.createService,
}));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { logger } from "../../../../platform/observability/logger";
import {
  DROPSHIP_CATALOG_ARRIVALS_INTERVAL_MS,
  DROPSHIP_CATALOG_ARRIVALS_LOCK_ID,
  isDropshipCatalogArrivalsWorkerEnabled,
  runLockedDropshipCatalogArrivalsTick,
  startDropshipCatalogArrivalsWorker,
} from "../../infrastructure/dropship-catalog-arrivals-runner";
import { resolveDropshipWorkerSchedule } from "../../infrastructure/dropship-worker-schedule";

const TICK: CatalogArrivalsTickResult = { outcome: "completed", followUp: null, ledger: null, notices: null, elapsedMs: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startDropshipWorkerSchedule.mockReturnValue({ handle: { stop: vi.fn() }, initialDelayMs: 60_000 });
  mocks.withAdvisoryLock.mockImplementation(async (_lockId: number, fn: () => Promise<unknown>) => fn());
  mocks.runTick.mockResolvedValue(TICK);
  mocks.createService.mockReturnValue({ runTick: mocks.runTick, recordTickFailure: mocks.recordTickFailure });
});

/** The run function the worker handed its schedule. */
function scheduledRun(): () => Promise<void> {
  expect(mocks.startDropshipWorkerSchedule).toHaveBeenCalledOnce();
  return mocks.startDropshipWorkerSchedule.mock.calls[0][0].run;
}

/** Every non-test source file under server/ (skipping __tests__ and *.test.ts), as `git grep` over non-test server/ would. */
function nonTestServerSources(): Array<{ path: string; text: string }> {
  const root = resolve(process.cwd(), "server");
  const files: Array<{ path: string; text: string }> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(path);
      } else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
        files.push({ path, text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root);
  return files;
}

describe("the catalog arrivals worker (PLAN-B v4.1 §11.1, §4.4)", () => {
  it("is on by default; only an explicit true in either switch turns it off", () => {
    expect(isDropshipCatalogArrivalsWorkerEnabled({})).toBe(true);
    expect(isDropshipCatalogArrivalsWorkerEnabled({ DROPSHIP_CATALOG_ARRIVALS_WORKER_DISABLED: "false", DISABLE_SCHEDULERS: "1" })).toBe(true);
    expect(isDropshipCatalogArrivalsWorkerEnabled({ DISABLE_SCHEDULERS: "true" })).toBe(false);
    expect(isDropshipCatalogArrivalsWorkerEnabled({ DROPSHIP_CATALOG_ARRIVALS_WORKER_DISABLED: "true" })).toBe(false);
    // No opt-in flag exists (decision 7): an "enabled" variable changes nothing.
    expect(isDropshipCatalogArrivalsWorkerEnabled({ DROPSHIP_CATALOG_ARRIVALS_WORKER_ENABLED: "false" })).toBe(true);
  });

  it.each([
    ["DISABLE_SCHEDULERS", { DISABLE_SCHEDULERS: "true" }],
    ["DROPSHIP_CATALOG_ARRIVALS_WORKER_DISABLED", { DROPSHIP_CATALOG_ARRIVALS_WORKER_DISABLED: "true" }],
  ])("starts nothing when %s is true", (_label, environment) => {
    startDropshipCatalogArrivalsWorker(environment, mocks.createService);
    expect(mocks.startDropshipWorkerSchedule).not.toHaveBeenCalled();
    expect(mocks.createService).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("ticks every minute on the catalogArrivals schedule (60 s after boot) and says so once", () => {
    const environment = {};
    startDropshipCatalogArrivalsWorker(environment);

    expect(DROPSHIP_CATALOG_ARRIVALS_INTERVAL_MS).toBe(60_000);
    expect(mocks.startDropshipWorkerSchedule).toHaveBeenCalledExactlyOnceWith({
      name: "catalogArrivals", intervalMs: 60_000, run: expect.any(Function), environment });
    expect(resolveDropshipWorkerSchedule("catalogArrivals", {})).toEqual({
      initialDelayMs: 60_000, initialDelayEnvironmentVariable: "DROPSHIP_CATALOG_ARRIVALS_WORKER_INITIAL_DELAY_MS" });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith("dropship.catalog_arrivals.worker_started", {
      outcome: "started", interval_ms: 60_000, initial_delay_ms: 60_000, lock_id: 736219,
      schedulingMode: "completion_delayed_non_overlapping" });
    // The service is built on the first tick, not at boot.
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("runs each tick under advisory lock 736219 through the pinned-client runner, with one service kept for the process", async () => {
    startDropshipCatalogArrivalsWorker({});
    await scheduledRun()();
    await scheduledRun()();

    expect(DROPSHIP_CATALOG_ARRIVALS_LOCK_ID).toBe(736219);
    expect(mocks.withAdvisoryLock).toHaveBeenCalledTimes(2);
    expect(mocks.withAdvisoryLock).toHaveBeenNthCalledWith(1, 736219, expect.any(Function));
    expect(mocks.runTick).toHaveBeenCalledTimes(2);
    // Its ledger hour and failure streak live in the service, so it is built once.
    expect(mocks.createService).toHaveBeenCalledOnce();
    expect(mocks.recordTickFailure).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("runs no tick when another process holds the lock", async () => {
    mocks.withAdvisoryLock.mockResolvedValue(null);
    startDropshipCatalogArrivalsWorker({});
    await scheduledRun()();
    expect(mocks.runTick).not.toHaveBeenCalled();
    expect(mocks.recordTickFailure).not.toHaveBeenCalled();
  });

  it("hands a lock runner failure to the service's streak with the scheduler's failure context, and never throws", async () => {
    const raw = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    mocks.withAdvisoryLock.mockRejectedValue(raw);
    startDropshipCatalogArrivalsWorker({});
    await expect(scheduledRun()()).resolves.toBeUndefined();

    expect(mocks.recordTickFailure).toHaveBeenCalledExactlyOnceWith(raw, {
      lock_id: 736219, context: expect.objectContaining({ error: "read ECONNRESET", errorName: "Error" }) });
    expect(mocks.runTick).not.toHaveBeenCalled();
  });

  it("logs a service that cannot be built at ERROR, never throws, and builds it again on the next tick", async () => {
    mocks.createService.mockImplementationOnce(() => { throw new Error("no database url"); });
    startDropshipCatalogArrivalsWorker({}, mocks.createService);
    await expect(scheduledRun()()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("dropship.catalog_arrivals.tick_failed", {
      outcome: "failed", error_code: "DROPSHIP_CATALOG_ARRIVALS_TICK_FAILED", error_class: "fatal", lock_id: 736219,
      context: expect.objectContaining({ error: "no database url", errorName: "Error" }) });
    expect(mocks.withAdvisoryLock).not.toHaveBeenCalled();

    await scheduledRun()();
    expect(mocks.createService).toHaveBeenCalledTimes(2);
    expect(mocks.runTick).toHaveBeenCalledOnce();
  });

  it("runs one locked tick through the given service and lock", async () => {
    const lock = vi.fn(async (_lockId: number, fn: () => Promise<unknown>) => fn());
    const service = { runTick: vi.fn(async () => TICK), recordTickFailure: vi.fn() };
    await runLockedDropshipCatalogArrivalsTick({ service, lock });
    expect(lock).toHaveBeenCalledExactlyOnceWith(736219, expect.any(Function));
    expect(service.runTick).toHaveBeenCalledOnce();
  });

  it("uses a lock id that appears on exactly one line of non-test server/ source (V3, TESTS-14)", () => {
    const hits = nonTestServerSources().flatMap((file) => file.text.split("\n")
      .map((line, index) => ({ path: file.path, line: index + 1, text: line }))
      .filter((line) => /\b736219\b/.test(line.text)));
    expect(hits).toHaveLength(1);
    expect(hits[0].path.endsWith("server/modules/dropship/infrastructure/dropship-catalog-arrivals-runner.ts")).toBe(true);
    expect(hits[0].text).toContain("export const DROPSHIP_CATALOG_ARRIVALS_LOCK_ID = 736219;");
  });

  it("is started by the server once, inside the dropship workers' scheduler switch, immediately before the first-mark worker (V2, TESTS-10)", () => {
    const index = readFileSync(resolve(process.cwd(), "server/index.ts"), "utf8");
    const block = /if \(!schedulersDisabled\(\)\) \{\n([\s\S]*?)\n\s*\} else \{\n\s*logSchedulerDisabled\("scheduler", "Dropship workers"\);/.exec(index);
    expect(block).not.toBeNull();
    const started = block![1].split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const arrivals = started.indexOf("startDropshipCatalogArrivalsWorker();");
    expect(arrivals).toBeGreaterThanOrEqual(0);
    expect(started[arrivals + 1]).toBe("startDropshipCategoryMarksWorker();");
    expect(index.match(/startDropshipCatalogArrivalsWorker\(\)/g)).toHaveLength(1);
    // The two existing order pins still hold (dropship-rules-conversion-runner.test.ts, dropship-marketplace-sync-runner.test.ts).
    expect(started.slice(-3)).toEqual(["startDropshipCategoryMarksWorker();", "startDropshipRulesConversionWorker();",
      "startDropshipMarketplaceSyncBackWorker();"]);
  });
});
