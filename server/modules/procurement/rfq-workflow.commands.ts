import { z } from "zod";
import { rfqResourceIdSchema } from "@shared/procurement/rfq-workflow";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  matchesRfqCommandReceipt,
  rfqCommandIntentSchema,
  rfqCommandReceiptSchema,
} from "@shared/procurement/rfq-command";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import {
  FinancialCommandError,
  runTransactionalFinancialCommand,
  type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition,
  type FinancialCommandRepository,
  type FinancialCommandResult,
} from "../../platform/commands/transactional-command.service";
import { PurchasingError } from "./purchasing.service";
import { DocumentNumberError } from "../../platform/document-numbering/document-number";
import { RfqWorkflowError, type RfqWorkflowCommand, type RfqWorkflowService, type RfqWorkflowTransaction } from "./rfq-workflow.service";

export const RFQ_WORKFLOW_COMMAND_PRINCIPAL = "procurement.rfq-workflow";

function rawIntent(command: RfqWorkflowCommand) {
  return {
    operation: command.operation,
    rfqId: command.rfqId,
    ...(command.operation === "capture_quote" ? { lineId: command.lineId } : {}),
    payload: command.body,
  };
}

export function bindRfqWorkflowCommandIdentity(
  command: RfqWorkflowCommand,
  actorId: string,
  descriptor: FinancialCommandDescriptor,
): FinancialCommandDescriptor {
  // Preserve the original uniqueness scope. An existing legacy key then fails
  // its hash comparison instead of creating a second command in a new namespace.
  return {
    ...descriptor,
    requestHash: hashHttpFinancialCommand({
      ...rfqWorkflowCommandScope(command),
      body: { actorId, intent: rawIntent(command), rawRequestHash: descriptor.requestHash },
    }),
  };
}

function invalidReceipt(): never {
  throw new FinancialCommandError(
    "The saved RFQ response does not prove this request. Retain the original command key.",
    500,
    "RFQ_COMMAND_RECEIPT_INVALID",
  );
}

export function validateRfqWorkflowReceipt(
  result: Pick<FinancialCommandResult, "body" | "httpStatus" | "terminalState">,
  command: RfqWorkflowCommand,
  actorId: string,
  idempotencyKey: string,
): void {
  const intent = rfqCommandIntentSchema.safeParse(rawIntent(command));
  if (result.terminalState === "succeeded") {
    if (!intent.success || result.httpStatus !== (command.operation === "convert" ? 201 : 200)
        || !matchesRfqCommandReceipt(result.body, { actorId, idempotencyKey, intent: intent.data })) {
      invalidReceipt();
    }
    return;
  }
  const rejection = z.object({
    details: z.object({
      rfqCommandOutcome: z.literal("rejected"),
      actorId: z.literal(actorId),
      idempotencyKey: z.literal(idempotencyKey),
      intent: z.unknown(),
    }).strict(),
  }).safeParse(result.body);
  if (result.terminalState !== "rejected" || result.httpStatus < 400 || result.httpStatus >= 500
      || !rejection.success
      || canonicalJson(rejection.data.details.intent) !== canonicalJson(intent.success ? intent.data : rawIntent(command))) {
    invalidReceipt();
  }
}

export function rfqWorkflowCommandScope(command: RfqWorkflowCommand) {
  rfqResourceIdSchema.parse(command.rfqId);
  if (command.operation === "capture_quote") rfqResourceIdSchema.parse(command.lineId);
  return {
    method: "POST",
    routeTemplate: command.operation === "capture_quote" ? "/api/purchasing/rfqs/:rfqId/lines/:lineId/quotes" : command.operation === "release" ? "/api/purchasing/rfqs/:rfqId/release" : "/api/purchasing/rfqs/:rfqId/convert",
    resourceKey: command.operation === "capture_quote" ? `rfq:${command.rfqId}:line:${command.lineId}` : `rfq:${command.rfqId}`,
    commandName: `procurement.rfq.${command.operation}`,
  };
}

