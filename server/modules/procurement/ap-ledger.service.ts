/**
 * AP Ledger Service
 * Handles vendor invoice lifecycle, payment recording, and invoice balance tracking.
 */

import { db } from "../../db";
import {
  vendorInvoices,
  vendorInvoicePoLinks,
  vendorInvoiceLines,
  vendorInvoiceAttachments,
  apPayments,
  apPaymentAllocations,
  purchaseOrders,
  purchaseOrderLines,
  vendors,
  inboundFreightCosts,
  inboundShipments,
  auditEvents,
  poStatusHistory,
} from "@shared/schema";
import { eq, and, inArray, sql, desc, lt, lte, gte, ne, asc, like } from "drizzle-orm";
import { format } from "date-fns";
import {
  centsToMills,
  computeLineTotalCentsFromMills,
  millsToCents,
} from "@shared/utils/money";
import {
  detectMatchMismatch,
  detectOverpaid,
  detectPastDue,
} from "./po-exceptions.service";
import {
  computePurchaseOrderInvoiceMatchSourceFingerprint,
  evaluatePurchaseOrderInvoiceMatches,
} from "./purchase-order-invoice-match";
import { COGSService } from "../inventory";

// ── Error class ─────────────────────────────────────────────────────

export class ApLedgerError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public details?: any,
  ) {
    super(message);
    this.name = "ApLedgerError";
  }
}

function positiveIntegerOrNull(value: unknown): number | null {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) return null;
  return numberValue;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const normalized = positiveIntegerOrNull(value);
  if (normalized === null || !Number.isSafeInteger(normalized)) {
    throw new ApLedgerError(`${field} must be a positive integer`, 400, {
      code: "AP_INPUT_POSITIVE_INTEGER_REQUIRED",
      field,
    });
  }
  return normalized;
}

function requireNonnegativeInteger(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ApLedgerError(`${field} must be a non-negative integer`, 400, {
      code: "AP_INPUT_NONNEGATIVE_INTEGER_REQUIRED",
      field,
    });
  }
  return normalized;
}

function requireUsdFinancialDocumentCurrency(value: unknown, field: string): string {
  const currency = normalizeRequiredText(value ?? "USD", field, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApLedgerError(`${field} must be a three-letter ISO code`, 400, {
      code: "AP_INPUT_CURRENCY_INVALID",
      field,
    });
  }
  if (currency !== "USD") {
    throw new ApLedgerError(
      "Non-USD purchasing documents require an explicit foreign-exchange rate authority",
      422,
      {
        code: "AP_FX_RATE_REQUIRED",
        field,
        currency,
        reportingCurrency: "USD",
      },
    );
  }
  return "USD";
}

function databaseMoneyToBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") {
    if (value < BigInt(0)) throw new ApLedgerError(`${field} cannot be negative`, 500);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ApLedgerError(`${field} is not a non-negative safe integer`, 500, {
        code: "AP_DATABASE_MONEY_INVALID",
        field,
        value,
      });
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new ApLedgerError(`${field} is not a valid integer money value`, 500, {
    code: "AP_DATABASE_MONEY_INVALID",
    field,
    value,
  });
}

function bigintMoneyToNumber(value: bigint, field: string): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApLedgerError(`${field} exceeds the supported integer money range`, 500, {
      code: "AP_DATABASE_MONEY_OVERFLOW",
      field,
      value: value.toString(),
    });
  }
  return Number(value);
}

function normalizeUnitCost(input: {
  unitCostCents?: unknown;
  unitCostMills?: unknown;
}): { unitCostCents: number; unitCostMills: number } {
  if (input.unitCostCents === undefined && input.unitCostMills === undefined) {
    throw new ApLedgerError("unitCostCents or unitCostMills is required", 400, {
      code: "AP_UNIT_COST_REQUIRED",
    });
  }
  const unitCostMills = input.unitCostMills === undefined
    ? centsToMills(requireNonnegativeInteger(input.unitCostCents, "unitCostCents"))
    : requireNonnegativeInteger(input.unitCostMills, "unitCostMills");
  const unitCostCents = millsToCents(unitCostMills);
  if (input.unitCostCents !== undefined) {
    const suppliedCents = requireNonnegativeInteger(input.unitCostCents, "unitCostCents");
    if (suppliedCents !== unitCostCents) {
      throw new ApLedgerError("unitCostCents and unitCostMills disagree", 400, {
        code: "AP_UNIT_COST_PRECISION_MISMATCH",
        suppliedCents,
        expectedCents: unitCostCents,
        unitCostMills,
      });
    }
  }
  return { unitCostCents, unitCostMills };
}

export function allocateProportionalPaidCents(
  items: Array<{ id: number; amountCents: number }>,
  paidCents: number,
  invoiceTotalCents: number,
): Map<number, number> {
  const normalizedPaid = requireNonnegativeInteger(paidCents, "paidCents");
  const normalizedInvoiceTotal = requirePositiveInteger(invoiceTotalCents, "invoiceTotalCents");
  if (normalizedPaid > normalizedInvoiceTotal) {
    throw new ApLedgerError("paidCents cannot exceed invoiceTotalCents", 500, {
      code: "AP_PAYMENT_ALLOCATION_INTEGRITY_ERROR",
      paidCents: normalizedPaid,
      invoiceTotalCents: normalizedInvoiceTotal,
    });
  }

  const seenIds = new Set<number>();
  const normalizedItems = items.map((item, index) => {
    const id = requirePositiveInteger(item.id, `items[${index}].id`);
    if (seenIds.has(id)) {
      throw new ApLedgerError("Payment allocation item ids must be unique", 500, {
        code: "AP_PAYMENT_ALLOCATION_DUPLICATE_ITEM",
        id,
      });
    }
    seenIds.add(id);
    return {
      id,
      amountCents: requireNonnegativeInteger(item.amountCents, `items[${index}].amountCents`),
    };
  });

  const invoiceTotal = BigInt(normalizedInvoiceTotal);
  const paid = BigInt(normalizedPaid);
  const totalItemAmount = normalizedItems.reduce(
    (sum, item) => sum + BigInt(item.amountCents),
    BigInt(0),
  );
  if (totalItemAmount > invoiceTotal) {
    throw new ApLedgerError("Linked shipment cost lines exceed the invoice total", 500, {
      code: "AP_SHIPMENT_COST_TOTAL_EXCEEDS_INVOICE",
      linkedCostTotalCents: totalItemAmount.toString(),
      invoiceTotalCents: normalizedInvoiceTotal,
    });
  }

  const targetNumerator = totalItemAmount * paid;
  const targetPaid = (targetNumerator + invoiceTotal / BigInt(2)) / invoiceTotal;
  const allocations = normalizedItems.map((item) => {
    const numerator = BigInt(item.amountCents) * paid;
    return {
      id: item.id,
      paidCents: numerator / invoiceTotal,
      remainder: numerator % invoiceTotal,
    };
  });
  const allocatedFloor = allocations.reduce((sum, item) => sum + item.paidCents, BigInt(0));
  let centsToDistribute = targetPaid - allocatedFloor;

  allocations.sort((left, right) => {
    if (left.remainder === right.remainder) return left.id - right.id;
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (const allocation of allocations) {
    if (centsToDistribute <= BigInt(0)) break;
    allocation.paidCents += BigInt(1);
    centsToDistribute -= BigInt(1);
  }

  return new Map(allocations.map((item) => [item.id, Number(item.paidCents)]));
}

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApLedgerError(`${field} is required`, 400, {
      code: "AP_INPUT_TEXT_REQUIRED",
      field,
    });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ApLedgerError(`${field} must be ${maxLength} characters or fewer`, 400, {
      code: "AP_INPUT_TEXT_TOO_LONG",
      field,
      maxLength,
    });
  }
  return normalized;
}

function normalizeOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ApLedgerError(`${field} must be a string`, 400, {
      code: "AP_INPUT_TEXT_INVALID",
      field,
    });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ApLedgerError(`${field} must be ${maxLength} characters or fewer`, 400, {
      code: "AP_INPUT_TEXT_TOO_LONG",
      field,
      maxLength,
    });
  }
  return normalized || undefined;
}

function normalizeOptionalDate(value: Date | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ApLedgerError(`${field} must be a valid date`, 400, {
      code: "AP_INPUT_DATE_INVALID",
      field,
    });
  }
  return value;
}

function rejectUnexpectedFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  context: string,
): void {
  const unexpectedFields = Object.keys(value).filter((field) => !allowedFields.has(field));
  if (unexpectedFields.length > 0) {
    throw new ApLedgerError(`${context} contains unsupported fields`, 400, {
      code: "AP_INPUT_FIELDS_UNSUPPORTED",
      unexpectedFields: unexpectedFields.sort(),
    });
  }
}

function resolvePoLineReceiveVariantId(poLine: any): number | null {
  return (
    positiveIntegerOrNull(poLine?.expectedReceiveVariantId) ??
    positiveIntegerOrNull(poLine?.productVariantId)
  );
}

export type ApLedgerCommand =
  | "approve_invoice"
  | "dispute_invoice"
  | "void_invoice"
  | "record_payment"
  | "void_payment";

export type RecordApPaymentInput = {
  vendorId: number;
  paymentDate: Date;
  paymentMethod: string;
  referenceNumber?: string;
  checkNumber?: string;
  bankAccountLabel?: string;
  totalAmountCents: number;
  currency?: string;
  notes?: string;
  status?: string;
  allocations: Array<{ vendorInvoiceId: number; appliedAmountCents: number; notes?: string }>;
  createdBy?: string;
};

export type ApLedgerCommandInput = {
  invoiceId?: number;
  paymentId?: number;
  reason?: string;
  userId?: string;
  payment?: RecordApPaymentInput;
};

export type ApLedgerCommandOutcome = {
  command: ApLedgerCommand;
  entityType: "invoice" | "payment";
  entityId?: number;
  affectedInvoiceIds: number[];
  affectedPaymentIds: number[];
  affectedPurchaseOrderIds: number[];
  message: string;
};

export type ApLedgerDbClient = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;

type RecomputePoFinancialAggregatesOptions = {
  client?: ApLedgerDbClient;
  runDetection?: boolean;
  actorId?: string;
  reason?: string;
  now?: Date;
  resolveDispute?: boolean;
};

// ─── PO Financial Aggregate Recompute ───────────────────────────────────────
//
// Called after any invoice or payment write that can affect a PO's financial
// state. Reads from non-voided vendor_invoices linked via vendor_invoice_po_links
// and writes back to purchase_orders.invoiced_total_cents / paid_total_cents /
// outstanding_cents / financial_status.
//
// Rule #3: integer arithmetic only — BigInt cents, no floats.
// Rule #6: idempotent — safe to call multiple times for the same PO.

/**
 * Return all PO IDs linked to a given invoice via vendor_invoice_po_links.
 */
async function getPoIdsForInvoice(invoiceId: number, client: ApLedgerDbClient = db): Promise<number[]> {
  const rows = await client
    .select({ purchaseOrderId: vendorInvoicePoLinks.purchaseOrderId })
    .from(vendorInvoicePoLinks)
    .where(eq(vendorInvoicePoLinks.vendorInvoiceId, invoiceId));
  return rows.map((r: { purchaseOrderId: number }) => r.purchaseOrderId);
}

async function recomputeLinkedPurchaseOrders(
  invoiceId: number,
  client: ApLedgerDbClient,
  options: Pick<
    RecomputePoFinancialAggregatesOptions,
    "actorId" | "reason" | "now" | "resolveDispute"
  > = {},
): Promise<number[]> {
  const poIds = await getPoIdsForInvoice(invoiceId, client);
  await recomputePoFinancialAggregatesForMany(poIds, client, options);
  return [...new Set(poIds)].sort((left, right) => left - right);
}

async function getInvoiceIdsForPayment(
  paymentId: number,
  client: ApLedgerDbClient = db,
): Promise<number[]> {
  const rows = await client
    .select({ vendorInvoiceId: apPaymentAllocations.vendorInvoiceId })
    .from(apPaymentAllocations)
    .where(eq(apPaymentAllocations.apPaymentId, paymentId));
  return rows.map((r: { vendorInvoiceId: number }) => r.vendorInvoiceId);
}

function uniqueNumbers(values: Iterable<number | null | undefined>): number[] {
  return [...new Set([...values].filter((value): value is number => Number.isFinite(value)))];
}

function attachApLedgerOutcome<T extends object>(data: T, outcome: ApLedgerCommandOutcome): T & { apLedgerOutcome: ApLedgerCommandOutcome } {
  return { ...data, apLedgerOutcome: outcome };
}

function buildApLedgerOutcome(input: {
  command: ApLedgerCommand;
  entityType: "invoice" | "payment";
  entityId?: number;
  affectedInvoiceIds?: number[];
  affectedPaymentIds?: number[];
  affectedPurchaseOrderIds?: number[];
}): ApLedgerCommandOutcome {
  const affectedInvoiceIds = uniqueNumbers(input.affectedInvoiceIds ?? []);
  const affectedPaymentIds = uniqueNumbers(input.affectedPaymentIds ?? []);
  const affectedPurchaseOrderIds = uniqueNumbers(input.affectedPurchaseOrderIds ?? []);
  const poPart = affectedPurchaseOrderIds.length
    ? ` Updated ${affectedPurchaseOrderIds.length} linked PO${affectedPurchaseOrderIds.length === 1 ? "" : "s"}.`
    : " No linked POs were affected.";

  return {
    command: input.command,
    entityType: input.entityType,
    entityId: input.entityId,
    affectedInvoiceIds,
    affectedPaymentIds,
    affectedPurchaseOrderIds,
    message: `${input.command.replace(/_/g, " ")} completed.${poPart}`,
  };
}

async function appendApLedgerCommandAudit(
  outcome: ApLedgerCommandOutcome,
  actor: string | undefined,
  client: ApLedgerDbClient,
): Promise<void> {
  await client.insert(auditEvents).values({
    level: "AUDIT",
    actor: actor ?? "system",
    action: `ap_ledger.${outcome.command}`,
    target: `${outcome.entityType}:${outcome.entityId ?? "unknown"}`,
    changes: null,
    context: {
      ...outcome,
    },
  });
}

async function appendApMutationAudit(
  action: string,
  target: string,
  actor: string | undefined,
  context: Record<string, unknown>,
  client: ApLedgerDbClient,
): Promise<void> {
  await client.insert(auditEvents).values({
    level: "AUDIT",
    actor: actor ?? "system",
    action: `ap_ledger.${action}`,
    target,
    changes: null,
    context,
  });
}

type EditableInvoice = {
  id: number;
  vendorId: number;
  currency: string | null;
  status: string;
  paidAmountCents: number;
};

async function lockEditableInvoice(
  client: ApLedgerDbClient,
  invoiceId: number,
): Promise<EditableInvoice> {
  const [invoice] = await client
    .select({
      id: vendorInvoices.id,
      vendorId: vendorInvoices.vendorId,
      currency: vendorInvoices.currency,
      status: vendorInvoices.status,
      paidAmountCents: vendorInvoices.paidAmountCents,
    })
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, invoiceId))
    .for("update");

  if (!invoice) {
    throw new ApLedgerError("Invoice not found", 404, { code: "AP_INVOICE_NOT_FOUND" });
  }
  if (!["received", "disputed"].includes(invoice.status)) {
    throw new ApLedgerError(
      "Only received or disputed invoices can be edited",
      409,
      {
        code: "AP_INVOICE_IMMUTABLE",
        invoiceId,
        status: invoice.status,
      },
    );
  }

  return invoice;
}

async function lockInvoiceForMatch(
  client: ApLedgerDbClient,
  invoiceId: number,
): Promise<EditableInvoice> {
  const [invoice] = await client
    .select({
      id: vendorInvoices.id,
      vendorId: vendorInvoices.vendorId,
      currency: vendorInvoices.currency,
      status: vendorInvoices.status,
      paidAmountCents: vendorInvoices.paidAmountCents,
    })
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, invoiceId))
    .for("update");

  if (!invoice) {
    throw new ApLedgerError("Invoice not found", 404, { code: "AP_INVOICE_NOT_FOUND" });
  }
  if (invoice.status === "voided") {
    throw new ApLedgerError("Voided invoices cannot be matched", 409, {
      code: "AP_INVOICE_MATCH_VOIDED",
      invoiceId,
    });
  }
  return invoice;
}

async function lockMatchingPurchaseOrder(
  client: ApLedgerDbClient,
  purchaseOrderId: number,
  vendorId: number,
  invoiceCurrency: string | null | undefined,
): Promise<void> {
  const [po] = await client
    .select({
      id: purchaseOrders.id,
      vendorId: purchaseOrders.vendorId,
      currency: purchaseOrders.currency,
    })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, purchaseOrderId))
    .for("update");

  if (!po) {
    throw new ApLedgerError("Purchase order not found", 404, {
      code: "AP_PURCHASE_ORDER_NOT_FOUND",
      purchaseOrderId,
    });
  }
  if (po.vendorId !== vendorId) {
    throw new ApLedgerError(
      "Invoice and purchase order must belong to the same vendor",
      422,
      {
        code: "AP_INVOICE_PO_VENDOR_MISMATCH",
        purchaseOrderId,
        invoiceVendorId: vendorId,
        purchaseOrderVendorId: po.vendorId,
      },
    );
  }
  const normalizedInvoiceCurrency = (invoiceCurrency ?? "USD").trim().toUpperCase();
  const normalizedPoCurrency = (po.currency ?? "USD").trim().toUpperCase();
  if (normalizedInvoiceCurrency !== normalizedPoCurrency) {
    throw new ApLedgerError(
      "Invoice and purchase order must use the same currency",
      422,
      {
        code: "AP_INVOICE_PO_CURRENCY_MISMATCH",
        purchaseOrderId,
        invoiceCurrency: normalizedInvoiceCurrency,
        purchaseOrderCurrency: normalizedPoCurrency,
      },
    );
  }
  requireUsdFinancialDocumentCurrency(normalizedPoCurrency, "purchaseOrder.currency");
}

