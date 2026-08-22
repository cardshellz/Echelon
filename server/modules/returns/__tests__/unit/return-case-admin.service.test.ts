import { describe, expect, it, vi } from "vitest";
import {
  ReturnCaseAdminError,
  ReturnCaseAdminService,
  type ReturnCaseAdminStore,
  type ReturnCaseDetailRow,
  type ReturnCaseListQuery,
  type ReturnCaseListRow,
} from "../../application/return-case-admin.service";

describe("ReturnCaseAdminService", () => {
  it("serializes list timestamps and returns deterministic pagination", async () => {
    const store = fakeStore();
    store.list.mockResolvedValue({
      rows: [listRow()],
      summary: { total: 51, open: 40, awaitingInspection: 12, closed: 11 },
    });
    const service = new ReturnCaseAdminService(store);
    const query: ReturnCaseListQuery = {
      search: null,
      caseStatus: null,
      sourceProvider: null,
      channelId: null,
      page: 2,
      limit: 25,
    };

    const result = await service.list(query);

    expect(store.list).toHaveBeenCalledWith(query);
    expect(result.summary).toEqual({ total: 51, open: 40, awaitingInspection: 12, closed: 11 });
    expect(result.pagination).toEqual({ page: 2, limit: 25, total: 51, totalPages: 3 });
    expect(result.cases[0]).toMatchObject({
      recordOrigin: "canonical",
      recordKey: "canonical:8",
      legacyRmaId: null,
      id: 8,
      openedAt: "2026-08-10T12:00:00.000Z",
      closedAt: null,
    });
  });

  it("serializes historical dropship RMAs without requiring canonical order links", async () => {
    const store = fakeStore();
    store.list.mockResolvedValue({
      rows: [{
        ...listRow(),
        recordOrigin: "legacy_dropship",
        recordKey: "legacy_dropship:12",
        legacyRmaId: 12,
        id: 12,
        caseNumber: "RMA-DF-0012",
        sourceProvider: "ebay",
        sourceEventType: "legacy_rma",
        sourceEventId: "12",
        businessContext: "dropship",
        channelId: null,
        channelName: null,
        omsOrderId: null,
        omsOrderNumber: null,
        wmsOrderId: null,
        wmsOrderNumber: null,
        wmsReturnId: null,
      }],
      summary: { total: 1, open: 1, awaitingInspection: 0, closed: 0 },
    });
    const service = new ReturnCaseAdminService(store);

    const result = await service.list({
      search: null,
      caseStatus: null,
      sourceProvider: null,
      channelId: null,
      page: 1,
      limit: 25,
    });

    expect(result.cases[0]).toMatchObject({
      recordOrigin: "legacy_dropship",
      recordKey: "legacy_dropship:12",
      legacyRmaId: 12,
      channelId: null,
      omsOrderId: null,
      wmsOrderId: null,
      wmsReturnId: null,
      openedAt: "2026-08-10T12:00:00.000Z",
    });
  });
  it("returns zero total pages for an empty result", async () => {
    const store = fakeStore();
    store.list.mockResolvedValue({
      rows: [],
      summary: { total: 0, open: 0, awaitingInspection: 0, closed: 0 },
    });
    const service = new ReturnCaseAdminService(store);

    const result = await service.list({
      search: null,
      caseStatus: null,
      sourceProvider: null,
      channelId: null,
      page: 1,
      limit: 25,
    });

    expect(result.pagination.totalPages).toBe(0);
  });

  it("serializes detail items and events without altering integer money", async () => {
    const store = fakeStore();
    store.getById.mockResolvedValue(detailRow());
    const service = new ReturnCaseAdminService(store);

    const result = await service.getById(8);

    expect(Object.keys(result).sort()).toEqual([
      "actionPlan",
      "approvalStatus",
      "businessContext",
      "caseNumber",
      "caseStatus",
      "channelId",
      "channelName",
      "closedAt",
      "createdAt",
      "customerRefundStatus",
      "events",
      "id",
      "inspectionStatus",
      "itemCount",
      "items",
      "legacyRmaId",
      "logisticsStatus",
      "omsOrderId",
      "omsOrderNumber",
      "openedAt",
      "policyId",
      "policySnapshot",
      "policyVersion",
      "recordKey",
      "recordOrigin",
      "sourceEventId",
      "sourceEventType",
      "sourceProvider",
      "storeConnectionId",
      "storeName",
      "unitCount",
      "updatedAt",
      "vendorId",
      "vendorName",
      "vendorSettlementStatus",
      "wmsOrderId",
      "wmsOrderNumber",
      "wmsReturnId",
    ].sort());
    expect(result.items[0]).toMatchObject({
      expectedQuantity: 2,
      receivedQuantity: 0,
      remainingQuantity: 2,
      receiptStatus: "expected",
      unitPaidPriceCents: 1099,
      sourceLineTotalCents: 2198,
      createdAt: "2026-08-10T12:00:01.000Z",
    });
    expect(result.actionPlan).toMatchObject({
      nextAction: "record_receipt",
      receiptSummary: {
        expectedUnits: 2,
        receivedUnits: 0,
        remainingUnits: 2,
      },
      actions: [
        { kind: "record_receipt", state: "available" },
        { kind: "start_inspection", state: "blocked" },
      ],
    });
    expect(result.events[0]).toMatchObject({
      eventType: "return_case_opened",
      occurredAt: "2026-08-10T12:00:00.000Z",
    });
  });

  it("serializes a blocked action plan when immutable policy evidence is invalid", async () => {
    const store = fakeStore();
    const row = detailRow();
    row.actionContext.policy = null;
    store.getById.mockResolvedValue(row);
    const service = new ReturnCaseAdminService(store);

    const result = await service.getById(8);

    expect(result.actionPlan.nextAction).toBeNull();
    expect(result.actionPlan.actions).toEqual([
      expect.objectContaining({ kind: "record_receipt", state: "blocked", reasonCode: "RETURN_POLICY_SNAPSHOT_INVALID" }),
      expect.objectContaining({ kind: "start_inspection", state: "blocked", reasonCode: "RETURN_POLICY_SNAPSHOT_INVALID" }),
    ]);
  });

  it("classifies a missing case as a 404", async () => {
    const store = fakeStore();
    store.getById.mockResolvedValue(null);
    const service = new ReturnCaseAdminService(store);

    await expect(service.getById(404)).rejects.toEqual(expect.objectContaining<Partial<ReturnCaseAdminError>>({
      code: "RETURN_CASE_NOT_FOUND",
      status: 404,
      context: { id: 404 },
    }));
  });
});

