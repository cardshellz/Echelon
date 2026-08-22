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
  };
}

function aggregate(input: {
  firstExpected?: number;
  firstReceived?: number;
  secondExpected?: number;
  secondReceived?: number;
  logisticsStatus?: "awaiting_return" | "partially_received" | "received";
  wmsStatus?: "expected" | "partially_received" | "received";
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
    actionContext: {
      lifecycle: {
        caseStatus: "open",
        approvalStatus: "approved",
        logisticsStatus: input.logisticsStatus ?? "awaiting_return",
        inspectionStatus: "pending",
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
        inspectionRequirement: "required",
        inspectionOwner: "card_shellz",
        customerRefundAuthority: "card_shellz",
        vendorSettlementTrigger: "none",
        returnlessRefundAllowed: false,
      },
      receipt: {
        wmsReturnId: 230,
        wmsStatus,
        receivedAt: firstReceived + secondReceived > 0 ? NOW : null,
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
      inspection: null,
      conditionalInspectionDecision: null,
    },
  };
}

function itemStatus(expected: number, received: number): string {
  return received === 0 ? "expected" : received === expected ? "received" : "partially_received";
}
