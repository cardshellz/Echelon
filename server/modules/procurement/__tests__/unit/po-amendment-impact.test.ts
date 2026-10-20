import { describe, expect, it } from "vitest";
import type { PoQuantityAmendmentPreview } from "@shared/procurement/po-quantity-amendment";
import { buildPoAmendmentImpact } from "../../po-amendment-impact.policy";
import type { PoAmendmentDependencies } from "../../po-amendment-dependencies.repository";
import { planPurchaseOrderQuantityExceptions } from "../../purchase-order-quantity-exceptions.policy";

const line = {
  id: 11,
  lineNumber: 1,
  name: "Product",
  orderQty: 20,
  receivedQty: 10,
  invoicedQty: 5,
  lineType: "product" as const,
  unitCostMills: 100,
  totalProductCostCents: 20,
  lineTotalCents: 20,
  status: "partially_received",
  blockedReason: null,
};
function plan(
  quantity = 30,
  closed = false,
): { preview: PoQuantityAmendmentPreview } {
  return {
    preview: {
      purchaseOrderId: 1,
      currency: "USD",
      sourceVersion: "a".repeat(64),
      reason: "Supplier confirmed quantity",
      lines: [
        {
          before: { ...line },
          after: { ...line, orderQty: quantity },
          priceTreatment: "keep_product_total",
        },
      ],
      beforeTotalCents: 20,
      afterTotalCents: 20,
      beforeStatus: "partially_received",
      afterStatus: "partially_received",
      closedPurchaseOrder: closed,
      warnings: [],
      invoiceMatches: [],
    },
  };
}
function dependencies(): PoAmendmentDependencies {
  return {
    shipments: [{ id: 1, shipment_number: "SHIP-1", status: "closed" }],
    shipmentLines: [
      {
        id: 2,
        purchase_order_id: 1,
        purchase_order_line_id: 11,
        inbound_shipment_id: 1,
        qty_shipped: 8,
        allocated_cost_cents: 100,
      },
    ],
    costs: [{ id: 3, inbound_shipment_id: 1, actual_cents: 100 }],
    allocations: [],
    snapshots: [],
    evidence: [],
    approvals: [],
    postings: [],
    shipmentCapacity: [{ lineId: 11, remainingPieces: 10, reviewReason: null }],
  };
}

describe("measured PO dependency impact", () => {
  it("uses the shipping owner's remaining capacity rather than subtracting shipments alone", () => {
    const before = dependencies(),
      after = structuredClone(before);
    after.shipmentCapacity[0].remainingPieces = 20;
    expect(
      buildPoAmendmentImpact(plan(), before, after, []).quantities[0],
    ).toMatchObject({
      received: 10,
      shipped: 8,
      invoiced: 5,
      remainingToReceive: { before: 10, after: 20 },
      remainingToShip: { before: 10, after: 20 },
      remainingToInvoice: { before: 15, after: 25 },
    });
  });
  it("shows missing capacity evidence instead of inventing zero or a shippable balance", () => {
    const before = dependencies(),
      after = structuredClone(before);
    after.shipmentCapacity[0] = {
      lineId: 11,
      remainingPieces: null,
      reviewReason: "Receipt links need review.",
    };
    expect(
      buildPoAmendmentImpact(plan(), before, after, []).quantities[0],
    ).toMatchObject({
      remainingToShip: { before: 10, after: null },
      shipmentCapacityReview: "Receipt links need review.",
    });
  });
  it("shows the latest historical posting balance once instead of adding old balances", () => {
    const before = dependencies(),
      after = structuredClone(before);
    const posting = {
      inbound_shipment_line_id: 2,
      component: "landed",
      destination: "historical_cogs",
    };
    before.postings = [
      { ...posting, after_mills: "10001" },
      { ...posting, after_mills: "20003" },
    ];
    after.postings = [...before.postings, { ...posting, after_mills: "15002" }];
    expect(
      buildPoAmendmentImpact(plan(), before, after, []).historicalCosts,
    ).toEqual([
      {
        purchaseOrderLineId: null,
        shipmentLineId: 2,
        component: "landed",
        destination: "historical_cogs",
        totalMills: { before: 20003, after: 15002 },
      },
    ]);
  });
  it.each(["shipment quantity", "shipment charge"])(
    "rejects an owner's unintended change to %s",
    (kind) => {
      const before = dependencies(),
        after = structuredClone(before);
      if (kind === "shipment quantity") after.shipmentLines[0].qty_shipped = 9;
      else after.costs[0].actual_cents = 101;
      expect(() => buildPoAmendmentImpact(plan(), before, after, [])).toThrow(
        /changed/,
      );
    },
  );
  it("fails closed when aggregated money exceeds the exact supported range", () => {
    const before = dependencies();
    before.costs = [Number.MAX_SAFE_INTEGER, 1].map((actual_cents, id) => ({
      id,
      inbound_shipment_id: 1,
      actual_cents,
    }));
    expect(() => buildPoAmendmentImpact(plan(), before, before, [])).toThrow();
  });
});

describe("quantity exception evidence after an approved PO edit", () => {
  const shortage = {
    id: 5,
    kind: "qty_short",
    status: "resolved",
    payload: { lineId: 11, orderedQty: 20, receivedQty: 10 },
  };
  it("retains the original evidence while superseding a shortage corrected by the new order", () => {
    const original = structuredClone(shortage);
    expect(planPurchaseOrderQuantityExceptions([shortage], plan(10))).toEqual([
      { supersededIds: [5], replacement: null },
    ]);
    expect(shortage).toEqual(original);
  });
  it("requires a new review if a changed order still has a previously raised shortage", () => {
    expect(
      planPurchaseOrderQuantityExceptions([shortage], plan(30))[0],
    ).toMatchObject({
      supersededIds: [5],
      replacement: {
        kind: "qty_short",
        payload: { orderedQty: 30, receivedQty: 10, shortageQty: 20 },
      },
    });
    expect(planPurchaseOrderQuantityExceptions([], plan(30))).toEqual([
      { supersededIds: [], replacement: null },
    ]);
    expect(
      planPurchaseOrderQuantityExceptions([shortage], plan(30, true))[0]
        .replacement,
    ).toBeNull();
  });
  it("surfaces an actual overreceipt without changing the received count", () => {
    expect(
      planPurchaseOrderQuantityExceptions([], plan(5))[0].replacement,
    ).toMatchObject({
      kind: "qty_over",
      payload: { orderedQty: 5, receivedQty: 10, overageQty: 5 },
    });
  });
  it("leaves unrelated, dismissed, and unchanged source decisions alone", () => {
    expect(planPurchaseOrderQuantityExceptions([shortage], plan(20))).toEqual(
      [],
    );
    expect(
      planPurchaseOrderQuantityExceptions(
        [
          { ...shortage, status: "dismissed" },
          { ...shortage, id: 6, kind: "match_mismatch" },
          { ...shortage, id: 7, payload: { lineId: 12 } },
        ],
        plan(30),
      ),
    ).toEqual([{ supersededIds: [], replacement: null }]);
  });
});
