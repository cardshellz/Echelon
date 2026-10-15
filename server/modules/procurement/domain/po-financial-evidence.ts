import { z } from "zod";
import {
  poFinancialEvidenceIdSchema as id,
  poFinancialEvidenceSchema,
  type PoFinancialEvidence,
} from "@shared/procurement/po-financial-evidence";

export interface PoFinancialInvoiceLinkEvidence {
  purchaseOrderId: number;
  purchaseOrderVendorId: number | null;
  purchaseOrderCurrency: string | null;
}
export interface PoFinancialInvoiceLineEvidence {
  id: number;
  purchaseOrderLineId: number | null;
  purchaseOrderId: number | null;
  freightCostId: number | null;
  lineTotalCents: unknown;
}
export interface PoFinancialPaymentEvidence {
  allocationId: number;
  paymentId: number;
  paymentVendorId: number | null;
  paymentCurrency: string | null;
  paymentStatus: string | null;
  appliedAmountCents: unknown;
}
export interface PoFinancialInvoiceEvidence {
  id: number;
  vendorId: number | null;
  currency: string | null;
  status: string;
  invoicedAmountCents: unknown;
  paidAmountCents: unknown;
  balanceCents: unknown;
  links: readonly PoFinancialInvoiceLinkEvidence[];
  lines: readonly PoFinancialInvoiceLineEvidence[];
  payments: readonly PoFinancialPaymentEvidence[];
}
export interface PoFinancialEvidenceInput {
  purchaseOrderId: number;
  vendorId: number;
  currency: string;
  invoices: readonly PoFinancialInvoiceEvidence[];
}

type ReviewReason = PoFinancialEvidence["reviewReasons"][number];
type AddReason = (code: string, message: string) => void;
type Amounts = {
  invoiced: bigint | null;
  paid: bigint | null;
  outstanding: bigint | null;
};
const unknownAmounts: Amounts = {
  invoiced: null,
  paid: null,
  outstanding: null,
};
const maximumCents = BigInt(Number.MAX_SAFE_INTEGER);
const rootSchema = z
  .object({
    purchaseOrderId: id,
    vendorId: id,
    currency: z.string(),
    invoices: z.array(z.unknown()),
  })
  .strict();
const linkSchema = z
  .object({
    purchaseOrderId: id,
    purchaseOrderVendorId: id.nullable(),
    purchaseOrderCurrency: z.string().nullable(),
  })
  .strict();
const lineSchema = z
  .object({
    id,
    purchaseOrderLineId: id.nullable(),
    purchaseOrderId: id.nullable(),
    freightCostId: id.nullable(),
    lineTotalCents: z.unknown(),
  })
  .strict();
const paymentSchema = z
  .object({
    allocationId: id,
    paymentId: id,
    paymentVendorId: id.nullable(),
    paymentCurrency: z.string().nullable(),
    paymentStatus: z.string().nullable(),
    appliedAmountCents: z.unknown(),
  })
  .strict();
const invoiceSchema = z
  .object({
    id,
    vendorId: id.nullable(),
    currency: z.string().nullable(),
    status: z.enum([
      "received",
      "approved",
      "partially_paid",
      "paid",
      "disputed",
      "voided",
    ]),
    invoicedAmountCents: z.unknown(),
    paidAmountCents: z.unknown(),
    balanceCents: z.unknown(),
    links: z.array(z.unknown()),
    lines: z.array(z.unknown()),
    payments: z.array(z.unknown()),
  })
  .strict();
type Invoice = z.infer<typeof invoiceSchema>;

/** Database money is checked before conversion. Missing/unsafe values are never zero. */
function money(value: unknown, signed = false): bigint | null {
  let result: bigint;
  if (typeof value === "bigint") result = value;
  else if (typeof value === "number" && Number.isSafeInteger(value))
    result = BigInt(value);
  else if (typeof value === "string" && /^-?\d+$/.test(value))
    result = BigInt(value);
  else return null;
  return result < (signed ? -maximumCents : BigInt(0)) || result > maximumCents
    ? null
    : result;
}

