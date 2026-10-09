import { z } from "zod";
import { invoiceQuantityIdSchema, invoiceQuantityPreviewRequestSchema, invoiceQuantityApprovalRequestSchema, invoiceQuantityResultSchema } from "@shared/procurement/invoice-quantity-correction";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";
import type { AmendmentDatabase } from "./po-quantity-amendment.repository";
import { readInvoiceQuantitySource, persistInvoiceQuantityCorrection, invoiceQuantityCorrectionTime } from "./invoice-quantity-correction.repository";
import { assertInvoiceQuantityAuthority, invoiceQuantityContext, planInvoiceQuantityCorrection, InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";

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
        return planInvoiceQuantityCorrection(source.facts, lineId, request);
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
          : error instanceof z.ZodError ? { kind: "rejected", httpStatus: 409, errorCode: "INVOICE_QUANTITY_SOURCE_INVALID", errorMessage: "Recorded quantity evidence is invalid.", body: { error: "Recorded quantity evidence is invalid. Reload the source records.", code: "INVOICE_QUANTITY_SOURCE_INVALID" } }
          : { kind: "retryable", errorCode: "INVOICE_QUANTITY_FAILED", errorMessage: "The correction rolled back. Retry the saved confirmation." },
        work: async (tx) => {
          const request = input(invoiceQuantityApprovalRequestSchema, value);
          const source = await readInvoiceQuantitySource(tx, lineId, actorId);
          assertInvoiceQuantityAuthority(source.actor); assertCurrent(source.sourceVersion, request.sourceVersion);
          const preview = planInvoiceQuantityCorrection(source.facts, lineId, request);
          const result = await persistInvoiceQuantityCorrection(tx, source, preview, actorId, descriptor.idempotencyKey, request.reason, invoiceQuantityCorrectionTime(source, clock()));
          return { httpStatus: 200, body: invoiceQuantityResultSchema.parse(result), resultType: "invoice_quantity_correction", resultId: result.auditEventId };
        },
      });
    },
  };
}
