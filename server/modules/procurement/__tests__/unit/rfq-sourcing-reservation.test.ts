import { describe, expect, it } from "vitest";
import { assertRfqSupplySnapshotCurrent, isActiveRfqReservation, rfqPendingSourcingPieces, type LinkedRfqPurchase } from "../../domain/rfq-sourcing-reservation";

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
  it("rejects unsafe quantities, missing timestamps and unknown purchase states", () => {
    expect(() => rfqPendingSourcingPieces(Number.MAX_SAFE_INTEGER + 1, null)).toThrow();
    expect(() => rfqPendingSourcingPieces(100, { ...purchase(), status: "unknown" } as never)).toThrow();
    expect(() => assertRfqSupplySnapshotCurrent([{ ...purchase("approved"), updatedAt: new Date("invalid") }], asOf)).toThrow();
  });
});
