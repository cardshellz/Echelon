import { resolveShipmentBillingOwnership } from "./shipment-billing-ownership";
import { z } from "zod";
import type { CostIssue } from "@shared/procurement/cost-source-contracts";

const integer = z.number().int().safe();
const id = integer.positive();
const money = z.union([integer, z.string().regex(/^-?\d{1,19}$/).transform(Number).pipe(integer)]);
const chargeSchema = z.object({
  id, shipmentId: id, vendorId: id.nullable(), invoiceId: id.nullable(),
  costType: z.string(), allocationMethod: z.string().nullable(), currency: z.string().nullable(),
  actualCents: money.nullable(), estimatedCents: money.nullable(), status: z.string().nullable(),
});
const invoiceLineSchema = z.object({
  id: id.nullable(), invoiceId: id, freightCostId: id.nullable(), vendorId: id,
  purchaseOrderLineId: id.nullable().optional().default(null), productVariantId: id.nullable().optional().default(null),
  invoiceNumber: z.string().min(1).nullable().optional().default(null),
  replacesInvoiceId: id.nullable().optional().default(null),
  shipmentId: id.nullable(), currency: z.string(), status: z.string(),
  invoiceTotalCents: money, documentLinesTotalCents: money.nullable(),
  quantity: integer.positive().nullable(), unitCostMills: money.nullable(), unitCostCents: money.nullable(),
  lineTotalCents: money.nullable(),
});
const inputSchema = z.object({ charge: chargeSchema, invoices: z.array(invoiceLineSchema), priorConfirmedCharge: z.unknown() });
type Charge = z.infer<typeof chargeSchema>;
type InvoiceLine = z.infer<typeof invoiceLineSchema>;
export interface ShipmentChargeEvidence {
  evidence: "confirmed" | "estimated" | "review_required";
  issue: CostIssue | null;
  confirmedCharge: Charge | null;
  approvedInvoiceLineIds: number[];
}

function review(code: string, message: string): ShipmentChargeEvidence {
  return { evidence: "review_required", issue: { code, message }, confirmedCharge: null, approvedInvoiceLineIds: [] };
}

function sameConfirmedCharge(current: Charge, previous: Charge): boolean {
  return ["confirmed", "finalized"].includes(previous.status ?? "") && previous.actualCents !== null
    && previous.currency === "USD" && current.id === previous.id && current.shipmentId === previous.shipmentId
    && current.vendorId === previous.vendorId && current.costType === previous.costType
    && current.allocationMethod === previous.allocationMethod && current.currency === previous.currency
    && current.actualCents === previous.actualCents;
}

/** Historical lines remain evidence. Only a complete, matching replacement chain
 * makes a voided document historical rather than a competing cost authority. */
function replacedAncestorIds(charge: Charge, invoices: readonly InvoiceLine[]): Set<number> | null {
  const ancestors = new Set<number>();
  if (charge.invoiceId === null) return ancestors;
  const headers = new Map<number, InvoiceLine>();
  for (const line of invoices) {
    const previous = headers.get(line.invoiceId);
    if (previous && (previous.replacesInvoiceId !== line.replacesInvoiceId
      || previous.invoiceNumber !== line.invoiceNumber || previous.status !== line.status
      || previous.vendorId !== line.vendorId || previous.shipmentId !== line.shipmentId
      || previous.currency !== line.currency)) return null;
    headers.set(line.invoiceId, line);
  }
  const current = headers.get(charge.invoiceId);
  if (!current || current.replacesInvoiceId === null) return ancestors;
  if (current.invoiceNumber === null || current.vendorId !== charge.vendorId
    || current.shipmentId !== charge.shipmentId || current.currency !== charge.currency) return null;
  let child = current;
  const visited = new Set([current.invoiceId]);
  while (child.replacesInvoiceId !== null) {
    const parentId = child.replacesInvoiceId;
    if (visited.has(parentId)) return null;
    visited.add(parentId);
    const parent = headers.get(parentId);
    if (!parent || parent.status !== "voided" || parent.vendorId !== current.vendorId
      || parent.invoiceNumber !== current.invoiceNumber || parent.shipmentId !== current.shipmentId
      || parent.currency !== current.currency
      || !invoices.some((line) => line.invoiceId === parentId && line.freightCostId === charge.id)
      || [...headers.values()].some((header) => header.replacesInvoiceId === parentId && header.invoiceId !== child.invoiceId)) return null;
    ancestors.add(parentId);
    child = parent;
  }
  return ancestors;
}

/**
 * AP linkage and payment state are not cost confirmation. A matching immutable
 * finalized charge retains its authority while AP progresses, or complete,
 * approved invoice lines establish authority for the same allocated amount.
 * A conflicting document is a review result, never a silent price replacement.
 */
