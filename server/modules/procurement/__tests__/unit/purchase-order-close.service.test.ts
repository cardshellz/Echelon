import { describe, expect, it } from "vitest";
import {
  buildPoCloseChange,
  buildPoCloseShortChange,
  buildPoCloseShortLinePatch,
} from "../../purchase-order-close.service";
import {
  buildPoLifecycleSummary,
  PoLifecycleError,
} from "../../purchase-order-lifecycle.service";

const NOW = new Date("2026-05-16T12:00:00.000Z");
const RECEIVED_PO = { id: 1, status: "received", physicalStatus: "received" };
const RECEIVED_LINE = {
  id: 11,
  lineType: "product",
  status: "received",
  orderQty: 10,
  receivedQty: 10,
  cancelledQty: 0,
};

describe("purchase-order-close.service", () => {
  it("builds the standard close patch and history", () => {
    const now = new Date("2026-05-16T12:00:00.000Z");

    const change = buildPoCloseChange({
      po: { id: 1, status: "received", physicalStatus: "received" },
      lines: [RECEIVED_LINE],
      userId: "user-1",
      notes: "all matched",
      now,
    });

    expect(change.patch).toMatchObject({
      status: "closed",
      closedAt: now,
      closedBy: "user-1",
      updatedBy: "user-1",
    });
    expect(change.history).toEqual({
      fromStatus: "received",
      toStatus: "closed",
      changedBy: "user-1",
      notes: "all matched",
    });
  });

  it("builds the close-short patch through the physical lifecycle boundary", () => {
    const now = new Date("2026-05-16T12:00:00.000Z");

    const change = buildPoCloseShortChange({
      po: { id: 2, status: "partially_received", physicalStatus: "receiving" },
      reason: "vendor short shipped",
      userId: "user-2",
      now,
    });

    expect(change.patch).toMatchObject({
      status: "closed",
      physicalStatus: "short_closed",
      closedAt: now,
      closedBy: "user-2",
      updatedBy: "user-2",
    });
    expect(change.history).toEqual({
      fromStatus: "partially_received",
      toStatus: "closed",
      changedBy: "user-2",
      notes: "Closed short: vendor short shipped",
    });
  });

  it("builds remaining line close-short patches only for open physical lines", () => {
    expect(
      buildPoCloseShortLinePatch({ id: 1, status: "open" }, "short"),
    ).toEqual({
      status: "closed",
      closeShortReason: "short",
    });
    expect(
      buildPoCloseShortLinePatch(
        { id: 2, status: "partially_received" },
        "short",
      ),
    ).toEqual({
      status: "closed",
      closeShortReason: "short",
    });
    expect(
      buildPoCloseShortLinePatch({ id: 3, status: "received" }, "short"),
    ).toBeNull();
  });

  it("rejects close-short outside partially received POs", () => {
    expect(() =>
      buildPoCloseShortChange({
        po: { id: 3, status: "received", physicalStatus: "received" },
        reason: "short",
        now: NOW,
      }),
    ).toThrow(PoLifecycleError);
  });

  it.each([undefined, null, "draft"])(
    "retains the legacy received-header fallback for physical status %s",
    (physicalStatus) => {
      const po = { ...RECEIVED_PO, physicalStatus };
      expect(
        buildPoCloseChange({ po, lines: [RECEIVED_LINE], now: NOW }).patch
          .status,
      ).toBe("closed");
      expect(
        buildPoLifecycleSummary(po).nextActions.map((action) => action.id),
      ).toContain("close");
    },
  );

  it.each([
    { status: "partially_received", physicalStatus: "receiving" },
    { status: "partially_received", physicalStatus: "received" },
    { status: "received", physicalStatus: "receiving" },
    { status: "received", physicalStatus: "short_closed" },
  ])("rejects ordinary close and does not advertise it for %j", (state) => {
    const po = { id: 1, ...state };
    expect(() =>
      buildPoCloseChange({ po, lines: [RECEIVED_LINE], now: NOW }),
    ).toThrow(/fully received/);
    expect(
      buildPoLifecycleSummary(po).nextActions.map((action) => action.id),
    ).not.toContain("close");
  });

  it("advertises the authorized close-short path for incomplete receipts", () => {
    const summary = buildPoLifecycleSummary({
      id: 1,
      status: "partially_received",
      physicalStatus: "receiving",
    });
    expect(summary.nextActions).toContainEqual(
      expect.objectContaining({
        id: "close_short",
        requiredPermission: { resource: "purchasing", action: "approve" },
      }),
    );
  });

  it("rejects a received header whose locked product quantities remain incomplete", () => {
    expect(() =>
      buildPoCloseChange({
        po: RECEIVED_PO,
        lines: [{ ...RECEIVED_LINE, receivedQty: 7 }],
        now: NOW,
      }),
    ).toThrow(
      expect.objectContaining({
        details: {
          code: "PO_CLOSE_RECEIPT_INCOMPLETE",
          purchaseOrderId: 1,
          lineIds: [11],
        },
      }),
    );
  });

  it.each([
    { receivedQty: 7, cancelledQty: 3 },
    { receivedQty: 11, cancelledQty: 0 },
    {
      receivedQty: Number.MAX_SAFE_INTEGER,
      orderQty: Number.MAX_SAFE_INTEGER,
      cancelledQty: Number.MAX_SAFE_INTEGER,
    },
  ])(
    "uses the receipt owner's remaining-quantity rule without overflow: %j",
    (quantities) => {
      expect(
        buildPoCloseChange({
          po: RECEIVED_PO,
          lines: [{ ...RECEIVED_LINE, ...quantities }],
          now: NOW,
        }).patch.status,
      ).toBe("closed");
    },
  );

  it("ignores cancelled product lines and nonphysical charges", () => {
    expect(
      buildPoCloseChange({
        po: RECEIVED_PO,
        lines: [
          RECEIVED_LINE,
          { ...RECEIVED_LINE, id: 12, status: "cancelled", receivedQty: 0 },
          { ...RECEIVED_LINE, id: 13, lineType: "fee", receivedQty: 0 },
        ],
        now: NOW,
      }).patch.status,
    ).toBe("closed");
  });

  it.each([
    { lines: [] },
    { lines: [{ ...RECEIVED_LINE, status: "cancelled" }] },
    { lines: [{ ...RECEIVED_LINE, lineType: "fee" }] },
  ])("requires active product receipt evidence (%j)", ({ lines }) => {
    expect(() =>
      buildPoCloseChange({ po: RECEIVED_PO, lines, now: NOW }),
    ).toThrow(/No active product/);
  });

  it.each([
    { orderQty: -1 },
    { receivedQty: 0.5 },
    { cancelledQty: Number.NaN },
    { receivedQty: Number.MAX_SAFE_INTEGER + 1 },
    { lineType: "unknown" },
    { status: "unknown" },
  ])("rejects malformed receipt evidence %j", (invalid) => {
    expect(() =>
      buildPoCloseChange({
        po: RECEIVED_PO,
        lines: [{ ...RECEIVED_LINE, ...invalid }],
        now: NOW,
      }),
    ).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          code: "PO_CLOSE_RECEIPT_EVIDENCE_INVALID",
        }),
      }),
    );
  });

  it("treats nullable legacy receipt counters as zero instead of completion", () => {
    expect(() =>
      buildPoCloseChange({
        po: RECEIVED_PO,
        lines: [{ ...RECEIVED_LINE, receivedQty: null, cancelledQty: null }],
        now: NOW,
      }),
    ).toThrow(/outstanding goods/);
  });

  it.each(["", " \t\n", null, 7, {}])(
    "rejects a missing or nontext close-short reason %j",
    (reason) => {
      expect(() =>
        buildPoCloseShortChange({
          po: { status: "partially_received" },
          reason: reason as string,
          now: NOW,
        }),
      ).toThrow(/reason is required/);
    },
  );

  it("trims close-short history and replaces a stale closed timestamp with command time", () => {
    const change = buildPoCloseShortChange({
      po: { status: "partially_received", closedAt: new Date(0) },
      reason: "  Supplier short shipped  ",
      now: NOW,
    });
    expect(change.patch.closedAt).toEqual(NOW);
    expect(change.history.notes).toBe("Closed short: Supplier short shipped");
  });

  it("rejects invalid injected clocks before creating a change", () => {
    expect(() =>
      buildPoCloseChange({
        po: RECEIVED_PO,
        lines: [RECEIVED_LINE],
        now: new Date("invalid"),
      }),
    ).toThrow(/timestamp/);
    expect(() =>
      buildPoCloseShortChange({
        po: { status: "partially_received" },
        reason: "short",
        now: undefined as unknown as Date,
      }),
    ).toThrow(/timestamp/);
  });
});
