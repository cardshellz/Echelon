import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingEndTickResult } from "../../application/dropship-listing-end-service";

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
vi.mock("../../infrastructure/dropship-listing-end.factory", () => ({
  createDropshipListingEndServiceFromEnv: mocks.createService,
}));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { logger } from "../../../../platform/observability/logger";
import {
  DROPSHIP_LISTING_END_INTERVAL_MS,
  DROPSHIP_LISTING_END_LOCK_ID,
  isDropshipListingEndWorkerEnabled,
  runLockedDropshipListingEndTick,
  startDropshipListingEndWorker,
} from "../../infrastructure/dropship-listing-end-runner";
import { resolveDropshipWorkerSchedule } from "../../infrastructure/dropship-worker-schedule";

/** The listing end worker's runner (PLAN-C v4.1 §5.2; D35): default on, kill switches, lock, schedule and start position. */
const TICK: ListingEndTickResult = { outcome: "completed", gate: null, due: 0, claimed: 0, ended: 0, failed: 0, superseded: 0, deferred: 0,
  retried: 0, skipped: 0, elapsedMs: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startDropshipWorkerSchedule.mockReturnValue({ handle: { stop: vi.fn() }, initialDelayMs: 5_000 });
  mocks.withAdvisoryLock.mockImplementation(async (_lockId: number, fn: () => Promise<unknown>) => fn());
  mocks.runTick.mockResolvedValue(TICK);
  mocks.createService.mockReturnValue({ runTick: mocks.runTick, recordTickFailure: mocks.recordTickFailure });
});

function scheduledRun(): () => Promise<void> {
  expect(mocks.startDropshipWorkerSchedule).toHaveBeenCalledOnce();
  return mocks.startDropshipWorkerSchedule.mock.calls[0][0].run;
}

/** Every non-test source file under server/, as a word grep of non-test server/ would read it. */
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

