import { createHash } from "node:crypto";
import { z } from "zod";
import { IntegrityError, ValidationError } from "@shared/errors";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { receiptReversalCommandResultSchema, receiptReversalIdSchema, receiptReversalLineBodySchema, receiptReversalOrderBodySchema, type ReceiptReversalAction } from "@shared/procurement/receipt-reversal-command";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { FINANCIAL_COMMAND_CONTRACT_VERSION, FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { readReversalKeyEvidence } from "./receipt-reversal.repository";
import { ReceivingUnitSnapshotError } from "./receiving-unit-snapshot";
import { ReceiptReversalError, reversalEvidenceReviewRequired, type ReceiptReversalTransaction, type ReverseLineParams, type ReverseOrderParams, type ReversalLineResult, type ReversalResult } from "./receipt-reversal.service";

// One namespace makes a reversal key identify one intent across operator,
// action and target. The authenticated operator is in the exact request hash.
export const RECEIPT_REVERSAL_COMMAND_PRINCIPAL = "procurement.receipt-reversal";
export function receiptReversalCommandScope() {
  return { method: "POST", routeTemplate: "/api/receiving/reversal-command", resourceKey: "receipt:reversal", commandName: "procurement.receipt.reverse" } as const;
}
export function hashReceiptReversalCommandIdentity(input: { action: ReceiptReversalAction; targetId: number; body: unknown; actorId: string }): string {
  return hashHttpFinancialCommand({ ...receiptReversalCommandScope(), body: input });
}
export function receiptReversalStorageKey(idempotencyKey: string): string {
  // Existing audit keys have a varchar(100) limit. Hash only the immutable raw
  // command key, not mutable receipt state; a line suffix still fits the column.
  return `rr:v1:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}
interface ReceiptReversalOwner {
  reverseReceivingLineInTransaction(tx: ReceiptReversalTransaction, input: ReverseLineParams): Promise<ReversalLineResult>;
  reverseReceivingOrderInTransaction(tx: ReceiptReversalTransaction, input: ReverseOrderParams): Promise<ReversalResult>;
}
export function classifyReceiptReversalFailure(error: unknown): FinancialCommandFailureDisposition {
  // These are concrete operational errors from the existing inventory owner.
  // Unknown exceptions and internal schema failures remain retryable.
  if (error instanceof ValidationError || error instanceof IntegrityError || error instanceof CostEvidenceError) {
    return { kind: "rejected", httpStatus: error.statusCode, body: { code: error.code, error: error.message, details: error.context }, errorCode: error.code, errorMessage: error.message };
  }
  if ((error instanceof ReceiptReversalError || error instanceof ReceivingUnitSnapshotError) && error.statusCode >= 400 && error.statusCode < 500) {
    const code = String(error.details?.code ?? "RECEIPT_REVERSAL_REJECTED");
    return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message, details: error.details }, errorCode: code, errorMessage: error.message };
  }
  return { kind: "retryable", errorCode: "RECEIPT_REVERSAL_TRANSIENT_FAILURE", errorMessage: "Receipt reversal failed before its transaction committed." };
}
export function createReceiptReversalCommands(service: ReceiptReversalOwner, repository: FinancialCommandRepository<ReceiptReversalTransaction> = financialCommandRepository) {
  return {
    async execute(action: ReceiptReversalAction, targetId: number, body: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      if (typeof actorId !== "string" || actorId !== actorId.trim() || !actorId || actorId.length > 100) throw new FinancialCommandError("An authenticated reversal operator is required", 401, "RECEIPT_REVERSAL_ACTOR_REQUIRED");
      const scope = receiptReversalCommandScope();
      if (descriptor.actorType !== "service" || descriptor.actorId !== RECEIPT_REVERSAL_COMMAND_PRINCIPAL
        || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate || descriptor.resourceKey !== scope.resourceKey
        || descriptor.commandName !== scope.commandName || descriptor.contractVersion !== FINANCIAL_COMMAND_CONTRACT_VERSION
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/.test(descriptor.idempotencyKey)) throw new FinancialCommandError("Receipt reversal command scope is invalid", 500, "RECEIPT_REVERSAL_SCOPE_INVALID");
      if (descriptor.requestHash !== hashReceiptReversalCommandIdentity({ action, targetId, body, actorId })) throw new FinancialCommandError("Receipt reversal command identity differs from its request", 500, "RECEIPT_REVERSAL_IDENTITY_INVALID");
      const execution = await runTransactionalFinancialCommand({
        repository, descriptor,
        classifyFailure: (error) => {
          const failure = classifyReceiptReversalFailure(error);
          if (failure.kind !== "rejected") return failure;
          const original = failure.body as { code: string; error: string; details?: Record<string, unknown> };
          return { ...failure, body: { ...original, details: { ...original.details, receiptReversalOutcome: "rejected", idempotencyKey: descriptor.idempotencyKey } } };
        },
        work: async (tx) => {
          const target = receiptReversalIdSchema.safeParse(targetId);
          const input = action === "line" ? receiptReversalLineBodySchema.safeParse(body) : action === "order" ? receiptReversalOrderBodySchema.safeParse(body) : z.never().safeParse(action);
          if (!target.success || !input.success) throw new ReceiptReversalError("Review the receipt reversal quantity, reason and override.", 400, { code: "RECEIPT_REVERSAL_INPUT_INVALID" });
          const requested = input.data;
          await lockInventoryCostGraph(tx);
          const storageKey = receiptReversalStorageKey(descriptor.idempotencyKey);
          // No legacy row records the complete command response. Without this
          // ledger reservation's saved result, all existing evidence blocks new
          // compensation rather than being guessed into a successful response.
          if ((await readReversalKeyEvidence(tx, descriptor.idempotencyKey)).length > 0
            || (await readReversalKeyEvidence(tx, storageKey)).length > 0) throw reversalEvidenceReviewRequired();
          const common = { reason: requested.reason, allowNegative: requested.allowNegative, userId: actorId, idempotencyKey: storageKey };
          const result = action === "line"
            ? await service.reverseReceivingLineInTransaction(tx, { ...common, receivingLineId: targetId, qty: receiptReversalLineBodySchema.parse(body).qty })
            : await service.reverseReceivingOrderInTransaction(tx, { ...common, receivingOrderId: targetId });
          const response = receiptReversalCommandResultSchema.safeParse({ ...result, action, targetId, actorId, idempotencyKey: descriptor.idempotencyKey });
          if (!response.success || (response.data.action === "line" && response.data.qty !== receiptReversalLineBodySchema.parse(body).qty)) throw new ReceiptReversalError("Receipt reversal returned an invalid recovery identity", 500, { code: "RECEIPT_REVERSAL_RESULT_INVALID" });
          return { httpStatus: 200, body: response.data, resultType: "receipt_reversal", resultId: response.data.action === "line" ? response.data.reversalId : response.data.reversals[0].reversalId };
        },
      });
      if (execution.terminalState === "succeeded") {
        const saved = receiptReversalCommandResultSchema.safeParse(execution.body);
        if (execution.httpStatus !== 200 || !saved.success || saved.data.action !== action || saved.data.targetId !== targetId
          || saved.data.actorId !== actorId || saved.data.idempotencyKey !== descriptor.idempotencyKey
          || (saved.data.action === "line" && saved.data.qty !== receiptReversalLineBodySchema.parse(body).qty)) {
          throw new FinancialCommandError("The saved reversal response needs review before recovery can continue", 500, "RECEIPT_REVERSAL_RESULT_INVALID");
        }
      }
      if (execution.terminalState === "rejected") {
        const rejected = z.object({
          code: z.string().min(1), error: z.string().min(1),
          details: z.object({ receiptReversalOutcome: z.literal("rejected"), idempotencyKey: z.literal(descriptor.idempotencyKey) }).passthrough(),
        }).passthrough().safeParse(execution.body);
        if (!rejected.success || execution.httpStatus < 400 || execution.httpStatus >= 500) throw new FinancialCommandError("The saved reversal rejection needs review before recovery can continue", 500, "RECEIPT_REVERSAL_RESULT_INVALID");
      }
      return execution;
    },
  };
}
