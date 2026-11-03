import { z } from "zod";
import { invoiceCostReviewSchema, invoiceCostReviewResultSchema, invoiceCostImpactPreviewSchema, invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-review";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { COGSService } from "../inventory/cogs.service";
import { costFingerprint, costInteger, lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { readPoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { buildCostDestinationImpact } from "./cost-change-impact";
import { ApLedgerError, invoiceCostReviewVersion } from "./ap-ledger.service";
import { reconcilePurchaseCostEvidence } from "./purchase-cost-application.service";
import { readPurchaseApprovalActor, readPurchaseApproverName } from "../identity/infrastructure/purchase-approval-access.repository";
import { hasQuantityAmendmentAuthority, PoQuantityAmendmentError } from "./po-quantity-amendment.policy";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { MoneyInputError } from "@shared/money-read";
import { isApprovedCostInvoiceStatus } from "@shared/procurement/purchase-cost-authority";
import { readInvoiceCorrectionInventoryValues } from "./invoice-correction-cost-values";
import { readInvoiceCostReviewLine, persistInvoiceCostComponents, recordInvoiceCostReview } from "./invoice-cost-review.repository";

import type { AmendmentTransaction } from "./po-quantity-amendment.repository";

type ReviewExecution =
  | { kind: "preview" }
  | { kind: "approval"; commandKey: string }
  // Tax/origin commands bind their own complete preview and authority. They
  // stage components before their existing owner applies the complete change.
  | { kind: "nested" };

/** Shared transactional component review. New standalone approvals require the
 * measured preview; nested tax/origin commands keep their owning approval. */
export async function reviewInvoiceCostComponentsInTransaction(tx: AmendmentTransaction, lineId: number, input: unknown, actorId: string, now: Date, execution: ReviewExecution) {
  const review = invoiceCostReviewSchema.parse(input);
  if (execution.kind === "approval" && review.previewVersion === undefined)
    throw new ApLedgerError("Review the cost changes before approving them.", 409, { code: "INVOICE_COST_REVIEW_PREVIEW_REQUIRED" });
  await lockInventoryCostGraph(tx);
  const line = await readInvoiceCostReviewLine(tx, lineId);
  if (!line) throw new ApLedgerError("Invoice line not found", 404);
  if (line.invoice_status === "voided" || line.currency !== "USD") throw new ApLedgerError("Cost review requires a nonvoid USD invoice", 409);
  // Raw PostgreSQL BIGINTs must be checked before conversion; rounding
  // the stored value would fingerprint evidence the operator never saw.
  const signedInteger = (value: unknown, field: string) => costInteger(value, field, -Number.MAX_SAFE_INTEGER);
  const versioned = { id: costInteger(line.id, "invoiceLineId", 1), qtyInvoiced: signedInteger(line.qty_invoiced, "qtyInvoiced"),
    unitCostCents: signedInteger(line.unit_cost_cents, "unitCostCents"),
    unitCostMills: line.unit_cost_mills === null ? null : signedInteger(line.unit_cost_mills, "unitCostMills"),
    lineTotalCents: signedInteger(line.line_total_cents, "lineTotalCents"), costComponentEvidence: line.cost_component_evidence };
  if (review.expectedVersion !== invoiceCostReviewVersion(versioned)) throw new ApLedgerError("Invoice line changed. Refresh and review the current amounts.", 409, { code: "INVOICE_COST_REVIEW_STALE" });
  const total = BigInt(review.productMills) + BigInt(review.packagingMills) + BigInt(review.adjustmentMills);
  if (total !== BigInt(versioned.lineTotalCents) * BigInt(100)) {
    throw new ApLedgerError("Product, packaging and adjustments must equal the recorded invoice line total exactly.", 422, { code: "INVOICE_COST_COMPONENT_TOTAL_MISMATCH" });
  }
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid cost-review clock");
  const captureImpact = execution.kind !== "nested";
  const purchaseLineId = line.purchase_order_line_id == null ? null : costInteger(line.purchase_order_line_id, "purchaseOrderLineId", 1);
  const before = captureImpact && purchaseLineId !== null ? await readPoAmendmentDependencies(tx, [purchaseLineId]) : null;
  // Keep the shared graph/document/dependency/IAM lock order. Middleware/session
  // permission checks cannot authorize a financial write after revocation.
  const authority = captureImpact ? await readPurchaseApprovalActor(tx, actorId) : null;
  if (authority && !hasQuantityAmendmentAuthority(authority))
    throw new ApLedgerError("An Administrator with purchasing approval permission must approve supplier cost changes.", 403, { code: "INVOICE_COST_REVIEW_ADMIN_REQUIRED" });
  const beforeValues = before ? await readInvoiceCorrectionInventoryValues(tx, before) : [];
  const after = invoiceCostComponentEvidenceSchema.parse({ contractVersion: 1, packagingTreatment: review.packagingTreatment, productMills: review.productMills,
    packagingMills: review.packagingMills, adjustmentMills: review.adjustmentMills, source: "operator_review",
    ...(review.adjustments === undefined ? {} : { adjustments: review.adjustments }) });
  await persistInvoiceCostComponents(tx, lineId, after, now);
  const application = execution.kind === "nested" || purchaseLineId === null ? null : await reconcilePurchaseCostEvidence(tx, purchaseLineId, new COGSService(tx), actorId, now);
  const afterDependencies = before && purchaseLineId !== null ? await readPoAmendmentDependencies(tx, [purchaseLineId]) : null;
  const impact = before && afterDependencies ? buildCostDestinationImpact(before, afterDependencies) : { lots: [], orderCosts: [], historicalCosts: [] };
  const afterValues = new Map((afterDependencies ? await readInvoiceCorrectionInventoryValues(tx, afterDependencies) : []).map(row => [row.lotId, row]));
  const inventoryValues = beforeValues.map(row => {
    const next = afterValues.get(row.lotId);
    if (!next || next.onHandUnits !== row.onHandUnits) throw new Error("Supplier cost review changed inventory quantities");
    return { lotId: row.lotId, lotNumber: row.lotNumber, onHandUnits: row.onHandUnits,
      beforeMills: row.onHandValueMills, afterMills: next.onHandValueMills, reviewReason: next.valueReviewReason };
  });
  const prior = invoiceCostComponentEvidenceSchema.safeParse(line.cost_component_evidence);
  const preview = captureImpact ? invoiceCostImpactPreviewSchema.parse({ lineId, lineTotalCents: versioned.lineTotalCents,
    before: prior.success ? prior.data : null, after, impact, inventoryValues,
    previewVersion: costFingerprint({ reviewContract: 2, expectedVersion: review.expectedVersion,
      // Settlement progress does not change approved costing authority.
      invoiceAuthority: isApprovedCostInvoiceStatus(line.invoice_status) ? "approved" : line.invoice_status,
      currency: line.currency, authority, after, before, impact, inventoryValues,
      sources: application?.costSources.map(row => row.contract) ?? [],
      outcomes: application?.costApplications.map(row => ({ status: row.status, issues: row.issues })) ?? [],
    }),
  }) : undefined;
  if (review.previewVersion !== undefined && review.previewVersion !== preview?.previewVersion)
    throw new ApLedgerError("The stock or cost records changed. Review the current cost changes again before saving.", 409, { code: "INVOICE_COST_REVIEW_STALE" });
  const response = invoiceCostReviewResultSchema.safeParse({ id: lineId, costComponentEvidence: after,
    costReviewVersion: invoiceCostReviewVersion({ ...versioned, costComponentEvidence: after }), application, ...(preview ? { preview } : {}) });
  if (!response.success) throw new Error("Invoice cost-review owner produced an invalid result");
  const actorName = authority ? await readPurchaseApproverName(tx, actorId) : null;
  const context = { invoiceId: costInteger(line.vendor_invoice_id, "invoiceId", 1), invoiceLineId: lineId,
    reason: review.reason, expectedVersion: review.expectedVersion, unchangedLineTotalCents: String(line.line_total_cents),
    application, ...(authority ? { reviewContract: 2, actorName, authority, preview,
      ...(execution.kind === "approval" ? { commandKey: execution.commandKey } : {}) } : {}) };
  await recordInvoiceCostReview(tx, { lineId, purchaseOrderLineId: purchaseLineId, actorId, at: now,
    before: line.cost_component_evidence, after, context, retainApproval: execution.kind === "approval" });
  return { httpStatus: 200, resultType: "vendor_invoice_line", resultId: lineId,
    body: response.data };
}

export function createInvoiceCostReviewCommands(repository: FinancialCommandRepository<AmendmentTransaction> = financialCommandRepository, clock: () => Date = () => new Date()) {
  return {
    async review(lineId: number, input: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      if (!Number.isSafeInteger(lineId) || lineId <= 0 || lineId > 2_147_483_647) throw new ApLedgerError("Invoice line ID is invalid", 400);
      if (!actorId?.trim()) throw new ApLedgerError("An authenticated cost reviewer is required", 401);
      if (descriptor.actorId !== actorId || descriptor.actorType !== "user" || descriptor.method !== "POST"
        || descriptor.routeTemplate !== "/api/vendor-invoice-lines/:lineId/cost-components"
        || descriptor.resourceKey !== `vendor_invoice_line:${lineId}` || descriptor.commandName !== "ap.invoice.cost_components") {
        throw new FinancialCommandError("Invoice cost-review command scope is invalid", 500, "INVOICE_COST_REVIEW_SCOPE_INVALID");
      }
      return runTransactionalFinancialCommand({ repository, descriptor,
        classifyFailure(error) {
          if (error instanceof z.ZodError) return { kind: "rejected", httpStatus: 400, body: { error: "Invalid invoice component review", details: error.flatten() }, errorCode: "INVOICE_COST_REVIEW_INVALID", errorMessage: "Invalid invoice component review" };
          if (error instanceof ApLedgerError) return { kind: "rejected", httpStatus: error.statusCode, body: { error: error.message, details: error.details }, errorCode: "INVOICE_COST_REVIEW_REJECTED", errorMessage: error.message };
          if (error instanceof CostEvidenceError || error instanceof PoQuantityAmendmentError || error instanceof MoneyInputError)
            return { kind: "rejected", httpStatus: error instanceof PoQuantityAmendmentError ? error.statusCode : 409,
              body: { error: error.message, details: { code: error.code } }, errorCode: error.code, errorMessage: error.message };
          return { kind: "retryable", errorCode: "INVOICE_COST_REVIEW_RETRY", errorMessage: "Invoice component review rolled back before commit." };
        },
        // Validation belongs inside work: already committed legacy command
        // receipts replay unchanged, without acquiring new posting authority.
        work: (tx) => reviewInvoiceCostComponentsInTransaction(tx, lineId, input, actorId, clock(), { kind: "approval", commandKey: descriptor.idempotencyKey }),
      });
    },
  };
}

export const invoiceCostReviewCommands = createInvoiceCostReviewCommands();
