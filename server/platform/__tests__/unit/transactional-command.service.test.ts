import { describe, expect, it, vi } from "vitest";

import {
  FinancialCommandError,
  runTransactionalFinancialCommand,
  type FinancialCommandClaim,
  type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition,
  type FinancialCommandRepository,
  type FinancialCommandReservation,
  type FinancialCommandResult,
  type FinancialCommandSuccess,
} from "../../commands/transactional-command.service";

type TestTransaction = { name: "command-transaction" };

const descriptor: FinancialCommandDescriptor = {
  actorType: "user",
  actorId: "user-7",
  method: "POST",
  routeTemplate: "/api/purchase-orders/:id/lines",
  resourceKey: "purchase_order:41",
  idempotencyKey: "po-line-command-123",
  requestHash: "a".repeat(64),
  commandName: "purchase_order.line.add",
  contractVersion: 1,
};

class MemoryCommandRepository implements FinancialCommandRepository<TestTransaction> {
  readonly claim: FinancialCommandClaim = {
    commandId: 73,
    leaseToken: "lease-73",
  };

  readonly transaction: TestTransaction = { name: "command-transaction" };

  reservation: FinancialCommandReservation = {
    kind: "claimed",
    claim: this.claim,
  };

  executeBeforeWorkError: unknown;

  reserveCalls: FinancialCommandDescriptor[] = [];
  executeCalls: Array<{
    claim: FinancialCommandClaim;
    descriptor: FinancialCommandDescriptor;
  }> = [];
  successfulWorkResults: FinancialCommandSuccess<unknown>[] = [];
  rejectCalls: Array<{
    claim: FinancialCommandClaim;
    descriptor: FinancialCommandDescriptor;
    rejection: Extract<FinancialCommandFailureDisposition, { kind: "rejected" }>;
  }> = [];
  retryableCalls: Array<{
    claim: FinancialCommandClaim;
    descriptor: FinancialCommandDescriptor;
    failure: Extract<FinancialCommandFailureDisposition, { kind: "retryable" }>;
  }> = [];

  async reserve(command: FinancialCommandDescriptor): Promise<FinancialCommandReservation> {
    this.reserveCalls.push(command);
    return this.reservation;
  }

  async executeClaim<T>(
    claim: FinancialCommandClaim,
    command: FinancialCommandDescriptor,
    work: (tx: TestTransaction) => Promise<FinancialCommandSuccess<T>>,
  ): Promise<FinancialCommandResult<T>> {
    this.executeCalls.push({ claim, descriptor: command });
    if (this.executeBeforeWorkError !== undefined) {
      throw this.executeBeforeWorkError;
    }

    const success = await work(this.transaction);
    this.successfulWorkResults.push(success);
    return {
      commandId: claim.commandId,
      replayed: false,
      httpStatus: success.httpStatus,
      body: success.body,
      terminalState: "succeeded",
    };
  }

  async rejectClaim(
    claim: FinancialCommandClaim,
    command: FinancialCommandDescriptor,
    rejection: Extract<FinancialCommandFailureDisposition, { kind: "rejected" }>,
  ): Promise<FinancialCommandResult> {
    this.rejectCalls.push({ claim, descriptor: command, rejection });
    return {
      commandId: claim.commandId,
      replayed: false,
      httpStatus: rejection.httpStatus,
      body: rejection.body,
      terminalState: "rejected",
    };
  }

  async markRetryable(
    claim: FinancialCommandClaim,
    command: FinancialCommandDescriptor,
    failure: Extract<FinancialCommandFailureDisposition, { kind: "retryable" }>,
  ): Promise<void> {
    this.retryableCalls.push({ claim, descriptor: command, failure });
  }
}

