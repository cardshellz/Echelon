import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { expectedShipmentInvoiceTotal, createShipmentInvoiceCommandSchema, shipmentInvoiceCommandRejectionSchema, shipmentInvoiceCommandResponseSchema, shipmentInvoiceIdSchema } from "@shared/procurement/shipment-invoice-command";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { FINANCIAL_COMMAND_CONTRACT_VERSION, FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import * as apLedger from "./ap-ledger.service";

export const SHIPMENT_INVOICE_COMMAND_PRINCIPAL = "procurement.shipment-invoice-create";
export function shipmentInvoiceCommandScope() {
  return { method: "POST", routeTemplate: "/api/inbound-shipments/create-invoice-command", resourceKey: "shipment:invoice:create", commandName: "procurement.shipment.invoice.create" } as const;
}
export function hashShipmentInvoiceCommandIdentity(input: { shipmentId: number; body: unknown; actorId: string }): string {
  return hashHttpFinancialCommand({ ...shipmentInvoiceCommandScope(), body: input });
}
export function classifyShipmentInvoiceFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof apLedger.ApLedgerError && error.statusCode >= 400 && error.statusCode < 500) {
    const code = String(error.details?.code ?? "SHIPMENT_INVOICE_REJECTED");
    return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message }, errorCode: code, errorMessage: error.message };
  }
  return { kind: "retryable", errorCode: "SHIPMENT_INVOICE_TRANSIENT_FAILURE", errorMessage: "Shipment invoice creation did not commit." };
}

type InvoiceOwner = Pick<typeof apLedger, "createInvoiceFromShipmentCostsInTransaction">;
export function createShipmentInvoiceCommands(
  owner: InvoiceOwner = apLedger,
  repository: FinancialCommandRepository<apLedger.ApLedgerDbClient> = financialCommandRepository,
  clock: () => Date = () => new Date(),
) {
  return {
    async execute(shipmentId: number, body: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      if (typeof actorId !== "string" || !actorId || actorId !== actorId.trim() || actorId.length > 100) throw new FinancialCommandError("An authenticated operator is required", 401, "SHIPMENT_INVOICE_ACTOR_REQUIRED");
      const scope = shipmentInvoiceCommandScope();
      if (descriptor.actorType !== "service" || descriptor.actorId !== SHIPMENT_INVOICE_COMMAND_PRINCIPAL
        || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate || descriptor.resourceKey !== scope.resourceKey
        || descriptor.commandName !== scope.commandName || descriptor.contractVersion !== FINANCIAL_COMMAND_CONTRACT_VERSION
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/.test(descriptor.idempotencyKey)) throw new FinancialCommandError("Shipment invoice command scope is invalid", 500, "SHIPMENT_INVOICE_SCOPE_INVALID");
      if (descriptor.requestHash !== hashShipmentInvoiceCommandIdentity({ shipmentId, body, actorId })) throw new FinancialCommandError("Shipment invoice identity differs from its request", 500, "SHIPMENT_INVOICE_IDENTITY_INVALID");
      const identity = { shipmentId, actorId, idempotencyKey: descriptor.idempotencyKey };
      const requested = createShipmentInvoiceCommandSchema.safeParse(body);
      const expectedTotal = requested.success ? expectedShipmentInvoiceTotal(requested.data) : null;
      const execution = await runTransactionalFinancialCommand({
        repository, descriptor,
        classifyFailure(error) {
          const failure = classifyShipmentInvoiceFailure(error);
          return failure.kind === "rejected" ? { ...failure, body: { ...(failure.body as Record<string, unknown>), ...identity, commandOutcome: "rejected" } } : failure;
        },
        work: async tx => {
          if (!shipmentInvoiceIdSchema.safeParse(shipmentId).success || !requested.success) throw new apLedger.ApLedgerError("Review the invoice number, dates and explicit charge selection.", 400, { code: "SHIPMENT_INVOICE_INPUT_INVALID" });
          const input = requested.data;
          const now = clock();
          if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Shipment invoice clock returned an invalid instant");
          await lockInventoryCostGraph(tx);
          const created = await owner.createInvoiceFromShipmentCostsInTransaction(tx, shipmentId, {
            ...input,
            invoiceDate: input.invoiceDate ? new Date(input.invoiceDate) : undefined,
            dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
          }, actorId, now);
          const sourceLines = z.array(z.object({ freightCostId: shipmentInvoiceIdSchema })).min(1).safeParse(created.lines);
          if (!sourceLines.success) throw new apLedger.ApLedgerError("Invoice creation returned invalid source lines", 500, { code: "SHIPMENT_INVOICE_RESULT_INVALID" });
          const parsed = shipmentInvoiceCommandResponseSchema.safeParse(JSON.parse(canonicalJson({
            ...created, ...identity, invoiceId: created.id, costRowIds: sourceLines.data.map(line => line.freightCostId), totalCents: created.invoicedAmountCents,
          })));
          if (!parsed.success || parsed.data.vendorId !== input.vendorId || parsed.data.invoiceNumber !== input.invoiceNumber
            || !sameIds(parsed.data.costRowIds, input.costRowIds) || (expectedTotal !== null && BigInt(parsed.data.totalCents) !== expectedTotal)) throw new apLedger.ApLedgerError("Invoice creation returned an invalid recovery identity", 500, { code: "SHIPMENT_INVOICE_RESULT_INVALID" });
          return { httpStatus: 200, body: parsed.data, resultType: "vendor_invoice", resultId: parsed.data.invoiceId };
        },
      });
      if (execution.terminalState === "succeeded") {
        const saved = shipmentInvoiceCommandResponseSchema.safeParse(execution.body);
        if (execution.httpStatus !== 200 || !saved.success || !requested.success
          || saved.data.shipmentId !== shipmentId || saved.data.actorId !== actorId || saved.data.idempotencyKey !== descriptor.idempotencyKey
          || saved.data.vendorId !== requested.data.vendorId || saved.data.invoiceNumber !== requested.data.invoiceNumber
          || !sameIds(saved.data.costRowIds, requested.data.costRowIds) || (expectedTotal !== null && BigInt(saved.data.totalCents) !== expectedTotal)) throw new FinancialCommandError("The saved invoice response needs review before recovery can continue", 500, "SHIPMENT_INVOICE_RESULT_INVALID");
      } else if (execution.terminalState === "rejected") {
        const saved = shipmentInvoiceCommandRejectionSchema.safeParse(execution.body);
        if (!saved.success || execution.httpStatus < 400 || execution.httpStatus >= 500 || saved.data.shipmentId !== shipmentId
          || saved.data.actorId !== actorId || saved.data.idempotencyKey !== descriptor.idempotencyKey) throw new FinancialCommandError("The saved invoice rejection needs review before recovery can continue", 500, "SHIPMENT_INVOICE_RESULT_INVALID");
      }
      return execution;
    },
  };
}
function sameIds(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every(id => expected.includes(id));
}