function readOwnership(
  invoice: Invoice,
  input: PoFinancialEvidenceInput,
  addReason: AddReason,
): Map<number, bigint> | null {
  const links = z.array(linkSchema).safeParse(invoice.links);
  const lines = z.array(lineSchema).safeParse(invoice.lines);
  if (!links.success || !lines.success) {
    addReason(
      "PO_INVOICE_OWNERSHIP_INVALID",
      "Invoice ownership evidence is missing or malformed.",
    );
    return null;
  }
  const linkedIds = new Set(links.data.map((link) => link.purchaseOrderId));
  if (
    linkedIds.size !== links.data.length ||
    !linkedIds.has(input.purchaseOrderId) ||
    links.data.some(
      (link) =>
        link.purchaseOrderVendorId !== invoice.vendorId ||
        link.purchaseOrderCurrency !== invoice.currency,
    )
  ) {
    addReason(
      "PO_INVOICE_OWNERSHIP_INVALID",
      "Invoice links do not identify consistent purchase order owners.",
    );
    return null;
  }
  const seenLineIds = new Set<number>();
  const poLineOwners = new Map<number, number>();
  const buckets = new Map<number, bigint>(
    [...linkedIds].map((poId) => [poId, BigInt(0)]),
  );
  for (const line of lines.data) {
    if (seenLineIds.has(line.id)) {
      addReason(
        "PO_INVOICE_OWNERSHIP_INVALID",
        "An invoice line appears more than once in the ownership evidence.",
      );
      return null;
    }
    seenLineIds.add(line.id);
    if (
      line.purchaseOrderLineId === null ||
      line.purchaseOrderId === null ||
      line.freightCostId !== null
    ) {
      addReason(
        "PO_INVOICE_LINE_UNASSIGNED",
        "An invoice line has no unambiguous purchase order line owner.",
      );
      return null;
    }
    if (
      !linkedIds.has(line.purchaseOrderId) ||
      (poLineOwners.has(line.purchaseOrderLineId) &&
        poLineOwners.get(line.purchaseOrderLineId) !== line.purchaseOrderId)
    ) {
      addReason(
        "PO_INVOICE_OWNERSHIP_INVALID",
        "An invoice line belongs to an inconsistent or unlinked purchase order.",
      );
      return null;
    }
    poLineOwners.set(line.purchaseOrderLineId, line.purchaseOrderId);
    const amount = money(line.lineTotalCents, true);
    if (amount === null) {
      addReason(
        "PO_INVOICE_LINE_AMOUNT_INVALID",
        "An invoice line amount is missing or outside the supported exact integer range.",
      );
      return null;
    }
    buckets.set(
      line.purchaseOrderId,
      buckets.get(line.purchaseOrderId)! + amount,
    );
  }
  return buckets;
}

function readCompletedPayments(
  invoice: Invoice,
  addReason: AddReason,
): bigint | null {
  const payments = z.array(paymentSchema).safeParse(invoice.payments);
  if (!payments.success) {
    addReason(
      "PO_PAYMENT_EVIDENCE_INVALID",
      "Invoice payment evidence is missing or malformed.",
    );
    return null;
  }
  const allocationIds = new Set<number>();
  const paymentIds = new Set<number>();
  let completed = BigInt(0);
  for (const payment of payments.data) {
    if (
      allocationIds.has(payment.allocationId) ||
      paymentIds.has(payment.paymentId)
    ) {
      addReason(
        "PO_PAYMENT_EVIDENCE_INVALID",
        "A payment allocation appears more than once for this invoice.",
      );
      return null;
    }
    allocationIds.add(payment.allocationId);
    paymentIds.add(payment.paymentId);
    if (
      payment.paymentStatus !== "completed" &&
      payment.paymentStatus !== "voided"
    ) {
      addReason(
        "PO_PAYMENT_STATUS_REVIEW_REQUIRED",
        "An invoice payment has a missing or unsupported settlement status.",
      );
      return null;
    }
    if (
      payment.paymentVendorId !== invoice.vendorId ||
      payment.paymentCurrency !== invoice.currency
    ) {
      addReason(
        "PO_PAYMENT_OWNERSHIP_INVALID",
        "Invoice payment vendor or currency does not match the invoice.",
      );
      return null;
    }
    const amount = money(payment.appliedAmountCents);
    if (amount === null || amount === BigInt(0)) {
      addReason(
        "PO_PAYMENT_AMOUNT_INVALID",
        "An invoice payment allocation is not a supported positive integer amount.",
      );
      return null;
    }
    if (payment.paymentStatus === "completed") completed += amount;
  }
  return completed;
}

