/**
 * Unit tests for `cascadeShopifyCancelToShipments` (§6 Group F, Commit 28).
 *
 * The cancel cascade is the WMS portion of the Shopify orders/cancelled
 * webhook handler. It:
 *   - Finds all non-terminal shipments for a WMS order
 *   - Calls handleCustomerCancelOnShipment for each (C19) — pre-label
 *     gets cancelled cleanly; post-label gets flagged requires_review
 *     + on_hold (Overlord's "Option B")
 *   - Rolls up order status via recomputeOrderStatusFromShipments
 *
 * The route handler itself (HMAC, OMS update, event log) is exercised
 * via integration; this file scopes to the cascade logic only.
 *
 * Standards: coding-standards Rule #6 (idempotent retry-safety), Rule #9
 * (happy + edge cases), Rule #15 (5-section completion report).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// `oms-webhooks.ts` transitively imports `server/db`; stub it so import
// time doesn't try to construct a real Postgres client. Same pattern as
// fulfillments-create-webhook / fulfillments-update-webhook.
vi.mock("../../../../db", () => ({
  db: {
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [] }),
      }),
    }),
    execute: async () => ({ rows: [] }),
  },
}));

// Pull in the cascade helper after the db mock is registered.
import { __test__ } from "../../oms-webhooks";

const { cascadeShopifyCancelToShipments } = __test__;

// ─── Scripted db.execute mock ────────────────────────────────────────

type ScriptedResponse = { rows: any[] };

function makeDb(scripted: ScriptedResponse[]) {
  const calls: any[] = [];
  const remaining = [...scripted];
  const execute = vi.fn(async (query: any) => {
    calls.push(query);
    if (remaining.length === 0) return { rows: [] };
    return remaining.shift()!;
  });
  return {
    db: { execute } as any,
    execute,
    calls,
    remaining,
  };
}

const NOW = new Date("2026-04-26T12:00:00Z");

describe("cascadeShopifyCancelToShipments (C28)", () => {
  it("happy path: 2 pre-label shipments → both cancelled, rollup runs", async () => {
    const mock = makeDb([
      // First db.execute is the SELECT for shipments
      { rows: [{ id: 101 }, { id: 102 }] },
    ]);

    const handleCustomerCancelOnShipment = vi
      .fn()
      .mockResolvedValueOnce({ mode: "cancelled", wmsOrderId: 42 })
      .mockResolvedValueOnce({ mode: "cancelled", wmsOrderId: 42 });
    const recomputeOrderStatusFromShipments = vi
      .fn()
      .mockResolvedValueOnce({ warehouseStatus: "cancelled", changed: true });

    const result = await cascadeShopifyCancelToShipments(
      mock.db,
      42,
      { handleCustomerCancelOnShipment, recomputeOrderStatusFromShipments },
      { now: NOW },
    );

    expect(result.hadShipments).toBe(true);
    expect(result.cascadeResults).toEqual([
      { shipmentId: 101, mode: "cancelled" },
      { shipmentId: 102, mode: "cancelled" },
    ]);
    expect(result.rollupChanged).toBe(true);
    expect(handleCustomerCancelOnShipment).toHaveBeenCalledTimes(2);
    expect(handleCustomerCancelOnShipment).toHaveBeenNthCalledWith(
      1,
      mock.db,
      101,
      expect.objectContaining({ now: NOW }),
    );
    expect(recomputeOrderStatusFromShipments).toHaveBeenCalledOnce();
    expect(recomputeOrderStatusFromShipments).toHaveBeenCalledWith(mock.db, 42);
  });

  it("mixed pre/post-label: 1 cancelled + 1 requires_review, rollup runs", async () => {
    const mock = makeDb([{ rows: [{ id: 201 }, { id: 202 }] }]);

    const handleCustomerCancelOnShipment = vi
      .fn()
      .mockResolvedValueOnce({ mode: "cancelled", wmsOrderId: 99 })
      .mockResolvedValueOnce({ mode: "requires_review", shipmentId: 202 });
    const recomputeOrderStatusFromShipments = vi
      .fn()
      .mockResolvedValueOnce({ warehouseStatus: "on_hold", changed: true });

    const result = await cascadeShopifyCancelToShipments(
      mock.db,
      99,
      { handleCustomerCancelOnShipment, recomputeOrderStatusFromShipments },
      { now: NOW },
    );

    expect(result.cascadeResults).toEqual([
      { shipmentId: 201, mode: "cancelled" },
      { shipmentId: 202, mode: "requires_review" },
    ]);
    expect(result.rollupChanged).toBe(true);
  });

  it("all post-label: all flagged for review, rollup invoked but order may not fully cancel", async () => {
    const mock = makeDb([{ rows: [{ id: 301 }, { id: 302 }, { id: 303 }] }]);

    const handleCustomerCancelOnShipment = vi
      .fn()
      .mockResolvedValue({ mode: "requires_review", shipmentId: 0 });
    const recomputeOrderStatusFromShipments = vi
      .fn()
      .mockResolvedValueOnce({ warehouseStatus: "on_hold", changed: true });

    const result = await cascadeShopifyCancelToShipments(
      mock.db,
      55,
      { handleCustomerCancelOnShipment, recomputeOrderStatusFromShipments },
      { now: NOW },
    );

    expect(result.cascadeResults.every((r) => r.mode === "requires_review")).toBe(
      true,
    );
    expect(handleCustomerCancelOnShipment).toHaveBeenCalledTimes(3);
  });

  it("no shipments: returns hadShipments=false, no helpers called", async () => {
    const mock = makeDb([{ rows: [] }]);

    const handleCustomerCancelOnShipment = vi.fn();
    const recomputeOrderStatusFromShipments = vi.fn();

    const result = await cascadeShopifyCancelToShipments(
      mock.db,
      77,
      { handleCustomerCancelOnShipment, recomputeOrderStatusFromShipments },
      { now: NOW },
    );

    expect(result.hadShipments).toBe(false);
    expect(result.cascadeResults).toEqual([]);
    expect(handleCustomerCancelOnShipment).not.toHaveBeenCalled();
    expect(recomputeOrderStatusFromShipments).not.toHaveBeenCalled();
  });

  it("one shipment helper throws but others succeed: continues, captures error, still rolls up", async () => {
    const mock = makeDb([{ rows: [{ id: 401 }, { id: 402 }, { id: 403 }] }]);

    const handleCustomerCancelOnShipment = vi
      .fn()
      .mockResolvedValueOnce({ mode: "cancelled", wmsOrderId: 88 })
      .mockRejectedValueOnce(new Error("DB connection lost"))
      .mockResolvedValueOnce({ mode: "cancelled", wmsOrderId: 88 });
    const recomputeOrderStatusFromShipments = vi
      .fn()
      .mockResolvedValueOnce({ warehouseStatus: "ready", changed: false });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await cascadeShopifyCancelToShipments(
      mock.db,
      88,
      { handleCustomerCancelOnShipment, recomputeOrderStatusFromShipments },
      { now: NOW },
    );

    expect(result.cascadeResults).toEqual([
      { shipmentId: 401, mode: "cancelled" },
      { shipmentId: 402, mode: "error", error: "DB connection lost" },
      { shipmentId: 403, mode: "cancelled" },
    ]);
    expect(handleCustomerCancelOnShipment).toHaveBeenCalledTimes(3);
    expect(recomputeOrderStatusFromShipments).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("rollup helper throws: returns cascadeResults, rollupChanged is undefined, error logged", async () => {
    const mock = makeDb([{ rows: [{ id: 501 }] }]);

    const handleCustomerCancelOnShipment = vi
      .fn()
      .mockResolvedValueOnce({ mode: "cancelled", wmsOrderId: 11 });
    const recomputeOrderStatusFromShipments = vi
      .fn()
      .mockRejectedValueOnce(new Error("rollup failed"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await cascadeShopifyCancelToShipments(
      mock.db,
      11,
      { handleCustomerCancelOnShipment, recomputeOrderStatusFromShipments },
    );

    expect(result.cascadeResults).toEqual([
      { shipmentId: 501, mode: "cancelled" },
    ]);
    expect(result.rollupChanged).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("threads shipstation hook into handleCustomerCancelOnShipment", async () => {
    const mock = makeDb([{ rows: [{ id: 601 }] }]);

    const handleCustomerCancelOnShipment = vi
      .fn()
      .mockResolvedValueOnce({ mode: "cancelled", wmsOrderId: 22 });
    const recomputeOrderStatusFromShipments = vi
      .fn()
      .mockResolvedValueOnce({ warehouseStatus: "cancelled", changed: true });
    const removeFromList = vi.fn();
    const ssAdapter = { removeFromList };

    await cascadeShopifyCancelToShipments(
      mock.db,
      22,
      { handleCustomerCancelOnShipment, recomputeOrderStatusFromShipments },
      { now: NOW, shipstation: ssAdapter },
    );

    expect(handleCustomerCancelOnShipment).toHaveBeenCalledWith(
      mock.db,
      601,
      expect.objectContaining({
        shipstation: ssAdapter,
        now: NOW,
      }),
    );
  });

  it("respects custom logPrefix in error messages", async () => {
    const mock = makeDb([{ rows: [{ id: 701 }] }]);

    const handleCustomerCancelOnShipment = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"));
    const recomputeOrderStatusFromShipments = vi
      .fn()
      .mockResolvedValueOnce({ warehouseStatus: "ready", changed: false });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await cascadeShopifyCancelToShipments(
      mock.db,
      33,
      { handleCustomerCancelOnShipment, recomputeOrderStatusFromShipments },
      { logPrefix: "[CUSTOM]" },
    );

    const errCalls = errSpy.mock.calls.map((c) => c.join(" "));
    expect(errCalls.some((s) => s.includes("[CUSTOM]"))).toBe(true);
    errSpy.mockRestore();
  });
});