async function requireLinkedPoLine(
  client: ApLedgerDbClient,
  invoiceId: number,
  purchaseOrderLineId: number,
): Promise<void> {
  const [lineReference] = await client
    .select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.id, purchaseOrderLineId));
  if (!lineReference) {
    throw new ApLedgerError("Purchase order line not found", 404, {
      code: "AP_PURCHASE_ORDER_LINE_NOT_FOUND",
      purchaseOrderLineId,
    });
  }
  const [po] = await client
    .select({ id: purchaseOrders.id })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, lineReference.purchaseOrderId))
    .for("update");
  if (!po) {
    throw new ApLedgerError("Purchase order not found", 404, {
      code: "AP_PURCHASE_ORDER_NOT_FOUND",
      purchaseOrderId: lineReference.purchaseOrderId,
    });
  }
  const [poLine] = await client
    .select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.id, purchaseOrderLineId))
    .for("share");
  if (!poLine || poLine.purchaseOrderId !== lineReference.purchaseOrderId) {
    throw new ApLedgerError("Purchase order line changed while the invoice was being updated", 409, {
      code: "AP_PURCHASE_ORDER_LINE_CONFLICT",
      purchaseOrderLineId,
    });
  }

  const [link] = await client
    .select({ id: vendorInvoicePoLinks.id })
    .from(vendorInvoicePoLinks)
    .where(and(
      eq(vendorInvoicePoLinks.vendorInvoiceId, invoiceId),
      eq(vendorInvoicePoLinks.purchaseOrderId, lineReference.purchaseOrderId),
    ));
  if (!link) {
    throw new ApLedgerError(
      "Invoice line can reference only a purchase order linked to this invoice",
      422,
      {
        code: "AP_INVOICE_LINE_PO_NOT_LINKED",
        invoiceId,
        purchaseOrderLineId,
        purchaseOrderId: lineReference.purchaseOrderId,
      },
    );
  }
}

async function runPoFinancialDetectionHooks(poId: number): Promise<void> {
  try {
    await detectOverpaid(poId);
    await detectPastDue(poId);
  } catch (detectionErr) {
    console.error("[po-exceptions] detection hook failed in recomputePoFinancialAggregates:", detectionErr);
  }
}

async function runPoFinancialDetectionHooksForMany(poIds: Iterable<number>): Promise<void> {
  for (const poId of new Set(poIds)) {
    await runPoFinancialDetectionHooks(poId);
  }
}

async function recomputePoFinancialAggregatesForMany(
  poIds: Iterable<number>,
  client: ApLedgerDbClient,
  options: Pick<
    RecomputePoFinancialAggregatesOptions,
    "actorId" | "reason" | "now" | "resolveDispute"
  > = {},
): Promise<void> {
  const orderedPoIds = [...new Set(poIds)].sort((left, right) => left - right);
  for (const poId of orderedPoIds) {
    await recomputePoFinancialAggregates(poId, {
      ...options,
      client,
      runDetection: false,
    });
  }
}

/**
 * Recompute financial aggregate columns on a purchase_order row.
 *
 * Sums invoicedAmountCents and paidAmountCents from all non-voided
 * vendor_invoices linked to the PO, derives outstanding_cents and
 * financial_status, then writes back atomically.
 *
 * Timestamps (firstInvoicedAt, firstPaidAt, fullyPaidAt) are only stamped
 * on first occurrence — never overwritten once set.
 */
export async function recomputePoFinancialAggregates(
  poId: number,
  options: RecomputePoFinancialAggregatesOptions = {},
): Promise<void> {
  if (!options.client) {
    await db.transaction(async (tx: ApLedgerDbClient) => {
      await recomputePoFinancialAggregates(poId, {
        ...options,
        client: tx,
        runDetection: false,
      });
    });
    if (options.runDetection !== false) {
      await runPoFinancialDetectionHooks(poId);
    }
    return;
  }

  const client = options.client;

  // Serialize every aggregate writer on the PO row. The invoice sum, aggregate
  // update, lifecycle timestamps, and status history then describe one state.
  const [po] = await client
    .select({
      status: purchaseOrders.status,
      financialStatus: purchaseOrders.financialStatus,
      firstInvoicedAt: purchaseOrders.firstInvoicedAt,
      firstPaidAt: purchaseOrders.firstPaidAt,
      fullyPaidAt: purchaseOrders.fullyPaidAt,
    })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .for("update");

  if (!po) return;

  // Sum from non-voided invoices linked to this PO.
  const invoiceRows = await client
    .select({
      invoicedAmountCents: vendorInvoices.invoicedAmountCents,
      paidAmountCents: vendorInvoices.paidAmountCents,
      status: vendorInvoices.status,
    })
    .from(vendorInvoicePoLinks)
    .innerJoin(vendorInvoices, eq(vendorInvoicePoLinks.vendorInvoiceId, vendorInvoices.id))
    .where(
      and(
        eq(vendorInvoicePoLinks.purchaseOrderId, poId),
        ne(vendorInvoices.status, "voided"),
      ),
    );

  // Integer arithmetic only (Rule #3).
  let invoicedTotal = BigInt(0);
  let paidTotal = BigInt(0);
  for (const [index, row] of invoiceRows.entries()) {
    invoicedTotal += databaseMoneyToBigInt(
      row.invoicedAmountCents ?? 0,
      `invoiceRows[${index}].invoicedAmountCents`,
    );
    paidTotal += databaseMoneyToBigInt(
      row.paidAmountCents ?? 0,
      `invoiceRows[${index}].paidAmountCents`,
    );
  }
  const outstanding = invoicedTotal > paidTotal ? invoicedTotal - paidTotal : BigInt(0);
  const hasDisputedInvoice = invoiceRows.some((row) => row.status === "disputed");

  // Derive new financial_status. Disputed stays disputed until explicitly resolved.
  const currentFinancial = (po.financialStatus ?? "unbilled") as string;
  let newFinancial: string;
  if (hasDisputedInvoice) {
    newFinancial = "disputed";
  } else if (currentFinancial === "disputed" && options.resolveDispute !== true) {
    newFinancial = "disputed";
  } else if (invoicedTotal === BigInt(0)) {
    newFinancial = "unbilled";
  } else if (paidTotal >= invoicedTotal) {
    newFinancial = "paid";
  } else if (paidTotal > BigInt(0)) {
    newFinancial = "partially_paid";
  } else {
    newFinancial = "invoiced";
  }

  const now = options.now ?? new Date();
  const patch: Record<string, any> = {
    invoicedTotalCents: bigintMoneyToNumber(invoicedTotal, "purchaseOrder.invoicedTotalCents"),
    paidTotalCents: bigintMoneyToNumber(paidTotal, "purchaseOrder.paidTotalCents"),
    outstandingCents: bigintMoneyToNumber(outstanding, "purchaseOrder.outstandingCents"),
    financialStatus: newFinancial,
    updatedAt: now,
  };

  // Stamp lifecycle timestamps on first occurrence only.
  if (currentFinancial === "unbilled" && newFinancial !== "unbilled" && !po.firstInvoicedAt) {
    patch.firstInvoicedAt = now;
  }
  if (
    (currentFinancial === "unbilled" || currentFinancial === "invoiced") &&
    (newFinancial === "partially_paid" || newFinancial === "paid") &&
    !po.firstPaidAt
  ) {
    patch.firstPaidAt = now;
  }
  if (newFinancial === "paid" && !po.fullyPaidAt) {
    patch.fullyPaidAt = now;
  }

  await client.update(purchaseOrders).set(patch).where(eq(purchaseOrders.id, poId));

  if (currentFinancial !== newFinancial) {
    await client.insert(poStatusHistory).values({
      purchaseOrderId: poId,
      fromStatus: po.status,
      toStatus: po.status,
      changedBy: options.actorId ?? null,
      changedAt: now,
      notes: options.reason
        ? `Financial status: ${currentFinancial} -> ${newFinancial}. ${options.reason}`
        : `Financial status: ${currentFinancial} -> ${newFinancial}.`,
    });
  }

  // ── Exception detection hooks (event-driven, Phase 1) ──────────────────
  // Run after the DB write so detection reads fresh aggregates.
  // Non-blocking: detection failures should not roll back the recompute.
  if (options.runDetection !== false) {
    await runPoFinancialDetectionHooks(poId);
  }
}

// ─── Status Transition Validation ────────────────────────────────────────────

const INVOICE_VALID_TRANSITIONS: Record<string, string[]> = {
  received: ["approved", "disputed", "voided"],
  approved: ["partially_paid", "paid", "disputed", "voided"],
  partially_paid: ["paid", "disputed", "voided"],
  disputed: ["approved", "voided"],
  paid: ["voided"],
  voided: [],
};

export function canTransitionInvoice(from: string, to: string): boolean {
  return (INVOICE_VALID_TRANSITIONS[from] ?? []).includes(to);
}

// ─── Payment Number Generation ────────────────────────────────────────────────

async function generatePaymentNumber(client: ApLedgerDbClient = db): Promise<string> {
  const dateStr = format(new Date(), "yyyyMMdd");
  const prefix = `PAY-${dateStr}-`;

  const result = await client
    .select({ paymentNumber: apPayments.paymentNumber })
    .from(apPayments)
    .where(sql`${apPayments.paymentNumber} LIKE ${prefix + "%"}`)
    .orderBy(desc(apPayments.paymentNumber))
    .limit(1);

  if (result.length === 0) return `${prefix}001`;
  const last = result[0].paymentNumber;
  const seq = parseInt(last.split("-")[2] || "0", 10) + 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

// ─── Invoice Balance Recalculation ────────────────────────────────────────────

async function recalculateInvoiceBalance(invoiceId: number, client: ApLedgerDbClient = db): Promise<void> {
  const [invoice] = await client
    .select({ invoicedAmountCents: vendorInvoices.invoicedAmountCents, status: vendorInvoices.status })
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, invoiceId))
    .for("update");

  if (!invoice) return;

  // Sum all non-voided payment allocations
  const allocResult = await client
    .select({ total: sql<number>`COALESCE(SUM(${apPaymentAllocations.appliedAmountCents}), 0)` })
    .from(apPaymentAllocations)
    .innerJoin(apPayments, eq(apPaymentAllocations.apPaymentId, apPayments.id))
    .where(
      and(
        eq(apPaymentAllocations.vendorInvoiceId, invoiceId),
        ne(apPayments.status, "voided"),
      )
    );

  const paidAmount = databaseMoneyToBigInt(
    allocResult[0]?.total ?? 0,
    `invoice[${invoiceId}].paidAmountCents`,
  );
  const invoicedAmount = databaseMoneyToBigInt(
    invoice.invoicedAmountCents,
    `invoice[${invoiceId}].invoicedAmountCents`,
  );
  const balance = invoicedAmount - paidAmount;

  let newStatus = invoice.status;
  if (invoice.status !== "voided" && invoice.status !== "disputed") {
    if (balance <= BigInt(0)) {
      newStatus = "paid";
    } else if (paidAmount > BigInt(0)) {
      newStatus = "partially_paid";
    } else if (invoice.status === "paid" || invoice.status === "partially_paid") {
      // Payment was voided, revert to approved
      newStatus = "approved";
    }
  }

  await client
    .update(vendorInvoices)
    .set({
      paidAmountCents: bigintMoneyToNumber(paidAmount, `invoice[${invoiceId}].paidAmountCents`),
      balanceCents: bigintMoneyToNumber(
        balance > BigInt(0) ? balance : BigInt(0),
        `invoice[${invoiceId}].balanceCents`,
      ),
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(eq(vendorInvoices.id, invoiceId));
}

// ─── Invoice Number Generation ───────────────────────────────────────────────

export async function generateInvoiceNumber(): Promise<string> {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `INV-${dateStr}-`;

  const existing = await db
    .select({ invoiceNumber: vendorInvoices.invoiceNumber })
    .from(vendorInvoices)
    .where(like(vendorInvoices.invoiceNumber, `${prefix}%`))
    .orderBy(desc(vendorInvoices.invoiceNumber))
    .limit(1);

  let nextNum = 1;
  if (existing.length > 0 && existing[0].invoiceNumber) {
    const lastNum = parseInt(existing[0].invoiceNumber.replace(prefix, ""), 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }

  return `${prefix}${String(nextNum).padStart(3, "0")}`;
}

// ─── Invoice CRUD ─────────────────────────────────────────────────────────────

export async function createInvoice(data: {
  invoiceNumber: string;
  ourReference?: string;
  vendorId: number;
  invoiceDate?: Date;
  dueDate?: Date;
  invoicedAmountCents?: number; // Optional — if lines imported, will be computed
  currency?: string;
  paymentTermsDays?: number;
  paymentTermsType?: string;
  notes?: string;
  internalNotes?: string;
  poIds?: number[]; // POs to link + auto-import lines
  createdBy?: string;
}) {
  rejectUnexpectedFields(data as Record<string, unknown>, new Set([
    "invoiceNumber",
    "ourReference",
    "vendorId",
    "invoiceDate",
    "dueDate",
    "invoicedAmountCents",
    "currency",
    "paymentTermsDays",
    "paymentTermsType",
    "notes",
    "internalNotes",
    "poIds",
    "createdBy",
  ]), "invoice create");
  const invoiceNumber = normalizeRequiredText(data.invoiceNumber, "invoiceNumber", 100);
  const vendorId = requirePositiveInteger(data.vendorId, "vendorId");
  const poIds = [...new Set((data.poIds ?? []).map((poId) =>
    requirePositiveInteger(poId, "poIds[]"),
  ))].sort((left, right) => left - right);
  const invoicedAmountCents = requireNonnegativeInteger(
    data.invoicedAmountCents ?? 0,
    "invoicedAmountCents",
  );
  const currency = requireUsdFinancialDocumentCurrency(data.currency, "currency");
  const paymentTermsDays = data.paymentTermsDays === undefined
    ? undefined
    : requireNonnegativeInteger(data.paymentTermsDays, "paymentTermsDays");
  const invoiceDate = normalizeOptionalDate(data.invoiceDate, "invoiceDate");
  const dueDate = normalizeOptionalDate(data.dueDate, "dueDate");
  const ourReference = normalizeOptionalText(data.ourReference, "ourReference", 100);
  const paymentTermsType = normalizeOptionalText(data.paymentTermsType, "paymentTermsType", 20);
  const notes = normalizeOptionalText(data.notes, "notes", 10_000);
  const internalNotes = normalizeOptionalText(data.internalNotes, "internalNotes", 10_000);
  const receivedAt = new Date();

  const invoice = await db.transaction(async (tx: ApLedgerDbClient) => {
    let inserted: any;
    try {
      [inserted] = await tx
        .insert(vendorInvoices)
        .values({
          invoiceNumber,
          ourReference,
          vendorId,
          status: "received",
          receivedDate: receivedAt,
          invoiceDate,
          dueDate,
          invoicedAmountCents,
          paidAmountCents: 0,
          balanceCents: invoicedAmountCents,
          currency,
          paymentTermsDays,
          paymentTermsType,
          notes,
          internalNotes,
          createdBy: data.createdBy,
          updatedBy: data.createdBy,
        })
        .returning();
    } catch (error: any) {
      if (error?.code === "23505") {
        throw new ApLedgerError(
          `Duplicate Invoice: This vendor already has invoice "${invoiceNumber}".`,
          409,
          { code: "AP_INVOICE_DUPLICATE" },
        );
      }
      throw error;
    }

    for (const poId of poIds) {
      await lockMatchingPurchaseOrder(tx, poId, vendorId, currency);
    }
    if (poIds.length > 0) {
      await tx.insert(vendorInvoicePoLinks).values(
        poIds.map((poId) => ({
          vendorInvoiceId: inserted.id,
          purchaseOrderId: poId,
        })),
      );
      for (const poId of poIds) {
        await importLinesFromPOWithClient(inserted.id, poId, tx);
      }
      await recalculateInvoiceFromLines(inserted.id, tx);
      await recomputePoFinancialAggregatesForMany(poIds, tx, {
        actorId: data.createdBy,
        reason: `Vendor invoice ${inserted.id} created and linked.`,
        now: receivedAt,
      });
    }

    await appendApMutationAudit(
      "invoice_created",
      `invoice:${inserted.id}`,
      data.createdBy,
      {
        invoiceId: inserted.id,
        vendorId,
        purchaseOrderIds: poIds,
      },
      tx,
    );

    const [final] = await tx
      .select()
      .from(vendorInvoices)
      .where(eq(vendorInvoices.id, inserted.id));
    if (!final) {
      throw new ApLedgerError("Created invoice could not be reloaded", 500, {
        code: "AP_INVOICE_RELOAD_FAILED",
        invoiceId: inserted.id,
      });
    }
    return final;
  });

  await runPoFinancialDetectionHooksForMany(poIds);
  return invoice;
}

export async function getInvoiceById(id: number) {
  const [invoice] = await db
    .select()
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, id));

  if (!invoice) return null;

  const poLinks = await db
    .select({
      id: vendorInvoicePoLinks.id,
      purchaseOrderId: vendorInvoicePoLinks.purchaseOrderId,
      allocatedAmountCents: vendorInvoicePoLinks.allocatedAmountCents,
      notes: vendorInvoicePoLinks.notes,
      poNumber: purchaseOrders.poNumber,
      poStatus: purchaseOrders.status,
      poTotalCents: purchaseOrders.totalCents,
    })
    .from(vendorInvoicePoLinks)
    .leftJoin(purchaseOrders, eq(vendorInvoicePoLinks.purchaseOrderId, purchaseOrders.id))
    .where(eq(vendorInvoicePoLinks.vendorInvoiceId, id));

  const payments = await db
    .select({
      id: apPaymentAllocations.id,
      apPaymentId: apPaymentAllocations.apPaymentId,
      appliedAmountCents: apPaymentAllocations.appliedAmountCents,
      paymentNumber: apPayments.paymentNumber,
      paymentDate: apPayments.paymentDate,
      paymentMethod: apPayments.paymentMethod,
      paymentStatus: apPayments.status,
      referenceNumber: apPayments.referenceNumber,
    })
    .from(apPaymentAllocations)
    .innerJoin(apPayments, eq(apPaymentAllocations.apPaymentId, apPayments.id))
    .where(eq(apPaymentAllocations.vendorInvoiceId, id))
    .orderBy(desc(apPayments.paymentDate));

  const lines = await db
    .select()
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.vendorInvoiceId, id))
    .orderBy(asc(vendorInvoiceLines.lineNumber));

  const attachments = await db
    .select()
    .from(vendorInvoiceAttachments)
    .where(eq(vendorInvoiceAttachments.vendorInvoiceId, id))
    .orderBy(desc(vendorInvoiceAttachments.uploadedAt));

  return { ...invoice, poLinks, payments, lines, attachments };
}

