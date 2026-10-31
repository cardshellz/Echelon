import { describe, expect, it, vi } from "vitest";
import { customerOrderProgressSchema } from "@shared/customer-account/order-progress";
import {
  presentCarrierPackageStatus,
  presentCustomerDelivery,
} from "../../../shipping/customer-delivery-progress";
import {
  presentCustomerReturn,
  presentCustomerReturnRefund,
  type CustomerReturnCaseProgressFacts,
} from "../../../returns/domain/customer-return-progress";
import { CustomerAccountProgressService } from "../../application/customer-account-progress.service";

const facts: CustomerReturnCaseProgressFacts = {
  caseStatus: "open",
  approvalStatus: "approved",
  logisticsStatus: "awaiting_return",
  inspectionStatus: "pending",
  customerRefundStatus: "pending",
  refundAttemptStatus: null,
  quantity: 3,
  receivedQuantity: 0,
  labelReady: true,
  labelInvalid: false,
};
const now = new Date("2026-10-30T12:00:00Z");
const scope = {
  channelId: 2,
  externalCustomerId: "100",
  orders: [{ omsOrderId: 10, externalOrderId: "99" }],
};
const delivered = presentCarrierPackageStatus("delivered"),
  transit = presentCarrierPackageStatus("in_transit"),
  unknown = presentCarrierPackageStatus(null);

