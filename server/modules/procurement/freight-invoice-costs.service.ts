import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { freightInvoiceIdSchema, freightInvoicePreviewRequestSchema, freightInvoiceApprovalRequestSchema,
  freightInvoicePreviewSchema, freightInvoiceResultSchema } from "@shared/procurement/freight-invoice-costs";
import { readIntegerCents, MoneyInputError } from "@shared/money-read";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";
import { CostEvidenceError, costFingerprint, costInteger } from "../inventory/infrastructure/cost-evidence.repository";
import { FreightInvoiceCostError } from "./domain/freight-invoice-costs";
import { purchaseTaxApprovalTime } from "./domain/purchase-tax";
import { assertInvoiceQuantityAuthority, InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { executeApInvoiceCommandInTransaction, ApLedgerError } from "./ap-ledger.service";
import type { AmendmentDatabase, AmendmentTransaction } from "./po-quantity-amendment.repository";
import type { ShipmentTrackingService } from "./shipment-tracking.service";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import { readFreightInvoiceReviewSource, persistFreightInvoiceChargeAmounts, recordFreightInvoiceCostApproval, readPoFreightInvoiceApprovalHistory } from "./freight-invoice-costs.repository";
import { readInvoiceCorrectionInventoryValues } from "./invoice-correction-cost-values";
import { buildCostDestinationImpact } from "./cost-change-impact";
import { PoQuantityAmendmentError } from "./po-quantity-amendment.policy";

export function freightInvoiceCommandScope(invoiceId: number) {
  freightInvoiceIdSchema.parse(invoiceId);
  return { method: "POST", routeTemplate: "/api/vendor-invoices/:id/shipment-cost-review/approve",
    resourceKey: `vendor_invoice:${invoiceId}`, commandName: "procurement.freight_invoice_costs.approve" };
}
function current(actual: string, expected: string) {
  if (actual !== expected) throw new FreightInvoiceCostError("The invoice, shipment, stock or approval authority changed. Reload and review the new costs.", "FREIGHT_INVOICE_STALE");
}
type Source = Awaited<ReturnType<typeof readFreightInvoiceReviewSource>>;
function allocations(before: Source, after: Source) {
  const amount = (source: Source, chargeId: number, lineId: number): number | null => {
    const found = source.dependencies.allocations.filter(row => costInteger(row.shipment_cost_id, "chargeId", 1) === chargeId
      && costInteger(row.inbound_shipment_line_id, "shipmentLineId", 1) === lineId);
    if (found.length > 1) throw new FreightInvoiceCostError("A charge has duplicate saved line allocations. Review its allocation records.", "FREIGHT_INVOICE_ALLOCATION_REVIEW");
    return found.length ? readIntegerCents(found[0].allocated_cents) : null;
  };
  return before.plan!.charges.flatMap(charge => {
    const rows = after.dependencies.shipmentLines.filter(row => costInteger(row.inbound_shipment_id, "shipmentId", 1) === charge.shipmentId)
      .map(line => {
        const lineId = costInteger(line.id, "shipmentLineId", 1), afterCents = amount(after, charge.chargeId, lineId);
        if (afterCents === null && charge.invoiceCents !== 0) throw new FreightInvoiceCostError("The updated shipment charge has an incomplete allocation. No changes were saved.", "FREIGHT_INVOICE_ALLOCATION_REVIEW");
        return { chargeId: charge.chargeId, shipmentId: charge.shipmentId, shipmentLineId: lineId,
          purchaseOrderId: line.purchase_order_id == null ? null : costInteger(line.purchase_order_id, "purchaseOrderId", 1),
          purchaseOrderNumber: line.purchase_order_id == null ? null : after.purchaseOrders.find(row => costInteger(row.id,"purchaseOrderId",1) === costInteger(line.purchase_order_id,"purchaseOrderId",1))?.po_number ?? null,
          purchaseOrderLineId: line.purchase_order_line_id == null ? null : costInteger(line.purchase_order_line_id, "purchaseOrderLineId", 1),
          label: String(line.product_name || line.sku || `Shipment line ${lineId}`), shippedPieces: costInteger(line.qty_shipped, "shipped pieces"),
          amountCents: { before: amount(before, charge.chargeId, lineId), after: afterCents ?? 0 } };
      });
    if (!rows.length || rows.reduce((sum, row) => sum + BigInt(row.amountCents.after), BigInt(0)) !== BigInt(charge.invoiceCents))
      throw new FreightInvoiceCostError("The updated shipment shares do not conserve the invoice charge. No changes were saved.", "FREIGHT_INVOICE_ALLOCATION_REVIEW");
    return rows;
  });
}
export function createFreightInvoiceCostService(database: AmendmentDatabase,
  shipmentTracking: Pick<ShipmentTrackingService, "refreshQuantityAllocationInTransaction">, clock: () => Date) {
  const repository = createDrizzleFinancialCommandRepository(database);
  async function execute(tx: AmendmentTransaction, source: Source, actorId: string, reason: string, key: string) {
    assertInvoiceQuantityAuthority(source.actor);
    if (source.context.blockedReason || !source.plan) throw new FreightInvoiceCostError(source.context.blockedReason ?? "Reload the invoice evidence.", "FREIGHT_INVOICE_BLOCKED");
    if (!source.plan.requiresChange) throw new FreightInvoiceCostError("The invoice already matches the saved charge amounts. Review its existing approval and use the shipment's cost update for any remaining inventory work.", "FREIGHT_INVOICE_NO_CHANGE");
    const at = purchaseTaxApprovalTime(clock(), [source.invoice.updated_at, ...source.charges.map(row => row.updated_at), ...source.dependencies.shipments.map(row => row.updated_at)]);
    const beforeValues = await readInvoiceCorrectionInventoryValues(tx, source.dependencies);
    // Delegate the document transition to AP. This adapter excludes manual PO
    // billing links: its AP detection hook has no PO scope. Actual shipment PO
    // cost effects and history are recorded by the cost owner below.
    await executeApInvoiceCommandInTransaction("approve_invoice", { invoiceId: source.context.invoiceId, userId: actorId, now: at }, tx);
    await persistFreightInvoiceChargeAmounts(tx, source, at);
    const applications: Array<{ issues: Array<{ code: string; message: string }> }> = [];
    const shipmentStates: Array<{ shipmentId: number; shipmentNumber: string; state: "applied" | "review_required" | "pending_finalization" }> = [];
    const generalIssues: Array<{ code: string; message: string }> = [];
    for (const shipmentId of source.shipmentIds) {
      const result = await shipmentTracking.refreshQuantityAllocationInTransaction(tx, shipmentId, actorId, at);
      applications.push(...result.costApplications);
      shipmentStates.push({ shipmentId, shipmentNumber: source.context.shipments.find(row => row.id === shipmentId)!.number,
        state: "status" in result ? result.status : "pending_finalization" });
      if ("skipped" in result) generalIssues.push(...result.skipped.map(row => ({ code: row.reason, message: row.message })));
    }
    const after = await readFreightInvoiceReviewSource(tx, source.context.invoiceId, actorId);
    const bill = source.facts.invoice, nextBill = after.facts.invoice;
    if (bill.amountCents !== nextBill.amountCents || bill.paidCents !== nextBill.paidCents || bill.balanceCents !== nextBill.balanceCents)
      throw new FreightInvoiceCostError("Shipment cost reconciliation cannot change invoice amounts or settlement.", "FREIGHT_INVOICE_BILL_CHANGED");
    const physical = (rows: Source["dependencies"]["shipmentLines"]) => rows.map(row => ({ id: row.id, pieces: row.qty_shipped, cartons: row.carton_count }));
    if (canonicalJson(physical(source.dependencies.shipmentLines)) !== canonicalJson(physical(after.dependencies.shipmentLines)))
      throw new FreightInvoiceCostError("Shipment cost reconciliation cannot change shipped quantities.", "FREIGHT_INVOICE_QUANTITY_CHANGED");
    const values = new Map((await readInvoiceCorrectionInventoryValues(tx, after.dependencies)).map(row => [row.lotId, row]));
    const reviewed = {
      invoiceId: source.context.invoiceId, invoiceNumber: source.context.invoiceNumber, sourceVersion: source.context.sourceVersion,
      invoiceAmountCents: bill.amountCents, paidAmountCents: bill.paidCents, balanceCents: bill.balanceCents,
      invoiceStatus: { before: bill.status, after: nextBill.status }, charges: source.plan.charges,
      allocations: allocations(source, after), shipmentStates, impact: buildCostDestinationImpact(source.dependencies, after.dependencies),
      inventoryValues: beforeValues.map(row => {
        const next = values.get(row.lotId);
        if (!next || next.onHandUnits !== row.onHandUnits) throw new FreightInvoiceCostError("Inventory counts changed during cost review.", "FREIGHT_INVOICE_QUANTITY_CHANGED");
        return { lotId: row.lotId, lotNumber: row.lotNumber, onHandUnits: row.onHandUnits,
          beforeMills: row.onHandValueMills, afterMills: next.onHandValueMills, reviewReason: next.valueReviewReason };
      }),
      issues: [...new Map([...generalIssues, ...applications.flatMap(row => row.issues)].map(issue => [canonicalJson({ code: issue.code, message: issue.message }), { code: issue.code, message: issue.message }])).values()],
    };
    const preview = freightInvoicePreviewSchema.parse({ ...reviewed, previewVersion: costFingerprint(reviewed) });
    const approval = await recordFreightInvoiceCostApproval(tx, source, preview, actorId, reason, key, at, applications);
    return freightInvoiceResultSchema.parse({ ...approval, preview });
  }
  return {
    history: (purchaseOrderId: number) => database.transaction(tx => readPoFreightInvoiceApprovalHistory(tx, freightInvoiceIdSchema.parse(purchaseOrderId))),
    context: (id: number, actorId: string) => database.transaction(async tx => (await readFreightInvoiceReviewSource(tx, freightInvoiceIdSchema.parse(id), actorId)).context),
    preview: (id: number, value: unknown, actorId: string) => {
      const invoiceId = freightInvoiceIdSchema.parse(id), request = freightInvoicePreviewRequestSchema.parse(value);
      return database.transaction(async tx => {
        const source = await readFreightInvoiceReviewSource(tx, invoiceId, actorId);
        assertInvoiceQuantityAuthority(source.actor); current(source.context.sourceVersion, request.sourceVersion);
        await tx.execute(sql`SAVEPOINT freight_invoice_preview`);
        try { return (await execute(tx, source, actorId, "Freight invoice preview; nothing saved", "preview")).preview; }
        finally { await tx.execute(sql`ROLLBACK TO SAVEPOINT freight_invoice_preview`); await tx.execute(sql`RELEASE SAVEPOINT freight_invoice_preview`); }
      });
    },
    approve: (id: number, value: unknown, actorId: string, descriptor: FinancialCommandDescriptor) => {
      const invoiceId = freightInvoiceIdSchema.parse(id), request = freightInvoiceApprovalRequestSchema.parse(value), scope = freightInvoiceCommandScope(invoiceId);
      if (descriptor.actorType !== "user" || descriptor.actorId !== actorId || descriptor.method !== scope.method
        || descriptor.routeTemplate !== scope.routeTemplate || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName)
        throw new FinancialCommandError("The approval does not match this administrator and freight invoice.", 403, "FREIGHT_INVOICE_SCOPE_INVALID");
      return runTransactionalFinancialCommand({ repository, descriptor,
        classifyFailure(error) {
          if (error instanceof FreightInvoiceCostError || error instanceof InvoiceQuantityCorrectionError || error instanceof CostEvidenceError || error instanceof PoQuantityAmendmentError)
            return { kind: "rejected", httpStatus: error instanceof CostEvidenceError ? 409 : error.statusCode, errorCode: error.code, errorMessage: error.message, body: { code: error.code, error: error.message } };
          if (error instanceof MoneyInputError) return { kind: "rejected", httpStatus: 409, errorCode: "FREIGHT_INVOICE_EVIDENCE_INVALID", errorMessage: "Recorded invoice or charge amounts are invalid.", body: { code: "FREIGHT_INVOICE_EVIDENCE_INVALID", error: "Review the recorded invoice and charge amounts." } };
          if (error instanceof ShipmentTrackingError || error instanceof ApLedgerError) {
            if (error.statusCode < 500) return { kind: "rejected", httpStatus: error.statusCode, errorCode: String(error.details?.code ?? "FREIGHT_INVOICE_REVIEW_REQUIRED"), errorMessage: error.message,
              body: { code: String(error.details?.code ?? "FREIGHT_INVOICE_REVIEW_REQUIRED"), error: error.message } };
          }
          if (error instanceof z.ZodError) return { kind: "rejected", httpStatus: 409, errorCode: "FREIGHT_INVOICE_EVIDENCE_INVALID", errorMessage: "Saved invoice or cost evidence is invalid.", body: { code: "FREIGHT_INVOICE_EVIDENCE_INVALID", error: "Reload the complete invoice and cost review." } };
          return { kind: "retryable", errorCode: "FREIGHT_INVOICE_RETRY", errorMessage: "The cost update rolled back. Retry the saved approval." };
        },
        work: async tx => {
          const source = await readFreightInvoiceReviewSource(tx, invoiceId, actorId);
          assertInvoiceQuantityAuthority(source.actor); current(source.context.sourceVersion, request.sourceVersion);
          const result = await execute(tx, source, actorId, request.reason, descriptor.idempotencyKey);
          current(result.preview.previewVersion, request.previewVersion);
          return { httpStatus: 200, body: result, resultType: "freight_invoice_cost_approval", resultId: result.approvalEventId };
        },
      });
    },
  };
}
