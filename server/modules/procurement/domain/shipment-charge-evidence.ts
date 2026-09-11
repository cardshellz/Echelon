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
  shipmentId: id.nullable(), currency: z.string(), status: z.string(),
  invoiceTotalCents: money, documentLinesTotalCents: money.nullable(),
  quantity: integer.positive().nullable(), unitCostMills: money.nullable(), unitCostCents: money.nullable(),
  lineTotalCents: money.nullable(),
});
const inputSchema = z.object({ charge: chargeSchema, invoices: z.array(invoiceLineSchema), priorConfirmedCharge: z.unknown() });
type Charge = z.infer<typeof chargeSchema>;
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
  const relevant = invoices.filter((line) => line.freightCostId === charge.id || line.invoiceId === charge.invoiceId);
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