export async function listInvoices(filters: {
  vendorId?: number;
  inboundShipmentId?: number;
  status?: string | string[];
  overdue?: boolean;
  dueBefore?: Date;
  limit?: number;
  offset?: number;
}) {
  const conditions = [];

  if (filters.vendorId) conditions.push(eq(vendorInvoices.vendorId, filters.vendorId));
  if (filters.inboundShipmentId) conditions.push(eq(vendorInvoices.inboundShipmentId, filters.inboundShipmentId));
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    conditions.push(inArray(vendorInvoices.status, statuses));
  }
  if (filters.overdue) {
    conditions.push(lt(vendorInvoices.dueDate, new Date()));
    conditions.push(inArray(vendorInvoices.status, ["received", "approved", "partially_paid"]));
  }
  if (filters.dueBefore) {
    conditions.push(lte(vendorInvoices.dueDate, filters.dueBefore));
  }

  const rows = await db
    .select({
      invoice: vendorInvoices,
      vendorName: vendors.name,
      vendorCode: vendors.code,
    })
    .from(vendorInvoices)
    .leftJoin(vendors, eq(vendorInvoices.vendorId, vendors.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(vendorInvoices.createdAt))
    .limit(filters.limit ?? 200)
    .offset(filters.offset ?? 0);

  // Attach PO numbers for each invoice
  const invoiceIds = rows.map((r) => r.invoice.id);
  let poLinkMap: Record<number, string[]> = {};
  if (invoiceIds.length) {
    const links = await db
      .select({
        vendorInvoiceId: vendorInvoicePoLinks.vendorInvoiceId,
        poNumber: purchaseOrders.poNumber,
      })
      .from(vendorInvoicePoLinks)
      .leftJoin(purchaseOrders, eq(vendorInvoicePoLinks.purchaseOrderId, purchaseOrders.id))
      .where(inArray(vendorInvoicePoLinks.vendorInvoiceId, invoiceIds));

    for (const link of links) {
      if (!poLinkMap[link.vendorInvoiceId]) poLinkMap[link.vendorInvoiceId] = [];
      if (link.poNumber) poLinkMap[link.vendorInvoiceId].push(link.poNumber);
    }
  }

  return rows.map((r) => ({
    ...r.invoice,
    vendorName: r.vendorName,
    vendorCode: r.vendorCode,
    poNumbers: poLinkMap[r.invoice.id] ?? [],
  }));
}

export async function updateInvoice(
  id: number,
  data: Partial<{
    invoiceNumber: string;
    ourReference: string;
    invoiceDate: Date;
    dueDate: Date;
    invoicedAmountCents: number;
    currency: string;
    paymentTermsDays: number;
    paymentTermsType: string;
    notes: string;
    internalNotes: string;
  }>,
  actorId?: string,
) {
  const invoiceId = requireCommandId(id, "invoiceId");
  rejectUnexpectedFields(data as Record<string, unknown>, new Set([
    "invoiceNumber",
    "ourReference",
    "invoiceDate",
    "dueDate",
    "invoicedAmountCents",
    "currency",
    "paymentTermsDays",
    "paymentTermsType",
    "notes",
    "internalNotes",
  ]), "invoice update");
  const providedFields = Object.keys(data).filter(
    (field) => (data as Record<string, unknown>)[field] !== undefined,
  );
  if (providedFields.length === 0) {
    throw new ApLedgerError("Invoice update requires at least one field", 400, {
      code: "AP_INVOICE_UPDATE_EMPTY",
    });
  }

  const result = await db.transaction(async (tx: ApLedgerDbClient) => {
    const invoice = await lockEditableInvoice(tx, invoiceId);
    const patch: Record<string, unknown> = { updatedBy: actorId, updatedAt: new Date() };
    if (data.invoiceNumber !== undefined) {
      patch.invoiceNumber = normalizeRequiredText(data.invoiceNumber, "invoiceNumber", 100);
    }
    if (data.ourReference !== undefined) {
      patch.ourReference = normalizeOptionalText(data.ourReference, "ourReference", 100) ?? null;
    }
    if (data.invoiceDate !== undefined) {
      patch.invoiceDate = normalizeOptionalDate(data.invoiceDate, "invoiceDate");
    }
    if (data.dueDate !== undefined) {
      patch.dueDate = normalizeOptionalDate(data.dueDate, "dueDate");
    }
    if (data.currency !== undefined) {
      patch.currency = requireUsdFinancialDocumentCurrency(data.currency, "currency");
    }
    if (data.paymentTermsDays !== undefined) {
      patch.paymentTermsDays = requireNonnegativeInteger(data.paymentTermsDays, "paymentTermsDays");
    }
    if (data.paymentTermsType !== undefined) {
      patch.paymentTermsType = normalizeOptionalText(data.paymentTermsType, "paymentTermsType", 20) ?? null;
    }
    if (data.notes !== undefined) {
      patch.notes = normalizeOptionalText(data.notes, "notes", 10_000) ?? null;
    }
    if (data.internalNotes !== undefined) {
      patch.internalNotes = normalizeOptionalText(data.internalNotes, "internalNotes", 10_000) ?? null;
    }
    if (data.invoicedAmountCents !== undefined) {
      const [lineCount] = await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(vendorInvoiceLines)
        .where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId));
      if (Number(lineCount?.count ?? 0) > 0) {
        throw new ApLedgerError(
          "Invoice total is derived from its lines and cannot be edited directly",
          409,
          { code: "AP_INVOICE_TOTAL_DERIVED_FROM_LINES", invoiceId },
        );
      }
      const amount = requireNonnegativeInteger(data.invoicedAmountCents, "invoicedAmountCents");
      const paidAmount = databaseMoneyToBigInt(
        invoice.paidAmountCents,
        `invoice[${invoiceId}].paidAmountCents`,
      );
      const balance = BigInt(amount) - paidAmount;
      patch.invoicedAmountCents = amount;
      patch.balanceCents = bigintMoneyToNumber(
        balance > BigInt(0) ? balance : BigInt(0),
        `invoice[${invoiceId}].balanceCents`,
      );
    }

    let updated: any;
    try {
      [updated] = await tx
        .update(vendorInvoices)
        .set(patch)
        .where(eq(vendorInvoices.id, invoiceId))
        .returning();
    } catch (error: any) {
      if (error?.code === "23505") {
        throw new ApLedgerError("This vendor already has an invoice with that number", 409, {
          code: "AP_INVOICE_DUPLICATE",
        });
      }
      throw error;
    }

    const affectedPoIds = await recomputeLinkedPurchaseOrders(invoiceId, tx, {
      actorId,
      reason: `Vendor invoice ${invoiceId} updated.`,
    });
    await appendApMutationAudit(
      "invoice_updated",
      `invoice:${invoiceId}`,
      actorId,
      { invoiceId, changedFields: providedFields.sort(), affectedPoIds },
      tx,
    );
    return { updated, affectedPoIds };
  });

  await runPoFinancialDetectionHooksForMany(result.affectedPoIds);
  return result.updated;
}

// ─── Invoice Status Transitions ───────────────────────────────────────────────

type InvoiceMutationResult = {
  value: any;
  affectedPoIds: number[];
  changed: boolean;
};

async function approveInvoiceInTransaction(
  tx: ApLedgerDbClient,
  id: number,
  userId?: string,
): Promise<InvoiceMutationResult> {
  const [inv] = await tx
    .select()
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, id))
    .for("update");
  if (!inv) {
    throw new ApLedgerError("Invoice not found", 404, { code: "AP_INVOICE_NOT_FOUND" });
  }
  if (["approved", "partially_paid", "paid"].includes(inv.status)) {
    await reconcileApprovedInvoiceVariance(id, tx, userId);
    return {
      value: inv,
      affectedPoIds: await getPoIdsForInvoice(id, tx),
      changed: false,
    };
  }
  if (!["received", "disputed"].includes(inv.status)) {
    throw new ApLedgerError("Invoice must be in received or disputed status to approve", 409, {
      code: "AP_INVOICE_APPROVAL_STATUS_INVALID",
    });
  }

  const [invoice] = await tx
    .update(vendorInvoices)
    .set({ status: "approved", approvedAt: new Date(), approvedBy: userId, updatedBy: userId, updatedAt: new Date() })
    .where(eq(vendorInvoices.id, id))
    .returning();
  const affectedPoIds = await getPoIdsForInvoice(id, tx);
  await recomputePoFinancialAggregatesForMany(affectedPoIds, tx, {
    actorId: userId,
    reason: `Vendor invoice ${id} approved.`,
    resolveDispute: true,
  });
  await reconcileApprovedInvoiceVariance(id, tx, userId);
  return { value: invoice, affectedPoIds, changed: true };
}

async function reconcileApprovedInvoiceVariance(
  id: number,
  client: ApLedgerDbClient,
  actorId?: string,
): Promise<void> {
  const invoiceLines = await client
    .select({ purchaseOrderLineId: vendorInvoiceLines.purchaseOrderLineId })
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.vendorInvoiceId, id));
  const purchaseOrderLineIds = uniqueNumbers(
    invoiceLines.map((line) => line.purchaseOrderLineId),
  ).sort((left, right) => left - right);
  for (const purchaseOrderLineId of purchaseOrderLineIds) {
    await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(
      purchaseOrderLineId,
      client,
      actorId,
    );
  }
}

export type ApprovedInvoiceVarianceReconciliationResult = {
  purchaseOrderLineId: number;
  state:
    | "invoice_actual"
    | "po_fallback_no_approved_invoice"
    | "po_fallback_incomplete_invoice_quantity"
    | "not_applicable_non_product";
  authoritativeUnitCostMills: number | null;
  approvedInvoiceIds: number[];
  approvedQty: string;
  lotsUpdated: number;
  cogsRowsUpdated: number;
  totalCogsDeltaCents: number;
};

/**
 * Resolve the authoritative product cost for one PO line from all currently
 * approved/paid invoice lines. Complete approved coverage uses the
 * quantity-weighted invoice mills per base piece. Incomplete or absent coverage
 * deterministically falls back to the PO cost until the evidence is complete.
 */
export async function reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(
  purchaseOrderLineId: number,
  client: ApLedgerDbClient,
  actorId?: string,
): Promise<ApprovedInvoiceVarianceReconciliationResult> {
  const normalizedPoLineId = requireCommandId(purchaseOrderLineId, "purchaseOrderLineId");
  const [poLine] = await client
    .select({
      id: purchaseOrderLines.id,
      purchaseOrderId: purchaseOrderLines.purchaseOrderId,
      lineType: purchaseOrderLines.lineType,
      status: purchaseOrderLines.status,
      orderQty: purchaseOrderLines.orderQty,
      receivedQty: purchaseOrderLines.receivedQty,
      unitCostCents: purchaseOrderLines.unitCostCents,
      unitCostMills: purchaseOrderLines.unitCostMills,
    })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.id, normalizedPoLineId))
    .for("update");
  if (!poLine) {
    throw new ApLedgerError("Purchase order line not found", 404, {
      code: "AP_PURCHASE_ORDER_LINE_NOT_FOUND",
      purchaseOrderLineId: normalizedPoLineId,
    });
  }

  const orderQty = requireNonnegativeInteger(poLine.orderQty, "purchaseOrderLine.orderQty");
  const poUnitCostMills = requireNonnegativeInteger(
    poLine.unitCostMills ?? centsToMills(
      requireNonnegativeInteger(poLine.unitCostCents ?? 0, "purchaseOrderLine.unitCostCents"),
    ),
    "purchaseOrderLine.unitCostMills",
  );
  const candidateLines = await client
    .select({
      id: vendorInvoiceLines.id,
      vendorInvoiceId: vendorInvoiceLines.vendorInvoiceId,
      qtyInvoiced: vendorInvoiceLines.qtyInvoiced,
      unitCostCents: vendorInvoiceLines.unitCostCents,
      unitCostMills: vendorInvoiceLines.unitCostMills,
    })
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.purchaseOrderLineId, normalizedPoLineId))
    .orderBy(asc(vendorInvoiceLines.vendorInvoiceId), asc(vendorInvoiceLines.id))
    .for("share");
  const candidateInvoiceIds = uniqueNumbers(
    candidateLines.map((line) => line.vendorInvoiceId),
  );
  const invoiceRows = candidateInvoiceIds.length === 0
    ? []
    : await client
      .select({
        id: vendorInvoices.id,
        invoiceNumber: vendorInvoices.invoiceNumber,
        status: vendorInvoices.status,
      })
      .from(vendorInvoices)
      .where(inArray(vendorInvoices.id, candidateInvoiceIds));
  const approvedInvoiceRows = invoiceRows.filter((invoice) =>
    ["approved", "partially_paid", "paid"].includes(invoice.status),
  );
  const approvedInvoiceIds = approvedInvoiceRows
    .map((invoice) => invoice.id)
    .sort((left, right) => left - right);
  const approvedInvoiceIdSet = new Set(approvedInvoiceIds);
  const approvedLines = candidateLines.filter((line) =>
    approvedInvoiceIdSet.has(Number(line.vendorInvoiceId)),
  );
  const approvedQty = approvedLines.reduce(
    (total, line) => total + BigInt(requireNonnegativeInteger(
      line.qtyInvoiced,
      `vendorInvoiceLine[${line.id}].qtyInvoiced`,
    )),
    BigInt(0),
  );
  const approvedExtendedCostMills = approvedLines.reduce(
    (total, line) => {
      const qty = BigInt(requireNonnegativeInteger(
        line.qtyInvoiced,
        `vendorInvoiceLine[${line.id}].qtyInvoiced`,
      ));
      const unitCostMills = BigInt(requireNonnegativeInteger(
        line.unitCostMills ?? centsToMills(
          requireNonnegativeInteger(line.unitCostCents, `vendorInvoiceLine[${line.id}].unitCostCents`),
        ),
        `vendorInvoiceLine[${line.id}].unitCostMills`,
      ));
      return total + (qty * unitCostMills);
    },
    BigInt(0),
  );
  const receivedQty = requireNonnegativeInteger(
    poLine.receivedQty ?? 0,
    "purchaseOrderLine.receivedQty",
  );
  const costCoverageQty = ["received", "closed"].includes(poLine.status)
    ? receivedQty
    : orderQty;

  let state: ApprovedInvoiceVarianceReconciliationResult["state"];
  let authoritativeUnitCostMills: number;
  let costSource: "invoice" | "po";
  if (approvedLines.length === 0) {
    state = "po_fallback_no_approved_invoice";
    authoritativeUnitCostMills = poUnitCostMills;
    costSource = "po";
  } else if (approvedQty === BigInt(0) || approvedQty !== BigInt(costCoverageQty)) {
    state = "po_fallback_incomplete_invoice_quantity";
    authoritativeUnitCostMills = poUnitCostMills;
    costSource = "po";
  } else {
    state = "invoice_actual";
    const roundedWeightedMills = (
      (approvedExtendedCostMills * BigInt(2)) + approvedQty
    ) / (approvedQty * BigInt(2));
    authoritativeUnitCostMills = bigintMoneyToNumber(
      roundedWeightedMills,
      `purchaseOrderLine[${normalizedPoLineId}].approvedWeightedUnitCostMills`,
    );
    costSource = "invoice";
  }

  if (poLine.lineType !== "product") {
    await appendApMutationAudit(
      "po_line_cost_reconciliation_skipped",
      `purchase_order_line:${normalizedPoLineId}`,
      actorId,
      {
        purchaseOrderId: poLine.purchaseOrderId,
        purchaseOrderLineId: normalizedPoLineId,
        state: "not_applicable_non_product",
        approvedInvoiceIds,
        approvedQty: approvedQty.toString(),
        orderQty,
        receivedQty,
        costCoverageQty,
      },
      client,
    );
    return {
      purchaseOrderLineId: normalizedPoLineId,
      state: "not_applicable_non_product",
      authoritativeUnitCostMills: null,
      approvedInvoiceIds,
      approvedQty: approvedQty.toString(),
      lotsUpdated: 0,
      cogsRowsUpdated: 0,
      totalCogsDeltaCents: 0,
    };
  }

  const invoiceNumbers = approvedInvoiceRows.map((invoice) => invoice.invoiceNumber);
  const cogsResult = await new COGSService(client as any).reconcileInvoiceVariance({
    purchaseOrderId: poLine.purchaseOrderId,
    purchaseOrderLineId: normalizedPoLineId,
    invoiceUnitCostCents: millsToCents(authoritativeUnitCostMills),
    invoiceUnitCostMills: authoritativeUnitCostMills,
    invoiceNumber: invoiceNumbers.length > 0 ? invoiceNumbers.join(",") : undefined,
    costSource,
    reason: `po_line_cost_reconciliation:${state}`,
  }, client);
  await appendApMutationAudit(
    "po_line_cost_reconciled",
    `purchase_order_line:${normalizedPoLineId}`,
    actorId,
    {
      purchaseOrderId: poLine.purchaseOrderId,
      purchaseOrderLineId: normalizedPoLineId,
      state,
      authoritativeUnitCostMills,
      approvedInvoiceIds,
      approvedQty: approvedQty.toString(),
      approvedExtendedCostMills: approvedExtendedCostMills.toString(),
      orderQty,
      receivedQty,
      costCoverageQty,
      ...cogsResult,
    },
    client,
  );
  return {
    purchaseOrderLineId: normalizedPoLineId,
    state,
    authoritativeUnitCostMills,
    approvedInvoiceIds,
    approvedQty: approvedQty.toString(),
    ...cogsResult,
  };
}

export async function approveInvoice(id: number, userId?: string) {
  const mutation = await db.transaction((tx: ApLedgerDbClient) =>
    approveInvoiceInTransaction(tx, id, userId),
  );

  await runPoFinancialDetectionHooksForMany(mutation.affectedPoIds);

  return mutation.value;
}

