import { sql } from "drizzle-orm";
import { z } from "zod";
import { purchaseTaxChangeSchema, purchaseTaxContextSchema, purchaseTaxApprovalHistorySchema, type PurchaseTaxTarget, type PurchaseTaxChange } from "@shared/procurement/purchase-tax";
import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import { canonicalJson } from "@shared/utils/canonical-json";
import { readIntegerCents, readIntegerMills } from "@shared/money-read";
import { costInteger, costFingerprint, lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { readPurchaseApprovalActor } from "../identity/infrastructure/purchase-approval-access.repository";
import { assertInvoiceQuantityAuthority } from "./invoice-quantity-correction.policy";
import { readPoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { readPoTaxEvidence, readInvoiceTaxEvidence, readPurchaseTaxTypes, readShipmentTaxEvidence } from "./purchase-tax-evidence.repository";
import { PurchaseTaxError, purchaseTaxAmounts } from "./domain/purchase-tax";
import { invoiceCostReviewVersion } from "./ap-ledger.service";
import { reviewInvoiceCostComponentsInTransaction } from "./invoice-cost-review.service";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";

const MAX_TAX_PO_SCOPES = 100;
function bounded<T>(rows: T[], limit = 10000): T[] {
  if (rows.length > limit) throw new PurchaseTaxError("The full tax impact exceeds the supported review size. No partial change was saved.", "PURCHASE_TAX_LIMIT");
  return rows;
}

export async function readPurchaseTaxApprovals(tx: AmendmentTransaction, target: PurchaseTaxTarget, poIds: number[]) {
  const rows = (await tx.execute(sql`SELECT audit.id,COALESCE(actor.display_name,actor.username,audit.actor) AS actor_name,audit.timestamp,
    audit.context->>'reason' AS reason,audit.changes->'preview' AS preview
    FROM public.audit_events audit LEFT JOIN identity.users actor ON actor.id=audit.actor
    WHERE audit.action='procurement.tax.approved' AND (audit.target=${`${target.kind}:${target.id ?? "new"}`}
      OR EXISTS(SELECT 1 FROM procurement.po_events event WHERE event.po_id=ANY(${sql.param(poIds)}::int[])
        AND event.event_type='tax_treatment_approved' AND event.payload_json->>'auditEventId'=audit.id::text))
    ORDER BY audit.id DESC LIMIT 20`)).rows;
  return rows.map(row => purchaseTaxApprovalHistorySchema.parse({ auditEventId: costInteger(row.id, "auditEventId", 1), actorName: String(row.actor_name),
    approvedAt: z.union([z.date(), z.string().min(1)]).pipe(z.coerce.date()).parse(row.timestamp).toISOString(), reason: String(row.reason), preview: row.preview }));
}

/** The global graph lock precedes financial records and current identity locks,
 * matching AP, receiving and the existing correction/update owners. */
export async function readPurchaseTaxChangeSource(tx: AmendmentTransaction, target: PurchaseTaxTarget, actorId: string) {
  await lockInventoryCostGraph(tx);
  const typeRows = bounded((await tx.execute(sql`SELECT * FROM procurement.purchase_tax_types ORDER BY id LIMIT 1001 FOR UPDATE`)).rows, 1000);
  const types = await readPurchaseTaxTypes(tx);
  let current: PurchaseTaxChange | null = null;
  let extraShipmentIds: number[] = [];
  let poIds: number[] = [], invoiceLine: Record<string, unknown> | null = null, charge: Record<string, unknown> | null = null;
  if (target.kind === "tax_type") {
    if (target.id !== null) {
      const existing = types.find(row => row.id === target.id);
      if (!existing) throw new PurchaseTaxError("Tax type not found.", "PURCHASE_TAX_NOT_FOUND", 404);
      current = { kind: "tax_type", id: existing.id, code: existing.code, name: existing.name, treatment: existing.treatment };
      const scopes = bounded((await tx.execute(sql`SELECT DISTINCT po_id FROM (
        SELECT id AS po_id FROM procurement.purchase_orders WHERE tax_type_id=${target.id}
        UNION SELECT purchase_order_id FROM procurement.purchase_order_lines WHERE tax_type_id=${target.id}
        UNION SELECT line.purchase_order_id FROM procurement.vendor_invoice_line_taxes tax
          JOIN procurement.vendor_invoice_lines invoice_line ON invoice_line.id=tax.vendor_invoice_line_id
          JOIN procurement.purchase_order_lines line ON line.id=invoice_line.purchase_order_line_id WHERE tax.tax_type_id=${target.id}
        UNION SELECT line.purchase_order_id FROM procurement.inbound_freight_costs cost
          JOIN procurement.inbound_shipment_lines line ON line.inbound_shipment_id=cost.inbound_shipment_id
          WHERE cost.tax_type_id=${target.id} AND line.purchase_order_id IS NOT NULL
      ) scopes ORDER BY po_id LIMIT ${MAX_TAX_PO_SCOPES + 1}`)).rows, MAX_TAX_PO_SCOPES);
      poIds = scopes.map(row => costInteger(row.po_id, "purchaseOrderId", 1));
      extraShipmentIds = bounded((await tx.execute(sql`SELECT DISTINCT inbound_shipment_id FROM procurement.inbound_freight_costs
        WHERE tax_type_id=${target.id} ORDER BY inbound_shipment_id LIMIT 10001`)).rows).map(row => costInteger(row.inbound_shipment_id, "shipmentId", 1));
    }
  } else if (target.kind === "purchase_order") poIds = [target.id];
  else if (target.kind === "invoice_line") {
    invoiceLine = (await tx.execute(sql`SELECT line.*,po_line.purchase_order_id,invoice.status AS invoice_status,invoice.currency AS invoice_currency
      FROM procurement.vendor_invoice_lines line JOIN procurement.purchase_order_lines po_line ON po_line.id=line.purchase_order_line_id
      JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id WHERE line.id=${target.id} FOR UPDATE OF invoice,line`)).rows[0] ?? null;
    if (!invoiceLine || invoiceLine.invoice_status === "voided") throw new PurchaseTaxError("A current invoice product line linked to a PO is required.", "PURCHASE_TAX_SOURCE_INVALID");
    poIds = [costInteger(invoiceLine.purchase_order_id, "purchaseOrderId", 1)];
  } else {
    charge = (await tx.execute(sql`SELECT * FROM procurement.inbound_freight_costs WHERE id=${target.id} FOR UPDATE`)).rows[0] ?? null;
    if (!charge || !["tax", "duty"].includes(String(charge.cost_type))) throw new PurchaseTaxError("Choose a shipment tax or duty charge.", "PURCHASE_TAX_SOURCE_INVALID");
    const linked = bounded((await tx.execute(sql`SELECT DISTINCT purchase_order_id FROM procurement.inbound_shipment_lines
      WHERE inbound_shipment_id=${charge.inbound_shipment_id} AND purchase_order_id IS NOT NULL ORDER BY purchase_order_id LIMIT 101`)).rows, MAX_TAX_PO_SCOPES);
    poIds = linked.map(row => costInteger(row.purchase_order_id, "purchaseOrderId", 1));
    current = { kind: "shipment_charge", id: target.id, taxTypeId: charge.tax_type_id == null ? null : costInteger(charge.tax_type_id, "taxTypeId", 1) };
  }
  const headers = bounded((await tx.execute(sql`SELECT * FROM procurement.purchase_orders
    WHERE id=ANY(${sql.param(poIds)}::int[]) ORDER BY id LIMIT 101 FOR UPDATE`)).rows, MAX_TAX_PO_SCOPES);
  if (target.kind === "purchase_order" && !headers.length) throw new PurchaseTaxError("Purchase order not found.", "PURCHASE_TAX_NOT_FOUND", 404);
  const lines = bounded((await tx.execute(sql`SELECT * FROM procurement.purchase_order_lines
    WHERE purchase_order_id=ANY(${sql.param(poIds)}::int[]) ORDER BY id LIMIT 10001 FOR UPDATE`)).rows);
  const productIds = lines.filter(row => row.line_type === "product" && row.status !== "cancelled").map(row => costInteger(row.id, "purchaseOrderLineId", 1));
  const dependencies = await readPoAmendmentDependencies(tx, productIds);
  const invoices = bounded((await tx.execute(sql`SELECT DISTINCT invoice.* FROM procurement.vendor_invoices invoice
    JOIN procurement.vendor_invoice_lines line ON line.vendor_invoice_id=invoice.id
    JOIN procurement.purchase_order_lines po_line ON po_line.id=line.purchase_order_line_id
    WHERE po_line.purchase_order_id=ANY(${sql.param(poIds)}::int[]) ORDER BY invoice.id LIMIT 10001`)).rows);
  const invoiceLines = bounded((await tx.execute(sql`SELECT * FROM procurement.vendor_invoice_lines
    WHERE vendor_invoice_id=ANY(${sql.param(invoices.map(row => costInteger(row.id, "invoiceId", 1)))}::int[]) ORDER BY id LIMIT 10001 FOR UPDATE`)).rows);
  const invoiceTaxes = await readInvoiceTaxEvidence(tx, invoiceLines.map(row => costInteger(row.id, "invoiceLineId", 1)));
  const poTaxes = await readPoTaxEvidence(tx, poIds);
  const shipmentIds = [...new Set([...extraShipmentIds, ...dependencies.shipments.map(row => costInteger(row.id, "shipmentId", 1)),
    ...(charge ? [costInteger(charge.inbound_shipment_id, "shipmentId", 1)] : [])])];
  const shipmentTaxes = await readShipmentTaxEvidence(tx, shipmentIds);
  const taxCharges = bounded((await tx.execute(sql`SELECT cost.*,shipment.shipment_number FROM procurement.inbound_freight_costs cost
    JOIN procurement.inbound_shipments shipment ON shipment.id=cost.inbound_shipment_id
    WHERE cost.inbound_shipment_id=ANY(${sql.param(shipmentIds)}::int[]) AND cost.cost_type IN ('tax','duty') ORDER BY cost.id LIMIT 10001`)).rows);
  const actor = await readPurchaseApprovalActor(tx, actorId);
  if (target.kind === "purchase_order") current = { kind: "purchase_order", id: target.id,
    taxTypeId: headers[0].tax_type_id == null ? null : costInteger(headers[0].tax_type_id, "taxTypeId", 1),
    lineTypes: lines.map(row => ({ lineId: costInteger(row.id, "lineId", 1), taxTypeId: row.tax_type_id == null ? null : costInteger(row.tax_type_id, "taxTypeId", 1) })) };
  if (invoiceLine) {
    const components = invoiceCostComponentEvidenceSchema.safeParse(invoiceLine.cost_component_evidence);
    if (components.success) current = { kind: "invoice_line", id: target.id!, components: { ...components.data, source: "operator_review" },
      taxes: (invoiceTaxes.get(target.id!) ?? []).map(tax => ({ taxTypeId: tax.taxTypeId!, amountMills: tax.amountMills })) };
  }
  const documents = [
    ...headers.map(header => ({ kind: "purchase_order" as const, id: costInteger(header.id, "purchaseOrderId", 1), reference: String(header.po_number), currency: String(header.currency),
      ...purchaseTaxAmounts(lines.filter(line => line.line_type === "product" && line.purchase_order_id === header.id).flatMap(line => poTaxes.get(costInteger(line.id, "lineId", 1)) ?? [])) })),
    ...invoices.map(invoice => ({ kind: "invoice" as const, id: costInteger(invoice.id, "invoiceId", 1), reference: String(invoice.invoice_number), currency: String(invoice.currency),
      ...purchaseTaxAmounts(invoiceLines.filter(line => line.vendor_invoice_id === invoice.id).flatMap(line => invoiceTaxes.get(costInteger(line.id, "lineId", 1)) ?? [])) })),
    ...shipmentIds.flatMap(id => {
      const rows = taxCharges.filter(row => row.inbound_shipment_id === id);
      // Never add different source currencies into one displayed tax amount.
      return [...new Set(rows.length ? rows.map(row => String(row.currency)) : ["USD"])].sort().map(currency => ({
        kind: "shipment" as const, id, reference: String(rows[0]?.shipment_number ?? `Shipment #${id}`), currency,
        ...purchaseTaxAmounts(rows.filter(row => row.currency === currency).map(row => shipmentTaxes.get(costInteger(row.id, "chargeId", 1))
          ?? { taxTypeId: null, treatment: "inventory" as const, amountMills: readIntegerMills(BigInt(readIntegerCents(row.actual_cents ?? row.estimated_cents ?? 0, "shipment tax")) * BigInt(100), "shipment tax"), source: `shipment_charge:${row.id}` })),
      }));
    }),
  ];
  const sourceVersion = costFingerprint({ version: 1, target, typeRows, headers, lines, invoices, invoiceLines,
    invoiceTaxes: [...invoiceTaxes], poTaxes: [...poTaxes], shipmentTaxes: [...shipmentTaxes], taxCharges, dependencies, actor });
  let canApprove = true;
  try { assertInvoiceQuantityAuthority(actor); } catch { canApprove = false; }
  const approvals = await readPurchaseTaxApprovals(tx, target, poIds);
  const context = purchaseTaxContextSchema.parse({ target, sourceVersion, canApprove, types, current, documents,
    approvals,
    lines: lines.map(row => ({ id: row.id, label: String(row.product_name || row.sku || `Line ${row.line_number}`),
      taxMills: readIntegerMills(BigInt(readIntegerCents(row.line_type === "tax" ? row.line_total_cents : row.tax_cents ?? 0, "line tax")) * BigInt(100), "line tax"), taxTypeId: row.tax_type_id })),
    invoice: invoiceLine ? { totalCents: readIntegerCents(invoiceLine.line_total_cents, "invoice line"), currency: String(invoiceLine.invoice_currency),
      taxes: (invoiceTaxes.get(target.id!) ?? []).map(tax => ({ taxTypeId: tax.taxTypeId!, amountMills: tax.amountMills })),
      components: invoiceCostComponentEvidenceSchema.safeParse(invoiceLine.cost_component_evidence).success ? invoiceCostComponentEvidenceSchema.parse(invoiceLine.cost_component_evidence) : null } : null,
  });
  const recordedVersions = [...typeRows, ...headers, ...lines, ...invoices, ...invoiceLines, ...(charge ? [charge] : [])].map(row => row.updated_at);
  return { target, context, sourceVersion, types, actor, headers, lines, invoiceLine, charge, dependencies, productIds, shipmentIds, recordedVersions };
}

export async function persistPurchaseTaxChange(tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readPurchaseTaxChangeSource>>,
  raw: PurchaseTaxChange, actorId: string, at: Date, reason: string) {
  const change = purchaseTaxChangeSchema.parse(raw);
  if (change.kind !== source.target.kind || change.id !== source.target.id) throw new PurchaseTaxError("The reviewed tax source changed.", "PURCHASE_TAX_SCOPE_INVALID");
  if (canonicalJson(change) === canonicalJson(source.context.current)) throw new PurchaseTaxError("Change a tax setting before reviewing it.", "PURCHASE_TAX_NO_CHANGE", 400);
  const validType = (id: number | null) => {
    if (id !== null && !source.types.some(row => row.id === id)) throw new PurchaseTaxError("Select an existing tax type.", "PURCHASE_TAX_TYPE_MISSING");
  };
  if (change.kind === "tax_type") {
    if (source.types.some(row => row.code === change.code && row.id !== change.id)) throw new PurchaseTaxError("That tax code already exists.", "PURCHASE_TAX_CODE_EXISTS");
    if (change.id === null) await tx.execute(sql`INSERT INTO procurement.purchase_tax_types(code,name,treatment,revision,created_at,updated_at,updated_by)
      VALUES(${change.code},${change.name},${change.treatment},1,${at},${at},${actorId})`);
    else await tx.execute(sql`UPDATE procurement.purchase_tax_types SET code=${change.code},name=${change.name},treatment=${change.treatment},
      revision=revision+1,updated_at=${at},updated_by=${actorId} WHERE id=${change.id}`);
  } else if (change.kind === "purchase_order") {
    validType(change.taxTypeId);
    const seen = new Set(change.lineTypes.map(row => row.lineId));
    if (seen.size !== change.lineTypes.length || seen.size !== source.lines.length || source.lines.some(row => !seen.has(costInteger(row.id, "lineId", 1))))
      throw new PurchaseTaxError("Review the complete purchase order tax lines.", "PURCHASE_TAX_SCOPE_INVALID");
    await tx.execute(sql`UPDATE procurement.purchase_orders SET tax_type_id=${change.taxTypeId},updated_at=${at},updated_by=${actorId} WHERE id=${change.id}`);
    for (const line of change.lineTypes) {
      validType(line.taxTypeId);
      await tx.execute(sql`UPDATE procurement.purchase_order_lines SET tax_type_id=${line.taxTypeId},updated_at=${at}
        WHERE id=${line.lineId} AND purchase_order_id=${change.id}`);
    }
  } else if (change.kind === "invoice_line") {
    if (!source.invoiceLine) throw new PurchaseTaxError("Invoice line not found.", "PURCHASE_TAX_SOURCE_INVALID");
    if (source.invoiceLine.invoice_currency !== "USD") throw new PurchaseTaxError("This invoice needs currency-specific costing before its tax can be applied. Its recorded currency and amounts were preserved.", "PURCHASE_TAX_CURRENCY_REVIEW");
    for (const tax of change.taxes) validType(tax.taxTypeId);
    const total = readIntegerMills(change.taxes.reduce((sum, tax) => sum + BigInt(tax.amountMills), BigInt(0)), "invoice taxes");
    if (change.components.adjustmentMills !== total) throw new PurchaseTaxError("The invoice's other amount must equal its named tax amounts. Review unrelated adjustments separately.", "PURCHASE_TAX_AMOUNT_MISMATCH", 422);
    const row = source.invoiceLine;
    await reviewInvoiceCostComponentsInTransaction(tx, change.id, { packagingTreatment: change.components.packagingTreatment,
      productMills: change.components.productMills, packagingMills: change.components.packagingMills, adjustmentMills: change.components.adjustmentMills,
      expectedVersion: invoiceCostReviewVersion({ id: change.id, qtyInvoiced: costInteger(row.qty_invoiced, "quantity"), unitCostCents: readIntegerCents(row.unit_cost_cents, "unit price"),
        unitCostMills: row.unit_cost_mills == null ? null : readIntegerMills(row.unit_cost_mills, "unit price"), lineTotalCents: readIntegerCents(row.line_total_cents, "invoice line"), costComponentEvidence: row.cost_component_evidence }), reason,
    }, actorId, at, { kind: "nested" });
    await tx.execute(sql`DELETE FROM procurement.vendor_invoice_line_taxes WHERE vendor_invoice_line_id=${change.id}`);
    for (const tax of change.taxes) await tx.execute(sql`INSERT INTO procurement.vendor_invoice_line_taxes(vendor_invoice_line_id,tax_type_id,amount_mills)
      VALUES(${change.id},${tax.taxTypeId},${tax.amountMills})`);
  } else {
    if (change.taxTypeId === null) throw new PurchaseTaxError("Select a configured tax type for this shipment charge.", "PURCHASE_TAX_TYPE_REQUIRED", 400);
    validType(change.taxTypeId);
    await tx.execute(sql`UPDATE procurement.inbound_freight_costs SET tax_type_id=${change.taxTypeId},updated_at=${at} WHERE id=${change.id}`);
  }
  return change;
}

export async function recordPurchaseTaxApproval(tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readPurchaseTaxChangeSource>>,
  preview: unknown, actorId: string, reason: string, at: Date, commandKey: string, costApplications: unknown) {
  const result = await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES(${at},'AUDIT',${actorId},'procurement.tax.approved',${`${source.target.kind}:${source.target.id ?? "new"}`},
    ${canonicalJson({ before: source.context.current, preview })}::jsonb,
    ${canonicalJson({ reason, commandKey, authority: source.actor, sourceVersion: source.sourceVersion, costApplications })}::jsonb) RETURNING id`);
  const auditEventId = costInteger(result.rows[0].id, "auditEventId", 1);
  for (const header of source.headers) await tx.execute(sql`INSERT INTO procurement.po_events(po_id,event_type,actor_type,actor_id,created_at,payload_json)
    VALUES(${header.id},'tax_treatment_approved','user',${actorId},${at},${canonicalJson({ auditEventId, reason, preview })}::jsonb)`);
  return auditEventId;
}
