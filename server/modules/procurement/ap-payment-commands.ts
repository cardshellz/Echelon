import { DocumentNumberError } from "../../platform/document-numbering/document-number";
import { SupplierCreditEvidenceError } from "./supplier-credit-settlement.repository";
import { readLegacyPaymentCommandIdentities, resolveApPaymentCommandIdentity, type LegacyPaymentCommandLookup } from "./ap-payment-command-identity";
import { paymentApplicationResultSchema, recordPaymentResultSchema, voidPaymentResultSchema } from "@shared/procurement/ap-payment-contract";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import {
  runTransactionalFinancialCommand,
  FinancialCommandError,
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
  if (error instanceof DocumentNumberError) {
    return rejection(error.statusCode, error.message, error.code, { code: error.code });
  }
  if ((error instanceof ApLedgerError || error instanceof SupplierCreditEvidenceError) && error.statusCode >= 400 && error.statusCode <= 499) {
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

function validatePaymentReceipt(command: ApPaymentFinancialCommand, input: ApLedgerCommandInput, descriptor: FinancialCommandDescriptor, raw: unknown, paymentId?: number) {
  const saved = command === "record_payment" ? recordPaymentResultSchema.parse(raw)
    : command === "apply_payment" ? paymentApplicationResultSchema.parse(raw) : voidPaymentResultSchema.parse(raw);
  const fail = () => { throw new FinancialCommandError("The saved payment response does not match the reviewed request. Keep its request key and review recovery.", 500, "AP_PAYMENT_RESULT_INVALID"); };
  if (saved.command !== command || saved.actorId !== descriptor.actorId || saved.idempotencyKey !== descriptor.idempotencyKey
    || (command !== "record_payment" && saved.paymentId !== paymentId)) fail();
  const matchApplications = (actual: readonly { allocationId: number; vendorInvoiceId: number; appliedAmountCents: number }[], expected: readonly { vendorInvoiceId: number; appliedAmountCents: number }[]) => {
    if (new Set(actual.map(row => row.allocationId)).size !== actual.length || actual.length !== expected.length) return false;
    const keys = (rows: readonly { vendorInvoiceId: number; appliedAmountCents: number }[]) => rows.map(row => `${row.vendorInvoiceId}:${row.appliedAmountCents}`).sort().join("|");
    return keys(actual) === keys(expected);
  };
  if (command === "record_payment") {
    const record = recordPaymentResultSchema.parse(saved);
    const expected = input.payment;
    if (!expected || record.id !== record.paymentId || record.vendorId !== expected.vendorId || record.totalAmountCents !== expected.totalAmountCents
      || record.paymentMethod !== expected.paymentMethod || record.paymentDate !== expected.paymentDate.toISOString()
      || record.paymentCalendarDate !== (expected.paymentCalendarDate ?? null)
      || record.paymentDateSource !== (expected.paymentCalendarDate == null ? "legacy_timestamp" : "recorded_calendar_date")
      || record.referenceNumber !== (expected.referenceNumber ?? null) || record.checkNumber !== (expected.checkNumber ?? null)
      || record.bankAccountLabel !== (expected.bankAccountLabel ?? null) || record.notes !== (expected.notes ?? null)
      || !matchApplications(record.applications, expected.allocations)) fail();
    const sum = record.applications.reduce((total, row) => total + BigInt(row.appliedAmountCents), BigInt(0));
    if (!["available", "fully_applied"].includes(record.paymentBalance.state) || record.paymentBalance.appliedAmountCents === null
      || record.paymentBalance.unappliedAmountCents === null || BigInt(record.paymentBalance.appliedAmountCents) !== sum
      || sum + BigInt(record.paymentBalance.unappliedAmountCents) !== BigInt(record.totalAmountCents)) fail();
  } else if (command === "apply_payment") {
    const application = paymentApplicationResultSchema.parse(saved);
    if (!input.application || !matchApplications(application.applications, input.application.allocations)
      || !["available", "fully_applied"].includes(application.paymentBalance.state)) fail();
  }
  return saved;
}

export function createApPaymentCommands(
  repository: FinancialCommandRepository<ApLedgerDbClient> = financialCommandRepository,
  clock: () => Date = () => new Date(),
  legacyLookup: LegacyPaymentCommandLookup = readLegacyPaymentCommandIdentities,
) {
  async function execute(
    command: ApPaymentFinancialCommand,
    input: ApLedgerCommandInput,
    descriptor: FinancialCommandDescriptor,
    httpStatus: 200 | 201,
    fallbackResultId?: number,
  ) {
    const boundDescriptor = await resolveApPaymentCommandIdentity(descriptor, command, legacyLookup);
    const result = await runTransactionalFinancialCommand({
      repository,
      descriptor: boundDescriptor,
      classifyFailure: error => {
        const disposition = classifyApPaymentCommandFailure(error);
        if (disposition.kind !== "rejected") return disposition;
        const body = disposition.body as { error: string; details?: Record<string, unknown> };
        return { ...disposition, body: { ...body, details: { ...body.details,
          paymentCommandOutcome: "rejected", command, actorId: descriptor.actorId, idempotencyKey: descriptor.idempotencyKey } } };
      },
      work: async (tx) => {
        const value = await executeApPaymentCommandInTransaction(command,
          { ...input, ...(input.payment ? { payment: { ...input.payment, createdBy: descriptor.actorId } } : {}), userId: descriptor.actorId, now: clock() }, tx);
        const bodyResultId = command === "record_payment" && "id" in value ? value.id : fallbackResultId;
        if (!Number.isInteger(bodyResultId)) {
          throw new Error(`${command} result did not include a payment id`);
        }
        const rawBody = { ...value, command, paymentId: bodyResultId, actorId: descriptor.actorId, idempotencyKey: descriptor.idempotencyKey };
        // Validate the exact JSON representation saved and sent, including Date serialization.
        const serialized = JSON.parse(JSON.stringify(rawBody));
        const body = validatePaymentReceipt(command, input, descriptor, serialized, fallbackResultId);
        return {
          httpStatus,
          body,
          resultType: "ap_payment",
          resultId: bodyResultId,
        };
      },
    }).catch(error => {
      if (error && typeof error === "object" && "constraint" in error && error.constraint === "financial_command_ap_payment_identity_guard")
        throw new FinancialCommandError("This payment request key belongs to another recorded request. Review the original payment before continuing.", 409, "AP_PAYMENT_KEY_REVIEW");
      throw error;
    });

    // Legacy exact-key replay keeps its original response. Every response created in
    // the unified namespace must retain the bound actor, operation and economics.
    if (boundDescriptor !== descriptor) {
      if (result.terminalState === "succeeded") validatePaymentReceipt(command, input, descriptor, result.body, fallbackResultId);
      else {
        const body = result.body as { details?: Record<string, unknown> };
        if (result.httpStatus < 400 || result.httpStatus >= 500 || body?.details?.paymentCommandOutcome !== "rejected"
          || body.details.command !== command || body.details.actorId !== descriptor.actorId || body.details.idempotencyKey !== descriptor.idempotencyKey)
          throw new FinancialCommandError("The saved payment rejection needs review before recovery can continue.", 500, "AP_PAYMENT_RESULT_INVALID");
      }
    }
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

    applyPayment(paymentId: number, input: ApLedgerCommandInput, descriptor: FinancialCommandDescriptor) {
      return execute("apply_payment", { ...input, paymentId }, descriptor, 200, paymentId);
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
