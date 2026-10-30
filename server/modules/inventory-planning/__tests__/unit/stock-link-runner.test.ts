import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StockLinkTickSummary } from "../../application/stock-link.service";

const mocks = vi.hoisted(() => ({
  withAdvisoryLock: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock("../../../../infrastructure/scheduler-lock", () => ({
  withAdvisoryLock: mocks.withAdvisoryLock,
  getSchedulerLockPoolSnapshot: () => null,
}));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { logger } from "../../../../platform/observability/logger";
import {
  STOCK_LINK_INITIAL_DELAY_MS, STOCK_LINK_INTERVAL_MS, STOCK_LINK_LOCK_ID, runLockedStockLinkTick, startStockLinkRunner,
  stockLinkRunnerDisableReason,
} from "../../infrastructure/stock-link-runner";

// The stock-link runner (PLAN-CH2 v4.1 §7.1, TST-10): the four pins of the listing-end runner's test
// (DS/__tests__/unit/dropship-listing-end-runner.test.ts): locked tick, lock id on one line, start-block position, plus
// the kill switches.

const SUMMARY: StockLinkTickSummary = { outcome: "completed", destinations: 0, claimed: 0, providerCalls: 0, observations: 0,
  lookups: 0, applies: 0, links: 0, relinks: 0, retires: 0, flags: 0, fenceHoldMsTotal: 0, fenceHoldMsMax: 0, elapsedMs: 1 };

function service() {
  return { tick: vi.fn(async () => SUMMARY), recordTickFailure: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.schedule.mockReturnValue({ stop: vi.fn() });
  mocks.withAdvisoryLock.mockImplementation(async (_lockId: number, fn: () => Promise<unknown>) => fn());
});

function scheduledRun(): () => Promise<void> {
  expect(mocks.schedule).toHaveBeenCalledOnce();
  return mocks.schedule.mock.calls[0][0].run;
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

describe("the stock-link runner (§7.1)", () => {
  it("runs with no environment variable set; only an explicit true in either switch turns it off (D-A, §21)", () => {
    expect(stockLinkRunnerDisableReason({})).toBeNull();
    expect(stockLinkRunnerDisableReason({ STOCK_LINK_AUTO_DISABLED: "false", DISABLE_SCHEDULERS: "1" })).toBeNull();
    expect(stockLinkRunnerDisableReason({ DISABLE_SCHEDULERS: "true" })).toBe("DISABLE_SCHEDULERS=true");
    expect(stockLinkRunnerDisableReason({ STOCK_LINK_AUTO_DISABLED: "true" })).toBe("STOCK_LINK_AUTO_DISABLED=true");
  });

  it.each([
    ["DISABLE_SCHEDULERS", { DISABLE_SCHEDULERS: "true" }],
    ["STOCK_LINK_AUTO_DISABLED", { STOCK_LINK_AUTO_DISABLED: "true" }],
  ])("starts nothing when %s is true", (_label, environment) => {
    const tickService = service();
    expect(startStockLinkRunner(tickService, environment, mocks.schedule)).toBeNull();
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(tickService.tick).not.toHaveBeenCalled();
  });

  it("ticks every 60 s, 30 s after boot, without overlap, and says so once", () => {
    const handle = startStockLinkRunner(service(), {}, mocks.schedule);
    expect(handle).toBe(mocks.schedule.mock.results[0]!.value);
    expect(STOCK_LINK_INTERVAL_MS).toBe(60_000);
    expect(STOCK_LINK_INITIAL_DELAY_MS).toBe(30_000);
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith({ taskName: "stock-link", initialDelayMs: 30_000, intervalMs: 60_000,
      run: expect.any(Function), logger: { error: expect.any(Function) } });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith("inventory_availability.stock_link.runner", {
      outcome: "started", interval_ms: 60_000, initial_delay_ms: 30_000, lock_id: 736220,
      schedulingMode: "completion_delayed_non_overlapping" });
  });

  it("runs each tick under advisory lock 736220 through the pinned-client runner", async () => {
    const tickService = service();
    startStockLinkRunner(tickService, {}, mocks.schedule);
    await scheduledRun()();
    await scheduledRun()();
    expect(STOCK_LINK_LOCK_ID).toBe(736220);
    expect(mocks.withAdvisoryLock).toHaveBeenNthCalledWith(1, 736220, expect.any(Function));
    expect(mocks.withAdvisoryLock).toHaveBeenNthCalledWith(2, 736220, expect.any(Function));
    expect(tickService.tick).toHaveBeenCalledTimes(2);
  });

  it("skips the tick when another process holds the lock", async () => {
    mocks.withAdvisoryLock.mockResolvedValue(null);
    const tickService = service();
    startStockLinkRunner(tickService, {}, mocks.schedule);
    await scheduledRun()();
    expect(tickService.tick).not.toHaveBeenCalled();
    expect(tickService.recordTickFailure).not.toHaveBeenCalled();
  });

  it("hands a lock runner failure to the service with the scheduler's failure context, and never throws", async () => {
    const raw = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    mocks.withAdvisoryLock.mockRejectedValue(raw);
    const tickService = service();
    startStockLinkRunner(tickService, {}, mocks.schedule);
    await expect(scheduledRun()()).resolves.toBeUndefined();
    expect(tickService.recordTickFailure).toHaveBeenCalledExactlyOnceWith(raw, {
      lock_id: 736220, context: expect.objectContaining({ error: "read ECONNRESET", errorName: "Error" }) });
  });

  it("logs a failure that escaped the locked tick at ERROR (fatal)", () => {
    startStockLinkRunner(service(), {}, mocks.schedule);
    const options = mocks.schedule.mock.calls[0][0];
    options.logger.error({ code: "NON_OVERLAPPING_SCHEDULED_TASK_FAILED", context: { error: "boom" } });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("inventory_availability.stock_link.runner", {
      outcome: "failed", error_code: "NON_OVERLAPPING_SCHEDULED_TASK_FAILED", error_class: "fatal", lock_id: 736220, context: { error: "boom" } });
  });

  it("runs one locked tick through the given service and lock", async () => {
    const lock = vi.fn(async (_lockId: number, fn: () => Promise<unknown>) => fn());
    const tickService = service();
    await runLockedStockLinkTick({ service: tickService, lock });
    expect(lock).toHaveBeenCalledExactlyOnceWith(736220, expect.any(Function));
    expect(tickService.tick).toHaveBeenCalledOnce();
  });

  it("uses a lock id that appears on exactly one line of non-test server/ source", () => {
    const hits = nonTestServerSources().flatMap((file) => file.text.split("\n")
      .map((line, index) => ({ path: file.path, line: index + 1, text: line }))
      .filter((line) => /\b736220\b/.test(line.text)));
    expect(hits).toHaveLength(1);
    expect(hits[0].path.replaceAll("\\", "/").endsWith("server/modules/inventory-planning/infrastructure/stock-link-runner.ts")).toBe(true);
    expect(hits[0].text).toContain("export const STOCK_LINK_LOCK_ID = 736220;");
  });

  it("is started by the server once, in its own block right after the publication outbox worker's, behind its own switch", () => {
    const index = readFileSync(resolve(process.cwd(), "server/index.ts"), "utf8").replaceAll("\r\n", "\n");
    expect(index.match(/startStockLinkRunner\(/g)).toHaveLength(1);
    const outbox = index.indexOf('"INVENTORY_PUBLICATION_WORKER_DISABLED",\n        );\n      }');
    const block = /if \(!schedulersDisabled\("STOCK_LINK_AUTO_DISABLED"\)\) \{\n\s*const stockLinkRunner = startStockLinkRunner\(services\.stockLink\);\n\s*if \(stockLinkRunner\) httpServer\.once\("close", \(\) => stockLinkRunner\.stop\(\)\);\n\s*\} else \{\n\s*logSchedulerDisabled\("scheduler", "Stock link runner", "STOCK_LINK_AUTO_DISABLED"\);\n\s*\}/.exec(index);
    expect(outbox).toBeGreaterThan(0);
    expect(block).not.toBeNull();
    // Nothing but the block's own comment lies between the outbox worker's block and this one.
    const between = index.slice(outbox + '"INVENTORY_PUBLICATION_WORKER_DISABLED",\n        );\n      }'.length, block!.index)
      .split("\n").map(line => line.trim()).filter(line => line.length > 0);
    expect(between.every(line => line.startsWith("//"))).toBe(true);
    const after = index.slice(block!.index + block![0].length).split("\n").map(line => line.trim()).find(line => line.length > 0);
    expect(after).toBe('if (!schedulersDisabled("PO_EMAIL_OUTBOX_WORKER_DISABLED")) {');
  });
});