function readSettlement(
  invoice: Invoice,
  invoiceAmount: bigint,
  addReason: AddReason,
): bigint | null {
  const paid = money(invoice.paidAmountCents);
  const balance = money(invoice.balanceCents);
  const completed = readCompletedPayments(invoice, addReason);
  if (paid === null || balance === null) {
    addReason(
      "PO_INVOICE_SETTLEMENT_INVALID",
      "Invoice settlement totals are missing or outside the supported exact integer range.",
    );
    return null;
  }
  if (completed === null) return null;
  if (
    paid > invoiceAmount ||
    completed !== paid ||
    balance !== invoiceAmount - paid
  ) {
    addReason(
      "PO_INVOICE_SETTLEMENT_MISMATCH",
      "Invoice settlement totals do not reconcile to completed payment evidence and the invoice amount.",
    );
    return null;
  }
  const inconsistentStatus =
    (invoice.status === "paid" && paid !== invoiceAmount) ||
    (invoice.status === "partially_paid" &&
      (paid === BigInt(0) || paid >= invoiceAmount)) ||
    (["received", "approved"].includes(invoice.status) && paid !== BigInt(0));
  if (inconsistentStatus) {
    addReason(
      "PO_INVOICE_STATUS_MISMATCH",
      "Invoice status does not agree with its recorded settlement amounts.",
    );
    return null;
  }
  return paid;
}

function evaluateInvoice(
  raw: unknown,
  input: PoFinancialEvidenceInput,
  addReason: AddReason,
): Amounts {
  const parsed = invoiceSchema.safeParse(raw);
  if (!parsed.success) {
    addReason(
      "PO_INVOICE_EVIDENCE_INVALID",
      "Invoice evidence contains a missing field, malformed identity or unsupported status.",
    );
    return unknownAmounts;
  }
  const invoice = parsed.data;
  if (
    invoice.vendorId !== input.vendorId ||
    invoice.currency !== input.currency
  ) {
    addReason(
      "PO_INVOICE_OWNERSHIP_INVALID",
      "Invoice vendor or currency does not match this purchase order.",
    );
    return unknownAmounts;
  }
  const invoiceAmount = money(invoice.invoicedAmountCents);
  if (invoiceAmount === null) {
    addReason(
      "PO_INVOICE_AMOUNT_INVALID",
      "Invoice amount is missing or outside the supported nonnegative exact integer range.",
    );
    return unknownAmounts;
  }
  const buckets = readOwnership(invoice, input, addReason);
  if (buckets === null) return unknownAmounts;
  const total = [...buckets.values()].reduce(
    (sum, amount) => sum + amount,
    BigInt(0),
  );
  if (total !== invoiceAmount) {
    addReason(
      "PO_INVOICE_LINE_TOTAL_MISMATCH",
      "Mapped invoice line amounts do not reconcile to the entire invoice amount.",
    );
    return unknownAmounts;
  }
  const invoiced = buckets.get(input.purchaseOrderId)!;
  const paid = readSettlement(invoice, invoiceAmount, addReason);
  if (paid === null) return { invoiced, paid: null, outstanding: null };
  if ([...buckets.values()].some((amount) => amount < BigInt(0))) {
    addReason(
      "PO_SIGNED_SETTLEMENT_REVIEW_REQUIRED",
      "A purchase order has a net invoice credit; its settlement attribution requires review.",
    );
    return { invoiced, paid: null, outstanding: null };
  }
  // Zero payment and complete settlement are exact boundaries. For partial
  // settlement, only one nonzero owner can identify the PO share without a
  // remittance split. Invoice-level payment history is never reconstructed.
  let attributedPaid: bigint;
  if (paid === BigInt(0)) attributedPaid = BigInt(0);
  else if (paid === invoiceAmount) attributedPaid = invoiced;
  else if (
    [...buckets.values()].filter((amount) => amount > BigInt(0)).length === 1
  ) {
    attributedPaid = invoiced > BigInt(0) ? paid : BigInt(0);
  } else {
    addReason(
      "PO_SHARED_INVOICE_PARTIAL_PAYMENT",
      "This invoice covers multiple purchase orders and is partially paid; no purchase order payment split was recorded.",
    );
    return { invoiced, paid: null, outstanding: null };
  }
  return {
    invoiced,
    paid: attributedPaid,
    outstanding: invoiced - attributedPaid,
  };
}

