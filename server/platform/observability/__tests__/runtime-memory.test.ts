import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linuxProcessSwapBytes, observeRuntimeRequests, observeRuntimeWork, readRuntimeMemory,
  resolveRuntimeMemoryConfiguration, runtimeRequestCategory, startRuntimeMemoryTelemetry } from "../runtime-memory";

const enabled = { NODE_ENV: "production" };
let stop: () => void = () => undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { stop(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("runtime memory configuration and process measurements", () => {
  it("enables production only by default and supports explicit opt-in and opt-out", () => {
    expect(resolveRuntimeMemoryConfiguration({})).toEqual({ enabled: false, intervalMs: 60_000 });
    expect(resolveRuntimeMemoryConfiguration(enabled).enabled).toBe(true);
    expect(resolveRuntimeMemoryConfiguration({ ...enabled, RUNTIME_MEMORY_TELEMETRY_ENABLED: "false" }).enabled).toBe(false);
    expect(resolveRuntimeMemoryConfiguration({ NODE_ENV: "test", RUNTIME_MEMORY_TELEMETRY_ENABLED: "true" }).enabled).toBe(true);
  });

  it.each(["", "-1", "0", "9999", "300001", "60000.5", "NaN", "Infinity", "invalid"])(
    "uses the bounded default for an invalid interval %s", value => {
      expect(resolveRuntimeMemoryConfiguration({ RUNTIME_MEMORY_TELEMETRY_INTERVAL_MS: value }).intervalMs).toBe(60_000);
    },
  );

  it.each([10_000, 60_000, 300_000])("accepts a bounded interval %s", interval => {
    expect(resolveRuntimeMemoryConfiguration({ RUNTIME_MEMORY_TELEMETRY_INTERVAL_MS: String(interval) }).intervalMs).toBe(interval);
  });

  it("parses Linux process swap and reports unavailable measurements as null", () => {
    expect(linuxProcessSwapBytes("Name:\tnode\nVmSwap:\t349300 kB\nThreads:\t7\n")).toBe(349300 * 1024);
    expect(linuxProcessSwapBytes("VmSwap: 0 kB\n")).toBe(0);
    for (const text of ["", "VmSwap: -1 kB", "VmSwap: 12 MB", "VmSwap: 999999999999999999 kB", "OtherVmSwap: 10 kB"]) {
      expect(linuxProcessSwapBytes(text)).toBeNull();
    }
  });

  it("reads numeric live process measurements without an inspector or database", () => {
    const measurement = readRuntimeMemory();
    expect(measurement.pid).toBe(process.pid);
    for (const [key, value] of Object.entries(measurement)) {
      if (key === "swapBytes" && value === null) continue;
      expect(Number.isSafeInteger(value), key).toBe(true);
      expect(value, key).toBeGreaterThanOrEqual(0);
    }
    expect(measurement.rss).toBeGreaterThan(0);
    expect(measurement.heapLimit).toBeGreaterThan(0);
  });
});

describe("runtime memory telemetry lifecycle", () => {
  it("is disabled outside production without a timer or extra async layer", () => {
    const emit = vi.fn();
    stop = startRuntimeMemoryTelemetry({ environment: { NODE_ENV: "test" }, emit });
    const promise = Promise.resolve("same promise");
    expect(observeRuntimeWork("job.one", () => promise)).toBe(promise);
    expect(emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("samples immediately, only initializes once, and stops its unreferenced interval", async () => {
    const emit = vi.fn();
    const interval = vi.spyOn(globalThis, "setInterval");
    stop = startRuntimeMemoryTelemetry({ environment: enabled, emit,
      readContext: () => ({ databasePool: { waitingRequests: 2 } }) });
    expect(interval.mock.results[0].value.hasRef()).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({ databasePool: { waitingRequests: 2 }, intervalMs: 60_000 });
    const stopDuplicate = startRuntimeMemoryTelemetry({ environment: enabled, emit });
    stopDuplicate();
    await observeRuntimeWork("job.one", async () => "result");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls[2][1]).toMatchObject({ name: "job.one", completed: 1 });
    expect(vi.getTimerCount()).toBe(1);
    stop(); stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not allow an old stop handle to disable a newer observer", async () => {
    const oldStop = startRuntimeMemoryTelemetry({ environment: enabled, emit: vi.fn() });
    oldStop();
    const emit = vi.fn();
    stop = startRuntimeMemoryTelemetry({ environment: enabled, emit });
    oldStop();
    await observeRuntimeWork("job.one", async () => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({ name: "job.one", completed: 1 });
  });

  it("recovers after sampling fails without surfacing raw errors or breaking work", async () => {
    const emit = vi.fn();
    const readMemory = vi.fn(readRuntimeMemory).mockImplementationOnce(() => { throw new Error("private failure"); });
    stop = startRuntimeMemoryTelemetry({ environment: enabled, emit, readMemory });
    await expect(observeRuntimeWork("job.one", async () => "ok")).resolves.toBe("ok");
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit.mock.calls[0][1]).toMatchObject({ samplingFailures: 1 });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private failure");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({ samplingFailures: 0 });
  });

  it("does not amplify blocked stdout and reports the backlog after it drains", async () => {
    const length = vi.spyOn(process.stdout, "writableLength", "get").mockReturnValue(100_000);
    const emit = vi.fn();
    stop = startRuntimeMemoryTelemetry({ environment: enabled, emit });
    await observeRuntimeWork("job.one", async () => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit).not.toHaveBeenCalled();
    length.mockReturnValue(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit.mock.calls[0][1]).toMatchObject({ skippedReports: 2, peakStdoutQueuedBytes: 100_000 });
    expect(emit.mock.calls[1][1]).toMatchObject({ name: "job.one", completed: 1 });
  });

  it("also skips a backed-up stderr stream and tolerates an unavailable context reader", async () => {
    const length = vi.spyOn(process.stderr, "writableLength", "get").mockReturnValue(100_000);
    const emit = vi.fn();
    const readContext = vi.fn().mockImplementationOnce(() => { throw new Error("context failure"); }).mockReturnValue({});
    stop = startRuntimeMemoryTelemetry({ environment: enabled, emit, readContext });
    expect(emit).not.toHaveBeenCalled();
    length.mockReturnValue(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(emit.mock.calls[0][1]).toMatchObject({ skippedReports: 1, samplingFailures: 1, peakStderrQueuedBytes: 100_000 });
  });

  it("does not propagate a failed log sink into a timer or a job", async () => {
    const emit = vi.fn().mockImplementation(() => { throw new Error("sink failed"); });
    stop = startRuntimeMemoryTelemetry({ environment: enabled, emit });
    const original = new Error("business error");
    await expect(observeRuntimeWork("job.one", async () => { throw original; })).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(60_000);
    emit.mockImplementation(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({ telemetryFailures: 2 });
  });
});

describe("request instrumentation", () => {
  it.each([
    ["POST", "/api/webhooks/shopify/orders", "http.webhook"],
    ["GET", "/api/internal/secret-path", "http.internal"],
    ["GET", "/api/wms/orders/123", "http.api_read"],
    ["POST", "/api/anything", "http.api_write"],
    ["GET", "/private-page", "http.other"],
  ])("uses a fixed group for %s %s", (method, path, expected) => {
    expect(runtimeRequestCategory(method, path)).toBe(expected);
  });

  it.each([
    ["finish", true, 200, "completed"],
    ["finish", true, 503, "failed"],
    ["close", false, 200, "failed"],
  ] as const)("cleans up once on %s (finished=%s status=%s)", async (event, writableFinished, statusCode, outcome) => {
    const emit = vi.fn();
    stop = startRuntimeMemoryTelemetry({ environment: enabled, emit });
    const response = Object.assign(new EventEmitter(), { writableFinished, statusCode });
    const request = { method: "GET", path: "/api/orders/123?secret=private", body: { private: true } };
    const next = vi.fn();
    observeRuntimeRequests(request as Request, response as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(request.body).toEqual({ private: true });
    response.emit(event);
    response.emit("finish"); response.emit("close");
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({ name: "http.api_read", active: 0,
      started: 1, [outcome]: 1, maxRssDelta: null });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private");
  });

  it("adds no listeners while disabled", () => {
    const response = new EventEmitter();
    const next = vi.fn();
    observeRuntimeRequests({ method: "GET", path: "/api/orders" } as Request, response as Response, next);
    expect(response.eventNames()).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
