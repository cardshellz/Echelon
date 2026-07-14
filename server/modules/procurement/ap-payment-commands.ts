import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import {
  runTransactionalFinancialCommand,
  type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition,
  type FinancialCommandRepository,
} from "../../platform/commands/transactional-command.service";
import {
  ApLedgerError,
  executeApPaymentCommandInTransaction,
  runApPaymentCommandPostCommit,
  type ApLedgerCommandInput,
  type ApLedgerDbClient,
  type ApPaymentFinancialCommand,
} from "./ap-ledger.service";

function rejection(
  httpStatus: number,
  message: string,
  errorCode: string,
  details?: Record<string, unknown>,
): FinancialCommandFailureDisposition {
  return {
    kind: "rejected",
    httpStatus,
    body: { error: message, ...(details ? { details } : {}) },
    errorCode,
    errorMessage: message,
  };
}

export function classifyApPaymentCommandFailure(
  error: unknown,
): FinancialCommandFailureDisposition {
  if (error instanceof ApLedgerError && error.statusCode >= 400 && error.statusCode <= 499) {
    return rejection(
      error.statusCode,
      error.message,
      String(error.details?.code ?? "AP_PAYMENT_COMMAND_REJECTED"),
      error.details,
    );
  }

  const pgCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (pgCode === "23503" || pgCode === "23514") {
    return rejection(
      422,
      "The payment references invalid or incompatible AP records",
      "AP_PAYMENT_REFERENCE_INVALID",
    );
  }

  return {
    kind: "retryable",
    errorCode: "AP_PAYMENT_COMMAND_TRANSIENT_FAILURE",
    errorMessage: "AP payment command failed before its transaction committed.",
  };
}

export function createApPaymentCommands(
  repository: FinancialCommandRepository<ApLedgerDbClient> = financialCommandRepository,
) {
  async function execute(
    command: ApPaymentFinancialCommand,
    input: ApLedgerCommandInput,
    descriptor: FinancialCommandDescriptor,
    httpStatus: 200 | 201,
    fallbackResultId?: number,
  ) {
    const result = await runTransactionalFinancialCommand({
      repository,
      descriptor,
      classifyFailure: classifyApPaymentCommandFailure,
      work: async (tx) => {
        const body = await executeApPaymentCommandInTransaction(command, input, tx);
        const bodyResultId = command === "record_payment" && "id" in body
          ? body.id
          : fallbackResultId;
        if (!Number.isInteger(bodyResultId)) {
          throw new Error(`${command} result did not include a payment id`);
        }
        return {
          httpStatus,
          body,
          resultType: "ap_payment",
          resultId: bodyResultId,
        };
      },
    });

    if (!result.replayed) {
      const outcome = (result.body as any)?.apLedgerOutcome;
      if (outcome) await runApPaymentCommandPostCommit(outcome);
    }
    return result;
  }

  return {
    recordPayment(
      input: ApLedgerCommandInput,
      descriptor: FinancialCommandDescriptor,
    ) {
      return execute("record_payment", input, descriptor, 201);
    },

    voidPayment(
      paymentId: number,
      input: ApLedgerCommandInput,
      descriptor: FinancialCommandDescriptor,
    ) {
      return execute("void_payment", { ...input, paymentId }, descriptor, 200, paymentId);
    },
  };
}

export const apPaymentCommands = createApPaymentCommands();
