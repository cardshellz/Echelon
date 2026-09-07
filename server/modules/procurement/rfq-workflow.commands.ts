import { z } from "zod";
import { rfqResourceIdSchema } from "@shared/procurement/rfq-workflow";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { PurchasingError } from "./purchasing.service";
import { RfqWorkflowError, type RfqWorkflowCommand, type RfqWorkflowService, type RfqWorkflowTransaction } from "./rfq-workflow.service";

export const RFQ_WORKFLOW_COMMAND_PRINCIPAL = "procurement.rfq-workflow";

export function rfqWorkflowCommandScope(command: RfqWorkflowCommand) {
  rfqResourceIdSchema.parse(command.rfqId);
  if (command.operation === "capture_quote") rfqResourceIdSchema.parse(command.lineId);
  return {
    method: "POST",
    routeTemplate: command.operation === "capture_quote" ? "/api/purchasing/rfqs/:rfqId/lines/:lineId/quotes" : "/api/purchasing/rfqs/:rfqId/convert",
    resourceKey: command.operation === "capture_quote" ? `rfq:${command.rfqId}:line:${command.lineId}` : `rfq:${command.rfqId}`,
    commandName: `procurement.rfq.${command.operation}`,
  };
}

export function classifyRfqWorkflowFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof z.ZodError) {
    const message = "Invalid RFQ command: " + error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    return { kind: "rejected", httpStatus: 400, body: { code: "RFQ_INPUT_INVALID", error: message }, errorCode: "RFQ_INPUT_INVALID", errorMessage: message };
  }
  if ((error instanceof RfqWorkflowError || error instanceof PurchasingError) && error.statusCode >= 400 && error.statusCode < 500) {
    const code = error instanceof RfqWorkflowError ? error.code : String(error.details?.code ?? "RFQ_PO_CREATE_REJECTED");
    return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message }, errorCode: code, errorMessage: error.message };
  }
  return { kind: "retryable", errorCode: "RFQ_TRANSIENT_FAILURE", errorMessage: "RFQ workflow transaction did not commit; retry with the same command key." };
}

export function createRfqWorkflowCommands(
  service: Pick<RfqWorkflowService, "executeInTransaction">,
  repository: FinancialCommandRepository<RfqWorkflowTransaction> = financialCommandRepository,
  clock: () => Date = () => new Date(),
) {
  return {
    async execute(command: RfqWorkflowCommand, actorId: string, descriptor: FinancialCommandDescriptor) {
      if (typeof actorId !== "string" || !actorId.trim()) throw new FinancialCommandError("An authenticated actor is required", 401, "RFQ_ACTOR_REQUIRED");
      const scope = rfqWorkflowCommandScope(command);
      if (descriptor.actorType !== "service" || descriptor.actorId !== RFQ_WORKFLOW_COMMAND_PRINCIPAL || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName) throw new FinancialCommandError("RFQ workflow command scope is invalid", 500, "RFQ_SCOPE_INVALID");
      return runTransactionalFinancialCommand({
        repository, descriptor, classifyFailure: classifyRfqWorkflowFailure,
        work: async (tx) => ({ httpStatus: command.operation === "convert" ? 201 : 200, body: await service.executeInTransaction(tx, command, actorId, clock(), descriptor.idempotencyKey) }),
      });
    },
  };
}
