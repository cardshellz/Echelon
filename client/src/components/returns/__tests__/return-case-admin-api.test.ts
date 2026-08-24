import { describe, expect, it, vi } from "vitest";

import {
  ReturnCaseAdminApiError,
  applyReturnInventoryTreatment,
  completeReturnInspection,
  getCustomerRefundPreview,
  getReturnCaseDetail,
  getReturnVariantBinAssignments,
  getReturnWarehouseLocations,
  getVendorSettlementPreview,
  issueReturnCustomerRefund,
  recordReturnDisposition,
  recordReturnReceipt,
  settleReturnVendorAccount,
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
      productVariantId: 901,
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

  it("posts and strictly validates a direct complete-inspection result", async () => {
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse({
      commandType: "complete_inspection",
      caseId: 42,
      caseNumber: "RET-0000000042",
      inspectionId: 91,
      inspectionStatus: "approved",
      completedAt: "2026-08-22T15:00:00.000Z",
      replayed: false,
    }));

    const result = await completeReturnInspection(42, 91, {
      idempotencyKey: " completion-command-1 ",
      outcome: "approved",
      notes: " seal intact ",
    }, transport);

    expect(result).toMatchObject({
      commandType: "complete_inspection",
      inspectionId: 91,
      inspectionStatus: "approved",
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("/api/returns/admin/cases/42/inspections/91/complete");
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotencyKey: "completion-command-1",
      outcome: "approved",
      notes: "seal intact",
    });
  });
  it("normalizes, orders, and strictly validates a disposition command", async () => {
    const transport = vi.fn<ReturnCaseAdminTransport>(async () =>
      jsonResponse(dispositionResultFixture()),
    );

    const result = await recordReturnDisposition(42, {
      idempotencyKey: " disposition-command-1 ",
      inspectionId: null,
      notes: " seal intact ",
      lines: [
        {
          returnCaseItemId: 12,
          quantity: 1,
          treatment: "hold_non_sellable",
          expectedCurrentReceivedQuantity: 2,
          expectedCurrentDisposedQuantity: 0,
        },
        {
          returnCaseItemId: 11,
          quantity: 1,
          treatment: "restock_sellable",
          expectedCurrentReceivedQuantity: 1,
          expectedCurrentDisposedQuantity: 0,
        },
      ],
    }, transport);

    expect(result).toMatchObject({
      commandType: "record_disposition",
      caseId: 42,
      inspectionId: null,
      inspectionResolution: "not_required",
      dispositionSummary: { recordedUnits: 2, remainingUnits: 1 },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("/api/returns/admin/cases/42/dispositions");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotencyKey: "disposition-command-1",
      inspectionId: null,
      notes: "seal intact",
      lines: [
        {
          returnCaseItemId: 11,
          quantity: 1,
          treatment: "restock_sellable",
          expectedCurrentReceivedQuantity: 1,
          expectedCurrentDisposedQuantity: 0,
        },
        {
          returnCaseItemId: 12,
          quantity: 1,
          treatment: "hold_non_sellable",
          expectedCurrentReceivedQuantity: 2,
          expectedCurrentDisposedQuantity: 0,
        },
      ],
    });
  });

  it("rejects a disposition response for a different return case", async () => {
    const fixture = dispositionResultFixture();
    fixture.caseId = 43;
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    await expect(recordReturnDisposition(42, {
      idempotencyKey: "disposition-command-identity",
      inspectionId: null,
      lines: [{
        returnCaseItemId: 11,
        quantity: 1,
        treatment: "restock_sellable",
        expectedCurrentReceivedQuantity: 1,
        expectedCurrentDisposedQuantity: 0,
      }],
    }, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
      context: {
        issues: expect.arrayContaining([expect.objectContaining({ path: "caseId" })]),
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects a disposition response for a different reviewed inspection", async () => {
    const fixture = dispositionResultFixture();
    fixture.inspectionId = 91;
    fixture.inspectionResolution = "approved";
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    await expect(recordReturnDisposition(42, {
      idempotencyKey: "disposition-command-inspection-identity",
      inspectionId: 92,
      lines: [
        {
          returnCaseItemId: 12,
          quantity: 1,
          treatment: "hold_non_sellable",
          expectedCurrentReceivedQuantity: 2,
          expectedCurrentDisposedQuantity: 0,
        },
        {
          returnCaseItemId: 11,
          quantity: 1,
          treatment: "restock_sellable",
          expectedCurrentReceivedQuantity: 1,
          expectedCurrentDisposedQuantity: 0,
        },
      ],
    }, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
      context: {
        issues: expect.arrayContaining([expect.objectContaining({ path: "inspectionId" })]),
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects a disposition summary that differs from submitted optimistic quantities", async () => {
    const fixture = dispositionResultFixture();
    fixture.lines = [{
      returnCaseItemId: 11,
      quantity: 1,
      treatment: "restock_sellable",
    }];
    fixture.dispositionSummary.receivedUnits = 4;
    fixture.dispositionSummary.remainingUnits = 2;
    fixture.dispositionSummary.items[0].receivedQuantity = 2;
    fixture.dispositionSummary.items[0].remainingQuantity = 1;
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    await expect(recordReturnDisposition(42, {
      idempotencyKey: "disposition-command-summary-identity",
      inspectionId: null,
      lines: [{
        returnCaseItemId: 11,
        quantity: 1,
        treatment: "restock_sellable",
        expectedCurrentReceivedQuantity: 1,
        expectedCurrentDisposedQuantity: 0,
      }],
    }, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
      context: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "dispositionSummary.items" }),
        ]),
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });


  it("rejects disposition response lines that differ from the submitted command", async () => {
    const fixture = dispositionResultFixture();
    fixture.lines = [{
      returnCaseItemId: 11,
      quantity: 2,
      treatment: "restock_sellable",
    }];
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    await expect(recordReturnDisposition(42, {
      idempotencyKey: "disposition-command-line-identity",
      inspectionId: null,
      lines: [{
        returnCaseItemId: 11,
        quantity: 1,
        treatment: "restock_sellable",
        expectedCurrentReceivedQuantity: 1,
        expectedCurrentDisposedQuantity: 0,
      }],
    }, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
      context: {
        issues: expect.arrayContaining([expect.objectContaining({ path: "lines.0" })]),
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });


  it.each([
    { name: "case", caseId: 43, inspectionId: 91, expectedPath: "caseId" },
    { name: "inspection", caseId: 42, inspectionId: 92, expectedPath: "inspectionId" },
  ])("rejects a completion response for a different $name identity", async ({ caseId, inspectionId, expectedPath }) => {
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse({
      commandType: "complete_inspection",
      caseId,
      caseNumber: "RET-0000000042",
      inspectionId,
      inspectionStatus: "approved",
      completedAt: "2026-08-22T15:00:00.000Z",
      replayed: false,
    }));

    await expect(completeReturnInspection(42, 91, {
      idempotencyKey: "completion-command-identity",
      outcome: "approved",
    }, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
      context: {
        issues: expect.arrayContaining([expect.objectContaining({ path: expectedPath })]),
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
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
      name: "duplicate disposition line",
      execute: (transport: ReturnCaseAdminTransport) => recordReturnDisposition(42, {
        idempotencyKey: "disposition-command-duplicate",
        inspectionId: null,
        lines: [
          {
            returnCaseItemId: 11,
            quantity: 1,
            treatment: "restock_sellable",
            expectedCurrentReceivedQuantity: 1,
            expectedCurrentDisposedQuantity: 0,
          },
          {
            returnCaseItemId: 11,
            quantity: 1,
            treatment: "hold_non_sellable",
            expectedCurrentReceivedQuantity: 1,
            expectedCurrentDisposedQuantity: 0,
          },
        ],
      }, transport),
    },
    {
      name: "unknown outbound field",
      execute: (transport: ReturnCaseAdminTransport) => startReturnInspection(42, {
        idempotencyKey: "inspection-command-1",
        unexpected: true,
      } as never, transport),
    },
    {
      name: "invalid inspection id",
      execute: (transport: ReturnCaseAdminTransport) => completeReturnInspection(42, 0, {
        idempotencyKey: "completion-command-1",
        outcome: "approved",
      }, transport),
    },
    {
      name: "invalid completion outcome",
      execute: (transport: ReturnCaseAdminTransport) => completeReturnInspection(42, 91, {
        idempotencyKey: "completion-command-1",
        outcome: "damaged",
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

  it("rejects an available completion action without exact active-inspection evidence", async () => {
    const fixture = detailFixture();
    fixture.actionPlan = {
      nextAction: "complete_inspection",
      receiptSummary: {
        expectedUnits: 5,
        receivedUnits: 5,
        remainingUnits: 0,
        fullyReceived: true,
        partiallyReceived: false,
      },
      inspectionSummary: null,
      actions: [{
        kind: "complete_inspection",
        label: "Complete inspection",
        description: "Record the final inspection outcome.",
        state: "available",
        reasonCode: null,
      }],
    } as never;
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    await expect(getReturnCaseDetail(42, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects a server action plan that omits a required action kind", async () => {
    const fixture = detailFixture();
    fixture.actionPlan.actions = fixture.actionPlan.actions.filter(
      (action) => action.kind !== "record_disposition",
    );
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    await expect(getReturnCaseDetail(42, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("accepts an empty disposition summary only for the explicit evidence-conflict blocker", async () => {
    const fixture = detailFixture();
    fixture.actionPlan.dispositionSummary = {
      receivedUnits: 0,
      recordedUnits: 0,
      remainingUnits: 0,
      fullyRecorded: false,
      partiallyRecorded: false,
      items: [],
    };
    const dispositionAction = fixture.actionPlan.actions.find(
      (action) => action.kind === "record_disposition",
    );
    if (!dispositionAction) throw new Error("Disposition action fixture is missing.");
    dispositionAction.state = "blocked";
    dispositionAction.reasonCode = "RETURN_DISPOSITION_STATE_CONFLICT";
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    const detail = await getReturnCaseDetail(42, transport);

    expect(detail.actionPlan.dispositionSummary.items).toEqual([]);
    expect(detail.actionPlan.actions.find(
      (action) => action.kind === "record_disposition",
    )).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_DISPOSITION_STATE_CONFLICT",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty disposition summary without the exact evidence-conflict blocker", async () => {
    const fixture = detailFixture();
    fixture.actionPlan.dispositionSummary = {
      receivedUnits: 0,
      recordedUnits: 0,
      remainingUnits: 0,
      fullyRecorded: false,
      partiallyRecorded: false,
      items: [],
    };
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    await expect(getReturnCaseDetail(42, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
      context: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "actionPlan.dispositionSummary.items",
          }),
        ]),
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });




  it("accepts a strict in-progress inspection summary from the action plan", async () => {
    const fixture = detailFixture();
    fixture.actionPlan.inspectionSummary = {
      inspectionId: 91,
      status: "in_progress",
      startedAt: "2026-08-22T14:30:00.000Z",
      startedBy: "user:7",
      completedAt: null,
      completedBy: null,
    };
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    const detail = await getReturnCaseDetail(42, transport);

    expect(detail.actionPlan.inspectionSummary).toMatchObject({
      inspectionId: 91,
      status: "in_progress",
      completedAt: null,
      completedBy: null,
    });
  });

  it("rejects a terminal inspection summary with incomplete completion evidence", async () => {
    const fixture = detailFixture();
    fixture.actionPlan.inspectionSummary = {
      inspectionId: 91,
      status: "approved",
      startedAt: "2026-08-22T14:30:00.000Z",
      startedBy: "user:7",
      completedAt: "2026-08-22T15:00:00.000Z",
      completedBy: null,
    };
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    await expect(getReturnCaseDetail(42, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects completion evidence dated before the inspection started", async () => {
    const fixture = detailFixture();
    fixture.actionPlan.inspectionSummary = {
      inspectionId: 91,
      status: "rejected",
      startedAt: "2026-08-22T14:30:00.000Z",
      startedBy: "user:7",
      completedAt: "2026-08-22T14:29:59.999Z",
      completedBy: "user:9",
    };
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    await expect(getReturnCaseDetail(42, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
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
  it("rejects a disposition summary whose received evidence differs from the return item", async () => {
    const fixture = detailFixture();
    fixture.actionPlan.dispositionSummary.receivedUnits = 2;
    fixture.actionPlan.dispositionSummary.remainingUnits = 2;
    fixture.actionPlan.dispositionSummary.items[0].receivedQuantity = 2;
    fixture.actionPlan.dispositionSummary.items[0].remainingQuantity = 2;
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(fixture));

    await expect(getReturnCaseDetail(42, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
      context: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "actionPlan.dispositionSummary.items.0.receivedQuantity",
          }),
        ]),
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("normalizes, sorts, and strictly correlates an inventory treatment command", async () => {
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(inventoryTreatmentResultFixture()));

    const result = await applyReturnInventoryTreatment(42, {
      idempotencyKey: " treatment-key ",
      notes: " putaway evidence ",
      lines: [
        { dispositionItemId: 92, expectedTreatment: "hold_non_sellable", expectedQuantity: 1, warehouseLocationId: null },
        { dispositionItemId: 91, expectedTreatment: "restock_sellable", expectedQuantity: 2, warehouseLocationId: 17 },
      ],
    }, transport);

    expect(result.inventoryTreatmentSummary).toMatchObject({ appliedUnits: 3, remainingUnits: 0 });
    expect(transport).toHaveBeenCalledWith(
      "/api/returns/admin/cases/42/inventory-treatments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "treatment-key",
          notes: "putaway evidence",
          lines: [
            { dispositionItemId: 91, expectedTreatment: "restock_sellable", expectedQuantity: 2, warehouseLocationId: 17 },
            { dispositionItemId: 92, expectedTreatment: "hold_non_sellable", expectedQuantity: 1, warehouseLocationId: null },
          ],
        }),
      }),
    );
  });

  it("rejects incoherent or uncorrelated inventory treatment success evidence", async () => {
    const wrongCase = inventoryTreatmentResultFixture();
    wrongCase.caseId = 43;
    const wrongCaseTransport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(wrongCase));
    const input = {
      idempotencyKey: "treatment-key",
      notes: null,
      lines: [
        { dispositionItemId: 91, expectedTreatment: "restock_sellable" as const, expectedQuantity: 2, warehouseLocationId: 17 },
        { dispositionItemId: 92, expectedTreatment: "hold_non_sellable" as const, expectedQuantity: 1, warehouseLocationId: null },
      ],
    };

    await expect(applyReturnInventoryTreatment(42, input, wrongCaseTransport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
    });

    const incoherent = inventoryTreatmentResultFixture();
    incoherent.lines[0].inventoryTransactionId = null;
    const incoherentTransport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(incoherent));
    await expect(applyReturnInventoryTreatment(42, input, incoherentTransport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
      status: 200,
    });
  });

  it("rejects duplicate sources and treatment/location mismatches before transport", async () => {
    const transport = vi.fn<ReturnCaseAdminTransport>();
    const duplicate = {
      idempotencyKey: "treatment-key",
      notes: null,
      lines: [
        { dispositionItemId: 91, expectedTreatment: "restock_sellable" as const, expectedQuantity: 2, warehouseLocationId: 17 },
        { dispositionItemId: 91, expectedTreatment: "restock_sellable" as const, expectedQuantity: 2, warehouseLocationId: 17 },
      ],
    };

    await expect(applyReturnInventoryTreatment(42, duplicate, transport)).rejects.toMatchObject({
      code: "RETURN_CASE_CLIENT_INPUT_INVALID",
    });
    await expect(applyReturnInventoryTreatment(42, {
      idempotencyKey: "treatment-key",
      notes: null,
      lines: [{ dispositionItemId: 91, expectedTreatment: "hold_non_sellable", expectedQuantity: 1, warehouseLocationId: 17 }],
    }, transport)).rejects.toMatchObject({ code: "RETURN_CASE_CLIENT_INPUT_INVALID" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("loads and validates warehouse locations with one read-only request", async () => {
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse([{
      id: 17,
      code: "A-01",
      name: "Primary",
      warehouseId: 3,
      isActive: 1,
      isPickable: 1,
      cycleCountFreezeId: null,
      extraProviderField: true,
    }]));

    await expect(getReturnWarehouseLocations(transport)).resolves.toMatchObject([{ id: 17, code: "A-01" }]);
    expect(transport).toHaveBeenCalledWith("/api/warehouse/locations", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });

    const malformed = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse([{
      id: 17, code: "A-01", name: null, warehouseId: 3, isActive: 1, isPickable: 2, cycleCountFreezeId: null,
    }]));
    await expect(getReturnWarehouseLocations(malformed)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
    });
  });

  it("loads exact bin assignments with normalized product variant IDs", async () => {
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse([{
      productVariantId: 11,
      assignedLocationCode: "P-01",
      assignedLocationId: 17,
      slotStatus: "valid",
      slotIssue: null,
      assignmentCount: 1,
      validAssignmentCount: 1,
      extraViewField: true,
    }]));

    await expect(getReturnVariantBinAssignments([33, 11, 33], transport)).resolves.toMatchObject([
      { productVariantId: 11, assignedLocationId: 17, slotStatus: "valid" },
    ]);
    expect(transport).toHaveBeenCalledWith("/api/bin-assignments?variantIds=11,33", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  });

  it("rejects invalid slot requests and unrequested assignment rows", async () => {
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse([{
      productVariantId: 99,
      assignedLocationCode: null,
      assignedLocationId: null,
      slotStatus: "unassigned",
      slotIssue: null,
      assignmentCount: 0,
      validAssignmentCount: 0,
    }]));

    await expect(getReturnVariantBinAssignments([], transport)).rejects.toMatchObject({
      code: "RETURN_CASE_CLIENT_INPUT_INVALID",
    });
    expect(transport).not.toHaveBeenCalled();
    await expect(getReturnVariantBinAssignments([11], transport)).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
    });
  });

  it("loads and strictly correlates an exact Shopify customer-refund preview", async () => {
    const preview = {
      commandType: "issue_customer_refund" as const,
      caseId: 42,
      caseNumber: "RET-0000000042",
      externalOrderId: "1001",
      externalOrderNumber: "#61694",
      quoteHash: "a".repeat(64),
      quote: {
        provider: "shopify" as const,
        currency: "USD",
        amountCents: 525,
        maximumRefundableCents: 525,
        lines: [{ returnCaseItemId: 9, externalLineItemId: "2001", quantity: 1, subtotalCents: 495, taxCents: 30, totalCents: 525 }],
        transactions: [{ position: 0, parentTransactionId: "gid://shopify/OrderTransaction/3001", gateway: "shopify_payments", amountCents: 525 }],
      },
    };
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(preview));

    await expect(getCustomerRefundPreview(42, transport)).resolves.toEqual(preview);
    expect(transport).toHaveBeenCalledWith(
      "/api/returns/admin/cases/42/customer-refund-preview",
      { method: "GET", credentials: "include", headers: { Accept: "application/json" } },
    );

    const wrongCase = { ...preview, caseId: 43 };
    await expect(getCustomerRefundPreview(
      42,
      vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(wrongCase)),
    )).rejects.toMatchObject({ code: "RETURN_CASE_RESPONSE_INVALID" });
  });

  it("normalizes and strictly correlates a Shopify customer-refund command", async () => {
    const response = {
      commandType: "issue_customer_refund" as const,
      caseId: 42,
      caseNumber: "RET-0000000042",
      customerRefundId: 71,
      provider: "shopify" as const,
      providerRefundId: "gid://shopify/Refund/4001",
      currency: "USD",
      amountCents: 525,
      completedAt: "2026-08-23T13:00:00.000Z",
      replayed: false,
    };
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(response));

    await expect(issueReturnCustomerRefund(42, {
      idempotencyKey: " refund-command-1 ",
      quoteHash: "a".repeat(64),
      notifyCustomer: true,
      notes: " approved return ",
    }, transport)).resolves.toEqual(response);
    expect(transport).toHaveBeenCalledWith(
      "/api/returns/admin/cases/42/customer-refunds",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "refund-command-1",
          quoteHash: "a".repeat(64),
          notifyCustomer: true,
          notes: "approved return",
        }),
      }),
    );

    await expect(issueReturnCustomerRefund(42, {
      idempotencyKey: "refund-command-2",
      quoteHash: "a".repeat(64),
      notifyCustomer: false,
      notes: null,
    }, vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse({ ...response, caseId: 43 })))).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
    });
  });

  it("posts and correlates a fault-specific vendor settlement preview", async () => {
    const preview = {
      commandType: "settle_vendor_account" as const,
      caseId: 42,
      caseNumber: "RET-0000000042",
      vendorId: 8,
      quoteHash: "b".repeat(64),
      quote: {
        currency: "USD",
        faultCategory: "vendor" as const,
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
          creditLedgerType: "return_credit" as const,
          breakdown: {},
        },
        policyFeeIds: { restockingFeeId: null, processingFeeId: null, returnShippingFeeId: 5 },
      },
    };
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(preview));

    await expect(getVendorSettlementPreview(42, "vendor", transport)).resolves.toEqual(preview);
    expect(transport).toHaveBeenCalledWith(
      "/api/returns/admin/cases/42/vendor-settlement-preview",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ faultCategory: "vendor" }) }),
    );

    const wrongFault = { ...preview, quote: { ...preview.quote, faultCategory: "carrier" as const } };
    await expect(getVendorSettlementPreview(
      42,
      "vendor",
      vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(wrongFault)),
    )).rejects.toMatchObject({ code: "RETURN_CASE_RESPONSE_INVALID" });
  });

  it("normalizes and strictly correlates an internal vendor-wallet settlement command", async () => {
    const response = {
      commandType: "settle_vendor_account" as const,
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
    };
    const transport = vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse(response));

    await expect(settleReturnVendorAccount(42, {
      idempotencyKey: " settlement-command-1 ",
      quoteHash: "b".repeat(64),
      faultCategory: "vendor",
      notes: " vendor fault confirmed ",
    }, transport)).resolves.toEqual(response);
    expect(transport).toHaveBeenCalledWith(
      "/api/returns/admin/cases/42/vendor-settlements",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "settlement-command-1",
          quoteHash: "b".repeat(64),
          faultCategory: "vendor",
          notes: "vendor fault confirmed",
        }),
      }),
    );

    await expect(settleReturnVendorAccount(42, {
      idempotencyKey: "settlement-command-2",
      quoteHash: "b".repeat(64),
      faultCategory: "vendor",
      notes: null,
    }, vi.fn<ReturnCaseAdminTransport>(async () => jsonResponse({ ...response, caseId: 43 })))).rejects.toMatchObject({
      code: "RETURN_CASE_RESPONSE_INVALID",
    });
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
        productVariantId: 901,
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
        productVariantId: 902,
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
      inspectionSummary: null,
      dispositionSummary: {
        receivedUnits: 1,
        recordedUnits: 0,
        remainingUnits: 1,
        fullyRecorded: false,
        partiallyRecorded: false,
        items: [
          {
            returnCaseItemId: 11,
            receivedQuantity: 1,
            restockSellableQuantity: 0,
            holdNonSellableQuantity: 0,
            recordedQuantity: 0,
            remainingQuantity: 1,
          },
          {
            returnCaseItemId: 12,
            receivedQuantity: 0,
            restockSellableQuantity: 0,
            holdNonSellableQuantity: 0,
            recordedQuantity: 0,
            remainingQuantity: 0,
          },
        ],
      },
      inventoryTreatmentSummary: {
        dispositionUnits: 0,
        appliedUnits: 0,
        remainingUnits: 0,
        fullyApplied: false,
        partiallyApplied: false,
        items: [],
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
        {
          kind: "complete_inspection" as const,
          label: "Complete inspection",
          description: "Record the final inspection outcome.",
          state: "blocked" as const,
          reasonCode: "RETURN_NOT_FULLY_RECEIVED",
        },
        {
          kind: "record_disposition" as const,
          label: "Resolve returned items",
          description: "Record explicit disposition intent for received items.",
          state: "blocked" as const,
          reasonCode: "RETURN_NOT_FULLY_RECEIVED",
        },
        {
          kind: "apply_inventory_treatment" as const,
          label: "Apply inventory treatment",
          description: "Apply recorded treatment decisions.",
          state: "blocked" as const,
          reasonCode: "RETURN_NOT_FULLY_RECEIVED",
        },
        {
          kind: "issue_customer_refund" as const,
          label: "Issue customer refund",
          description: "Refund the Card Shellz customer through the source Shopify order.",
          state: "blocked" as const,
          reasonCode: "RETURN_INSPECTION_NOT_APPROVED",
        },
        {
          kind: "settle_vendor_account" as const,
          label: "Settle vendor account",
          description: "Post the approved return credit to the dropship vendor's Echelon wallet.",
          state: "not_applicable" as const,
          reasonCode: "RETURN_VENDOR_SETTLEMENT_NOT_APPLICABLE",
        },
      ],
    },
  };
}
function dispositionResultFixture() {
  return {
    commandType: "record_disposition" as const,
    caseId: 42,
    caseNumber: "RET-0000000042",
    dispositionId: 77,
    inspectionId: null,
    inspectionResolution: "not_required" as const,
    lines: [
      {
        returnCaseItemId: 12,
        treatment: "hold_non_sellable" as const,
        quantity: 1,
      },
      {
        returnCaseItemId: 11,
        treatment: "restock_sellable" as const,
        quantity: 1,
      },
    ],
    dispositionSummary: {
      receivedUnits: 3,
      recordedUnits: 2,
      remainingUnits: 1,
      fullyRecorded: false,
      partiallyRecorded: true,
      items: [
        {
          returnCaseItemId: 11,
          receivedQuantity: 1,
          restockSellableQuantity: 1,
          holdNonSellableQuantity: 0,
          recordedQuantity: 1,
          remainingQuantity: 0,
        },
        {
          returnCaseItemId: 12,
          receivedQuantity: 2,
          restockSellableQuantity: 0,
          holdNonSellableQuantity: 1,
          recordedQuantity: 1,
          remainingQuantity: 1,
        },
      ],
    },
    recordedAt: "2026-08-23T12:00:00.000Z",
    replayed: false,
  };
}

