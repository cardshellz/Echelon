import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReturnCaseOperationError,
  ReturnCaseOperationService,
  type ReturnCaseOperationAggregate,
  type ReturnCaseOperationStore,
  type ReturnCaseOperationTransaction,
} from "../../application/return-case-operations.service";

const NOW = new Date("2026-08-22T12:00:00.000Z");

describe("ReturnCaseOperationService", () => {
  let tx: ReturnType<typeof fakeTransaction>;
  let service: ReturnCaseOperationService;

  beforeEach(() => {
    tx = fakeTransaction();
    const store: ReturnCaseOperationStore = {
      transaction: (work) => work(tx as unknown as ReturnCaseOperationTransaction),
    };
    service = new ReturnCaseOperationService(store, () => NOW);
  });

  it("converts receipt deltas to optimistic absolute WMS targets", async () => {
    tx.loadForUpdate.mockResolvedValue(aggregate());
    tx.persistReceipt.mockImplementation(async (input) => ({
      commandType: "record_receipt",
      caseId: input.aggregate.caseId,
      caseNumber: input.aggregate.caseNumber,
      wmsReturnId: input.aggregate.wmsReturnId,
      logisticsStatus: "partially_received",
      expectedUnits: 5,
      receivedUnits: 3,
      remainingUnits: 2,
      replayed: false,
    }));

    const result = await service.recordReceipt({
      caseId: 1,
      idempotencyKey: " receipt-1 ",
      actor: " user:7 ",
      notes: " carton intact ",
      lines: [
        { returnCaseItemId: 2, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 },
        { returnCaseItemId: 1, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 2 },
      ],
    });

    expect(result).toMatchObject({ commandType: "record_receipt", replayed: false });
    expect(tx.lockCommand).toHaveBeenCalledWith("receipt-1");
    expect(tx.persistReceipt).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "receipt-1",
      actor: "user:7",
      notes: "carton intact",
      now: NOW,
      lines: [
        {
          returnCaseItemId: 1,
          wmsReturnItemId: 101,
          expectedCurrentReceivedQuantity: 0,
          targetReceivedQuantity: 2,
        },
        {
          returnCaseItemId: 2,
          wmsReturnItemId: 102,
          expectedCurrentReceivedQuantity: 0,
          targetReceivedQuantity: 1,
        },
      ],
    }));
  });

  it("reads the operation clock only after locked state validation and skips it for replay", async () => {
    const order: string[] = [];
    const clock = vi.fn(() => {
      order.push("clock");
      return NOW;
    });
    const orderedService = new ReturnCaseOperationService({
      transaction: (work) => work(tx as unknown as ReturnCaseOperationTransaction),
    }, clock);
    tx.loadForUpdate.mockImplementation(async () => {
      order.push("state");
      return aggregate();
    });
    tx.persistReceipt.mockImplementation(async (input) => {
      order.push("persist");
      return {
        commandType: "record_receipt",
        caseId: input.aggregate.caseId,
        caseNumber: input.aggregate.caseNumber,
        wmsReturnId: input.aggregate.wmsReturnId,
        logisticsStatus: "partially_received",
        expectedUnits: 5,
        receivedUnits: 1,
        remainingUnits: 4,
        replayed: false,
      };
    });
    const input = {
      caseId: 1,
      idempotencyKey: "receipt-clock-order",
      actor: "user:7",
      notes: null,
      lines: [{ returnCaseItemId: 1, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 }],
    };

    await orderedService.recordReceipt(input);

    expect(order).toEqual(["state", "clock", "persist"]);
    const requestHash = tx.persistReceipt.mock.calls[0][0].requestHash;
    tx.findCommand.mockResolvedValue({
      commandType: "record_receipt",
      requestHash,
      result: {
        commandType: "record_receipt",
        caseId: 1,
        caseNumber: "RET-0000000001",
        wmsReturnId: 230,
        logisticsStatus: "partially_received",
        expectedUnits: 5,
        receivedUnits: 1,
        remainingUnits: 4,
        replayed: false,
      },
    });
    order.length = 0;
    clock.mockClear();
    tx.loadForUpdate.mockClear();
    tx.persistReceipt.mockClear();

    const replay = await orderedService.recordReceipt(input);

    expect(replay.replayed).toBe(true);
    expect(order).toEqual([]);
    expect(clock).not.toHaveBeenCalled();
    expect(tx.loadForUpdate).not.toHaveBeenCalled();
    expect(tx.persistReceipt).not.toHaveBeenCalled();
  });

  it("replays a matching command without locking or mutating the case aggregate", async () => {
    tx.findCommand.mockResolvedValue({
      commandType: "record_receipt",
      requestHash: "ignored",
      result: {
        commandType: "record_receipt",
        caseId: 1,
        caseNumber: "RET-0000000001",
        wmsReturnId: 230,
        logisticsStatus: "received",
        expectedUnits: 5,
        receivedUnits: 5,
        remainingUnits: 0,
        replayed: false,
      },
    });
    // The service compares the stored hash. Capture the deterministic hash from
    // a first attempt without persisting, then replay with the same payload.
    tx.findCommand.mockResolvedValueOnce(null);
    tx.loadForUpdate.mockResolvedValue(aggregate());
    tx.persistReceipt.mockRejectedValueOnce(new Error("capture"));
    const input = {
      caseId: 1,
      idempotencyKey: "receipt-replay",
      actor: "user:7",
      notes: null,
      lines: [{ returnCaseItemId: 1, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 }],
    };
    await expect(service.recordReceipt(input)).rejects.toThrow("capture");
    const requestHash = tx.persistReceipt.mock.calls[0][0].requestHash;
    tx.findCommand.mockResolvedValue({
      commandType: "record_receipt",
      requestHash,
      result: {
        commandType: "record_receipt",
        caseId: 1,
        caseNumber: "RET-0000000001",
        wmsReturnId: 230,
        logisticsStatus: "received",
        expectedUnits: 5,
        receivedUnits: 5,
        remainingUnits: 0,
        replayed: false,
      },
    });
    tx.loadForUpdate.mockClear();
    tx.persistReceipt.mockClear();

    const replay = await service.recordReceipt(input);

    expect(replay.replayed).toBe(true);
    expect(tx.loadForUpdate).not.toHaveBeenCalled();
    expect(tx.persistReceipt).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key for another payload", async () => {
    tx.findCommand.mockResolvedValue({
      commandType: "start_inspection",
      requestHash: "0".repeat(64),
      result: {
        commandType: "start_inspection",
        caseId: 1,
        caseNumber: "RET-0000000001",
        inspectionId: 9,
        inspectionStatus: "in_progress",
        startedAt: NOW.toISOString(),
        replayed: false,
      },
    });

    await expect(service.recordReceipt({
      caseId: 1,
      idempotencyKey: "same-key",
      actor: "user:7",
      notes: null,
      lines: [{ returnCaseItemId: 1, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 }],
    })).rejects.toMatchObject({
      code: "RETURN_CASE_IDEMPOTENCY_CONFLICT",
      status: 409,
    });
  });

  it("rejects over-receipt before invoking the WMS persistence adapter", async () => {
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstExpected: 2,
      firstReceived: 1,
      logisticsStatus: "partially_received",
      wmsStatus: "partially_received",
    }));

    await expect(service.recordReceipt({
      caseId: 1,
      idempotencyKey: "receipt-over",
      actor: "user:7",
      notes: null,
      lines: [{ returnCaseItemId: 1, expectedCurrentReceivedQuantity: 1, quantityReceivedNow: 2 }],
    })).rejects.toMatchObject({
      code: "RETURN_CASE_RECEIPT_QUANTITY_EXCEEDED",
      status: 409,
    });
    expect(tx.persistReceipt).not.toHaveBeenCalled();
  });

  it("rejects stale receipt intent before adding the submitted delta", async () => {
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstExpected: 3,
      firstReceived: 1,
      logisticsStatus: "partially_received",
      wmsStatus: "partially_received",
    }));

    await expect(service.recordReceipt({
      caseId: 1,
      idempotencyKey: "receipt-stale",
      actor: "user:7",
      notes: null,
      lines: [{ returnCaseItemId: 1, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 }],
    })).rejects.toMatchObject({
      code: "RETURN_CASE_RECEIPT_STATE_STALE",
      status: 409,
      context: {
        caseId: 1,
        returnCaseItemId: 1,
        expectedCurrentReceivedQuantity: 0,
        actualCurrentReceivedQuantity: 1,
      },
    });
    expect(tx.persistReceipt).not.toHaveBeenCalled();
  });

  it("rejects items that are not members of the locked return case", async () => {
    tx.loadForUpdate.mockResolvedValue(aggregate());

    await expect(service.recordReceipt({
      caseId: 1,
      idempotencyKey: "receipt-wrong-case",
      actor: "user:7",
      notes: null,
      lines: [{ returnCaseItemId: 999, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 }],
    })).rejects.toMatchObject({
      code: "RETURN_CASE_RECEIPT_ITEM_NOT_FOUND",
      status: 409,
    });
  });

  it("starts one inspection only after the fully received action is available", async () => {
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstExpected: 2,
      firstReceived: 2,
      secondExpected: 3,
      secondReceived: 3,
      logisticsStatus: "received",
      wmsStatus: "received",
    }));
    tx.persistStartInspection.mockImplementation(async (input) => ({
      commandType: "start_inspection",
      caseId: input.aggregate.caseId,
      caseNumber: input.aggregate.caseNumber,
      inspectionId: 8,
      inspectionStatus: "in_progress",
      startedAt: input.now.toISOString(),
      replayed: false,
    }));

    const result = await service.startInspection({
      caseId: 1,
      idempotencyKey: "inspection-1",
      actor: "user:7",
      notes: "begin",
    });

    expect(result).toMatchObject({ inspectionId: 8, inspectionStatus: "in_progress" });
    expect(tx.persistStartInspection).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "inspection-1",
      actor: "user:7",
      notes: "begin",
      now: NOW,
    }));
  });

  it.each(["approved", "rejected"] as const)(
    "completes an in-progress inspection as %s without delegating side effects",
    async (outcome) => {
      tx.loadForUpdate.mockResolvedValue(aggregate({
        firstExpected: 2,
        firstReceived: 2,
        secondExpected: 3,
        secondReceived: 3,
        logisticsStatus: "received",
        wmsStatus: "received",
        inspectionStatus: "in_progress",
        inspection: activeInspection(8),
      }));
      tx.persistCompleteInspection.mockImplementation(async (input) => ({
        commandType: "complete_inspection",
        caseId: input.aggregate.caseId,
        caseNumber: input.aggregate.caseNumber,
        inspectionId: input.inspectionId,
        inspectionStatus: input.outcome,
        completedAt: input.now.toISOString(),
        replayed: false,
      }));

      const result = await service.completeInspection({
        caseId: 1,
        inspectionId: 8,
        idempotencyKey: ` complete-${outcome} `,
        actor: " user:7 ",
        outcome,
        notes: " inspected ",
      });

      expect(result).toMatchObject({
        commandType: "complete_inspection",
        inspectionId: 8,
        inspectionStatus: outcome,
        completedAt: NOW.toISOString(),
        replayed: false,
      });
      expect(tx.persistCompleteInspection).toHaveBeenCalledWith(expect.objectContaining({
        inspectionId: 8,
        idempotencyKey: `complete-${outcome}`,
        actor: "user:7",
        outcome,
        notes: "inspected",
        now: NOW,
      }));
    },
  );

  it("replays completion before loading mutable state or reading the clock", async () => {
    const clock = vi.fn(() => NOW);
    const replayService = new ReturnCaseOperationService({
      transaction: (work) => work(tx as unknown as ReturnCaseOperationTransaction),
    }, clock);
    const input = {
      caseId: 1,
      inspectionId: 8,
      idempotencyKey: "complete-replay",
      actor: "user:7",
      outcome: "approved" as const,
      notes: null,
    };
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstExpected: 2,
      firstReceived: 2,
      secondExpected: 3,
      secondReceived: 3,
      logisticsStatus: "received",
      wmsStatus: "received",
      inspectionStatus: "in_progress",
      inspection: activeInspection(8),
    }));
    tx.persistCompleteInspection.mockRejectedValueOnce(new Error("capture"));
    await expect(replayService.completeInspection(input)).rejects.toThrow("capture");
    const requestHash = tx.persistCompleteInspection.mock.calls[0][0].requestHash;
    tx.findCommand.mockResolvedValue({
      commandType: "complete_inspection",
      requestHash,
      result: {
        commandType: "complete_inspection",
        caseId: 1,
        caseNumber: "RET-0000000001",
        inspectionId: 8,
        inspectionStatus: "approved",
        completedAt: NOW.toISOString(),
        replayed: false,
      },
    });
    tx.loadForUpdate.mockClear();
    tx.persistCompleteInspection.mockClear();
    clock.mockClear();

    const replay = await replayService.completeInspection(input);

    expect(replay.replayed).toBe(true);
    expect(tx.loadForUpdate).not.toHaveBeenCalled();
    expect(tx.persistCompleteInspection).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
  });

  it("rejects completion idempotency conflicts before loading the aggregate", async () => {
    tx.findCommand.mockResolvedValue({
      commandType: "complete_inspection",
      requestHash: "0".repeat(64),
      result: {
        commandType: "complete_inspection",
        caseId: 1,
        caseNumber: "RET-0000000001",
        inspectionId: 8,
        inspectionStatus: "approved",
        completedAt: NOW.toISOString(),
        replayed: false,
      },
    });

    await expect(service.completeInspection({
      caseId: 1,
      inspectionId: 8,
      idempotencyKey: "complete-conflict",
      actor: "user:7",
      outcome: "rejected",
      notes: null,
    })).rejects.toMatchObject({ code: "RETURN_CASE_IDEMPOTENCY_CONFLICT", status: 409 });
    expect(tx.loadForUpdate).not.toHaveBeenCalled();
    expect(tx.persistCompleteInspection).not.toHaveBeenCalled();
  });

  it("rejects a stale inspection path id before reading the clock or persisting", async () => {
    const clock = vi.fn(() => NOW);
    const staleService = new ReturnCaseOperationService({
      transaction: (work) => work(tx as unknown as ReturnCaseOperationTransaction),
    }, clock);
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstExpected: 2,
      firstReceived: 2,
      secondExpected: 3,
      secondReceived: 3,
      logisticsStatus: "received",
      wmsStatus: "received",
      inspectionStatus: "in_progress",
      inspection: activeInspection(8),
    }));

    await expect(staleService.completeInspection({
      caseId: 1,
      inspectionId: 9,
      idempotencyKey: "complete-stale",
      actor: "user:7",
      outcome: "approved",
      notes: null,
    })).rejects.toMatchObject({
      code: "RETURN_CASE_INSPECTION_STATE_STALE",
      status: 409,
      context: {
        caseId: 1,
        expectedInspectionId: 9,
        actualInspectionId: 8,
        actualInspectionStatus: "in_progress",
      },
    });
    expect(tx.persistCompleteInspection).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
  });

  it("does not start inspection before full receipt", async () => {
    tx.loadForUpdate.mockResolvedValue(aggregate());

    await expect(service.startInspection({
      caseId: 1,
      idempotencyKey: "inspection-too-soon",
      actor: "user:7",
      notes: null,
    })).rejects.toMatchObject({
      code: "RETURN_NOT_FULLY_RECEIVED",
      status: 409,
    });
    expect(tx.persistStartInspection).not.toHaveBeenCalled();
  });

  it("records a reviewed disposition against exact terminal inspection evidence", async () => {
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstReceived: 2,
      secondReceived: 3,
      logisticsStatus: "received",
      wmsStatus: "received",
      inspectionStatus: "approved",
      inspection: terminalInspection(8, "approved"),
    }));
    tx.persistDisposition.mockImplementation(async (input) => ({
      commandType: "record_disposition",
      caseId: input.aggregate.caseId,
      caseNumber: input.aggregate.caseNumber,
      dispositionId: 17,
      inspectionId: input.inspectionId,
      inspectionResolution: input.inspectionResolution,
      lines: input.lines.map(({ returnCaseItemId, quantity, treatment }) => ({
        returnCaseItemId,
        quantity,
        treatment,
      })),
      dispositionSummary: input.dispositionSummary,
      recordedAt: input.now.toISOString(),
      replayed: false,
    }));

    const result = await service.recordDisposition({
      caseId: 1,
      inspectionId: 8,
      idempotencyKey: " disposition-1 ",
      actor: " user:7 ",
      notes: " inspected ",
      lines: [
        {
          returnCaseItemId: 2,
          quantity: 3,
          treatment: "hold_non_sellable",
          expectedCurrentReceivedQuantity: 3,
          expectedCurrentDisposedQuantity: 0,
        },
        {
          returnCaseItemId: 1,
          quantity: 2,
          treatment: "restock_sellable",
          expectedCurrentReceivedQuantity: 2,
          expectedCurrentDisposedQuantity: 0,
        },
      ],
    });

    expect(result).toMatchObject({
      inspectionId: 8,
      inspectionResolution: "approved",
      dispositionSummary: {
        receivedUnits: 5,
        recordedUnits: 5,
        remainingUnits: 0,
        fullyRecorded: true,
        partiallyRecorded: false,
      },
    });
    expect(tx.persistDisposition).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "disposition-1",
      actor: "user:7",
      notes: "inspected",
      inspectionId: 8,
      inspectionResolution: "approved",
      now: NOW,
      lines: [
        expect.objectContaining({ returnCaseItemId: 1, treatment: "restock_sellable" }),
        expect.objectContaining({ returnCaseItemId: 2, treatment: "hold_non_sellable" }),
      ],
    }));
  });

  it("records no-inspection disposition without fabricating inspection evidence", async () => {
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstReceived: 2,
      secondReceived: 3,
      logisticsStatus: "received",
      wmsStatus: "received",
      inspectionStatus: "not_required",
      inspectionRequirement: "none",
    }));
    tx.persistDisposition.mockImplementation(async (input) => ({
      commandType: "record_disposition",
      caseId: input.aggregate.caseId,
      caseNumber: input.aggregate.caseNumber,
      dispositionId: 18,
      inspectionId: input.inspectionId,
      inspectionResolution: input.inspectionResolution,
      lines: input.lines.map(({ returnCaseItemId, quantity, treatment }) => ({ returnCaseItemId, quantity, treatment })),
      dispositionSummary: input.dispositionSummary,
      recordedAt: input.now.toISOString(),
      replayed: false,
    }));

    await service.recordDisposition({
      caseId: 1,
      inspectionId: null,
      idempotencyKey: "disposition-no-inspection",
      actor: "user:7",
      notes: null,
      lines: [{
        returnCaseItemId: 1,
        quantity: 1,
        treatment: "restock_sellable",
        expectedCurrentReceivedQuantity: 2,
        expectedCurrentDisposedQuantity: 0,
      }],
    });

    expect(tx.persistDisposition).toHaveBeenCalledWith(expect.objectContaining({
      inspectionId: null,
      inspectionResolution: "not_required",
    }));
  });

  it("rejects stale reviewed inspection evidence before reading the clock or persisting", async () => {
    const clock = vi.fn(() => NOW);
    const staleService = new ReturnCaseOperationService({
      transaction: (work) => work(tx as unknown as ReturnCaseOperationTransaction),
    }, clock);
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstReceived: 2,
      secondReceived: 3,
      logisticsStatus: "received",
      wmsStatus: "received",
      inspectionStatus: "approved",
      inspection: terminalInspection(8, "approved"),
    }));

    await expect(staleService.recordDisposition(dispositionInput({ inspectionId: 9 })))
      .rejects.toMatchObject({
        code: "RETURN_CASE_INSPECTION_STATE_STALE",
        status: 409,
        context: { expectedInspectionId: 9, actualInspectionId: 8 },
      });
    expect(clock).not.toHaveBeenCalled();
    expect(tx.persistDisposition).not.toHaveBeenCalled();
  });

  it("rejects disposition evidence that predates receipt or terminal inspection", async () => {
    const beforeReceipt = new ReturnCaseOperationService({
      transaction: (work) => work(tx as unknown as ReturnCaseOperationTransaction),
    }, () => new Date(NOW.getTime() - 1));
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstReceived: 2,
      secondReceived: 3,
      logisticsStatus: "received",
      wmsStatus: "received",
      inspectionStatus: "approved",
      inspection: terminalInspection(8, "approved", new Date(NOW.getTime() - 2)),
    }));
    await expect(beforeReceipt.recordDisposition(dispositionInput()))
      .rejects.toMatchObject({ code: "RETURN_CASE_DISPOSITION_TIME_INVALID", status: 500 });

    const beforeInspection = new ReturnCaseOperationService({
      transaction: (work) => work(tx as unknown as ReturnCaseOperationTransaction),
    }, () => new Date(NOW.getTime() - 1));
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstReceived: 2,
      secondReceived: 3,
      logisticsStatus: "received",
      wmsStatus: "received",
      receivedAt: new Date(NOW.getTime() - 2),
      inspectionStatus: "approved",
      inspection: terminalInspection(8, "approved", NOW),
    }));
    await expect(beforeInspection.recordDisposition(dispositionInput()))
      .rejects.toMatchObject({ code: "RETURN_CASE_DISPOSITION_TIME_INVALID", status: 500 });
    expect(tx.persistDisposition).not.toHaveBeenCalled();
  });

  it("replays disposition before mutable state and hashes the reviewed inspection id", async () => {
    const clock = vi.fn(() => NOW);
    const replayService = new ReturnCaseOperationService({
      transaction: (work) => work(tx as unknown as ReturnCaseOperationTransaction),
    }, clock);
    const input = dispositionInput();
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstReceived: 2,
      secondReceived: 3,
      logisticsStatus: "received",
      wmsStatus: "received",
      inspectionStatus: "approved",
      inspection: terminalInspection(8, "approved"),
    }));
    tx.persistDisposition.mockRejectedValueOnce(new Error("capture"));
    await expect(replayService.recordDisposition(input)).rejects.toThrow("capture");
    const persisted = tx.persistDisposition.mock.calls[0][0];
    const replayResult = {
      commandType: "record_disposition" as const,
      caseId: 1,
      caseNumber: "RET-0000000001",
      dispositionId: 17,
      inspectionId: 8,
      inspectionResolution: "approved" as const,
      lines: [{ returnCaseItemId: 1, quantity: 1, treatment: "restock_sellable" as const }],
      dispositionSummary: persisted.dispositionSummary,
      recordedAt: NOW.toISOString(),
      replayed: false,
    };
    tx.findCommand.mockResolvedValue({
      commandType: "record_disposition",
      requestHash: persisted.requestHash,
      result: replayResult,
    });
    tx.loadForUpdate.mockClear();
    tx.persistDisposition.mockClear();
    clock.mockClear();

    expect(await replayService.recordDisposition(input)).toMatchObject({ replayed: true });
    expect(tx.loadForUpdate).not.toHaveBeenCalled();
    expect(tx.persistDisposition).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    await expect(replayService.recordDisposition({ ...input, inspectionId: 9 }))
      .rejects.toMatchObject({ code: "RETURN_CASE_IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it.each([
    ["RETURN_CASE_DISPOSITION_STATE_STALE", 1, 0, 1],
    ["RETURN_CASE_DISPOSITION_QUANTITY_EXCEEDED", 2, 0, 3],
  ] as const)("rejects %s before disposition persistence", async (
    code,
    expectedCurrentReceivedQuantity,
    expectedCurrentDisposedQuantity,
    quantity,
  ) => {
    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstReceived: 2,
      secondReceived: 3,
      logisticsStatus: "received",
      wmsStatus: "received",
      inspectionStatus: "approved",
      inspection: terminalInspection(8, "approved"),
    }));
    await expect(service.recordDisposition(dispositionInput({
      lines: [{
        returnCaseItemId: 1,
        quantity,
        treatment: "restock_sellable",
        expectedCurrentReceivedQuantity,
        expectedCurrentDisposedQuantity,
      }],
    }))).rejects.toMatchObject({ code, status: 409 });
    expect(tx.persistDisposition).not.toHaveBeenCalled();
  });

  it("normalizes reviewed inventory treatment, persists exact source evidence, and notifies sellable variants after commit", async () => {
    const notify = vi.fn();
    const order: string[] = [];
    const treatmentService = new ReturnCaseOperationService({
      transaction: (work) => work(tx as unknown as ReturnCaseOperationTransaction),
    }, () => {
      order.push("clock");
      return NOW;
    }, { notify: (productVariantId) => {
      order.push(`notify:${productVariantId}`);
      notify(productVariantId);
    } });
    tx.loadForUpdate.mockImplementation(async () => {
      order.push("state");
      return treatmentReadyAggregate();
    });
    tx.persistInventoryTreatment.mockImplementation(async (input) => {
      order.push("persist");
      return inventoryTreatmentResult(treatmentSummary(), false);
    });

    const result = await treatmentService.applyInventoryTreatment({
      caseId: 1,
      idempotencyKey: " treatment-1 ",
      actor: " user:7 ",
      notes: " inspected units ",
      lines: [
        { dispositionItemId: 92, expectedTreatment: "hold_non_sellable", expectedQuantity: 3, warehouseLocationId: null },
        { dispositionItemId: 91, expectedTreatment: "restock_sellable", expectedQuantity: 2, warehouseLocationId: 17 },
      ],
    });

    expect(result).toMatchObject({ commandType: "apply_inventory_treatment", replayed: false });
    expect(tx.lockCommand).toHaveBeenCalledWith("treatment-1");
    expect(tx.persistInventoryTreatment).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "treatment-1",
      actor: "user:7",
      notes: "inspected units",
      now: NOW,
      lines: [
        {
          dispositionItemId: 91,
          returnCaseItemId: 1,
          productVariantId: 1001,
          treatment: "restock_sellable",
          quantity: 2,
          warehouseLocationId: 17,
        },
        {
          dispositionItemId: 92,
          returnCaseItemId: 2,
          productVariantId: null,
          treatment: "hold_non_sellable",
          quantity: 3,
          warehouseLocationId: null,
        },
      ],
    }));
    expect(order).toEqual(["state", "clock", "persist", "notify:1001"]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(1001);
  });

  it("replays inventory treatment before state loading and does not notify again", async () => {
    const notify = vi.fn();
    const clock = vi.fn(() => NOW);
    const replayService = new ReturnCaseOperationService({
      transaction: (work) => work(tx as unknown as ReturnCaseOperationTransaction),
    }, clock, { notify });
    const input = inventoryTreatmentInput();
    tx.loadForUpdate.mockResolvedValue(treatmentReadyAggregate());
    tx.persistInventoryTreatment.mockRejectedValueOnce(new Error("capture"));
    await expect(replayService.applyInventoryTreatment(input)).rejects.toThrow("capture");
    const persisted = tx.persistInventoryTreatment.mock.calls[0][0];
    tx.findCommand.mockResolvedValue({
      commandType: "apply_inventory_treatment",
      requestHash: persisted.requestHash,
      result: inventoryTreatmentResult(treatmentSummary(), false),
    });
    tx.loadForUpdate.mockClear();
    tx.persistInventoryTreatment.mockClear();
    clock.mockClear();

    expect(await replayService.applyInventoryTreatment(input)).toMatchObject({ replayed: true });
    expect(tx.loadForUpdate).not.toHaveBeenCalled();
    expect(tx.persistInventoryTreatment).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    await expect(replayService.applyInventoryTreatment({ ...input, notes: "different" }))
      .rejects.toMatchObject({ code: "RETURN_CASE_IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it.each([
    {
      name: "changed treatment",
      input: inventoryTreatmentInput({ lines: [{ dispositionItemId: 91, expectedTreatment: "hold_non_sellable", expectedQuantity: 2, warehouseLocationId: null }] }),
      code: "RETURN_INVENTORY_TREATMENT_STATE_STALE",
      status: 409,
    },
    {
      name: "changed quantity",
      input: inventoryTreatmentInput({ lines: [{ dispositionItemId: 91, expectedTreatment: "restock_sellable", expectedQuantity: 1, warehouseLocationId: 17 }] }),
      code: "RETURN_INVENTORY_TREATMENT_STATE_STALE",
      status: 409,
    },
    {
      name: "sellable treatment without a location",
      input: inventoryTreatmentInput({ lines: [{ dispositionItemId: 91, expectedTreatment: "restock_sellable", expectedQuantity: 2, warehouseLocationId: null }] }),
      code: "RETURN_CASE_OPERATION_INPUT_INVALID",
      status: 400,
    },
    {
      name: "held treatment with a sellable location",
      input: inventoryTreatmentInput({ lines: [{ dispositionItemId: 92, expectedTreatment: "hold_non_sellable", expectedQuantity: 3, warehouseLocationId: 17 }] }),
      code: "RETURN_CASE_OPERATION_INPUT_INVALID",
      status: 400,
    },
  ])("rejects $name before inventory treatment persistence", async ({ input, code, status }) => {
    tx.loadForUpdate.mockResolvedValue(treatmentReadyAggregate());

    await expect(service.applyInventoryTreatment(input)).rejects.toMatchObject({ code, status });
    expect(tx.persistInventoryTreatment).not.toHaveBeenCalled();
  });

  it("rejects sellable restock when the canonical return item has no exact catalog variant", async () => {
    tx.loadForUpdate.mockResolvedValue(treatmentReadyAggregate({
      items: [
        { returnCaseItemId: 1, omsOrderLineId: 11, wmsOrderItemId: 21, productVariantId: null },
        { returnCaseItemId: 2, omsOrderLineId: 12, wmsOrderItemId: 22, productVariantId: 1002 },
      ],
    }));

    await expect(service.applyInventoryTreatment(inventoryTreatmentInput())).rejects.toMatchObject({
      code: "RETURN_INVENTORY_TREATMENT_VARIANT_MISSING",
      status: 409,
    });
    expect(tx.persistInventoryTreatment).not.toHaveBeenCalled();
  });

  it("rejects duplicate disposition item ids at the input boundary", async () => {
    await expect(service.applyInventoryTreatment(inventoryTreatmentInput({
      lines: [
        { dispositionItemId: 91, expectedTreatment: "restock_sellable", expectedQuantity: 2, warehouseLocationId: 17 },
        { dispositionItemId: 91, expectedTreatment: "restock_sellable", expectedQuantity: 2, warehouseLocationId: 17 },
      ],
    }))).rejects.toMatchObject({ code: "RETURN_CASE_OPERATION_INPUT_INVALID", status: 400 });
    expect(tx.loadForUpdate).not.toHaveBeenCalled();
    expect(tx.persistInventoryTreatment).not.toHaveBeenCalled();
  });

  it("rejects duplicate receipt lines and invalid clocks deterministically", async () => {
    await expect(service.recordReceipt({
      caseId: 1,
      idempotencyKey: "duplicates",
      actor: "user:7",
      notes: null,
      lines: [
        { returnCaseItemId: 1, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 },
        { returnCaseItemId: 1, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 },
      ],
    })).rejects.toBeInstanceOf(ReturnCaseOperationError);

    tx.loadForUpdate.mockResolvedValue(aggregate({
      firstExpected: 2,
      firstReceived: 2,
      secondExpected: 3,
      secondReceived: 3,
      logisticsStatus: "received",
      wmsStatus: "received",
    }));
    const invalidClockService = new ReturnCaseOperationService({
      transaction: (work) => work(tx as unknown as ReturnCaseOperationTransaction),
    }, () => new Date("invalid"));
    await expect(invalidClockService.startInspection({
      caseId: 1,
      idempotencyKey: "bad-clock",
      actor: "user:7",
      notes: null,
    })).rejects.toMatchObject({ code: "RETURN_CASE_CLOCK_INVALID", status: 500 });
  });
});

