import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeInTransaction: vi.fn(),
  postCommit: vi.fn(),
}));

vi.mock("../../ap-ledger.service", () => {
  class ApLedgerError extends Error {
    constructor(
      message: string,
      public statusCode = 400,
      public details?: Record<string, unknown>,
    ) {
      super(message);
      this.name = "ApLedgerError";
    }
  }
  return {
    ApLedgerError,
    executeApPaymentCommandInTransaction: mocks.executeInTransaction,
    runApPaymentCommandPostCommit: mocks.postCommit,
  };
});

import { ApLedgerError } from "../../ap-ledger.service";
import {
  classifyApPaymentCommandFailure,
  createApPaymentCommands,
} from "../../ap-payment-commands";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";

const descriptor: FinancialCommandDescriptor = {
  actorType: "user",
  actorId: "ops-user",
  method: "POST",
  routeTemplate: "/api/ap-payments",
  resourceKey: "vendor:4",
  idempotencyKey: "payment-command-123",
  requestHash: "a".repeat(64),
  commandName: "ap.payment.record",
  contractVersion: 1,
};

function claimedRepository() {
  const tx = { name: "same-ap-transaction" };
  return {
    tx,
    repository: {
      reserve: vi.fn().mockResolvedValue({
        kind: "claimed",
        claim: { commandId: 91, leaseToken: "lease-91" },
      }),
      executeClaim: vi.fn(async (_claim, _descriptor, work) => {
        const success = await work(tx);
        return {
          commandId: 91,
          replayed: false,
          httpStatus: success.httpStatus,
          body: success.body,
          terminalState: "succeeded",
        };
      }),
      rejectClaim: vi.fn(),
      markRetryable: vi.fn(),
    },
  };
}

describe("AP payment transactional commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records the payment and its durable result through the same transaction", async () => {
    const { repository, tx } = claimedRepository();
    const apLedgerOutcome = {
      command: "record_payment",
      entityType: "payment",
      entityId: 21,
      affectedInvoiceIds: [12],
      affectedPaymentIds: [21],
      affectedPurchaseOrderIds: [55],
      message: "record payment completed. Updated 1 linked PO.",
    };
    mocks.executeInTransaction.mockResolvedValue({
      id: 21,
      paymentNumber: "PAY-21",
      apLedgerOutcome,
    });

    const commands = createApPaymentCommands(repository as any);
    const result = await commands.recordPayment({
      payment: {
        vendorId: 4,
        paymentDate: new Date("2026-07-14T00:00:00.000Z"),
        paymentMethod: "ach",
        totalAmountCents: 2500,
        allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
      },
    }, descriptor);

    expect(mocks.executeInTransaction).toHaveBeenCalledWith(
      "record_payment",
      expect.objectContaining({ payment: expect.objectContaining({ vendorId: 4 }) }),
      tx,
    );
    expect(repository.executeClaim).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ replayed: false, httpStatus: 201 });
    expect(mocks.postCommit).toHaveBeenCalledWith(apLedgerOutcome);
  });

  it("replays a completed payment without running the mutation or hooks again", async () => {
    const replayedBody = {
      id: 21,
      apLedgerOutcome: { command: "record_payment", affectedPurchaseOrderIds: [55] },
    };
    const repository = {
      reserve: vi.fn().mockResolvedValue({
        kind: "replay",
        result: {
          commandId: 91,
          replayed: true,
          httpStatus: 201,
          body: replayedBody,
          terminalState: "succeeded",
        },
      }),
      executeClaim: vi.fn(),
      rejectClaim: vi.fn(),
      markRetryable: vi.fn(),
    };

    const result = await createApPaymentCommands(repository as any).recordPayment({
      payment: {
        vendorId: 4,
        paymentDate: new Date("2026-07-14T00:00:00.000Z"),
        paymentMethod: "ach",
        totalAmountCents: 2500,
        allocations: [],
      },
    }, descriptor);

    expect(result).toMatchObject({ replayed: true, body: replayedBody });
    expect(mocks.executeInTransaction).not.toHaveBeenCalled();
    expect(repository.executeClaim).not.toHaveBeenCalled();
    expect(mocks.postCommit).not.toHaveBeenCalled();
  });

  it("stores deterministic AP validation failures as rejected results", () => {
    const failure = classifyApPaymentCommandFailure(new ApLedgerError(
      "Allocation total exceeds payment total",
      422,
      { code: "AP_PAYMENT_ALLOCATION_EXCEEDS_TOTAL" },
    ));

    expect(failure).toEqual({
      kind: "rejected",
      httpStatus: 422,
      body: {
        error: "Allocation total exceeds payment total",
        details: { code: "AP_PAYMENT_ALLOCATION_EXCEEDS_TOTAL" },
      },
      errorCode: "AP_PAYMENT_ALLOCATION_EXCEEDS_TOTAL",
      errorMessage: "Allocation total exceeds payment total",
    });
  });

  it("keeps unknown infrastructure failures retryable without leaking details", () => {
    expect(classifyApPaymentCommandFailure(new Error("password=secret"))).toEqual({
      kind: "retryable",
      errorCode: "AP_PAYMENT_COMMAND_TRANSIENT_FAILURE",
      errorMessage: "AP payment command failed before its transaction committed.",
    });
  });
});
