import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierReturnCreditReviewInputSchema, supplierReturnCreditReviewCommandResultSchema } from "@shared/procurement/supplier-return-credit";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandRepository, type FinancialCommandResult } from "../../platform/commands/transactional-command.service";
import { classifySupplierReturnFailure } from "./supplier-return.commands";
import { recordSupplierReturnDifferenceReview } from "./supplier-return-difference.service";
import type { SupplierReturnTransaction } from "./supplier-return.repository";

export const SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE = {
  method: "POST", routeTemplate: "/api/supplier-return-entitlements/:id/review",
  resourceKey: "supplier-return-credit-review", commandName: "supplier_return.review_credit_difference",
} as const;
export function bindSupplierReturnReviewCommand(descriptor: FinancialCommandDescriptor): FinancialCommandDescriptor {
  return { ...descriptor, actorType: "service", actorId: "procurement.supplier-return-review", requestHash: hashHttpFinancialCommand({
    ...SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE, body: { actorId: descriptor.actorId, rawRequestHash: descriptor.requestHash },
  }) };
}
export function validateSupplierReturnReviewReceipt(result: Pick<FinancialCommandResult, "body" | "terminalState" | "httpStatus">,
  entitlementId: number, raw: unknown, descriptor: FinancialCommandDescriptor): void {
  const fail = () => { throw new FinancialCommandError("Saved return credit review does not match the submitted evidence. Retain the request key.", 500, "SUPPLIER_RETURN_REVIEW_RESULT_INVALID"); };
  if (result.terminalState !== "succeeded") {
    const parsed = z.object({ details: z.object({ supplierReturnCommandOutcome: z.literal("rejected"), command: z.literal("review_credit_difference"),
      actorId: z.literal(descriptor.actorId), idempotencyKey: z.literal(descriptor.idempotencyKey), entitlementId: z.literal(entitlementId) }) }).safeParse(result.body);
    if (result.terminalState !== "rejected" || result.httpStatus < 400 || result.httpStatus >= 500 || !parsed.success) fail();
    return;
  }
  const parsed = supplierReturnCreditReviewCommandResultSchema.safeParse(result.body);
  const request = supplierReturnCreditReviewInputSchema.safeParse(raw);
  if (!parsed.success || !request.success) { fail(); return; }
  const body = parsed.data, latest = body.review.latestReview;
  if (result.httpStatus !== 201 || body.actorId !== descriptor.actorId || body.idempotencyKey !== descriptor.idempotencyKey
    || body.entitlementId !== entitlementId || canonicalJson(body.request) !== canonicalJson(request.data) || !latest || !body.review.reviewCurrent) { fail(); return; }
  if (latest.recordedBy !== descriptor.actorId || latest.expectedVersion !== request.data.expectedVersion || latest.reason !== request.data.reason
    || latest.evidenceReference !== request.data.evidenceReference || latest.disposition !== request.data.disposition
    || body.review.version === request.data.expectedVersion
    || !body.review.reviewHistory.at(-1)
    || canonicalJson(body.review.reviewHistory.at(-1)) !== canonicalJson(latest)
    || canonicalJson(latest.assignments) !== canonicalJson(request.data.assignments)
    || body.review.reviewHistory.filter(row => row.id === latest.id && canonicalJson(row) === canonicalJson(latest)).length !== 1) fail();
}
export function createSupplierReturnReviewCommands(repository: FinancialCommandRepository<SupplierReturnTransaction> = financialCommandRepository, clock: () => Date = () => new Date()) {
  return {
    async review(entitlementId: number, raw: unknown, descriptor: FinancialCommandDescriptor) {
      const scope = SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE;
      if (!z.number().int().positive().max(2_147_483_647).safeParse(entitlementId).success || descriptor.contractVersion !== 1
        || !z.string().min(1).max(100).refine(value => value.trim() === value).safeParse(descriptor.actorId).success
        || !z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/).safeParse(descriptor.idempotencyKey).success
        || descriptor.actorType !== "user" || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate
        || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName
        || descriptor.requestHash !== hashHttpFinancialCommand({ ...scope, body: raw, params: { id: String(entitlementId) }, query: {} })) {
        throw new FinancialCommandError("Return credit review request identity is invalid.", 400, "SUPPLIER_RETURN_REVIEW_IDENTITY_INVALID");
      }
      const result = await runTransactionalFinancialCommand({ repository, descriptor: bindSupplierReturnReviewCommand(descriptor),
        classifyFailure: error => {
          const failure = classifySupplierReturnFailure(error);
          if (failure.kind !== "rejected") return failure;
          const body = failure.body as { error: string; details: { code: string } };
          return { ...failure, body: { ...body, details: { ...body.details, supplierReturnCommandOutcome: "rejected",
            command: "review_credit_difference", actorId: descriptor.actorId, idempotencyKey: descriptor.idempotencyKey, entitlementId } } };
        },
        work: async tx => {
          const review = await recordSupplierReturnDifferenceReview(tx, { entitlementId, raw, actorId: descriptor.actorId, at: clock(), commandKey: descriptor.idempotencyKey });
          const body = supplierReturnCreditReviewCommandResultSchema.parse({ command: "review_credit_difference", actorId: descriptor.actorId,
            idempotencyKey: descriptor.idempotencyKey, entitlementId, request: supplierReturnCreditReviewInputSchema.parse(raw), review });
          validateSupplierReturnReviewReceipt({ body, httpStatus: 201, terminalState: "succeeded" }, entitlementId, raw, descriptor);
          return { httpStatus: 201, body, resultType: "supplier_return_credit_review", resultId: review.latestReview!.id };
        },
      });
      validateSupplierReturnReviewReceipt(result, entitlementId, raw, descriptor);
      return result;
    },
  };
}
export const supplierReturnReviewCommands = createSupplierReturnReviewCommands();
