import { z } from "zod";
import { acceptedReturnCreditSourceSchema } from "@shared/procurement/supplier-return-credit";
import { costIssueSchema, type CostIssue, type CostSourceReference, type CostInventoryEffect } from "@shared/procurement/cost-source-contracts";
import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import { supplierCreditDispositionSchema, type SourceLineInput } from "@shared/procurement/supplier-credit";
import { costFingerprint, costInteger, CostEvidenceError } from "../../inventory/infrastructure/cost-evidence-values";

export type SupplierCreditSourceInput = SourceLineInput;
const integer = z.number().int().nonnegative().safe();
const id = z.number().int().positive().max(2_147_483_647);
export const supplierCreditSourceEvidenceSchema = z.object({
  contractVersion: z.literal(1),
  invoiceLineId: id,
  invoiceId: id,
  invoiceSourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  purchaseOrderLineId: id.nullable(),
  freightCostId: id.nullable(),
  reduction: z.object({ productMills: integer, packagingMills: integer, landedMills: integer, basePieces: integer }).strict(),
  returnSource: z.object({
    dispositionId: id, observationId: id, receivingLineId: id, purchaseOrderLineId: id,
    productId: id, productVariantId: id, unitsPerVariant: id, observationQuantity: id,
    evidenceReference: z.string().min(1).max(200),
  }).strict().nullable(),
  acceptedReturnSource: acceptedReturnCreditSourceSchema.optional(),
  issues: z.array(costIssueSchema),
}).strict();
export type SupplierCreditSourceEvidence = z.infer<typeof supplierCreditSourceEvidenceSchema>;

/** Deliberately excludes invoice payment status and mutable display metadata. */
export function supplierCreditInvoiceSourceFingerprint(row: Record<string, unknown>): string {
  return costFingerprint({
    id: costInteger(row.id, "invoiceLineId", 1),
    vendor_invoice_id: costInteger(row.vendor_invoice_id, "invoiceId", 1),
    qty_invoiced: costInteger(row.qty_invoiced, "qtyInvoiced"),
    line_total_cents: costInteger(row.line_total_cents, "lineTotalCents"),
    // Freight uses its exact charge relationship, not product/packaging metadata.
    cost_component_evidence: row.freight_cost_id == null ? row.cost_component_evidence ?? null : null,
    currency: row.currency,
  });
}

export function supplierCreditIssue(code: string, message: string): CostIssue { return { code, message }; }

/** A physical return is not a price reduction on the goods retained. Remove its
 * source denominator only when the original invoice components divide exactly. */
export function evaluateSupplierCreditSource(input: {
  line: SupplierCreditSourceInput;
  invoice: Record<string, unknown>;
  returnSource?: SupplierCreditSourceEvidence["returnSource"];
}): { sourceEvidence: SupplierCreditSourceEvidence; costState: "pending" | "review_required"; costIssues: CostIssue[] } {
  const { line, invoice } = input;
  const amountMills = BigInt(costInteger(line.amountCents, "credit.amountCents", 1)) * BigInt(100);
  const issues: CostIssue[] = [];
  const reduction = { productMills: 0, packagingMills: 0, landedMills: 0, basePieces: 0 };
  const purchaseOrderLineId = invoice.purchase_order_line_id == null ? null : costInteger(invoice.purchase_order_line_id, "purchaseOrderLineId", 1);
  const freightCostId = invoice.freight_cost_id == null ? null : costInteger(invoice.freight_cost_id, "freightCostId", 1);
  const components = invoiceCostComponentEvidenceSchema.safeParse(invoice.cost_component_evidence);
  const exactComponents = components.success
    && components.data.adjustmentMills === 0
    && BigInt(components.data.productMills) + BigInt(components.data.packagingMills) === BigInt(costInteger(invoice.line_total_cents, "lineTotalCents")) * BigInt(100);
  let returnSource: SupplierCreditSourceEvidence["returnSource"] = null;
  if (line.disposition.kind === "accepted_stock_return") {
    throw new CostEvidenceError("CREDIT_ACCEPTED_RETURN_OWNER_REQUIRED", "Accepted-stock credits require the independent immutable return-value owner.");
  } else if (line.disposition.kind === "price_reduction" && line.disposition.component === "landed") {
    if (freightCostId === null || purchaseOrderLineId !== null) issues.push(supplierCreditIssue("CREDIT_LANDED_SOURCE_REQUIRED", "The landed credit needs an exact supplier invoice line linked to one freight charge."));
    reduction.landedMills = costInteger(amountMills.toString(), "credit.landedMills");
  } else if (!exactComponents || purchaseOrderLineId === null || freightCostId !== null) {
    issues.push(supplierCreditIssue("CREDIT_COMPONENT_SOURCE_REVIEW", "Credit costing requires an exact approved product invoice source with supported product and packaging components."));
  } else if (line.disposition.kind === "price_reduction") {
    const field = line.disposition.component === "product" ? "productMills" : "packagingMills";
    reduction[field] = costInteger(amountMills.toString(), `credit.${field}`);
    if (amountMills > BigInt(components.data[field])) issues.push(supplierCreditIssue("CREDIT_COMPONENT_EXCEEDED", "The credit exceeds the original invoice cost component."));
  } else if (!input.returnSource) {
    issues.push(supplierCreditIssue("CREDIT_RETURN_SOURCE_REVIEW", "The physical return lacks an exact immutable invoice product source and unit conversion. Review its financial disposition explicitly."));
  } else {
    returnSource = input.returnSource;
    const pieces = BigInt(returnSource.observationQuantity) * BigInt(returnSource.unitsPerVariant);
    const invoicedPieces = BigInt(costInteger(invoice.qty_invoiced, "qtyInvoiced", 1));
    const product = BigInt(components.data.productMills) * pieces;
    const packaging = BigInt(components.data.packagingMills) * pieces;
    if (pieces > invoicedPieces || product % invoicedPieces !== BigInt(0) || packaging % invoicedPieces !== BigInt(0)
      || (product + packaging) / invoicedPieces !== amountMills) {
      issues.push(supplierCreditIssue("CREDIT_RETURN_VALUE_REVIEW", "The supplier credit does not exactly equal the returned quantity's original invoice components. An explicit difference disposition is required; no inventory loss or residual price is inferred."));
    } else {
      reduction.basePieces = costInteger(pieces.toString(), "credit.returnBasePieces");
      reduction.productMills = costInteger((product / invoicedPieces).toString(), "credit.returnProductMills");
      reduction.packagingMills = costInteger((packaging / invoicedPieces).toString(), "credit.returnPackagingMills");
    }
  }
  const sourceEvidence = supplierCreditSourceEvidenceSchema.parse({ contractVersion: 1,
    invoiceLineId: line.invoiceLineId, invoiceId: costInteger(invoice.vendor_invoice_id, "invoiceId", 1),
    invoiceSourceFingerprint: supplierCreditInvoiceSourceFingerprint(invoice), purchaseOrderLineId, freightCostId,
    reduction, returnSource, issues });
  return { sourceEvidence, costState: issues.length ? "review_required" : "pending", costIssues: issues };
}

