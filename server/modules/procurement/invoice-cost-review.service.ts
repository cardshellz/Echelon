import { z } from "zod";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { invoiceCostReviewSchema, invoiceCostReviewResultSchema } from "@shared/procurement/invoice-cost-review";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { COGSService } from "../inventory/cogs.service";
import { costInteger, lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { ApLedgerError, invoiceCostReviewVersion } from "./ap-ledger.service";
import { reconcilePurchaseCostEvidence } from "./purchase-cost-application.service";

export function createInvoiceCostReviewCommands(repository: FinancialCommandRepository<any> = financialCommandRepository, clock: () => Date = () => new Date()) {
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
          return { kind: "retryable", errorCode: "INVOICE_COST_REVIEW_RETRY", errorMessage: "Invoice component review rolled back before commit." };
        },
        work: async (tx) => {
          const review = invoiceCostReviewSchema.parse(input);
          await lockInventoryCostGraph(tx);
          const result = await tx.execute(sql`
            SELECT line.*,invoice.status AS invoice_status,invoice.currency
            FROM procurement.vendor_invoice_lines line JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id
            WHERE line.id=${lineId} FOR UPDATE OF invoice,line
          `);
          const line = result.rows[0];
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
          const now = clock();
          if (!Number.isFinite(now.getTime())) throw new Error("Invalid cost-review clock");
          const after = { contractVersion: 1, packagingTreatment: review.packagingTreatment, productMills: review.productMills,
            packagingMills: review.packagingMills, adjustmentMills: review.adjustmentMills, source: "operator_review" };
          await tx.execute(sql`UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=${canonicalJson(after)}::jsonb,updated_at=${now} WHERE id=${lineId}`);
          const application = line.purchase_order_line_id === null ? null : await reconcilePurchaseCostEvidence(tx, Number(line.purchase_order_line_id), new COGSService(tx), actorId, now);
          const response = invoiceCostReviewResultSchema.safeParse({ id: lineId, costComponentEvidence: after,
            costReviewVersion: invoiceCostReviewVersion({ ...versioned, costComponentEvidence: after }), application });
          if (!response.success) throw new Error("Invoice cost-review owner produced an invalid result");
          await tx.execute(sql`
            INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
            VALUES (${now},'AUDIT',${actorId},'procurement.invoice.cost_components',${`invoice-line:${lineId}`},
              ${canonicalJson({ before: line.cost_component_evidence, after })}::jsonb,
              ${canonicalJson({ invoiceId: Number(line.vendor_invoice_id), invoiceLineId: lineId, reason: review.reason, expectedVersion: review.expectedVersion, unchangedLineTotalCents: String(line.line_total_cents), application })}::jsonb)
          `);
          return { httpStatus: 200, resultType: "vendor_invoice_line", resultId: lineId,
            body: response.data };
        },
      });
    },
  };
}

export const invoiceCostReviewCommands = createInvoiceCostReviewCommands();