function fakeStore() {
  return {
    list: vi.fn<ReturnCaseAdminStore["list"]>(),
    getById: vi.fn<ReturnCaseAdminStore["getById"]>(),
  };
}

function listRow(): ReturnCaseListRow {
  return {
    recordOrigin: "canonical",
    recordKey: "canonical:8",
    legacyRmaId: null,
    id: 8,
    caseNumber: "RMA-000008",
    sourceProvider: "shopify",
    sourceEventType: "refund",
    sourceEventId: "9001",
    businessContext: "retail",
    channelId: 36,
    channelName: "Shopify",
    vendorId: null,
    vendorName: null,
    storeConnectionId: null,
    storeName: null,
    omsOrderId: 100,
    omsOrderNumber: "61229",
    wmsOrderId: 200,
    wmsOrderNumber: "61229",
    wmsReturnId: 300,
    caseStatus: "open",
    approvalStatus: "approved",
    logisticsStatus: "awaiting_return",
    inspectionStatus: "pending",
    customerRefundStatus: "completed",
    vendorSettlementStatus: "not_applicable",
    openedAt: new Date("2026-08-10T12:00:00.000Z"),
    closedAt: null,
    itemCount: 1,
    unitCount: 2,
  };
}

function detailRow(): ReturnCaseDetailRow {
  return {
    ...listRow(),
    policyId: 7,
    policyVersion: 3,
    policySnapshot: policySnapshot(),
    createdAt: new Date("2026-08-10T12:00:00.000Z"),
    updatedAt: new Date("2026-08-10T12:00:02.000Z"),
    items: [{
      id: 80,
      wmsReturnItemId: 301,
      omsOrderLineId: 101,
      wmsOrderItemId: 201,
      externalLineItemId: "line-1",
      sku: "SKU-1",
      title: "Toploader",
      quantity: 2,
      expectedQuantity: 2,
      receivedQuantity: 0,
      remainingQuantity: 2,
      receiptStatus: "expected",
      unitPaidPriceCents: 1099,
      sourceLineTotalCents: 2198,
      createdAt: new Date("2026-08-10T12:00:01.000Z"),
    }],
    events: [{
      id: 81,
      eventType: "return_case_opened",
      actor: "system:shopify-refund",
      details: { sourceEventId: "9001" },
      occurredAt: new Date("2026-08-10T12:00:00.000Z"),
      createdAt: new Date("2026-08-10T12:00:01.000Z"),
    }],
    actionContext: {
      lifecycle: {
        caseStatus: "open",
        approvalStatus: "approved",
        logisticsStatus: "awaiting_return",
        inspectionStatus: "pending",
        customerRefundStatus: "completed",
        vendorSettlementStatus: "not_applicable",
      },
      policy: policySnapshot(),
      receipt: {
        wmsReturnId: 300,
        wmsStatus: "expected",
        receivedAt: null,
        restocked: false,
        canonicalItemCount: 1,
        items: [{
          returnCaseItemId: 80,
          wmsReturnItemId: 301,
          caseExpectedQuantity: 2,
          wmsExpectedQuantity: 2,
          wmsReceivedQuantity: 0,
          wmsStatus: "expected",
        }],
      },
      inspection: null,
      conditionalInspectionDecision: null,
    },
  };
}

function policySnapshot() {
  return {
    id: 7,
    name: "Retail returns",
    version: 3,
    scopeKind: "channel_context",
    scopeKey: "context:retail:channel:36",
    returnWindowDays: 30,
    returnDestination: "card_shellz" as const,
    approvalAuthority: "card_shellz",
    labelProvider: "shipstation",
    returnShippingPayer: "customer",
    inspectionRequirement: "required" as const,
    inspectionOwner: "card_shellz" as const,
    customerRefundAuthority: "card_shellz",
    vendorSettlementTrigger: "none",
    returnlessRefundAllowed: false,
  };
}