export interface SupplierCreditCostRow {
  id: unknown; supplier_credit_id: unknown; invoice_line_id: unknown; amount_cents: unknown;
  disposition: unknown; source_evidence: unknown; status: unknown;
  purchase_order_line_id?: unknown; freight_cost_id?: unknown;
}

export function supplierCreditDispositionMatches(credit: SupplierCreditCostRow, evidence: SupplierCreditSourceEvidence): boolean {
  const parsed = supplierCreditDispositionSchema.safeParse(credit.disposition);
  if (!parsed.success) return false;
  const disposition = parsed.data;
  const reduction = evidence.reduction;
  if (disposition.kind === "accepted_stock_return") {
    const source = evidence.acceptedReturnSource;
    return !!source && source.returnLineId === disposition.supplierReturnLineId && source.quantity === disposition.quantity
      && source.entitlementId === (disposition.entitlementId ?? null) && source.evidenceReference === disposition.evidenceReference
      && evidence.returnSource === null && Object.values(reduction).every(amount => amount === 0);
  }
  if (disposition.kind === "quarantine_return") {
    const source = evidence.returnSource;
    return source !== null && source.dispositionId === disposition.returnDispositionId
      && source.purchaseOrderLineId === evidence.purchaseOrderLineId && evidence.freightCostId === null
      && source.observationQuantity === disposition.quantity && source.evidenceReference === disposition.evidenceReference
      && (evidence.issues.length > 0 || BigInt(reduction.basePieces) === BigInt(source.observationQuantity) * BigInt(source.unitsPerVariant));
  }
  if (evidence.returnSource !== null || reduction.basePieces !== 0) return false;
  if (evidence.issues.length) return true;
  const amount = BigInt(costInteger(credit.amount_cents, "creditAmountCents", 1)) * BigInt(100);
  return (disposition.component === "product" ? BigInt(reduction.productMills) === amount && reduction.packagingMills === 0 && reduction.landedMills === 0
    : disposition.component === "packaging" ? BigInt(reduction.packagingMills) === amount && reduction.productMills === 0 && reduction.landedMills === 0
      : BigInt(reduction.landedMills) === amount && reduction.productMills === 0 && reduction.packagingMills === 0);
}