function fakeTransaction() {
  return {
    lockCommand: vi.fn().mockResolvedValue(undefined),
    findCommand: vi.fn().mockResolvedValue(null),
    loadForUpdate: vi.fn(),
    persistReceipt: vi.fn(),
    persistStartInspection: vi.fn(),
    persistCompleteInspection: vi.fn(),
    persistDisposition: vi.fn(),
    persistInventoryTreatment: vi.fn(),
  };
}

function aggregate(input: {
  firstExpected?: number;
  firstReceived?: number;
  secondExpected?: number;
  secondReceived?: number;
  logisticsStatus?: "awaiting_return" | "partially_received" | "received";
  wmsStatus?: "expected" | "partially_received" | "received";
  inspectionStatus?: "pending" | "in_progress" | "approved" | "rejected" | "not_required";
  inspectionRequirement?: "required" | "conditional_required" | "none";
  receivedAt?: Date;
  inspection?: ReturnCaseOperationAggregate["actionContext"]["inspection"];
  disposition?: ReturnCaseOperationAggregate["actionContext"]["disposition"];
  inventoryTreatment?: ReturnCaseOperationAggregate["actionContext"]["inventoryTreatment"];
  items?: ReturnCaseOperationAggregate["items"];
} = {}): ReturnCaseOperationAggregate {
  const firstExpected = input.firstExpected ?? 2;
  const firstReceived = input.firstReceived ?? 0;
  const secondExpected = input.secondExpected ?? 3;
  const secondReceived = input.secondReceived ?? 0;
  const wmsStatus = input.wmsStatus ?? "expected";
  return {
    caseId: 1,
    caseNumber: "RET-0000000001",
    omsOrderId: 50,
    wmsReturnId: 230,
    wmsOrderId: 60,
    items: input.items ?? [
      { returnCaseItemId: 1, omsOrderLineId: 11, wmsOrderItemId: 21, productVariantId: 1001 },
      { returnCaseItemId: 2, omsOrderLineId: 12, wmsOrderItemId: 22, productVariantId: 1002 },
    ],
    actionContext: {
      lifecycle: {
        caseStatus: "open",
        approvalStatus: "approved",
        logisticsStatus: input.logisticsStatus ?? "awaiting_return",
        inspectionStatus: input.inspectionStatus ?? "pending",
        customerRefundStatus: "pending",
        vendorSettlementStatus: "not_applicable",
      },
      policy: {
        id: 6,
        name: "Returns",
        version: 2,
        scopeKind: "channel_context",
        scopeKey: "context:retail:channel:36",
        returnWindowDays: 32,
        returnDestination: "card_shellz",
        approvalAuthority: "card_shellz",
        labelProvider: "shipstation",
        returnShippingPayer: "customer",
        inspectionRequirement: input.inspectionRequirement ?? "required",
        inspectionOwner: "card_shellz",
        customerRefundAuthority: "card_shellz",
        vendorSettlementTrigger: "none",
        returnlessRefundAllowed: false,
      },
      receipt: {
        wmsReturnId: 230,
        wmsStatus,
        receivedAt: input.receivedAt
          ?? (firstReceived + secondReceived > 0 ? NOW : null),
        restocked: false,
        canonicalItemCount: 2,
        items: [
          {
            returnCaseItemId: 1,
            wmsReturnItemId: 101,
            caseExpectedQuantity: firstExpected,
            wmsExpectedQuantity: firstExpected,
            wmsReceivedQuantity: firstReceived,
            wmsStatus: itemStatus(firstExpected, firstReceived),
          },
          {
            returnCaseItemId: 2,
            wmsReturnItemId: 102,
            caseExpectedQuantity: secondExpected,
            wmsExpectedQuantity: secondExpected,
            wmsReceivedQuantity: secondReceived,
            wmsStatus: itemStatus(secondExpected, secondReceived),
          },
        ],
      },
      inspection: input.inspection ?? null,
      disposition: input.disposition ?? null,
      inventoryTreatment: input.inventoryTreatment ?? null,
      conditionalInspectionDecision: null,
    },
  };
}

