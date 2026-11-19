import { z } from "zod";
import { sql } from "drizzle-orm";
import { invoiceQuantityIdSchema, invoiceQuantityPreviewRequestSchema, invoiceQuantityApprovalRequestSchema, invoiceQuantityResultSchema } from "@shared/procurement/invoice-quantity-correction";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";
import type { AmendmentDatabase, AmendmentTransaction } from "./po-quantity-amendment.repository";
import { readInvoiceQuantitySource, persistInvoiceQuantityCorrection, recordInvoiceQuantityCorrectionResult, invoiceQuantityCorrectionTime } from "./invoice-quantity-correction.repository";
import { assertInvoiceQuantityAuthority, invoiceQuantityContext, planInvoiceQuantityCorrection, InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { applyInvoiceCorrectionCosts, readInvoiceCorrectionCostDependencies } from "./invoice-correction-costs.service";
import { readInvoiceCorrectionInventoryValues } from "./invoice-correction-cost-values";
import { CostEvidenceError, costFingerprint } from "../inventory/infrastructure/cost-evidence-values";
import { PoQuantityAmendmentError } from "./po-quantity-amendment.policy";
import type { InvoiceQuantityPreview } from "@shared/procurement/invoice-quantity-correction";

import { buildCurrentPurchaseApprovalSnapshot, PurchaseApprovalAuthorityError } from "./purchase-order-approval.policy";
function correctionApproval(source: Awaited<ReturnType<typeof readInvoiceQuantitySource>>, invoiceTotalCents: number) {
  if (source.facts.invoices.find(row => row.id === source.facts.billing.invoiceId)?.currency !== source.facts.header.currency) {
    throw new InvoiceQuantityCorrectionError("Invoice and PO currency differ. Review their currency conversion through the owning workflow.", "INVOICE_CORRECTION_CURRENCY_REVIEW_REQUIRED");
  }
  return buildCurrentPurchaseApprovalSnapshot({ ...source, totalCents: Math.max(z.number().int().nonnegative().safe().parse(source.facts.header.totalCents), invoiceTotalCents) });
}
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvoiceQuantityCorrectionError("Enter a positive whole-piece quantity and include a correction reason.", "INVOICE_QUANTITY_INPUT_INVALID", 400);
  return parsed.data;
}
function assertCurrent(actual: string, expected: string) {
  if (actual !== expected) throw new InvoiceQuantityCorrectionError("The invoice, PO, receipts or approval permissions changed. Reload and review the new values before confirming.", "INVOICE_QUANTITY_STALE");
}
export function createInvoiceQuantityCorrectionService(database: AmendmentDatabase, clock: () => Date) {
  const repository = createDrizzleFinancialCommandRepository(database);
  async function execute(tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readInvoiceQuantitySource>>,
    preview: InvoiceQuantityPreview, approval: ReturnType<typeof correctionApproval>, actorId: string,
    commandKey: string, reason: string, closedPurchaseOrderConfirmed: boolean) {
    const line = source.facts.invoiceLines.find(row => row.id === preview.invoiceLineId)!;
    if (line.purchaseOrderLineId === null) throw new InvoiceQuantityCorrectionError("The invoice line needs a purchase source before costing.", "INVOICE_QUANTITY_LINK_MISSING");
    const before = await readInvoiceCorrectionCostDependencies(tx, line.purchaseOrderLineId);
    const beforeValues = await readInvoiceCorrectionInventoryValues(tx, before);
    const at = invoiceQuantityCorrectionTime(source, clock());
    const saved = await persistInvoiceQuantityCorrection(tx, source, preview, actorId, at);
    const costs = await applyInvoiceCorrectionCosts(tx, line.purchaseOrderLineId, before, beforeValues, actorId, at);
    const reviewed = { ...preview, costing: costs.impact };
    const finalPreview = { ...reviewed, previewVersion: costFingerprint(reviewed) };
    return recordInvoiceQuantityCorrectionResult(tx, source, saved, finalPreview, actorId, commandKey, reason,
      at, approval, closedPurchaseOrderConfirmed, costs.application);
  }
  return {
    async context(id: number, actorId: string) {
      const lineId = input(invoiceQuantityIdSchema, id);
      return database.transaction(async (tx) => {
        const source = await readInvoiceQuantitySource(tx, lineId, actorId);
        return invoiceQuantityContext(source.facts, lineId, source.actor, source.sourceVersion);
      });
    },
    async preview(id: number, value: unknown, actorId: string) {
      const lineId = input(invoiceQuantityIdSchema, id);
      const request = input(invoiceQuantityPreviewRequestSchema, value);
      return database.transaction(async (tx) => {
        const source = await readInvoiceQuantitySource(tx, lineId, actorId);
        assertInvoiceQuantityAuthority(source.actor); assertCurrent(source.sourceVersion, request.sourceVersion);
        const preview = planInvoiceQuantityCorrection(source.facts, lineId, request);
        const approval = correctionApproval(source, preview.afterInvoiceAmountCents!);
        // Measure the same document/cost/audit owners used by approval. All
        // database writes are rolled back; no physical operation is replayed.
        await tx.execute(sql`SAVEPOINT invoice_correction_preview`);
        try { return (await execute(tx, source, preview, approval, actorId, "preview",
          "Invoice correction preview; no changes saved", request.closedPurchaseOrderConfirmed === true)).preview; }
        finally {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT invoice_correction_preview`);
          await tx.execute(sql`RELEASE SAVEPOINT invoice_correction_preview`);
        }
      });
    },
    async approve(id: number, value: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      const lineId = input(invoiceQuantityIdSchema, id);
      const route = "/api/vendor-invoice-lines/:lineId/quantity-correction";
      if (descriptor.actorType !== "user" || descriptor.actorId !== actorId || descriptor.method !== "POST"
        || descriptor.routeTemplate !== route || descriptor.resourceKey !== `vendor_invoice_line:${lineId}` || descriptor.commandName !== "ap.invoice.quantity_correction") {
        throw new FinancialCommandError("The correction command does not match this invoice line or approver.", 403, "INVOICE_QUANTITY_SCOPE_INVALID");
      }
      return runTransactionalFinancialCommand({ repository, descriptor,
        classifyFailure: (error) => error instanceof InvoiceQuantityCorrectionError ? { kind: "rejected", httpStatus: error.statusCode,
          errorCode: error.code, errorMessage: error.message, body: { error: error.message, code: error.code } }
          : error instanceof PurchaseApprovalAuthorityError ? { kind: "rejected", httpStatus: error.statusCode,
            errorCode: String(error.details.code), errorMessage: error.message, body: { error: error.message, code: error.details.code } }
          : error instanceof CostEvidenceError || error instanceof PoQuantityAmendmentError ? { kind: "rejected", httpStatus: 409,
            errorCode: "INVOICE_QUANTITY_COST_REVIEW_REQUIRED", errorMessage: error.message,
            body: { error: error.message, code: "INVOICE_QUANTITY_COST_REVIEW_REQUIRED" } }
          : error instanceof z.ZodError ? { kind: "rejected", httpStatus: 409, errorCode: "INVOICE_QUANTITY_SOURCE_INVALID", errorMessage: "Recorded quantity evidence is invalid.", body: { error: "Recorded quantity evidence is invalid. Reload the source records.", code: "INVOICE_QUANTITY_SOURCE_INVALID" } }
          : { kind: "retryable", errorCode: "INVOICE_QUANTITY_FAILED", errorMessage: "The correction rolled back. Retry the saved confirmation." },
        work: async (tx) => {
          const request = input(invoiceQuantityApprovalRequestSchema, value);
          const source = await readInvoiceQuantitySource(tx, lineId, actorId);
          assertInvoiceQuantityAuthority(source.actor); assertCurrent(source.sourceVersion, request.sourceVersion);
          const preview = planInvoiceQuantityCorrection(source.facts, lineId, request);
          const approval = correctionApproval(source, preview.afterInvoiceAmountCents!);
          if (!request.previewVersion) throw new InvoiceQuantityCorrectionError("Review the invoice and inventory cost changes before approving this correction.", "INVOICE_QUANTITY_PREVIEW_REQUIRED");
          const result = await execute(tx, source, preview, approval, actorId, descriptor.idempotencyKey, request.reason, request.closedPurchaseOrderConfirmed === true);
          if (result.preview.previewVersion !== request.previewVersion) throw new InvoiceQuantityCorrectionError("The inventory cost impact changed. Reload and review this correction again.", "INVOICE_QUANTITY_STALE");
          return { httpStatus: 200, body: invoiceQuantityResultSchema.parse(result), resultType: "invoice_quantity_correction", resultId: result.auditEventId };
        },
      });
    },
  };
}
