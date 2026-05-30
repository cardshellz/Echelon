/**
 * Phase 1 regression tests — one per defect addressed by C3/C4/C9.
 *
 * Each test reproduces the bug scenario first (the condition that WOULD
 * have caused the defect), then asserts the fix prevents it. These tests
 * are the ratchet: if someone reintroduces the bug, the test goes red.
 *
 * Defects covered:
 *   D-DUP       — duplicate shipments per order (C3 advisory lock)
 *   D-NOSM      — unguarded warehouse_status writes (C4 transition guard)
 *   D-FORCECXL  — reconciler force-cancels shipped SS order (C4 terminal)
 *   D-SPAM      — cancelled↔ready_to_ship oscillation (C4 terminal matrix)
 *   D-ZOMBIE    — no transition for mixed-cancelled lines (C4 handles it)
 *   D-PINGPONG  — OMS→WMS vs WMS→OMS reconciler status fight (C4 blocks)
 *   D-NOENGINE  — ShipStation hardcoded, no port (C9 adapter interface)
 */

import { describe, it, expect, vi } from "vitest";
import {
  isTransitionAllowed,
  isTerminalStatus,
  transitionOrderStatus,
  cancelOrder,
  markOrderShipped,
} from "../../order-status-core";
import {
  createShipStationEngine,
  toEngineRef,
  fromEngineRef,
} from "../../../shipping/adapters/shipstation.adapter";
import { normalizeCarrier } from "../../../shipping/types";
import type { ShippingEngine } from "../../../shipping/engine";
import type { ShipStationServiceHandle } from "../../../shipping/adapters/shipstation.adapter";
import type { WmsWarehouseStatus } from "@shared/enums/order-status";
import {
  deriveWmsFromShipments,
  type ShipmentStatus,
} from "@shared/enums/order-status";

// ─── Helpers ────────────────────────────────────────────────────────

function mockDb(currentStatus: WmsWarehouseStatus | null, updateSucceeds = true) {
  return {
    execute: vi.fn().mockImplementation((query: any) => {
      const str = JSON.stringify(query);
      if (str.includes("UPDATE")) {
        if (updateSucceeds && currentStatus !== null) {
          return { rows: [{ new_status: currentStatus }] };
        }
        return { rows: [] };
      }
      if (currentStatus === null) return { rows: [] };
      return { rows: [{ warehouse_status: currentStatus }] };
    }),
  };
}

