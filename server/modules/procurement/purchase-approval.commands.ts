import { z } from "zod";
import { purchaseApprovalInputSchema, purchaseApprovalResultSchema } from "@shared/procurement/purchase-approval-command";
import { canonicalJson } from "@shared/utils/canonical-json";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { PurchasingError } from "./purchasing.service";

export function purchaseApprovalCommandScope(id: number) {
  return { method: "POST", routeTemplate: "/api/purchase-orders/:id/approve", resourceKey: `purchase_order:${id}`, commandName: "procurement.purchase_order.approve" } as const;
}

function classifyFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof PurchasingError && error.statusCode >= 400 && error.statusCode < 500) {
    const code = String(error.details?.code ?? "PO_APPROVAL_REJECTED");
    return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message, details: error.details }, errorCode: code, errorMessage: error.message };
  }
  if (error instanceof z.ZodError) {
    const message = "Reload and review the purchase order before approving its current terms.";
    return { kind: "rejected", httpStatus: 400, body: { code: "PO_APPROVAL_REVIEW_REQUIRED", error: message }, errorCode: "PO_APPROVAL_REVIEW_REQUIRED", errorMessage: message };
  }
  return { kind: "retryable", errorCode: "PO_APPROVAL_TRANSIENT_FAILURE", errorMessage: "Purchase approval did not commit. Recover the saved request." };
}

export function createPurchaseApprovalCommands<Transaction>(owner: {
  authorize(actorId: string): Promise<void>;
  approve(tx: Transaction, id: number, actorId: string, body: unknown): Promise<unknown>;
}, repository: FinancialCommandRepository<Transaction>) {
  return {
    async execute(id: number, body: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      const scope = purchaseApprovalCommandScope(id);
      if (!Number.isSafeInteger(id) || id <= 0 || descriptor.actorType !== "user" || descriptor.actorId !== actorId
        || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate
        || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName) {
        throw new FinancialCommandError("Purchase approval command scope is invalid", 400, "PO_APPROVAL_SCOPE_INVALID");
      }
      if (descriptor.requestHash !== hashHttpFinancialCommand({ ...scope, params: { id: String(id) }, body })) {
        throw new FinancialCommandError("Purchase approval command identity does not match its original request", 400, "PO_APPROVAL_IDENTITY_INVALID");
      }
      // A replay is read access to the original actor's result, not a fresh
      // approval. Current Identity authorization still applies before replay.
      await owner.authorize(actorId);
      const assertMatchingResult = (result: unknown) => {
        const reviewed = purchaseApprovalInputSchema.safeParse(body);
        const parsed = purchaseApprovalResultSchema.safeParse(result);
        if (!reviewed.success || !parsed.success || parsed.data.id !== id || parsed.data.approvedBy !== actorId
          || parsed.data.totalCents !== reviewed.data.expectedTotalCents || parsed.data.reviewedUpdatedAt !== reviewed.data.expectedUpdatedAt
          || parsed.data.reviewedLinesFingerprint !== reviewed.data.expectedLinesFingerprint
          || parsed.data.approvalCommand.idempotencyKey !== descriptor.idempotencyKey) {
          throw new FinancialCommandError("Purchase approval result cannot be verified. Preserve the saved request and contact support.", 500, "PO_APPROVAL_RESULT_INVALID");
        }
        return parsed.data;
      };
      const result = await runTransactionalFinancialCommand({
        repository, descriptor, classifyFailure,
        work: async (tx) => {
          const approved = await owner.approve(tx, id, actorId, body);
          const serialized: unknown = JSON.parse(canonicalJson(approved));
          const verified = assertMatchingResult({ ...(serialized as Record<string, unknown>), approvalCommand: { name: scope.commandName, idempotencyKey: descriptor.idempotencyKey } });
          return { httpStatus: 200, body: verified, resultType: "purchase_order", resultId: id };
        },
      });
      // Stored successes are checked too: recovery must never accept a valid
      // looking result from another request or a damaged historical payload.
      if (result.terminalState === "succeeded") assertMatchingResult(result.body);
      return result;
    },
  };
}
