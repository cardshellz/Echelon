import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { readIntegerCents, readIntegerMills } from "@shared/money-read";
import { freightInvoiceContextSchema, freightInvoiceApprovalHistorySchema, type FreightInvoicePreview } from "@shared/procurement/freight-invoice-costs";
import { costFingerprint, costInteger, lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { readPurchaseApprovalActor, readPurchaseApproverName } from "../identity/infrastructure/purchase-approval-access.repository";
import { hasQuantityAmendmentAuthority } from "./po-quantity-amendment.policy";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import { readPoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { readInvoiceSourceCapabilities } from "./shipment-billing-ownership.repository";
import { hasInvoiceCreditHistory } from "./supplier-credit-settlement.repository";
import { planFreightInvoiceCosts, FreightInvoiceCostError } from "./domain/freight-invoice-costs";

const MAX_INVOICE_LINES = 1000;
const MAX_CHARGES = 500;
const dateText = (value: unknown) => value == null ? null : z.coerce.date().parse(value).toISOString();
const optionalCents = (value: unknown) => value == null ? null : readIntegerCents(value, "shipment charge");

function approvalHistory(rows: Array<Record<string, unknown>>) {
  return freightInvoiceApprovalHistorySchema.parse(rows.map(row => {
    const payload = z.object({ actorName: z.string(), approvedAt: z.string(), reason: z.string(), preview: z.unknown() }).parse(row.payload_json);
    return { actorName: payload.actorName, approvedAt: payload.approvedAt, reason: payload.reason, preview: payload.preview };
  }));
}
export async function readPoFreightInvoiceApprovalHistory(tx: AmendmentTransaction, purchaseOrderId: number) {
  return approvalHistory((await tx.execute(sql`SELECT payload_json FROM procurement.po_events
    WHERE po_id=${purchaseOrderId} AND event_type='freight_invoice_costs_approved' ORDER BY id DESC LIMIT 20`)).rows);
}
/** PO events are protected by migration 227. The general audit table is an
 * operational copy, not a second approval authority. Deduplicate a shared
 * shipment's identical PO events before taking the most recent 20 approvals. */
async function readInvoiceFreightApprovalHistory(tx: AmendmentTransaction, invoiceId: number) {
  return approvalHistory((await tx.execute(sql`SELECT payload_json FROM (
    SELECT DISTINCT ON (actor_id,payload_json->>'commandKey') id,payload_json FROM procurement.po_events
    WHERE event_type='freight_invoice_costs_approved' AND payload_json#>>'{preview,invoiceId}'=${String(invoiceId)}
    ORDER BY actor_id,payload_json->>'commandKey',id DESC
  ) approvals ORDER BY id DESC LIMIT 20`)).rows);
}

/** Graph lock precedes documents, complete shared-shipment dependencies and IAM.
 * All active and retained source ownership is checked by the existing AP reader. */
export async function readFreightInvoiceReviewSource(tx: AmendmentTransaction, invoiceId: number, actorId: string) {
  await lockInventoryCostGraph(tx);
  const invoice = (await tx.execute(sql`SELECT * FROM procurement.vendor_invoices WHERE id=${invoiceId} FOR UPDATE`)).rows[0];
  if (!invoice) throw new FreightInvoiceCostError("Invoice not found.", "FREIGHT_INVOICE_NOT_FOUND", 404);
  const lines = (await tx.execute(sql`SELECT * FROM procurement.vendor_invoice_lines WHERE vendor_invoice_id=${invoiceId}
    ORDER BY id LIMIT ${MAX_INVOICE_LINES + 1} FOR UPDATE`)).rows;
  const charges = (await tx.execute(sql`SELECT * FROM procurement.inbound_freight_costs cost
    WHERE cost.vendor_invoice_id=${invoiceId} OR EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines line
      WHERE line.vendor_invoice_id=${invoiceId} AND line.freight_cost_id=cost.id)
    ORDER BY cost.id LIMIT ${MAX_CHARGES + 1} FOR UPDATE`)).rows;
  if (lines.length > MAX_INVOICE_LINES || charges.length > MAX_CHARGES)
    throw new FreightInvoiceCostError("This complete invoice review exceeds the supported size. No partial cost update was saved.", "FREIGHT_INVOICE_LIMIT");
  const shipmentIds = [...new Set(charges.map(row => costInteger(row.inbound_shipment_id, "shipmentId", 1)))].sort((a, b) => a - b);
  const shipments = (await tx.execute(sql`SELECT * FROM procurement.inbound_shipments WHERE id=ANY(${sql.param(shipmentIds)}::int[]) ORDER BY id FOR UPDATE`)).rows;
  const capabilities = await readInvoiceSourceCapabilities(tx, invoiceId);
  const hasCreditHistory = await hasInvoiceCreditHistory(tx, invoiceId);
  const purchaseLinks = (await tx.execute(sql`SELECT id FROM procurement.vendor_invoice_po_links WHERE vendor_invoice_id=${invoiceId} ORDER BY id FOR UPDATE`)).rows;
  const facts = {
    invoice: { id: invoiceId, number: String(invoice.invoice_number), vendorId: costInteger(invoice.vendor_id, "vendorId", 1),
      shipmentId: invoice.inbound_shipment_id == null ? null : costInteger(invoice.inbound_shipment_id, "shipmentId", 1),
      currency: String(invoice.currency), status: String(invoice.status),
      amountCents: readIntegerCents(invoice.invoiced_amount_cents), paidCents: readIntegerCents(invoice.paid_amount_cents),
      balanceCents: readIntegerCents(invoice.balance_cents, "invoice balance", true) },
    lines: lines.map(row => ({ id: costInteger(row.id, "invoiceLineId", 1),
      freightCostId: row.freight_cost_id == null ? null : costInteger(row.freight_cost_id, "chargeId", 1),
      purchaseOrderLineId: row.purchase_order_line_id == null ? null : costInteger(row.purchase_order_line_id, "poLineId", 1),
      productVariantId: row.product_variant_id == null ? null : costInteger(row.product_variant_id, "variantId", 1),
      quantity: costInteger(row.qty_invoiced, "invoice quantity", 1),
      unitMills: row.unit_cost_mills == null ? readIntegerMills(BigInt(readIntegerCents(row.unit_cost_cents)) * BigInt(100)) : readIntegerMills(row.unit_cost_mills),
      amountCents: readIntegerCents(row.line_total_cents) })),
    charges: charges.map(row => ({ id: costInteger(row.id, "chargeId", 1), shipmentId: costInteger(row.inbound_shipment_id, "shipmentId", 1),
      vendorId: row.vendor_id == null ? null : costInteger(row.vendor_id, "vendorId", 1),
      invoiceId: row.vendor_invoice_id == null ? null : costInteger(row.vendor_invoice_id, "invoiceId", 1),
      currency: row.currency == null ? null : String(row.currency), label: String(row.description || row.cost_type),
      estimatedCents: optionalCents(row.estimated_cents), actualCents: optionalCents(row.actual_cents) })),
    capabilities, hasCreditHistory, hasPurchaseOrderLinks: purchaseLinks.length > 0,
  };
  let plan: ReturnType<typeof planFreightInvoiceCosts> | null = null;
  let blockedReason: string | null = null;
  try {
    plan = planFreightInvoiceCosts(facts);
    if (shipments.length !== shipmentIds.length || shipments.some(row => row.status === "cancelled"))
      throw new FreightInvoiceCostError("A linked shipment is missing or cancelled. Review its source before applying invoice costs.", "FREIGHT_INVOICE_SHIPMENT_REVIEW");
  } catch (error) {
    if (!(error instanceof FreightInvoiceCostError)) throw error;
    blockedReason = error.message;
  }
  const dependencies = await readPoAmendmentDependencies(tx, [], { shipmentIds });
  const poIds = [...new Set(dependencies.shipmentLines.flatMap(row => row.purchase_order_id == null ? [] : [costInteger(row.purchase_order_id, "purchaseOrderId", 1)]))];
  const purchaseOrders = (await tx.execute(sql`SELECT id,po_number FROM procurement.purchase_orders WHERE id=ANY(${sql.param(poIds)}::int[]) ORDER BY id FOR SHARE`)).rows;
  if (!poIds.length || purchaseOrders.length !== poIds.length)
    blockedReason ??= "Link this shipment to its purchase order using Edit shipment before approving its invoice costs.";
  const actor = await readPurchaseApprovalActor(tx, actorId);
  const actorName = await readPurchaseApproverName(tx, actorId);
  const canApprove = hasQuantityAmendmentAuthority(actor);
  const history = await readInvoiceFreightApprovalHistory(tx, invoiceId);
  const sourceVersion = costFingerprint({ reviewVersion: 2, invoice, lines, charges, capabilities, hasCreditHistory, purchaseLinks, dependencies, purchaseOrders, actor });
  const context = freightInvoiceContextSchema.parse({
    invoiceId, invoiceNumber: facts.invoice.number, sourceVersion, canApprove,
    blockedReason: !canApprove && plan?.requiresChange ? "A current Administrator with purchasing approval permission must approve this update." : blockedReason,
    requiresChange: plan?.requiresChange ?? false, charges: plan?.charges ?? [], invoiceStatus: facts.invoice.status,
    shipments: shipments.map(row => ({ id: costInteger(row.id, "shipmentId", 1), number: String(row.shipment_number), status: String(row.status) })),
    invoiceAmountCents: facts.invoice.amountCents, paidAmountCents: facts.invoice.paidCents, balanceCents: facts.invoice.balanceCents,
    originalApproval: { actorId: invoice.approved_by == null ? null : String(invoice.approved_by),
      actorName: invoice.approved_by == null ? null : await readPurchaseApproverName(tx, String(invoice.approved_by)), approvedAt: dateText(invoice.approved_at) }, history,
  });
  return { invoice, lines, charges, shipmentIds, dependencies, purchaseOrders, actor, actorName, context, facts, plan };
}

/** Only the reviewed invoice workflow can replace AP-owned charge amounts.
 * Estimates, invoice links, quantities and payment evidence are preserved. */
export async function persistFreightInvoiceChargeAmounts(tx: AmendmentTransaction,
  source: Awaited<ReturnType<typeof readFreightInvoiceReviewSource>>, at: Date) {
  if (!source.plan) throw new FreightInvoiceCostError("Reload the complete shipment cost review.", "FREIGHT_INVOICE_SCOPE_REVIEW");
  for (const charge of source.plan.charges) {
    const changed = (await tx.execute(sql`UPDATE procurement.inbound_freight_costs
      SET actual_cents=${charge.invoiceCents},updated_at=${at}
      WHERE id=${charge.chargeId} AND vendor_invoice_id=${source.context.invoiceId}
      AND inbound_shipment_id=${charge.shipmentId} RETURNING id`)).rows;
    if (changed.length !== 1) throw new FreightInvoiceCostError("Shipment charge ownership changed. Reload this review.", "FREIGHT_INVOICE_STALE");
  }
}

export async function recordFreightInvoiceCostApproval(tx: AmendmentTransaction,
  source: Awaited<ReturnType<typeof readFreightInvoiceReviewSource>>, preview: FreightInvoicePreview,
  actorId: string, reason: string, commandKey: string, at: Date, applications: unknown) {
  const poIds = source.purchaseOrders.map(row => costInteger(row.id, "purchaseOrderId", 1)).sort((a, b) => a - b);
  if (!poIds.length) throw new FreightInvoiceCostError("A linked purchase order is required to retain this approval.", "FREIGHT_INVOICE_PURCHASE_SCOPE_REVIEW");
  const audit = (await tx.execute(sql`INSERT INTO public.audit_events(action,actor,target,changes,context,timestamp,level)
    VALUES('procurement.freight_invoice_costs.approved',${actorId},${`vendor_invoice:${preview.invoiceId}`},
      ${canonicalJson({ preview, applications })}::jsonb,${canonicalJson({ actorName: source.actorName, reason, commandKey, authority: source.actor })}::jsonb,${at},'AUDIT') RETURNING id`)).rows[0];
  const auditEventId = costInteger(audit?.id, "auditEventId", 1);
  let approvalEventId: number | null = null;
  for (const poId of poIds) {
    const event = (await tx.execute(sql`INSERT INTO procurement.po_events(po_id,event_type,actor_type,actor_id,payload_json,created_at)
      VALUES(${poId},'freight_invoice_costs_approved','user',${actorId},${canonicalJson({ auditEventId, actorName: source.actorName, approvedAt: at.toISOString(), reason, commandKey, authority: source.actor, preview })}::jsonb,${at}) RETURNING id`)).rows[0];
    const id = costInteger(event?.id, "approvalEventId", 1);
    approvalEventId ??= id;
  }
  return { auditEventId, approvalEventId };
}