describe("adversarial separation of payment, original delivery and returns", () => {
  it("does not let return financial states change return physical progress", () => {
    for (const customerRefundStatus of [
      "pending",
      "completed",
      "failed",
      "not_required",
    ] as const) {
      expect(presentCustomerReturn({ ...facts, customerRefundStatus })).toEqual(
        { code: "label_ready", label: "Label ready — awaiting drop-off" },
      );
    }
  });
  it("does not call a refund processing merely because intake initialized pending", () => {
    expect(presentCustomerReturnRefund(facts).code).toBe("not_started");
    expect(
      presentCustomerReturnRefund({ ...facts, refundAttemptStatus: "pending" })
        .code,
    ).toBe("processing");
    expect(
      presentCustomerReturnRefund({
        ...facts,
        customerRefundStatus: "completed",
        refundAttemptStatus: "pending",
      }).code,
    ).toBe("completed");
  });
  it("keeps receipt, inspection and confirmed refund independent", () => {
    expect(
      presentCustomerReturn({
        ...facts,
        logisticsStatus: "received",
        receivedQuantity: 3,
      }).code,
    ).toBe("received");
    expect(
      presentCustomerReturnRefund({
        ...facts,
        logisticsStatus: "received",
        receivedQuantity: 3,
      }).code,
    ).toBe("not_started");
    expect(
      presentCustomerReturn({
        ...facts,
        logisticsStatus: "received",
        receivedQuantity: 3,
        inspectionStatus: "in_progress",
      }).code,
    ).toBe("under_review");
    expect(
      presentCustomerReturn({ ...facts, customerRefundStatus: "completed" })
        .code,
    ).toBe("label_ready");
  });
  it("distinguishes carrier delivery to the warehouse from an actual warehouse receipt", () => {
    expect(presentCustomerReturn(facts, [delivered]).code).toBe("delivered");
    expect(
      presentCustomerReturn({ ...facts, receivedQuantity: 1 }, [delivered])
        .code,
    ).toBe("partially_received");
    expect(
      presentCustomerReturn({ ...facts, logisticsStatus: "received" }).code,
    ).toBe("needs_attention");
  });
  it("does not close a physically outstanding return because a legacy case says closed", () => {
    expect(
      presentCustomerReturn({
        ...facts,
        caseStatus: "closed",
        customerRefundStatus: "completed",
      }).code,
    ).toBe("needs_attention");
    expect(
      presentCustomerReturn({
        ...facts,
        caseStatus: "closed",
        receivedQuantity: 3,
      }).code,
    ).toBe("complete");
  });
  it("rejects over-receipt and unknown lifecycle values rather than guessing completion", () => {
    expect(() =>
      presentCustomerReturn({ ...facts, receivedQuantity: 4 }),
    ).toThrow();
    expect(() =>
      presentCustomerReturn({
        ...facts,
        logisticsStatus: "future_status",
      } as never),
    ).toThrow();
  });
  it("does not deliver three shipments when only two have delivery proof", () => {
    expect(
      presentCustomerDelivery([delivered, delivered, unknown], true)?.code,
    ).toBe("partially_delivered");
    expect(
      presentCustomerDelivery([delivered, delivered, transit], true)?.code,
    ).toBe("partially_delivered");
    expect(
      presentCustomerDelivery([delivered, delivered, delivered], false)?.code,
    ).toBe("partially_delivered");
    expect(
      presentCustomerDelivery([delivered, delivered, delivered], true)?.code,
    ).toBe("delivered");
  });
  it("prioritizes a delivery exception without treating pickup-point arrival as delivery", () => {
    expect(
      presentCustomerDelivery(
        [delivered, presentCarrierPackageStatus("exception")],
        true,
      )?.code,
    ).toBe("delivery_issue");
    expect(
      presentCustomerDelivery(
        [presentCarrierPackageStatus("delivered_to_service_point")],
        true,
      )?.code,
    ).toBe("ready_for_pickup");
    expect(presentCustomerDelivery([], true)).toBeNull();
    expect(presentCustomerDelivery([unknown], true)).toBeNull();
  });
  it("is invariant to package arrival order and never mutates its inputs", () => {
    const states = Object.freeze([
      delivered,
      transit,
      presentCarrierPackageStatus("exception"),
    ]);
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ])
      expect(
        presentCustomerDelivery(
          order.map((index) => states[index]),
          true,
        )?.code,
      ).toBe("delivery_issue");
    expect(states).toEqual([
      delivered,
      transit,
      presentCarrierPackageStatus("exception"),
    ]);
  });
  it("validates public identity uniqueness and never accepts incomplete delivered claims", () => {
    expect(() =>
      customerOrderProgressSchema.parse({
        delivery: delivered,
        packages: [],
        returns: [],
      }),
    ).toThrow();
    expect(() =>
      customerOrderProgressSchema.parse({
        delivery: null,
        packages: [
          { key: "x", trackingNumber: null, status: unknown },
          { key: "x", trackingNumber: null, status: unknown },
        ],
        returns: [],
      }),
    ).toThrow();
  });
  it("keeps returns readable during a shipping outage and identifies only the failed track", async () => {
    const report = vi.fn();
    const reader = new CustomerAccountProgressService({
      delivery: {
        read: vi.fn().mockRejectedValue(new Error("shipping unavailable")),
      },
      returns: {
        read: vi
          .fn()
          .mockResolvedValue(new Map([[10, { returns: [], refunds: [] }]])),
      },
      report,
    });
    expect((await reader.read(scope, now)).get(10)).toMatchObject({
      unavailable: ["delivery"],
      returns: [],
    });
    expect(report).toHaveBeenCalledWith({
      code: "CUSTOMER_ACCOUNT_DELIVERY_PROGRESS_UNAVAILABLE",
    });
  });
  it("does not invent no-returns when the returns owner failed", async () => {
    const reader = new CustomerAccountProgressService({
      delivery: {
        read: vi
          .fn()
          .mockResolvedValue(new Map([[10, { delivery: null, packages: [] }]])),
      },
      returns: {
        read: vi.fn().mockRejectedValue(new Error("returns unavailable")),
      },
      report: vi.fn(),
    });
    expect((await reader.read(scope, now)).get(10)?.unavailable).toEqual([
      "returns",
      "refunds",
    ]);
  });
  it("rejects cross-account, unrequested owner rows before exposing progress", async () => {
    const reader = new CustomerAccountProgressService({
      delivery: {
        read: vi
          .fn()
          .mockResolvedValue(new Map([[11, { delivery: null, packages: [] }]])),
      },
      returns: {
        read: vi
          .fn()
          .mockResolvedValue(new Map([[10, { returns: [], refunds: [] }]])),
      },
      report: vi.fn(),
    });
    await expect(reader.read(scope, now)).rejects.toThrow(
      "unrequested order identity",
    );
  });
  it("checks every three-package carrier combination without ever completing missing packages", () => {
    const codes = [
      "unknown",
      "pre_transit",
      "accepted",
      "in_transit",
      "delivered",
      "exception",
      "delivery_attempt",
      "delivered_to_service_point",
    ] as const;
    for (const first of codes)
      for (const second of codes)
        for (const third of codes)
          for (const fullyShipped of [false, true]) {
            const packages = [first, second, third].map(
              presentCarrierPackageStatus,
            );
            expect(
              presentCustomerDelivery(packages, fullyShipped)?.code ===
                "delivered",
            ).toBe(
              fullyShipped &&
                [first, second, third].every((code) => code === "delivered"),
            );
          }
  });
  it("highlights an outstanding box exception while preserving actual receipt counts", () => {
    expect(
      presentCustomerReturn({ ...facts, receivedQuantity: 1 }, [
        delivered,
        presentCarrierPackageStatus("exception"),
      ]),
    ).toEqual({
      code: "delivery_issue",
      label: "Partially received — delivery issue",
    });
    expect(
      presentCustomerReturn({ ...facts, receivedQuantity: 3 }, [
        delivered,
        presentCarrierPackageStatus("exception"),
      ]).code,
    ).toBe("received");
  });
  it("never advertises a known voided/replaced label as ready", () => {
    expect(
      presentCustomerReturn({ ...facts, labelInvalid: true, labelReady: false })
        .code,
    ).toBe("needs_attention");
  });
  it("isolates malformed owner data to its lane and order", async () => {
    const reader = new CustomerAccountProgressService({
      delivery: {
        read: vi
          .fn()
          .mockResolvedValue(
            new Map([
              [
                10,
                {
                  delivery: { code: "delivered", label: "Delivered" },
                  packages: [],
                },
              ],
            ]),
          ),
      },
      returns: {
        read: vi
          .fn()
          .mockResolvedValue(new Map([[10, { returns: [], refunds: [] }]])),
      },
      report: vi.fn(),
    });
    expect((await reader.read(scope, now)).get(10)).toMatchObject({
      delivery: null,
      packages: [],
      returns: [],
      unavailable: ["delivery"],
    });
  });
});
