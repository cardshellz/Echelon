import { describe, expect, it } from "vitest";
import {
  isConfirmedDeliveryDateInvalid,
  resolveEffectiveDeliveryDate,
  validateDeliverySchedulePatch,
} from "../../purchase-order-delivery-schedule";

const sentPo = {
  status: "acknowledged",
  physicalStatus: "acknowledged",
  sentToVendorAt: "2026-05-10T18:00:00.000Z",
  orderDate: "2026-05-10T18:00:00.000Z",
  createdAt: "2026-05-10T17:00:00.000Z",
  expectedDeliveryDate: "2026-06-15T00:00:00.000Z",
  confirmedDeliveryDate: null,
};

describe("purchase order delivery schedule", () => {
  it("allows a confirmed date on the same calendar day as PO submission", () => {
    const issues = validateDeliverySchedulePatch(sentPo, {
      confirmedDeliveryDate: new Date("2026-05-10T00:00:00.000Z"),
    });

    expect(issues).toEqual([]);
  });

  it("rejects a confirmed date before PO submission", () => {
    const issues = validateDeliverySchedulePatch(sentPo, {
      confirmedDeliveryDate: new Date("2026-05-09T00:00:00.000Z"),
    });

    expect(issues).toEqual([
      expect.objectContaining({
        code: "CONFIRMED_DELIVERY_BEFORE_PO",
        field: "confirmedDeliveryDate",
      }),
    ]);
  });

  it("ignores an impossible confirmed date when resolving the effective ETA", () => {
    const record = {
      ...sentPo,
      confirmedDeliveryDate: "2026-05-01T00:00:00.000Z",
    };

    expect(isConfirmedDeliveryDateInvalid(record)).toBe(true);
    expect(resolveEffectiveDeliveryDate(record)?.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("rejects confirmed dates before a PO is sent", () => {
    const issues = validateDeliverySchedulePatch({
      ...sentPo,
      status: "draft",
      physicalStatus: "draft",
      sentToVendorAt: null,
      orderDate: null,
    }, {
      confirmedDeliveryDate: new Date("2026-05-12T00:00:00.000Z"),
    });

    expect(issues[0]).toMatchObject({ code: "CONFIRMED_DELIVERY_BEFORE_SEND" });
  });
});
