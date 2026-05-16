import { describe, expect, it } from "vitest";
import {
  buildPoCloseChange,
  buildPoCloseShortChange,
  buildPoCloseShortLinePatch,
} from "../../purchase-order-close.service";
import { PoLifecycleError } from "../../purchase-order-lifecycle.service";

describe("purchase-order-close.service", () => {
  it("builds the standard close patch and history", () => {
    const now = new Date("2026-05-16T12:00:00.000Z");

    const change = buildPoCloseChange({
      po: { id: 1, status: "received", physicalStatus: "received" },
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
    expect(buildPoCloseShortLinePatch({ id: 1, status: "open" }, "short")).toEqual({
      status: "closed",
      closeShortReason: "short",
    });
    expect(buildPoCloseShortLinePatch({ id: 2, status: "partially_received" }, "short")).toEqual({
      status: "closed",
      closeShortReason: "short",
    });
    expect(buildPoCloseShortLinePatch({ id: 3, status: "received" }, "short")).toBeNull();
  });

  it("rejects close-short outside partially received POs", () => {
    expect(() =>
      buildPoCloseShortChange({
        po: { id: 3, status: "received", physicalStatus: "received" },
        reason: "short",
      }),
    ).toThrow(PoLifecycleError);
  });
});
