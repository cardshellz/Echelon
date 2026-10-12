import { reviewedInvoiceAmount, InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { z } from "zod";
import { poVarianceApprovalRequestSchema, poVarianceResultSchema } from "@shared/procurement/po-variance-approval";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";
import { assertQuantityAmendmentAuthority, PoQuantityAmendmentError } from "./po-quantity-amendment.policy";
import { buildCurrentPurchaseApprovalSnapshot, PurchaseApprovalAuthorityError } from "./purchase-order-approval.policy";
import type { AmendmentDatabase } from "./po-quantity-amendment.repository";
import { buildPoVarianceContext, PoVarianceApprovalError } from "./po-variance-approval.policy";
import { readPoVarianceSource, persistPoVarianceApproval } from "./po-variance-approval.repository";
const idSchema = z.number().int().positive().max(2_147_483_647);
export function createPoVarianceApprovalService(database: AmendmentDatabase, clock: () => Date) {
  const repository = createDrizzleFinancialCommandRepository(database);
  return {
    async context(id: number, actorId: string) {
      const exceptionId = idSchema.parse(id);
      return database.transaction(async tx => {
        const loaded = await readPoVarianceSource(tx, exceptionId, actorId);
        const context = buildPoVarianceContext(loaded.source, loaded.exception);
        reviewedInvoiceAmount(loaded.source.facts, context.issues[0].lineId, context.issues[0].invoiceLineAmountCents);
        return context;
      });
    },
    async approve(id: number, input: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      const exceptionId = idSchema.parse(id);
      if (descriptor.actorType !== "user" || descriptor.actorId !== actorId || descriptor.method !== "POST"
        || descriptor.routeTemplate !== "/api/po-exceptions/:id/variance-approval" || descriptor.resourceKey !== `po_exception:${exceptionId}`
        || descriptor.commandName !== "purchase_order.variance.approve") throw new FinancialCommandError("The variance command does not match its authenticated approver or exception.", 403, "PO_VARIANCE_SCOPE_INVALID");
      return runTransactionalFinancialCommand({ repository, descriptor,
        classifyFailure: error => error instanceof PoVarianceApprovalError || error instanceof PoQuantityAmendmentError || error instanceof InvoiceQuantityCorrectionError ? {
          kind: "rejected", httpStatus: error.statusCode, errorCode: error.code, errorMessage: error.message, body: { error: error.message, code: error.code },
        } : error instanceof PurchaseApprovalAuthorityError ? { kind: "rejected", httpStatus: error.statusCode, errorCode: String(error.details.code), errorMessage: error.message, body: { error: error.message, code: error.details.code } }
        : error instanceof z.ZodError ? { kind: "rejected", httpStatus: 400, errorCode: "PO_VARIANCE_INVALID", errorMessage: "Review the variance evidence and approval fields.", body: { error: "Review the variance evidence and approval fields.", code: "PO_VARIANCE_INVALID" } }
        : { kind: "retryable", errorCode: "PO_VARIANCE_FAILED", errorMessage: "The acceptance rolled back. Retry the saved confirmation." },
        work: async tx => {
          const request = poVarianceApprovalRequestSchema.parse(input), loaded = await readPoVarianceSource(tx, exceptionId, actorId);
          assertQuantityAmendmentAuthority(loaded.source.actor);
          if (loaded.source.sourceVersion !== request.sourceVersion) throw new PoVarianceApprovalError("The invoice, PO or approval permissions changed. Reload and review this variance.", "PO_VARIANCE_STALE");
          const context = buildPoVarianceContext(loaded.source, loaded.exception);
          if (context.blockedReason) throw new PoVarianceApprovalError(context.blockedReason, "PO_VARIANCE_BLOCKED");
          const invoiceTotal = reviewedInvoiceAmount(loaded.source.facts, context.issues[0].lineId, context.issues[0].invoiceLineAmountCents);
          const approval = buildCurrentPurchaseApprovalSnapshot({ ...loaded.source, totalCents: Math.max(z.number().int().nonnegative().safe().parse(loaded.source.facts.header.totalCents), invoiceTotal) });
          const at = z.date().parse(clock());
          const result = await persistPoVarianceApproval(tx, loaded, context, request.reason, descriptor.idempotencyKey, approval, at);
          return { httpStatus: 200, body: poVarianceResultSchema.parse(result), resultType: "po_variance_approval", resultId: result.auditEventId };
        },
      });
    },
  };
}