async function disputeInvoiceInTransaction(
  tx: ApLedgerDbClient,
  id: number,
  reason: string,
  userId?: string,
): Promise<InvoiceMutationResult> {
  const [inv] = await tx
    .select()
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, id))
    .for("update");
  if (!inv) {
    throw new ApLedgerError("Invoice not found", 404, { code: "AP_INVOICE_NOT_FOUND" });
  }
  if (!["received", "approved", "partially_paid"].includes(inv.status)) {
    throw new ApLedgerError("Cannot dispute invoice in its current status", 409, {
      code: "AP_INVOICE_DISPUTE_STATUS_INVALID",
    });
  }

  const [invoice] = await tx
    .update(vendorInvoices)
    .set({ status: "disputed", disputeReason: reason, updatedBy: userId, updatedAt: new Date() })
    .where(eq(vendorInvoices.id, id))
    .returning();
  const affectedPoIds = await getPoIdsForInvoice(id, tx);
  await recomputePoFinancialAggregatesForMany(affectedPoIds, tx, {
    actorId: userId,
    reason: `Vendor invoice ${id} disputed.`,
  });
  await reconcileApprovedInvoiceVariance(id, tx, userId);
  return { value: invoice, affectedPoIds, changed: true };
}

export async function disputeInvoice(id: number, reason: string, userId?: string) {
  const mutation = await db.transaction((tx: ApLedgerDbClient) =>
    disputeInvoiceInTransaction(tx, id, reason, userId),
  );
  await runPoFinancialDetectionHooksForMany(mutation.affectedPoIds);
  return mutation.value;
}

async function voidInvoiceInTransaction(
  tx: ApLedgerDbClient,
  id: number,
  reason: string,
  userId?: string,
): Promise<InvoiceMutationResult> {
  const [inv] = await tx
    .select()
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, id))
    .for("update");
  if (!inv) {
    throw new ApLedgerError("Invoice not found", 404, { code: "AP_INVOICE_NOT_FOUND" });
  }
  if (inv.status === "voided") {
    throw new ApLedgerError("Invoice is already voided", 409, {
      code: "AP_INVOICE_ALREADY_VOIDED",
    });
  }
  if (inv.paidAmountCents > 0) {
    throw new ApLedgerError(
      "Cannot void an invoice with payments applied — void the payments first",
      409,
      { code: "AP_INVOICE_VOID_HAS_PAYMENTS" },
    );
  }

  const affectedPoIds = await getPoIdsForInvoice(id, tx);
  const [invoice] = await tx
    .update(vendorInvoices)
    .set({ status: "voided", internalNotes: `${inv.internalNotes ? inv.internalNotes + "\n" : ""}VOIDED: ${reason}`, updatedBy: userId, updatedAt: new Date() })
    .where(eq(vendorInvoices.id, id))
    .returning();
  await recomputePoFinancialAggregatesForMany(affectedPoIds, tx, {
    actorId: userId,
    reason: `Vendor invoice ${id} voided.`,
    resolveDispute: true,
  });
  await reconcileApprovedInvoiceVariance(id, tx, userId);
  return { value: invoice, affectedPoIds, changed: true };
}

export async function voidInvoice(id: number, reason: string, userId?: string) {
  const mutation = await db.transaction((tx: ApLedgerDbClient) =>
    voidInvoiceInTransaction(tx, id, reason, userId),
  );
  await runPoFinancialDetectionHooksForMany(mutation.affectedPoIds);
  return mutation.value;
}

// ─── PO Links ─────────────────────────────────────────────────────────────────

export async function linkPoToInvoice(
  invoiceId: number,
  purchaseOrderId: number,
  allocatedAmountCents?: number,
  notes?: string,
  actorId?: string,
) {
  const normalizedInvoiceId = requireCommandId(invoiceId, "invoiceId");
  const normalizedPoId = requireCommandId(purchaseOrderId, "purchaseOrderId");
  const normalizedAllocation = allocatedAmountCents === undefined
    ? undefined
    : requireNonnegativeInteger(allocatedAmountCents, "allocatedAmountCents");
  const normalizedNotes = normalizeOptionalText(notes, "notes", 10_000);

  const link = await db.transaction(async (tx: ApLedgerDbClient) => {
    const invoice = await lockEditableInvoice(tx, normalizedInvoiceId);
    await lockMatchingPurchaseOrder(tx, normalizedPoId, invoice.vendorId, invoice.currency);

    const [upserted] = await tx
      .insert(vendorInvoicePoLinks)
      .values({
        vendorInvoiceId: normalizedInvoiceId,
        purchaseOrderId: normalizedPoId,
        allocatedAmountCents: normalizedAllocation,
        notes: normalizedNotes,
      })
      .onConflictDoUpdate({
        target: [vendorInvoicePoLinks.vendorInvoiceId, vendorInvoicePoLinks.purchaseOrderId],
        set: { allocatedAmountCents: normalizedAllocation, notes: normalizedNotes },
      })
      .returning();

    const imported = await importLinesFromPOWithClient(normalizedInvoiceId, normalizedPoId, tx);
    await recalculateInvoiceFromLines(normalizedInvoiceId, tx);
    await recomputePoFinancialAggregates(normalizedPoId, {
      client: tx,
      runDetection: false,
      actorId,
      reason: `Vendor invoice ${normalizedInvoiceId} linked to PO ${normalizedPoId}.`,
    });
    await appendApMutationAudit(
      "invoice_po_linked",
      `invoice:${normalizedInvoiceId}`,
      actorId,
      {
        invoiceId: normalizedInvoiceId,
        purchaseOrderId: normalizedPoId,
        linkId: upserted.id,
        importedLineIds: imported.map((line) => line.id),
      },
      tx,
    );
    return upserted;
  });

  await runPoFinancialDetectionHooks(normalizedPoId);
  return link;
}

export async function unlinkPoFromInvoice(
  invoiceId: number,
  purchaseOrderId: number,
  actorId?: string,
) {
  const normalizedInvoiceId = requireCommandId(invoiceId, "invoiceId");
  const normalizedPoId = requireCommandId(purchaseOrderId, "purchaseOrderId");
  const changed = await db.transaction(async (tx: ApLedgerDbClient) => {
    const invoice = await lockEditableInvoice(tx, normalizedInvoiceId);
    await lockMatchingPurchaseOrder(tx, normalizedPoId, invoice.vendorId, invoice.currency);
    const [existingLink] = await tx
      .select({ id: vendorInvoicePoLinks.id })
      .from(vendorInvoicePoLinks)
      .where(and(
        eq(vendorInvoicePoLinks.vendorInvoiceId, normalizedInvoiceId),
        eq(vendorInvoicePoLinks.purchaseOrderId, normalizedPoId),
      ))
      .for("update");
    if (!existingLink) return false;

    await tx
      .delete(vendorInvoicePoLinks)
      .where(eq(vendorInvoicePoLinks.id, existingLink.id));

    const poLineIds = await tx
      .select({ id: purchaseOrderLines.id })
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, normalizedPoId));
    if (poLineIds.length > 0) {
      await tx
        .delete(vendorInvoiceLines)
        .where(and(
          eq(vendorInvoiceLines.vendorInvoiceId, normalizedInvoiceId),
          inArray(vendorInvoiceLines.purchaseOrderLineId, poLineIds.map((line) => line.id)),
        ));
    }

    await recalculateInvoiceFromLines(normalizedInvoiceId, tx);
    await recomputePoFinancialAggregates(normalizedPoId, {
      client: tx,
      runDetection: false,
      actorId,
      reason: `Vendor invoice ${normalizedInvoiceId} unlinked from PO ${normalizedPoId}.`,
    });
    await appendApMutationAudit(
      "invoice_po_unlinked",
      `invoice:${normalizedInvoiceId}`,
      actorId,
      {
        invoiceId: normalizedInvoiceId,
        purchaseOrderId: normalizedPoId,
        removedLinkId: existingLink.id,
      },
      tx,
    );
    return true;
  });

  if (changed) {
    await runPoFinancialDetectionHooks(normalizedPoId);
  }
  return { ok: true, changed };
}

export async function getInvoicesForPo(purchaseOrderId: number) {
  const links = await db
    .select({
      link: vendorInvoicePoLinks,
      invoice: vendorInvoices,
    })
    .from(vendorInvoicePoLinks)
    .innerJoin(vendorInvoices, eq(vendorInvoicePoLinks.vendorInvoiceId, vendorInvoices.id))
    .where(eq(vendorInvoicePoLinks.purchaseOrderId, purchaseOrderId))
    .orderBy(desc(vendorInvoices.invoiceDate));

  return links.map((r) => ({ ...r.invoice, allocatedAmountCents: r.link.allocatedAmountCents }));
}

/**
 * Phase 2: Return all ap_payments linked to a PO via the chain:
 *   vendor_invoice_po_links → vendor_invoices → ap_payment_allocations → ap_payments
 *
 * Columns: paymentDate, paymentMethod, appliedAmountCents, invoiceNumber, referenceNumber
 * Only non-voided payments are returned.
 */
export async function getPaymentsForPo(purchaseOrderId: number) {
  // Step 1: find all vendor invoice IDs linked to this PO
  const invoiceLinks = await db
    .select({ vendorInvoiceId: vendorInvoicePoLinks.vendorInvoiceId })
    .from(vendorInvoicePoLinks)
    .where(eq(vendorInvoicePoLinks.purchaseOrderId, purchaseOrderId));

  if (invoiceLinks.length === 0) return [];

  const invoiceIds = invoiceLinks.map((l) => l.vendorInvoiceId);

  // Step 2: fetch all non-voided payment allocations for those invoices
  const rows = await db
    .select({
      allocationId: apPaymentAllocations.id,
      apPaymentId: apPaymentAllocations.apPaymentId,
      appliedAmountCents: apPaymentAllocations.appliedAmountCents,
      vendorInvoiceId: apPaymentAllocations.vendorInvoiceId,
      invoiceNumber: vendorInvoices.invoiceNumber,
      paymentDate: apPayments.paymentDate,
      paymentMethod: apPayments.paymentMethod,
      paymentStatus: apPayments.status,
      referenceNumber: apPayments.referenceNumber,
      paymentNumber: apPayments.paymentNumber,
    })
    .from(apPaymentAllocations)
    .innerJoin(apPayments, eq(apPaymentAllocations.apPaymentId, apPayments.id))
    .innerJoin(vendorInvoices, eq(apPaymentAllocations.vendorInvoiceId, vendorInvoices.id))
    .where(
      and(
        inArray(apPaymentAllocations.vendorInvoiceId, invoiceIds),
        ne(apPayments.status, "voided"),
      ),
    )
    .orderBy(desc(apPayments.paymentDate));

  return rows;
}

// ─── Payments ─────────────────────────────────────────────────────────────────

type PaymentMutationResult<T> = {
  value: T;
  affectedPoIds: number[];
};

function validateRecordPaymentInput(data: RecordApPaymentInput): void {
  requireUsdFinancialDocumentCurrency(data.currency, "currency");
  if (!Number.isSafeInteger(data.vendorId) || data.vendorId <= 0) {
    throw new ApLedgerError("vendorId must be a positive integer", 400, {
      code: "AP_PAYMENT_VENDOR_INVALID",
    });
  }
  if (!(data.paymentDate instanceof Date) || !Number.isFinite(data.paymentDate.getTime())) {
    throw new ApLedgerError("paymentDate must be a valid date", 400, {
      code: "AP_PAYMENT_DATE_INVALID",
    });
  }
  if (!data.paymentMethod?.trim() || data.paymentMethod.length > 20) {
    throw new ApLedgerError("paymentMethod must be between 1 and 20 characters", 400, {
      code: "AP_PAYMENT_METHOD_INVALID",
    });
  }
  if (!Number.isSafeInteger(data.totalAmountCents) || data.totalAmountCents <= 0) {
    throw new ApLedgerError("totalAmountCents must be a positive integer", 400, {
      code: "AP_PAYMENT_TOTAL_INVALID",
    });
  }

  const seenInvoiceIds = new Set<number>();
  for (const allocation of data.allocations) {
    if (!Number.isSafeInteger(allocation.vendorInvoiceId) || allocation.vendorInvoiceId <= 0) {
      throw new ApLedgerError("Each allocation must reference a valid vendor invoice", 400, {
        code: "AP_PAYMENT_ALLOCATION_INVOICE_INVALID",
      });
    }
    if (!Number.isSafeInteger(allocation.appliedAmountCents) || allocation.appliedAmountCents <= 0) {
      throw new ApLedgerError("Each allocation amount must be a positive integer", 400, {
        code: "AP_PAYMENT_ALLOCATION_AMOUNT_INVALID",
      });
    }
    if (seenInvoiceIds.has(allocation.vendorInvoiceId)) {
      throw new ApLedgerError("A payment may allocate to each invoice only once", 422, {
        code: "AP_PAYMENT_ALLOCATION_DUPLICATE_INVOICE",
      });
    }
    seenInvoiceIds.add(allocation.vendorInvoiceId);
  }

  const allocTotal = data.allocations.reduce((sum, allocation) =>
    sum + allocation.appliedAmountCents, 0);
  if (!Number.isSafeInteger(allocTotal) || allocTotal > data.totalAmountCents) {
    throw new ApLedgerError(
      `Allocation total (${allocTotal}) exceeds payment total (${data.totalAmountCents})`,
      422,
      { code: "AP_PAYMENT_ALLOCATION_EXCEEDS_TOTAL" },
    );
  }
}

async function lockAndValidatePaymentInvoices(
  tx: ApLedgerDbClient,
  data: RecordApPaymentInput,
  paymentCurrency: string,
): Promise<void> {
  if (data.allocations.length === 0) return;
  const invoiceIds = data.allocations.map((allocation) => allocation.vendorInvoiceId);
  const invoices = await tx
    .select({
      id: vendorInvoices.id,
      vendorId: vendorInvoices.vendorId,
      currency: vendorInvoices.currency,
      status: vendorInvoices.status,
      balanceCents: vendorInvoices.balanceCents,
    })
    .from(vendorInvoices)
    .where(inArray(vendorInvoices.id, invoiceIds))
    .orderBy(asc(vendorInvoices.id))
    .for("update");

  const invoicesById = new Map(invoices.map((invoice: any) => [invoice.id, invoice]));
  for (const allocation of data.allocations) {
    const invoice: any = invoicesById.get(allocation.vendorInvoiceId);
    if (!invoice) {
      throw new ApLedgerError("A payment allocation references an invoice that does not exist", 422, {
        code: "AP_PAYMENT_ALLOCATION_INVOICE_NOT_FOUND",
      });
    }
    if (invoice.vendorId !== data.vendorId) {
      throw new ApLedgerError("Payment vendor must match every allocated invoice vendor", 422, {
        code: "AP_PAYMENT_ALLOCATION_VENDOR_MISMATCH",
      });
    }
    const invoiceCurrency = requireUsdFinancialDocumentCurrency(
      invoice.currency,
      `invoice[${invoice.id}].currency`,
    );
    if (invoiceCurrency !== paymentCurrency) {
      throw new ApLedgerError("Payment currency must match every allocated invoice", 422, {
        code: "AP_PAYMENT_ALLOCATION_CURRENCY_MISMATCH",
        paymentCurrency,
        invoiceCurrency,
        invoiceId: invoice.id,
      });
    }
    if (!["approved", "partially_paid"].includes(invoice.status)) {
      throw new ApLedgerError("Payments may only be allocated to approved open invoices", 409, {
        code: "AP_PAYMENT_ALLOCATION_INVOICE_NOT_PAYABLE",
      });
    }
    const balanceCents = databaseMoneyToBigInt(
      invoice.balanceCents,
      `invoice[${invoice.id}].balanceCents`,
    );
    if (BigInt(allocation.appliedAmountCents) > balanceCents) {
      throw new ApLedgerError("Payment allocation exceeds the invoice's open balance", 409, {
        code: "AP_PAYMENT_ALLOCATION_EXCEEDS_BALANCE",
      });
    }
  }
}

async function recordPaymentInTransaction(
  tx: ApLedgerDbClient,
  data: RecordApPaymentInput,
): Promise<PaymentMutationResult<any>> {
  validateRecordPaymentInput(data);
  const paymentCurrency = requireUsdFinancialDocumentCurrency(data.currency, "currency");
  await lockAndValidatePaymentInvoices(tx, data, paymentCurrency);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ap_payment_number'))`);
  const paymentNumber = await generatePaymentNumber(tx);
  const affectedPoIds = new Set<number>();

  try {
    const [inserted] = await tx
      .insert(apPayments)
      .values({
        paymentNumber,
        vendorId: data.vendorId,
        paymentDate: data.paymentDate,
        paymentMethod: data.paymentMethod,
        referenceNumber: data.referenceNumber,
        checkNumber: data.checkNumber,
        bankAccountLabel: data.bankAccountLabel,
        totalAmountCents: data.totalAmountCents,
        currency: paymentCurrency,
        status: data.status ?? "completed",
        notes: data.notes,
        createdBy: data.createdBy,
        updatedBy: data.createdBy,
      })
      .returning();

    if (data.allocations.length > 0) {
      await tx.insert(apPaymentAllocations).values(
        data.allocations.map((a) => ({
          apPaymentId: inserted.id,
          vendorInvoiceId: a.vendorInvoiceId,
          appliedAmountCents: a.appliedAmountCents,
          notes: a.notes,
        }))
      );

      for (const alloc of data.allocations) {
        await recalculateInvoiceBalance(alloc.vendorInvoiceId, tx);
        const poIds = await getPoIdsForInvoice(alloc.vendorInvoiceId, tx);
        for (const poId of poIds) affectedPoIds.add(poId);
      }

      await recomputePoFinancialAggregatesForMany(affectedPoIds, tx, {
        actorId: data.createdBy,
        reason: `AP payment ${inserted.id} recorded.`,
      });
    }

    return { value: inserted, affectedPoIds: [...affectedPoIds] };
  } catch (error: any) {
    if (error?.code === "23505") {
      if (error?.constraint === "ap_payment_allocations_pay_inv_idx") {
        throw new ApLedgerError(
          "A payment may allocate to each invoice only once.",
          422,
          { code: "AP_PAYMENT_ALLOCATION_DUPLICATE_INVOICE" },
        );
      }
      throw new ApLedgerError(
        `Payment number '${paymentNumber}' already in use by an active record.`,
        409,
      );
    }
    throw error;
  }
}

export async function recordPayment(data: RecordApPaymentInput) {
  validateRecordPaymentInput(data);
  const result = await db.transaction((tx: ApLedgerDbClient) =>
    recordPaymentInTransaction(tx, data),
  );

  await runPoFinancialDetectionHooksForMany(result.affectedPoIds);

  return result.value;
}

