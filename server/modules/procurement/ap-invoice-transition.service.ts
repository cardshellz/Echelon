import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { apInvoiceTransitionActionSchema, apInvoiceTransitionInputSchema, apInvoiceTransitionPreviewSchema, apInvoiceTransitionReceiptSchema,
  type ApInvoiceTransitionAction } from "@shared/procurement/ap-invoice-transition";
import { costFingerprint, costInteger, lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { readPurchaseInvoiceActionActor, readPurchaseApproverName } from "../identity/infrastructure/purchase-approval-access.repository";
import { ApLedgerError, executeApInvoiceCommandInTransaction, type ApInvoiceFinancialCommand, type ApprovedInvoiceVarianceReconciliationResult } from "./ap-ledger.service";
import { readInvoiceTransitionDocuments, readInvoiceTransitionHistory, retainInvoiceTransitionReview } from "./ap-invoice-transition.repository";
import { readPoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { readInvoiceCorrectionInventoryValues } from "./invoice-correction-cost-values";
import { buildCostDestinationImpact } from "./cost-change-impact";
import { readPoFinancialEvidenceSourcesWithClient } from "./po-financial-evidence.repository";
import { buildPoFinancialWorkflow } from "./domain/po-financial-workflow";
import type { AmendmentDatabase, AmendmentTransaction } from "./po-quantity-amendment.repository";

export const invoiceTransitionIdSchema = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));
const commands: Record<ApInvoiceTransitionAction, ApInvoiceFinancialCommand> = { approve: "approve_invoice", dispute: "dispute_invoice", void: "void_invoice" };
const dateText = (value: unknown): string | null => value == null ? null : z.coerce.date().parse(value).toISOString();
function document(row: Record<string, unknown>) {
  return { status: row.status, currency: row.currency,
    amountCents: costInteger(row.invoiced_amount_cents, "invoice amount"), paidCents: costInteger(row.paid_amount_cents, "paid amount"),
    balanceCents: costInteger(row.balance_cents, "invoice balance"),
    approvedBy: row.approved_by == null ? null : String(row.approved_by), approvedAt: dateText(row.approved_at) };
}

/** One simulation and commit adapter around the existing AP and cost owners.
 * A preview rolls back the real writes; no alternative valuation engine exists. */
