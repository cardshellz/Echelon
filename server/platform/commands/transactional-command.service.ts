export const FINANCIAL_COMMAND_CONTRACT_VERSION = 1;

export type FinancialCommandActorType = "user" | "service" | "system";

export type FinancialCommandDescriptor = {
  actorType: FinancialCommandActorType;
  actorId: string;
  method: string;
  routeTemplate: string;
  resourceKey: string;
  idempotencyKey: string;
  requestHash: string;
  commandName: string;
  contractVersion: number;
};

export type FinancialCommandClaim = {
  commandId: number;
  leaseToken: string;
};

export type FinancialCommandResult<T = unknown> = {
  commandId: number;
  replayed: boolean;
  httpStatus: number;
  body: T;
  terminalState: "succeeded" | "rejected";
};

export type FinancialCommandSuccess<T = unknown> = {
  httpStatus: number;
  body: T;
  resultType?: string;
  resultId?: string | number;
};

export type FinancialCommandFailureDisposition =
  | {
      kind: "rejected";
      httpStatus: number;
      body: unknown;
      errorCode: string;
      errorMessage: string;
    }
  | {
      kind: "retryable";
      errorCode: string;
      errorMessage: string;
    };

export type FinancialCommandReservation =
  | { kind: "claimed"; claim: FinancialCommandClaim }
  | { kind: "replay"; result: FinancialCommandResult };

export interface FinancialCommandRepository<Transaction> {
  reserve(descriptor: FinancialCommandDescriptor): Promise<FinancialCommandReservation>;
  executeClaim<T>(
    claim: FinancialCommandClaim,
    descriptor: FinancialCommandDescriptor,
    work: (tx: Transaction) => Promise<FinancialCommandSuccess<T>>,
  ): Promise<FinancialCommandResult<T>>;
  rejectClaim(
    claim: FinancialCommandClaim,
    descriptor: FinancialCommandDescriptor,
    rejection: Extract<FinancialCommandFailureDisposition, { kind: "rejected" }>,
  ): Promise<FinancialCommandResult>;
  markRetryable(
    claim: FinancialCommandClaim,
    descriptor: FinancialCommandDescriptor,
    failure: Extract<FinancialCommandFailureDisposition, { kind: "retryable" }>,
  ): Promise<void>;
}

export class FinancialCommandError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
    public readonly responseHeaders?: Record<string, string>,
  ) {
    super(message);
    this.name = "FinancialCommandError";
  }
}

function assertDescriptor(descriptor: FinancialCommandDescriptor): void {
  if (!/^[a-f0-9]{64}$/.test(descriptor.requestHash)) {
    throw new TypeError("Financial command requestHash must be a lowercase SHA-256 digest");
  }
  if (!descriptor.actorId || !descriptor.routeTemplate || !descriptor.resourceKey) {
    throw new TypeError("Financial command scope is incomplete");
  }
  if (!descriptor.commandName || descriptor.contractVersion !== FINANCIAL_COMMAND_CONTRACT_VERSION) {
    throw new TypeError("Financial command contract identity is invalid");
  }
}

function assertSuccess<T>(success: FinancialCommandSuccess<T>): void {
  if (!Number.isInteger(success.httpStatus) || success.httpStatus < 200 || success.httpStatus > 299) {
    throw new TypeError("Financial command success must use a 2xx HTTP status");
  }
  if ((success.resultType === undefined) !== (success.resultId === undefined)) {
    throw new TypeError("Financial command resultType and resultId must be provided together");
  }
}

/**
 * Reserve a durable command lease, then execute the domain mutation and final
 * response record in one database transaction. A process crash before or
 * during the business transaction leaves only a reclaimable reservation.
 */
export async function runTransactionalFinancialCommand<Transaction, T>(input: {
  repository: FinancialCommandRepository<Transaction>;
  descriptor: FinancialCommandDescriptor;
  work: (tx: Transaction) => Promise<FinancialCommandSuccess<T>>;
  classifyFailure: (error: unknown) => FinancialCommandFailureDisposition;
}): Promise<FinancialCommandResult<T | unknown>> {
  assertDescriptor(input.descriptor);
  const reservation = await input.repository.reserve(input.descriptor);
  if (reservation.kind === "replay") {
    return reservation.result as FinancialCommandResult<T | unknown>;
  }

  try {
    return await input.repository.executeClaim(
      reservation.claim,
      input.descriptor,
      async (tx) => {
        const success = await input.work(tx);
        assertSuccess(success);
        return success;
      },
    );
  } catch (error) {
    // Ownership errors mean a newer worker already reclaimed or completed the
    // command. Never let a stale worker overwrite that worker's result.
    if (error instanceof FinancialCommandError && error.code === "FINANCIAL_COMMAND_STALE_OWNER") {
      throw error;
    }

    const disposition = input.classifyFailure(error);
    if (disposition.kind === "rejected") {
      return await input.repository.rejectClaim(
        reservation.claim,
        input.descriptor,
        disposition,
      ) as FinancialCommandResult<T | unknown>;
    }

    await input.repository.markRetryable(
      reservation.claim,
      input.descriptor,
      disposition,
    );
    throw error;
  }
}
