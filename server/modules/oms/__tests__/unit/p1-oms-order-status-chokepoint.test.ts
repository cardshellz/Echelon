import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  OMS_DRIVER_ALLOWED_TARGETS,
  OMS_ORDER_LIFECYCLE_STATUS_VALUES,
  OMS_ORDER_STATUS_TRANSITION_MATRIX,
  allowedOmsOrderFromStatuses,
  isNonCancellableOmsOrderStatus,
  isOmsOrderTransitionAllowed,
  isTerminalOmsOrderStatus,
  recordShipmentOutcome,
  recordShipmentOutcomeInOms,
  transitionOmsOrderStatus,
} from "../../channel-fulfillment-authority.api";

const OMS_ROOT = path.resolve(__dirname, "../..");

function collectProductionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...collectProductionFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("P1.2: OMS order status state-machine chokepoint", () => {
  describe("transition matrix and driver rules", () => {
    it("forbids cancelling any physically dispatched or refunded OMS order", () => {
      for (const status of ["partially_shipped", "shipped", "delivered", "refunded"] as const) {
        expect(isNonCancellableOmsOrderStatus(status)).toBe(true);
        expect(isOmsOrderTransitionAllowed(status, "cancelled")).toBe(false);
        expect(OMS_ORDER_STATUS_TRANSITION_MATRIX.cancelled.has(status)).toBe(false);
      }

      for (const status of ["pending", "confirmed", "paid", "processing"] as const) {
        expect(isNonCancellableOmsOrderStatus(status)).toBe(false);
        expect(isOmsOrderTransitionAllowed(status, "cancelled", "channel")).toBe(true);
      }
    });

    it("protects cancelled, refunded, and delivered orders against backward fulfillment regression", () => {
      for (const terminal of ["cancelled", "refunded", "delivered"] as const) {
        expect(isTerminalOmsOrderStatus(terminal)).toBe(true);
        expect(isOmsOrderTransitionAllowed(terminal, "shipped")).toBe(false);
        expect(isOmsOrderTransitionAllowed(terminal, "partially_shipped")).toBe(false);
        expect(isOmsOrderTransitionAllowed(terminal, "confirmed")).toBe(false);
        expect(isOmsOrderTransitionAllowed(terminal, "processing")).toBe(false);
      }
    });

    it("restricts the shipping engine driver from cancelling or refunding OMS orders", () => {
      expect(OMS_DRIVER_ALLOWED_TARGETS.engine.has("cancelled")).toBe(false);
      expect(OMS_DRIVER_ALLOWED_TARGETS.engine.has("refunded")).toBe(false);
      expect(isOmsOrderTransitionAllowed("confirmed", "cancelled", "engine")).toBe(false);
      expect(allowedOmsOrderFromStatuses("cancelled", "engine")).toEqual([]);
      expect(allowedOmsOrderFromStatuses("shipped", "engine")).toEqual([
        "pending",
        "confirmed",
        "paid",
        "processing",
        "partially_shipped",
        "shipped",
      ]);
      expect(OMS_ORDER_LIFECYCLE_STATUS_VALUES).toHaveLength(9);
    });
  });

  describe("transitionOmsOrderStatus CAS verdicts", () => {
    it("transitions a pre-dispatch order to cancelled and emits an optional audit event", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              previous_status: "confirmed",
              new_status: "cancelled",
              financial_status: "voided",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });

      const verdict = await transitionOmsOrderStatus({ execute }, 501, {
        to: "cancelled",
        driver: "channel",
        reason: "customer_cancel",
        financialStatus: "voided",
        event: {
          eventType: "status_transitioned",
          details: { source: "unit_test" },
        },
      });

      expect(verdict).toEqual({
        outcome: "transitioned",
        transitioned: true,
        omsOrderId: 501,
        previousStatus: "confirmed",
        newStatus: "cancelled",
        financialStatus: "voided",
        reason: "customer_cancel",
      });
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("returns already_in_state when order is already cancelled with null shipped_at", async () => {
      const execute = vi.fn().mockResolvedValueOnce({
        rows: [{ status: "cancelled", financial_status: "refunded", shipped_at: null }],
      });

      const verdict = await transitionOmsOrderStatus({ execute }, 502, {
        from: ["cancelled"],
        to: "cancelled",
        driver: "channel",
        reason: "duplicate_cancel",
      });

      expect(verdict).toEqual({
        outcome: "already_in_state",
        transitioned: false,
        omsOrderId: 502,
        currentStatus: "cancelled",
        financialStatus: "refunded",
        reason: "OMS order 502 is already in 'cancelled'",
      });
    });

    it("returns blocked_by_state when attempting to cancel an already shipped order", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // CAS UPDATE matched 0 rows
        .mockResolvedValueOnce({
          rows: [
            {
              status: "shipped",
              financial_status: "paid",
              shipped_at: "2026-11-18T10:00:00.000Z",
            },
          ],
        });

      const verdict = await transitionOmsOrderStatus({ execute }, 503, {
        to: "cancelled",
        driver: "channel",
        reason: "late_shopify_cancel",
      });

      expect(verdict.outcome).toBe("blocked_by_state");
      expect(verdict.transitioned).toBe(false);
      if (verdict.outcome === "blocked_by_state") {
        expect(verdict.currentStatus).toBe("shipped");
        expect(verdict.shippedAt).toBe("2026-11-18T10:00:00.000Z");
      }
    });

    it("returns blocked_by_state when status is confirmed yet shipped_at is populated", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // CAS UPDATE blocked by shipped_at IS NULL
        .mockResolvedValueOnce({
          rows: [
            {
              status: "confirmed",
              financial_status: "paid",
              shipped_at: "2026-11-18T11:30:00.000Z",
            },
          ],
        });

      const verdict = await transitionOmsOrderStatus({ execute }, 504, {
        to: "cancelled",
        driver: "reconciler",
        reason: "cancel_reconciliation",
      });

      expect(verdict.outcome).toBe("blocked_by_state");
      if (verdict.outcome === "blocked_by_state") {
        expect(verdict.reason).toContain("carries shipped_at");
      }
    });

    it("returns blocked_by_state without running CAS UPDATE when driver is forbidden", async () => {
      const execute = vi.fn().mockResolvedValueOnce({
        rows: [{ status: "confirmed", financial_status: "paid", shipped_at: null }],
      });

      const verdict = await transitionOmsOrderStatus({ execute }, 505, {
        to: "cancelled",
        driver: "engine",
        reason: "engine_cancel",
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(verdict.outcome).toBe("blocked_by_state");
      if (verdict.outcome === "blocked_by_state") {
        expect(verdict.reason).toContain("driver 'engine' is not permitted");
      }
    });

    it("returns not_found when OMS order does not exist", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const verdict = await transitionOmsOrderStatus({ execute }, 40404, {
        to: "cancelled",
        reason: "missing",
      });

      expect(verdict).toEqual({
        outcome: "not_found",
        transitioned: false,
        omsOrderId: 40404,
        reason: "OMS order 40404 not found",
      });
    });
  });

  describe("recordShipmentOutcome chokepoint", () => {
    it("records shipment outcome, marks lines fulfilled, and appends shipped event", async () => {
      expect(recordShipmentOutcomeInOms).toBe(recordShipmentOutcome);

      const execute = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ previous_status: "processing", new_status: "shipped" }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await recordShipmentOutcome({ execute }, {
        omsOrderId: 601,
        trackingNumber: "1Z999AA10123456784",
        carrier: "UPS",
        markAllLinesFulfilled: true,
      });

      expect(res).toEqual({
        outcome: "recorded",
        changed: true,
        omsOrderId: 601,
        previousStatus: "processing",
        newStatus: "shipped",
      });
      expect(execute).toHaveBeenCalledTimes(3);
    });

    it("blocks shipment outcome overwrite on cancelled, refunded, or delivered orders", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ status: "cancelled" }] });

      const res = await recordShipmentOutcome({ execute }, {
        omsOrderId: 602,
        trackingNumber: "1Z999",
        carrier: "UPS",
      });

      expect(res.outcome).toBe("blocked_by_state");
      if (res.outcome === "blocked_by_state") {
        expect(res.currentStatus).toBe("cancelled");
      }
    });
  });

  describe("structural repository guard across server/modules/oms", () => {
    it("bans unqualified UPDATE oms_orders in all OMS production TypeScript files", () => {
      const offenders: string[] = [];
      for (const file of collectProductionFiles(OMS_ROOT)) {
        const src = fs.readFileSync(file, "utf8");
        if (/\bUPDATE\s+oms_orders\b/i.test(src)) {
          offenders.push(path.relative(OMS_ROOT, file).replace(/\\/g, "/"));
        }
      }
      expect(offenders).toEqual([]);
    });

    it("ensures every OMS cancellation and shipment writer enforces state-machine guards", () => {
      const webhooksSrc = fs.readFileSync(path.join(OMS_ROOT, "oms-webhooks.ts"), "utf8");
      expect(webhooksSrc).toContain("transitionOmsOrderStatus(db, existing.id");
      expect(webhooksSrc).toContain(
        "NOT IN ('shipped', 'partially_shipped', 'delivered', 'refunded')",
      );

      const ebaySrc = fs.readFileSync(path.join(OMS_ROOT, "ebay-order-ingestion.ts"), "utf8");
      expect(ebaySrc).toContain("transitionOmsOrderStatus(database, result.id");

      const wmsSyncSrc = fs.readFileSync(path.join(OMS_ROOT, "wms-sync.service.ts"), "utf8");
      expect(wmsSyncSrc).toContain("transitionOmsOrderStatus(db, row.oms_id");

      const observationSrc = fs.readFileSync(
        path.join(OMS_ROOT, "channel-order-observation.repository.ts"),
        "utf8",
      );
      expect(observationSrc).toContain(
        "status NOT IN ('shipped','partially_shipped','delivered','refunded') AND shipped_at IS NULL",
      );

      const dropshipCancelSrc = fs.readFileSync(
        path.join(OMS_ROOT, "dropship-marketplace-cancel.ts"),
        "utf8",
      );
      expect(dropshipCancelSrc).toContain(
        "status NOT IN ('cancelled', 'refunded', 'shipped', 'partially_shipped', 'delivered')",
      );

      const flowRecSrc = fs.readFileSync(
        path.join(OMS_ROOT, "oms-flow-reconciliation.service.ts"),
        "utf8",
      );
      expect(flowRecSrc).toContain(
        "oo.status NOT IN ('cancelled', 'shipped', 'partially_shipped', 'delivered', 'refunded')",
      );
      expect(flowRecSrc).toContain("oo.shipped_at IS NULL");

      const omsServiceSrc = fs.readFileSync(path.join(OMS_ROOT, "oms.service.ts"), "utf8");
      expect(omsServiceSrc).toContain("recordShipmentOutcome(");
      expect(omsServiceSrc).toContain('allowedOmsOrderFromStatuses("shipped", "engine")');
    });
  });
});
