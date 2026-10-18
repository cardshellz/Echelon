import { pendingSourcingReviewSchema } from "@shared/procurement/automatic-sourcing-review";
import { describe, expect, it } from "vitest";
import { assertRfqSupplySnapshotCurrent, pendingPurchaseSourcingPieces, sourcingScopesOverlap, isActiveRfqReservation, rfqPendingSourcingPieces, type LinkedRfqPurchase } from "../../domain/rfq-sourcing-reservation";

const asOf = new Date("2026-09-07T12:00:00Z");
function purchase(status: LinkedRfqPurchase["status"] = "draft"): LinkedRfqPurchase {
  return { rfqLineId: 20, purchaseOrderId: 99, status, lineStatus: "open", orderQty: 200, receivedQty: 20, cancelledQty: 30, updatedAt: new Date("2026-09-07T13:00:00Z") };
}

describe("RFQ sourcing reservation handoff", () => {
  it("uses the actual pending PO remainder independently of its original request quantity", () => {
    expect(rfqPendingSourcingPieces(100, purchase())).toBe(150);
    expect(rfqPendingSourcingPieces(100, purchase("pending_approval"))).toBe(150);
    expect(rfqPendingSourcingPieces(100, purchase(), false)).toBe(150);
    expect(() => assertRfqSupplySnapshotCurrent([purchase()], asOf)).not.toThrow();
  });
  it.each(["approved", "sent", "acknowledged", "partially_received", "received", "closed", "cancelled"] as const)("releases the RFQ reserve at %s but rejects an older demand snapshot", (status) => {
    expect(rfqPendingSourcingPieces(100, purchase(status))).toBe(0);
    expect(() => assertRfqSupplySnapshotCurrent([purchase(status)], asOf)).toThrow(expect.objectContaining({ code: "RFQ_SUPPLY_SNAPSHOT_STALE" }));
    expect(() => assertRfqSupplySnapshotCurrent([purchase(status)], new Date("2026-09-07T14:00:00Z"))).not.toThrow();
  });
  it("retains active unlinked history and releases inactive requests without guessing a purchase link", () => {
    expect(rfqPendingSourcingPieces(100, null, isActiveRfqReservation("quoted", "ordered"))).toBe(100);
    expect(rfqPendingSourcingPieces(100, null, isActiveRfqReservation("cancelled", "ordered"))).toBe(0);
    expect(rfqPendingSourcingPieces(100, null, isActiveRfqReservation("quoted", "cancelled"))).toBe(0);
  });
  it("uses one validated pending-purchase remainder for cancelled, fulfilled and partial lines", () => {
    const { rfqLineId: _rfqLineId, ...source } = purchase();
    expect(pendingPurchaseSourcingPieces(source)).toBe(150);
    for (const lineStatus of ["closed", "cancelled", "received"]) expect(pendingPurchaseSourcingPieces({ ...source, lineStatus })).toBe(0);
    expect(pendingPurchaseSourcingPieces({ ...source, receivedQty: 200 })).toBe(0);
    for (const orderQty of [null, "200", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => pendingPurchaseSourcingPieces({ ...source, orderQty })).toThrow();
  });
  it("intersects unassigned warehouse demand without conflating separate explicit warehouses", () => {
    expect(sourcingScopesOverlap({ productId: 100, warehouseId: 1 }, { productId: 100, warehouseId: null })).toBe(true);
    expect(sourcingScopesOverlap({ productId: 100, warehouseId: null }, { productId: 100, warehouseId: 1 })).toBe(true);
    expect(sourcingScopesOverlap({ productId: 100, warehouseId: 1 }, { productId: 100, warehouseId: 2 })).toBe(false);
    expect(sourcingScopesOverlap({ productId: 100 }, { productId: 101 })).toBe(false);
  });
  it("validates visible partial-reservation quantities and exact recovery identities", () => {
    const review = { recommendationId: "100:200:30", reason: "pending_sourcing_reservation", reservedPieces: 100, suggestedPieces: 150, uncoveredPieces: 50, message: "Review existing source", reservations: [{ productId: 100, pieces: 100, purchaseOrderId: 99, rfqId: null }] };
    expect(pendingSourcingReviewSchema.parse(review)).toEqual(review);
    expect(pendingSourcingReviewSchema.safeParse({ ...review, reservedPieces: 99 }).success).toBe(false);
    expect(pendingSourcingReviewSchema.safeParse({ ...review, uncoveredPieces: 0 }).success).toBe(false);
    for (const rfqId of [10, null]) expect(pendingSourcingReviewSchema.safeParse({ ...review, reservations: [{ ...review.reservations[0], purchaseOrderId: rfqId === null ? null : 99, rfqId }] }).success).toBe(false);
  });
  it("rejects unsafe quantities, missing timestamps and unknown purchase states", () => {
    expect(() => rfqPendingSourcingPieces(Number.MAX_SAFE_INTEGER + 1, null)).toThrow();
    expect(() => rfqPendingSourcingPieces(100, { ...purchase(), status: "unknown" } as never)).toThrow();
    expect(() => assertRfqSupplySnapshotCurrent([{ ...purchase("approved"), updatedAt: new Date("invalid") }], asOf)).toThrow();
  });
});
