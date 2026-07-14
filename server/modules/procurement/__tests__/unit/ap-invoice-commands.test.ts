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
    executeApInvoiceCommandInTransaction: mocks.executeInTransaction,
    runApInvoiceCommandPostCommit: mocks.postCommit,
  };
});

import { ApLedgerError } from "../../ap-ledger.service";
import {
  classifyApInvoiceCommandFailure,
  createApInvoiceCommands,
} from "../../ap-invoice-commands";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";

const descriptor: FinancialCommandDescriptor = {
  actorType: "user",
  actorId: "ops-user",
  method: "POST",
  routeTemplate: "/api/vendor-invoices/:id/approve",
  resourceKey: "vendor_invoice:12",
  idempotencyKey: "invoice-command-123",
  requestHash: "b".repeat(64),
  commandName: "ap.invoice.approve",
  contractVersion: 1,
};

function claimedRepository() {
  const tx = { name: "same-invoice-transaction" };
  return {
    tx,
    repository: {
      reserve: vi.fn().mockResolvedValue({
        kind: "claimed",
        claim: { commandId: 81, leaseToken: "lease-81" },
      }),
      executeClaim: vi.fn(async (_claim, _descriptor, work) => {
        const success = await work(tx);
        return {
          commandId: 81,
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

describe("AP invoice transactional commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["approveInvoice", "approve_invoice", {}],
    ["disputeInvoice", "dispute_invoice", { reason: "price mismatch" }],
    ["voidInvoice", "void_invoice", { reason: "duplicate" }],
  ] as const)("runs %s and its durable result through the same transaction", async (
    method,
    command,
    input,
  ) => {
    const { repository, tx } = claimedRepository();
    const apLedgerOutcome = {
      command,
      entityType: "invoice",
      entityId: 12,
      affectedInvoiceIds: [12],
      affectedPaymentIds: [],
      affectedPurchaseOrderIds: [55],
      message: `${command} completed. Updated 1 linked PO.`,
    };
    mocks.executeInTransaction.mockResolvedValue({
      id: 12,
      status: command === "approve_invoice" ? "approved" : command === "dispute_invoice" ? "disputed" : "voided",
      apLedgerOutcome,
    });

    const commands = createApInvoiceCommands(repository as any);
    const result = await commands[method](12, { ...input, userId: "ops-user" }, descriptor);

    expect(mocks.executeInTransaction).toHaveBeenCalledWith(
      command,
      { ...input, invoiceId: 12, userId: "ops-user" },
      tx,
    );
    expect(repository.executeClaim).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ replayed: false, httpStatus: 200 });
    expect(mocks.postCommit).toHaveBeenCalledWith(apLedgerOutcome);
  });

  it("replays a completed transition without running the mutation or hooks", async () => {
    const replayedBody = {
      id: 12,
      status: "approved",
      apLedgerOutcome: { command: "approve_invoice", affectedPurchaseOrderIds: [55] },
    };
    const repository = {
      reserve: vi.fn().mockResolvedValue({
        kind: "replay",
        result: {
          commandId: 81,
          replayed: true,
          httpStatus: 200,
          body: replayedBody,
          terminalState: "succeeded",
        },
      }),
      executeClaim: vi.fn(),
      rejectClaim: vi.fn(),
      markRetryable: vi.fn(),
    };

    const result = await createApInvoiceCommands(repository as any)
      .approveInvoice(12, { userId: "ops-user" }, descriptor);

    expect(result).toMatchObject({ replayed: true, body: replayedBody });
    expect(mocks.executeInTransaction).not.toHaveBeenCalled();
    expect(mocks.postCommit).not.toHaveBeenCalled();
  });

  it("stores deterministic transition conflicts as rejected command results", () => {
    expect(classifyApInvoiceCommandFailure(new ApLedgerError(
      "Cannot dispute invoice in its current status",
      409,
      { code: "AP_INVOICE_DISPUTE_STATUS_INVALID" },
    ))).toEqual({
      kind: "rejected",
      httpStatus: 409,
      body: {
        error: "Cannot dispute invoice in its current status",
        details: { code: "AP_INVOICE_DISPUTE_STATUS_INVALID" },
      },
      errorCode: "AP_INVOICE_DISPUTE_STATUS_INVALID",
      errorMessage: "Cannot dispute invoice in its current status",
    });
  });

  it("keeps unknown infrastructure failures retryable without leaking details", () => {
    expect(classifyApInvoiceCommandFailure(new Error("connection password"))).toEqual({
      kind: "retryable",
      errorCode: "AP_INVOICE_COMMAND_TRANSIENT_FAILURE",
      errorMessage: "AP invoice command failed before its transaction committed.",
    });
  });
});
