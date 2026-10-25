import { hasInvoiceCreditHistory } from "./supplier-credit-settlement.repository";
import { readShipmentBillingOwnership } from "./shipment-billing-ownership.repository";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { apPaymentAllocations, auditEvents, inboundFreightCosts, inboundShipments, vendorInvoiceLines,
  vendorInvoicePoLinks, vendorInvoices } from "@shared/schema";
import { invoiceReplacementHistorySchema, invoiceReplacementInputSchema,
  invoiceReplacementResultSchema, type ReplacementInvoiceResult } from "@shared/procurement/invoice-replacement";
import { costFingerprint, lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { ApLedgerError, recomputeLinkedPurchaseOrders, type ApLedgerDbClient } from "./ap-ledger.service";
import { evaluateInvoiceReplacement } from "./domain/invoice-replacement";
import { readShipmentPurchaseOrders } from "./shipment-purchase-orders.repository";

const invoiceIdSchema = z.number().int().positive().max(2_147_483_647);


/** Read the exact source footprint used by both the preview and locked command. */
async function readReplacementSource(client: ApLedgerDbClient, invoiceId: number, lock: boolean) {
  const invoiceQuery = client.select().from(vendorInvoices).where(eq(vendorInvoices.id, invoiceId));
  const [invoice] = await (lock ? invoiceQuery.for("update") : invoiceQuery);
  if (!invoice) throw new ApLedgerError("Invoice not found", 404, { code: "AP_INVOICE_NOT_FOUND" });
  const linesQuery = client.select().from(vendorInvoiceLines).where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId)).orderBy(asc(vendorInvoiceLines.id));
  const lines = await (lock ? linesQuery.for("update") : linesQuery);
  const ids = [...new Set(lines.flatMap(line => line.freightCostId === null ? [] : [line.freightCostId]))];
  const costsQuery = client.select().from(inboundFreightCosts).where(or(eq(inboundFreightCosts.vendorInvoiceId, invoiceId),
    ...(ids.length ? [inArray(inboundFreightCosts.id, ids)] : []))).orderBy(asc(inboundFreightCosts.id));
  const costs = await (lock ? costsQuery.for("update") : costsQuery);
  const linksQuery = client.select().from(vendorInvoicePoLinks).where(eq(vendorInvoicePoLinks.vendorInvoiceId, invoiceId)).orderBy(asc(vendorInvoicePoLinks.id));
  const links = await (lock ? linksQuery.for("update") : linksQuery);
  const paymentHistory = await client.select({ id: apPaymentAllocations.id }).from(apPaymentAllocations)
    .where(eq(apPaymentAllocations.vendorInvoiceId, invoiceId)).orderBy(asc(apPaymentAllocations.id));
  const [successor] = await client.select({ id: vendorInvoices.id }).from(vendorInvoices)
    .where(eq(vendorInvoices.replacesInvoiceId, invoiceId));
  const shipmentQuery = invoice.inboundShipmentId === null ? null : client.select().from(inboundShipments).where(eq(inboundShipments.id, invoice.inboundShipmentId));
  const [shipment] = shipmentQuery === null ? [] : await (lock ? shipmentQuery.for("update") : shipmentQuery);
  const shipmentPoIds = invoice.inboundShipmentId === null || links.length === 0 ? [] :
    ((await readShipmentPurchaseOrders(client, [invoice.inboundShipmentId])).get(invoice.inboundShipmentId) ?? []).map(po => po.id);
  const hasCreditHistory = await hasInvoiceCreditHistory(client, invoiceId);
  return { invoice, lines, costs, links, paymentHistory, hasCreditHistory, successorInvoiceId: successor?.id ?? null, shipment: shipment ?? null, shipmentPoIds };
}



export async function readInvoiceReplacementDetail(client: ApLedgerDbClient, invoiceId: number) {
  const source = await readReplacementSource(client, invoiceIdSchema.parse(invoiceId), false);
  const rows = await client.select({ id: vendorInvoices.id, invoiceNumber: vendorInvoices.invoiceNumber, status: vendorInvoices.status,
    replacesInvoiceId: vendorInvoices.replacesInvoiceId, createdAt: vendorInvoices.createdAt }).from(vendorInvoices)
    .where(and(eq(vendorInvoices.vendorId, source.invoice.vendorId), eq(vendorInvoices.invoiceNumber, source.invoice.invoiceNumber)))
    .orderBy(asc(vendorInvoices.id));
  const capability = evaluateInvoiceReplacement(source, costFingerprint(source));
  const ownership = await readShipmentBillingOwnership(client, source.costs);
  const conflictingOwnership = capability.allowed && source.costs.some(cost => ownership.get(cost.id)?.state !== "voided");
  return { replacementCapability: conflictingOwnership ? { ...capability, allowed: false, code: "AP_INVOICE_BILLING_REVIEW_REQUIRED",
    message: "The original invoice has conflicting shipment billing evidence. Review all source invoices before replacement." } : capability,
    replacementHistory: invoiceReplacementHistorySchema.parse(rows) };
}

