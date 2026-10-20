import { sql } from "drizzle-orm";
import { readAcceptedReturnCreditOptions, reviewAcceptedReturnCreditSource, recordAcceptedReturnCreditLinks,
  readAcceptedReturnCreditCostStatus } from "./supplier-return-credit.repository";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierCreditSourceLineInputSchema, type SourceLineInput } from "@shared/procurement/supplier-credit";
import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import type { CostIssue, CostInventoryEffect } from "@shared/procurement/cost-source-contracts";
import { COGSService } from "../inventory/cogs.service";
import { costInteger, CostEvidenceError, lockInventoryCostGraph, type CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import { evaluateSupplierCreditSource, resolveSupplierCreditReductions, supplierCreditIssue,
  supplierCreditSourceEvidenceSchema, supplierCreditInvoiceSourceFingerprint, type SupplierCreditSourceEvidence } from "./domain/supplier-credit-source";
import { readCreditedReturnQuantities, readSupplierCreditCostRows, readSupplierCreditInvoiceLines,
  readSupplierCreditReturns, writeSupplierCreditSourceResult } from "./supplier-credit-source.repository";
import { reconcilePurchaseCostEvidence } from "./purchase-cost-application.service";
import { applyShipmentCostRevisions } from "./shipment-cost-application.service";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import { createSupplierCreditCostReadCache, type SupplierCreditCostReadCache } from "./supplier-credit-cost-read-cache";
export { createSupplierCreditCostReadCache, type SupplierCreditCostReadCache } from "./supplier-credit-cost-read-cache";

type CostState = "pending" | "posted" | "review_required" | "not_applicable";
type SourceContext = { actorId: string; at: Date };
function validateContext(input: SourceContext) {
  if (!input.actorId?.trim() || !Number.isFinite(input.at.getTime())) throw new CostEvidenceError("CREDIT_SOURCE_ACTOR_REQUIRED", "Supplier credit source review requires an actor and valid clock.");
}
function requireApprovedInvoice(line: Record<string, unknown>) {
  if (line.currency !== "USD" || !["approved", "partially_paid", "paid"].includes(String(line.invoice_status))) {
    throw new CostEvidenceError("CREDIT_SOURCE_INVOICE_UNAVAILABLE", "The source must be an approved USD supplier invoice.");
  }
  if (line.purchase_order_line_id != null && (line.po_vendor_id == null
    || Number(line.po_vendor_id) !== Number(line.vendor_id) || line.po_line_type !== "product")) {
    throw new CostEvidenceError("CREDIT_SOURCE_VENDOR_MISMATCH", "The invoice's original product line must belong to the same supplier's purchase order.");
  }
}

export async function validateSupplierCreditSourceLines(tx: CostEvidenceTransaction, input: SourceContext & {
  invoiceId: number; lines: readonly SourceLineInput[]; creditId?: number;
}) {
  validateContext(input);
  const lines = z.array(supplierCreditSourceLineInputSchema).min(1).max(100).parse(input.lines);
  await lockInventoryCostGraph(tx);
  const invoices = await readSupplierCreditInvoiceLines(tx, input.invoiceId, true);
  if (!invoices.length) throw new CostEvidenceError("CREDIT_SOURCE_INVOICE_UNAVAILABLE", "The source invoice has no available lines.");
  const result = [];
  const requestedReturns = new Map<number, bigint>();
  const acceptedGroups = new Map<string, number>();
  for (const line of lines) {
    const invoice = invoices.find(row => Number(row.id) === line.invoiceLineId);
    if (!invoice) throw new CostEvidenceError("CREDIT_SOURCE_LINE_MISMATCH", "A credit line does not belong to its source invoice.");
    requireApprovedInvoice(invoice);
    if (line.disposition.kind === "accepted_stock_return") {
      const disposition = line.disposition;
      const group = `${disposition.supplierReturnLineId}:${disposition.entitlementId ?? "new"}`;
      const priorQuantity = acceptedGroups.get(group);
      if (priorQuantity !== undefined && priorQuantity !== disposition.quantity) {
        throw new CostEvidenceError("RETURN_CREDIT_GROUP_QUANTITY", "Components sharing a returned-quantity entitlement must review the same exact quantity.");
      }
      acceptedGroups.set(group, disposition.quantity);
      const acceptedReturnSource = await reviewAcceptedReturnCreditSource(tx, { invoice, line, creditId: input.creditId });
      const sourceEvidence = supplierCreditSourceEvidenceSchema.parse({ contractVersion: 1,
        invoiceLineId: line.invoiceLineId, invoiceId: Number(invoice.vendor_invoice_id),
        invoiceSourceFingerprint: supplierCreditInvoiceSourceFingerprint(invoice),
        purchaseOrderLineId: invoice.purchase_order_line_id == null ? null : Number(invoice.purchase_order_line_id),
        freightCostId: invoice.freight_cost_id == null ? null : Number(invoice.freight_cost_id),
        reduction: { productMills: 0, packagingMills: 0, landedMills: 0, basePieces: 0 },
        returnSource: null, acceptedReturnSource, issues: [] });
      result.push({ invoiceLineId: line.invoiceLineId, sourceEvidence, costState: "pending" as const, costIssues: [] });
      continue;
    }
    let returnSource: SupplierCreditSourceEvidence["returnSource"] = null;
    if (line.disposition.kind === "quarantine_return") {
      const disposition = line.disposition;
      const returns = await readSupplierCreditReturns(tx, invoice, true);
      const source = returns.find(row => Number(row.id) === disposition.returnDispositionId);
      if (!source || source.evidence_reference !== disposition.evidenceReference) throw new CostEvidenceError("CREDIT_RETURN_SOURCE_MISMATCH", "The return must be an immutable quarantine return for this invoice's vendor and PO line, with its recorded collection evidence.");
      const used = await readCreditedReturnQuantities(tx, [disposition.returnDispositionId], input.creditId);
      const requested = (requestedReturns.get(disposition.returnDispositionId) ?? BigInt(0)) + BigInt(disposition.quantity);
      requestedReturns.set(disposition.returnDispositionId, requested);
      if (requested + (used.get(disposition.returnDispositionId) ?? BigInt(0)) > BigInt(costInteger(source.observation_qty, "returnedQuantity", 1))) {
        throw new CostEvidenceError("CREDIT_RETURN_QUANTITY_EXCEEDED", "Credits already use this physical return quantity. Review the current return and active credits.");
      }
      returnSource = { dispositionId: disposition.returnDispositionId, observationId: costInteger(source.observation_id, "observationId", 1),
        receivingLineId: costInteger(source.receiving_line_id, "receivingLineId", 1), purchaseOrderLineId: costInteger(source.purchase_order_line_id, "purchaseOrderLineId", 1),
        productId: costInteger(source.product_id, "productId", 1), productVariantId: costInteger(source.product_variant_id, "productVariantId", 1),
        unitsPerVariant: costInteger(source.units_per_variant_snapshot, "unitsPerVariant", 1), observationQuantity: disposition.quantity,
        evidenceReference: disposition.evidenceReference };
    }
    result.push({ invoiceLineId: line.invoiceLineId, ...evaluateSupplierCreditSource({ line, invoice, returnSource }) });
  }
  const poIds = [...new Set(invoices.filter(row => row.purchase_order_line_id != null).map(row => Number(row.purchase_order_line_id)))];
  const existing = (await readSupplierCreditCostRows(tx, { purchaseOrderLineIds: poIds })).filter(row => Number(row.supplier_credit_id) !== input.creditId);
  // Evaluate the complete component cap, including distinct product/packaging
  // entries on the same document. Drafts do not reserve financial entitlement.
  const provisionalIdBase = existing.reduce((maximum, row) => Math.max(maximum, costInteger(row.id, "creditLineId", 1)), 0);
  const proposed = result.map((row, index) => ({ id: provisionalIdBase + index + 1, supplier_credit_id: input.creditId ?? 1,
    invoice_line_id: row.invoiceLineId, amount_cents: lines[index].amountCents, disposition: lines[index].disposition,
    source_evidence: row.sourceEvidence, status: "approved" }));
  const cap = resolveSupplierCreditReductions(invoices, [...existing.filter(row => invoices.some(invoice => Number(invoice.id) === Number(row.invoice_line_id))),
    ...proposed.filter(row => row.source_evidence.freightCostId === null)]);
  const exceeded = cap.issues.find(issue => issue.code === "CREDIT_SOURCE_EXCEEDED");
  if (exceeded) throw new CostEvidenceError(exceeded.code, exceeded.message);
  return result;
}

export async function readSupplierCreditSourceOptions(tx: CostEvidenceTransaction, input: SourceContext & { invoiceId: number }) {
  validateContext(input);
  const invoices = await readSupplierCreditInvoiceLines(tx, input.invoiceId, false);
  const result = [];
  for (const invoice of invoices) {
    const components: Array<"product" | "packaging" | "landed"> = [];
    const issues: CostIssue[] = [];
    const evidence = invoiceCostComponentEvidenceSchema.safeParse(invoice.cost_component_evidence);
    if (invoice.freight_cost_id != null && invoice.purchase_order_line_id == null) components.push("landed");
    else if (invoice.purchase_order_line_id != null && evidence.success && evidence.data.adjustmentMills === 0
      && BigInt(evidence.data.productMills) + BigInt(evidence.data.packagingMills) === BigInt(costInteger(invoice.line_total_cents, "invoiceTotal")) * BigInt(100)) {
      if (evidence.data.productMills > 0) components.push("product");
      if (evidence.data.packagingMills > 0) components.push("packaging");
    } else issues.push(supplierCreditIssue("CREDIT_COMPONENT_SOURCE_REVIEW", "Review the original invoice cost components before recording a price reduction."));
    const returns = await readSupplierCreditReturns(tx, invoice, false);
    const used = await readCreditedReturnQuantities(tx, returns.map(row => Number(row.id)));
    const returnDispositions = returns.flatMap(row => {
      const available = BigInt(costInteger(row.observation_qty, "returnedQuantity", 1)) - (used.get(Number(row.id)) ?? BigInt(0));
      return available <= BigInt(0) ? [] : [{ returnDispositionId: Number(row.id), quantityAvailable: costInteger(available.toString(), "quantityAvailable", 1),
        unitLabel: String(row.unit_label), evidenceReference: String(row.evidence_reference), label: String(row.description) }];
    });
    const acceptedReturns = await readAcceptedReturnCreditOptions(tx, invoice);
    result.push({ invoiceLineId: costInteger(invoice.id, "invoiceLineId", 1), components, returnDispositions, acceptedReturns, issues });
  }
  return result;
}

async function reconcileCreditSources(tx: AmendmentTransaction, input: SourceContext & { creditId: number }, action: "approve" | "void") {
  validateContext(input);
  await lockInventoryCostGraph(tx);
  const credit = (await tx.execute(sql`SELECT id,source_invoice_id,status,approved_at FROM procurement.supplier_credits
    WHERE id=${costInteger(input.creditId, "creditId", 1)} FOR UPDATE`)).rows[0];
  if (!credit || credit.status !== (action === "approve" ? "approved" : "voided")) throw new CostEvidenceError("CREDIT_SOURCE_STATE_INVALID", "Credit costing must run in the matching approval or void transaction.");
  const lines = (await tx.execute(sql`SELECT id,invoice_line_id,amount_cents,disposition,source_evidence FROM procurement.supplier_credit_lines
    WHERE supplier_credit_id=${input.creditId} ORDER BY id FOR UPDATE`)).rows;
  if (action === "approve") {
    const validated = await validateSupplierCreditSourceLines(tx, { ...input, creditId: input.creditId, invoiceId: Number(credit.source_invoice_id),
      lines: lines.map(line => supplierCreditSourceLineInputSchema.parse({ invoiceLineId: Number(line.invoice_line_id), amountCents: costInteger(line.amount_cents, "creditAmount", 1), disposition: line.disposition })) });
    for (let index = 0; index < lines.length; index++) {
      if (canonicalJson(lines[index].source_evidence) !== canonicalJson(validated[index].sourceEvidence)) {
        throw new CostEvidenceError("CREDIT_SOURCE_CHANGED", "The original source evidence changed after the supplier credit was recorded. Preserve the draft and review its source before approval.");
      }
      await writeSupplierCreditSourceResult(tx, Number(lines[index].id), validated[index]);
    }
  }
  if (action === "approve") await recordAcceptedReturnCreditLinks(tx, input);
  if (action === "void" && credit.approved_at === null) return readSupplierCreditCostStatus(tx, { creditId: input.creditId });
  const invoices = await readSupplierCreditInvoiceLines(tx, Number(credit.source_invoice_id), false);
  const affected = invoices.filter(row => lines.some(line => supplierCreditSourceLineInputSchema.shape.disposition.parse(line.disposition).kind !== "accepted_stock_return" && Number(line.invoice_line_id) === Number(row.id)));
  const poIds = [...new Set(affected.filter(row => row.purchase_order_line_id != null).map(row => Number(row.purchase_order_line_id)))];
  const writer = new COGSService(tx);
  for (const poLineId of poIds) await reconcilePurchaseCostEvidence(tx, poLineId, writer, input.actorId, input.at);
  const freightIds = affected.filter(row => row.freight_cost_id != null).map(row => Number(row.freight_cost_id));
  if (freightIds.length) {
    const shipments = (await tx.execute(sql`SELECT DISTINCT inbound_shipment_id FROM procurement.inbound_freight_costs
      WHERE id=ANY(${sql.param(freightIds)}::int[]) ORDER BY inbound_shipment_id`)).rows;
    for (const shipment of shipments) await applyShipmentCostRevisions(tx, Number(shipment.inbound_shipment_id), writer, input.actorId, input.at);
  }
  const result = await readSupplierCreditCostStatus(tx, { creditId: input.creditId });
  for (const line of result.lines) if (line.costState !== "not_applicable") await writeSupplierCreditSourceResult(tx, line.id, { ...line, costState: line.costState });
  return result;
}
export const approveSupplierCreditSources = (tx: AmendmentTransaction, input: SourceContext & { creditId: number }) => reconcileCreditSources(tx, input, "approve");
export const voidSupplierCreditSources = (tx: AmendmentTransaction, input: SourceContext & { creditId: number }) => reconcileCreditSources(tx, input, "void");

/** AP settlement never proves inventory completion. Use the current canonical
 * source/application projection, including after a compensating credit void. */
export async function readSupplierCreditCostStatus(tx: CostEvidenceTransaction, input: { creditId: number; cache?: SupplierCreditCostReadCache }) {
  const cache = input.cache ?? createSupplierCreditCostReadCache(tx);
  cache.assertTransaction(tx);
  const rows = (await tx.execute(sql`SELECT line.id,line.disposition,line.source_evidence,line.cost_state,line.cost_issues,
      invoice_line.purchase_order_line_id,invoice_line.freight_cost_id,credit.status,credit.approved_at
    FROM procurement.supplier_credit_lines line JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
    JOIN procurement.vendor_invoice_lines invoice_line ON invoice_line.id=line.invoice_line_id
    WHERE credit.id=${costInteger(input.creditId, "creditId", 1)} ORDER BY line.id`)).rows;
  const postedDocument = rows.some(row => row.approved_at !== null);
  const poIds = [...new Set(rows.filter(row => row.disposition.kind !== "accepted_stock_return" && row.purchase_order_line_id != null).map(row => Number(row.purchase_order_line_id)))];
  const purchaseLines = postedDocument && poIds.length ? await cache.readPurchaseLines(poIds) : [];
  const lines: Array<{ id: number; costState: CostState; costIssues: CostIssue[]; inventoryEffect?: CostInventoryEffect }> = [];
  for (const row of rows) {
    let costState: CostState = row.cost_state;
    let costIssues: CostIssue[] = row.cost_issues;
    let inventoryEffect: CostInventoryEffect | undefined;
    if (row.status === "voided" && row.approved_at === null) {
      costState = "not_applicable";
      costIssues = [];
    } else if (postedDocument && row.disposition.kind === "accepted_stock_return") {
      const current = await readAcceptedReturnCreditCostStatus(tx, Number(row.id));
      costState = current.costState;
      costIssues = current.costIssues;
    } else if (postedDocument) {
      const original = supplierCreditSourceEvidenceSchema.safeParse(row.source_evidence);
      const issues = row.status === "approved" && original.success ? original.data.issues : [];
      if (row.purchase_order_line_id != null) {
        const current = purchaseLines.find(line => line.purchaseOrderLineId === Number(row.purchase_order_line_id));
        const components = current?.components.filter(component => row.disposition.kind === "quarantine_return" || component.component === row.disposition.component) ?? [];
        costIssues = [...issues, ...components.flatMap(component => component.issues)];
        costState = costIssues.length || !components.length ? "review_required" : components.every(component => component.status === "applied") ? "posted" : "pending";
        if (row.status === "approved" && row.disposition.kind === "quarantine_return" && costState === "posted" && components.length === 2
          && components.every(component => component.sourceEvidence === "confirmed" && component.sourceCurrent && component.inventoryEffect)
          && canonicalJson(components[0].inventoryEffect) === canonicalJson(components[1].inventoryEffect)
          && components[0].inventoryEffect?.returns.some(item => item.supplierCreditLineId === Number(row.id))) {
          inventoryEffect = components[0].inventoryEffect;
        }
      } else if (row.freight_cost_id != null) {
        const scope = await cache.readShipmentScope(Number(row.freight_cost_id));
        const current = [];
        for (const purchaseOrderId of scope.purchaseOrderIds) {
          const projection = await cache.readPoShipments(purchaseOrderId);
          current.push(...(projection?.lines.filter(line => line.shipmentId === scope.shipmentId) ?? []));
        }
        costIssues = [...issues, ...current.flatMap(line => line.issues)];
        if (!current.length) costIssues.push(supplierCreditIssue("CREDIT_LANDED_SOURCE_REQUIRED", "The credit has no complete original shipment posting scope."));
        costState = costIssues.length || current.some(line => line.status === "review_required") ? "review_required"
          : current.every(line => line.status === "applied") ? "posted" : "pending";
      } else {
        costState = "review_required";
        costIssues = [supplierCreditIssue("CREDIT_COST_SCOPE_REQUIRED", "The approved credit has no supported original inventory cost source.")];
      }
    }
    lines.push({ id: Number(row.id), costState, costIssues, ...(inventoryEffect ? { inventoryEffect } : {}) });
  }
  const costStatus: CostState = lines.length && lines.every(line => line.costState === "not_applicable") ? "not_applicable"
    : lines.some(line => line.costState === "review_required") ? "review_required" : lines.length && lines.every(line => line.costState === "posted") ? "posted" : "pending";
  return { lines, costStatus, costIssues: lines.flatMap(line => line.costIssues) };
}
