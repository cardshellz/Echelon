import { z } from "zod";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability";
import { ReceivingQuarantineError } from "./domain/receiving-quarantine";
import { executeReceivingCustodyCommand, validateCustodyCommandInput, type ReceivingCustodyCommand } from "./receiving-quarantine.service";
import type { CustodyTransaction } from "./receiving-quarantine.repository";
import type { ReceivingQuarantineReceivingPort } from "./receiving-quarantine-receiving.port";

export function custodyCommandScope(command: ReceivingCustodyCommand, resourceId: number) {
  return {
    method: "POST",
    routeTemplate: command === "intake" ? "/api/receiving/:orderId/quarantine" : `/api/receiving/quarantine/:observationId/${command}`,
    resourceKey: `${command === "intake" ? "receiving_order" : "receiving_custody"}:${resourceId}`,
    commandName: `procurement.receiving.custody.${command.replace(/-/g, "_")}`,
  };
}
function classifyFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof ReceivingQuarantineError) {
    // Availability failures must not become permanent responses for a command
    // key. The client retains that exact intent until recovery confirms it.
    if (error.statusCode >= 500) {
      logger.error("receiving.custody.protection_unavailable", { error_code: error.code });
      return { kind: "retryable", errorCode: error.code, errorMessage: error.message };
    }
    return { kind: "rejected", httpStatus: error.statusCode,
      body: { error: error.message, code: error.code, details: error.details }, errorCode: error.code, errorMessage: error.message };
  }
  if (error instanceof z.ZodError) {
    logger.error("receiving.custody.evidence_invalid", { error_code: "RECEIVING_CUSTODY_EVIDENCE_INVALID",
      issues: error.issues.map(issue => ({ code: issue.code, path: issue.path.join(".") })) });
    return { kind: "rejected", httpStatus: 409,
    body: { error: "Stored receiving custody evidence is invalid. Review the source records.", code: "RECEIVING_CUSTODY_EVIDENCE_INVALID" },
    errorCode: "RECEIVING_CUSTODY_EVIDENCE_INVALID", errorMessage: "Stored custody evidence invalid" };
  }
  // Other receiving domain errors already expose safe, classified operator text.
  if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
    const details = "details" in error && typeof error.details === "object" && error.details !== null ? error.details : {};
    return { kind: "rejected", httpStatus: error.statusCode, body: { error: error.message, details },
      errorCode: "RECEIVING_CUSTODY_SOURCE_REJECTED", errorMessage: error.message };
  }
  logger.error("receiving.custody.transaction_failed", { error_code: "RECEIVING_CUSTODY_TRANSACTION_FAILED",
    error_type: error instanceof Error ? error.name : "unknown" });
  return { kind: "retryable", errorCode: "RECEIVING_CUSTODY_TRANSACTION_FAILED", errorMessage: "Custody transaction did not commit. Retry the same command key." };
}

export function createReceivingCustodyCommands(receiving: ReceivingQuarantineReceivingPort,
  repository: FinancialCommandRepository<CustodyTransaction> = financialCommandRepository, clock: () => Date = () => new Date()) {
  return {
    async execute(command: ReceivingCustodyCommand, resourceId: number, body: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      validateCustodyCommandInput(command, body);
      const scope = custodyCommandScope(command, resourceId);
      if (descriptor.actorType !== "user" || descriptor.actorId !== actorId || descriptor.method !== scope.method
        || descriptor.routeTemplate !== scope.routeTemplate || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName) {
        throw new FinancialCommandError("Custody command scope is invalid", 500, "RECEIVING_CUSTODY_SCOPE_INVALID");
      }
      return runTransactionalFinancialCommand({ repository, descriptor, classifyFailure,
        work: async tx => {
          const result = await executeReceivingCustodyCommand(tx, receiving, { command, resourceId, body, actorId, at: clock(), commandKey: descriptor.idempotencyKey });
          return { httpStatus: 200, body: result, resultType: "receiving_custody", resultId: result.observation.id };
        },
      });
    },
  };
}
