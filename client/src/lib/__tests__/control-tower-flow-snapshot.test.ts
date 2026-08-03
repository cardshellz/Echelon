import { describe, expect, it } from "vitest";

import { flowSnapshotIsCurrent } from "../control-tower-flow-snapshot";

describe("flowSnapshotIsCurrent", () => {
  it("accepts current and non-stale refreshing snapshots", () => {
    expect(flowSnapshotIsCurrent({ status: "current", stale: false })).toBe(true);
    expect(flowSnapshotIsCurrent({ status: "refreshing", stale: false })).toBe(true);
  });

  it("treats failed and old payloads as historical evidence", () => {
    expect(flowSnapshotIsCurrent({ status: "degraded", stale: false })).toBe(false);
    expect(flowSnapshotIsCurrent({ status: "failed", stale: true })).toBe(false);
    expect(flowSnapshotIsCurrent({ status: "stale", stale: true })).toBe(false);
    expect(flowSnapshotIsCurrent({ status: "current", stale: true })).toBe(false);
    expect(flowSnapshotIsCurrent(null)).toBe(false);
  });
});
