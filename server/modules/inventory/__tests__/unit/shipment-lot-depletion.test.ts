import { describe, expect, it } from "vitest";
import { planShipmentLotDepletion, type ShipmentLotBalance,
  type ShipmentLotDepletionRequest } from "../../domain/shipment-lot-depletion";

const request: ShipmentLotDepletionRequest = { productVariantId: 30, warehouseLocationId: 20,
  qty: 2, fromPicked: 0, fromOnHand: 2, reservedToRelease: 2 };
const lot: ShipmentLotBalance = { id: 1, qtyOnHand: 5, qtyReserved: 3, qtyPicked: 2,
  receivedAt: new Date("2026-01-01T00:00:00Z"), status: "active" };

describe("shipment lot bucket depletion", () => {
  it("keeps other picked stock untouched for an on-hand-only shipment", () => {
    expect(planShipmentLotDepletion(request, [lot])).toEqual([{
      lotId: 1, fromPicked: 0, fromOnHand: 2, reservedToRelease: 2,
      expectedOnHand: 5, expectedReserved: 3, expectedPicked: 2, expectedStatus: "active",
    }]);
  });
  it("does not release reservations for an unreserved concession", () => {
    expect(planShipmentLotDepletion({ ...request, reservedToRelease: 0 }, [lot]))
      .toMatchObject([{ fromPicked: 0, fromOnHand: 2, reservedToRelease: 0 }]);
  });
  it("does not consume on-hand for already-picked stock", () => {
    expect(planShipmentLotDepletion({ ...request, fromPicked: 2, fromOnHand: 0, reservedToRelease: 0 }, [lot]))
      .toMatchObject([{ fromPicked: 2, fromOnHand: 0, reservedToRelease: 0 }]);
  });
  it("releases the exact reserved quantity even when the oldest lot is unreserved", () => {
    const lots = [{ ...lot, id: 9, qtyReserved: 0 },
      { ...lot, id: 10, receivedAt: new Date("2026-02-01T00:00:00Z") }];
    expect(planShipmentLotDepletion({ ...request, reservedToRelease: 1 }, lots))
      .toMatchObject([{ lotId: 9, fromOnHand: 1, reservedToRelease: 0 },
        { lotId: 10, fromOnHand: 1, reservedToRelease: 1 }]);
  });
  it("uses ID as a deterministic FIFO tie breaker without mutating inputs", () => {
    const lots = Object.freeze([Object.freeze({ ...lot, id: 2 }), Object.freeze({ ...lot, id: 1 })]);
    expect(planShipmentLotDepletion(Object.freeze(request), lots).map((row) => row.lotId)).toEqual([1]);
    expect(lots.map((row) => row.id)).toEqual([2, 1]);
    expect(lots[1].qtyOnHand).toBe(5);
  });
  it("does not use inactive on-hand to satisfy a shipment", () => {
    expect(() => planShipmentLotDepletion(request, [{ ...lot, status: "quarantine" }]))
      .toThrow(expect.objectContaining({ code: "LOT_SHIPMENT_SHORTFALL" }));
  });
  it.each([
    { label: "picked", command: { ...request, fromPicked: 2, fromOnHand: 0, reservedToRelease: 0 },
      facts: { ...lot, qtyPicked: 1 }, missing: { missingPicked: 1 } },
    { label: "reserved", command: request, facts: { ...lot, qtyReserved: 1 }, missing: { missingReserved: 1 } },
    { label: "free", command: { ...request, reservedToRelease: 0 },
      facts: { ...lot, qtyReserved: 4 }, missing: { missingUnreservedOnHand: 1 } },
  ])("fails completely when $label stock is missing even if another bucket is ample", ({ command, facts, missing }) => {
    expect(() => planShipmentLotDepletion(command, [facts]))
      .toThrow(expect.objectContaining({ code: "LOT_SHIPMENT_SHORTFALL", context: expect.objectContaining(missing) }));
  });
  it("rejects no lots instead of silently succeeding", () => {
    expect(() => planShipmentLotDepletion(request, [])).toThrow(expect.objectContaining({ code: "LOT_SHIPMENT_SHORTFALL" }));
  });
  it.each([
    { ...request, qty: 0 }, { ...request, qty: -1 }, { ...request, qty: 1.5 },
    { ...request, qty: NaN }, { ...request, qty: Infinity }, { ...request, qty: 2_147_483_648 },
    { ...request, fromPicked: 1 }, { ...request, reservedToRelease: 3 },
    { ...request, productVariantId: 0 }, { ...request, warehouseLocationId: -1 },
  ])("rejects invalid request %#", (bad) => {
    expect(() => planShipmentLotDepletion(bad, [lot])).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });
  it.each([
    { ...lot, qtyOnHand: -1 }, { ...lot, qtyReserved: 6 }, { ...lot, qtyPicked: -1 },
    { ...lot, receivedAt: new Date(NaN) }, { ...lot, id: 0 }, { ...lot, qtyOnHand: 1.2 },
  ])("rejects malformed lot evidence %#", (bad) => {
    expect(() => planShipmentLotDepletion(request, [bad])).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });
  it("rejects duplicate lot identities", () => {
    expect(() => planShipmentLotDepletion(request, [lot, lot])).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });
  it("handles the maximum inventory counter without rounding", () => {
    const max = 2_147_483_647;
    expect(planShipmentLotDepletion({ ...request, qty: max, fromOnHand: max, reservedToRelease: max },
      [{ ...lot, qtyOnHand: max, qtyReserved: max }])[0].fromOnHand).toBe(max);
  });
  it("conserves each bucket and protects residual reservations across all small valid requests", () => {
    const lots = [lot, { ...lot, id: 2, qtyOnHand: 3, qtyReserved: 1, qtyPicked: 1 }];
    for (let picked = 0; picked <= 3; picked++) for (let reserved = 0; reserved <= 4; reserved++) {
      for (let free = 0; free <= 4; free++) {
        const qty = picked + reserved + free;
        if (qty === 0) continue;
        const plan = planShipmentLotDepletion({ ...request, qty, fromPicked: picked,
          fromOnHand: reserved + free, reservedToRelease: reserved }, lots);
        expect(plan.reduce((n, row) => n + row.fromPicked, 0)).toBe(picked);
        expect(plan.reduce((n, row) => n + row.fromOnHand, 0)).toBe(reserved + free);
        expect(plan.reduce((n, row) => n + row.reservedToRelease, 0)).toBe(reserved);
        for (const row of plan) {
          expect(row.expectedOnHand - row.fromOnHand).toBeGreaterThanOrEqual(row.expectedReserved - row.reservedToRelease);
          expect(row.expectedPicked - row.fromPicked).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