/** Shared by source reads and posting. Gross invoice evidence is never edited. */
export function resolveSupplierCreditReductions(invoices: Record<string, unknown>[], credits: readonly SupplierCreditCostRow[] = [], purchaseOrderLineId?: number) {
  let productMills = BigInt(0), packagingMills = BigInt(0), basePieces = BigInt(0);
  const issues: CostIssue[] = [];
  const sources: CostSourceReference[] = [];
  const returns: CostInventoryEffect["returns"] = [];
  const byInvoice = new Map<number, { product: bigint; packaging: bigint; pieces: bigint }>();
  const identities = new Set<number>();
  for (const credit of credits) {
    // A return of accepted stock already has its own outgoing cost allocation.
    // Its credit cannot change this gross source or its revision fingerprint.
    if (supplierCreditDispositionSchema.safeParse(credit.disposition).data?.kind === "accepted_stock_return") continue;
    const creditId = costInteger(credit.supplier_credit_id, "creditId", 1);
    const lineId = costInteger(credit.id, "creditLineId", 1);
    if (identities.has(lineId)) {
      issues.push(supplierCreditIssue("CREDIT_SOURCE_DUPLICATE", "A supplier credit source line appears more than once. Review the complete source before applying costs."));
      continue;
    }
    identities.add(lineId);
    sources.push({ kind: "supplier_credit_line", documentId: creditId, lineId, version: costFingerprint(credit) });
    if (credit.status === "voided") continue;
    if (credit.status !== "approved") throw new CostEvidenceError("CREDIT_SOURCE_STATE_INVALID", "A cost source credit must be approved or a previously approved void.");
    const invoiceLineId = costInteger(credit.invoice_line_id, "invoiceLineId", 1);
    const invoice = invoices.find(row => Number(row.id) === invoiceLineId);
    const parsed = supplierCreditSourceEvidenceSchema.safeParse(credit.source_evidence);
    if (!invoice || !parsed.success || parsed.data.invoiceLineId !== invoiceLineId || parsed.data.invoiceId !== Number(invoice.vendor_invoice_id)
      || parsed.data.invoiceSourceFingerprint !== supplierCreditInvoiceSourceFingerprint(invoice)) {
      issues.push(supplierCreditIssue("CREDIT_SOURCE_CHANGED", "An approved supplier credit no longer matches the exact invoice evidence reviewed at approval."));
      continue;
    }
    const evidence = parsed.data;
    // Existing gross purchase fingerprints intentionally omit the selected PO
    // line ID. The caller supplies that scope without rewriting old contracts.
    const invoicePoLineId = invoice.purchase_order_line_id ?? purchaseOrderLineId;
    if (invoicePoLineId == null || evidence.purchaseOrderLineId !== Number(invoicePoLineId)
      || purchaseOrderLineId !== undefined && evidence.purchaseOrderLineId !== purchaseOrderLineId
      || credit.purchase_order_line_id !== undefined && evidence.purchaseOrderLineId !== Number(credit.purchase_order_line_id)
      || evidence.freightCostId !== null || invoice.freight_cost_id != null || credit.freight_cost_id != null) {
      issues.push(supplierCreditIssue("CREDIT_SOURCE_SCOPE_MISMATCH", "The credit's frozen purchase or freight source does not identify the original invoice cost scope."));
      continue;
    }
    if (!supplierCreditDispositionMatches(credit, evidence)) {
      issues.push(supplierCreditIssue("CREDIT_SOURCE_DISPOSITION_MISMATCH", "The credit disposition disagrees with its frozen cost and physical return evidence."));
      continue;
    }
    issues.push(...evidence.issues);
    if (evidence.issues.length) continue;
    const reduction = evidence.reduction;
    if (BigInt(reduction.productMills) + BigInt(reduction.packagingMills) !== BigInt(costInteger(credit.amount_cents, "creditAmountCents", 1)) * BigInt(100) || reduction.landedMills !== 0) {
      issues.push(supplierCreditIssue("CREDIT_SOURCE_AMOUNT_MISMATCH", "The approved supplier credit does not reconcile to its recorded product and packaging reductions."));
      continue;
    }
    const totals = byInvoice.get(invoiceLineId) ?? { product: BigInt(0), packaging: BigInt(0), pieces: BigInt(0) };
    totals.product += BigInt(reduction.productMills); totals.packaging += BigInt(reduction.packagingMills); totals.pieces += BigInt(reduction.basePieces);
    byInvoice.set(invoiceLineId, totals);
    productMills += BigInt(reduction.productMills); packagingMills += BigInt(reduction.packagingMills); basePieces += BigInt(reduction.basePieces);
    if (evidence.returnSource) returns.push({
      supplierCreditLineId: lineId, returnDispositionId: evidence.returnSource.dispositionId,
      observationId: evidence.returnSource.observationId, receivingLineId: evidence.returnSource.receivingLineId,
      quantity: evidence.returnSource.observationQuantity, unitsPerVariant: evidence.returnSource.unitsPerVariant,
    });
  }
  for (const [invoiceLineId, totals] of byInvoice) {
    const invoice = invoices.find(row => Number(row.id) === invoiceLineId)!;
    const parsed = invoiceCostComponentEvidenceSchema.safeParse(invoice.cost_component_evidence);
    if (!parsed.success || totals.product > BigInt(parsed.data.productMills) || totals.packaging > BigInt(parsed.data.packagingMills)
      || totals.pieces > BigInt(costInteger(invoice.qty_invoiced, "qtyInvoiced"))) {
      issues.push(supplierCreditIssue("CREDIT_SOURCE_EXCEEDED", "Cumulative supplier credits exceed the original invoice component or quantity. Review the credit source before changing inventory costs."));
    }
  }
  return { productMills, packagingMills, basePieces, issues, sources, returns };
}