describe("the listing end worker's runner (§5.2)", () => {
  it("runs with no environment variable set; only an explicit true in either switch turns it off (D35)", () => {
    expect(isDropshipListingEndWorkerEnabled({})).toBe(true);
    expect(isDropshipListingEndWorkerEnabled({ DROPSHIP_LISTING_END_WORKER_DISABLED: "false", DISABLE_SCHEDULERS: "1" })).toBe(true);
    expect(isDropshipListingEndWorkerEnabled({ DISABLE_SCHEDULERS: "true" })).toBe(false);
    expect(isDropshipListingEndWorkerEnabled({ DROPSHIP_LISTING_END_WORKER_DISABLED: "true" })).toBe(false);
    // Nothing has to be turned on: an "enabled" variable changes nothing.
    expect(isDropshipListingEndWorkerEnabled({ DROPSHIP_LISTING_END_WORKER_ENABLED: "false" })).toBe(true);
  });

  it.each([
    ["DISABLE_SCHEDULERS", { DISABLE_SCHEDULERS: "true" }],
    ["DROPSHIP_LISTING_END_WORKER_DISABLED", { DROPSHIP_LISTING_END_WORKER_DISABLED: "true" }],
  ])("starts nothing when %s is true", (_label, environment) => {
    startDropshipListingEndWorker(environment, mocks.createService);
    expect(mocks.startDropshipWorkerSchedule).not.toHaveBeenCalled();
    expect(mocks.createService).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("ticks every 10 s on the listingEnd schedule, 5 s after boot, and says so once", () => {
    const environment = {};
    startDropshipListingEndWorker(environment);
    expect(DROPSHIP_LISTING_END_INTERVAL_MS).toBe(10_000);
    expect(mocks.startDropshipWorkerSchedule).toHaveBeenCalledExactlyOnceWith({
      name: "listingEnd", intervalMs: 10_000, run: expect.any(Function), environment });
    expect(resolveDropshipWorkerSchedule("listingEnd", {})).toEqual({
      initialDelayMs: 5_000, initialDelayEnvironmentVariable: "DROPSHIP_LISTING_END_WORKER_INITIAL_DELAY_MS" });
    expect(resolveDropshipWorkerSchedule("listingEnd", { DROPSHIP_LISTING_END_WORKER_INITIAL_DELAY_MS: "0" }).initialDelayMs).toBe(0);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith("dropship.listing_end.worker_started", {
      outcome: "started", interval_ms: 10_000, initial_delay_ms: 5_000, lock_id: 736218,
      schedulingMode: "completion_delayed_non_overlapping" });
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("runs each tick under advisory lock 736218 through the pinned-client runner, with one service kept for the process", async () => {
    startDropshipListingEndWorker({});
    await scheduledRun()();
    await scheduledRun()();
    expect(DROPSHIP_LISTING_END_LOCK_ID).toBe(736218);
    expect(mocks.withAdvisoryLock).toHaveBeenNthCalledWith(1, 736218, expect.any(Function));
    expect(mocks.runTick).toHaveBeenCalledTimes(2);
    expect(mocks.createService).toHaveBeenCalledOnce();
  });

  it("skips the tick when another process holds the lock", async () => {
    mocks.withAdvisoryLock.mockResolvedValue(null);
    startDropshipListingEndWorker({});
    await scheduledRun()();
    expect(mocks.runTick).not.toHaveBeenCalled();
    expect(mocks.recordTickFailure).not.toHaveBeenCalled();
  });

  it("hands a lock runner failure to the service with the scheduler's failure context, and never throws", async () => {
    const raw = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    mocks.withAdvisoryLock.mockRejectedValue(raw);
    startDropshipListingEndWorker({});
    await expect(scheduledRun()()).resolves.toBeUndefined();
    expect(mocks.recordTickFailure).toHaveBeenCalledExactlyOnceWith(raw, {
      lock_id: 736218, context: expect.objectContaining({ error: "read ECONNRESET", errorName: "Error" }) });
  });

  it("logs a service that cannot be built at ERROR (fatal), never throws, and builds it again on the next tick", async () => {
    mocks.createService.mockImplementationOnce(() => { throw new Error("no database url"); });
    startDropshipListingEndWorker({}, mocks.createService);
    await expect(scheduledRun()()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("dropship.listing_end.tick_failed", {
      outcome: "failed", error_code: "DROPSHIP_LISTING_END_TICK_FAILED", error_class: "fatal", lock_id: 736218,
      context: expect.objectContaining({ error: "no database url", errorName: "Error" }) });
    await scheduledRun()();
    expect(mocks.runTick).toHaveBeenCalledOnce();
  });

  it("runs one locked tick through the given service and lock", async () => {
    const lock = vi.fn(async (_lockId: number, fn: () => Promise<unknown>) => fn());
    const service = { runTick: vi.fn(async () => TICK), recordTickFailure: vi.fn() };
    await runLockedDropshipListingEndTick({ service, lock });
    expect(lock).toHaveBeenCalledExactlyOnceWith(736218, expect.any(Function));
    expect(service.runTick).toHaveBeenCalledOnce();
  });

  it("uses a lock id that appears on exactly one line of non-test server/ source", () => {
    const hits = nonTestServerSources().flatMap((file) => file.text.split("\n")
      .map((line, index) => ({ path: file.path, line: index + 1, text: line }))
      .filter((line) => /\b736218\b/.test(line.text)));
    expect(hits).toHaveLength(1);
    expect(hits[0].path.endsWith("server/modules/dropship/infrastructure/dropship-listing-end-runner.ts")).toBe(true);
    expect(hits[0].text).toContain("export const DROPSHIP_LISTING_END_LOCK_ID = 736218;");
  });

  it("is started by the server once, after the cost detection worker and immediately before the catalog arrivals worker", () => {
    const index = readFileSync(resolve(process.cwd(), "server/index.ts"), "utf8");
    const block = /if \(!schedulersDisabled\(\)\) \{\n([\s\S]*?)\n\s*\} else \{\n\s*logSchedulerDisabled\("scheduler", "Dropship workers"\);/.exec(index);
    expect(block).not.toBeNull();
    const started = block![1].split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const end = started.indexOf("startDropshipListingEndWorker();");
    expect(end).toBeGreaterThan(0);
    expect(started[end - 1]).toBe("startDropshipCostDetectionWorker();");
    expect(started[end + 1]).toBe("startDropshipCatalogArrivalsWorker();");
    expect(index.match(/startDropshipListingEndWorker\(\)/g)).toHaveLength(1);
    // The arrivals pin (immediately before category marks) and the last three still hold.
    expect(started[started.indexOf("startDropshipCatalogArrivalsWorker();") + 1]).toBe("startDropshipCategoryMarksWorker();");
    expect(started.slice(-3)).toEqual(["startDropshipCategoryMarksWorker();", "startDropshipRulesConversionWorker();",
      "startDropshipMarketplaceSyncBackWorker();"]);
  });
});
