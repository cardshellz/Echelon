import { z } from "zod";
import { custodyCommandIdentitySchema, verifyCustodyCommandResult, type VerifiedCustodyResult } from "@shared/procurement/receiving-quarantine-command";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { assertNoLegacyCustodyCommand } from "./receiving-quarantine-command-evidence.repository";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability";
import { ReceivingQuarantineError } from "./domain/receiving-quarantine";
import { executeReceivingCustodyCommand, validateCustodyCommandInput, type ReceivingCustodyCommand } from "./receiving-quarantine.service";
import type { CustodyTransaction } from "./receiving-quarantine.repository";
import type { ReceivingQuarantineReceivingPort } from "./receiving-quarantine-receiving.port";

export const CUSTODY_COMMAND_PRINCIPAL = "procurement.receiving-custody";
/** Public URLs stay stable; one durable namespace prevents cross-actor/action key reuse. */
export function custodyCommandScope() {
  return { method: "POST", routeTemplate: "/api/receiving/custody-command", resourceKey: "receiving:custody", commandName: "procurement.receiving.custody.command" };
}
export function custodyCommandRoute(command: ReceivingCustodyCommand): string {
  return command === "intake" ? "/api/receiving/:orderId/quarantine" : `/api/receiving/quarantine/:observationId/${command}`;
}
export function hashCustodyCommandIdentity(input: { command: ReceivingCustodyCommand; resourceId: number; body: unknown; actorId: string }): string {
  return hashHttpFinancialCommand({ ...custodyCommandScope(), body: input });
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
      const identity = custodyCommandIdentitySchema.parse({ command, resourceId, actorId, idempotencyKey: descriptor.idempotencyKey });
      const scope = custodyCommandScope();
      if (descriptor.actorType !== "service" || descriptor.actorId !== CUSTODY_COMMAND_PRINCIPAL || descriptor.method !== scope.method
        || descriptor.routeTemplate !== scope.routeTemplate || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName
        || descriptor.contractVersion !== 1 || descriptor.requestHash !== hashCustodyCommandIdentity({ command, resourceId, body, actorId })) {
        throw new FinancialCommandError("Custody command scope is invalid", 500, "RECEIVING_CUSTODY_SCOPE_INVALID");
      }
      const execution = await runTransactionalFinancialCommand({ repository, descriptor,
        classifyFailure: error => {
          const failure = classifyFailure(error);
          if (failure.kind !== "rejected") return failure;
          const original = failure.body as Record<string, unknown>;
          return { ...failure, body: { ...original, details: { ...(typeof original.details === "object" && original.details !== null ? original.details : {}),
            custodyCommandOutcome: "rejected", ...identity } } };
        },
        work: async tx => {
          await assertNoLegacyCustodyCommand(tx, descriptor.idempotencyKey);
          const result = await executeReceivingCustodyCommand(tx, receiving, { command, resourceId, body, actorId, at: clock(), commandKey: descriptor.idempotencyKey });
          let verified: VerifiedCustodyResult;
          try { verified = verifyCustodyCommandResult({ ...result, ...identity, request: body }, identity, body); }
          catch { throw new FinancialCommandError("The quarantine command returned incomplete recovery evidence.", 503, "RECEIVING_CUSTODY_RESULT_INVALID"); }
          return { httpStatus: 200, body: verified, resultType: "receiving_custody", resultId: verified.observation.id };
        },
      });
      if (execution.terminalState === "succeeded") {
        try {
          if (execution.httpStatus !== 200) throw new Error("Invalid success status");
          verifyCustodyCommandResult(execution.body, identity, body);
        } catch { throw new FinancialCommandError("The saved quarantine response needs review before recovery can continue.", 503, "RECEIVING_CUSTODY_RESULT_INVALID"); }
      } else {
        const rejected = z.object({ details: z.object({ custodyCommandOutcome: z.literal("rejected"),
          command: z.literal(command), resourceId: z.literal(resourceId), actorId: z.literal(actorId), idempotencyKey: z.literal(descriptor.idempotencyKey),
        }).passthrough() }).passthrough().safeParse(execution.body);
        if (!rejected.success || execution.httpStatus < 400 || execution.httpStatus >= 500) throw new FinancialCommandError("The saved quarantine rejection needs review.", 503, "RECEIVING_CUSTODY_RESULT_INVALID");
      }
      return execution;
    },
  };
}