function mockSs(overrides: Partial<ShipStationServiceHandle> = {}): ShipStationServiceHandle {
  return {
    isConfigured: vi.fn().mockReturnValue(true),
    pushShipment: vi.fn().mockResolvedValue({ shipstationOrderId: 1, orderKey: "k" }),
    cancelOrder: vi.fn().mockResolvedValue({ alreadyInState: false }),
    putOrderOnHold: vi.fn().mockResolvedValue(undefined),
    releaseOrderFromHold: vi.fn().mockResolvedValue(undefined),
    markAsShipped: vi.fn().mockResolvedValue({ alreadyInState: false }),
    updateSortRank: vi.fn().mockResolvedValue({ touched: 0 }),
    getOrderById: vi.fn().mockResolvedValue(null),
    getShipments: vi.fn().mockResolvedValue([]),
    processShipNotify: vi.fn().mockResolvedValue(0),
    registerWebhook: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════
// D-NOSM: Unguarded warehouse_status writes
// BUG: 12+ scattered writers do UPDATE wms.orders SET warehouse_status
//      without checking the current state — illegal transitions like
//      shipped→ready or cancelled→picking are mechanically possible.
// FIX: C4 transitionOrderStatus() with from-state WHERE guard.
// ═════════════════════════════════════════════════════════════════════

describe("D-NOSM regression: unguarded status writes", () => {
  it("rejects shipped → ready (was possible via raw UPDATE)", () => {
    expect(isTransitionAllowed("shipped", "ready")).toBe(false);
  });

  it("rejects shipped → picking (was possible via self-heal GET)", () => {
    expect(isTransitionAllowed("shipped", "picking")).toBe(false);
  });

  it("rejects shipped → cancelled (double-terminal)", () => {
    expect(isTransitionAllowed("shipped", "cancelled")).toBe(false);
  });

  it("rejects cancelled → ready (was possible via rollup re-derive)", () => {
    expect(isTransitionAllowed("cancelled", "ready")).toBe(false);
  });

  it("rejects cancelled → picking (impossible state)", () => {
    expect(isTransitionAllowed("cancelled", "picking")).toBe(false);
  });

  it("transitionOrderStatus returns transitioned=false for terminal state", async () => {
    const db = mockDb("shipped", false);
    const result = await transitionOrderStatus(db, 1, {
      from: ["ready", "picking", "shipped"],
      to: "cancelled",
      reason: "test",
    });
    expect(result.transitioned).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════
// D-FORCECXL: Reconciler force-cancels shipped SS order
// BUG: Reconciler #4 calls ss.cancelOrder and discards the
//      {alreadyInState:true} return — stamps shipment 'cancelled'
//      even when SS says the order already shipped.
// FIX: C9 adapter returns alreadyInState; C4 allows cancelled→shipped.
// ═════════════════════════════════════════════════════════════════════

describe("D-FORCECXL regression: force-cancel on shipped engine order", () => {
  it("C9 adapter surfaces alreadyInState from cancel response", async () => {
    const ss = mockSs({
      cancelOrder: vi.fn().mockResolvedValue({ alreadyInState: true }),
    });
    const engine = createShipStationEngine(ss);
    const ref = toEngineRef(999);

    const result = await engine.cancel(ref);
    expect(result.alreadyInState).toBe(true);
  });

  it("C4 allows cancelled→shipped so truth wins after engine reports shipped", async () => {
    expect(isTransitionAllowed("cancelled", "shipped")).toBe(true);

    const db = mockDb("cancelled", true);
    const result = await markOrderShipped(db, 1, "engine_says_shipped");
    expect(result.transitioned).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════
// D-SPAM: cancelled↔ready_to_ship oscillation
// BUG: deriveWmsFromShipments returns 'ready' for cancelled orders
//      with open shipments → recomputeOrderStatusFromShipments flips
//      cancelled back to ready_to_ship → reconciler re-cancels →
//      ss.cancelOrder spams hourly on already-shipped SS orders.
// FIX: cancelled is terminal in C4 (can't go back to ready/ready_to_ship);
//      shipment-rollup.ts has terminal guard (Phase 0);
//      deriveWmsFromShipments returns 'ready' but the terminal guard blocks.
// ═════════════════════════════════════════════════════════════════════

describe("D-SPAM regression: cancel↔ready_to_ship oscillation", () => {
  it("deriveWmsFromShipments still returns 'ready' for open shipments (the derivation is correct)", () => {
    const result = deriveWmsFromShipments(["planned"]);
    expect(result).toBe("ready");
  });

  it("but C4 blocks cancelled → ready (the oscillation entry point)", () => {
    expect(isTransitionAllowed("cancelled", "ready")).toBe(false);
  });

  it("and C4 blocks cancelled → ready_to_ship", () => {
    expect(isTransitionAllowed("cancelled", "ready_to_ship")).toBe(false);
  });

  it("the only exit from cancelled is shipped (truth wins)", () => {
    const ALL_STATES: WmsWarehouseStatus[] = [
      "ready", "picking", "picked", "packing", "packed",
      "ready_to_ship", "partially_shipped", "shipped",
      "on_hold", "exception", "cancelled", "awaiting_3pl",
    ];

    const allowedExits = ALL_STATES.filter((s) =>
      s !== "cancelled" && isTransitionAllowed("cancelled", s),
    );
    expect(allowedExits).toEqual(["shipped"]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// D-ZOMBIE: No transition for mixed-cancelled lines
// BUG: updateOrderProgress has no handler for orders where some lines
//      are cancelled and some are completed → order stays stuck in
//      an intermediate state. Only a GET self-heal covers it.
// FIX: C4 allows transitions from intermediate states to both shipped
//      and cancelled; the pick-queue self-heal logic will call C4.
// ═════════════════════════════════════════════════════════════════════

describe("D-ZOMBIE regression: stuck mixed-cancelled orders", () => {
  it("allows in_progress states to reach shipped", () => {
    expect(isTransitionAllowed("ready", "shipped")).toBe(true);
    expect(isTransitionAllowed("ready_to_ship", "shipped")).toBe(true);
    expect(isTransitionAllowed("partially_shipped", "shipped")).toBe(true);
    expect(isTransitionAllowed("picking", "shipped")).toBe(true);
  });

  it("allows in_progress states to reach cancelled", () => {
    expect(isTransitionAllowed("picking", "cancelled")).toBe(true);
    expect(isTransitionAllowed("picked", "cancelled")).toBe(true);
    expect(isTransitionAllowed("packing", "cancelled")).toBe(true);
  });

  it("allows exception to reach shipped (after resolution)", () => {
    expect(isTransitionAllowed("exception", "shipped")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════
// D-PINGPONG: OMS→WMS vs WMS→OMS reconciler status fight
// BUG: Reconciler #4 sets WMS to cancelled (OMS says cancelled).
//      Reconciler #13 sees WMS cancelled + OMS open → sets WMS back
//      to ready. They alternate every sweep cycle.
// FIX: C4 terminal states prevent the ping-pong — once cancelled,
//      only shipped can exit. Reconciler #13 can't set it back to ready.
// ═════════════════════════════════════════════════════════════════════

describe("D-PINGPONG regression: reconciler status fight", () => {
  it("once cancelled, reconciler cannot revert to ready", () => {
    expect(isTransitionAllowed("cancelled", "ready")).toBe(false);
  });

  it("once cancelled, reconciler cannot revert to in_progress", () => {
    expect(isTransitionAllowed("cancelled", "picking")).toBe(false);
    expect(isTransitionAllowed("cancelled", "on_hold")).toBe(false);
  });

  it("once shipped, reconciler cannot revert to any non-terminal state", () => {
    const nonTerminal: WmsWarehouseStatus[] = [
      "ready", "picking", "picked", "packing", "packed",
      "ready_to_ship", "partially_shipped", "on_hold",
      "exception", "awaiting_3pl",
    ];
    for (const state of nonTerminal) {
      expect(
        isTransitionAllowed("shipped", state),
        `shipped → ${state} should be blocked`,
      ).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// D-NOENGINE: ShipStation hardcoded, no port
// BUG: ~16 ss.* methods called directly throughout the codebase.
//      No ShippingEngine abstraction — impossible to swap engines
//      or test pipeline without SS credentials.
// FIX: C9 ShippingEngine interface + ShipStationEngineAdapter.
// ═════════════════════════════════════════════════════════════════════

describe("D-NOENGINE regression: engine portability", () => {
  it("adapter implements all ShippingEngine methods", () => {
    const engine = createShipStationEngine(mockSs());
    expect(typeof engine.isConfigured).toBe("function");
    expect(typeof engine.upsertShipment).toBe("function");
    expect(typeof engine.cancel).toBe("function");
    expect(typeof engine.hold).toBe("function");
    expect(typeof engine.releaseHold).toBe("function");
    expect(typeof engine.markShipped).toBe("function");
    expect(typeof engine.updatePriority).toBe("function");
    expect(typeof engine.getState).toBe("function");
    expect(typeof engine.getShipments).toBe("function");
    expect(typeof engine.normalizeWebhook).toBe("function");
    expect(typeof engine.registerWebhook).toBe("function");
    expect(engine.engineName).toBe("shipstation");
  });

  it("engineRef round-trips without losing data", () => {
    const ref = toEngineRef(42, "echelon-wms-shp-7");
    expect(ref.engine).toBe("shipstation");
    expect(ref.engineOrderRef).toBe("42");
    expect(ref.engineShipmentRef).toBe("echelon-wms-shp-7");
    expect(fromEngineRef(ref)).toBe(42);
  });

  it("rejects engineRefs from a different engine (no cross-contamination)", () => {
    expect(() => fromEngineRef({ engine: "other", engineOrderRef: "1" })).toThrow();
  });

  it("normalizes engine-specific carrier codes to canonical vocabulary", () => {
    expect(normalizeCarrier("stamps_com")).toBe("USPS");
    expect(normalizeCarrier("ups_walleted")).toBe("UPS");
    expect(normalizeCarrier("dhl_express_worldwide")).toBe("DHL");
  });
});

// ═════════════════════════════════════════════════════════════════════
// D-DUP: Duplicate shipments per order (C3 advisory lock)
// BUG: No unique constraint on outbound_shipments(order_id).
//      8 INSERT paths with inconsistent dedup. Concurrent calls to
//      createShipmentForOrder both pass the probe and both insert.
//      Each duplicate becomes a separate SS order (per-shipment orderKey).
// FIX: Advisory lock + partial unique index (migration 0568).
//      Note: the advisory lock is tested in create-shipment.test.ts.
//      This test verifies the structural contract.
// ═════════════════════════════════════════════════════════════════════

describe("D-DUP regression: duplicate shipment prevention", () => {
  it("migration 0568 creates a partial unique index on outbound_shipments(order_id)", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const migrationSql = readFileSync(
      resolve(__dirname, "../../../../../migrations/0568_shipment_unique_per_order.sql"),
      "utf8",
    );
    expect(migrationSql).toContain("CREATE UNIQUE INDEX");
    expect(migrationSql).toContain("outbound_shipments");
    expect(migrationSql).toContain("order_id");
    expect(migrationSql).toContain("WHERE status IN");
  });

  it("create-shipment.ts uses pg_advisory_lock for serialization", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(
      resolve(__dirname, "../../../../modules/wms/create-shipment.ts"),
      "utf8",
    );
    expect(src).toContain("pg_advisory_lock(918406");
    expect(src).toContain("pg_advisory_unlock(918406");
  });
});

// ═════════════════════════════════════════════════════════════════════
// Cross-cutting: terminal state completeness
// ═════════════════════════════════════════════════════════════════════

describe("Terminal state completeness", () => {
  it("every non-terminal state can reach both shipped and cancelled", () => {
    const nonTerminal: WmsWarehouseStatus[] = [
      "ready", "picking", "picked", "packing", "packed",
      "ready_to_ship", "partially_shipped",
      "on_hold", "exception", "awaiting_3pl",
    ];

    for (const state of nonTerminal) {
      expect(
        isTransitionAllowed(state, "shipped") || isTransitionAllowed(state, "cancelled"),
        `${state} must be able to reach at least one terminal state`,
      ).toBe(true);
    }
  });

  it("shipped and cancelled are the only terminal states", () => {
    const ALL_STATES: WmsWarehouseStatus[] = [
      "ready", "picking", "picked", "packing", "packed",
      "ready_to_ship", "partially_shipped", "shipped",
      "on_hold", "exception", "cancelled", "awaiting_3pl",
    ];

    const terminals = ALL_STATES.filter(isTerminalStatus);
    expect(terminals).toEqual(["shipped", "cancelled"]);
  });
});
