import { z } from "zod";
import {
  poAmendmentIdSchema, poQuantityPreviewRequestSchema, poQuantityApprovalRequestSchema, poQuantityAmendmentResultSchema,
} from "@shared/procurement/po-quantity-amendment";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";
import { assertQuantityAmendmentAuthority, buildQuantityAmendmentContext, planQuantityAmendment, quantityAmendmentTimestamp, PoQuantityAmendmentError } from "./po-quantity-amendment.policy";
import { readQuantityAmendmentSource, persistQuantityAmendment, type AmendmentDatabase } from "./po-quantity-amendment.repository";
import { assertUniqueHighestApprovalTier, buildPurchaseApprovalSnapshot, PurchaseApprovalAuthorityError } from "./purchase-order-approval.policy";

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PoQuantityAmendmentError("Review the correction fields and include a reason of at least 10 characters.", "PO_AMENDMENT_INPUT_INVALID", 400);
  return parsed.data;
}
function assertVersion(actual: string, expected: string) {
  if (actual !== expected) throw new PoQuantityAmendmentError("The PO, receipts, invoice evidence or approval permissions changed. Reload and review the correction again.", "PO_AMENDMENT_STALE", 409);
}
function approvalForPlan(source: Awaited<ReturnType<typeof readQuantityAmendmentSource>>, totalCents: number) {
  const tiers = source.requireApproval ? source.approvalTiers.filter((tier) => tier.thresholdCents <= totalCents).sort((a, b) => b.thresholdCents - a.thresholdCents || a.id - b.id) : [];
  assertUniqueHighestApprovalTier(tiers.slice(0, 2));
  return buildPurchaseApprovalSnapshot({ actor: source.actor, requireApproval: source.requireApproval, tier: tiers[0] ?? null, totalCents });
}
export function createPoQuantityAmendmentService(database: AmendmentDatabase, now: () => Date) {
  const repository = createDrizzleFinancialCommandRepository(database);
  return {
    async context(id: number, actorId: string) {
      const poId = input(poAmendmentIdSchema, id);
      return database.transaction(async (tx) => {
        const source = await readQuantityAmendmentSource(tx, poId, actorId);
        return buildQuantityAmendmentContext(source.facts, source.actor, source.sourceVersion);
      });
    },
    async preview(id: number, rawRequest: unknown, actorId: string) {
      const poId = input(poAmendmentIdSchema, id);
      const request = input(poQuantityPreviewRequestSchema, rawRequest);
      return database.transaction(async (tx) => {
        const source = await readQuantityAmendmentSource(tx, poId, actorId);
        assertQuantityAmendmentAuthority(source.actor);
        assertVersion(source.sourceVersion, request.sourceVersion);
        const plan = planQuantityAmendment(source.facts, request);
        approvalForPlan(source, plan.preview.afterTotalCents);
        return plan.preview;
      });
    },
    async approve(id: number, rawRequest: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      const poId = input(poAmendmentIdSchema, id);
      if (descriptor.actorType !== "user" || descriptor.actorId !== actorId || descriptor.method !== "POST"
        || descriptor.routeTemplate !== "/api/purchase-orders/:id/quantity-amendment" || descriptor.resourceKey !== `purchase_order:${poId}`
        || descriptor.commandName !== "purchase_order.quantity_amendment.approve") throw new FinancialCommandError("The command does not match this PO or authenticated approver.", 403, "PO_AMENDMENT_ACTOR_INVALID");
      return runTransactionalFinancialCommand({
        repository, descriptor,
        classifyFailure: (error) => error instanceof PoQuantityAmendmentError ? {
          kind: "rejected", httpStatus: error.statusCode, errorCode: error.code, errorMessage: error.message, body: { error: error.message, code: error.code },
        } : error instanceof PurchaseApprovalAuthorityError ? {
          kind: "rejected", httpStatus: error.statusCode, errorCode: String(error.details.code), errorMessage: error.message, body: { error: error.message, details: error.details },
        } : error instanceof z.ZodError ? {
          kind: "rejected", httpStatus: 409, errorCode: "PO_AMENDMENT_SOURCE_INVALID", errorMessage: "Recorded source data is invalid.", body: { error: "Recorded source data is invalid. Review the source evidence.", code: "PO_AMENDMENT_SOURCE_INVALID" },
        } : { kind: "retryable", errorCode: "PO_AMENDMENT_FAILED", errorMessage: "The quantity correction could not be completed. Retry the saved request." },
        work: async (tx) => {
          const request = input(poQuantityApprovalRequestSchema, rawRequest);
          const source = await readQuantityAmendmentSource(tx, poId, actorId);
          assertQuantityAmendmentAuthority(source.actor);
          assertVersion(source.sourceVersion, request.sourceVersion);
          const plan = planQuantityAmendment(source.facts, request);
          const approval = approvalForPlan(source, plan.preview.afterTotalCents);
          const result = await persistQuantityAmendment(tx, source, plan, actorId, descriptor.idempotencyKey, quantityAmendmentTimestamp(source.facts, now()), approval);
          return { httpStatus: 200, body: poQuantityAmendmentResultSchema.parse(result), resultType: "po_quantity_amendment", resultId: result.auditEventId };
        },
      });
    },
  };
}
