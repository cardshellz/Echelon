import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { receivingEntryCommandSchema, receivingEntryCommandResultSchema, receivingEntryResultMatchesRequest, type ReceivingEntryCommand } from "@shared/procurement/receiving-entry-command";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { FINANCIAL_COMMAND_CONTRACT_VERSION, FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { ReceivingError } from "./receiving.service";
import { ReceivingEntryError } from "./domain/receiving-entry";
import { ReceivingCloseIntegrityError } from "./receiving-close-integrity.domain";
import type { ReceivingEntryTransaction } from "./receiving-entry.repository";

// One key means one operator's physical intent, across both endpoints and all
// receipts. Identical goods entered with different keys remain distinct batches.
export const RECEIVING_ENTRY_COMMAND_PRINCIPAL = "procurement.receiving-entry";
export function receivingEntryCommandScope() {
  return { method: "POST", routeTemplate: "/api/receiving/entry-command", resourceKey: "receiving:entry", commandName: "procurement.receiving.entry" } as const;
}
export function hashReceivingEntryCommandIdentity(command: unknown, actorId: string): string {
  return hashHttpFinancialCommand({ ...receivingEntryCommandScope(), body: { command, actorId } });
}

interface ReceivingEntryOwner {
  assertEntryAuthority(actorId: string): Promise<void>;
  executeEntryInTransaction(tx: ReceivingEntryTransaction, command: ReceivingEntryCommand, actorId: string, commandKey: string): Promise<{ order: unknown; receivingLineId: number | null }>;
}

export function classifyReceivingEntryFailure(error: unknown): FinancialCommandFailureDisposition {
  if ((error instanceof ReceivingError || error instanceof ReceivingEntryError || error instanceof ReceivingCloseIntegrityError)
    && error.statusCode >= 400 && error.statusCode < 500) {
    const code = error instanceof ReceivingEntryError ? error.code : String(error.details?.code ?? "RECEIVING_ENTRY_REJECTED");
    return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message }, errorCode: code, errorMessage: error.message };
  }
  const cause = error instanceof Error ? error.cause ?? error : error;
  const pg = cause && typeof cause === "object" ? cause as Record<string, unknown> : null;
  if (pg?.code === "23503" && pg.schema === "procurement" && ["receiving_orders", "receiving_lines"].includes(String(pg.table))) {
    const message = "A receiving reference is no longer available. Review the vendor, warehouse, product and location.";
    return { kind: "rejected", httpStatus: 422, body: { code: "RECEIVING_ENTRY_REFERENCE_INVALID", error: message }, errorCode: "RECEIVING_ENTRY_REFERENCE_INVALID", errorMessage: message };
  }
  return { kind: "retryable", errorCode: "RECEIVING_ENTRY_TRANSIENT_FAILURE", errorMessage: "Receiving entry failed before its transaction committed." };
}

export function createReceivingEntryCommands(service: ReceivingEntryOwner,
  repository: FinancialCommandRepository<ReceivingEntryTransaction> = financialCommandRepository) {
  return {
    async execute(command: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      if (typeof actorId !== "string" || !actorId || actorId !== actorId.trim() || actorId.length > 100) {
        throw new FinancialCommandError("An authenticated receiving operator is required", 401, "RECEIVING_ENTRY_ACTOR_REQUIRED");
      }
      const scope = receivingEntryCommandScope();
      if (descriptor.actorType !== "service" || descriptor.actorId !== RECEIVING_ENTRY_COMMAND_PRINCIPAL
        || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate || descriptor.resourceKey !== scope.resourceKey
        || descriptor.commandName !== scope.commandName || descriptor.contractVersion !== FINANCIAL_COMMAND_CONTRACT_VERSION
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/.test(descriptor.idempotencyKey)) {
        throw new FinancialCommandError("Receiving entry command scope is invalid", 500, "RECEIVING_ENTRY_SCOPE_INVALID");
      }
      if (descriptor.requestHash !== hashReceivingEntryCommandIdentity(command, actorId)) {
        throw new FinancialCommandError("Receiving entry identity does not match its request", 500, "RECEIVING_ENTRY_IDENTITY_INVALID");
      }
      // Do not reveal a previously saved result to a disabled or revoked actor.
      // New mutations lock and recheck the same current authority in their tx.
      try { await service.assertEntryAuthority(actorId); }
      catch (error) {
        if (error instanceof ReceivingEntryError) throw new FinancialCommandError(error.message, error.statusCode, error.code);
        throw error;
      }
      const result = await runTransactionalFinancialCommand({
        repository, descriptor,
        classifyFailure(error) {
          const failure = classifyReceivingEntryFailure(error);
          if (failure.kind !== "rejected") return failure;
          return { ...failure, body: { ...(failure.body as Record<string, unknown>),
            details: { receivingEntryOutcome: "rejected", idempotencyKey: descriptor.idempotencyKey } } };
        },
        async work(tx) {
          const parsed = receivingEntryCommandSchema.safeParse(command);
          if (!parsed.success) throw new ReceivingEntryError("RECEIVING_ENTRY_INPUT_INVALID",
            "Review the receiving entry: " + parsed.error.issues.map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "), 400);
          const requested = parsed.data;
          const saved = await service.executeEntryInTransaction(tx, requested, actorId, descriptor.idempotencyKey);
          const order = z.record(z.unknown()).safeParse(saved.order);
          const response = receivingEntryCommandResultSchema.safeParse(order.success ? {
            ...JSON.parse(canonicalJson(order.data)), entryCommand: { action: requested.action, targetId: requested.targetId,
              actorId, idempotencyKey: descriptor.idempotencyKey, receivingOrderId: order.data.id, receivingLineId: saved.receivingLineId },
          } : null);
          if (!response.success || !receivingEntryResultMatchesRequest(response.data, requested, actorId)) throw new ReceivingEntryError("RECEIVING_ENTRY_RESULT_INVALID", "Receiving entry returned an invalid recovery identity.", 500);
          return { httpStatus: 201, body: response.data, resultType: "receiving_entry", resultId: saved.receivingLineId ?? response.data.id };
        },
      });
      if (result.terminalState === "succeeded") {
        const response = receivingEntryCommandResultSchema.safeParse(result.body);
        const requested = receivingEntryCommandSchema.safeParse(command);
        if (result.httpStatus !== 201 || !response.success || !requested.success
          || response.data.entryCommand.action !== requested.data.action || response.data.entryCommand.targetId !== requested.data.targetId
          || response.data.entryCommand.actorId !== actorId || response.data.entryCommand.idempotencyKey !== descriptor.idempotencyKey
          || !receivingEntryResultMatchesRequest(response.data, requested.data, actorId)) {
          throw new FinancialCommandError("The saved receiving response needs review before recovery can continue", 500, "RECEIVING_ENTRY_RESULT_INVALID");
        }
      } else {
        const rejection = z.object({ code: z.string().min(1), error: z.string().min(1),
          details: z.object({ receivingEntryOutcome: z.literal("rejected"), idempotencyKey: z.literal(descriptor.idempotencyKey) }).passthrough(),
        }).passthrough().safeParse(result.body);
        if (!rejection.success || result.httpStatus < 400 || result.httpStatus >= 500) {
          throw new FinancialCommandError("The saved receiving rejection needs review before recovery can continue", 500, "RECEIVING_ENTRY_RESULT_INVALID");
        }
      }
      return result;
    },
  };
}
