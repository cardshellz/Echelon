import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import {
  runTransactionalFinancialCommand,
  type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition,
  type FinancialCommandRepository,
} from "../../platform/commands/transactional-command.service";
import {
  ApLedgerError,
  executeApInvoiceCommandInTransaction,
  runApInvoiceCommandPostCommit,
  type ApInvoiceFinancialCommand,
  type ApLedgerCommandInput,
  type ApLedgerDbClient,
} from "./ap-ledger.service";

export function classifyApInvoiceCommandFailure(
  error: unknown,
): FinancialCommandFailureDisposition {
  if (error instanceof ApLedgerError && error.statusCode >= 400 && error.statusCode <= 499) {
    return {
      kind: "rejected",
      httpStatus: error.statusCode,
      body: { error: error.message, ...(error.details ? { details: error.details } : {}) },
      errorCode: String(error.details?.code ?? "AP_INVOICE_COMMAND_REJECTED"),
      errorMessage: error.message,
    };
  }

  const pgCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (pgCode === "23503" || pgCode === "23514") {
    return {
      kind: "rejected",
      httpStatus: 422,
      body: { error: "The invoice transition references invalid or incompatible AP records" },
      errorCode: "AP_INVOICE_REFERENCE_INVALID",
      errorMessage: "The invoice transition references invalid or incompatible AP records",
    };
  }

  return {
    kind: "retryable",
    errorCode: "AP_INVOICE_COMMAND_TRANSIENT_FAILURE",
    errorMessage: "AP invoice command failed before its transaction committed.",
  };
}

export function createApInvoiceCommands(
  repository: FinancialCommandRepository<ApLedgerDbClient> = financialCommandRepository,
) {
  async function execute(
    command: ApInvoiceFinancialCommand,
    invoiceId: number,
    input: ApLedgerCommandInput,
    descriptor: FinancialCommandDescriptor,
  ) {
    const result = await runTransactionalFinancialCommand({
      repository,
      descriptor,
      classifyFailure: classifyApInvoiceCommandFailure,
      work: async (tx) => ({
        httpStatus: 200,
        body: await executeApInvoiceCommandInTransaction(
          command,
          { ...input, invoiceId },
          tx,
        ),
        resultType: "vendor_invoice",
        resultId: invoiceId,
      }),
    });

    if (!result.replayed) {
      const outcome = (result.body as any)?.apLedgerOutcome;
      if (outcome) await runApInvoiceCommandPostCommit(outcome);
    }
    return result;
  }

  return {
    approveInvoice(
      invoiceId: number,
      input: ApLedgerCommandInput,
      descriptor: FinancialCommandDescriptor,
    ) {
      return execute("approve_invoice", invoiceId, input, descriptor);
    },
    disputeInvoice(
      invoiceId: number,
      input: ApLedgerCommandInput,
      descriptor: FinancialCommandDescriptor,
    ) {
      return execute("dispute_invoice", invoiceId, input, descriptor);
    },
    voidInvoice(
      invoiceId: number,
      input: ApLedgerCommandInput,
      descriptor: FinancialCommandDescriptor,
    ) {
      return execute("void_invoice", invoiceId, input, descriptor);
    },
  };
}

export const apInvoiceCommands = createApInvoiceCommands();
