import { DocumentNumberError } from "../../platform/document-numbering/document-number";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { purchaseOrderEntryCommandSchema, purchaseOrderEntryCommandResultSchema, purchaseOrderEntryResultMatchesRequest,
  type PurchaseOrderEntryAction, type PurchaseOrderEntryCommand } from "@shared/procurement/purchase-order-entry-command";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { FINANCIAL_COMMAND_CONTRACT_VERSION, FinancialCommandError, runTransactionalFinancialCommand,
  type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { PurchasingError } from "./purchasing.service";
import { PurchaseOrderEntryError } from "./domain/purchase-order-entry";
import type { PurchaseOrderEntryTransaction } from "./purchase-order-entry.repository";

export const PURCHASE_ORDER_ENTRY_COMMAND_PRINCIPAL = "procurement.purchase-order-entry";
export function purchaseOrderEntryCommandScope() {
  return { method: "POST", routeTemplate: "/api/purchase-orders/entry-command", resourceKey: "purchase-order:entry", commandName: "procurement.purchase-order.entry" } as const;
}
export function hashPurchaseOrderEntryCommandIdentity(command: unknown, actorId: string): string {
  return hashHttpFinancialCommand({ ...purchaseOrderEntryCommandScope(), body: { command, actorId } });
}
interface PurchaseOrderEntryOwner {
  assertPurchaseEntryAuthority(action: PurchaseOrderEntryAction, actorId: string, key: string): Promise<void>;
  executePurchaseEntryInTransaction(tx: PurchaseOrderEntryTransaction, command: PurchaseOrderEntryCommand, actorId: string, key: string): Promise<Record<string, unknown>>;
}
export function classifyPurchaseOrderEntryFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof DocumentNumberError) {
    return { kind: "rejected", httpStatus: error.statusCode, body: { code: error.code, error: error.message }, errorCode: error.code, errorMessage: error.message };
  }
  if (error instanceof PurchasingError || error instanceof PurchaseOrderEntryError) {
    const code = error instanceof PurchaseOrderEntryError ? error.code : String(error.details?.code ?? "PURCHASE_ORDER_ENTRY_REJECTED");
    if (error.statusCode >= 400 && error.statusCode < 500
      && !["PURCHASE_ORDER_ENTRY_LEGACY_REVIEW_REQUIRED", "PO_NUMBER_ALLOCATION_EXHAUSTED"].includes(code)) {
      return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message }, errorCode: code, errorMessage: error.message };
    }
  }
  return { kind: "retryable", errorCode: "PURCHASE_ORDER_ENTRY_TRANSIENT_FAILURE", errorMessage: "The purchase order transaction did not commit. Retry the original request." };
}

