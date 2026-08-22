import { describe, expect, it, vi } from "vitest";

import {
  ReturnCaseAdminApiError,
  getReturnCaseDetail,
  recordReturnReceipt,
  startReturnInspection,
  type ReturnCaseAdminTransport,
} from "../return-case-admin-api";

describe("return case admin API client", () => {
  it("loads and strictly validates operational return-case detail with one request", async () => {
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(detailFixture()));

    const detail = await getReturnCaseDetail(42, transport);

    expect(detail.actionPlan.nextAction).toBe("record_receipt");
    expect(detail.items[0]).toMatchObject({
      id: 11,
      expectedQuantity: 2,
      receivedQuantity: 1,
      remainingQuantity: 1,
      receiptStatus: "partially_received",
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      "/api/returns/admin/cases/42",
      {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("normalizes and deterministically orders a receipt command", async () => {
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse({
      commandType: "record_receipt",
      caseId: 42,
      caseNumber: "RET-0000000042",
      wmsReturnId: 230,
      logisticsStatus: "partially_received",
      expectedUnits: 5,
      receivedUnits: 3,
      remainingUnits: 2,
      replayed: false,
    }));

    const result = await recordReturnReceipt(42, {
      idempotencyKey: " receipt-command-1 ",
      notes: " dock count verified ",
      lines: [
        { returnCaseItemId: 12, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 },
        { returnCaseItemId: 11, expectedCurrentReceivedQuantity: 1, quantityReceivedNow: 1 },
      ],
    }, transport);

    expect(result).toMatchObject({ commandType: "record_receipt", remainingUnits: 2 });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("/api/returns/admin/cases/42/receipt");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotencyKey: "receipt-command-1",
      notes: "dock count verified",
      lines: [
        { returnCaseItemId: 11, expectedCurrentReceivedQuantity: 1, quantityReceivedNow: 1 },
        { returnCaseItemId: 12, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 },
      ],
    });
  });

  it("posts and validates the direct start-inspection result", async () => {
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse({
      commandType: "start_inspection",
      caseId: 42,
      caseNumber: "RET-0000000042",
      inspectionId: 91,
      inspectionStatus: "in_progress",
      startedAt: "2026-08-22T14:30:00.000Z",
      replayed: false,
    }));

    const result = await startReturnInspection(42, {
      idempotencyKey: "inspection-command-1",
    }, transport);

    expect(result).toMatchObject({ inspectionId: 91, inspectionStatus: "in_progress" });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("/api/returns/admin/cases/42/inspections/start");
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotencyKey: "inspection-command-1",
      notes: null,
    });
  });

  it.each([
    {
      name: "invalid case id",
      execute: (transport: ReturnCaseAdminTransport) => getReturnCaseDetail(0, transport),
    },
    {
      name: "duplicate receipt line",
      execute: (transport: ReturnCaseAdminTransport) => recordReturnReceipt(42, {
        idempotencyKey: "receipt-command-1",
        lines: [
          { returnCaseItemId: 11, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 },
          { returnCaseItemId: 11, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 },
        ],
      }, transport),
    },
    {
      name: "non-positive receipt quantity",
      execute: (transport: ReturnCaseAdminTransport) => recordReturnReceipt(42, {
        idempotencyKey: "receipt-command-1",
        lines: [{ returnCaseItemId: 11, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 0 }],
      }, transport),
    },
    {
      name: "missing expected current receipt quantity",
      execute: (transport: ReturnCaseAdminTransport) => recordReturnReceipt(42, {
        idempotencyKey: "receipt-command-1",
        lines: [{ returnCaseItemId: 11, quantityReceivedNow: 1 }],
      } as never, transport),
    },
    {
      name: "negative expected current receipt quantity",
      execute: (transport: ReturnCaseAdminTransport) => recordReturnReceipt(42, {
        idempotencyKey: "receipt-command-1",
        lines: [{ returnCaseItemId: 11, expectedCurrentReceivedQuantity: -1, quantityReceivedNow: 1 }],
      }, transport),
    },
    {
      name: "unknown outbound field",
      execute: (transport: ReturnCaseAdminTransport) => startReturnInspection(42, {
        idempotencyKey: "inspection-command-1",
        unexpected: true,
      } as never, transport),
    },
  ])("rejects $name before issuing a request", async ({ execute }) => {
    const transport = vi.fn<ReturnCaseAdminTransport>();

    await expect(execute(transport)).rejects.toMatchObject({
      code: "RETURN_CASE_CLIENT_INPUT_INVALID",
      status: 0,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("preserves a structured server error without retrying", async () => {
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse({
      error: {
        code: "RETURN_CASE_RECEIPT_QUANTITY_EXCEEDED",
        message: "The receipt quantity exceeds the quantity still expected for an item.",
        context: { returnCaseItemId: 11, remaining: 1 },
      },
    }, 409));

    const error = await recordReturnReceipt(42, {
      idempotencyKey: "receipt-command-1",
      lines: [{ returnCaseItemId: 11, expectedCurrentReceivedQuantity: 1, quantityReceivedNow: 2 }],
    }, transport).catch((caught) => caught);

    expect(error).toBeInstanceOf(ReturnCaseAdminApiError);
    expect(error).toMatchObject({
      code: "RETURN_CASE_RECEIPT_QUANTITY_EXCEEDED",
      status: 409,
      message: "The receipt quantity exceeds the quantity still expected for an item.",
      context: { returnCaseItemId: 11, remaining: 1 },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed or internally inconsistent success payloads without retrying", async () => {
    const malformed = detailFixture();
    malformed.actionPlan.receiptSummary.remainingUnits = 3;
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse({
      ...malformed,
      unknownField: true,
    }));

    await expect(getReturnCaseDetail(42, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("classifies invalid JSON and transport failures with one attempted request", async () => {
    const invalidJsonTransport = vi.fn<ReturnCaseAdminTransport>(async () =>
      new Response("not-json", { status: 200 }),
    );
    await expect(getReturnCaseDetail(42, invalidJsonTransport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
    });
    expect(invalidJsonTransport).toHaveBeenCalledTimes(1);

    const failedTransport = vi.fn<ReturnCaseAdminTransport>(async () => {
      throw new TypeError("network unavailable");
    });
    await expect(getReturnCaseDetail(42, failedTransport)).rejects.toMatchObject({
      code: "RETURN_CASE_REQUEST_FAILED",
      status: 0,
      context: { causeName: "TypeError" },
    });
    expect(failedTransport).toHaveBeenCalledTimes(1);
  });
});

function detailFixture() {
  return {
    recordOrigin: "canonical" as const,
    recordKey: "return-case:42",
    legacyRmaId: null,
    id: 42,
    caseNumber: "RET-0000000042",
    sourceProvider: "admin",
    sourceEventType: "manual_return_case_opened",
    sourceEventId: "return-command-42",
    businessContext: "retail",
    channelId: 36,
    channelName: "Shopify",
    vendorId: null,
    vendorName: null,
    storeConnectionId: null,
    storeName: null,
    omsOrderId: 61_694,
    omsOrderNumber: "61694",
    wmsOrderId: 61_694,
    wmsOrderNumber: "61694",
    wmsReturnId: 230,
    caseStatus: "open",
    approvalStatus: "approved",
    logisticsStatus: "partially_received",
    inspectionStatus: "pending",
    customerRefundStatus: "pending",
    vendorSettlementStatus: "not_applicable",
    openedAt: "2026-08-22T12:00:00.000Z",
    closedAt: null,
    itemCount: 2,
    unitCount: 5,
    policyId: 6,
    policyVersion: 2,
    policySnapshot: { inspectionRequirement: "required" },
    createdAt: "2026-08-22T12:00:00.000Z",
    updatedAt: "2026-08-22T12:30:00.000Z",
    items: [
      {
        id: 11,
        wmsReturnItemId: 301,
        omsOrderLineId: 501,
        wmsOrderItemId: 701,
        externalLineItemId: "line-11",
        sku: "SKU-11",
        title: "First item",
        quantity: 2,
        expectedQuantity: 2,
        receivedQuantity: 1,
        remainingQuantity: 1,
        receiptStatus: "partially_received" as const,
        unitPaidPriceCents: 495,
        sourceLineTotalCents: 990,
        createdAt: "2026-08-22T12:00:00.000Z",
      },
      {
        id: 12,
        wmsReturnItemId: 302,
        omsOrderLineId: 502,
        wmsOrderItemId: 702,
        externalLineItemId: "line-12",
        sku: "SKU-12",
        title: "Second item",
        quantity: 3,
        expectedQuantity: 3,
        receivedQuantity: 0,
        remainingQuantity: 3,
        receiptStatus: "expected" as const,
        unitPaidPriceCents: 250,
        sourceLineTotalCents: 750,
        createdAt: "2026-08-22T12:00:00.000Z",
      },
    ],
    events: [{
      id: 90,
      eventType: "return_case_opened",
      actor: "user:1",
      details: { policyId: 6 },
      occurredAt: "2026-08-22T12:00:00.000Z",
      createdAt: "2026-08-22T12:00:00.000Z",
    }],
    actionPlan: {
      nextAction: "record_receipt" as const,
      receiptSummary: {
        expectedUnits: 5,
        receivedUnits: 1,
        remainingUnits: 4,
        fullyReceived: false,
        partiallyReceived: true,
      },
      actions: [
        {
          kind: "record_receipt" as const,
          label: "Record receipt",
          description: "Record physical receipt against the expected WMS return.",
          state: "available" as const,
          reasonCode: null,
        },
        {
          kind: "start_inspection" as const,
          label: "Start inspection",
          description: "Begin inspection of the received items.",
          state: "blocked" as const,
          reasonCode: "RETURN_NOT_FULLY_RECEIVED",
        },
      ],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
