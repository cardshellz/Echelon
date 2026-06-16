/**
 * Structural guards for the Flow Monitor's declarative consistency-invariant
 * registry (flow-waterfall.service.ts). These don't hit a DB — they assert the
 * registry is well-formed so adding/editing an invariant can't silently break
 * the waterfall, and they pin the bug classes the 2026-06 fulfillment audit
 * found so a future refactor can't drop them.
 */
import { describe, it, expect } from "vitest";
import { CONSISTENCY_INVARIANTS } from "../../flow-waterfall.service";

const VALID_STAGES = new Set(["intake", "oms_to_wms", "wms_fulfill", "engine_push", "shipped", "writeback", "other"]);

describe("flow-waterfall consistency invariants", () => {
  it("every invariant is well-formed (code/severity/stage/message/why + count & sample builders)", () => {
    for (const inv of CONSISTENCY_INVARIANTS) {
      expect(inv.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(["critical", "warning"]).toContain(inv.severity);
      expect(VALID_STAGES.has(inv.stage)).toBe(true);
      expect(inv.message.length).toBeGreaterThan(10);
      expect(inv.why.length).toBeGreaterThan(20); // the "where to look" must be substantive
      expect(typeof inv.count).toBe("function");
      expect(typeof inv.sample).toBe("function");
    }
  });

  it("codes are unique (no collision with each other)", () => {
    const codes = CONSISTENCY_INVARIANTS.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("count/sample builders produce a query object without throwing", () => {
    const fakeWin = {}; // builders just interpolate it into sql``
    for (const inv of CONSISTENCY_INVARIANTS) {
      expect(inv.count(fakeWin)).toBeTruthy();
      expect(inv.sample(fakeWin)).toBeTruthy();
    }
  });

  it("pins the bug classes found in the 2026-06 fulfillment audit", () => {
    const codes = new Set(CONSISTENCY_INVARIANTS.map((i) => i.code));
    // If any of these is ever removed, that whole class of bug goes undetected again.
    expect(codes.has("SHIPPED_SHIPMENT_CANCELLED")).toBe(true);          // dedup cancelled a shipped shipment
    expect(codes.has("ORDER_CANCELLED_WITH_SHIPPED_UNITS")).toBe(true);  // bogus-cascade "lost orders"
    expect(codes.has("SHIPMENT_SHIPPED_AT_WRONG_STATUS")).toBe(true);    // shipped_at but non-shipped status
    expect(codes.has("ORDER_SHIPPED_BUT_LINE_SHORT")).toBe(true);        // claims shipped, a line is short
  });
});
