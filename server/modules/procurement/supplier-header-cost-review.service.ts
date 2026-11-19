import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  supplierHeaderTargetSchema, supplierHeaderPreviewInputSchema, supplierHeaderApprovalInputSchema,
  supplierHeaderPreviewSchema, supplierHeaderResultSchema, type SupplierHeaderTarget,
} from "@shared/procurement/supplier-header-costs";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { PoAmendmentImpact } from "@shared/procurement/po-amendment-impact";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";
import { COGSService } from "../inventory/cogs.service";
import { costFingerprint, CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import type { CostRevisionApplicationResult } from "../inventory/application/apply-cost-revision";
import { assertInvoiceQuantityAuthority, InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { allocateSupplierHeader, supplierHeaderSourceFingerprint } from "./domain/supplier-header-costs";
import { purchaseTaxApprovalTime } from "./domain/purchase-tax";
import { readSupplierHeaderReviewSource, insertSupplierHeaderReview, recordSupplierHeaderEffect, readSupplierHeaderHistory } from "./supplier-header-cost-review.repository";
import { readPoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { readInvoiceCorrectionInventoryValues } from "./invoice-correction-cost-values";
import { reconcilePurchaseCostEvidence } from "./purchase-cost-application.service";
import { buildCostDestinationImpact } from "./cost-change-impact";
import { projectPoAmendmentReturnedCosts } from "./po-amendment-return-impact";
import { applySupplierHeaderShipmentCosts } from "./supplier-header-shipment-application";
import type { ShipmentTrackingService } from "./shipment-tracking.service";
import type { AmendmentDatabase, AmendmentTransaction } from "./po-quantity-amendment.repository";

export function supplierHeaderCommandScope(target: SupplierHeaderTarget) {
  supplierHeaderTargetSchema.parse(target);
  return { method: "POST", routeTemplate: "/api/purchasing/supplier-header-costs/approve",
    resourceKey: `${target.kind}:${target.id}`, commandName: "purchasing.supplier_header_costs.approve" };
}
function current(actual: string, expected: string) {
  if (actual !== expected) throw new CostEvidenceError("SUPPLIER_HEADER_STALE", "The supplier document, allocation, stock or approval permissions changed. Review the current amounts again.");
}
type Source = Awaited<ReturnType<typeof readSupplierHeaderReviewSource>>;
type ApplicationEffect = PoAmendmentImpact["applications"][number];
function applicationEffect(scope: Pick<ApplicationEffect, "purchaseOrderLineId" | "shipmentId" | "component">,
  application: CostRevisionApplicationResult): ApplicationEffect {
  return { ...scope, status: application.status, lotsUpdated: application.lotsUpdated, orderCostsUpdated: application.cogsRowsUpdated,
    orderCostDeltaCents: application.totalCogsDeltaCents, issues: application.issues.map(row => ({ code: row.code, message: row.message })),
    ...projectPoAmendmentReturnedCosts(application) };
}

/** The same transaction executes preview and approval. Header classifications,
 * current supplier/shipment cost application and immutable history commit once;
 * the original bill, cash, document approval and physical counts remain facts. */
export function createSupplierHeaderCostService(database: AmendmentDatabase,
  shipmentTracking: Pick<ShipmentTrackingService, "refreshQuantityAllocationInTransaction">, clock: () => Date) {
  const commands = createDrizzleFinancialCommandRepository(database);
  async function execute(tx: AmendmentTransaction, source: Source, request: z.infer<typeof supplierHeaderPreviewInputSchema>,
    actorId: string, commandKey: string, expectedPreview?: string) {
    assertInvoiceQuantityAuthority(source.actor);
    if (source.context.blockedReason) throw new CostEvidenceError("SUPPLIER_HEADER_SOURCE_REVIEW", source.context.blockedReason);
    const shares = allocateSupplierHeader(source.selection.source, request.entries);
    const beforeShares = source.selection.current ? (source.selection.issue ? source.selection.current.after : source.selection.shares) : [];
    const beforeValues = await readInvoiceCorrectionInventoryValues(tx, source.dependencies);
    const at = purchaseTaxApprovalTime(clock(), [source.document.updated_at, source.selection.current?.approvedAt]);
    const reviewId = await insertSupplierHeaderReview(tx, source, { entries: request.entries,
      sourceFingerprint: supplierHeaderSourceFingerprint(source.selection.source), before: beforeShares, after: shares,
      actorId, reason: request.reason, at, commandKey,
      // Preview is rolled back before commit; a real command's supplied hash is
      // checked against the actual result before this immutable row can commit.
      previewVersion: expectedPreview ?? "0".repeat(64) });
    const applications: ApplicationEffect[] = [];
    const writer = new COGSService(tx);
    for (const lineId of source.lineIds) {
      const result = await reconcilePurchaseCostEvidence(tx, lineId, writer, actorId, at);
      applications.push(...result.costApplications.map((row, index) => applicationEffect({ purchaseOrderLineId: lineId, shipmentId: null,
        component: result.costSources[index].contract.component }, row)));
    }
    if (source.target.kind === "invoice") {
      const shipments = await applySupplierHeaderShipmentCosts(tx, source.target.id, shipmentTracking, actorId, at);
      for (const shipment of shipments) {
        applications.push(...shipment.results.map(row => applicationEffect({ purchaseOrderLineId: null, shipmentId: shipment.shipmentId, component: "landed" }, row)));
        if (shipment.pending || shipment.issues.length) applications.push({ purchaseOrderLineId: null, shipmentId: shipment.shipmentId, component: "landed",
          status: shipment.pending ? "review_required" : "applied", lotsUpdated: 0, orderCostsUpdated: 0, orderCostDeltaCents: 0, issues: shipment.issues });
      }
    }
    const document = (await tx.execute(source.target.kind === "purchase_order"
      ? sql`SELECT * FROM procurement.purchase_orders WHERE id=${source.target.id}`
      : sql`SELECT * FROM procurement.vendor_invoices WHERE id=${source.target.id}`)).rows[0];
    if (canonicalJson(document) !== canonicalJson(source.document)) throw new Error("Header classification changed the original document or settlement.");
    const dependencies = await readPoAmendmentDependencies(tx, source.lineIds, { shipmentIds: source.shipmentIds });
    const afterValues = await readInvoiceCorrectionInventoryValues(tx, dependencies);
    if (afterValues.length !== beforeValues.length) throw new Error("Header classification changed the inventory structure.");
    const byLot = new Map(afterValues.map(row => [row.lotId, row]));
    const inventoryValues = beforeValues.map(row => {
      const next = byLot.get(row.lotId);
      if (!next || next.onHandUnits !== row.onHandUnits) throw new Error("Header classification changed stock quantities.");
      return { lotId: row.lotId, lotNumber: row.lotNumber, onHandUnits: row.onHandUnits,
        originalLotTotalMills: { before: row.originalLotTotalMills, after: next.originalLotTotalMills },
        onHandValueMills: { before: row.onHandValueMills, after: next.onHandValueMills }, valueReviewReason: next.valueReviewReason };
    });
    const impact = { ...buildCostDestinationImpact(source.dependencies, dependencies), applications };
    const issues = [...new Set(applications.flatMap(row => row.issues.map(issue => issue.message)))];
    const measured = { target: source.target, sourceVersion: source.sourceVersion, before: beforeShares, after: shares, impact, inventoryValues, issues };
    const preview = supplierHeaderPreviewSchema.parse({ ...measured,
      previewVersion: costFingerprint({ contract: 1, measured, entries: request.entries, reason: request.reason }) });
    if (expectedPreview !== undefined) current(preview.previewVersion, expectedPreview);
    await recordSupplierHeaderEffect(tx, source, { reviewId, preview, actorId, reason: request.reason, at, commandKey });
    return supplierHeaderResultSchema.parse({ reviewId, preview });
  }
  return {
    history: (target: SupplierHeaderTarget) => database.transaction(tx => readSupplierHeaderHistory(tx, supplierHeaderTargetSchema.parse(target))),
    context: (target: SupplierHeaderTarget, actorId: string) => database.transaction(async tx =>
      (await readSupplierHeaderReviewSource(tx, supplierHeaderTargetSchema.parse(target), actorId)).context),
    preview: (input: unknown, actorId: string) => {
      const request = supplierHeaderPreviewInputSchema.parse(input);
      return database.transaction(async tx => {
        const source = await readSupplierHeaderReviewSource(tx, request.target, actorId);
        assertInvoiceQuantityAuthority(source.actor); current(source.sourceVersion, request.sourceVersion);
        await tx.execute(sql`SAVEPOINT supplier_header_preview`);
        try { return (await execute(tx, source, request, actorId, "preview")).preview; }
        finally { await tx.execute(sql`ROLLBACK TO SAVEPOINT supplier_header_preview`); await tx.execute(sql`RELEASE SAVEPOINT supplier_header_preview`); }
      });
    },
    approve: (input: unknown, actorId: string, descriptor: FinancialCommandDescriptor) => {
      const request = supplierHeaderApprovalInputSchema.parse(input), scope = supplierHeaderCommandScope(request.target);
      if (descriptor.actorType !== "user" || descriptor.actorId !== actorId || descriptor.method !== scope.method
        || descriptor.routeTemplate !== scope.routeTemplate || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName)
        throw new FinancialCommandError("The approval request does not match its original supplier document.", 400, "SUPPLIER_HEADER_COMMAND_SCOPE");
      return runTransactionalFinancialCommand({ repository: commands, descriptor,
        classifyFailure(error) {
          if (error instanceof CostEvidenceError || error instanceof InvoiceQuantityCorrectionError) return { kind: "rejected", httpStatus: error instanceof InvoiceQuantityCorrectionError ? error.statusCode : 409,
            errorCode: error.code, errorMessage: error.message, body: { error: error.message, code: error.code } };
          if (error instanceof z.ZodError) return { kind: "rejected", httpStatus: 422, errorCode: "SUPPLIER_HEADER_SOURCE_INVALID",
            errorMessage: "Review the original supplier amounts and exact allocations.", body: { error: "Review the original supplier amounts and exact allocations.", code: "SUPPLIER_HEADER_SOURCE_INVALID" } };
          return { kind: "retryable", errorCode: "SUPPLIER_HEADER_RETRY", errorMessage: "The header approval rolled back. Retry the saved request." };
        },
        work: async tx => {
          const source = await readSupplierHeaderReviewSource(tx, request.target, actorId);
          assertInvoiceQuantityAuthority(source.actor); current(source.sourceVersion, request.sourceVersion);
          const result = await execute(tx, source, request, actorId, descriptor.idempotencyKey, request.previewVersion);
          return { httpStatus: 200, body: result, resultType: "supplier_header_cost_review", resultId: result.reviewId };
        },
      }).then(result => {
        if (result.httpStatus >= 200 && result.httpStatus < 300) {
          const verified = supplierHeaderResultSchema.safeParse(result.body);
          if (!verified.success || canonicalJson(verified.data.preview.target) !== canonicalJson(request.target)
            || verified.data.preview.sourceVersion !== request.sourceVersion || verified.data.preview.previewVersion !== request.previewVersion)
            throw new FinancialCommandError("The recorded approval could not be verified. Retry the same saved request.", 503, "SUPPLIER_HEADER_RESULT_UNVERIFIED");
        }
        return result;
      });
    },
  };
}
