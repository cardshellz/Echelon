import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { matchesRfqCreateReceipt, rfqCreateIntentSchema, rfqCreateKeySchema, rfqCreateReceiptSchema, rfqCreateRejectionDetailsSchema, type RfqCreatePayload } from "@shared/procurement/rfq-create-command";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { PurchasingError } from "./purchasing.service";
import type { RfqWorkflowTransaction } from "./rfq-workflow.service";
import { buildRfqCreationRequestHash } from "./purchasing-rfq-allocation";

export const RFQ_CREATE_COMMAND_PRINCIPAL = "procurement.rfq-create";
export function rfqCreateCommandScope() {
  return { method: "POST", routeTemplate: "/api/purchasing/rfq-queue", resourceKey: "rfq:create", commandName: "procurement.rfq.create_batch" } as const;
}
export function hashRfqCreateIdentity(body: unknown, actorId: string): string {
  return hashHttpFinancialCommand({ ...rfqCreateCommandScope(), body: { actorId, body } });
}
interface RfqCreateOwner {
  assertRfqCreationAuthority(actorId: string): Promise<void>;
  createRfqBatchInTransaction(tx: RfqWorkflowTransaction, body: RfqCreatePayload, actorId: string, key: string): Promise<unknown>;
}
function invalidResult(): never {
  throw new FinancialCommandError("The RFQ creation result could not be verified. Keep the original saved request.", 500, "RFQ_CREATE_RESULT_INVALID");
}
function classify(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof z.ZodError) {
    const message = "Review the RFQ selection: " + error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    return { kind: "rejected", httpStatus: 400, body: { code: "RFQ_CREATE_INPUT_INVALID", error: message }, errorCode: "RFQ_CREATE_INPUT_INVALID", errorMessage: message };
  }
  if (error instanceof PurchasingError && error.statusCode >= 400 && error.statusCode < 500) {
    const code = String(error.details?.code ?? "RFQ_CREATE_REJECTED");
    // A conflicting legacy identity is unresolved evidence, not proof that the
    // operator's original batch never committed. Do not license a new key.
    if (["RFQ_IDEMPOTENCY_CONFLICT", "RFQ_IDEMPOTENCY_ACTOR_CONFLICT"].includes(code)) return { kind: "retryable", errorCode: code, errorMessage: error.message };
    return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message }, errorCode: code, errorMessage: error.message };
  }
  return { kind: "retryable", errorCode: "RFQ_CREATE_TRANSIENT_FAILURE", errorMessage: "RFQ creation did not commit. Recover the original request." };
}
export function createRfqCreateCommands(owner: RfqCreateOwner, repository: FinancialCommandRepository<RfqWorkflowTransaction> = financialCommandRepository) {
  return {
    async execute(body: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      const scope = rfqCreateCommandScope();
      if (!z.string().min(1).max(200).refine(value => value === value.trim()).safeParse(actorId).success
        || !rfqCreateKeySchema.safeParse(descriptor.idempotencyKey).success || descriptor.contractVersion !== 1
        || descriptor.actorType !== "service" || descriptor.actorId !== RFQ_CREATE_COMMAND_PRINCIPAL
        || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate
        || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName
        || descriptor.requestHash !== hashRfqCreateIdentity(body, actorId)) {
        throw new FinancialCommandError("RFQ creation command identity is invalid", 400, "RFQ_CREATE_IDENTITY_INVALID");
      }
      const rawIntent = { operation: "create_batch", rfqId: null, payload: body };
      const verifyReceipt = (value: unknown) => {
        const intent = rfqCreateIntentSchema.safeParse(rawIntent);
        if (!intent.success || !matchesRfqCreateReceipt(value, { actorId, idempotencyKey: descriptor.idempotencyKey, intent: intent.data })) invalidResult();
        const expectedHash = buildRfqCreationRequestHash(intent.data.payload, actorId);
        if (value.result.rfqs.some(rfq => rfq.requestHash !== expectedHash)) invalidResult();
        return value;
      };
      await owner.assertRfqCreationAuthority(actorId);
      const result = await runTransactionalFinancialCommand({ repository, descriptor,
        classifyFailure(error) {
          const failure = classify(error);
          if (failure.kind !== "rejected") return failure;
          const parsed = rfqCreateIntentSchema.safeParse(rawIntent);
          return { ...failure, body: { ...(failure.body as Record<string, unknown>), details: {
            rfqCommandOutcome: "rejected", actorId, idempotencyKey: descriptor.idempotencyKey, intent: parsed.success ? parsed.data : rawIntent,
          } } };
        },
        async work(tx) {
          const intent = rfqCreateIntentSchema.parse(rawIntent);
          const saved = await owner.createRfqBatchInTransaction(tx, intent.payload, actorId, descriptor.idempotencyKey);
          const receipt = rfqCreateReceiptSchema.safeParse({ version: 1, actorId, idempotencyKey: descriptor.idempotencyKey, intent, result: JSON.parse(canonicalJson(saved)) });
          if (!receipt.success) invalidResult();
          verifyReceipt(receipt.data);
          return { httpStatus: receipt.data.result.reused ? 200 : 201, body: receipt.data };
        },
      });
      // reserve may have waited for an earlier command. Re-read current Identity
      // after that wait as well, including success and rejection replays.
      await owner.assertRfqCreationAuthority(actorId);
      const intent = rfqCreateIntentSchema.safeParse(rawIntent);
      if (result.terminalState === "succeeded") {
        if (![200, 201].includes(result.httpStatus)) invalidResult();
        verifyReceipt(result.body);
      } else {
        const rejection = z.object({ details: rfqCreateRejectionDetailsSchema.extend({ intent: z.unknown() }) }).safeParse(result.body);
        if (!rejection.success || result.httpStatus < 400 || result.httpStatus >= 500
          || rejection.data.details.actorId !== actorId || rejection.data.details.idempotencyKey !== descriptor.idempotencyKey
          || canonicalJson(rejection.data.details.intent) !== canonicalJson(intent.success ? intent.data : rawIntent)) invalidResult();
      }
      return result;
    },
  };
}
