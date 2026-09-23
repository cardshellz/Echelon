import { describe, expect, it, vi } from "vitest";
import { createRuntimeMemoryObserver, MAX_RUNTIME_MEMORY_GROUPS } from "../runtime-memory-observer";

function fixture() {
  let time = 10;
  let point = { rss: 100, heapUsed: 60, external: 20 };
  const emit = vi.fn();
  const readMemory = vi.fn(() => point);
  const nowMs = vi.fn(() => time);
  const observer = createRuntimeMemoryObserver({ emit, readMemory, nowMs });
  return { observer, emit, readMemory, nowMs,
    advance: (ms: number) => { time += ms; },
    setPoint: (value: typeof point) => { point = value; },
    records: () => emit.mock.calls.map(([action, data]) => ({ action, ...data })),
  };
}

describe("bounded runtime memory observer", () => {
  it("preserves work results and reports numeric process deltas without retaining payloads", async () => {
    const f = fixture();
    const result = { customer: "must not enter telemetry" };
    const work = vi.fn(async () => {
      f.advance(15);
      f.setPoint({ rss: 125, heapUsed: 45, external: 24 });
      return result;
    });
    expect(await f.observer.run("shipping.batch", work)).toBe(result);
    expect(work).toHaveBeenCalledTimes(1);
    expect(f.emit).not.toHaveBeenCalled();
    f.observer.report({ pid: 42 });
    expect(f.records()).toEqual([
      { action: "runtime.memory", pid: 42, reportSequence: 1, activeWork: 0, telemetryFailures: 0 },
      { action: "runtime.work_memory", reportSequence: 1, name: "shipping.batch",
        active: 0, peakActive: 1, started: 1, completed: 1, failed: 0,
        overlappingStarts: 0, maxDurationMs: 15, maxRssDelta: 25, maxHeapDelta: -15,
        maxExternalDelta: 4, deltaScope: "whole_process_not_exclusive" },
    ]);
    expect(JSON.stringify(f.records())).not.toContain(result.customer);
  });

  it("preserves the original exception and completes failed work exactly once", async () => {
    const f = fixture();
    const error = new Error("private provider response");
    await expect(f.observer.run("shipping.batch", async () => { throw error; })).rejects.toBe(error);
    const finish = f.observer.begin("shipping.batch");
    finish("completed");
    finish("failed");
    f.observer.report({});
    expect(f.records()[1]).toMatchObject({ active: 0, started: 2, completed: 1, failed: 1 });
    expect(JSON.stringify(f.records())).not.toContain(error.message);
  });

  it("keeps in-flight gauges across windows and records overlapping starts", () => {
    const f = fixture();
    const first = f.observer.begin("job.one");
    const second = f.observer.begin("job.one");
    const third = f.observer.begin("job.two");
    f.observer.report({});
    expect(f.records()).toEqual(expect.arrayContaining([
      expect.objectContaining({ activeWork: 3 }),
      expect.objectContaining({ name: "job.one", active: 2, peakActive: 2, started: 2, overlappingStarts: 1 }),
      expect.objectContaining({ name: "job.two", active: 1, started: 1, overlappingStarts: 1 }),
    ]));
    f.emit.mockClear();
    f.advance(50);
    first("completed"); second("failed"); third("completed");
    f.observer.report({});
    expect(f.records()).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportSequence: 2, activeWork: 0 }),
      expect.objectContaining({ name: "job.one", active: 0, peakActive: 2, started: 0, completed: 1, failed: 1, maxDurationMs: 50 }),
    ]));
    f.emit.mockClear();
    f.observer.report({});
    expect(f.records()).toHaveLength(1);
  });

  it("copies only measurements even when the provider reuses its object", () => {
    const f = fixture();
    const point = { rss: 100, heapUsed: 60, external: 20, secret: "private" };
    f.readMemory.mockImplementation(() => point);
    const finish = f.observer.begin("job.one");
    point.rss = 140;
    finish("completed");
    f.observer.report({});
    expect(f.records()[1]).toMatchObject({ maxRssDelta: 40 });
    expect(JSON.stringify(f.records())).not.toContain("private");
  });

  it("records HTTP-style counts and duration without per-request memory sampling", () => {
    const f = fixture();
    const finish = f.observer.begin("http.api_read", false);
    f.advance(8);
    finish("completed");
    f.observer.report({});
    expect(f.readMemory).not.toHaveBeenCalled();
    expect(f.records()[1]).toMatchObject({ completed: 1, maxDurationMs: 8,
      maxRssDelta: null, maxHeapDelta: null, maxExternalDelta: null });
  });

  it("bounds cardinality and periodic output, including invalid and overflowing names", () => {
    const f = fixture();
    for (let i = 0; i < 1_000; i++) f.observer.begin(`job.${i}`)("completed");
    f.observer.begin("/orders/customer@example.com?token=secret")("completed");
    f.observer.begin("x".repeat(81))("completed");
    f.observer.report({});
    expect(f.records()).toHaveLength(MAX_RUNTIME_MEMORY_GROUPS + 1);
    expect(f.records().find(record => record.name === "other")).toMatchObject({ completed: 1_003 - MAX_RUNTIME_MEMORY_GROUPS });
    expect(JSON.stringify(f.records())).not.toContain("secret");
    f.emit.mockClear();
    f.observer.report({});
    expect(f.records()).toHaveLength(1);
  });

  it("does not fail business work when the clock or memory collector throws", async () => {
    const f = fixture();
    f.nowMs.mockImplementation(() => { throw new Error("clock failed"); });
    f.readMemory.mockImplementation(() => { throw new Error("collector failed"); });
    await expect(f.observer.run("job.one", async () => "ok")).resolves.toBe("ok");
    f.observer.report({});
    expect(f.records()[0]).toMatchObject({ telemetryFailures: 4 });
    expect(f.records()[1]).toMatchObject({ completed: 1, maxDurationMs: 0, maxRssDelta: null });
  });

  it("falls back safely if an untyped caller supplies a non-string name", async () => {
    const f = fixture();
    for (const value of [null, undefined, Symbol("private"), { private: true }]) {
      await expect(f.observer.run(value as unknown as string, async () => "ok")).resolves.toBe("ok");
    }
    f.observer.report({});
    expect(f.records()[1]).toMatchObject({ name: "other", started: 4, completed: 4 });
    expect(JSON.stringify(f.records())).not.toContain("private");
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid memory measurements (%s) without failing work", async value => {
      const f = fixture();
      f.setPoint({ rss: value, heapUsed: 0, external: 0 });
      await f.observer.run("job.one", async () => undefined);
      f.observer.report({});
      expect(f.records()[0]).toMatchObject({ telemetryFailures: 2 });
      expect(f.records()[1]).toMatchObject({ maxRssDelta: null });
    },
  );

  it("rejects invalid clocks, clamps backwards duration, and accepts zero-byte readings", () => {
    const f = fixture();
    f.setPoint({ rss: 0, heapUsed: 0, external: 0 });
    f.nowMs.mockReturnValueOnce(Number.NaN).mockReturnValueOnce(-1);
    f.observer.begin("job.invalid")("completed");
    f.nowMs.mockReturnValueOnce(100).mockReturnValueOnce(10);
    f.observer.begin("job.backwards")("completed");
    f.observer.report({});
    expect(f.records()[0]).toMatchObject({ telemetryFailures: 2 });
    expect(f.records()[2]).toMatchObject({ maxDurationMs: 0, maxRssDelta: 0 });
  });

  it("survives a broken log sink and reports missing emissions in the next window", async () => {
    const f = fixture();
    f.emit.mockImplementationOnce(() => { throw new Error("sink failed"); });
    expect(() => f.observer.report({})).not.toThrow();
    const original = new Error("work failed");
    await expect(f.observer.run("job.one", async () => { throw original; })).rejects.toBe(original);
    f.observer.report({});
    expect(f.records()[1]).toMatchObject({ telemetryFailures: 1, reportSequence: 2 });
    expect(f.records()[2]).toMatchObject({ failed: 1 });
  });
});
