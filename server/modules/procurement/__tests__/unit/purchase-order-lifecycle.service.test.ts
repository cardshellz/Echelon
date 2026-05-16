import { describe, expect, it } from "vitest";
import {
  PoLifecycleError,
  buildFinancialTransitionChange,
  buildPhysicalTransitionChange,
  getAllowedLegacyTransitions,
} from "../../purchase-order-lifecycle.service";

describe("purchase-order-lifecycle.service", () => {
  it("builds a physical transition patch with legacy status compatibility", () => {
    const now = new Date("2026-05-16T12:00:00.000Z");

    const change = buildPhysicalTransitionChange({
      po: {
        id: 1,
        status: "approved",
        physicalStatus: "draft",
        sentToVendorAt: null,
      },
      target: "sent",
      userId: "user-1",
      notes: "Sent to vendor",
      now,
      extraPatch: { orderDate: now },
    });

    expect(change.patch).toMatchObject({
      physicalStatus: "sent",
      status: "sent",
      sentToVendorAt: now,
      orderDate: now,
      updatedBy: "user-1",
    });
    expect(change.history).toMatchObject({
      fromStatus: "approved",
      toStatus: "sent",
      changedBy: "user-1",
      notes: "Sent to vendor",
    });
  });

  it("uses legacy status as physical fallback for pre-dual-track rows", () => {
    const now = new Date("2026-05-16T12:00:00.000Z");

    const change = buildPhysicalTransitionChange({
      po: {
        id: 2,
        status: "sent",
        physicalStatus: "draft",
        vendorAckDate: null,
      },
      target: "acknowledged",
      userId: "user-1",
      now,
      extraPatch: { vendorAckDate: now },
    });

    expect(change.patch).toMatchObject({
      physicalStatus: "acknowledged",
      status: "acknowledged",
      vendorAckDate: now,
      updatedBy: "user-1",
    });
    expect(change.history).toMatchObject({
      fromStatus: "sent",
      toStatus: "acknowledged",
      changedBy: "user-1",
      notes: "Physical status: sent -> acknowledged",
    });
  });

  it("rejects an invalid physical transition with allowed states in details", () => {
    expect(() =>
      buildPhysicalTransitionChange({
        po: { status: "approved", physicalStatus: "draft" },
        target: "received",
      }),
    ).toThrow(PoLifecycleError);

    try {
      buildPhysicalTransitionChange({
        po: { status: "approved", physicalStatus: "draft" },
        target: "received",
      });
    } catch (error: any) {
      expect(error.details).toEqual({
        current: "draft",
        target: "received",
        allowed: ["sent", "cancelled"],
      });
    }
  });

  it("builds a financial transition patch without mutating legacy status", () => {
    const now = new Date("2026-05-16T12:00:00.000Z");

    const change = buildFinancialTransitionChange({
      po: {
        status: "received",
        financialStatus: "invoiced",
        firstPaidAt: null,
        fullyPaidAt: null,
      },
      target: "paid",
      userId: "user-2",
      now,
    });

    expect(change.patch).toMatchObject({
      financialStatus: "paid",
      firstPaidAt: now,
      fullyPaidAt: now,
      updatedBy: "user-2",
    });
    expect(change.patch).not.toHaveProperty("status");
    expect(change.history).toMatchObject({
      fromStatus: "received",
      toStatus: "received",
    });
  });

  it("exposes legacy transition allowances for current compatibility gates", () => {
    expect(getAllowedLegacyTransitions("approved")).toEqual(["sent", "cancelled"]);
    expect(getAllowedLegacyTransitions("received")).toEqual(["closed"]);
    expect(getAllowedLegacyTransitions("not_real")).toEqual([]);
  });
});