function activeInspection(inspectionId: number): NonNullable<ReturnCaseOperationAggregate["actionContext"]["inspection"]> {
  return {
    inspectionId,
    status: "in_progress",
    startedAt: new Date("2026-08-22T11:00:00.000Z"),
    startedBy: "user:6",
    completedAt: null,
    completedBy: null,
  };
}

function terminalInspection(
  inspectionId: number,
  status: "approved" | "rejected",
  completedAt: Date = NOW,
): NonNullable<ReturnCaseOperationAggregate["actionContext"]["inspection"]> {
  return {
    inspectionId,
    status,
    startedAt: new Date("2026-08-22T10:00:00.000Z"),
    startedBy: "user:6",
    completedAt,
    completedBy: "user:7",
  };
}

function dispositionInput(
  override: Partial<Parameters<ReturnCaseOperationService["recordDisposition"]>[0]> = {},
): Parameters<ReturnCaseOperationService["recordDisposition"]>[0] {
  return {
    caseId: 1,
    inspectionId: 8,
    idempotencyKey: "disposition-test",
    actor: "user:7",
    notes: null,
    lines: [{
      returnCaseItemId: 1,
      quantity: 1,
      treatment: "restock_sellable",
      expectedCurrentReceivedQuantity: 2,
      expectedCurrentDisposedQuantity: 0,
    }],
    ...override,
  };
}