export async function reviewInvoiceTransitionInTransaction(tx: AmendmentTransaction, invoiceId: number,
  action: ApInvoiceTransitionAction, input: unknown, actorId: string, clockValue: Date, commandKey?: string) {
  z.number().int().positive().max(2_147_483_647).parse(invoiceId);
  apInvoiceTransitionActionSchema.parse(action);
  const request = apInvoiceTransitionInputSchema.parse(input);
  if (commandKey && !request.previewVersion) throw new ApLedgerError("Review the invoice changes before saving.", 409,
    { code: "AP_INVOICE_TRANSITION_PREVIEW_REQUIRED" });
  if (!(clockValue instanceof Date) || !Number.isFinite(clockValue.getTime()))
    throw new ApLedgerError("Invoice action time is unavailable. Retry the saved action.", 503, { code: "AP_INVOICE_TRANSITION_CLOCK_INVALID" });
  const at = new Date(clockValue.getTime());
  await lockInventoryCostGraph(tx);
  const before = await readInvoiceTransitionDocuments(tx, invoiceId);
  const lineIds = [...new Set(before.lines.flatMap(row => row.purchase_order_line_id == null ? [] : [costInteger(row.purchase_order_line_id, "purchaseOrderLineId", 1)]))];
  const options = { shipmentIds: before.invoice.inbound_shipment_id == null ? [] : [costInteger(before.invoice.inbound_shipment_id, "shipmentId", 1)] };
  const dependencies = await readPoAmendmentDependencies(tx, lineIds, options);
  const purchaseOrderIds = [...new Set(before.links.map(row => costInteger(row.purchase_order_id, "purchaseOrderId", 1)))].sort((a, b) => a - b);
  // Use the canonical attributed financial owner, never the legacy whole-bill
  // compatibility caches. A shared invoice must not be counted once per PO.
  const beforeFinancialSources = await readPoFinancialEvidenceSourcesWithClient(tx, purchaseOrderIds);
  if (beforeFinancialSources.size !== purchaseOrderIds.length) throw new ApLedgerError("A linked purchase order is missing. Review the invoice links.", 409,
    { code: "AP_INVOICE_TRANSITION_PURCHASE_MISSING" });
  const authority = await readPurchaseInvoiceActionActor(tx, actorId, action === "dispute" ? "edit" : "approve");
  if (!authority.active || !authority.grantIds.length) throw new ApLedgerError("Your current purchasing permission does not allow this invoice action.", 403,
    { code: "AP_INVOICE_TRANSITION_PERMISSION_REQUIRED" });
  const beforeValues = await readInvoiceCorrectionInventoryValues(tx, dependencies);
  const result = await executeApInvoiceCommandInTransaction(commands[action], { invoiceId, userId: actorId, reason: request.reason, now: at }, tx);
  const after = await readInvoiceTransitionDocuments(tx, invoiceId);
  const afterDependencies = await readPoAmendmentDependencies(tx, lineIds, options);
  const afterFinancialSources = await readPoFinancialEvidenceSourcesWithClient(tx, purchaseOrderIds);
  const purchaseOrders = purchaseOrderIds.map(purchaseOrderId => {
    const previous = beforeFinancialSources.get(purchaseOrderId), next = afterFinancialSources.get(purchaseOrderId);
    if (!previous || !next) throw new Error("Invoice transition lost a linked purchase financial source");
    return { purchaseOrderId, before: buildPoFinancialWorkflow(previous), after: buildPoFinancialWorkflow(next) };
  });
  const impact = buildCostDestinationImpact(dependencies, afterDependencies);
  const afterValues = new Map((await readInvoiceCorrectionInventoryValues(tx, afterDependencies)).map(row => [row.lotId, row]));
  const inventoryValues = beforeValues.map(row => {
    const next = afterValues.get(row.lotId);
    if (!next || next.onHandUnits !== row.onHandUnits) throw new Error("Invoice transition changed inventory quantities");
    return { lotId: row.lotId, lotNumber: row.lotNumber, onHandUnits: row.onHandUnits,
      beforeMills: row.onHandValueMills, afterMills: next.onHandValueMills, reviewReason: next.valueReviewReason };
  });
  const reconciliations: ApprovedInvoiceVarianceReconciliationResult[] = result.invoiceCostReconciliations;
  const costReviews = reconciliations.map(row => ({ purchaseOrderLineId: row.purchaseOrderLineId, state: row.state,
    issues: [...new Map([...row.costSources.flatMap(source => source.contract.issue ? [source.contract.issue] : []),
      ...row.costApplications.flatMap(application => application.issues)].map(issue => [`${issue.code}:${issue.message}`, issue])).values()] }));
  const measured = { invoiceId, action, reason: request.reason, before: document(before.invoice), after: document(after.invoice), impact, inventoryValues, costReviews, purchaseOrders };
  // Clock/generated identities are retained in the receipt, not hashed as
  // economic inputs. Original document approval and all prior evidence ARE bound.
  const previewVersion = costFingerprint({ contract: 2, invoiceId, action, reason: request.reason, before, dependencies, authority,
    beforePurchaseFinancialSources: [...beforeFinancialSources.entries()], purchaseOrders,
    impact, inventoryValues, costReviews, afterStatus: after.invoice.status,
    sources: reconciliations.flatMap(row => row.costSources.map(source => source.contract)) });
  const validated = apInvoiceTransitionPreviewSchema.safeParse({ ...measured, previewVersion });
  if (!validated.success) throw new Error("Invoice transition owner returned an invalid preview");
  const preview = validated.data;
  if (request.previewVersion && request.previewVersion !== previewVersion) throw new ApLedgerError(
    "The invoice, stock, costs or purchasing permissions changed. Review the current changes before saving.", 409, { code: "AP_INVOICE_TRANSITION_STALE" });
  if (!commandKey) return { result, preview };
  const receipt = apInvoiceTransitionReceiptSchema.parse({ preview, actorId, actorName: await readPurchaseApproverName(tx, actorId), approvedAt: at.toISOString() });
  await retainInvoiceTransitionReview(tx, receipt, commandKey, authority,
    result.apLedgerOutcome.affectedPurchaseOrderIds);
  return { result: { ...result, transitionReview: receipt }, preview };
}

export function createInvoiceTransitionPreview(database: AmendmentDatabase, clock: () => Date) {
  return async (invoiceId: number, action: ApInvoiceTransitionAction, input: unknown, actorId: string) => {
    const request = apInvoiceTransitionInputSchema.parse(input);
    if (request.previewVersion !== undefined) throw new ApLedgerError("Start a new invoice preview before saving.", 400);
    return database.transaction(async tx => {
      await tx.execute(sql`SAVEPOINT invoice_transition_preview`);
      try { return (await reviewInvoiceTransitionInTransaction(tx, invoiceId, action, request, actorId, clock())).preview; }
      finally { await tx.execute(sql`ROLLBACK TO SAVEPOINT invoice_transition_preview`); await tx.execute(sql`RELEASE SAVEPOINT invoice_transition_preview`); }
    });
  };
}
export const previewInvoiceTransition = createInvoiceTransitionPreview(db, () => new Date());
export function createInvoiceTransitionHistory(database: AmendmentDatabase) {
  return async (invoiceId: number) => {
    z.number().int().positive().max(2_147_483_647).parse(invoiceId);
    return database.transaction(tx => readInvoiceTransitionHistory(tx, invoiceId));
  };
}
export const getInvoiceTransitionHistory = createInvoiceTransitionHistory(db);
