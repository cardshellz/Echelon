import { SupplierCreditEvidenceError } from "./supplier-credit-settlement.repository";
import { z } from "zod";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { MoneyInputError } from "@shared/money-read";
import { PoQuantityAmendmentError } from "./po-quantity-amendment.policy";
import { reviewInvoiceTransitionInTransaction } from "./ap-invoice-transition.service";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import {
  runTransactionalFinancialCommand,
  type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition,
  type FinancialCommandRepository,
} from "../../platform/commands/transactional-command.service";
import {
  ApLedgerError,
  runApInvoiceCommandPostCommit,
  type ApInvoiceFinancialCommand,
  type ApLedgerCommandInput,
  type ApLedgerDbClient,
} from "./ap-ledger.service";

export function classifyApInvoiceCommandFailure(
  error: unknown,
): FinancialCommandFailureDisposition {
  if (error instanceof z.ZodError) return { kind: "rejected", httpStatus: 400,
    body: { error: "Review the invoice action and add a reason.", details: { code: "AP_INVOICE_TRANSITION_INPUT_INVALID" } },
    errorCode: "AP_INVOICE_TRANSITION_INPUT_INVALID", errorMessage: "Invalid invoice transition review" };
  if (error instanceof CostEvidenceError || error instanceof MoneyInputError || error instanceof PoQuantityAmendmentError)
    return { kind: "rejected", httpStatus: error instanceof PoQuantityAmendmentError ? error.statusCode : 409,
      body: { error: error.message, details: { code: error.code } }, errorCode: error.code, errorMessage: error.message };
  if ((error instanceof ApLedgerError || error instanceof SupplierCreditEvidenceError) && error.statusCode >= 400 && error.statusCode <= 499) {
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
  clock: () => Date = () => new Date(),
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
      work: async (tx) => {
        // A committed legacy receipt replays before new review requirements.
        // New requests must have one authenticated, correctly scoped intent.
        const action = command === "approve_invoice" ? "approve" : command === "dispute_invoice" ? "dispute" : "void";
        if (!input.userId || descriptor.actorId !== input.userId || descriptor.actorType !== "user"
          || descriptor.method !== "POST" || descriptor.routeTemplate !== `/api/vendor-invoices/:id/${action}`
          || descriptor.commandName !== `ap.invoice.${action}` || descriptor.resourceKey !== `vendor_invoice:${invoiceId}`)
          throw new ApLedgerError("Invoice transition command scope is invalid", 400, { code: "AP_INVOICE_TRANSITION_SCOPE_INVALID" });
        const reviewed = await reviewInvoiceTransitionInTransaction(tx as AmendmentTransaction, invoiceId, action,
          input.transitionReview, input.userId, clock(), descriptor.idempotencyKey);
        return {
          httpStatus: 200,
          body: reviewed.result,
          resultType: "vendor_invoice",
          resultId: invoiceId,
        };
      },
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