function treatmentReadyAggregate(
  override: { items?: ReturnCaseOperationAggregate["items"] } = {},
): ReturnCaseOperationAggregate {
  return aggregate({
    firstExpected: 2,
    firstReceived: 2,
    secondExpected: 3,
    secondReceived: 3,
    logisticsStatus: "received",
    wmsStatus: "received",
    inspectionStatus: "approved",
    inspection: terminalInspection(8, "approved"),
    disposition: {
      recordCount: 2,
      lines: [
        { dispositionItemId: 91, dispositionId: 81, returnCaseItemId: 1, treatment: "restock_sellable", quantity: 2 },
        { dispositionItemId: 92, dispositionId: 82, returnCaseItemId: 2, treatment: "hold_non_sellable", quantity: 3 },
      ],
    },
    items: override.items,
  });
}

function inventoryTreatmentInput(
  override: Partial<Parameters<ReturnCaseOperationService["applyInventoryTreatment"]>[0]> = {},
): Parameters<ReturnCaseOperationService["applyInventoryTreatment"]>[0] {
  return {
    caseId: 1,
    idempotencyKey: "inventory-treatment-test",
    actor: "user:7",
    notes: null,
    lines: [{
      dispositionItemId: 91,
      expectedTreatment: "restock_sellable",
      expectedQuantity: 2,
      warehouseLocationId: 17,
    }],
    ...override,
  };
}

