import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SHIPMENT_STATUS_TRANSITION_MATRIX,
  allowedShipmentFromStatuses,
  isShipmentTransitionAllowed,
  isTerminalShipmentStatus,
  transitionShipmentStatus,
} from "../../shipment-status-core";
import {
  WMS_WAREHOUSE_STATUS_TRANSITION_MATRIX,
  allowedWmsOrderFromStatuses,
  isTerminalWmsOrderStatus,
  isWmsOrderTransitionAllowed,
} from "../../wms-order-status-core";
import {
  assignWmsOrderToWarehouseInWms,
  releaseLockedPickingAssignmentInWms,
  transitionWmsOrderStatusByMatrixReturningInWms,
  updateActiveWmsOrderFieldsReturningInWms,
  updateWmsOrderByIdInWms,
  updateWmsOrderByIdReturningInWms,
} from "../../wms-order-mutations.repository";

const WMS_ROOT = path.resolve(__dirname, "../..");

function collectWmsProductionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectWmsProductionFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("P1.1 & P1.3: WMS Shipment & Order Status State-Machine Chokepoints", () => {
  describe("P1.1: Shipment status transition matrix & CAS transitionShipmentStatus", () => {
    it("enforces physical shipment finality against cancellation and queue regression", () => {
      expect(isShipmentTransitionAllowed("planned", "queued")).toBe(true);
      expect(isShipmentTransitionAllowed("queued", "labeled")).toBe(true);
      expect(isShipmentTransitionAllowed("labeled", "shipped")).toBe(true);
      expect(isShipmentTransitionAllowed("voided", "queued")).toBe(true);
      expect(isShipmentTransitionAllowed("cancelled", "shipped")).toBe(true);

      expect(isShipmentTransitionAllowed("shipped", "cancelled")).toBe(false);
      expect(isShipmentTransitionAllowed("returned", "cancelled")).toBe(false);
      expect(isShipmentTransitionAllowed("lost", "cancelled")).toBe(false);
      expect(isShipmentTransitionAllowed("shipped", "queued")).toBe(false);
      expect(isShipmentTransitionAllowed("cancelled", "queued")).toBe(false);
      expect(isShipmentTransitionAllowed("cancelled", "voided")).toBe(false);
      expect(isShipmentTransitionAllowed("returned", "voided")).toBe(false);
      expect(isShipmentTransitionAllowed("lost", "voided")).toBe(false);

      expect(isTerminalShipmentStatus("shipped")).toBe(true);
      expect(isTerminalShipmentStatus("cancelled")).toBe(true);
      expect(isTerminalShipmentStatus("voided")).toBe(false);
      expect(allowedShipmentFromStatuses("cancelled")).toEqual([
        "planned",
        "queued",
        "labeled",
        "voided",
      ]);
      expect(Object.keys(SHIPMENT_STATUS_TRANSITION_MATRIX)).toHaveLength(8);
    });

    it("returns discriminated transitioned / already_in_state / blocked_by_state / not_found verdicts", async () => {
      const transitionedDb = {
        execute: vi.fn().mockResolvedValueOnce({
          rows: [{ previous_status: "queued", new_status: "cancelled" }],
        }),
      };
      const ok = await transitionShipmentStatus(transitionedDb, 101, {
        to: "cancelled",
        reason: "customer_cancel",
      });
      expect(ok).toEqual({
        outcome: "transitioned",
        transitioned: true,
        shipmentId: 101,
        previousStatus: "queued",
        newStatus: "cancelled",
        reason: "customer_cancel",
      });

      const alreadyDb = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ status: "cancelled", shipped_at: null }] }),
      };
      const already = await transitionShipmentStatus(alreadyDb, 101, {
        to: "cancelled",
        reason: "duplicate_cancel",
      });
      expect(already.outcome).toBe("already_in_state");
      expect(already.transitioned).toBe(false);

      const blockedShippedDb = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({
            rows: [{ status: "queued", shipped_at: "2026-11-18T10:00:00Z" }],
          }),
      };
      const blocked = await transitionShipmentStatus(blockedShippedDb, 101, {
        to: "cancelled",
        reason: "late_cancel",
      });
      expect(blocked.outcome).toBe("blocked_by_state");
      if (blocked.outcome === "blocked_by_state") {
        expect(blocked.shippedAt).toBe("2026-11-18T10:00:00Z");
        expect(blocked.reason).toContain("shipped_at");
      }

      const missingDb = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
      };
      const missing = await transitionShipmentStatus(missingDb, 999, {
        to: "cancelled",
        reason: "missing",
      });
      expect(missing).toEqual({
        outcome: "not_found",
        transitioned: false,
        shipmentId: 999,
        reason: "shipment 999 not found",
      });
    });

    it("guards every UPDATE wms.outbound_shipments status mutation in modules/wms with a status predicate", () => {
      const files = collectWmsProductionFiles(WMS_ROOT);
      const unguarded: string[] = [];

      for (const file of files) {
        const rel = path.relative(WMS_ROOT, file).replace(/\\/g, "/");
        const content = fs.readFileSync(file, "utf8");
        const updateBlocks = content.match(
          /UPDATE\s+wms\.outbound_shipments[\s\S]*?(?:;|`|\$\d+(?:\s*\))?)/g,
        );
        if (!updateBlocks) continue;

        // Inspect each exported function or statement updating status
        const chunks = content.split(/export\s+async\s+function\s+/);
        for (const chunk of chunks) {
          if (!/UPDATE\s+wms\.outbound_shipments/.test(chunk)) continue;
          if (!/\bSET\b[\s\S]*?\bstatus\s*=/.test(chunk)) continue;
          const hasStatusWhere =
            /\bWHERE\b[\s\S]*?\bstatus\b/.test(chunk) ||
            /prior\.status\s+IN/.test(chunk);
          if (!hasStatusWhere) {
            const fnName = chunk.split("(")[0]?.trim() || "inline";
            unguarded.push(`${rel}::${fnName}`);
          }
        }
      }

      expect(unguarded).toEqual([]);
    });
  });

  describe("P1.3: WMS warehouse_status chokepoint & generic updater status stripping", () => {
    it("enforces terminal warehouse_status invariants with truth-wins cancelled -> shipped only", () => {
      expect(isTerminalWmsOrderStatus("shipped")).toBe(true);
      expect(isTerminalWmsOrderStatus("cancelled")).toBe(true);
      expect(isTerminalWmsOrderStatus("ready")).toBe(false);

      expect(isWmsOrderTransitionAllowed("in_progress", "ready")).toBe(true);
      expect(isWmsOrderTransitionAllowed("cancelled", "shipped")).toBe(true);
      expect(isWmsOrderTransitionAllowed("cancelled", "ready")).toBe(false);
      expect(isWmsOrderTransitionAllowed("shipped", "ready")).toBe(false);
      expect(isWmsOrderTransitionAllowed("shipped", "cancelled")).toBe(false);
      expect(allowedWmsOrderFromStatuses("awaiting_3pl")).toEqual(["ready", "on_hold"]);
      expect(Object.keys(WMS_WAREHOUSE_STATUS_TRANSITION_MATRIX)).toHaveLength(14);
    });

    it("prevents generic field updaters from writing warehouseStatus even via untyped casts", async () => {
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 7 }]),
        }),
      });
      const client = { update: vi.fn().mockReturnValue({ set: setMock }) };

      await updateWmsOrderByIdInWms(client, 7, {
        notes: "keep",
        ...({ warehouseStatus: "ready" } as Record<string, unknown>),
      });
      expect(setMock).toHaveBeenCalledWith({ notes: "keep" });

      setMock.mockClear();
      const onlyStatusRows = await updateWmsOrderByIdReturningInWms(
        client,
        7,
        { warehouseStatus: "shipped" } as unknown as Record<string, never>,
      );
      expect(onlyStatusRows).toEqual([]);
      expect(setMock).not.toHaveBeenCalled();

      const activeRows = await updateActiveWmsOrderFieldsReturningInWms(
        client,
        7,
        { warehouseStatus: "cancelled" } as unknown as Record<string, never>,
      );
      expect(activeRows).toEqual([]);
      expect(setMock).not.toHaveBeenCalled();
    });

    it("routes matrix transitions, picker release, and 3PL assignment through guarded Drizzle predicates", async () => {
      const returning = vi.fn().mockResolvedValue([{ id: 42, warehouseStatus: "ready" }]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      const client = { update: vi.fn().mockReturnValue({ set }) };

      await transitionWmsOrderStatusByMatrixReturningInWms(client, 42, "cancelled", {
        exceptionResolution: "cancelled",
      });
      expect(set).toHaveBeenCalledWith({
        exceptionResolution: "cancelled",
        warehouseStatus: "cancelled",
      });
      expect(where).toHaveBeenCalledTimes(1);

      set.mockClear();
      where.mockClear();
      await releaseLockedPickingAssignmentInWms(client, 42);
      expect(set).toHaveBeenCalledWith({
        warehouseStatus: "ready",
        assignedPickerId: null,
        startedAt: null,
      });
      expect(where).toHaveBeenCalledTimes(1);

      set.mockClear();
      where.mockClear();
      await assignWmsOrderToWarehouseInWms(client, 42, {
        warehouseId: 9,
        routeTo3pl: true,
        updatedAt: new Date("2026-11-18T12:00:00Z"),
      });
      expect(set).toHaveBeenCalledWith({
        warehouseId: 9,
        warehouseStatus: "awaiting_3pl",
        updatedAt: new Date("2026-11-18T12:00:00Z"),
      });
      expect(where).toHaveBeenCalledTimes(1);
    });

    it("eliminates the phantom wms.orders.status column write in wms-order-mutations.repository.ts", () => {
      const src = fs.readFileSync(
        path.join(WMS_ROOT, "wms-order-mutations.repository.ts"),
        "utf8",
      );
      expect(src).not.toMatch(/UPDATE\s+wms\.orders\b[\s\S]{0,120}?\bSET\s+status\s*=/);
      expect(src).toContain("warehouse_status = 'completed'");
    });
  });
});
