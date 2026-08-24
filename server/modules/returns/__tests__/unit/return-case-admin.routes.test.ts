import http from "http";
import { AddressInfo } from "net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReturnCaseAdminError,
  type ReturnCaseAdminService,
} from "../../application/return-case-admin.service";
import {
  OpenReturnCaseError,
  type OpenReturnCaseService,
} from "../../application/open-return-case.service";
import {
  ReturnCaseOperationError,
  type ReturnCaseOperationService,
} from "../../application/return-case-operations.service";
import {
  ReturnCaseFinancialError,
  type ReturnCaseFinancialService,
} from "../../application/return-case-financial.service";
import { registerReturnCaseAdminRoutes } from "../../interfaces/http/return-case-admin.routes";

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({ requirePermission: requirePermissionMock }));

describe("return case admin routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: ReturnType<typeof fakeService>;
  let openService: ReturnType<typeof fakeOpenService>;
  let operationService: ReturnType<typeof fakeOperationService>;
  let financialService: ReturnType<typeof fakeFinancialService>;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = fakeService();
    openService = fakeOpenService();
    operationService = fakeOperationService();
    financialService = fakeFinancialService();
    server = await startServer(buildApp(service, openService, operationService, financialService));
  });

  afterEach(async () => server.close());

  it("validates and forwards normalized list filters", async () => {
    service.list.mockResolvedValue({
      cases: [],
      summary: { total: 0, open: 0, awaitingInspection: 0, closed: 0 },
      pagination: { page: 2, limit: 10, total: 0, totalPages: 0 },
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases?search=%20RMA-1%20&caseStatus=open&sourceProvider=shopify&page=2&limit=10`);

    expect(response.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith({
      search: "RMA-1",
      caseStatus: "open",
      sourceProvider: "shopify",
      channelId: null,
      page: 2,
      limit: 10,
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "view");
  });

  it("rejects invalid pagination before calling the service", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/cases?page=0&limit=101`);

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(service.list).not.toHaveBeenCalled();
  });

  it("rejects unsafe case ids before calling the service", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/9007199254740992`);

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(service.getById).not.toHaveBeenCalled();
  });

  it("returns classified not-found responses", async () => {
    service.getById.mockRejectedValue(new ReturnCaseAdminError(
      "RETURN_CASE_NOT_FOUND",
      "Return case was not found.",
      404,
      { id: 42 },
    ));

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42`);

    expect(response).toEqual({
      status: 404,
      body: {
        error: {
          code: "RETURN_CASE_NOT_FOUND",
          message: "Return case was not found.",
          context: { id: 42 },
        },
      },
    });
  });

  it("normalizes source-order search and requires view permission", async () => {
    openService.searchSourceOrders.mockResolvedValue({
      orders: [],
      channels: [],
      pagination: { page: 3, limit: 10, total: 0, totalPages: 0 },
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/source-orders?search=%20ORDER-1%20&channelId=36&page=3&limit=10`);

    expect(response.status).toBe(200);
    expect(openService.searchSourceOrders).toHaveBeenCalledWith({
      search: "ORDER-1",
      channelId: 36,
      page: 3,
      limit: 10,
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "view");
  });

  it("opens a case with the authenticated actor and edit permission", async () => {
    openService.open.mockResolvedValue({ caseId: 9, caseNumber: "RMA-00000009", wmsReturnId: 10, replayed: false });
    const body = {
      idempotencyKey: "command-1",
      omsOrderId: 101,
      wmsOrderId: 201,
      reasonCode: "buyer_return",
      notes: "customer request",
      items: [{ wmsOrderItemId: 301, quantity: 1 }],
    };

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases`, { method: "POST", body });

    expect(response.status).toBe(201);
    expect(openService.open).toHaveBeenCalledWith({ ...body, actor: "user:7" });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "edit");
  });

  it("returns 200 for an idempotent replay", async () => {
    openService.open.mockResolvedValue({ caseId: 9, caseNumber: "RMA-00000009", wmsReturnId: 10, replayed: true });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases`, {
      method: "POST",
      body: {
        idempotencyKey: "command-1",
        omsOrderId: 101,
        wmsOrderId: 201,
        reasonCode: "buyer_return",
        notes: null,
        items: [{ wmsOrderItemId: 301, quantity: 1 }],
      },
    });

    expect(response.status).toBe(200);
  });

  it("rejects malformed create commands before calling the service", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/cases`, {
      method: "POST",
      body: {
        idempotencyKey: "command-1",
        omsOrderId: 101,
        wmsOrderId: 201,
        reasonCode: "made_up",
        items: [],
      },
    });

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(openService.open).not.toHaveBeenCalled();
  });

  it("preserves classified create conflicts", async () => {
    openService.open.mockRejectedValue(new OpenReturnCaseError(
      "RETURN_CASE_QUANTITY_UNAVAILABLE",
      "The requested quantity is unavailable.",
      409,
      { wmsOrderItemId: 301 },
    ));

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases`, {
      method: "POST",
      body: {
        idempotencyKey: "command-1",
        omsOrderId: 101,
        wmsOrderId: 201,
        reasonCode: "buyer_return",
        notes: null,
        items: [{ wmsOrderItemId: 301, quantity: 2 }],
      },
    });

    expect(response).toMatchObject({ status: 409, body: { error: { code: "RETURN_CASE_QUANTITY_UNAVAILABLE" } } });
  });

  it("records a receipt with normalized input and the authenticated server actor", async () => {
    operationService.recordReceipt.mockResolvedValue({
      commandType: "record_receipt",
      caseId: 42,
      caseNumber: "RET-0000000042",
      wmsReturnId: 72,
      logisticsStatus: "received",
      expectedUnits: 2,
      receivedUnits: 2,
      remainingUnits: 0,
      replayed: false,
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/receipt`, {
      method: "POST",
      body: {
        idempotencyKey: " receipt-command-1 ",
        notes: " dock receipt ",
        lines: [{ returnCaseItemId: 9, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 2 }],
      },
    });

    expect(response.status).toBe(201);
    expect(operationService.recordReceipt).toHaveBeenCalledWith({
      caseId: 42,
      idempotencyKey: "receipt-command-1",
      notes: "dock receipt",
      lines: [{ returnCaseItemId: 9, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 2 }],
      actor: "user:7",
    });
  });

  it("starts an inspection with the authenticated server actor", async () => {
    operationService.startInspection.mockResolvedValue({
      commandType: "start_inspection",
      caseId: 42,
      caseNumber: "RET-0000000042",
      inspectionId: 81,
      inspectionStatus: "in_progress",
      startedAt: "2026-08-22T16:00:00.000Z",
      replayed: false,
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/inspections/start`, {
      method: "POST",
      body: { idempotencyKey: " inspection-command-1 ", notes: null },
    });

    expect(response.status).toBe(201);
    expect(operationService.startInspection).toHaveBeenCalledWith({
      caseId: 42,
      idempotencyKey: "inspection-command-1",
      notes: null,
      actor: "user:7",
    });
  });

  it("completes an inspection with strict normalized input and the authenticated actor", async () => {
    operationService.completeInspection.mockResolvedValue({
      commandType: "complete_inspection",
      caseId: 42,
      caseNumber: "RET-0000000042",
      inspectionId: 81,
      inspectionStatus: "approved",
      completedAt: "2026-08-22T17:00:00.000Z",
      replayed: false,
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/inspections/81/complete`, {
      method: "POST",
      body: { idempotencyKey: " complete-command-1 ", outcome: "approved", notes: " approved condition " },
    });

    expect(response.status).toBe(201);
    expect(operationService.completeInspection).toHaveBeenCalledWith({
      caseId: 42,
      inspectionId: 81,
      idempotencyKey: "complete-command-1",
      outcome: "approved",
      notes: "approved condition",
      actor: "user:7",
    });
  });

  it("returns 200 for a completion command replay", async () => {
    operationService.completeInspection.mockResolvedValue({
      commandType: "complete_inspection",
      caseId: 42,
      caseNumber: "RET-0000000042",
      inspectionId: 81,
      inspectionStatus: "rejected",
      completedAt: "2026-08-22T17:00:00.000Z",
      replayed: true,
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/inspections/81/complete`, {
      method: "POST",
      body: { idempotencyKey: "complete-command-2", outcome: "rejected", notes: null },
    });

    expect(response.status).toBe(200);
  });

  it("strictly rejects malformed completion commands and unsafe inspection ids", async () => {
    const malformed = await jsonRequest(`${server.url}/api/returns/admin/cases/42/inspections/81/complete`, {
      method: "POST",
      body: {
        idempotencyKey: "complete-command-3",
        outcome: "approved",
        notes: null,
        actor: "forged-actor",
      },
    });
    const unsafeId = await jsonRequest(
      `${server.url}/api/returns/admin/cases/42/inspections/9007199254740992/complete`,
      { method: "POST", body: { idempotencyKey: "complete-command-4", outcome: "approved", notes: null } },
    );

    expect(malformed).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(unsafeId).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(operationService.completeInspection).not.toHaveBeenCalled();
  });

  it("records disposition with strict reviewed evidence and the authenticated actor", async () => {
    operationService.recordDisposition.mockResolvedValue({
      commandType: "record_disposition",
      caseId: 42,
      caseNumber: "RET-0000000042",
      dispositionId: 91,
      inspectionId: 81,
      inspectionResolution: "approved",
      lines: [{ returnCaseItemId: 9, quantity: 2, treatment: "restock_sellable" }],
      dispositionSummary: {
        receivedUnits: 2,
        recordedUnits: 2,
        remainingUnits: 0,
        fullyRecorded: true,
        partiallyRecorded: false,
        items: [{
          returnCaseItemId: 9,
          receivedQuantity: 2,
          restockSellableQuantity: 2,
          holdNonSellableQuantity: 0,
          recordedQuantity: 2,
          remainingQuantity: 0,
        }],
      },
      recordedAt: "2026-08-22T18:00:00.000Z",
      replayed: false,
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/dispositions`, {
      method: "POST",
      body: {
        idempotencyKey: " disposition-command-1 ",
        inspectionId: 81,
        notes: " sellable ",
        lines: [{
          returnCaseItemId: 9,
          quantity: 2,
          treatment: "restock_sellable",
          expectedCurrentReceivedQuantity: 2,
          expectedCurrentDisposedQuantity: 0,
        }],
      },
    });

    expect(response.status).toBe(201);
    expect(operationService.recordDisposition).toHaveBeenCalledWith({
      caseId: 42,
      idempotencyKey: "disposition-command-1",
      inspectionId: 81,
      notes: "sellable",
      lines: [{
        returnCaseItemId: 9,
        quantity: 2,
        treatment: "restock_sellable",
        expectedCurrentReceivedQuantity: 2,
        expectedCurrentDisposedQuantity: 0,
      }],
      actor: "user:7",
    });
  });

  it("returns 200 for a disposition replay", async () => {
    operationService.recordDisposition.mockResolvedValue({
      commandType: "record_disposition",
      caseId: 42,
      caseNumber: "RET-0000000042",
      dispositionId: 91,
      inspectionId: null,
      inspectionResolution: "not_required",
      lines: [{ returnCaseItemId: 9, quantity: 1, treatment: "hold_non_sellable" }],
      dispositionSummary: {
        receivedUnits: 2,
        recordedUnits: 1,
        remainingUnits: 1,
        fullyRecorded: false,
        partiallyRecorded: true,
        items: [],
      },
      recordedAt: "2026-08-22T18:00:00.000Z",
      replayed: true,
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/dispositions`, {
      method: "POST",
      body: {
        idempotencyKey: "disposition-replay",
        inspectionId: null,
        notes: null,
        lines: [{
          returnCaseItemId: 9,
          quantity: 1,
          treatment: "hold_non_sellable",
          expectedCurrentReceivedQuantity: 2,
          expectedCurrentDisposedQuantity: 0,
        }],
      },
    });

    expect(response.status).toBe(200);
  });

  it.each([
    { name: "missing reviewed inspection id", omitInspection: true, treatment: "restock_sellable", extra: {} },
    { name: "invalid treatment", omitInspection: false, treatment: "destroy", extra: {} },
    { name: "forged actor", omitInspection: false, treatment: "restock_sellable", extra: { actor: "user:999" } },
  ])("strictly rejects $name before disposition service calls", async ({ omitInspection, treatment, extra }) => {
    const body: Record<string, unknown> = {
      idempotencyKey: "disposition-invalid",
      inspectionId: 81,
      notes: null,
      lines: [{
        returnCaseItemId: 9,
        quantity: 1,
        treatment,
        expectedCurrentReceivedQuantity: 2,
        expectedCurrentDisposedQuantity: 0,
      }],
      ...extra,
    };
    if (omitInspection) delete body.inspectionId;

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/dispositions`, {
      method: "POST",
      body,
    });

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(operationService.recordDisposition).not.toHaveBeenCalled();
  });

  it("applies reviewed inventory treatment with the authenticated actor", async () => {
    operationService.applyInventoryTreatment.mockResolvedValue({
      commandType: "apply_inventory_treatment",
      caseId: 42,
      caseNumber: "RET-0000000042",
      inventoryTreatmentId: 101,
      lines: [{
        dispositionItemId: 91,
        returnCaseItemId: 9,
        productVariantId: 301,
        treatment: "restock_sellable",
        quantity: 2,
        warehouseLocationId: 17,
        inventoryTransactionId: 401,
        inventoryLotId: 501,
      }],
      inventoryTreatmentSummary: {
        dispositionUnits: 2,
        appliedUnits: 2,
        remainingUnits: 0,
        fullyApplied: true,
        partiallyApplied: false,
        items: [{
          dispositionItemId: 91,
          returnCaseItemId: 9,
          treatment: "restock_sellable",
          quantity: 2,
          warehouseLocationId: 17,
          inventoryTransactionId: 401,
          inventoryLotId: 501,
          applied: true,
        }],
      },
      appliedAt: "2026-08-23T16:00:00.000Z",
      replayed: false,
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/inventory-treatments`, {
      method: "POST",
      body: {
        idempotencyKey: " treatment-command-1 ",
        notes: " received sellable ",
        lines: [{
          dispositionItemId: 91,
          expectedTreatment: "restock_sellable",
          expectedQuantity: 2,
          warehouseLocationId: 17,
        }],
      },
    });

    expect(response.status).toBe(201);
    expect(operationService.applyInventoryTreatment).toHaveBeenCalledWith({
      caseId: 42,
      idempotencyKey: "treatment-command-1",
      notes: "received sellable",
      lines: [{
        dispositionItemId: 91,
        expectedTreatment: "restock_sellable",
        expectedQuantity: 2,
        warehouseLocationId: 17,
      }],
      actor: "user:7",
    });
  });

  it("returns 200 for an inventory treatment replay", async () => {
    operationService.applyInventoryTreatment.mockResolvedValue({
      commandType: "apply_inventory_treatment",
      caseId: 42,
      caseNumber: "RET-0000000042",
      inventoryTreatmentId: 101,
      lines: [],
      inventoryTreatmentSummary: {
        dispositionUnits: 1,
        appliedUnits: 1,
        remainingUnits: 0,
        fullyApplied: true,
        partiallyApplied: false,
        items: [],
      },
      appliedAt: "2026-08-23T16:00:00.000Z",
      replayed: true,
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/inventory-treatments`, {
      method: "POST",
      body: {
        idempotencyKey: "treatment-replay",
        notes: null,
        lines: [{
          dispositionItemId: 91,
          expectedTreatment: "hold_non_sellable",
          expectedQuantity: 1,
          warehouseLocationId: null,
        }],
      },
    });

    expect(response.status).toBe(200);
  });

  it.each([
    { name: "missing reviewed treatment", line: { dispositionItemId: 91, expectedQuantity: 1, warehouseLocationId: null } },
    { name: "invalid quantity", line: { dispositionItemId: 91, expectedTreatment: "hold_non_sellable", expectedQuantity: 0, warehouseLocationId: null } },
    { name: "forged actor", line: { dispositionItemId: 91, expectedTreatment: "hold_non_sellable", expectedQuantity: 1, warehouseLocationId: null }, extra: { actor: "user:999" } },
  ])("strictly rejects $name before inventory treatment service calls", async ({ line, extra }) => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/inventory-treatments`, {
      method: "POST",
      body: { idempotencyKey: "treatment-invalid", notes: null, lines: [line], ...extra },
    });

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(operationService.applyInventoryTreatment).not.toHaveBeenCalled();
  });

  it("preserves classified inventory treatment conflicts", async () => {
    operationService.applyInventoryTreatment.mockRejectedValue(new ReturnCaseOperationError(
      "RETURN_INVENTORY_TREATMENT_STATE_STALE",
      "The recorded disposition changed after this return was reviewed.",
      409,
      { caseId: 42, dispositionItemId: 91 },
    ));

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/inventory-treatments`, {
      method: "POST",
      body: { idempotencyKey: "treatment-conflict", notes: null, lines: [{ dispositionItemId: 91, expectedTreatment: "hold_non_sellable", expectedQuantity: 1, warehouseLocationId: null }] },
    });

    expect(response).toEqual({ status: 409, body: { error: {
      code: "RETURN_INVENTORY_TREATMENT_STATE_STALE",
      message: "The recorded disposition changed after this return was reviewed.",
      context: { caseId: 42, dispositionItemId: 91 },
    } } });
  });

  it("returns 200 for receipt and inspection command replays", async () => {
    operationService.recordReceipt.mockResolvedValue({
      commandType: "record_receipt",
      caseId: 42,
      caseNumber: "RET-0000000042",
      wmsReturnId: 72,
      logisticsStatus: "partially_received",
      expectedUnits: 2,
      receivedUnits: 1,
      remainingUnits: 1,
      replayed: true,
    });
    operationService.startInspection.mockResolvedValue({
      commandType: "start_inspection",
      caseId: 42,
      caseNumber: "RET-0000000042",
      inspectionId: 81,
      inspectionStatus: "in_progress",
      startedAt: "2026-08-22T16:00:00.000Z",
      replayed: true,
    });

    const receipt = await jsonRequest(`${server.url}/api/returns/admin/cases/42/receipt`, {
      method: "POST",
      body: {
        idempotencyKey: "receipt-command-1",
        notes: null,
        lines: [{ returnCaseItemId: 9, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 }],
      },
    });
    const inspection = await jsonRequest(`${server.url}/api/returns/admin/cases/42/inspections/start`, {
      method: "POST",
      body: { idempotencyKey: "inspection-command-1", notes: null },
    });

    expect(receipt.status).toBe(200);
    expect(inspection.status).toBe(200);
  });

  it("strictly rejects malformed operation bodies before service calls", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/receipt`, {
      method: "POST",
      body: {
        idempotencyKey: "receipt-command-1",
        notes: null,
        actor: "forged-actor",
        lines: [{ returnCaseItemId: 9, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 0 }],
      },
    });

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: "RETURN_CASE_QUERY_INVALID" } },
    });
    expect(operationService.recordReceipt).not.toHaveBeenCalled();
  });

  it("requires the reviewed current quantity on every receipt line", async () => {
    const response = await jsonRequest(server.url + "/api/returns/admin/cases/42/receipt", {
      method: "POST",
      body: {
        idempotencyKey: "receipt-command-without-current",
        notes: null,
        lines: [{ returnCaseItemId: 9, quantityReceivedNow: 1 }],
      },
    });

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: "RETURN_CASE_QUERY_INVALID" } },
    });
    expect(operationService.recordReceipt).not.toHaveBeenCalled();
  });

  it("requires an authenticated actor for return operations", async () => {
    await server.close();
    server = await startServer(buildApp(service, openService, operationService, financialService, null));

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/receipt`, {
      method: "POST",
      body: {
        idempotencyKey: "receipt-command-1",
        notes: null,
        lines: [{ returnCaseItemId: 9, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 }],
      },
    });

    expect(response).toMatchObject({
      status: 401,
      body: { error: { code: "RETURN_CASE_ACTOR_REQUIRED" } },
    });
    expect(operationService.recordReceipt).not.toHaveBeenCalled();
  });

  it("preserves classified return-operation conflicts", async () => {
    operationService.startInspection.mockRejectedValue(new ReturnCaseOperationError(
      "RETURN_CASE_INSPECTION_NOT_AVAILABLE",
      "Inspection cannot start from the current state.",
      409,
      { caseId: 42 },
    ));

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/inspections/start`, {
      method: "POST",
      body: { idempotencyKey: "inspection-command-1", notes: null },
    });

    expect(response).toEqual({
      status: 409,
      body: {
        error: {
          code: "RETURN_CASE_INSPECTION_NOT_AVAILABLE",
          message: "Inspection cannot start from the current state.",
          context: { caseId: 42 },
        },
      },
    });
  });

  it("previews the exact Shopify customer refund with orders edit permission", async () => {
    financialService.previewCustomerRefund.mockResolvedValue({
      commandType: "issue_customer_refund",
      caseId: 42,
      caseNumber: "RET-0000000042",
      externalOrderId: "1001",
      quoteHash: "a".repeat(64),
      quote: {
        provider: "shopify",
        currency: "USD",
        amountCents: 525,
        maximumRefundableCents: 525,
        lines: [{ returnCaseItemId: 9, externalLineItemId: "2001", quantity: 1, subtotalCents: 495, taxCents: 30, totalCents: 525 }],
        transactions: [{ position: 0, parentTransactionId: "gid://shopify/OrderTransaction/3001", gateway: "shopify_payments", amountCents: 525 }],
      },
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/customer-refund-preview`);

    expect(response).toMatchObject({ status: 200, body: { caseId: 42, quoteHash: "a".repeat(64) } });
    expect(financialService.previewCustomerRefund).toHaveBeenCalledWith(42);
    expect(requirePermissionMock).toHaveBeenCalledWith("orders", "edit");
  });

  it("issues a customer refund with strict input and the authenticated actor", async () => {
    financialService.issueCustomerRefund.mockResolvedValue({
      commandType: "issue_customer_refund",
      caseId: 42,
      caseNumber: "RET-0000000042",
      customerRefundId: 71,
      provider: "shopify",
      providerRefundId: "gid://shopify/Refund/4001",
      currency: "USD",
      amountCents: 525,
      completedAt: "2026-08-23T13:00:00.000Z",
      replayed: false,
    });

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/customer-refunds`, {
      method: "POST",
      body: {
        idempotencyKey: " customer-refund-command-1 ",
        quoteHash: "a".repeat(64),
        notifyCustomer: true,
        notes: " approved return ",
      },
    });

    expect(response.status).toBe(201);
    expect(financialService.issueCustomerRefund).toHaveBeenCalledWith({
      caseId: 42,
      idempotencyKey: "customer-refund-command-1",
      quoteHash: "a".repeat(64),
      notifyCustomer: true,
      notes: "approved return",
      actor: "user:7",
    });
  });

  it("previews and posts a dropship vendor settlement without marketplace-buyer data", async () => {
    financialService.previewVendorSettlement.mockResolvedValue({
      commandType: "settle_vendor_account",
      caseId: 42,
      caseNumber: "RET-0000000042",
      vendorId: 8,
      quoteHash: "b".repeat(64),
      quote: {
        currency: "USD",
        faultCategory: "vendor",
        returnShippingActualCents: 300,
        settlement: {
          productCreditCents: 2_000,
          originalShippingCreditCents: 500,
          restockingFeeCents: 0,
          processingFeeCents: 0,
          returnShippingFeeCents: 300,
          grossCreditCents: 2_500,
          totalFeeCents: 300,
          netSettlementCents: 2_200,
        },
        policyFeeIds: { restockingFeeId: null, processingFeeId: null, returnShippingFeeId: 5 },
      },
    });
    financialService.settleVendorAccount.mockResolvedValue({
      commandType: "settle_vendor_account",
      caseId: 42,
      caseNumber: "RET-0000000042",
      vendorSettlementId: 19,
      vendorId: 8,
      currency: "USD",
      grossCreditCents: 2_500,
      totalFeeCents: 300,
      netSettlementCents: 2_200,
      walletLedgerIds: [91, 92],
      settledAt: "2026-08-23T14:00:00.000Z",
      replayed: false,
    });

    const preview = await jsonRequest(`${server.url}/api/returns/admin/cases/42/vendor-settlement-preview`, {
      method: "POST",
      body: { faultCategory: "vendor" },
    });
    const result = await jsonRequest(`${server.url}/api/returns/admin/cases/42/vendor-settlements`, {
      method: "POST",
      body: {
        idempotencyKey: " vendor-settlement-command-1 ",
        quoteHash: "b".repeat(64),
        faultCategory: "vendor",
        notes: null,
      },
    });

    expect(preview.status).toBe(200);
    expect(financialService.previewVendorSettlement).toHaveBeenCalledWith({ caseId: 42, faultCategory: "vendor" });
    expect(result.status).toBe(201);
    expect(financialService.settleVendorAccount).toHaveBeenCalledWith({
      caseId: 42,
      idempotencyKey: "vendor-settlement-command-1",
      quoteHash: "b".repeat(64),
      faultCategory: "vendor",
      notes: null,
      actor: "user:7",
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("dropship", "manage_operations");
  });

  it("rejects malformed financial requests before provider or wallet calls", async () => {
    const customer = await jsonRequest(`${server.url}/api/returns/admin/cases/42/customer-refunds`, {
      method: "POST",
      body: { idempotencyKey: "refund-1", quoteHash: "not-a-hash", notifyCustomer: true, notes: null },
    });
    const vendor = await jsonRequest(`${server.url}/api/returns/admin/cases/42/vendor-settlements`, {
      method: "POST",
      body: { idempotencyKey: "settle-1", quoteHash: "b".repeat(64), faultCategory: "made_up", notes: null },
    });

    expect(customer).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(vendor).toMatchObject({ status: 400, body: { error: { code: "RETURN_CASE_QUERY_INVALID" } } });
    expect(financialService.issueCustomerRefund).not.toHaveBeenCalled();
    expect(financialService.settleVendorAccount).not.toHaveBeenCalled();
  });

  it("preserves classified financial conflicts", async () => {
    financialService.previewCustomerRefund.mockRejectedValue(new ReturnCaseFinancialError(
      "RETURN_CUSTOMER_REFUND_NOT_OWNED",
      "Echelon does not own this buyer refund.",
      409,
      { caseId: 42 },
    ));

    const response = await jsonRequest(`${server.url}/api/returns/admin/cases/42/customer-refund-preview`);

    expect(response).toEqual({
      status: 409,
      body: { error: { code: "RETURN_CUSTOMER_REFUND_NOT_OWNED", message: "Echelon does not own this buyer refund.", context: { caseId: 42 } } },
    });
  });

  it("requires inventory adjust permission for all operation routes", () => {
    const adjustCalls = requirePermissionMock.mock.calls.filter(
      ([resource, action]) => resource === "inventory" && action === "adjust",
    );
    expect(adjustCalls).toEqual([
      ["inventory", "adjust"],
      ["inventory", "adjust"],
      ["inventory", "adjust"],
      ["inventory", "adjust"],
      ["inventory", "adjust"],
    ]);
  });
});

function fakeService() {
  return { list: vi.fn(), getById: vi.fn() };
}

function fakeOpenService() {
  return { searchSourceOrders: vi.fn(), getSourceOrder: vi.fn(), open: vi.fn() };
}

function fakeOperationService() {
  return {
    recordReceipt: vi.fn(),
    startInspection: vi.fn(),
    completeInspection: vi.fn(),
    recordDisposition: vi.fn(),
    applyInventoryTreatment: vi.fn(),
  };
}

function fakeFinancialService() {
  return {
    previewCustomerRefund: vi.fn(),
    issueCustomerRefund: vi.fn(),
    previewVendorSettlement: vi.fn(),
    settleVendorAccount: vi.fn(),
  };
}

function buildApp(
  service: ReturnType<typeof fakeService>,
  openService: ReturnType<typeof fakeOpenService>,
  operationService: ReturnType<typeof fakeOperationService>,
  financialService: ReturnType<typeof fakeFinancialService>,
  userId: number | null = 7,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user?: { id: number } } }).session = userId === null
      ? { user: undefined }
      : { user: { id: userId } };
    next();
  });
  registerReturnCaseAdminRoutes(
    app,
    service as unknown as ReturnCaseAdminService,
    openService as unknown as OpenReturnCaseService,
    operationService as unknown as ReturnCaseOperationService,
    financialService as unknown as ReturnCaseFinancialService,
  );
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(
  url: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const target = new URL(url);
  const rawRequestBody = options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "GET",
      headers: rawRequestBody === null ? undefined : {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(rawRequestBody),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: rawBody === "" ? {} : JSON.parse(rawBody) as Record<string, any>,
        });
      });
    });
    request.on("error", reject);
    if (rawRequestBody !== null) request.write(rawRequestBody);
    request.end();
  });
}