function aggregateAmounts(
  values: readonly (bigint | null)[],
  reasons: ReviewReason[],
): number | null {
  if (values.some((value) => value === null)) return null;
  const total = values.reduce<bigint>((sum, value) => sum + value!, BigInt(0));
  if (total < -maximumCents || total > maximumCents) {
    reasons.push({
      code: "PO_FINANCIAL_AMOUNT_OVERFLOW",
      message:
        "The purchase order financial total exceeds the supported exact integer range.",
      invoiceId: null,
    });
    return null;
  }
  return Number(total);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invoiceIdFromEvidence(value: unknown): number | null {
  const parsed = id.safeParse(isRecord(value) ? value.id : undefined);
  return parsed.success ? parsed.data : null;
}

/** A line or allocation belongs to one invoice. Repeated payment IDs across
 * invoices are legitimate, but repeated allocation IDs would count evidence twice. */
function hasRepeatedSourceIdentities(invoices: readonly unknown[]): boolean {
  const lineIds = new Set<number>();
  const allocationIds = new Set<number>();
  for (const invoice of invoices) {
    if (!isRecord(invoice)) continue;
    if (Array.isArray(invoice.lines)) {
      for (const line of invoice.lines) {
        const lineId = id.safeParse(isRecord(line) ? line.id : undefined);
        if (!lineId.success) continue;
        if (lineIds.has(lineId.data)) return true;
        lineIds.add(lineId.data);
      }
    }
    if (Array.isArray(invoice.payments)) {
      for (const payment of invoice.payments) {
        const allocationId = id.safeParse(
          isRecord(payment) ? payment.allocationId : undefined,
        );
        if (!allocationId.success) continue;
        if (allocationIds.has(allocationId.data)) return true;
        allocationIds.add(allocationId.data);
      }
    }
  }
  return false;
}
/** Additive current evidence only: no cache writes, allocation policy, clock or mutation. */
export function buildPoFinancialEvidence(
  input: PoFinancialEvidenceInput,
): PoFinancialEvidence {
  const validated = rootSchema.parse(input);
  const reasons: ReviewReason[] = [];
  // Individual malformed records must become review evidence, rather than
  // throwing before the invoice validator can classify them.
  const active = validated.invoices.filter(
    (invoice) => !isRecord(invoice) || invoice.status !== "voided",
  );
  const identifiedInvoiceIds = active
    .map(invoiceIdFromEvidence)
    .filter((invoiceId): invoiceId is number => invoiceId !== null);
  const invoiceIds = new Set(identifiedInvoiceIds);
  const unidentifiedCount = active.length - identifiedInvoiceIds.length;
  const results: Amounts[] = [];
  if (input.currency !== "USD") {
    reasons.push({
      code: "PO_FINANCIAL_CURRENCY_UNSUPPORTED",
      message:
        "Purchase order financial attribution currently supports USD evidence only.",
      invoiceId: null,
    });
    results.push(unknownAmounts);
  } else if (invoiceIds.size !== identifiedInvoiceIds.length) {
    reasons.push({
      code: "PO_INVOICE_EVIDENCE_DUPLICATE",
      message:
        "An invoice appears more than once in this purchase order's financial evidence.",
      invoiceId: null,
    });
    results.push(unknownAmounts);
  } else if (hasRepeatedSourceIdentities(active)) {
    reasons.push({
      code: "PO_FINANCIAL_SOURCE_DUPLICATE",
      message:
        "An invoice line or payment allocation appears more than once in the financial evidence.",
      invoiceId: null,
    });
    results.push(unknownAmounts);
  } else {
    for (const invoice of active) {
      const invoiceId = invoiceIdFromEvidence(invoice);
      results.push(
        evaluateInvoice(invoice, input, (code, message) =>
          reasons.push({ code, message, invoiceId }),
        ),
      );
    }
  }
  const invoicedAmountCents = aggregateAmounts(
    results.map((result) => result.invoiced),
    reasons,
  );
  const paidAmountCents = aggregateAmounts(
    results.map((result) => result.paid),
    reasons,
  );
  const outstandingAmountCents = aggregateAmounts(
    results.map((result) => result.outstanding),
    reasons,
  );
  const reviewReasons = [
    ...new Map(
      reasons.map((reason) => [
        `${reason.invoiceId}:${reason.code}:${reason.message}`,
        reason,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      (left.invoiceId ?? 0) - (right.invoiceId ?? 0) ||
      (left.code < right.code ? -1 : left.code > right.code ? 1 : 0),
  );
  return poFinancialEvidenceSchema.parse({
    purchaseOrderId: input.purchaseOrderId,
    currency: input.currency,
    state: reviewReasons.length ? "review_required" : "complete",
    invoicedAmountCents,
    paidAmountCents,
    outstandingAmountCents,
    invoiceCount: invoiceIds.size + unidentifiedCount,
    reviewReasons,
  });
}
