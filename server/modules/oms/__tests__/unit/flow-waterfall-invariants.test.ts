/**
 * Structural guards for the Flow Monitor's declarative issue registry
 * (flow-waterfall.service.ts). These don't hit a DB — they assert the registry is
 * well-formed so adding/editing an issue can't silently break the waterfall, and
 * they pin the contradiction bug-classes the 2026-06 fulfillment audit found so a
 * future refactor can't drop them.
 */
import { describe, it, expect } from "vitest";
import { FLOW_ISSUES, CONSISTENCY_INVARIANTS } from "../../flow-waterfall.service";

const VALID_STAGES = new Set(["intake", "oms_to_wms", "wms_fulfill", "engine_push", "shipped", "writeback", "other"]);
const VALID_KINDS = new Set(["stuck", "contradiction", "duplicate", "queue_failure", "sla"]);
const VALID_SEVERITY = new Set(["critical", "warning", "info"]);
const VALID_REMEDIATION = new Set([
  "REQUEUE", "REPLAY_AFTER_STOCK", "REPLAY_AFTER_FIX", "MANUAL_REVIEW", "INVESTIGATE", "CODE_FIX", "PURGE_OBSOLETE",
]);

describe("flow-waterfall issue registry", () => {
  it("every issue is well-formed (code/kind/stage/severity/message/why/remediation + builders)", () => {
    for (const i of FLOW_ISSUES) {
      expect(i.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(VALID_KINDS.has(i.kind)).toBe(true);
      expect(VALID_STAGES.has(i.stage)).toBe(true);
      expect(VALID_SEVERITY.has(i.severity)).toBe(true);
      expect(i.message.length).toBeGreaterThan(8);
      expect(i.why.length).toBeGreaterThan(20); // the "where to look / what to do" must be substantive
      expect(VALID_REMEDIATION.has(i.remediation)).toBe(true);
      expect(typeof i.replaySafe).toBe("boolean");
      expect(typeof i.count).toBe("function");
      expect(typeof i.sample).toBe("function");
    }
  });

  it("codes are unique (no collision)", () => {
    const codes = FLOW_ISSUES.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("count/sample builders produce a query object without throwing", () => {
    const fakeWin = {}; // builders just interpolate it into sql``
    for (const i of FLOW_ISSUES) {
      expect(i.count(fakeWin)).toBeTruthy();
      expect(i.sample(fakeWin)).toBeTruthy();
    }
  });

  it("pins the bug classes found in the 2026-06 fulfillment audit", () => {
    const codes = new Set(CONSISTENCY_INVARIANTS.map((i) => i.code));
    // If any of these is ever removed, that whole class of bug goes undetected again.
    expect(codes.has("SHIPPED_SHIPMENT_CANCELLED")).toBe(true);          // dedup cancelled a shipped shipment
    expect(codes.has("ORDER_CANCELLED_WITH_SHIPPED_UNITS")).toBe(true);  // bogus-cascade "lost orders"
    expect(codes.has("SHIPMENT_SHIPPED_AT_WRONG_STATUS")).toBe(true);    // shipped_at but non-shipped status
    expect(codes.has("ORDER_SHIPPED_BUT_LINE_SHORT")).toBe(true);        // claims shipped, a line is short
    // The contradiction view is exactly the kind-filtered subset.
    expect(CONSISTENCY_INVARIANTS.every((i) => i.kind === "contradiction")).toBe(true);
  });
});