export async function getPaymentById(id: number) {
  const [payment] = await db
    .select({
      payment: apPayments,
      vendorName: vendors.name,
      vendorCode: vendors.code,
    })
    .from(apPayments)
    .leftJoin(vendors, eq(apPayments.vendorId, vendors.id))
    .where(eq(apPayments.id, id));

  if (!payment) return null;

  const allocations = await db
    .select({
      id: apPaymentAllocations.id,
      vendorInvoiceId: apPaymentAllocations.vendorInvoiceId,
      appliedAmountCents: apPaymentAllocations.appliedAmountCents,
      notes: apPaymentAllocations.notes,
      invoiceNumber: vendorInvoices.invoiceNumber,
      invoiceDate: vendorInvoices.invoiceDate,
      invoicedAmountCents: vendorInvoices.invoicedAmountCents,
      balanceCents: vendorInvoices.balanceCents,
    })
    .from(apPaymentAllocations)
    .innerJoin(vendorInvoices, eq(apPaymentAllocations.vendorInvoiceId, vendorInvoices.id))
    .where(eq(apPaymentAllocations.apPaymentId, id));

  return { ...payment.payment, vendorName: payment.vendorName, vendorCode: payment.vendorCode, allocations };
}

export async function listPayments(filters: {
  vendorId?: number;
  status?: string | string[];
  paymentMethod?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}) {
  const conditions = [];

  if (filters.vendorId) conditions.push(eq(apPayments.vendorId, filters.vendorId));
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    conditions.push(inArray(apPayments.status, statuses));
  }
  if (filters.paymentMethod) conditions.push(eq(apPayments.paymentMethod, filters.paymentMethod));
  if (filters.dateFrom) conditions.push(gte(apPayments.paymentDate, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(apPayments.paymentDate, filters.dateTo));

  return db
    .select({
      payment: apPayments,
      vendorName: vendors.name,
      vendorCode: vendors.code,
    })
    .from(apPayments)
    .leftJoin(vendors, eq(apPayments.vendorId, vendors.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(apPayments.paymentDate))
    .limit(filters.limit ?? 200)
    .offset(filters.offset ?? 0);
}

async function voidPaymentInTransaction(
  tx: ApLedgerDbClient,
  id: number,
  reason: string,
  userId?: string,
): Promise<PaymentMutationResult<{ ok: true }>> {
  const affectedPoIds = new Set<number>();
  const [payment] = await tx
    .select()
    .from(apPayments)
    .where(eq(apPayments.id, id))
    .for("update");
  if (!payment) throw new ApLedgerError("Payment not found", 404);
  if (payment.status === "voided") throw new ApLedgerError("Payment is already voided", 409);

  await tx
    .update(apPayments)
    .set({ status: "voided", voidedAt: new Date(), voidedBy: userId, voidReason: reason, updatedBy: userId, updatedAt: new Date() })
    .where(eq(apPayments.id, id));
  const affectedAllocs = await tx
    .select({ vendorInvoiceId: apPaymentAllocations.vendorInvoiceId })
    .from(apPaymentAllocations)
    .where(eq(apPaymentAllocations.apPaymentId, id))
    .orderBy(asc(apPaymentAllocations.vendorInvoiceId));

  for (const alloc of affectedAllocs) {
    await recalculateInvoiceBalance(alloc.vendorInvoiceId, tx);
    const poIds = await getPoIdsForInvoice(alloc.vendorInvoiceId, tx);
    for (const poId of poIds) affectedPoIds.add(poId);
  }
  await recomputePoFinancialAggregatesForMany(affectedPoIds, tx, {
    actorId: userId,
    reason: `AP payment ${id} voided.`,
  });

  return { value: { ok: true }, affectedPoIds: [...affectedPoIds] };
}

export async function voidPayment(id: number, reason: string, userId?: string) {
  const result = await db.transaction((tx: ApLedgerDbClient) =>
    voidPaymentInTransaction(tx, id, reason, userId),
  );

  await runPoFinancialDetectionHooksForMany(result.affectedPoIds);
}

// ─── AP Summary / Aging ───────────────────────────────────────────────────────

function requireCommandId(value: number | undefined, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ApLedgerError(`${field} must be a positive integer`, 400, {
      code: "AP_COMMAND_ID_INVALID",
    });
  }
  return value as number;
}

function requireCommandReason(reason: string | undefined): string {
  if (!reason?.trim()) {
    throw new ApLedgerError("reason is required");
  }
  return reason;
}

export type ApInvoiceFinancialCommand =
  | "approve_invoice"
  | "dispute_invoice"
  | "void_invoice";

export async function executeApInvoiceCommandInTransaction(
  command: ApInvoiceFinancialCommand,
  input: ApLedgerCommandInput,
  tx: ApLedgerDbClient,
) {
  const invoiceId = requireCommandId(input.invoiceId, "invoiceId");
  let mutation: InvoiceMutationResult;
  if (command === "approve_invoice") {
    mutation = await approveInvoiceInTransaction(tx, invoiceId, input.userId);
  } else if (command === "dispute_invoice") {
    mutation = await disputeInvoiceInTransaction(
      tx,
      invoiceId,
      requireCommandReason(input.reason),
      input.userId,
    );
  } else {
    mutation = await voidInvoiceInTransaction(
      tx,
      invoiceId,
      requireCommandReason(input.reason),
      input.userId,
    );
  }

  const affectedPurchaseOrderIds = mutation.affectedPoIds.length
    ? mutation.affectedPoIds
    : await getPoIdsForInvoice(invoiceId, tx);
  const outcome = buildApLedgerOutcome({
    command,
    entityType: "invoice",
    entityId: invoiceId,
    affectedInvoiceIds: [invoiceId],
    affectedPurchaseOrderIds,
  });
  await appendApLedgerCommandAudit(outcome, input.userId, tx);
  return attachApLedgerOutcome(mutation.value, outcome);
}

export async function runApInvoiceCommandPostCommit(
  outcome: ApLedgerCommandOutcome,
): Promise<void> {
  await runPoFinancialDetectionHooksForMany(outcome.affectedPurchaseOrderIds);
}

export type ApPaymentFinancialCommand = "record_payment" | "void_payment";

/**
 * Apply a cash-moving AP command using the caller's transaction. The payment,
 * allocations, invoice/PO balances, command audit, and durable HTTP result can
 * therefore commit or roll back as one unit under the financial command ledger.
 */
export async function executeApPaymentCommandInTransaction(
  command: ApPaymentFinancialCommand,
  input: ApLedgerCommandInput,
  tx: ApLedgerDbClient,
) {
  const actor = input.userId ?? input.payment?.createdBy;

  if (command === "record_payment") {
    if (!input.payment) throw new ApLedgerError("payment is required");
    const mutation = await recordPaymentInTransaction(tx, input.payment);
    const affectedInvoiceIds = uniqueNumbers(
      input.payment.allocations.map((allocation) => allocation.vendorInvoiceId),
    );
    const outcome = buildApLedgerOutcome({
      command,
      entityType: "payment",
      entityId: mutation.value.id,
      affectedInvoiceIds,
      affectedPaymentIds: [mutation.value.id],
      affectedPurchaseOrderIds: mutation.affectedPoIds,
    });
    await appendApLedgerCommandAudit(outcome, actor, tx);
    return attachApLedgerOutcome(mutation.value, outcome);
  }

  const paymentId = requireCommandId(input.paymentId, "paymentId");
  const affectedInvoiceIds = await getInvoiceIdsForPayment(paymentId, tx);
  const mutation = await voidPaymentInTransaction(
    tx,
    paymentId,
    requireCommandReason(input.reason),
    input.userId,
  );
  const outcome = buildApLedgerOutcome({
    command,
    entityType: "payment",
    entityId: paymentId,
    affectedInvoiceIds,
    affectedPaymentIds: [paymentId],
    affectedPurchaseOrderIds: mutation.affectedPoIds,
  });
  await appendApLedgerCommandAudit(outcome, actor, tx);
  return { ok: true, apLedgerOutcome: outcome };
}

export async function runApPaymentCommandPostCommit(
  outcome: ApLedgerCommandOutcome,
): Promise<void> {
  await runPoFinancialDetectionHooksForMany(outcome.affectedPurchaseOrderIds);
}

export async function getApSummary(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ApLedgerError("AP summary clock is invalid", 500, {
      code: "AP_SUMMARY_CLOCK_INVALID",
    });
  }
  const openStatuses = ["received", "approved", "partially_paid"];

  const allOpen = await db
    .select({
      id: vendorInvoices.id,
      vendorId: vendorInvoices.vendorId,
      vendorName: vendors.name,
      balanceCents: vendorInvoices.balanceCents,
      dueDate: vendorInvoices.dueDate,
      status: vendorInvoices.status,
    })
    .from(vendorInvoices)
    .leftJoin(vendors, eq(vendorInvoices.vendorId, vendors.id))
    .where(inArray(vendorInvoices.status, openStatuses));

  let totalOutstanding = BigInt(0);
  let overdue = BigInt(0);
  let dueSoon = BigInt(0);

  const agingBuckets = {
    current: BigInt(0),
    days1_30: BigInt(0),
    days31_60: BigInt(0),
    days61_90: BigInt(0),
    days90plus: BigInt(0),
  };
  const vendorAging: Record<number, {
    vendorName: string;
    current: bigint;
    days1_30: bigint;
    days31_60: bigint;
    days61_90: bigint;
    days90plus: bigint;
    total: bigint;
  }> = {};

  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  for (const [index, inv] of allOpen.entries()) {
    const balance = databaseMoneyToBigInt(
      inv.balanceCents,
      `openInvoices[${index}].balanceCents`,
    );
    totalOutstanding += balance;

    if (inv.dueDate && inv.dueDate < in7Days) dueSoon += balance;

    const daysPastDue = inv.dueDate ? Math.floor((now.getTime() - inv.dueDate.getTime()) / (1000 * 60 * 60 * 24)) : 0;

    let bucket: keyof typeof agingBuckets;
    if (daysPastDue <= 0) { bucket = "current"; }
    else if (daysPastDue <= 30) { bucket = "days1_30"; overdue += balance; }
    else if (daysPastDue <= 60) { bucket = "days31_60"; overdue += balance; }
    else if (daysPastDue <= 90) { bucket = "days61_90"; overdue += balance; }
    else { bucket = "days90plus"; overdue += balance; }

    agingBuckets[bucket] += balance;

    if (!vendorAging[inv.vendorId]) {
      vendorAging[inv.vendorId] = {
        vendorName: inv.vendorName ?? "",
        current: BigInt(0),
        days1_30: BigInt(0),
        days31_60: BigInt(0),
        days61_90: BigInt(0),
        days90plus: BigInt(0),
        total: BigInt(0),
      };
    }
    vendorAging[inv.vendorId][bucket] += balance;
    vendorAging[inv.vendorId].total += balance;
  }

  // Payment totals
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const [paidThisMonthResult, paidAllTimeResult] = await Promise.all([
    db.select({ total: sql<number>`COALESCE(SUM(${apPayments.totalAmountCents}), 0)` })
      .from(apPayments)
      .where(and(eq(apPayments.status, "completed"), gte(apPayments.paymentDate, startOfMonth))),
    db.select({ total: sql<number>`COALESCE(SUM(${apPayments.totalAmountCents}), 0)` })
      .from(apPayments)
      .where(eq(apPayments.status, "completed")),
  ]);

  const paidThisMonthCents = bigintMoneyToNumber(
    databaseMoneyToBigInt(paidThisMonthResult[0]?.total ?? 0, "paidThisMonthCents"),
    "paidThisMonthCents",
  );
  const paidAllTimeCents = bigintMoneyToNumber(
    databaseMoneyToBigInt(paidAllTimeResult[0]?.total ?? 0, "paidAllTimeCents"),
    "paidAllTimeCents",
  );

  // Recent payments (last 10)
  const recentPayments = await db
    .select({
      id: apPayments.id,
      paymentNumber: apPayments.paymentNumber,
      vendorName: vendors.name,
      paymentDate: apPayments.paymentDate,
      paymentMethod: apPayments.paymentMethod,
      totalAmountCents: apPayments.totalAmountCents,
      status: apPayments.status,
    })
    .from(apPayments)
    .leftJoin(vendors, eq(apPayments.vendorId, vendors.id))
    .orderBy(desc(apPayments.paymentDate), desc(apPayments.createdAt))
    .limit(10);

  // Open invoice count
  const openInvoiceCount = allOpen.length;

  // Recently paid invoices (last 10)
  const recentlyPaid = await db
    .select({
      id: vendorInvoices.id,
      invoiceNumber: vendorInvoices.invoiceNumber,
      vendorName: vendors.name,
      invoicedAmountCents: vendorInvoices.invoicedAmountCents,
      paidAmountCents: vendorInvoices.paidAmountCents,
      updatedAt: vendorInvoices.updatedAt,
    })
    .from(vendorInvoices)
    .leftJoin(vendors, eq(vendorInvoices.vendorId, vendors.id))
    .where(eq(vendorInvoices.status, "paid"))
    .orderBy(desc(vendorInvoices.updatedAt))
    .limit(10);

  return {
    totalOutstandingCents: bigintMoneyToNumber(totalOutstanding, "totalOutstandingCents"),
    overdueCents: bigintMoneyToNumber(overdue, "overdueCents"),
    dueSoonCents: bigintMoneyToNumber(dueSoon, "dueSoonCents"),
    paidThisMonthCents,
    paidAllTimeCents,
    agingBuckets: Object.fromEntries(
      Object.entries(agingBuckets).map(([bucket, value]) => [
        bucket,
        bigintMoneyToNumber(value, `agingBuckets.${bucket}`),
      ]),
    ),
    openInvoiceCount,
    vendorAging: Object.entries(vendorAging).map(([vendorId, data]) => ({
      vendorId: Number(vendorId),
      vendorName: data.vendorName,
      current: bigintMoneyToNumber(data.current, `vendorAging[${vendorId}].current`),
      days1_30: bigintMoneyToNumber(data.days1_30, `vendorAging[${vendorId}].days1_30`),
      days31_60: bigintMoneyToNumber(data.days31_60, `vendorAging[${vendorId}].days31_60`),
      days61_90: bigintMoneyToNumber(data.days61_90, `vendorAging[${vendorId}].days61_90`),
      days90plus: bigintMoneyToNumber(data.days90plus, `vendorAging[${vendorId}].days90plus`),
      total: bigintMoneyToNumber(data.total, `vendorAging[${vendorId}].total`),
    })),
    recentPayments,
    recentlyPaid,
  };
}

export async function listApLedgerCommandAudit(limit = 12) {
  const safeLimit = Math.min(Math.max(Number(limit) || 12, 1), 50);
  const rows = await db
    .select({
      id: auditEvents.id,
      timestamp: auditEvents.timestamp,
      actor: auditEvents.actor,
      action: auditEvents.action,
      target: auditEvents.target,
      context: auditEvents.context,
    })
    .from(auditEvents)
    .where(like(auditEvents.action, "ap_ledger.%"))
    .orderBy(desc(auditEvents.timestamp))
    .limit(safeLimit);

  return rows.map((row) => {
    const context = (row.context ?? {}) as Partial<ApLedgerCommandOutcome>;
    return {
      id: row.id,
      timestamp: row.timestamp,
      actor: row.actor,
      action: row.action,
      target: row.target,
      command: context.command ?? row.action.replace(/^ap_ledger\./, ""),
      entityType: context.entityType,
      entityId: context.entityId,
      affectedInvoiceIds: context.affectedInvoiceIds ?? [],
      affectedPaymentIds: context.affectedPaymentIds ?? [],
      affectedPurchaseOrderIds: context.affectedPurchaseOrderIds ?? [],
      message: context.message ?? row.action,
    };
  });
}

// ─── Invoice Lines ────────────────────────────────────────────────────────────

async function importLinesFromPOWithClient(
  invoiceId: number,
  purchaseOrderId: number,
  client: ApLedgerDbClient,
) {
  const poLines = await client
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(purchaseOrderLines.lineNumber));

  if (poLines.length === 0) return [];

  const poLineIds = poLines.map((line) => line.id);
  const existingImportedLines = await client
    .select({ purchaseOrderLineId: vendorInvoiceLines.purchaseOrderLineId })
    .from(vendorInvoiceLines)
    .where(
      and(
        eq(vendorInvoiceLines.vendorInvoiceId, invoiceId),
        inArray(vendorInvoiceLines.purchaseOrderLineId, poLineIds),
      ),
    );
  const importedPoLineIds = new Set(
    existingImportedLines
      .map((line) => line.purchaseOrderLineId)
      .filter((id): id is number => typeof id === "number"),
  );

  // Get current max line number on this invoice
  const existing = await client
    .select({ maxLine: sql<number>`COALESCE(MAX(${vendorInvoiceLines.lineNumber}), 0)` })
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId));
  let lineNum = Number(existing[0]?.maxLine ?? 0);

  const newLines = [];
  for (const pol of poLines) {
    if (pol.status === "cancelled") continue;
    if (importedPoLineIds.has(pol.id)) continue;
    lineNum++;
    const unitCostMills = Number(
      pol.unitCostMills ?? centsToMills(Number(pol.unitCostCents ?? 0)),
    );
    const unitCostCents = millsToCents(unitCostMills);
    const qty = pol.orderQty;
    // Use the actual PO line total — it includes discounts + tax, no recomputation
    const lineTotal = pol.lineTotalCents != null
      ? Number(pol.lineTotalCents)
      : computeLineTotalCentsFromMills(unitCostMills, qty); // Fallback only if PO line has no total
    const [line] = await client
      .insert(vendorInvoiceLines)
      .values({
        vendorInvoiceId: invoiceId,
        purchaseOrderLineId: pol.id,
        productVariantId: resolvePoLineReceiveVariantId(pol),
        lineNumber: lineNum,
        sku: pol.sku,
        productName: pol.productName,
        description: pol.description,
        qtyInvoiced: qty,
        qtyOrdered: qty,
        qtyReceived: pol.receivedQty ?? 0,
        unitCostCents,
        unitCostMills,
        lineTotalCents: lineTotal,
        matchStatus: "pending",
      })
      .returning();
    newLines.push(line);
  }

  return newLines;
}

