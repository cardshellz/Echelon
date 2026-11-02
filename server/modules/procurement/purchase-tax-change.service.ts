import { sql } from "drizzle-orm";
import { z } from "zod";
import { purchaseTaxTargetSchema, purchaseTaxPreviewRequestSchema, purchaseTaxApprovalRequestSchema, purchaseTaxPreviewSchema,
  purchaseTaxResultSchema, purchaseTaxImpactSchema, type PurchaseTaxChange, type PurchaseTaxTarget } from "@shared/procurement/purchase-tax";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { runTransactionalFinancialCommand, FinancialCommandError, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";
import { COGSService } from "../inventory/cogs.service";
import { costFingerprint, CostEvidenceError } from "../inventory/infrastructure/cost-evidence.repository";
import { assertInvoiceQuantityAuthority, InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { readPurchaseTaxChangeSource, persistPurchaseTaxChange, recordPurchaseTaxApproval, readPurchaseTaxApprovals } from "./purchase-tax-change.repository";
import { readPurchaseTaxTypes } from "./purchase-tax-evidence.repository";
import { readInvoiceCorrectionInventoryValues } from "./invoice-correction-cost-values";
import { buildCostDestinationImpact } from "./cost-change-impact";
import { reconcilePurchaseCostEvidence } from "./purchase-cost-application.service";
import { readPurchaseCostSource } from "./purchase-cost-source.repository";
import { resolvePurchaseCostSource } from "./domain/purchase-cost-source";
import { PurchaseTaxError, purchaseTaxApprovalTime } from "./domain/purchase-tax";
import { readPurchaseCostStatus } from "./purchase-cost-status.repository";
import { projectPoAmendmentReturnedCosts } from "./po-amendment-return-impact";
import { readShipmentCostReviewInTransaction } from "./shipment-cost-review.repository";
import { isShipmentCostLinePosted } from "@shared/procurement/shipment-cost-workflow";
import { supplierCostReviewTasks, shipmentCostReviewTasks } from "@shared/procurement/cost-review-tasks";
import { shipmentCostReviewLines } from "@shared/procurement/cost-review-adapters";
import { ApLedgerError } from "./ap-ledger.service";
import { MoneyInputError } from "@shared/money-read";
import { applyShipmentCostRevisions } from "./shipment-cost-application.service";
import { ShipmentTrackingError, type ShipmentTrackingService } from "./shipment-tracking.service";
import { PoQuantityAmendmentError } from "./po-quantity-amendment.policy";
import type { AmendmentDatabase, AmendmentTransaction } from "./po-quantity-amendment.repository";
import type { PoAmendmentImpact } from "@shared/procurement/po-amendment-impact";
import { purchaseTaxSettingsChanges } from "@shared/procurement/purchase-tax-settings";

export function purchaseTaxCommandScope(target: PurchaseTaxTarget) {
  return { routeTemplate: "/api/purchasing/tax-changes", resourceKey: `purchase_tax:${target.kind}:${target.id ?? "new"}`, commandName: "purchasing.tax.change" };
}
function targetFor(change: PurchaseTaxChange): PurchaseTaxTarget { return purchaseTaxTargetSchema.parse({ kind: change.kind, id: change.id }); }
function assertVersion(actual: string, expected: string) {
  if (actual !== expected) throw new PurchaseTaxError("Tax settings, source documents, stock or approval permissions changed. Reload and review the new values.", "PURCHASE_TAX_STALE");
}

export function createPurchaseTaxChangeService(database: AmendmentDatabase, shipments: Pick<ShipmentTrackingService, "refreshQuantityAllocationInTransaction">, clock: () => Date) {
  const commands = createDrizzleFinancialCommandRepository(database);
  async function execute(tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readPurchaseTaxChangeSource>>,
    change: PurchaseTaxChange, actorId: string, reason: string, commandKey: string) {
    assertInvoiceQuantityAuthority(source.actor);
    const at = purchaseTaxApprovalTime(clock(), source.recordedVersions);
    const beforeValues = await readInvoiceCorrectionInventoryValues(tx, source.dependencies);
    await persistPurchaseTaxChange(tx, source, change, actorId, at, reason);
    const economicChange = change.kind !== "tax_type" || source.context.current?.kind !== "tax_type"
      || change.treatment !== source.context.current.treatment;
    const writer = new COGSService(tx), applications: PoAmendmentImpact["applications"] = [], receipts: unknown[] = [];
    const supplierResults = [];
    for (const lineId of economicChange ? source.productIds : []) {
      const current = await readPurchaseCostSource(tx, lineId);
      if (!current) throw new PurchaseTaxError("A purchase cost source disappeared.", "PURCHASE_TAX_SOURCE_INVALID");
      const previous = source.dependencies.evidence.find(row => row.id === lineId)?.source;
      const selected = resolvePurchaseCostSource(current);
      // A quote-tax edit cannot take ownership back from unchanged invoices or
      // apply an unchanged legacy averaged source to newly linked stock.
      if (previous && costFingerprint(selected) === costFingerprint(resolvePurchaseCostSource(previous))) continue;
      if (!current.receiptCosting && current.approvedInvoices.length > 1 && selected.some(row => row.evidence === "confirmed")) {
        throw new PurchaseTaxError("Several invoices cover this line. Receipt-specific cost allocation is required before changing its tax cost; this editor cannot average their prices.", "PURCHASE_TAX_RECEIPT_ALLOCATION_REQUIRED");
      }
      const result = await reconcilePurchaseCostEvidence(tx, lineId, writer, actorId, at);
      receipts.push(result); supplierResults.push({ lineId, result });
    }
    const shipmentResults = [];
    for (const shipmentId of (economicChange ? [...source.shipmentIds] : []).sort((a, b) => a - b)) {
      // A real measurement problem must not fabricate an allocation or erase a
      // financial tax decision. Keep that source as a visible unapplied review.
      await tx.execute(sql`SAVEPOINT purchase_tax_shipment_update`);
      let result;
      try {
        result = await shipments.refreshQuantityAllocationInTransaction(tx, shipmentId, actorId, at);
      } catch (error) {
        await tx.execute(sql`ROLLBACK TO SAVEPOINT purchase_tax_shipment_update`);
        if (!(error instanceof ShipmentTrackingError) || error.details?.code !== "MISSING_ALLOCATION_DIMENSIONS") throw error;
        result = await applyShipmentCostRevisions(tx, shipmentId, writer, actorId, at);
      }
      await tx.execute(sql`RELEASE SAVEPOINT purchase_tax_shipment_update`);
      receipts.push(result);
      shipmentResults.push({ shipmentId, result });
    }
    // Read shared status only after all owners finish: supplier and shipment
    // revisions can touch the same transferred/repacked stock graph.
    const status = await readPurchaseCostStatus(tx, economicChange ? source.productIds : []);
    const warnings: string[] = [];
    for (const line of status.lines.filter(line => line.components.some(component => ["review_required", "outdated"].includes(component.status)))) {
      warnings.push(...supplierCostReviewTasks(line).map(task => `${task.title}. ${task.explanation}`));
    }
    for (const { lineId, result } of supplierResults) for (let index = 0; index < result.costApplications.length; index++) {
      const application = result.costApplications[index], component = result.costSources[index].contract.component;
      const current = status.lines.find(line => line.purchaseOrderLineId === lineId)?.components.find(row => row.component === component);
      if (!current) throw new PurchaseTaxError("The current supplier cost outcome is missing.", "PURCHASE_TAX_RESULT_INVALID");
      applications.push({ purchaseOrderLineId: lineId, shipmentId: null, component,
        status: current.status === "pending" ? "pending_finalization" : current.status,
        lotsUpdated: application.replayed ? 0 : application.lotsUpdated, orderCostsUpdated: application.replayed ? 0 : application.cogsRowsUpdated,
        orderCostDeltaCents: application.replayed ? 0 : application.totalCogsDeltaCents,
        ...projectPoAmendmentReturnedCosts(application), issues: current.issues });
    }
    for (const { shipmentId, result } of shipmentResults) {
      if (!result.costApplications.length) {
        applications.push({ purchaseOrderLineId: null, shipmentId, component: "landed", status: "pending_finalization", lotsUpdated: 0,
          orderCostsUpdated: 0, orderCostDeltaCents: 0, issues: [{ code: "PURCHASE_TAX_SHIPMENT_PENDING", message: "The tax treatment is saved. Shipment costing will use it when the shipment is finalized." }] });
        continue;
      }
      const review = await readShipmentCostReviewInTransaction(tx, shipmentId);
      if (!review) throw new PurchaseTaxError("The shipment's current cost outcome is missing.", "PURCHASE_TAX_RESULT_INVALID");
      warnings.push(...shipmentCostReviewLines(review).flatMap(line => shipmentCostReviewTasks(line).map(task => `${task.title}. ${task.explanation}`)));
      for (const line of review.lines) {
        const application = result.costApplications.find(row => row.applicationId === line.application?.id);
        if (!application) throw new PurchaseTaxError("A shipment cost application cannot be verified.", "PURCHASE_TAX_RESULT_INVALID");
        const posted = isShipmentCostLinePosted(line);
        applications.push({ purchaseOrderLineId: line.purchaseOrderLineId ?? null, shipmentId, shipmentLineId: line.lineId, component: "landed",
          status: posted ? "applied" : "review_required", lotsUpdated: application.replayed ? 0 : application.lotsUpdated,
          orderCostsUpdated: application.replayed ? 0 : application.cogsRowsUpdated, orderCostDeltaCents: application.replayed ? 0 : application.totalCogsDeltaCents,
          ...projectPoAmendmentReturnedCosts(application), issues: posted ? [] : [...(line.sourceIssue ? [line.sourceIssue] : []), ...application.issues] });
      }
    }
    const after = await readPurchaseTaxChangeSource(tx, source.target, actorId);
    const afterValues = new Map((await readInvoiceCorrectionInventoryValues(tx, after.dependencies)).map(row => [row.lotId, row]));
    // The shared amendment DTO deliberately keeps issue facts and removes
    // allocation IDs created inside a rolled-back preview. Normalize BEFORE
    // hashing; the committed owner's full evidence stays in the root audit.
    const impact = purchaseTaxImpactSchema.parse({ ...buildCostDestinationImpact(source.dependencies, after.dependencies), applications,
      inventoryValues: beforeValues.map(row => {
        const next = afterValues.get(row.lotId);
        if (!next || row.onHandUnits !== next.onHandUnits) throw new PurchaseTaxError("Tax changes cannot change stock counts.", "PURCHASE_TAX_STOCK_CHANGED");
        return { lotId: row.lotId, lotNumber: row.lotNumber, onHandUnits: row.onHandUnits,
          originalLotTotalMills: { before: row.originalLotTotalMills, after: next.originalLotTotalMills },
          onHandValueMills: { before: row.onHandValueMills, after: next.onHandValueMills }, valueReviewReason: next.valueReviewReason };
      }) });
    const reviewed = { sourceVersion: source.sourceVersion, change, settings: purchaseTaxSettingsChanges(source.context, change), before: source.context.documents, after: after.context.documents, impact, warnings: [...new Set(warnings)] };
    const preview = purchaseTaxPreviewSchema.parse({ ...reviewed, previewVersion: costFingerprint(reviewed) });
    const auditEventId = await recordPurchaseTaxApproval(tx, source, preview, actorId, reason, at, commandKey, receipts);
    return purchaseTaxResultSchema.parse({ auditEventId, preview });
  }
  return {
    types: () => database.transaction(tx => readPurchaseTaxTypes(tx)),
    history: (purchaseOrderId: number) => database.transaction(async tx => {
      const target = purchaseTaxTargetSchema.parse({ kind: "purchase_order", id: purchaseOrderId });
      if (!(await tx.execute(sql`SELECT id FROM procurement.purchase_orders WHERE id=${purchaseOrderId}`)).rows.length)
        throw new PurchaseTaxError("Purchase order not found.", "PURCHASE_TAX_NOT_FOUND", 404);
      return readPurchaseTaxApprovals(tx, target, [purchaseOrderId]);
    }),
    context: (target: unknown, actorId: string) => database.transaction(async tx =>
      (await readPurchaseTaxChangeSource(tx, purchaseTaxTargetSchema.parse(target), actorId)).context),
    async preview(input: unknown, actorId: string) {
      const request = purchaseTaxPreviewRequestSchema.parse(input);
      return database.transaction(async tx => {
        const source = await readPurchaseTaxChangeSource(tx, targetFor(request.change), actorId);
        assertInvoiceQuantityAuthority(source.actor); assertVersion(source.sourceVersion, request.sourceVersion);
        await tx.execute(sql`SAVEPOINT purchase_tax_preview`);
        try { return (await execute(tx, source, request.change, actorId, "Tax change preview; nothing saved", "preview")).preview; }
        finally { await tx.execute(sql`ROLLBACK TO SAVEPOINT purchase_tax_preview`); await tx.execute(sql`RELEASE SAVEPOINT purchase_tax_preview`); }
      });
    },
    async approve(input: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      const request = purchaseTaxApprovalRequestSchema.parse(input), scope = purchaseTaxCommandScope(targetFor(request.change));
      if (descriptor.actorType !== "user" || descriptor.actorId !== actorId || descriptor.method !== "POST"
        || descriptor.routeTemplate !== scope.routeTemplate || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName)
        throw new FinancialCommandError("Tax approval scope is invalid.", 403, "PURCHASE_TAX_SCOPE_INVALID");
      return runTransactionalFinancialCommand({ repository: commands, descriptor,
        classifyFailure(error) {
          if (error instanceof PurchaseTaxError || error instanceof InvoiceQuantityCorrectionError) return { kind: "rejected", httpStatus: error.statusCode,
            errorCode: error.code, errorMessage: error.message, body: { error: error.message, code: error.code } };
          if (error instanceof ApLedgerError) return { kind: "rejected", httpStatus: error.statusCode, errorCode: "PURCHASE_TAX_INVOICE_REVIEW", errorMessage: error.message, body: { error: error.message, code: "PURCHASE_TAX_INVOICE_REVIEW" } };
          if (error instanceof MoneyInputError) return { kind: "rejected", httpStatus: 422, errorCode: error.code, errorMessage: error.message, body: { error: error.message, code: error.code } };
          if (error instanceof CostEvidenceError || error instanceof PoQuantityAmendmentError || error instanceof ShipmentTrackingError)
            return { kind: "rejected", httpStatus: 409, errorCode: "PURCHASE_TAX_COST_REVIEW", errorMessage: error.message, body: { error: error.message, code: "PURCHASE_TAX_COST_REVIEW" } };
          if (error instanceof z.ZodError) return { kind: "rejected", httpStatus: 409, errorCode: "PURCHASE_TAX_SOURCE_INVALID", errorMessage: "Saved tax evidence is invalid.", body: { error: "Saved tax evidence is invalid. Reload the source.", code: "PURCHASE_TAX_SOURCE_INVALID" } };
          return { kind: "retryable", errorCode: "PURCHASE_TAX_RETRY", errorMessage: "The tax change rolled back. Retry the saved approval." };
        },
        work: async tx => {
          const source = await readPurchaseTaxChangeSource(tx, targetFor(request.change), actorId);
          assertInvoiceQuantityAuthority(source.actor); assertVersion(source.sourceVersion, request.sourceVersion);
          const result = await execute(tx, source, request.change, actorId, request.reason, descriptor.idempotencyKey);
          assertVersion(result.preview.previewVersion, request.previewVersion);
          return { httpStatus: 200, body: result, resultType: "purchase_tax_approval", resultId: result.auditEventId };
        },
      });
    },
  };
}