export function resolveShipmentChargeEvidence(value: unknown): ShipmentChargeEvidence {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) return review("LANDED_INVOICE_EVIDENCE_INVALID", "Shipment charge or invoice evidence contains incomplete or invalid values. Review the source records before applying cost.");
  const { charge, invoices } = parsed.data;
  const previous = chargeSchema.safeParse(parsed.data.priorConfirmedCharge);
  const currentIsConfirmed = charge.actualCents !== null && charge.currency === "USD"
    && ["confirmed", "finalized"].includes(charge.status ?? "");
  const priorStillApplies = previous.success && sameConfirmedCharge(charge, previous.data)
    && ["invoiced", "paid", "partially_paid"].includes(charge.status ?? "");
  const confirmedCharge = currentIsConfirmed ? charge : priorStillApplies ? previous.data : null;
  const effectiveCents = charge.actualCents ?? charge.estimatedCents;
  const ancestors = replacedAncestorIds(charge, invoices);
  if (ancestors === null) {
    return review("LANDED_INVOICE_REPLACEMENT_REVIEW", `Shipment charge ${charge.id} has incomplete or conflicting invoice replacement history. Review its original and replacement documents.`);
  }
  const relevant = invoices.filter((line) => !ancestors.has(line.invoiceId)
    && (line.freightCostId === charge.id || line.invoiceId === charge.invoiceId));
  const sourcedLines = relevant.filter((line) => line.freightCostId === charge.id);
  if (charge.invoiceId !== null && sourcedLines.length === 0) {
    return review("LANDED_INVOICE_LINES_MISSING", `Shipment charge ${charge.id} is linked to an invoice without a recorded charge allocation. Review its invoice lines.`);
  }
  if (sourcedLines.length > 0) {
    if (sourcedLines.some((line) => (charge.invoiceId !== null && line.invoiceId !== charge.invoiceId)
      || charge.vendorId === null || line.vendorId !== charge.vendorId
      || (line.shipmentId !== null && line.shipmentId !== charge.shipmentId)
      || line.currency !== "USD" || charge.currency !== "USD")) {
      return review("LANDED_INVOICE_SOURCE_MISMATCH", `Shipment charge ${charge.id} has conflicting invoice, supplier, shipment, or currency evidence.`);
    }
    if (sourcedLines.some((line) => !["draft", "received", "approved", "partially_paid", "paid"].includes(line.status))) {
      return review("LANDED_INVOICE_STATUS_REVIEW", `Shipment charge ${charge.id} references disputed, voided, or unsupported invoice evidence.`);
    }
    const ownershipHeaders = new Map(invoices.map(line => [line.invoiceId, {
      id: line.invoiceId, vendorId: line.vendorId, shipmentId: line.shipmentId, currency: line.currency,
      status: line.status, invoiceNumber: line.invoiceNumber ?? "", replacesInvoiceId: line.replacesInvoiceId,
      hasProductSources: invoices.some(source => source.invoiceId === line.invoiceId && (source.purchaseOrderLineId !== null || source.productVariantId !== null)),
    }]));
    const ownership = resolveShipmentBillingOwnership({ cost: charge, invoices: [...ownershipHeaders.values()],
      lines: invoices.filter(line => line.freightCostId !== null && line.id !== null).map(line => ({
        id: line.id, invoiceId: line.invoiceId, freightCostId: line.freightCostId,
        purchaseOrderLineId: line.purchaseOrderLineId, productVariantId: line.productVariantId,
      })) });
    if (ownership.state === "review_required") return review("LANDED_INVOICE_SOURCE_MISMATCH", ownership.message);
    if (sourcedLines.some((line) => line.id === null || line.quantity === null || line.lineTotalCents === null
      || line.lineTotalCents < 0 || line.invoiceTotalCents < 0 || line.documentLinesTotalCents !== line.invoiceTotalCents
      || (line.unitCostMills === null && line.unitCostCents === null))) {
      return review("LANDED_INVOICE_TOTAL_REVIEW", `Shipment charge ${charge.id} needs complete invoice lines that reconcile to the document total.`);
    }
    let invoicedCents = BigInt(0);
    for (const line of sourcedLines) {
      const unitMills = line.unitCostMills === null ? BigInt(line.unitCostCents!) * BigInt(100) : BigInt(line.unitCostMills);
      if (unitMills < BigInt(0) || (unitMills * BigInt(line.quantity!) + BigInt(50)) / BigInt(100) !== BigInt(line.lineTotalCents!)) {
        return review("LANDED_INVOICE_TOTAL_REVIEW", `Shipment charge ${charge.id} has inconsistent invoice quantity, unit price, or extended amount.`);
      }
      invoicedCents += BigInt(line.lineTotalCents!);
    }
    if (effectiveCents === null || invoicedCents !== BigInt(effectiveCents)) {
      return review("LANDED_INVOICE_AMOUNT_REVIEW", `Shipment charge ${charge.id} differs from its invoice allocation. Reconcile the charge and invoice before applying costs.`);
    }
    if (sourcedLines.every((line) => ["approved", "partially_paid", "paid"].includes(line.status))) {
      return { evidence: "confirmed", issue: null, confirmedCharge,
        approvedInvoiceLineIds: sourcedLines.map((line) => line.id!) };
    }
  }
  return { evidence: confirmedCharge ? "confirmed" : "estimated", issue: null,
    confirmedCharge, approvedInvoiceLineIds: [] };
}
