import { sumInvoiceCredits } from "./invoice-credit-evidence";
import { createHash } from "node:crypto";
import { z } from "zod";
import { poFinancialEvidenceIdSchema } from "@shared/procurement/po-financial-evidence";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  buildPoFinancialEvidence,
  validatePoFinancialInvoiceFootprint,
  type PoFinancialEvidenceInput,
  type PoFinancialInvoiceEvidence,
} from "./po-financial-evidence";

export const FINANCIAL_EXCEPTION_OWNER = "po-financial-invoice-evidence-v1";
export const FINANCIAL_EXCEPTION_KINDS = ["overpaid", "past_due"] as const;
export type FinancialExceptionKind = (typeof FINANCIAL_EXCEPTION_KINDS)[number];
export interface InvoiceSchedule {
  id: number;
  invoiceNumber: string;
  dueDate: Date | null;
}
// A structurally valid Date can still be invalid; utcDay then classifies only
// due-date evidence as unknown. Missing/invalid schedule identities must never
// look like an absent invoice or permit either alert kind to be cleared.
const invoiceSchedulesSchema = z.array(
  z
    .object({
      id: poFinancialEvidenceIdSchema,
      invoiceNumber: z.string().refine((value) => value.trim().length > 0),
      dueDate: z.custom<Date>((value) => value instanceof Date).nullable(),
    })
    .strict(),
);