export function classifyRfqWorkflowFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof z.ZodError) {
    const message = "Invalid RFQ command: " + error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    return { kind: "rejected", httpStatus: 400, body: { code: "RFQ_INPUT_INVALID", error: message }, errorCode: "RFQ_INPUT_INVALID", errorMessage: message };
  }
  if ((error instanceof RfqWorkflowError || error instanceof PurchasingError || error instanceof DocumentNumberError)
    && error.statusCode >= 400 && error.statusCode < 500) {
    const code = error instanceof PurchasingError ? String(error.details?.code ?? "RFQ_PO_CREATE_REJECTED") : error.code;
    return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message }, errorCode: code, errorMessage: error.message };
  }
  return { kind: "retryable", errorCode: "RFQ_TRANSIENT_FAILURE", errorMessage: "RFQ workflow transaction did not commit; retry with the same command key." };
}

function assertCommandIdentity(command: RfqWorkflowCommand, actorId: string, descriptor: FinancialCommandDescriptor): void {
  const validActor = z.string().min(1).max(200).refine(value => value.trim() === value).safeParse(actorId);
  if (!validActor.success) {
    throw new FinancialCommandError("An authenticated actor is required", 401, "RFQ_ACTOR_REQUIRED");
  }
  const scope = rfqWorkflowCommandScope(command);
  if (descriptor.contractVersion !== 1
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/.test(descriptor.idempotencyKey)
      || !/^[0-9a-f]{64}$/.test(descriptor.requestHash)
      || descriptor.actorType !== "service"
      || descriptor.actorId !== RFQ_WORKFLOW_COMMAND_PRINCIPAL
      || descriptor.method !== scope.method
      || descriptor.routeTemplate !== scope.routeTemplate
      || descriptor.resourceKey !== scope.resourceKey
      || descriptor.commandName !== scope.commandName) {
    throw new FinancialCommandError("RFQ workflow command scope is invalid", 500, "RFQ_SCOPE_INVALID");
  }
}

function classifyFailureWithProof(
  error: unknown,
  command: RfqWorkflowCommand,
  actorId: string,
  idempotencyKey: string,
): FinancialCommandFailureDisposition {
  const failure = classifyRfqWorkflowFailure(error);
  if (failure.kind !== "rejected") return failure;
  const intent = rfqCommandIntentSchema.safeParse(rawIntent(command));
  return {
    ...failure,
    body: {
      ...failure.body as Record<string, unknown>,
      details: {
        rfqCommandOutcome: "rejected",
        actorId,
        idempotencyKey,
        intent: intent.success ? intent.data : rawIntent(command),
      },
    },
  };
}

export function createRfqWorkflowCommands(
  service: Pick<RfqWorkflowService, "executeInTransaction">,
  repository: FinancialCommandRepository<RfqWorkflowTransaction> = financialCommandRepository,
  clock: () => Date = () => new Date(),
) {
  return {
    async execute(command: RfqWorkflowCommand, actorId: string, descriptor: FinancialCommandDescriptor) {
      assertCommandIdentity(command, actorId, descriptor);
      const result = await runTransactionalFinancialCommand({
        repository,
        descriptor: bindRfqWorkflowCommandIdentity(command, actorId, descriptor),
        classifyFailure: error => classifyFailureWithProof(error, command, actorId, descriptor.idempotencyKey),
        work: async (tx) => {
          const value = await service.executeInTransaction(tx, command, actorId, clock(), descriptor.idempotencyKey);
          const parsed = rfqCommandReceiptSchema.safeParse({
            version: 1,
            actorId,
            idempotencyKey: descriptor.idempotencyKey,
            intent: rawIntent(command),
            result: value,
          });
          if (!parsed.success) invalidReceipt();
          const response = { httpStatus: command.operation === "convert" ? 201 : 200, body: parsed.data };
          validateRfqWorkflowReceipt({ ...response, terminalState: "succeeded" }, command, actorId, descriptor.idempotencyKey);
          return response;
        },
      });
      validateRfqWorkflowReceipt(result, command, actorId, descriptor.idempotencyKey);
      return result;
    },
  };
}