export async function replaceVoidedInvoiceInTransaction(client: ApLedgerDbClient, invoiceId: number, input: unknown,
  actorId: string, at: Date): Promise<ReplacementInvoiceResult> {
  const id = invoiceIdSchema.safeParse(invoiceId), command = invoiceReplacementInputSchema.safeParse(input);
  if (!id.success || !command.success || !actorId.trim() || !Number.isFinite(at.getTime())) {
    throw new ApLedgerError("Replacement requires a valid invoice, current version and correction reason.", 400, { code: "AP_INVOICE_REPLACEMENT_INPUT_INVALID" });
  }
  await lockInventoryCostGraph(client);
  const source = await readReplacementSource(client, id.data, true);
  const capability = evaluateInvoiceReplacement(source, costFingerprint(source));
  if (command.data.expectedVersion !== capability.expectedVersion) throw new ApLedgerError(
    "The invoice or its charge assignments changed. Reload the invoice and review the replacement again.", 409, { code: "AP_INVOICE_REPLACEMENT_STALE" });
  if (!capability.allowed) throw new ApLedgerError(capability.message, 409, { code: capability.code });
  const ownership = await readShipmentBillingOwnership(client, source.costs);
  if (source.costs.some(cost => ownership.get(cost.id)?.state !== "voided")) throw new ApLedgerError(
    "The original invoice has conflicting shipment billing evidence. Review all source invoices before replacement.", 409,
    { code: "AP_INVOICE_BILLING_REVIEW_REQUIRED", invoiceId });

  const { invoice } = source;
  const [replacement] = await client.insert(vendorInvoices).values({
    replacesInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, vendorId: invoice.vendorId,
    inboundShipmentId: invoice.inboundShipmentId, ourReference: invoice.ourReference, status: "received",
    invoiceDate: invoice.invoiceDate, receivedDate: at, dueDate: invoice.dueDate, approvedAt: null, approvedBy: null,
    invoicedAmountCents: invoice.invoicedAmountCents, paidAmountCents: 0, balanceCents: invoice.invoicedAmountCents,
    currency: invoice.currency, paymentTermsDays: invoice.paymentTermsDays, paymentTermsType: invoice.paymentTermsType,
    notes: invoice.notes, internalNotes: `Replacement of voided invoice ${invoice.id}: ${command.data.reason}`,
    disputeReason: null, createdBy: actorId, updatedBy: actorId, createdAt: at, updatedAt: at,
  }).returning();
  if (!replacement) throw new Error("Invoice replacement insert returned no document");
  for (const line of source.lines) {
    const { id: _id, vendorInvoiceId: _owner, createdAt: _created, updatedAt: _updated, ...fields } = line;
    await client.insert(vendorInvoiceLines).values({ ...fields, vendorInvoiceId: replacement.id,
      matchStatus: "pending", costComponentEvidence: null, createdAt: at, updatedAt: at });
  }
  for (const link of source.links) await client.insert(vendorInvoicePoLinks).values({
    vendorInvoiceId: replacement.id, purchaseOrderId: link.purchaseOrderId, allocatedAmountCents: link.allocatedAmountCents,
    notes: link.notes, createdAt: at,
  });
  const costIds = source.costs.map(cost => cost.id);
  const reassigned = await client.update(inboundFreightCosts).set({ vendorInvoiceId: replacement.id,
    invoiceNumber: replacement.invoiceNumber, invoiceDate: replacement.invoiceDate, dueDate: replacement.dueDate,
    costStatus: "invoiced", updatedAt: at }).where(and(inArray(inboundFreightCosts.id, costIds), eq(inboundFreightCosts.vendorInvoiceId, invoice.id)))
    .returning({ id: inboundFreightCosts.id });
  if (reassigned.length !== costIds.length) throw new ApLedgerError("The shipment charge assignment changed during replacement.", 409, { code: "AP_INVOICE_REPLACEMENT_STALE" });
  await recomputeLinkedPurchaseOrders(replacement.id, client, { actorId, now: at, reason: `Invoice ${invoice.id} replaced by ${replacement.id}.` });
  await client.insert(auditEvents).values({ timestamp: at, level: "AUDIT", actor: actorId, action: "ap_ledger.invoice_replaced",
    target: `invoice:${invoice.id}`, changes: { before: { invoice, lines: source.lines, poLinks: source.links, charges: source.costs },
      after: { invoice: replacement, chargeAssignments: costIds.map(costId => ({ costId, vendorInvoiceId: replacement.id })) } },
    context: { command: "replace_invoice", invoiceId: replacement.id, replacesInvoiceId: invoice.id,
      reason: command.data.reason, expectedVersion: capability.expectedVersion, affectedInvoiceIds: [invoice.id, replacement.id],
      affectedPurchaseOrderIds: source.links.map(link => link.purchaseOrderId), freightCostIds: costIds },
  });
  return invoiceReplacementResultSchema.parse({ invoiceId: replacement.id, replacesInvoiceId: invoice.id,
    invoiceNumber: replacement.invoiceNumber, status: replacement.status, freightCostIds: costIds });
}