export interface FinancialAlert {
  kind: FinancialExceptionKind;
  invoiceId: number;
  identity: string;
  sourceFingerprint: string;
  payload: Record<string, unknown>;
  title: string;
  message: string;
}
export interface FinancialAlertEvaluation {
  alerts: FinancialAlert[];
  unknownKinds: FinancialExceptionKind[];
  diagnostics: string[];
  invoiceIds: number[];
  invoiceEvidence: Array<{
    invoiceId: number;
    status: string;
    invoicedCents: number;
    paidCents: number;
    creditedCents: number;
    outstandingCents: number;
    dueDate: string | null;
    completedAllocationIds: number[];
    activeCreditAllocationIds: number[];
  }>;
}
const maximumCents = BigInt(Number.MAX_SAFE_INTEGER);
function cents(value: unknown): bigint | null {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  if (
    !["number", "string", "bigint"].includes(typeof value) ||
    !/^\d+$/.test(String(value))
  )
    return null;
  const parsed = BigInt(String(value));
  return parsed <= maximumCents ? parsed : null;
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function usd(value: bigint): string {
  return `$${value / BigInt(100)}.${String(value % BigInt(100)).padStart(2, "0")}`;
}
function utcDay(value: Date): string | null {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString().slice(0, 10)
    : null;
}

/** Invoice settlement is checked without inventing a PO share. This also permits
 * a verified legacy overpayment, which the PO attribution projection rejects. */
function settlement(
  invoice: PoFinancialInvoiceEvidence,
): { invoiced: bigint; paid: bigint; credited: bigint; settled: bigint; balance: bigint } | null {
  const invoiced = cents(invoice.invoicedAmountCents),
    paid = cents(invoice.paidAmountCents),
    balance = cents(invoice.balanceCents);
  const credited = cents(invoice.creditedAmountCents === undefined ? 0 : invoice.creditedAmountCents);
  const verifiedCredit = sumInvoiceCredits(invoice.credits === undefined ? [] : invoice.credits, invoice.vendorId, invoice.currency);
  if (invoiced === null || paid === null || balance === null || credited === null
    || verifiedCredit === null || BigInt(verifiedCredit) !== credited) return null;
  const settled = paid + credited;
  let completed = BigInt(0);
  // Repeated applications retain the same cash payment and distinct allocation IDs.
  const allocations = new Set<number>();
  for (const payment of invoice.payments) {
    if (
      payment === null ||
      typeof payment !== "object" ||
      Array.isArray(payment)
    )
      return null;
    const amount = cents(payment.appliedAmountCents);
    if (
      !Number.isSafeInteger(payment.allocationId) ||
      payment.allocationId <= 0 ||
      !Number.isSafeInteger(payment.paymentId) ||
      payment.paymentId <= 0 ||
      allocations.has(payment.allocationId) ||
      amount === null ||
      amount === BigInt(0) ||
      payment.paymentVendorId !== invoice.vendorId ||
      payment.paymentCurrency !== invoice.currency ||
      !["completed", "voided"].includes(payment.paymentStatus ?? "")
    )
      return null;
    allocations.add(payment.allocationId);
    if (payment.paymentStatus === "completed") completed += amount;
  }
  if (completed !== paid) return null;
  // A canonical invoice void retains its historical invoice balance. It must
  // have no currently completed payment; a void with active money is unknown.
  if (invoice.status === "voided")
    return settled === BigInt(0) ? { invoiced, paid, credited, settled, balance } : null;
  if (balance !== (invoiced > settled ? invoiced - settled : BigInt(0))) return null;
  if (
    (invoice.status === "paid" && settled < invoiced) ||
    (invoice.status === "partially_paid" &&
      (settled === BigInt(0) || settled >= invoiced)) ||
    (["received", "approved"].includes(invoice.status) && settled !== BigInt(0))
  )
    return null;
  return { invoiced, paid, credited, settled, balance };
}

/** Pure, clock-injected evaluation. A due date is overdue only after its UTC
 * calendar date; missing evidence is never interpreted as a cleared alert. */
export function evaluatePoFinancialExceptions(
  input: PoFinancialEvidenceInput,
  schedules: readonly InvoiceSchedule[],
  asOf: Date,
): FinancialAlertEvaluation {
  const today = utcDay(asOf);
  if (!today)
    throw new TypeError("Financial exception asOf must be a valid Date");
  const result: FinancialAlertEvaluation = {
    alerts: [],
    unknownKinds: [],
    diagnostics: [],
    invoiceIds: [],
    invoiceEvidence: [],
  };
  const unknown = (
    kinds: readonly FinancialExceptionKind[],
    reason: string,
  ) => {
    result.unknownKinds = [...new Set([...result.unknownKinds, ...kinds])];
    result.diagnostics.push(reason);
  };
  const parsedSchedules = invoiceSchedulesSchema.safeParse(schedules);
  if (
    !parsedSchedules.success ||
    new Set(parsedSchedules.data.map((row) => row.id)).size !==
      parsedSchedules.data.length
  ) {
    unknown(FINANCIAL_EXCEPTION_KINDS, "PO_FINANCIAL_SCHEDULE_INVALID");
    return result;
  }
  const scheduleRows = parsedSchedules.data;
  // Reuse canonical full-source duplicate and ownership checks. Payment-split
  // ambiguity does not make a whole invoice balance ambiguous.
  const accepted = new Set([
    "PO_SHARED_INVOICE_PARTIAL_PAYMENT",
    "PO_SIGNED_SETTLEMENT_REVIEW_REQUIRED",
    "PO_INVOICE_SETTLEMENT_MISMATCH",
    "PO_INVOICE_STATUS_MISMATCH",
  ]);
  const projection = buildPoFinancialEvidence(input);
  if (projection.reviewReasons.some((reason) => !accepted.has(reason.code))) {
    unknown(FINANCIAL_EXCEPTION_KINDS, "PO_FINANCIAL_SOURCE_REVIEW_REQUIRED");
    return result;
  }
  result.invoiceIds = input.invoices
    .filter((invoice) => invoice !== null && typeof invoice === "object")
    .map((invoice) => invoice.id);
  for (const invoice of input.invoices) {
    const footprint = validatePoFinancialInvoiceFootprint(input, invoice);
    const amounts = footprint.valid ? settlement(invoice) : null;
    if (!amounts) {
      unknown(
        FINANCIAL_EXCEPTION_KINDS,
        `INVOICE_${invoice.id}_EVIDENCE_INVALID`,
      );
      continue;
    }
    const schedule = scheduleRows.filter((row) => row.id === invoice.id);
    result.invoiceEvidence.push({
      invoiceId: invoice.id,
      status: invoice.status,
      invoicedCents: Number(amounts.invoiced),
      paidCents: Number(amounts.paid),
      creditedCents: Number(amounts.credited),
      outstandingCents: Number(amounts.balance),
      dueDate:
        schedule.length === 1 && schedule[0].dueDate !== null
          ? utcDay(schedule[0].dueDate)
          : null,
      completedAllocationIds: invoice.payments
        .filter((payment) => payment.paymentStatus === "completed")
        .map((payment) => payment.allocationId)
        .sort((a, b) => a - b),
      activeCreditAllocationIds: (invoice.credits ?? [])
        .filter(credit => credit.reversalId === null)
        .map(credit => credit.allocationId)
        .sort((a, b) => a - b),
    });
    if (invoice.status === "voided") continue;
    if (
      schedule.length !== 1 ||
      typeof schedule[0].invoiceNumber !== "string" ||
      !schedule[0].invoiceNumber.trim()
    ) {
      unknown(
        FINANCIAL_EXCEPTION_KINDS,
        `INVOICE_${invoice.id}_SCHEDULE_MISSING`,
      );
      continue;
    }
    const dueDay =
      schedule[0].dueDate === null ? null : utcDay(schedule[0].dueDate);
    const base = {
      owner: FINANCIAL_EXCEPTION_OWNER,
      scope: "linked_invoice",
      invoiceId: invoice.id,
      invoiceNumber: schedule[0].invoiceNumber,
      invoicedCents: Number(amounts.invoiced),
      paidCents: Number(amounts.paid),
      creditedCents: Number(amounts.credited),
      outstandingCents: Number(amounts.balance),
    };
    const add = (
      kind: FinancialExceptionKind,
      title: string,
      message: string,
      extra: Record<string, unknown>,
    ) => {
      const payload = { ...base, ...extra };
      // Elapsed age and the observation clock are deliberately absent. Exact
      // completed allocation identity changes are substantive source changes.
      const sourceFingerprint = hash({
        payload,
        status: invoice.status,
        credits: [...(invoice.credits ?? [])]
          .sort((a, b) => a.allocationId - b.allocationId),
        payments: [...invoice.payments]
          .sort((a, b) => a.allocationId - b.allocationId)
          .map((p) => ({
            id: p.allocationId,
            paymentId: p.paymentId,
            status: p.paymentStatus,
            amount: String(p.appliedAmountCents),
          })),
      });
      result.alerts.push({
        kind,
        invoiceId: invoice.id,
        identity: hash({
          owner: FINANCIAL_EXCEPTION_OWNER,
          poId: input.purchaseOrderId,
          kind,
          invoiceId: invoice.id,
        }),
        sourceFingerprint,
        payload: { ...payload, sourceFingerprint },
        title,
        message,
      });
    };
    if (amounts.settled > amounts.invoiced)
      add(
        "overpaid",
        "Linked invoice overpaid",
        `Linked invoice ${schedule[0].invoiceNumber} has ${usd(amounts.settled - amounts.invoiced)} excess ${amounts.credited > BigInt(0) ? "cash and credit settlement" : "completed payments"}. Amounts describe the whole invoice, not this PO's share.`,
        { overageCents: Number(amounts.settled - amounts.invoiced) },
      );
    if (amounts.balance === BigInt(0)) continue;
    if (!dueDay) {
      unknown(["past_due"], `INVOICE_${invoice.id}_DUE_DATE_UNKNOWN`);
      continue;
    }
    if (dueDay < today)
      add(
        "past_due",
        "Linked invoice past due",
        `Linked invoice ${schedule[0].invoiceNumber} was due ${dueDay} and has ${usd(amounts.balance)} outstanding. Amounts describe the whole invoice, not this PO's share.`,
        { dueDate: dueDay },
      );
  }
  // Preserve every alert of an uncertain kind; do not partially revise history
  // while another source might explain it.
  result.alerts = result.alerts.filter(
    (alert) => !result.unknownKinds.includes(alert.kind),
  );
  return result;
}
