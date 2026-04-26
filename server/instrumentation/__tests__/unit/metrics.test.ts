/**
 * Unit tests for `server/instrumentation/metrics.ts` (§6 Commit 36).
 *
 * Tests the structure-log emit shape, label formatting, and the
 * never-throw contract. The actual upgrade path to prom-client (or
 * any other backend) replaces only the `console.log` line; the
 * caller-facing API stays the same.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { incr, formatLabels, type CounterName } from "../../metrics";

describe("metrics.incr — structured log emit", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("emits metric=<name> count=<n> with default count=1 and no labels", () => {
    incr("ss_push_succeeded");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toBe("metric=ss_push_succeeded count=1");
  });

  it("emits the explicit count when provided", () => {
    incr("shopify_push_attempted", 3);
    expect(logSpy.mock.calls[0][0]).toBe("metric=shopify_push_attempted count=3");
  });

  it("appends label tokens when labels object is provided", () => {
    incr("ss_ship_notify_dlq_enqueued", 1, { topic: "SHIP_NOTIFY", reason: "transient" });
    expect(logSpy.mock.calls[0][0]).toBe(
      "metric=ss_ship_notify_dlq_enqueued count=1 topic=SHIP_NOTIFY reason=transient",
    );
  });

  it("coerces numeric label values to strings", () => {
    incr("shopify_push_failed", 1, { shipmentId: 42, attempts: 3 });
    expect(logSpy.mock.calls[0][0]).toBe(
      "metric=shopify_push_failed count=1 shipmentId=42 attempts=3",
    );
  });

  it("coerces boolean label values to strings", () => {
    incr("shopify_cancel_succeeded", 1, { alreadyCancelled: true });
    expect(logSpy.mock.calls[0][0]).toBe(
      "metric=shopify_cancel_succeeded count=1 alreadyCancelled=true",
    );
  });

  it("replaces whitespace in label values with underscores so each k=v is one token", () => {
    incr("shopify_push_failed", 1, { reason: "shopify api timeout" });
    expect(logSpy.mock.calls[0][0]).toBe(
      "metric=shopify_push_failed count=1 reason=shopify_api_timeout",
    );
  });

  it("JSON-stringifies object label values inline", () => {
    incr("ss_reconcile_v2_divergence", 1, { evidence: { ssStatus: "shipped", wmsStatus: "queued" } });
    // The object stringification produces `{"ssStatus":"shipped","wmsStatus":"queued"}`
    // which has no whitespace to begin with; assert the line shape.
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("metric=ss_reconcile_v2_divergence");
    expect(line).toContain("count=1");
    expect(line).toContain('evidence={"ssStatus":"shipped","wmsStatus":"queued"}');
  });

  it("renders null/undefined label values as 'null'", () => {
    incr("wms_sync_validation_failed", 1, { field: "totalCents", value: null as any });
    expect(logSpy.mock.calls[0][0]).toBe(
      "metric=wms_sync_validation_failed count=1 field=totalCents value=null",
    );
  });

  it("does not throw when emit fails — caller's hot path is protected", () => {
    // Force JSON.stringify to throw by passing a circular-reference object
    const circ: any = {};
    circ.self = circ;
    expect(() => incr("ss_push_succeeded", 1, { circ })).not.toThrow();
    // The warn path should fire instead
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("[metrics] incr emit failed");
  });

  it("type-narrows CounterName at the call site (compile-time check)", () => {
    // Sanity: a valid name compiles without `as any`.
    const valid: CounterName = "shopify_push_succeeded";
    incr(valid);
    expect(logSpy.mock.calls[0][0]).toContain("metric=shopify_push_succeeded");
    // Invalid would not compile (this comment serves as documentation;
    // an `// @ts-expect-error` next to a bad string would prove it).
  });
});

describe("metrics.formatLabels — exported helper", () => {
  it("returns empty string when labels is undefined", () => {
    expect(formatLabels(undefined)).toBe("");
  });

  it("returns empty string when labels is empty object", () => {
    expect(formatLabels({})).toBe("");
  });

  it("preserves insertion order of keys", () => {
    expect(formatLabels({ a: 1, b: 2, c: 3 })).toBe("a=1 b=2 c=3");
  });

  it("handles a single label cleanly", () => {
    expect(formatLabels({ k: "v" })).toBe("k=v");
  });
});