describe("runTransactionalFinancialCommand", () => {
  it("returns a durable replay without invoking the command work", async () => {
    const repository = new MemoryCommandRepository();
    const replay: FinancialCommandResult = {
      commandId: 28,
      replayed: true,
      httpStatus: 201,
      body: { id: 901, status: "draft" },
      terminalState: "succeeded",
    };
    repository.reservation = { kind: "replay", result: replay };
    const work = vi.fn();

    const result = await runTransactionalFinancialCommand({
      repository,
      descriptor,
      work,
      classifyFailure: vi.fn(),
    });

    expect(result).toBe(replay);
    expect(work).not.toHaveBeenCalled();
    expect(repository.executeCalls).toHaveLength(0);
    expect(repository.rejectCalls).toHaveLength(0);
    expect(repository.retryableCalls).toHaveLength(0);
  });

  it("executes work in the claimed transaction and returns its stored success", async () => {
    const repository = new MemoryCommandRepository();
    const body = { id: 901, purchaseOrderId: 41 };
    const work = vi.fn(async (tx: TestTransaction) => {
      expect(tx).toBe(repository.transaction);
      return {
        httpStatus: 201,
        body,
        resultType: "purchase_order_line",
        resultId: 901,
      };
    });

    const result = await runTransactionalFinancialCommand({
      repository,
      descriptor,
      work,
      classifyFailure: vi.fn(),
    });

    expect(result).toEqual({
      commandId: 73,
      replayed: false,
      httpStatus: 201,
      body,
      terminalState: "succeeded",
    });
    expect(repository.reserveCalls).toEqual([descriptor]);
    expect(repository.executeCalls).toEqual([{ claim: repository.claim, descriptor }]);
    expect(repository.successfulWorkResults).toEqual([{
      httpStatus: 201,
      body,
      resultType: "purchase_order_line",
      resultId: 901,
    }]);
    expect(repository.rejectCalls).toHaveLength(0);
    expect(repository.retryableCalls).toHaveLength(0);
  });

  it("persists and returns the exact deterministic rejection", async () => {
    const repository = new MemoryCommandRepository();
    const domainError = new Error("ordered quantity exceeds the remaining quantity");
    const rejectedBody = {
      error: "Quantity exceeds remaining quantity",
      code: "PO_LINE_QUANTITY_EXCEEDED",
      details: { remaining: 5 },
    };
    const rejection = {
      kind: "rejected" as const,
      httpStatus: 422,
      body: rejectedBody,
      errorCode: "PO_LINE_QUANTITY_EXCEEDED",
      errorMessage: domainError.message,
    };
    const classifyFailure = vi.fn((error: unknown) => {
      expect(error).toBe(domainError);
      return rejection;
    });

    const result = await runTransactionalFinancialCommand({
      repository,
      descriptor,
      work: async () => {
        throw domainError;
      },
      classifyFailure,
    });

    expect(result).toEqual({
      commandId: 73,
      replayed: false,
      httpStatus: 422,
      body: rejectedBody,
      terminalState: "rejected",
    });
    expect(result.body).toBe(rejectedBody);
    expect(repository.rejectCalls).toEqual([{
      claim: repository.claim,
      descriptor,
      rejection,
    }]);
    expect(repository.retryableCalls).toHaveLength(0);
    expect(classifyFailure).toHaveBeenCalledOnce();
  });

  it("marks an unexpected failure retryable and rethrows the original error", async () => {
    const repository = new MemoryCommandRepository();
    const databaseError = new Error("connection reset");
    const failure = {
      kind: "retryable" as const,
      errorCode: "PO_LINE_COMMAND_FAILED",
      errorMessage: databaseError.message,
    };

    const command = runTransactionalFinancialCommand({
      repository,
      descriptor,
      work: async () => {
        throw databaseError;
      },
      classifyFailure: () => failure,
    });

    await expect(command).rejects.toBe(databaseError);
    expect(repository.retryableCalls).toEqual([{
      claim: repository.claim,
      descriptor,
      failure,
    }]);
    expect(repository.rejectCalls).toHaveLength(0);
  });

  it("never classifies or overwrites a result after losing lease ownership", async () => {
    const repository = new MemoryCommandRepository();
    const staleOwner = new FinancialCommandError(
      "Financial command lease is no longer owned by this worker",
      409,
      "FINANCIAL_COMMAND_STALE_OWNER",
    );
    repository.executeBeforeWorkError = staleOwner;
    const work = vi.fn();
    const classifyFailure = vi.fn();

    const command = runTransactionalFinancialCommand({
      repository,
      descriptor,
      work,
      classifyFailure,
    });

    await expect(command).rejects.toBe(staleOwner);
    expect(work).not.toHaveBeenCalled();
    expect(classifyFailure).not.toHaveBeenCalled();
    expect(repository.rejectCalls).toHaveLength(0);
    expect(repository.retryableCalls).toHaveLength(0);
  });

  it("rejects an invalid descriptor before reserving a durable claim", async () => {
    const repository = new MemoryCommandRepository();

    const command = runTransactionalFinancialCommand({
      repository,
      descriptor: { ...descriptor, requestHash: "NOT-A-SHA256" },
      work: vi.fn(),
      classifyFailure: vi.fn(),
    });

    await expect(command).rejects.toThrow(
      "Financial command requestHash must be a lowercase SHA-256 digest",
    );
    expect(repository.reserveCalls).toHaveLength(0);
    expect(repository.executeCalls).toHaveLength(0);
  });

  it("does not commit an invalid success result and sends it through failure handling", async () => {
    const repository = new MemoryCommandRepository();
    const classifyFailure = vi.fn((error: unknown) => ({
      kind: "retryable" as const,
      errorCode: "INVALID_COMMAND_RESULT",
      errorMessage: (error as Error).message,
    }));

    const command = runTransactionalFinancialCommand({
      repository,
      descriptor,
      work: async () => ({ httpStatus: 500, body: { id: 901 } }),
      classifyFailure,
    });

    await expect(command).rejects.toThrow(
      "Financial command success must use a 2xx HTTP status",
    );
    expect(repository.successfulWorkResults).toHaveLength(0);
    expect(classifyFailure).toHaveBeenCalledOnce();
    expect(repository.retryableCalls).toEqual([{
      claim: repository.claim,
      descriptor,
      failure: {
        kind: "retryable",
        errorCode: "INVALID_COMMAND_RESULT",
        errorMessage: "Financial command success must use a 2xx HTTP status",
      },
    }]);
  });
});