export async function importLinesFromPO(
  invoiceId: number,
  purchaseOrderId: number,
  actorId?: string,
) {
  const normalizedInvoiceId = requireCommandId(invoiceId, "invoiceId");
  const normalizedPoId = requireCommandId(purchaseOrderId, "purchaseOrderId");
  const lines = await db.transaction(async (tx: ApLedgerDbClient) => {
    const invoice = await lockEditableInvoice(tx, normalizedInvoiceId);
    await lockMatchingPurchaseOrder(tx, normalizedPoId, invoice.vendorId, invoice.currency);

    const [link] = await tx
      .select({ id: vendorInvoicePoLinks.id })
      .from(vendorInvoicePoLinks)
      .where(and(
        eq(vendorInvoicePoLinks.vendorInvoiceId, normalizedInvoiceId),
        eq(vendorInvoicePoLinks.purchaseOrderId, normalizedPoId),
      ))
      .for("update");
    if (!link) {
      throw new ApLedgerError("Purchase order must be linked before importing lines", 409, {
        code: "AP_INVOICE_PO_LINK_REQUIRED",
        invoiceId: normalizedInvoiceId,
        purchaseOrderId: normalizedPoId,
      });
    }

    const imported = await importLinesFromPOWithClient(normalizedInvoiceId, normalizedPoId, tx);
    await recalculateInvoiceFromLines(normalizedInvoiceId, tx);
    await recomputePoFinancialAggregates(normalizedPoId, {
      client: tx,
      runDetection: false,
      actorId,
      reason: `Invoice ${normalizedInvoiceId} lines imported from PO ${normalizedPoId}.`,
    });
    await appendApMutationAudit(
      "invoice_lines_imported",
      `invoice:${normalizedInvoiceId}`,
      actorId,
      {
        invoiceId: normalizedInvoiceId,
        purchaseOrderId: normalizedPoId,
        importedLineIds: imported.map((line) => line.id),
      },
      tx,
    );
    return imported;
  });

  await runPoFinancialDetectionHooks(normalizedPoId);
  return lines;
}

export async function addInvoiceLine(invoiceId: number, data: {
  purchaseOrderLineId?: number;
  productVariantId?: number;
  sku?: string;
  productName?: string;
  description?: string;
  qtyInvoiced: number;
  unitCostCents?: number;
  unitCostMills?: number;
  notes?: string;
}, actorId?: string) {
  rejectUnexpectedFields(data as Record<string, unknown>, new Set([
    "purchaseOrderLineId",
    "productVariantId",
    "sku",
    "productName",
    "description",
    "qtyInvoiced",
    "unitCostCents",
    "unitCostMills",
    "notes",
  ]), "invoice line create");
  const normalizedInvoiceId = requireCommandId(invoiceId, "invoiceId");
  const purchaseOrderLineId = data.purchaseOrderLineId === undefined
    ? undefined
    : requirePositiveInteger(data.purchaseOrderLineId, "purchaseOrderLineId");
  const productVariantId = data.productVariantId === undefined
    ? undefined
    : requirePositiveInteger(data.productVariantId, "productVariantId");
  const qtyInvoiced = requirePositiveInteger(data.qtyInvoiced, "qtyInvoiced");
  const { unitCostCents, unitCostMills } = normalizeUnitCost(data);
  const lineTotalCents = computeLineTotalCentsFromMills(unitCostMills, qtyInvoiced);
  const sku = normalizeOptionalText(data.sku, "sku", 100);
  const productName = normalizeOptionalText(data.productName, "productName", 10_000);
  const description = normalizeOptionalText(data.description, "description", 10_000);
  const notes = normalizeOptionalText(data.notes, "notes", 10_000);

  const result = await db.transaction(async (tx: ApLedgerDbClient) => {
    await lockEditableInvoice(tx, normalizedInvoiceId);
    if (purchaseOrderLineId !== undefined) {
      await requireLinkedPoLine(tx, normalizedInvoiceId, purchaseOrderLineId);
    }
    const existing = await tx
      .select({ maxLine: sql<number>`COALESCE(MAX(${vendorInvoiceLines.lineNumber}), 0)` })
      .from(vendorInvoiceLines)
      .where(eq(vendorInvoiceLines.vendorInvoiceId, normalizedInvoiceId));
    const lineNumber = Number(existing[0]?.maxLine ?? 0) + 1;
    const [line] = await tx
      .insert(vendorInvoiceLines)
      .values({
        vendorInvoiceId: normalizedInvoiceId,
        purchaseOrderLineId,
        productVariantId,
        lineNumber,
        sku,
        productName,
        description,
        qtyInvoiced,
        unitCostCents,
        unitCostMills,
        lineTotalCents,
        matchStatus: "pending",
        notes,
      })
      .returning();

    await recalculateInvoiceFromLines(normalizedInvoiceId, tx);
    const affectedPoIds = await recomputeLinkedPurchaseOrders(normalizedInvoiceId, tx, {
      actorId,
      reason: `Invoice line ${line.id} added to invoice ${normalizedInvoiceId}.`,
    });
    await appendApMutationAudit(
      "invoice_line_added",
      `invoice:${normalizedInvoiceId}`,
      actorId,
      { invoiceId: normalizedInvoiceId, invoiceLineId: line.id, affectedPoIds },
      tx,
    );
    return { line, affectedPoIds };
  });

  await runPoFinancialDetectionHooksForMany(result.affectedPoIds);
  return result.line;
}

export async function updateInvoiceLine(lineId: number, data: {
  qtyInvoiced?: number;
  unitCostCents?: number;
  unitCostMills?: number;
  description?: string;
  notes?: string;
}, actorId?: string) {
  rejectUnexpectedFields(data as Record<string, unknown>, new Set([
    "qtyInvoiced",
    "unitCostCents",
    "unitCostMills",
    "description",
    "notes",
  ]), "invoice line update");
  const providedFields = Object.keys(data).filter(
    (field) => (data as Record<string, unknown>)[field] !== undefined,
  );
  if (providedFields.length === 0) {
    throw new ApLedgerError("Invoice line update requires at least one field", 400, {
      code: "AP_INVOICE_LINE_UPDATE_EMPTY",
    });
  }
  const normalizedLineId = requireCommandId(lineId, "lineId");
  const result = await db.transaction(async (tx: ApLedgerDbClient) => {
    const [lineReference] = await tx
      .select({
        vendorInvoiceId: vendorInvoiceLines.vendorInvoiceId,
        purchaseOrderLineId: vendorInvoiceLines.purchaseOrderLineId,
      })
      .from(vendorInvoiceLines)
      .where(eq(vendorInvoiceLines.id, normalizedLineId));
    if (!lineReference) {
      throw new ApLedgerError("Invoice line not found", 404, {
        code: "AP_INVOICE_LINE_NOT_FOUND",
        lineId: normalizedLineId,
      });
    }

    await lockEditableInvoice(tx, lineReference.vendorInvoiceId);
    if (lineReference.purchaseOrderLineId != null) {
      await requireLinkedPoLine(
        tx,
        lineReference.vendorInvoiceId,
        lineReference.purchaseOrderLineId,
      );
    }
    const [existing] = await tx
      .select()
      .from(vendorInvoiceLines)
      .where(eq(vendorInvoiceLines.id, normalizedLineId))
      .for("update");
    if (!existing) {
      throw new ApLedgerError("Invoice line not found", 404, {
        code: "AP_INVOICE_LINE_NOT_FOUND",
        lineId: normalizedLineId,
      });
    }

    const qtyInvoiced = data.qtyInvoiced === undefined
      ? existing.qtyInvoiced
      : requirePositiveInteger(data.qtyInvoiced, "qtyInvoiced");
    const normalizedCost = data.unitCostCents === undefined && data.unitCostMills === undefined
      ? normalizeUnitCost({
        unitCostCents: existing.unitCostCents,
        unitCostMills: existing.unitCostMills ?? undefined,
      })
      : normalizeUnitCost({
        unitCostCents: data.unitCostCents,
        unitCostMills: data.unitCostMills,
      });
    const updates: Record<string, unknown> = {
      qtyInvoiced,
      unitCostCents: normalizedCost.unitCostCents,
      unitCostMills: normalizedCost.unitCostMills,
      lineTotalCents: computeLineTotalCentsFromMills(normalizedCost.unitCostMills, qtyInvoiced),
      matchStatus: "pending",
      updatedAt: new Date(),
    };
    if (data.description !== undefined) {
      updates.description = normalizeOptionalText(data.description, "description", 10_000) ?? null;
    }
    if (data.notes !== undefined) {
      updates.notes = normalizeOptionalText(data.notes, "notes", 10_000) ?? null;
    }

    const [updated] = await tx
      .update(vendorInvoiceLines)
      .set(updates)
      .where(eq(vendorInvoiceLines.id, normalizedLineId))
      .returning();
    await recalculateInvoiceFromLines(existing.vendorInvoiceId, tx);
    const affectedPoIds = await recomputeLinkedPurchaseOrders(existing.vendorInvoiceId, tx, {
      actorId,
      reason: `Invoice line ${normalizedLineId} updated.`,
    });
    await appendApMutationAudit(
      "invoice_line_updated",
      `invoice:${existing.vendorInvoiceId}`,
      actorId,
      { invoiceId: existing.vendorInvoiceId, invoiceLineId: normalizedLineId, affectedPoIds },
      tx,
    );
    return { updated, affectedPoIds };
  });

  await runPoFinancialDetectionHooksForMany(result.affectedPoIds);
  return result.updated;
}

export async function removeInvoiceLine(lineId: number, actorId?: string) {
  const normalizedLineId = requireCommandId(lineId, "lineId");
  const affectedPoIds = await db.transaction(async (tx: ApLedgerDbClient) => {
    const [lineReference] = await tx
      .select({
        vendorInvoiceId: vendorInvoiceLines.vendorInvoiceId,
        purchaseOrderLineId: vendorInvoiceLines.purchaseOrderLineId,
      })
      .from(vendorInvoiceLines)
      .where(eq(vendorInvoiceLines.id, normalizedLineId));
    if (!lineReference) {
      throw new ApLedgerError("Invoice line not found", 404, {
        code: "AP_INVOICE_LINE_NOT_FOUND",
        lineId: normalizedLineId,
      });
    }

    await lockEditableInvoice(tx, lineReference.vendorInvoiceId);
    if (lineReference.purchaseOrderLineId != null) {
      await requireLinkedPoLine(
        tx,
        lineReference.vendorInvoiceId,
        lineReference.purchaseOrderLineId,
      );
    }
    const [existing] = await tx
      .select({ id: vendorInvoiceLines.id })
      .from(vendorInvoiceLines)
      .where(eq(vendorInvoiceLines.id, normalizedLineId))
      .for("update");
    if (!existing) {
      throw new ApLedgerError("Invoice line not found", 404, {
        code: "AP_INVOICE_LINE_NOT_FOUND",
        lineId: normalizedLineId,
      });
    }

    await tx.delete(vendorInvoiceLines).where(eq(vendorInvoiceLines.id, normalizedLineId));
    await recalculateInvoiceFromLines(lineReference.vendorInvoiceId, tx);
    const poIds = await recomputeLinkedPurchaseOrders(lineReference.vendorInvoiceId, tx, {
      actorId,
      reason: `Invoice line ${normalizedLineId} removed.`,
    });
    await appendApMutationAudit(
      "invoice_line_removed",
      `invoice:${lineReference.vendorInvoiceId}`,
      actorId,
      { invoiceId: lineReference.vendorInvoiceId, invoiceLineId: normalizedLineId, affectedPoIds: poIds },
      tx,
    );
    return poIds;
  });

  await runPoFinancialDetectionHooksForMany(affectedPoIds);
}

export async function getInvoiceLines(invoiceId: number) {
  return db
    .select()
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId))
    .orderBy(asc(vendorInvoiceLines.lineNumber));
}

async function recalculateInvoiceFromLines(
  invoiceId: number,
  client: ApLedgerDbClient = db,
) {
  const result = await client
    .select({ total: sql<number>`COALESCE(SUM(${vendorInvoiceLines.lineTotalCents}), 0)` })
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId));

  const linesTotalCents = bigintMoneyToNumber(
    databaseMoneyToBigInt(result[0]?.total ?? 0, `invoice[${invoiceId}].lineTotalCents`),
    `invoice[${invoiceId}].lineTotalCents`,
  );

  const [inv] = await client.select().from(vendorInvoices).where(eq(vendorInvoices.id, invoiceId));
  if (!inv) return;

  const paidAmountCents = requireNonnegativeInteger(
    inv.paidAmountCents,
    `invoice[${invoiceId}].paidAmountCents`,
  );
  const balance = linesTotalCents - paidAmountCents;

  await client
    .update(vendorInvoices)
    .set({
      invoicedAmountCents: linesTotalCents,
      balanceCents: Math.max(0, balance),
      updatedAt: new Date(),
    })
    .where(eq(vendorInvoices.id, invoiceId));
}

// ─── 3-Way Match ──────────────────────────────────────────────────────────────

type PersistedInvoiceMatchResult = ReturnType<typeof evaluatePurchaseOrderInvoiceMatches>[number];

async function persistInvoiceMatchResults(
  client: ApLedgerDbClient,
  results: PersistedInvoiceMatchResult[],
  actorId?: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  const evaluatedAt = new Date();
  for (const result of results) {
    await client
      .update(vendorInvoiceLines)
      .set({
        qtyReceived: result.qtyReceived,
        matchStatus: result.matchStatus,
        updatedAt: evaluatedAt,
      })
      .where(eq(vendorInvoiceLines.id, result.id));
  }

  const resultsByInvoiceId = new Map<number, PersistedInvoiceMatchResult[]>();
  for (const result of results) {
    const invoiceResults = resultsByInvoiceId.get(result.vendorInvoiceId) ?? [];
    invoiceResults.push(result);
    resultsByInvoiceId.set(result.vendorInvoiceId, invoiceResults);
  }
  for (const invoiceId of [...resultsByInvoiceId.keys()].sort((left, right) => left - right)) {
    const invoiceResults = resultsByInvoiceId.get(invoiceId) ?? [];
    await appendApMutationAudit(
      "invoice_match_run",
      `invoice:${invoiceId}`,
      actorId,
      {
        invoiceId,
        lineCount: invoiceResults.length,
        mismatchLineIds: invoiceResults
          .filter((line) => line.matchStatus !== "matched" && line.matchStatus !== "pending")
          .map((line) => line.id),
        ...context,
      },
      client,
    );
  }
}

export type PurchaseOrderInvoiceMatchTransactionResult = {
  purchaseOrderId: number;
  purchaseOrderLineIds: number[];
  activeInvoiceIds: number[];
  invoiceNumbersById: Map<number, string>;
  sourceFingerprint: string;
  results: PersistedInvoiceMatchResult[];
  invoicesWithoutMappedLines: number[];
};

/**
 * Recompute every non-voided invoice line linked to one PO. The caller must
 * already hold the purchase-order header lock. PO-line locks serialize the
 * derived match write with receiving and invoice-line insertion.
 */
export async function recomputePurchaseOrderInvoiceMatchesInTransaction(
  purchaseOrderId: number,
  client: ApLedgerDbClient,
  actorId?: string,
): Promise<PurchaseOrderInvoiceMatchTransactionResult> {
  const normalizedPoId = requireCommandId(purchaseOrderId, "purchaseOrderId");
  const poLines = await client
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, normalizedPoId))
    .orderBy(asc(purchaseOrderLines.id))
    .for("update");
  const links = await client
    .select({ vendorInvoiceId: vendorInvoicePoLinks.vendorInvoiceId })
    .from(vendorInvoicePoLinks)
    .where(eq(vendorInvoicePoLinks.purchaseOrderId, normalizedPoId))
    .orderBy(asc(vendorInvoicePoLinks.vendorInvoiceId));
  const linkedInvoiceIds = uniqueNumbers(
    links.map((link: { vendorInvoiceId: number }) => link.vendorInvoiceId),
  ).sort((left, right) => left - right);

  if (linkedInvoiceIds.length === 0) {
    return {
      purchaseOrderId: normalizedPoId,
      purchaseOrderLineIds: poLines.map((line) => Number(line.id)),
      activeInvoiceIds: [],
      invoiceNumbersById: new Map(),
      sourceFingerprint: computePurchaseOrderInvoiceMatchSourceFingerprint({
        purchaseOrderId: normalizedPoId,
        purchaseOrderLines: poLines,
        activeInvoices: [],
        invoiceLines: [],
      }),
      results: [],
      invoicesWithoutMappedLines: [],
    };
  }

  const invoiceRows = await client
    .select({
      id: vendorInvoices.id,
      invoiceNumber: vendorInvoices.invoiceNumber,
      status: vendorInvoices.status,
    })
    .from(vendorInvoices)
    .where(inArray(vendorInvoices.id, linkedInvoiceIds));
  const activeInvoices = invoiceRows
    .filter((invoice) => invoice.status !== "voided")
    .sort((left, right) => left.id - right.id);
  const activeInvoiceIds = activeInvoices.map((invoice) => invoice.id);
  const invoiceNumbersById = new Map(
    activeInvoices.map((invoice) => [invoice.id, invoice.invoiceNumber]),
  );
  if (activeInvoiceIds.length === 0) {
    return {
      purchaseOrderId: normalizedPoId,
      purchaseOrderLineIds: poLines.map((line) => Number(line.id)),
      activeInvoiceIds,
      invoiceNumbersById,
      sourceFingerprint: computePurchaseOrderInvoiceMatchSourceFingerprint({
        purchaseOrderId: normalizedPoId,
        purchaseOrderLines: poLines,
        activeInvoices,
        invoiceLines: [],
      }),
      results: [],
      invoicesWithoutMappedLines: [],
    };
  }

  const allLinkedInvoiceLines = await client
    .select()
    .from(vendorInvoiceLines)
    .where(inArray(vendorInvoiceLines.vendorInvoiceId, activeInvoiceIds))
    .orderBy(asc(vendorInvoiceLines.vendorInvoiceId), asc(vendorInvoiceLines.id))
    .for("update");
  const poLineIds = new Set(poLines.map((line) => Number(line.id)));
  const scopedInvoiceLines = allLinkedInvoiceLines.filter((line) =>
    line.purchaseOrderLineId == null || poLineIds.has(Number(line.purchaseOrderLineId)),
  );
  const mappedInvoiceIds = new Set(scopedInvoiceLines.map((line) => Number(line.vendorInvoiceId)));
  const invoicesWithoutMappedLines = activeInvoiceIds.filter((id) => !mappedInvoiceIds.has(id));
  const results = evaluatePurchaseOrderInvoiceMatches({
    purchaseOrderLines: poLines,
    invoiceLines: scopedInvoiceLines,
  });
  const sourceFingerprint = computePurchaseOrderInvoiceMatchSourceFingerprint({
    purchaseOrderId: normalizedPoId,
    purchaseOrderLines: poLines,
    activeInvoices,
    invoiceLines: scopedInvoiceLines,
  });
  await persistInvoiceMatchResults(client, results, actorId, {
    purchaseOrderId: normalizedPoId,
    sourceFingerprint,
    source: "purchase_order",
  });

  return {
    purchaseOrderId: normalizedPoId,
    purchaseOrderLineIds: poLines.map((line) => Number(line.id)),
    activeInvoiceIds,
    invoiceNumbersById,
    sourceFingerprint,
    results,
    invoicesWithoutMappedLines,
  };
}