function inventoryTreatmentResultFixture() {
  return {
    commandType: "apply_inventory_treatment" as const,
    caseId: 42,
    caseNumber: "RET-0000000042",
    inventoryTreatmentId: 101,
    lines: [
      {
        dispositionItemId: 91,
        returnCaseItemId: 11,
        productVariantId: 301,
        treatment: "restock_sellable" as const,
        quantity: 2,
        warehouseLocationId: 17,
        inventoryTransactionId: 401,
        inventoryLotId: 501,
      },
      {
        dispositionItemId: 92,
        returnCaseItemId: 12,
        productVariantId: null,
        treatment: "hold_non_sellable" as const,
        quantity: 1,
        warehouseLocationId: null,
        inventoryTransactionId: null,
        inventoryLotId: null,
      },
    ],
    inventoryTreatmentSummary: {
      dispositionUnits: 3,
      appliedUnits: 3,
      remainingUnits: 0,
      fullyApplied: true,
      partiallyApplied: false,
      items: [
        { dispositionItemId: 91, returnCaseItemId: 11, treatment: "restock_sellable" as const, quantity: 2, warehouseLocationId: 17, inventoryTransactionId: 401, inventoryLotId: 501, applied: true },
        { dispositionItemId: 92, returnCaseItemId: 12, treatment: "hold_non_sellable" as const, quantity: 1, warehouseLocationId: null, inventoryTransactionId: null, inventoryLotId: null, applied: true },
      ],
    },
    appliedAt: "2026-08-23T16:00:00.000Z",
    replayed: false,
  };
}


function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
