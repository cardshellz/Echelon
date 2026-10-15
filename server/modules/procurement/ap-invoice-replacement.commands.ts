import type { ReplacementInvoiceInput } from "@shared/procurement/invoice-replacement";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { classifyApInvoiceCommandFailure } from "./ap-invoice-commands";
import { ApLedgerError, type ApLedgerDbClient } from "./ap-ledger.service";
import { replaceVoidedInvoiceInTransaction } from "./ap-invoice-replacement.service";

export function createApInvoiceReplacementCommands(
  repository: FinancialCommandRepository<ApLedgerDbClient> = financialCommandRepository,
  clock: () => Date = () => new Date(),
) {
  return {
    createReplacement(invoiceId: number, input: ReplacementInvoiceInput & { userId?: string }, descriptor: FinancialCommandDescriptor) {
      if (descriptor.commandName !== "ap.invoice.replacement" || descriptor.resourceKey !== `vendor_invoice:${invoiceId}`
        || descriptor.routeTemplate !== "/api/vendor-invoices/:id/replacement" || descriptor.method !== "POST"
        || (input.userId !== undefined && input.userId !== descriptor.actorId)) {
        throw new ApLedgerError("Invoice replacement command scope is invalid", 400, { code: "AP_INVOICE_REPLACEMENT_SCOPE_INVALID" });
      }
      return runTransactionalFinancialCommand({ repository, descriptor, classifyFailure: classifyApInvoiceCommandFailure,
        work: async tx => {
          const { userId: _userId, ...request } = input;
          const body = await replaceVoidedInvoiceInTransaction(tx, invoiceId, request, descriptor.actorId, clock());
          return { httpStatus: 201, body, resultType: "vendor_invoice", resultId: body.invoiceId };
        },
      });
    },
  };
}
export const apInvoiceReplacementCommands = createApInvoiceReplacementCommands();