export async function runInvoiceMatch(invoiceId: number, actorId?: string) {
  const normalizedInvoiceId = requireCommandId(invoiceId, "invoiceId");
  const updatedLines = await db.transaction(async (tx: ApLedgerDbClient) => {
    await lockInvoiceForMatch(tx, normalizedInvoiceId);
    const initialLines = await tx
      .select()
      .from(vendorInvoiceLines)
      .where(eq(vendorInvoiceLines.vendorInvoiceId, normalizedInvoiceId))
      .orderBy(asc(vendorInvoiceLines.lineNumber));
    const purchaseOrderLineIds = uniqueNumbers(
      initialLines.map((line) => line.purchaseOrderLineId),
    ).sort((left, right) => left - right);

    if (purchaseOrderLineIds.length === 0) {
      const lockedLines = await tx
        .select()
        .from(vendorInvoiceLines)
        .where(eq(vendorInvoiceLines.vendorInvoiceId, normalizedInvoiceId))
        .orderBy(asc(vendorInvoiceLines.lineNumber))
        .for("update");
      const results = evaluatePurchaseOrderInvoiceMatches({
        purchaseOrderLines: [],
        invoiceLines: lockedLines,
      });
      await persistInvoiceMatchResults(tx, results, actorId, { source: "invoice" });
      const resultsById = new Map(results.map((result) => [result.id, result]));
      return lockedLines.map((line) => ({ ...line, ...resultsById.get(line.id) }));
    }

    const poLines = await tx
      .select()
      .from(purchaseOrderLines)
      .where(inArray(purchaseOrderLines.id, purchaseOrderLineIds))
      .orderBy(asc(purchaseOrderLines.id))
      .for("update");
    const contributorLines = await tx
      .select()
      .from(vendorInvoiceLines)
      .where(inArray(vendorInvoiceLines.purchaseOrderLineId, purchaseOrderLineIds))
      .orderBy(asc(vendorInvoiceLines.vendorInvoiceId), asc(vendorInvoiceLines.id))
      .for("update");
    const contributorInvoiceIds = uniqueNumbers(
      contributorLines.map((line) => line.vendorInvoiceId),
    );
    const contributorInvoices = contributorInvoiceIds.length === 0
      ? []
      : await tx
        .select({ id: vendorInvoices.id, status: vendorInvoices.status })
        .from(vendorInvoices)
        .where(inArray(vendorInvoices.id, contributorInvoiceIds));
    const activeInvoiceIds = new Set(
      contributorInvoices
        .filter((invoice) => invoice.status !== "voided")
        .map((invoice) => invoice.id),
    );
    const activeContributorLines = contributorLines.filter((line) =>
      activeInvoiceIds.has(Number(line.vendorInvoiceId)),
    );
    const standaloneTargetLines = initialLines.filter((line) => line.purchaseOrderLineId == null);
    const results = evaluatePurchaseOrderInvoiceMatches({
      purchaseOrderLines: poLines,
      invoiceLines: [...activeContributorLines, ...standaloneTargetLines],
    });
    await persistInvoiceMatchResults(tx, results, actorId, {
      requestedInvoiceId: normalizedInvoiceId,
      source: "invoice",
    });
    const resultsById = new Map(results.map((result) => [result.id, result]));
    return initialLines.map((line) => ({ ...line, ...resultsById.get(line.id) }));
  });

  // ── Exception detection hook: match_mismatch ──────────────────────
  // Detect after all line match statuses have been written.
  // Non-blocking: detection failures should not roll back the match run.
  try {
    const hasMismatch = updatedLines.some(
      (l) => l.matchStatus !== "matched" && l.matchStatus !== "pending",
    );
    if (hasMismatch) {
      await detectMatchMismatch(normalizedInvoiceId);
    }
  } catch (detectionErr) {
    console.error("[po-exceptions] detection hook failed in runInvoiceMatch:", detectionErr);
  }

  return updatedLines;
}

// ─── Attachments ──────────────────────────────────────────────────────────────

export async function addAttachment(invoiceId: number, data: {
  fileName: string;
  fileType?: string;
  fileSizeBytes?: number;
  filePath: string;
  uploadedBy?: string;
  notes?: string;
}) {
  const normalizedInvoiceId = requirePositiveInteger(invoiceId, "invoiceId");
  const fileName = normalizeRequiredText(data.fileName, "fileName", 255);
  const fileType = normalizeOptionalText(data.fileType, "fileType", 100);
  const filePath = normalizeRequiredText(data.filePath, "filePath", 4_000);
  const uploadedBy = normalizeOptionalText(data.uploadedBy, "uploadedBy", 255);
  const notes = normalizeOptionalText(data.notes, "notes", 10_000);
  const fileSizeBytes = data.fileSizeBytes === undefined
    ? undefined
    : requireNonnegativeInteger(data.fileSizeBytes, "fileSizeBytes");

  return db.transaction(async (tx: ApLedgerDbClient) => {
    const [invoice] = await tx
      .select({ id: vendorInvoices.id })
      .from(vendorInvoices)
      .where(eq(vendorInvoices.id, normalizedInvoiceId))
      .for("update");
    if (!invoice) {
      throw new ApLedgerError("Invoice not found", 404, { code: "AP_INVOICE_NOT_FOUND" });
    }

    const [attachment] = await tx
      .insert(vendorInvoiceAttachments)
      .values({
        vendorInvoiceId: normalizedInvoiceId,
        fileName,
        fileType,
        fileSizeBytes,
        filePath,
        uploadedBy,
        notes,
      })
      .returning();
    await appendApMutationAudit(
      "invoice_attachment_added",
      `invoice:${normalizedInvoiceId}`,
      uploadedBy,
      {
        invoiceId: normalizedInvoiceId,
        attachmentId: attachment.id,
        fileName,
        fileType,
        fileSizeBytes,
      },
      tx,
    );
    return attachment;
  });
}

export async function getAttachments(invoiceId: number) {
  return db
    .select()
    .from(vendorInvoiceAttachments)
    .where(eq(vendorInvoiceAttachments.vendorInvoiceId, invoiceId))
    .orderBy(desc(vendorInvoiceAttachments.uploadedAt));
}

export async function getAttachmentById(id: number) {
  const [attachment] = await db
    .select()
    .from(vendorInvoiceAttachments)
    .where(eq(vendorInvoiceAttachments.id, id));
  return attachment ?? null;
}

export async function removeAttachment(id: number, actorId?: string) {
  const normalizedAttachmentId = requirePositiveInteger(id, "attachmentId");
  return db.transaction(async (tx: ApLedgerDbClient) => {
    const [attachment] = await tx
      .select()
      .from(vendorInvoiceAttachments)
      .where(eq(vendorInvoiceAttachments.id, normalizedAttachmentId))
      .for("update");
    if (!attachment) return null;

    await tx
      .delete(vendorInvoiceAttachments)
      .where(eq(vendorInvoiceAttachments.id, normalizedAttachmentId));
    await appendApMutationAudit(
      "invoice_attachment_removed",
      `invoice:${attachment.vendorInvoiceId}`,
      actorId,
      {
        invoiceId: attachment.vendorInvoiceId,
        attachmentId: normalizedAttachmentId,
        fileName: attachment.fileName,
        fileType: attachment.fileType,
        fileSizeBytes: attachment.fileSizeBytes,
      },
      tx,
    );
    return attachment;
  });
}

// ─── Shipment Cost → AP Bridge ──────────────────────────────────────────────

/**
 * Get vendors with unbilled cost rows on a shipment.
 * Used by the vendor picker in the Add Invoice flow.
 */
export async function getCostVendorsForShipment(shipmentId: number) {
  const rows = await db
    .select({
      vendorId: inboundFreightCosts.vendorId,
      vendorName: vendors.name,
      unbilledCostCount: sql<number>`COUNT(*)::int`,
      unbilledTotalCents: sql<number>`COALESCE(SUM(COALESCE(${inboundFreightCosts.actualCents}, ${inboundFreightCosts.estimatedCents}, 0)), 0)::int`,
    })
    .from(inboundFreightCosts)
    .innerJoin(vendors, eq(inboundFreightCosts.vendorId, vendors.id))
    .where(
      and(
        eq(inboundFreightCosts.inboundShipmentId, shipmentId),
        sql`${inboundFreightCosts.vendorInvoiceId} IS NULL`,
        sql`${inboundFreightCosts.vendorId} IS NOT NULL`,
      ),
    )
    .groupBy(inboundFreightCosts.vendorId, vendors.name)
    .orderBy(vendors.name);

  return {
    vendors: rows.map((r) => ({
      vendorId: r.vendorId!,
      vendorName: r.vendorName,
      unbilledCostCount: r.unbilledCostCount,
      unbilledTotalCents: r.unbilledTotalCents,
    })),
  };
}

/**
 * List unbilled cost rows for a (shipmentId, vendorId) pair.
 * Used by the Add Invoice modal for line preview.
 */
export async function listCostsForInvoiceCreation(shipmentId: number, vendorId: number) {
  const rows = await db
    .select({
      cost: inboundFreightCosts,
      vendorName: vendors.name,
    })
    .from(inboundFreightCosts)
    .leftJoin(vendors, eq(vendors.id, inboundFreightCosts.vendorId))
    .where(
      and(
        eq(inboundFreightCosts.inboundShipmentId, shipmentId),
        eq(inboundFreightCosts.vendorId, vendorId),
        sql`${inboundFreightCosts.vendorInvoiceId} IS NULL`,
      ),
    )
    .orderBy(inboundFreightCosts.costType);

  return rows.map((r) => ({
    ...r.cost,
    vendorDisplayName: r.vendorName,
  }));
}

/**
 * Create an invoice from a shipment's unbilled cost rows for a specific vendor.
 * Race-safe: uses SELECT ... FOR UPDATE on candidate rows inside a transaction.
 *
 * Mirrors the addLinesFromPO pattern from shipment-tracking.service.ts.
 */
export async function createInvoiceFromShipmentCosts(
  shipmentId: number,
  data: {
    vendorId: number;
    invoiceNumber: string;
    invoiceDate?: Date;
    dueDate?: Date;
    costRowIds?: number[];
    lineOverrides?: Array<{
      freightCostId: number;
      qtyInvoiced: number;
      unitCostCents?: number;
      unitCostMills?: number;
      description?: string;
    }>;
    notes?: string;
  },
  actorId?: string,
) {
  // ── 1. Pre-flight validation (non-locked reads) ──
  rejectUnexpectedFields(data as Record<string, unknown>, new Set([
    "vendorId",
    "invoiceNumber",
    "invoiceDate",
    "dueDate",
    "costRowIds",
    "lineOverrides",
    "notes",
  ]), "shipment cost invoice create");
  const normalizedShipmentId = requirePositiveInteger(shipmentId, "shipmentId");
  const vendorId = requirePositiveInteger(data.vendorId, "vendorId");
  const invoiceNumber = normalizeRequiredText(data.invoiceNumber, "invoiceNumber", 100);
  const invoiceDateInput = normalizeOptionalDate(data.invoiceDate, "invoiceDate");
  const dueDateInput = normalizeOptionalDate(data.dueDate, "dueDate");
  const notes = normalizeOptionalText(data.notes, "notes", 10_000);
  const requestedCostIds = data.costRowIds === undefined
    ? undefined
    : [...new Set(data.costRowIds.map((id) => requirePositiveInteger(id, "costRowIds[]")))]
      .sort((left, right) => left - right);
  if (requestedCostIds && requestedCostIds.length === 0) {
    throw new ApLedgerError("costRowIds must contain at least one ID when provided", 400, {
      code: "AP_SHIPMENT_COST_IDS_EMPTY",
    });
  }

  const overrideMap = new Map<number, {
    qtyInvoiced: number;
    unitCostCents: number;
    unitCostMills: number;
    description?: string;
  }>();
  for (const [index, override] of (data.lineOverrides ?? []).entries()) {
    rejectUnexpectedFields(override as Record<string, unknown>, new Set([
      "freightCostId",
      "qtyInvoiced",
      "unitCostCents",
      "unitCostMills",
      "description",
    ]), `lineOverrides[${index}]`);
    const freightCostId = requirePositiveInteger(
      override.freightCostId,
      `lineOverrides[${index}].freightCostId`,
    );
    if (overrideMap.has(freightCostId)) {
      throw new ApLedgerError("Each shipment cost may be overridden only once", 400, {
        code: "AP_SHIPMENT_COST_OVERRIDE_DUPLICATE",
        freightCostId,
      });
    }
    const normalizedCost = normalizeUnitCost(override);
    overrideMap.set(freightCostId, {
      qtyInvoiced: requirePositiveInteger(
        override.qtyInvoiced,
        `lineOverrides[${index}].qtyInvoiced`,
      ),
      ...normalizedCost,
      description: normalizeOptionalText(
        override.description,
        `lineOverrides[${index}].description`,
        10_000,
      ),
    });
  }

  // ── 2. Transaction: lock, validate, insert ──
  const result = await db.transaction(async (tx: ApLedgerDbClient) => {
    const [shipment] = await tx
      .select({ shipmentNumber: inboundShipments.shipmentNumber, status: inboundShipments.status })
      .from(inboundShipments)
      .where(eq(inboundShipments.id, normalizedShipmentId))
      .for("update");
    if (!shipment) throw new ApLedgerError("Shipment not found", 404);
    if (shipment.status === "cancelled") {
      throw new ApLedgerError("Cannot create invoice for a cancelled shipment", 409, {
        code: "AP_SHIPMENT_CANCELLED",
      });
    }

    const [vendor] = await tx
      .select({ id: vendors.id, name: vendors.name, paymentTermsDays: vendors.paymentTermsDays })
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .for("share");
    if (!vendor) throw new ApLedgerError("Vendor not found", 404);
    // Lock candidate cost rows with FOR UPDATE
    let lockedRows;
    if (requestedCostIds) {
      lockedRows = await tx.execute(sql`
        SELECT id, cost_type, description, actual_cents, estimated_cents,
               performed_by_name, vendor_id, vendor_invoice_id, cost_status
        FROM procurement.inbound_freight_costs
        WHERE inbound_shipment_id = ${normalizedShipmentId}
          AND vendor_id = ${vendorId}
          AND vendor_invoice_id IS NULL
          AND id = ANY(ARRAY[${sql.join(requestedCostIds, sql`, `)}]::integer[])
        ORDER BY id
        FOR UPDATE
      `);
    } else {
      lockedRows = await tx.execute(sql`
        SELECT id, cost_type, description, actual_cents, estimated_cents,
               performed_by_name, vendor_id, vendor_invoice_id, cost_status
        FROM procurement.inbound_freight_costs
        WHERE inbound_shipment_id = ${normalizedShipmentId}
          AND vendor_id = ${vendorId}
          AND vendor_invoice_id IS NULL
        ORDER BY id
        FOR UPDATE
      `);
    }

    const costs = lockedRows.rows as any[];

    if (costs.length === 0) {
      throw new ApLedgerError("No unbilled cost rows found for this vendor on this shipment", 400);
    }

    if (requestedCostIds) {
      const lockedIds = new Set(costs.map((cost) => Number(cost.id)));
      const missingCostRowIds = requestedCostIds.filter((id) => !lockedIds.has(id));
      if (missingCostRowIds.length > 0) {
        throw new ApLedgerError(
          "One or more requested shipment costs are missing, already invoiced, or owned by another vendor",
          409,
          { code: "AP_SHIPMENT_COST_SELECTION_STALE", missingCostRowIds },
        );
      }
    }

    // Defense-in-depth: re-verify none have been invoiced concurrently
    const alreadyInvoiced = costs.filter((c: any) => c.vendor_invoice_id != null);
    if (alreadyInvoiced.length > 0) {
      throw new ApLedgerError(
        `Cost rows already invoiced: ${alreadyInvoiced.map((c: any) => c.id).join(", ")}`,
        409,
      );
    }

    // Sanity check: all locked rows must match the requested vendor
    const wrongVendor = costs.filter((c: any) => Number(c.vendor_id) !== vendorId);
    if (wrongVendor.length > 0) {
      throw new ApLedgerError("Vendor mismatch on cost rows", 422);
    }

    // ── 3. Build line overrides map ──
    const lockedCostIds = new Set(costs.map((cost) => Number(cost.id)));
    const orphanOverrideIds = [...overrideMap.keys()].filter((id) => !lockedCostIds.has(id));
    if (orphanOverrideIds.length > 0) {
      throw new ApLedgerError("Line override references a cost outside the locked selection", 422, {
        code: "AP_SHIPMENT_COST_OVERRIDE_NOT_SELECTED",
        freightCostIds: orphanOverrideIds.sort((left, right) => left - right),
      });
    }

    // ── 4. Compute invoice lines ──
    let lineNum = 0;
    const lines: Array<{
      lineNumber: number;
      freightCostId: number;
      description: string;
      productName: string;
      qtyInvoiced: number;
      unitCostCents: number;
      unitCostMills: number;
      lineTotalCents: number;
    }> = [];

    for (const cost of costs) {
      lineNum++;
      const costId = Number(cost.id);
      const costAmount = requireNonnegativeInteger(
        cost.actual_cents !== null && cost.actual_cents !== undefined
          ? cost.actual_cents
          : cost.estimated_cents ?? 0,
        `shipmentCost[${cost.id}].amountCents`,
      );
      const label = String(cost.cost_type).replace(/_/g, " ");
      const defaultDescription = `${label}: ${cost.performed_by_name || vendor.name}`;
      const override = overrideMap.get(costId);

      const qtyInvoiced = override?.qtyInvoiced ?? 1;
      const unitCostMills = override?.unitCostMills ?? centsToMills(costAmount);
      const unitCostCents = millsToCents(unitCostMills);
      const description = override?.description ?? defaultDescription;
      const lineTotalCents = computeLineTotalCentsFromMills(unitCostMills, qtyInvoiced);

      lines.push({
        lineNumber: lineNum,
        freightCostId: costId,
        description,
        productName: label,
        qtyInvoiced,
        unitCostCents,
        unitCostMills,
        lineTotalCents,
      });
    }

    const totalCentsBigInt = lines.reduce(
      (sum, line) => sum + BigInt(line.lineTotalCents),
      BigInt(0),
    );
    if (totalCentsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ApLedgerError("Invoice total exceeds the supported integer range", 400, {
        code: "AP_INVOICE_TOTAL_OVERFLOW",
      });
    }
    const totalCents = Number(totalCentsBigInt);

    // ── 5. Insert vendor_invoices row ──
    const invoiceDate = invoiceDateInput ?? new Date();
    const dueDate = dueDateInput ?? (vendor.paymentTermsDays
      ? new Date(invoiceDate.getTime() + vendor.paymentTermsDays * 86400000)
      : undefined);

    let invoiceRow: any;
    try {
      [invoiceRow] = await tx
        .insert(vendorInvoices)
        .values({
          invoiceNumber,
          vendorId,
          inboundShipmentId: normalizedShipmentId,
          status: "received",
          invoiceDate,
          receivedDate: new Date(),
          dueDate: dueDate ?? null,
          invoicedAmountCents: totalCents,
          balanceCents: totalCents,
          paidAmountCents: 0,
          currency: "USD",
          notes: notes ?? null,
          createdBy: actorId,
          updatedBy: actorId,
        })
        .returning();
    } catch (error: any) {
      if (error?.code === "23505") {
        throw new ApLedgerError("This vendor already has an invoice with that number", 409, {
          code: "AP_INVOICE_DUPLICATE",
        });
      }
      throw error;
    }

    // ── 6. Insert vendor_invoice_lines with freightCostId ──
    for (const line of lines) {
      await tx.insert(vendorInvoiceLines).values({
        vendorInvoiceId: invoiceRow.id,
        lineNumber: line.lineNumber,
        freightCostId: line.freightCostId,
        description: line.description,
        productName: line.productName,
        qtyInvoiced: line.qtyInvoiced,
        unitCostCents: line.unitCostCents,
        unitCostMills: line.unitCostMills,
        lineTotalCents: line.lineTotalCents,
        matchStatus: "matched",
      });
    }

    // ── 7. Update cost row denorms ──
    const costIds = costs.map((cost: any) => Number(cost.id));
    await tx.execute(sql`
      UPDATE procurement.inbound_freight_costs
      SET vendor_invoice_id = ${invoiceRow.id},
          invoice_number = ${invoiceNumber},
          invoice_date = ${invoiceDate.toISOString()},
          due_date = ${dueDate ? dueDate.toISOString() : null},
          cost_status = 'invoiced',
          updated_at = NOW()
      WHERE id = ANY(ARRAY[${sql.join(costIds, sql`, `)}]::integer[])
    `);

    await appendApMutationAudit(
      "shipment_cost_invoice_created",
      `invoice:${invoiceRow.id}`,
      actorId,
      {
        invoiceId: invoiceRow.id,
        inboundShipmentId: normalizedShipmentId,
        vendorId,
        freightCostIds: costIds,
        totalCents,
      },
      tx,
    );

    return {
      ...invoiceRow,
      lines,
      inboundShipmentId: normalizedShipmentId,
    };
  });

  return result;
}