export function createPurchaseOrderEntryCommands(service: PurchaseOrderEntryOwner,
  repository: FinancialCommandRepository<PurchaseOrderEntryTransaction> = financialCommandRepository) {
  return { async execute(command: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
    if (typeof actorId !== "string" || !actorId || actorId !== actorId.trim() || actorId.length > 100) {
      throw new FinancialCommandError("An authenticated purchasing operator is required", 401, "PURCHASE_ORDER_ENTRY_ACTOR_REQUIRED");
    }
    const scope = purchaseOrderEntryCommandScope();
    if (descriptor.actorType !== "service" || descriptor.actorId !== PURCHASE_ORDER_ENTRY_COMMAND_PRINCIPAL
      || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate || descriptor.resourceKey !== scope.resourceKey
      || descriptor.commandName !== scope.commandName || descriptor.contractVersion !== FINANCIAL_COMMAND_CONTRACT_VERSION
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/.test(descriptor.idempotencyKey)) {
      throw new FinancialCommandError("Purchase order command scope is invalid", 500, "PURCHASE_ORDER_ENTRY_SCOPE_INVALID");
    }
    if (descriptor.requestHash !== hashPurchaseOrderEntryCommandIdentity(command, actorId)) {
      throw new FinancialCommandError("Purchase order identity does not match its request", 500, "PURCHASE_ORDER_ENTRY_IDENTITY_INVALID");
    }
    const requested = purchaseOrderEntryCommandSchema.safeParse(command);
    if (!requested.success) throw new FinancialCommandError("Purchase order command envelope is invalid", 400, "PURCHASE_ORDER_ENTRY_INPUT_INVALID");
    try { await service.assertPurchaseEntryAuthority(requested.data.action, actorId, descriptor.idempotencyKey); }
    catch (error) {
      if (error instanceof PurchaseOrderEntryError) throw new FinancialCommandError(error.message, error.statusCode, error.code);
      throw error;
    }
    const status = requested.data.action === "create" || requested.data.action === "duplicate" ? 201 : 200;
    const result = await runTransactionalFinancialCommand({ repository, descriptor,
      classifyFailure(error) {
        const failure = classifyPurchaseOrderEntryFailure(error);
        return failure.kind === "rejected" ? { ...failure, body: { ...(failure.body as Record<string, unknown>),
          details: { purchaseOrderEntryOutcome: "rejected", idempotencyKey: descriptor.idempotencyKey,
            action: requested.data.action, targetId: requested.data.targetId, actorId, requestCanonical: canonicalJson(requested.data) } } } : failure;
      },
      async work(tx) {
        const saved = await service.executePurchaseEntryInTransaction(tx, requested.data, actorId, descriptor.idempotencyKey);
        const po = z.object({ id: z.number().int().positive() }).passthrough().parse(saved.po);
        const response = purchaseOrderEntryCommandResultSchema.safeParse({ ...JSON.parse(canonicalJson(saved)), entryCommand: {
          action: requested.data.action, targetId: requested.data.targetId, actorId, idempotencyKey: descriptor.idempotencyKey,
          purchaseOrderId: po.id, requestCanonical: canonicalJson(requested.data),
        } });
        if (!response.success || !purchaseOrderEntryResultMatchesRequest(response.data, requested.data, actorId)) {
          throw new PurchaseOrderEntryError("PURCHASE_ORDER_ENTRY_RESULT_INVALID", "Purchase order returned invalid recovery evidence.", 500);
        }
        return { httpStatus: status, body: response.data, resultType: "purchase_order_entry", resultId: po.id };
      },
    });
    if (result.terminalState === "succeeded") {
      const response = purchaseOrderEntryCommandResultSchema.safeParse(result.body);
      if (result.httpStatus !== status || !response.success || response.data.entryCommand.idempotencyKey !== descriptor.idempotencyKey
        || !purchaseOrderEntryResultMatchesRequest(response.data, requested.data, actorId)) {
        throw new FinancialCommandError("The saved purchase order response requires review", 500, "PURCHASE_ORDER_ENTRY_RESULT_INVALID");
      }
    } else {
      const rejected = z.object({ code: z.string().min(1), error: z.string().min(1), details: z.object({
        purchaseOrderEntryOutcome: z.literal("rejected"), idempotencyKey: z.literal(descriptor.idempotencyKey),
        action: z.literal(requested.data.action), targetId: requested.data.targetId === null ? z.null() : z.literal(requested.data.targetId),
        actorId: z.literal(actorId), requestCanonical: z.literal(canonicalJson(requested.data)),
      }).passthrough() }).passthrough().safeParse(result.body);
      if (!rejected.success || result.httpStatus < 400 || result.httpStatus >= 500) {
        throw new FinancialCommandError("The saved purchase order rejection requires review", 500, "PURCHASE_ORDER_ENTRY_RESULT_INVALID");
      }
    }
    // Reservation/replay may have waited on another worker. Do not expose its
    // terminal response if this operator's grant was revoked while waiting.
    try { await service.assertPurchaseEntryAuthority(requested.data.action, actorId, descriptor.idempotencyKey); }
    catch (error) {
      if (error instanceof PurchaseOrderEntryError) throw new FinancialCommandError(error.message, error.statusCode, error.code);
      throw error;
    }
    return result;
  } };
}
