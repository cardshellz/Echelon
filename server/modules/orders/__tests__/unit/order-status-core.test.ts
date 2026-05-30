import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isTransitionAllowed,
  isTerminalStatus,
  transitionOrderStatus,
  cancelOrder,
  markOrderShipped,
} from "../../order-status-core";
import type { WmsWarehouseStatus } from "@shared/enums/order-status";

function mockDb(currentStatus: WmsWarehouseStatus | null, updateSucceeds = true) {
  return {
    execute: vi.fn().mockImplementation((query: any) => {
      const queryStr = typeof query === "string" ? query : JSON.stringify(query);
      if (queryStr.includes("UPDATE")) {
        if (updateSucceeds && currentStatus !== null) {
          return { rows: [{ new_status: "cancelled" }] };
        }
        return { rows: [] };
      }
      // SELECT for getCurrentStatus
      if (currentStatus === null) return { rows: [] };
      return { rows: [{ warehouse_status: currentStatus }] };
    }),
  };
}

describe("isTransitionAllowed", () => {
  it("allows ready → cancelled", () => {
    expect(isTransitionAllowed("ready", "cancelled")).toBe(true);
  });

  it("allows ready → picking", () => {
    expect(isTransitionAllowed("ready", "picking")).toBe(true);
  });

  it("allows cancelled → shipped (truth wins)", () => {
    expect(isTransitionAllowed("cancelled", "shipped")).toBe(true);
  });

  it("disallows shipped → ready (terminal)", () => {
    expect(isTransitionAllowed("shipped", "ready")).toBe(false);
  });

  it("disallows shipped → cancelled (terminal)", () => {
    expect(isTransitionAllowed("shipped", "cancelled")).toBe(false);
  });

  it("disallows cancelled → ready (terminal)", () => {
    expect(isTransitionAllowed("cancelled", "ready")).toBe(false);
  });

  it("disallows same-state transition", () => {
    expect(isTransitionAllowed("ready", "ready")).toBe(false);
  });

  it("allows in-progress forward: picking → picked", () => {
    expect(isTransitionAllowed("picking", "picked")).toBe(true);
  });

  it("allows partially_shipped → shipped", () => {
    expect(isTransitionAllowed("partially_shipped", "shipped")).toBe(true);
  });

  it("allows on_hold → ready (release)", () => {
    expect(isTransitionAllowed("on_hold", "ready")).toBe(true);
  });
});

describe("isTerminalStatus", () => {
  it("marks shipped as terminal", () => {
    expect(isTerminalStatus("shipped")).toBe(true);
  });

  it("marks cancelled as terminal", () => {
    expect(isTerminalStatus("cancelled")).toBe(true);
  });

  it("does not mark ready as terminal", () => {
    expect(isTerminalStatus("ready")).toBe(false);
  });

  it("does not mark on_hold as terminal", () => {
    expect(isTerminalStatus("on_hold")).toBe(false);
  });
});

describe("transitionOrderStatus", () => {
  it("succeeds when current status is in from list", async () => {
    const db = mockDb("ready", true);
    const result = await transitionOrderStatus(db, 1, {
      from: ["ready", "picking"],
      to: "cancelled",
      reason: "test_cancel",
    });
    expect(result.transitioned).toBe(true);
    expect(result.newStatus).toBe("cancelled");
    expect(result.reason).toBe("test_cancel");
  });

  it("fails when current status is not in from list", async () => {
    const db = mockDb("shipped", false);
    const result = await transitionOrderStatus(db, 1, {
      from: ["ready", "picking"],
      to: "cancelled",
      reason: "test_cancel",
    });
    expect(result.transitioned).toBe(false);
    expect(result.previousStatus).toBe("shipped");
  });

  it("fails when order does not exist", async () => {
    const db = mockDb(null, false);
    const result = await transitionOrderStatus(db, 999, {
      from: ["ready"],
      to: "cancelled",
      reason: "test",
    });
    expect(result.transitioned).toBe(false);
    expect(result.previousStatus).toBeNull();
  });

  it("filters from-list to only legal transitions", async () => {
    // shipped → cancelled is illegal, but ready → cancelled is legal
    // Only 'ready' should be in the WHERE clause
    const db = mockDb("ready", true);
    const result = await transitionOrderStatus(db, 1, {
      from: ["ready", "shipped"],
      to: "cancelled",
      reason: "mixed_from",
    });
    expect(result.transitioned).toBe(true);
  });

  it("fails when all from states are illegal for the target", async () => {
    const db = mockDb("shipped");
    const result = await transitionOrderStatus(db, 1, {
      from: ["shipped"],
      to: "ready",
      reason: "impossible",
    });
    expect(result.transitioned).toBe(false);
    expect(result.reason).toContain("no legal transition");
  });
});

describe("cancelOrder convenience", () => {
  it("attempts cancel from all non-terminal states", async () => {
    const db = mockDb("ready", true);
    const result = await cancelOrder(db, 1, "oms_cancel");
    expect(result.transitioned).toBe(true);
    expect(result.newStatus).toBe("cancelled");
  });

  it("fails to cancel already-shipped order", async () => {
    const db = mockDb("shipped", false);
    const result = await cancelOrder(db, 1, "oms_cancel");
    expect(result.transitioned).toBe(false);
  });
});

describe("markOrderShipped convenience", () => {
  it("ships from ready_to_ship", async () => {
    const db = mockDb("ready_to_ship", true);
    const result = await markOrderShipped(db, 1, "ship_notify");
    expect(result.transitioned).toBe(true);
    expect(result.newStatus).toBe("shipped");
  });

  it("ships from cancelled (truth wins)", async () => {
    const db = mockDb("cancelled", true);
    const result = await markOrderShipped(db, 1, "engine_says_shipped");
    expect(result.transitioned).toBe(true);
  });

  it("fails to ship already-shipped order (same state)", async () => {
    const db = mockDb("shipped", false);
    const result = await markOrderShipped(db, 1, "duplicate");
    expect(result.transitioned).toBe(false);
  });
});

describe("transition matrix completeness", () => {
  const ALL_STATES: WmsWarehouseStatus[] = [
    "ready", "picking", "picked", "packing", "packed",
    "ready_to_ship", "partially_shipped", "shipped",
    "on_hold", "exception", "cancelled", "awaiting_3pl",
  ];

  it("every non-terminal state can reach cancelled", () => {
    const nonTerminal = ALL_STATES.filter((s) => !isTerminalStatus(s));
    for (const state of nonTerminal) {
      expect(
        isTransitionAllowed(state, "cancelled"),
        `${state} → cancelled should be allowed`,
      ).toBe(true);
    }
  });

  it("shipped cannot transition to anything", () => {
    for (const target of ALL_STATES) {
      if (target === "shipped") continue;
      expect(
        isTransitionAllowed("shipped", target),
        `shipped → ${target} should be disallowed`,
      ).toBe(false);
    }
  });

  it("cancelled can only transition to shipped", () => {
    for (const target of ALL_STATES) {
      if (target === "cancelled") continue;
      if (target === "shipped") {
        expect(isTransitionAllowed("cancelled", "shipped")).toBe(true);
      } else {
        expect(
          isTransitionAllowed("cancelled", target),
          `cancelled → ${target} should be disallowed`,
        ).toBe(false);
      }
    }
  });
});
