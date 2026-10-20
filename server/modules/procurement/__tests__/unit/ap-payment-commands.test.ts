import { SupplierCreditEvidenceError } from "../../supplier-credit-settlement.repository";
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
  createApPaymentCommands as createCommands,
} from "../../ap-payment-commands";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";

const createApPaymentCommands = (repository: Parameters<typeof createCommands>[0], clock?: () => Date) => createCommands(repository, clock, async () => []);

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

function recordedPaymentValue() {
  return { id: 21, paymentNumber: "PAY-21", vendorId: 4, totalAmountCents: 2500, currency: "USD", status: "completed",
    paymentDate: new Date("2026-07-14T00:00:00.000Z"), paymentCalendarDate: null, paymentDateSource: "legacy_timestamp",
    paymentMethod: "ach", referenceNumber: null, checkNumber: null, bankAccountLabel: null, notes: null,
    applications: [{ allocationId: 30, vendorInvoiceId: 12, appliedAmountCents: 2500 }],
    paymentBalance: { state: "fully_applied", appliedAmountCents: 2500, unappliedAmountCents: 0, version: "b".repeat(64), issue: null } };
}

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

  it("records credit evidence conflicts as terminal review rejections", () => {
    const failure = classifyApPaymentCommandFailure(new SupplierCreditEvidenceError(12, "AP_INVOICE_SETTLEMENT_REVIEW"));
    expect(failure).toMatchObject({ kind: "rejected", httpStatus: 409,
      errorCode: "AP_INVOICE_SETTLEMENT_REVIEW", body: { details: { code: "AP_INVOICE_SETTLEMENT_REVIEW", invoiceId: 12 } } });
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
      ...recordedPaymentValue(),
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
      ...recordedPaymentValue(), paymentDate: "2026-07-14T00:00:00.000Z", command: "record_payment", actorId: descriptor.actorId, idempotencyKey: descriptor.idempotencyKey, paymentId: 21,
      applications: [], paymentBalance: { state: "available", appliedAmountCents: 0, unappliedAmountCents: 2500, version: "b".repeat(64), issue: null },
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
  it("stores command, actor, key and payment identity in the successful record receipt", async () => {
    const { repository } = claimedRepository();
    mocks.executeInTransaction.mockResolvedValue(recordedPaymentValue());
    const result = await createApPaymentCommands(repository as any).recordPayment({ payment: { vendorId: 4, paymentDate: new Date("2026-07-14Z"), paymentMethod: "ach", totalAmountCents: 2500, allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }] } }, descriptor);
    expect(result.body).toMatchObject({ command: "record_payment", actorId: descriptor.actorId, idempotencyKey: descriptor.idempotencyKey, paymentId: 21 });
    expect(mocks.executeInTransaction.mock.calls[0][1]).toMatchObject({ userId: descriptor.actorId, payment: { createdBy: descriptor.actorId } });
  });
  it("stores a matching rejection proof only after the durable rejection succeeds", async () => {
    const { repository } = claimedRepository();
    mocks.executeInTransaction.mockRejectedValue(new ApLedgerError("Balance changed", 409, { code: "AP_PAYMENT_VERSION_CONFLICT" }));
    repository.rejectClaim.mockImplementation(async (_claim, _descriptor, rejection) => ({ terminalState: "rejected", body: rejection.body, replayed: false, httpStatus: rejection.httpStatus, commandId: 91 }));
    const result = await createApPaymentCommands(repository as any).applyPayment(21, { application: { expectedVersion: "a".repeat(64), allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 1 }], reason: "Review" } }, descriptor);
    expect(result.body).toMatchObject({ details: { paymentCommandOutcome: "rejected", command: "apply_payment", actorId: descriptor.actorId, idempotencyKey: descriptor.idempotencyKey } });
    repository.rejectClaim.mockRejectedValue(new Error("durable storage failed"));
    await expect(createApPaymentCommands(repository as any).applyPayment(21, {}, descriptor)).rejects.toThrow("durable storage failed");
  });
  it("validates malformed successful replies before storing them", async () => {
    const { repository } = claimedRepository();
    mocks.executeInTransaction.mockResolvedValue({ ...recordedPaymentValue(), totalAmountCents: -1 });
    await expect(createApPaymentCommands(repository as any).recordPayment({}, descriptor)).rejects.toThrow();
    expect(repository.markRetryable).toHaveBeenCalledOnce();
    expect(repository.rejectClaim).not.toHaveBeenCalled();
  });
  it("injects the command clock for an append-only existing-payment application", async () => {
    const { repository } = claimedRepository();
    const now = new Date("2026-10-01T15:30:00Z");
    mocks.executeInTransaction.mockResolvedValue({ applications: [{ allocationId: 30, vendorInvoiceId: 12, appliedAmountCents: 500 }],
      paymentBalance: { state: "available", appliedAmountCents: 500, unappliedAmountCents: 2000, version: "b".repeat(64), issue: null },
      apLedgerOutcome: { command: "apply_payment", entityType: "payment", entityId: 21, affectedInvoiceIds: [12], affectedPaymentIds: [21], affectedPurchaseOrderIds: [], message: "Applied." } });
    const result = await createApPaymentCommands(repository as any, () => now).applyPayment(21, { application: { expectedVersion: "a".repeat(64), allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 500 }], reason: "Apply deposit" } }, descriptor);
    expect(mocks.executeInTransaction.mock.calls[0][1].now).toBe(now);
    expect(result.body).toMatchObject({ command: "apply_payment", paymentId: 21, actorId: descriptor.actorId, idempotencyKey: descriptor.idempotencyKey });
  });

  it.each([{ actorId: "different-operator" }, { totalAmountCents: 9999 }, { applications: [] }, { command: "void_payment" }])("rejects mismatched saved successful receipt %j without another mutation", async patch => {
    const { repository } = claimedRepository();
    const body = { ...recordedPaymentValue(), paymentDate: "2026-07-14T00:00:00.000Z", command: "record_payment", actorId: descriptor.actorId,
      idempotencyKey: descriptor.idempotencyKey, paymentId: 21, ...patch };
    repository.reserve.mockResolvedValue({ kind: "replay", result: { commandId: 91, replayed: true, httpStatus: 201, body, terminalState: "succeeded" } });
    await expect(createApPaymentCommands(repository as any).recordPayment({ payment: { vendorId: 4, paymentDate: new Date("2026-07-14Z"), paymentMethod: "ach", totalAmountCents: 2500,
      allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }] } }, descriptor)).rejects.toThrow();
    expect(mocks.executeInTransaction).not.toHaveBeenCalled();
  });

});
