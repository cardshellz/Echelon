import { describe, expect, it } from "vitest";
import {
  quantityCorrectionInputSchema,
  shipmentQuantityEditInputSchema,
} from "@shared/procurement/receipt-shipment-quantity-correction";
import {
  planQuantityCorrection,
  correctedReceiptLifecycle,
  planShipmentReceiptExpectations,
  type QuantityCorrectionFacts,
} from "../../domain/receipt-shipment-quantity-correction";

const facts = (): QuantityCorrectionFacts => ({
  shipmentLineId: 11,
  shippedPieces: 200,
  orderPieces: 5000,
  poReceivedPieces: 300,
  cancelledPieces: 0,
  otherShippedPieces: 100,
  receipts: [
    {
      id: 21,
      receiptId: 20,
      receiptNumber: "RCV-A",
      receivedUnits: 2,
      receivedPieces: 200,
      piecesPerUnit: 100,
      unitWasRecorded: true,
      variantId: 30,
    },
  ],
  origins: [
    {
      inventoryLotId: 41,
      receiptLineId: 21,
      shipmentLineId: 11,
      receivedUnits: 2,
      piecesPerUnit: 100,
      purchaseStart: 0,
      shipmentStart: 0,
    },
    {
      inventoryLotId: 42,
      receiptLineId: 22,
      shipmentLineId: 12,
      receivedUnits: 1,
      piecesPerUnit: 100,
      purchaseStart: 200,
      shipmentStart: 0,
    },
  ],
});
const input = () =>
  quantityCorrectionInputSchema.parse({
    sourceVersion: "a".repeat(64),
    shippedPieces: 2000,
    receipts: [{ receiptLineId: 21, receivedPieces: 2000 }],
    reason: "Verified against packing slip",
    evidenceConfirmed: true,
  });