/**
 * Get payment status for each shipment cost + summary totals.
 */
export async function getShipmentCostPaymentStatus(shipmentId: number) {
  const costs = await db
    .select({
      costId: inboundFreightCosts.id,
      costType: inboundFreightCosts.costType,
      description: inboundFreightCosts.description,
      performedByName: inboundFreightCosts.performedByName,
      actualCents: inboundFreightCosts.actualCents,
      estimatedCents: inboundFreightCosts.estimatedCents,
      vendorInvoiceId: inboundFreightCosts.vendorInvoiceId,
      invoiceStatus: vendorInvoices.status,
      invoiceNumber: vendorInvoices.invoiceNumber,
      invoicedAmountCents: vendorInvoices.invoicedAmountCents,
      paidAmountCents: vendorInvoices.paidAmountCents,
      invoiceLineTotalCents: sql<number | null>`(
        SELECT SUM(vil.line_total_cents)::bigint
        FROM procurement.vendor_invoice_lines vil
        WHERE vil.freight_cost_id = ${inboundFreightCosts.id}
          AND vil.vendor_invoice_id = ${vendorInvoices.id}
      )`,
    })
    .from(inboundFreightCosts)
    .leftJoin(vendorInvoices, eq(inboundFreightCosts.vendorInvoiceId, vendorInvoices.id))
    .where(eq(inboundFreightCosts.inboundShipmentId, shipmentId));

  let totalCents = 0;
  let linkedCents = 0;
  let paidCents = 0;
  let outstandingCents = 0;

  const normalizedCosts = costs.map((cost, index) => ({
    ...cost,
    amountCents: requireNonnegativeInteger(
      cost.invoiceLineTotalCents !== null && cost.invoiceLineTotalCents !== undefined
        ? cost.invoiceLineTotalCents
        : cost.actualCents !== null && cost.actualCents !== undefined
          ? cost.actualCents
          : cost.estimatedCents ?? 0,
      `shipmentCosts[${index}].amountCents`,
    ),
  }));

  const partialCostsByInvoice = new Map<number, typeof normalizedCosts>();
  for (const cost of normalizedCosts) {
    if (cost.invoiceStatus !== "partially_paid" || !cost.vendorInvoiceId) continue;
    const existing = partialCostsByInvoice.get(cost.vendorInvoiceId) ?? [];
    existing.push(cost);
    partialCostsByInvoice.set(cost.vendorInvoiceId, existing);
  }

  const partialPaidByCostId = new Map<number, number>();
  for (const [invoiceId, invoiceCosts] of partialCostsByInvoice) {
    const invoiceTotalCents = requirePositiveInteger(
      invoiceCosts[0].invoicedAmountCents,
      `invoice[${invoiceId}].invoicedAmountCents`,
    );
    const invoicePaidCents = requireNonnegativeInteger(
      invoiceCosts[0].paidAmountCents,
      `invoice[${invoiceId}].paidAmountCents`,
    );
    const allocation = allocateProportionalPaidCents(
      invoiceCosts.map((cost) => ({ id: cost.costId, amountCents: cost.amountCents })),
      invoicePaidCents,
      invoiceTotalCents,
    );
    for (const [costId, allocatedCents] of allocation) {
      partialPaidByCostId.set(costId, allocatedCents);
    }
  }

  const costStatuses = normalizedCosts.map((c) => {
    const amount = c.amountCents;
    totalCents += amount;

    let paymentStatus: "unlinked" | "unpaid" | "partial" | "paid" | "disputed" | "voided" = "unlinked";
    let costPaidCents = 0;
    let costOutstandingCents = amount;

    if (c.vendorInvoiceId && c.invoiceStatus) {
      linkedCents += amount;

      if (c.invoiceStatus === "voided") {
        paymentStatus = "voided";
      } else if (c.invoiceStatus === "disputed") {
        paymentStatus = "disputed";
      } else if (c.invoiceStatus === "paid") {
        paymentStatus = "paid";
        costPaidCents = amount;
        costOutstandingCents = 0;
      } else if (c.invoiceStatus === "partially_paid") {
        paymentStatus = "partial";
        costPaidCents = partialPaidByCostId.get(c.costId) ?? 0;
        costOutstandingCents = amount - costPaidCents;
      } else {
        paymentStatus = "unpaid";
      }
    }

    paidCents += costPaidCents;
    outstandingCents += costOutstandingCents;

    return {
      costId: c.costId,
      costType: c.costType,
      description: c.description,
      performedByName: c.performedByName,
      amountCents: amount,
      vendorInvoiceId: c.vendorInvoiceId,
      invoiceNumber: c.invoiceNumber,
      invoiceStatus: c.invoiceStatus,
      paymentStatus,
      paidCents: costPaidCents,
      outstandingCents: costOutstandingCents,
    };
  });

  if (paidCents + outstandingCents !== totalCents) {
    throw new ApLedgerError("Shipment cost payment summary checksum failed", 500, {
      code: "AP_SHIPMENT_PAYMENT_CHECKSUM_FAILED",
      shipmentId,
      totalCents,
      paidCents,
      outstandingCents,
    });
  }

  return {
    costs: costStatuses,
    summary: {
      totalCents,
      linkedCents,
      paidCents,
      outstandingCents,
    },
  };
}

/**
 * Get all invoices linked to a shipment with summary totals.
 * Uses vendor_invoices.inbound_shipment_id direct FK.
 */
export async function getShipmentInvoicesSummary(shipmentId: number) {
  const rows = await db
    .select({
      invoice: vendorInvoices,
      vendorName: vendors.name,
      vendorCode: vendors.code,
    })
    .from(vendorInvoices)
    .leftJoin(vendors, eq(vendorInvoices.vendorId, vendors.id))
    .where(eq(vendorInvoices.inboundShipmentId, shipmentId))
    .orderBy(desc(vendorInvoices.invoiceDate));

  let totalInvoiced = BigInt(0);
  let totalPaid = BigInt(0);
  let activeInvoiceCount = 0;

  const invoices = rows.map((r, index) => {
    if (r.invoice.status !== "voided") {
      activeInvoiceCount++;
      totalInvoiced += databaseMoneyToBigInt(
        r.invoice.invoicedAmountCents ?? 0,
        `shipmentInvoices[${index}].invoicedAmountCents`,
      );
      totalPaid += databaseMoneyToBigInt(
        r.invoice.paidAmountCents ?? 0,
        `shipmentInvoices[${index}].paidAmountCents`,
      );
    }
    return {
      ...r.invoice,
      vendorName: r.vendorName,
      vendorCode: r.vendorCode,
    };
  });

  const outstanding = totalInvoiced > totalPaid ? totalInvoiced - totalPaid : BigInt(0);
  const totalInvoicedCents = bigintMoneyToNumber(totalInvoiced, "shipment.totalInvoicedCents");
  const totalPaidCents = bigintMoneyToNumber(totalPaid, "shipment.totalPaidCents");

  return {
    invoices,
    summary: {
      totalInvoicedCents,
      totalPaidCents,
      outstandingCents: bigintMoneyToNumber(outstanding, "shipment.outstandingCents"),
      invoiceCount: invoices.length,
      activeInvoiceCount,
    },
  };
}

/**
 * Enrich shipment cost rows with linked invoice info and derived status.
 * Returns enriched cost array with linkedInvoice and derivedStatus fields.
 */
export async function enrichCostsWithInvoiceInfo(shipmentId: number) {
  const costs = await db
    .select({
      cost: inboundFreightCosts,
      invoiceId: vendorInvoices.id,
      invoiceNumber: vendorInvoices.invoiceNumber,
      invoiceVendorId: vendorInvoices.vendorId,
      invoiceStatus: vendorInvoices.status,
      invoiceVendorName: vendors.name,
      invoicedAmountCents: vendorInvoices.invoicedAmountCents,
      paidAmountCents: vendorInvoices.paidAmountCents,
      balanceCents: vendorInvoices.balanceCents,
    })
    .from(inboundFreightCosts)
    .leftJoin(vendorInvoices, eq(inboundFreightCosts.vendorInvoiceId, vendorInvoices.id))
    .leftJoin(vendors, eq(vendorInvoices.vendorId, vendors.id))
    .where(eq(inboundFreightCosts.inboundShipmentId, shipmentId));

  return costs.map((c) => {
    const linkedInvoice = c.invoiceId
      ? {
          id: c.invoiceId,
          invoiceNumber: c.invoiceNumber,
          vendorId: c.invoiceVendorId,
          vendorName: c.invoiceVendorName,
        }
      : null;

    let derivedStatus: "unbilled" | "invoiced" | "paid" = "unbilled";
    if (c.invoiceId && c.invoiceStatus) {
      if (c.invoiceStatus === "voided") {
        derivedStatus = "unbilled";
      } else {
        const balance = Number(c.balanceCents) || 0;
        derivedStatus = balance <= 0 ? "paid" : "invoiced";
      }
    }

    return {
      ...c.cost,
      linkedInvoice,
      derivedStatus,
    };
  });
}

/**
 * Link a single shipment cost to an existing vendor invoice.
 */
export async function linkCostToInvoice(
  costId: number,
  vendorInvoiceId: number,
  actorId?: string,
) {
  const normalizedCostId = requirePositiveInteger(costId, "costId");
  const normalizedInvoiceId = requirePositiveInteger(vendorInvoiceId, "vendorInvoiceId");
  return db.transaction(async (tx: ApLedgerDbClient) => {
    const [cost] = await tx
      .select()
      .from(inboundFreightCosts)
      .where(eq(inboundFreightCosts.id, normalizedCostId))
      .for("update");
    if (!cost) {
      throw new ApLedgerError("Shipment cost not found", 404, {
        code: "AP_SHIPMENT_COST_NOT_FOUND",
        costId: normalizedCostId,
      });
    }
    if (cost.vendorInvoiceId && cost.vendorInvoiceId !== normalizedInvoiceId) {
      throw new ApLedgerError("Shipment cost is already linked to another invoice", 409, {
        code: "AP_SHIPMENT_COST_ALREADY_LINKED",
        costId: normalizedCostId,
        vendorInvoiceId: cost.vendorInvoiceId,
      });
    }

    const invoice = await lockEditableInvoice(tx, normalizedInvoiceId);
    const [invoiceDetails] = await tx
      .select({
        inboundShipmentId: vendorInvoices.inboundShipmentId,
        invoiceNumber: vendorInvoices.invoiceNumber,
        invoiceDate: vendorInvoices.invoiceDate,
        dueDate: vendorInvoices.dueDate,
      })
      .from(vendorInvoices)
      .where(eq(vendorInvoices.id, normalizedInvoiceId));
    if (cost.vendorId !== null && cost.vendorId !== invoice.vendorId) {
      throw new ApLedgerError("Shipment cost and invoice must belong to the same vendor", 422, {
        code: "AP_SHIPMENT_COST_VENDOR_MISMATCH",
        costId: normalizedCostId,
        costVendorId: cost.vendorId,
        invoiceVendorId: invoice.vendorId,
      });
    }
    if (
      invoiceDetails?.inboundShipmentId !== null &&
      invoiceDetails?.inboundShipmentId !== undefined &&
      invoiceDetails.inboundShipmentId !== cost.inboundShipmentId
    ) {
      throw new ApLedgerError("Invoice is already assigned to a different shipment", 422, {
        code: "AP_INVOICE_SHIPMENT_MISMATCH",
        invoiceId: normalizedInvoiceId,
        invoiceShipmentId: invoiceDetails.inboundShipmentId,
        costShipmentId: cost.inboundShipmentId,
      });
    }

    await tx
      .update(inboundFreightCosts)
      .set({
        vendorInvoiceId: normalizedInvoiceId,
        vendorId: invoice.vendorId,
        invoiceNumber: invoiceDetails?.invoiceNumber ?? null,
        invoiceDate: invoiceDetails?.invoiceDate ?? null,
        dueDate: invoiceDetails?.dueDate ?? null,
        costStatus: "invoiced",
        updatedAt: new Date(),
      })
      .where(eq(inboundFreightCosts.id, normalizedCostId));

    if (!invoiceDetails?.inboundShipmentId) {
      await tx
        .update(vendorInvoices)
        .set({
          inboundShipmentId: cost.inboundShipmentId,
          updatedBy: actorId,
          updatedAt: new Date(),
        })
        .where(eq(vendorInvoices.id, normalizedInvoiceId));
    }
    await appendApMutationAudit(
      "shipment_cost_invoice_linked",
      `shipment_cost:${normalizedCostId}`,
      actorId,
      {
        costId: normalizedCostId,
        vendorInvoiceId: normalizedInvoiceId,
        inboundShipmentId: cost.inboundShipmentId,
      },
      tx,
    );

    return { costId: normalizedCostId, vendorInvoiceId: normalizedInvoiceId };
  });
}

/**
 * Unlink a shipment cost from its vendor invoice.
 */
export async function unlinkCostFromInvoice(costId: number, actorId?: string) {
  const normalizedCostId = requirePositiveInteger(costId, "costId");
  return db.transaction(async (tx: ApLedgerDbClient) => {
    const [cost] = await tx
      .select()
      .from(inboundFreightCosts)
      .where(eq(inboundFreightCosts.id, normalizedCostId))
      .for("update");
    if (!cost) {
      throw new ApLedgerError("Shipment cost not found", 404, {
        code: "AP_SHIPMENT_COST_NOT_FOUND",
        costId: normalizedCostId,
      });
    }
    if (!cost.vendorInvoiceId) return { ok: true, changed: false };

    await lockEditableInvoice(tx, cost.vendorInvoiceId);
    await tx
      .update(inboundFreightCosts)
      .set({
        vendorInvoiceId: null,
        invoiceNumber: null,
        invoiceDate: null,
        dueDate: null,
        costStatus: cost.actualCents === null ? "estimated" : "finalized",
        updatedAt: new Date(),
      })
      .where(eq(inboundFreightCosts.id, normalizedCostId));
    await appendApMutationAudit(
      "shipment_cost_invoice_unlinked",
      `shipment_cost:${normalizedCostId}`,
      actorId,
      {
        costId: normalizedCostId,
        vendorInvoiceId: cost.vendorInvoiceId,
        inboundShipmentId: cost.inboundShipmentId,
      },
      tx,
    );
    return { ok: true, changed: true };
  });
}
