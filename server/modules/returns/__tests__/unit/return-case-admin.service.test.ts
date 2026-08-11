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
      id: 8,
      openedAt: "2026-08-10T12:00:00.000Z",
      closedAt: null,
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

    expect(result.items[0]).toMatchObject({
      unitPaidPriceCents: 1099,
      sourceLineTotalCents: 2198,
      createdAt: "2026-08-10T12:00:01.000Z",
    });
    expect(result.events[0]).toMatchObject({
      eventType: "return_case_opened",
      occurredAt: "2026-08-10T12:00:00.000Z",
    });
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
    policySnapshot: { returnWindowDays: 30 },
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
  };
}