describe("receipt/shipment quantity correction plan", () => {
  it("shipment edits preserve posted receipts, their conversions and cost origins", () => {
    const source = facts();
    const request = {
      ...input(),
      receipts: [{ receiptLineId: 21, receivedPieces: 200 }],
    };
    const plan = planQuantityCorrection(source, request, "shipment");
    expect(plan.poReceivedPieces).toBe(source.poReceivedPieces);
    expect(plan.origins).toEqual(source.origins);
    expect(plan.receipts[0]).toMatchObject({
      afterPieces: 200,
      afterPiecesPerUnit: 100,
    });
    expect(() => planQuantityCorrection(source, input(), "shipment")).toThrow(
      "cannot change received quantities",
    );
    expect(shipmentQuantityEditInputSchema.safeParse(request).success).toBe(
      false,
    );
    const { receipts: _, ...shipmentInput } = request;
    expect(shipmentQuantityEditInputSchema.parse(shipmentInput)).toEqual(
      shipmentInput,
    );
  });
  it("a shipment edit supports unreceived goods without creating stock or receipt evidence", () => {
    const source = {
      ...facts(),
      receipts: [],
      origins: [],
      poReceivedPieces: 0,
    };
    const plan = planQuantityCorrection(
      source,
      { ...input(), receipts: [] },
      "shipment",
    );
    expect(plan.receipts).toEqual([]);
    expect(plan.origins).toEqual([]);
    expect(plan.poReceivedPieces).toBe(0);
  });
  it("only refreshes expected units on an open receipt, preserving its count and unit", () => {
    const pending = {
      receiptId: 70,
      receiptLineId: 71,
      receiptNumber: "RCV-OPEN",
      expectedUnits: 2,
      receivedUnits: 1,
      piecesPerUnit: 100,
    };
    expect(
      planShipmentReceiptExpectations([pending], 2000, BigInt(200)),
    ).toEqual([{ ...pending, afterExpectedUnits: 18 }]);
    expect(() =>
      planShipmentReceiptExpectations([pending], 2001, BigInt(200)),
    ).toThrow("receiving unit");
    expect(() =>
      planShipmentReceiptExpectations(
        [pending, { ...pending, receiptLineId: 72 }],
        2000,
        BigInt(200),
      ),
    ).toThrow("More than one");
  });
  it("changes the base-piece meaning, preserves handled units and shifts later purchase intervals", () => {
    const source = facts(),
      before = structuredClone(source);
    const plan = planQuantityCorrection(source, input());
    expect(plan.poReceivedPieces).toBe(2100);
    expect(plan.receipts[0]).toMatchObject({
      receivedUnits: 2,
      afterPieces: 2000,
      afterPiecesPerUnit: 1000,
    });
    expect(plan.origins).toEqual([
      { ...before.origins[0], piecesPerUnit: 1000 },
      { ...before.origins[1], purchaseStart: 2000 },
    ]);
    expect(source).toEqual(before);
  });
  it("preserves gaps between known origins", () => {
    const source = facts();
    source.origins[1].purchaseStart = 250;
    expect(
      planQuantityCorrection(source, input()).origins[1].purchaseStart,
    ).toBe(2050);
  });
  it("handles split lots and partial receipts without multiplying physical stock", () => {
    const source = facts();
    source.origins[0].receivedUnits = 1;
    source.origins.splice(1, 0, {
      ...source.origins[0],
      inventoryLotId: 43,
      purchaseStart: 100,
      shipmentStart: 100,
    });
    const request = input();
    request.shippedPieces = 3000;
    const plan = planQuantityCorrection(source, request);
    expect(
      plan.origins.map((origin) => [
        origin.purchaseStart,
        origin.shipmentStart,
      ]),
    ).toEqual([
      [0, 0],
      [1000, 1000],
      [2000, 0],
    ]);
  });
  it("rejects incorrect coverage and overlapping cost intervals", () => {
    const source = facts();
    source.origins[0].receivedUnits = 1;
    expect(() => planQuantityCorrection(source, input())).toThrow(
      "exact handled receipt",
    );
    source.origins[0].receivedUnits = 2;
    source.origins[1].purchaseStart = 100;
    expect(() => planQuantityCorrection(source, input())).toThrow("overlap");
  });
  it("does not invent missing origins", () => {
    const source = facts();
    source.origins = [];
    expect(planQuantityCorrection(source, input()).origins).toEqual([]);
  });
  it("rejects conflicting receipt unit and shipment origin evidence", () => {
    const source = facts();
    source.origins[0].piecesPerUnit = 50;
    expect(() => planQuantityCorrection(source, input())).toThrow("disagree");
    source.origins[0].piecesPerUnit = 100;
    source.origins[0].shipmentLineId = 999;
    expect(() => planQuantityCorrection(source, input())).toThrow("disagree");
  });
  it.each([0, -1, 0.5, 2147483648, Number.MAX_SAFE_INTEGER, NaN, Infinity])(
    "rejects invalid pieces %s at the boundary",
    (value) => {
      expect(
        quantityCorrectionInputSchema.safeParse({
          ...input(),
          shippedPieces: value,
        }).success,
      ).toBe(false);
    },
  );
  it("requires whole pieces per received unit", () => {
    const request = input();
    request.receipts[0].receivedPieces = 1999;
    expect(() => planQuantityCorrection(facts(), request)).toThrow(
      "whole number",
    );
  });
  it.each(["missing", "duplicate", "wrong"] as const)(
    "rejects %s receipt selection",
    (kind) => {
      const request = input();
      request.receipts =
        kind === "missing"
          ? []
          : kind === "duplicate"
            ? [...request.receipts, ...request.receipts]
            : [{ receiptLineId: 999, receivedPieces: 2000 }];
      expect(() => planQuantityCorrection(facts(), request)).toThrow(
        "every linked receipt",
      );
    },
  );
  it("enforces PO capacity and does not allow received pieces beyond the manifest", () => {
    const request = input();
    request.shippedPieces = 5000;
    expect(() => planQuantityCorrection(facts(), request)).toThrow(
      "available PO quantity",
    );
    request.shippedPieces = 1000;
    expect(() => planQuantityCorrection(facts(), request)).toThrow(
      "cannot exceed",
    );
  });
  it("rejects a repeated no-op but permits recording a missing conversion", () => {
    const source = facts(),
      request = input();
    request.shippedPieces = 200;
    request.receipts[0].receivedPieces = 200;
    expect(() => planQuantityCorrection(source, request)).toThrow(
      "already recorded",
    );
    source.receipts[0].unitWasRecorded = false;
    expect(
      planQuantityCorrection(source, request).receipts[0].afterPiecesPerUnit,
    ).toBe(100);
  });
});

describe("corrected receipt lifecycle", () => {
  const source = () => ({
    closed: false,
    status: "received",
    physicalStatus: "received",
    targetId: 1,
    targetReceived: 100,
    targetOrdered: 100,
    targetCancelled: 0,
    lines: [
      { id: 1, status: "received", lineType: "product" },
      { id: 2, status: "open", lineType: "service" },
      { id: 3, status: "cancelled", lineType: "product" },
    ],
  });
  it("counts only active product lines and preserves completed receiving", () => {
    expect(correctedReceiptLifecycle(source())).toEqual({
      lineStatus: "received",
      receivedLineCount: 1,
      status: "received",
      physicalStatus: "received",
    });
  });
  it("shows a reopened receiving balance without reopening a closed PO", () => {
    expect(
      correctedReceiptLifecycle({ ...source(), targetReceived: 50 }),
    ).toMatchObject({
      status: "partially_received",
      physicalStatus: "receiving",
      receivedLineCount: 0,
    });
    expect(
      correctedReceiptLifecycle({
        ...source(),
        closed: true,
        status: "closed",
        physicalStatus: "closed",
        targetReceived: 50,
      }),
    ).toMatchObject({
      status: "closed",
      physicalStatus: "closed",
      receivedLineCount: 0,
    });
  });
});
