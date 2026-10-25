import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  poAmendmentIdSchema, poQuantityPreviewRequestSchema, poQuantityApprovalRequestSchema, poQuantityAmendmentResultSchema,
} from "@shared/procurement/po-quantity-amendment";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";
import { assertQuantityAmendmentAuthority, buildQuantityAmendmentContext, planQuantityAmendment, quantityAmendmentTimestamp, PoQuantityAmendmentError } from "./po-quantity-amendment.policy";
import { readQuantityAmendmentSource, readPoAmendmentHistory, persistQuantityAmendment, recordQuantityAmendmentResult, type AmendmentDatabase, type AmendmentTransaction } from "./po-quantity-amendment.repository";
import { buildCurrentPurchaseApprovalSnapshot, PurchaseApprovalAuthorityError } from "./purchase-order-approval.policy";
import { refreshPoAmendmentCosts, type PoAmendmentShipmentOwner } from "./po-amendment-costs.service";
import { costFingerprint, CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import type { PoQuantityPreviewRequest } from "@shared/procurement/po-quantity-amendment";
import { preparePoAdditions } from "./po-line-composition.repository";

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PoQuantityAmendmentError("Review the correction fields and include a reason of at least 10 characters.", "PO_AMENDMENT_INPUT_INVALID", 400);
  return parsed.data;
}
function assertVersion(actual: string, expected: string) {
  if (actual !== expected) throw new PoQuantityAmendmentError("The PO, receipts, invoice evidence or approval permissions changed. Reload and review the correction again.", "PO_AMENDMENT_STALE", 409);
}
export function createPoQuantityAmendmentService(database: AmendmentDatabase, now: () => Date, shipments: PoAmendmentShipmentOwner) {
  const repository = createDrizzleFinancialCommandRepository(database);
  async function prepare(tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readQuantityAmendmentSource>>, request: PoQuantityPreviewRequest) {
    const additions = await preparePoAdditions(tx, source.facts.header, Math.max(0, ...source.facts.lines.map(line => line.lineNumber)) + 1, request);
    const plan = planQuantityAmendment(source.facts, request, additions);
    const approval = buildCurrentPurchaseApprovalSnapshot({ ...source, totalCents: plan.preview.afterTotalCents });
    return { plan, approval };
  }
  async function execute(tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readQuantityAmendmentSource>>,
    request: PoQuantityPreviewRequest, actorId: string, commandKey: string, prepared?: Awaited<ReturnType<typeof prepare>>) {
    const { plan, approval } = prepared ?? await prepare(tx, source, request);
    const at = quantityAmendmentTimestamp(source.facts, now());
    const saved = await persistQuantityAmendment(tx, source, plan, actorId, at, approval);
    const impact = await refreshPoAmendmentCosts(tx, source, plan, shipments, actorId, at);
    const preview = { ...plan.preview, impact };
    const reviewed = { ...plan, preview: { ...preview, previewVersion: costFingerprint(preview) } };
    return recordQuantityAmendmentResult(tx, source, reviewed, saved, actorId, commandKey, at, approval);
  }
  return {
    async history(id: number, beforeId: number | null) {
      const poId = input(poAmendmentIdSchema, id);
      const cursor = beforeId === null ? null : input(z.number().int().positive().safe(), beforeId);
      return database.transaction(tx => readPoAmendmentHistory(tx, poId, cursor));
    },
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
        // Execute the same financial owners as approval, then roll back all
        // writes. The displayed impact is measured, not a second approximation.
        await tx.execute(sql`SAVEPOINT po_amendment_preview`);
        try { return (await execute(tx, source, request, actorId, "preview")).preview; }
        finally {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT po_amendment_preview`);
          await tx.execute(sql`RELEASE SAVEPOINT po_amendment_preview`);
        }
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
        } : error instanceof CostEvidenceError || error instanceof ShipmentTrackingError ? {
          kind: "rejected", httpStatus: 409, errorCode: "PO_AMENDMENT_COST_REVIEW", errorMessage: error.message,
          body: { error: error.message, code: "PO_AMENDMENT_COST_REVIEW" },
        } : error instanceof z.ZodError ? {
          kind: "rejected", httpStatus: 409, errorCode: "PO_AMENDMENT_SOURCE_INVALID", errorMessage: "Recorded source data is invalid.", body: { error: "Recorded source data is invalid. Review the source evidence.", code: "PO_AMENDMENT_SOURCE_INVALID" },
        } : { kind: "retryable", errorCode: "PO_AMENDMENT_FAILED", errorMessage: "The quantity correction could not be completed. Retry the saved request." },
        work: async (tx) => {
          const request = input(poQuantityApprovalRequestSchema, rawRequest);
          const source = await readQuantityAmendmentSource(tx, poId, actorId);
          assertQuantityAmendmentAuthority(source.actor);
          assertVersion(source.sourceVersion, request.sourceVersion);
          // Preserve specific authority/line failures even for a direct approval
          // request that never obtained a valid preview. Preparation makes no writes.
          const prepared = await prepare(tx, source, request);
          if (!request.previewVersion) throw new PoQuantityAmendmentError("Review the current quantities and downstream costs before approving this edit.", "PO_AMENDMENT_PREVIEW_REQUIRED");
          const result = await execute(tx, source, request, actorId, descriptor.idempotencyKey, prepared);
          if (result.preview.previewVersion !== request.previewVersion) throw new PoQuantityAmendmentError("The dependent cost impact changed. Reload and review the PO edit again.", "PO_AMENDMENT_STALE");
          return { httpStatus: 200, body: poQuantityAmendmentResultSchema.parse(result), resultType: "po_quantity_amendment", resultId: result.auditEventId };
        },
      });
    },
  };
}