function inventoryTreatmentResult(
  summary: ReturnType<typeof treatmentSummary>,
  replayed: boolean,
) {
  return {
    commandType: "apply_inventory_treatment" as const,
    caseId: 1,
    caseNumber: "RET-0000000001",
    inventoryTreatmentId: 101,
    lines: [
      {
        dispositionItemId: 91,
        returnCaseItemId: 1,
        productVariantId: 1001,
        treatment: "restock_sellable" as const,
        quantity: 2,
        warehouseLocationId: 17,
        inventoryTransactionId: 401,
        inventoryLotId: 501,
      },
      {
        dispositionItemId: 92,
        returnCaseItemId: 2,
        productVariantId: null,
        treatment: "hold_non_sellable" as const,
        quantity: 3,
        warehouseLocationId: null,
        inventoryTransactionId: null,
        inventoryLotId: null,
      },
    ],
    inventoryTreatmentSummary: summary,
    appliedAt: NOW.toISOString(),
    replayed,
  };
}

function treatmentSummary() {
  return {
    dispositionUnits: 5,
    appliedUnits: 5,
    remainingUnits: 0,
    fullyApplied: true,
    partiallyApplied: false,
    items: [
      {
        dispositionItemId: 91,
        returnCaseItemId: 1,
        treatment: "restock_sellable" as const,
        quantity: 2,
        warehouseLocationId: 17,
        inventoryTransactionId: 401,
        inventoryLotId: 501,
        applied: true,
      },
      {
        dispositionItemId: 92,
        returnCaseItemId: 2,
        treatment: "hold_non_sellable" as const,
        quantity: 3,
        warehouseLocationId: null,
        inventoryTransactionId: null,
        inventoryLotId: null,
        applied: true,
      },
    ],
  };
}

function itemStatus(expected: number, received: number): string {
  return received === 0 ? "expected" : received === expected ? "received" : "partially_received";
}
