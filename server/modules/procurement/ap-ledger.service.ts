import { readIntegerCents, readIntegerMills } from "@shared/money-read";
import { hasInvoiceCreditHistory, SupplierCreditEvidenceError, assertInvoiceHasNoCreditHistory, assertInvoiceSettlementEvidence, readInvoiceCreditAmount, readVerifiedInvoiceSettlementProjections } from "./supplier-credit-settlement.repository";
import { paymentApplicationInputSchema, paymentCalendarDateSchema, type PaymentApplicationInput } from "@shared/procurement/ap-payment-contract";
import { readPaymentBalances } from "./ap-payment-balance.repository";
import { readCommandAuthorityActor } from "../identity/infrastructure/command-authority.repository";
import { readShipmentBillingOwnership, readInvoiceSourceCapabilities } from "./shipment-billing-ownership.repository";
import { readPoFinancialEvidenceSourcesWithClient } from "./po-financial-evidence.repository";
import { buildPoFinancialWorkflow } from "./domain/po-financial-workflow";
import { buildPoFinancialMilestonePatch } from "./domain/po-financial-milestones";
import { readInvoiceWorkList, readPaymentWorkList } from "./ap-work-list.repository";
import type { InvoiceWorkListQuery, PaymentWorkListQuery, InvoiceWorkListPage, PaymentWorkListPage } from "@shared/procurement/ap-work-list";

import { deriveInvoiceFinancialState } from "./domain/invoice-financial-state";
import { invoiceEditCapability } from "./domain/ap-invoice-edit-policy";
import { classifyApPaymentState, COMPLETED_AP_PAYMENT_STATUS, isRecordableApPaymentStatus } from "./domain/ap-payment-state";
import { summarizeInvoiceCostReconciliation } from "./domain/invoice-cost-reconciliation-summary";
import { costFingerprint, costInteger, lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { reconcilePurchaseCostEvidence } from "./purchase-cost-application.service";
import { getInvoiceLinesWithPoQuantities } from "./invoice-po-quantities.repository";
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
import { eq, and, inArray, sql, desc, lt, lte, gte, ne, asc, like, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { documentNumberPrefix } from "../../platform/document-numbering/document-number";
import { allocateDocumentNumber, readSuggestedInvoiceNumber } from "../../platform/document-numbering/document-number.repository";
import {
  centsToMills,
  computeLineTotalCentsFromMills,
  millsToCents,
} from "@shared/utils/money";
import {
  detectMatchMismatch,
  detectFinancialExceptions,
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

function requireSignedInteger(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized)) {
    throw new ApLedgerError(`${field} must be a signed safe integer`, 400, {
      code: "AP_INPUT_SIGNED_INTEGER_REQUIRED",
      field,
    });
  }
  return normalized;
}

function roundSignedRatioHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) {
    throw new ApLedgerError("Ratio denominator must be positive", 500, {
      code: "AP_PAYMENT_ALLOCATION_INTEGRITY_ERROR",
    });
  }
  const negative = numerator < BigInt(0);
  const absoluteNumerator = negative ? -numerator : numerator;
  const rounded = (absoluteNumerator + denominator / BigInt(2)) / denominator;
  return negative ? -rounded : rounded;
}

function floorSignedRatio(numerator: bigint, denominator: bigint): {
  quotient: bigint;
  remainder: bigint;
} {
  let quotient = numerator / denominator;
  let remainder = numerator % denominator;
  if (remainder < BigInt(0)) {
    quotient -= BigInt(1);
    remainder += denominator;
  }
  return { quotient, remainder };
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
      amountCents: requireSignedInteger(item.amountCents, `items[${index}].amountCents`),
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
  const targetPaid = roundSignedRatioHalfAwayFromZero(targetNumerator, invoiceTotal);
  const allocations = normalizedItems.map((item) => {
    const numerator = BigInt(item.amountCents) * paid;
    const divided = floorSignedRatio(numerator, invoiceTotal);
    return {
      id: item.id,
      paidCents: divided.quotient,
      remainder: divided.remainder,
    };
  });
  const allocatedFloor = allocations.reduce((sum, item) => sum + item.paidCents, BigInt(0));
  let centsToDistribute = targetPaid - allocatedFloor;

  if (centsToDistribute < BigInt(0) || centsToDistribute > BigInt(allocations.length)) {
    throw new ApLedgerError("Signed payment allocation remainder is out of range", 500, {
      code: "AP_PAYMENT_ALLOCATION_INTEGRITY_ERROR",
      centsToDistribute: centsToDistribute.toString(),
      itemCount: allocations.length,
    });
  }

  const remainderOrder = [...allocations].sort((left, right) => {
    if (left.remainder === right.remainder) return left.id - right.id;
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (const allocation of remainderOrder) {
    if (centsToDistribute <= BigInt(0)) break;
    allocation.paidCents += BigInt(1);
    centsToDistribute -= BigInt(1);
  }

  const paidById = new Map(allocations.map((item) => [item.id, item.paidCents]));
  return new Map(normalizedItems.map((item) => {
    const allocatedPaidCents = paidById.get(item.id);
    if (allocatedPaidCents === undefined) {
      throw new ApLedgerError("Payment allocation result is missing an item", 500, {
        code: "AP_PAYMENT_ALLOCATION_INTEGRITY_ERROR",
        itemId: item.id,
      });
    }
    return [item.id, readIntegerCents(allocatedPaidCents, "allocatedPaidCents", true)];
  }));
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
  | "apply_payment"
  | "void_payment";

export type RecordApPaymentInput = {
  vendorId: number;
  paymentDate: Date;
  paymentCalendarDate?: string | null;
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
  application?: PaymentApplicationInput;
  now?: Date;
};

export type ApPaymentCommandInput = ApLedgerCommandInput & { now: Date };

export type ApPaymentClockOptions = { now?: Date };

function requirePaymentCommandTime(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ApLedgerError("AP payment command clock is invalid", 500, { code: "AP_PAYMENT_CLOCK_INVALID" });
  }
  // Take ownership before the first await; callers cannot move a command across
  // dates by mutating a shared Date while its transaction is waiting for a lock.
  return new Date(value.getTime());
}

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

export async function recomputeLinkedPurchaseOrders(
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
  at?: Date,
): Promise<void> {
  await client.insert(auditEvents).values({
    ...(at ? { timestamp: at } : {}),
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
  recordedAt?: Date,
): Promise<void> {
  await client.insert(auditEvents).values({
    ...(recordedAt ? { timestamp: recordedAt } : {}),
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
  replacesInvoiceId?: number | null;
  invoiceNumber?: string;
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
      creditedAmountCents: vendorInvoices.creditedAmountCents,
      approvedAt: vendorInvoices.approvedAt,
      approvedBy: vendorInvoices.approvedBy,
      replacesInvoiceId: vendorInvoices.replacesInvoiceId,
      invoiceNumber: vendorInvoices.invoiceNumber,
    })
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, invoiceId))
    .for("update");

  if (!invoice) {
    throw new ApLedgerError("Invoice not found", 404, { code: "AP_INVOICE_NOT_FOUND" });
  }
  await assertInvoiceHasNoCreditHistory(client, invoiceId);
  const headerCapability = invoiceEditCapability({ ...invoice, hasPaymentHistory: false });
  if (!headerCapability.allowed) {
    throw new ApLedgerError(headerCapability.reason, 409, { code: headerCapability.code, invoiceId, status: invoice.status });
  }
  // The cost-graph lock and header lock serialize this check with payment,
  // approval, dispute and reviewed-correction owners. Voids retain history.
  const [paymentHistory] = await client.select({ id: apPaymentAllocations.id })
    .from(apPaymentAllocations).where(eq(apPaymentAllocations.vendorInvoiceId, invoiceId)).limit(1);
  const capability = invoiceEditCapability({ ...invoice, hasPaymentHistory: !!paymentHistory });
  if (!capability.allowed) {
    throw new ApLedgerError(capability.reason, 409, { code: capability.code, invoiceId, status: invoice.status });
  }

  return invoice;
}

async function assertInvoiceSourceCapability(client: ApLedgerDbClient, invoiceId: number,
  action: "purchaseOrderLinks" | "approval" | "payment"): Promise<void> {
  const capability = (await readInvoiceSourceCapabilities(client, invoiceId))[action];
  if (!capability.allowed) throw new ApLedgerError(capability.reason, 409, { code: capability.code, invoiceId });
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
      creditedAmountCents: vendorInvoices.creditedAmountCents,
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
    await detectFinancialExceptions(poId);
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
    await runApCostTransaction(async (tx: ApLedgerDbClient) => {
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
      creditedAmountCents: vendorInvoices.creditedAmountCents,
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
  let paidTotal = BigInt(0); let creditedTotal = BigInt(0);
  for (const [index, row] of invoiceRows.entries()) {
    creditedTotal += databaseMoneyToBigInt(row.creditedAmountCents,`invoiceRows[${index}].creditedAmountCents`);
    invoicedTotal += databaseMoneyToBigInt(
      row.invoicedAmountCents ?? 0,
      `invoiceRows[${index}].invoicedAmountCents`,
    );
    paidTotal += databaseMoneyToBigInt(
      row.paidAmountCents ?? 0,
      `invoiceRows[${index}].paidAmountCents`,
    );
  }
  const settledTotal = paidTotal + creditedTotal;
  const outstanding = invoicedTotal > settledTotal ? invoicedTotal - settledTotal : BigInt(0);
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
  } else if (settledTotal >= invoicedTotal) {
    newFinancial = "paid";
  } else if (settledTotal > BigInt(0)) {
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

  // Legacy whole-invoice sums above remain compatibility caches. Only exact
  // attributed evidence can establish a new financial milestone.
  const source = (await readPoFinancialEvidenceSourcesWithClient(client, [poId])).get(poId);
  if (!source) throw new ApLedgerError("Purchase order financial source is unavailable", 409,
    { code: "PO_FINANCIAL_EVIDENCE_SOURCE_MISSING", purchaseOrderId: poId });
  Object.assign(patch, buildPoFinancialMilestonePatch({ workflow: buildPoFinancialWorkflow(source), existing: po, now }));

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

async function generatePaymentNumber(client: ApLedgerDbClient, at: Date): Promise<string> {
  return allocateDocumentNumber(client, { kind: "payment", prefix: documentNumberPrefix("PAY", at, "local") });
}

// ─── Invoice Balance Recalculation ────────────────────────────────────────────

export async function recalculateInvoiceBalance(invoiceId: number, client: ApLedgerDbClient = db, at: Date = new Date()): Promise<void> {
  const [invoice] = await client
    .select({ id: vendorInvoices.id, vendorId: vendorInvoices.vendorId, currency: vendorInvoices.currency, invoicedAmountCents: vendorInvoices.invoicedAmountCents, status: vendorInvoices.status })
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, invoiceId))
    .for("update");

  if (!invoice) return;

  // Only completed payments settle invoices. Unknown legacy states block
  // recalculation so a command cannot silently rewrite historical balances.
  const allocResult = await client
    .select({
      total: sql<number>`COALESCE(SUM(CASE WHEN ${apPayments.status} = ${COMPLETED_AP_PAYMENT_STATUS} THEN ${apPaymentAllocations.appliedAmountCents} ELSE 0 END), 0)`,
      reviewRequiredCount: sql<number>`COUNT(*) FILTER (WHERE ${apPayments.status} NOT IN ('completed', 'voided'))`,
    })
    .from(apPaymentAllocations)
    .innerJoin(apPayments, eq(apPaymentAllocations.apPaymentId, apPayments.id))
    .where(eq(apPaymentAllocations.vendorInvoiceId, invoiceId));

  if (Number(allocResult[0]?.reviewRequiredCount ?? 0) > 0) {
    throw new ApLedgerError("This invoice has a payment with an unsupported historical status. Review the payment evidence before changing its balance.", 409, {
      code: "AP_PAYMENT_STATUS_REVIEW_REQUIRED", invoiceId,
    });
  }

  const paidAmount = databaseMoneyToBigInt(
    allocResult[0]?.total ?? 0,
    `invoice[${invoiceId}].paidAmountCents`,
  );
  const invoicedAmount = databaseMoneyToBigInt(
    invoice.invoicedAmountCents,
    `invoice[${invoiceId}].invoicedAmountCents`,
  );
  const creditedAmountCents = await readInvoiceCreditAmount(client, invoice);
  const projected = deriveInvoiceFinancialState({ status: invoice.status, creditedAmountCents,
    invoiceAmountCents: bigintMoneyToNumber(invoicedAmount, `invoice[${invoiceId}].invoicedAmountCents`),
    paidAmountCents: bigintMoneyToNumber(paidAmount, `invoice[${invoiceId}].paidAmountCents`),
  });

  await client
    .update(vendorInvoices)
    .set({
      creditedAmountCents,
      paidAmountCents: bigintMoneyToNumber(paidAmount, `invoice[${invoiceId}].paidAmountCents`),
      balanceCents: projected.balanceCents,
      status: projected.status,
      updatedAt: at,
    })
    .where(eq(vendorInvoices.id, invoiceId));
}

// ─── Invoice Number Generation ───────────────────────────────────────────────

/**
 * Read-only suggestion for the editable supplier invoice identifier. This does
 * not reserve a number: createInvoice retains the reviewed vendor reference and
 * rejects a duplicate for that vendor instead of silently renumbering it.
 */
export async function generateInvoiceNumber(options: { now?: Date } = {}): Promise<string> {
  const at = options.now ?? new Date();
  return readSuggestedInvoiceNumber(db, documentNumberPrefix("INV", at, "utc"));
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

  const invoice = await runApCostTransaction(async (tx: ApLedgerDbClient) => {
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
  return db.transaction(async tx => {
    const [invoice] = await tx
      .select()
      .from(vendorInvoices)
      .where(eq(vendorInvoices.id, id));

    if (!invoice) return null;
    const settlement=(await readVerifiedInvoiceSettlementProjections(tx,[invoice])).get(invoice.id)!;

    const poLinks = await tx
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

    const payments = await tx
      .select({
        id: apPaymentAllocations.id,
        apPaymentId: apPaymentAllocations.apPaymentId,
        appliedAmountCents: apPaymentAllocations.appliedAmountCents,
        paymentNumber: apPayments.paymentNumber,
        paymentDate: apPayments.paymentDate,
        paymentCalendarDate: apPayments.paymentCalendarDate,
        paymentDateSource: sql<"recorded_calendar_date" | "legacy_timestamp">`CASE WHEN ${apPayments.paymentCalendarDate} IS NULL THEN 'legacy_timestamp' ELSE 'recorded_calendar_date' END`,
        paymentMethod: apPayments.paymentMethod,
        paymentStatus: apPayments.status,
        referenceNumber: apPayments.referenceNumber,
      })
      .from(apPaymentAllocations)
      .innerJoin(apPayments, eq(apPaymentAllocations.apPaymentId, apPayments.id))
      .where(eq(apPaymentAllocations.vendorInvoiceId, id))
      .orderBy(desc(apPayments.paymentDate));

    const lines = await getInvoiceLinesWithPoQuantities(invoice.id, tx);

    const attachments = await tx
      .select()
      .from(vendorInvoiceAttachments)
      .where(eq(vendorInvoiceAttachments.vendorInvoiceId, id))
      .orderBy(desc(vendorInvoiceAttachments.uploadedAt));

    const { readInvoiceReplacementDetail } = await import("./ap-invoice-replacement.service");
    const replacementDetail = await readInvoiceReplacementDetail(tx, id);
    const sourceCapabilities = await readInvoiceSourceCapabilities(tx, id);
    const hasSupplierCreditHistory = await hasInvoiceCreditHistory(tx, id);
    return { ...invoice, ...settlement, ...replacementDetail, sourceCapabilities, hasSupplierCreditHistory, capabilities: { edit: invoiceEditCapability({ ...invoice, hasPaymentHistory: payments.length > 0 }) },
      paymentReviewRequired: payments.some((payment) => classifyApPaymentState(payment.paymentStatus) === "review_required"),
      poLinks, payments, lines: lines.map((line) => ({ ...line, costReviewVersion: invoiceCostReviewVersion(line) })), attachments };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function listInvoiceWorkList(query: InvoiceWorkListQuery, now: Date): Promise<InvoiceWorkListPage> {
  return readInvoiceWorkList(query, now);
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
  return db.transaction(async tx => {
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

  const rows = await tx
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
    const links = await tx
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

  const settlements=await readVerifiedInvoiceSettlementProjections(tx,rows.map(row=>row.invoice));
  return rows.map((r) => ({
    ...r.invoice, ...settlements.get(r.invoice.id)!,
    vendorName: r.vendorName,
    vendorCode: r.vendorCode,
    poNumbers: poLinkMap[r.invoice.id] ?? [],
  }));
  }, {isolationLevel:"repeatable read",accessMode:"read only"});
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

  const result = await runApCostTransaction(async (tx: ApLedgerDbClient) => {
    const invoice = await lockEditableInvoice(tx, invoiceId);
    const patch: Record<string, unknown> = { updatedBy: actorId, updatedAt: new Date() };
    if (data.invoiceNumber !== undefined) {
      patch.invoiceNumber = normalizeRequiredText(data.invoiceNumber, "invoiceNumber", 100);
      if (invoice.replacesInvoiceId != null && patch.invoiceNumber !== invoice.invoiceNumber) {
        throw new ApLedgerError("A replacement retains its original supplier invoice number.", 409,
          { code: "AP_INVOICE_REPLACEMENT_IDENTITY_IMMUTABLE", invoiceId });
      }
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
  await assertInvoiceSourceCapability(tx, id, "approval");
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

export type ApprovedInvoiceVarianceReconciliationResult = Awaited<ReturnType<typeof reconcilePurchaseCostEvidence>> & {
  purchaseOrderLineId: number;
  state: "confirmed_invoice_cost" | "estimated_purchase_cost" | "review_required" | "not_applicable_non_product";
  costSourceState: "confirmed" | "estimated" | "review_required" | "not_applicable";
  costApplicationState: "applied" | "review_required" | "not_applicable";
  authoritativeUnitCostMills: number | null;
  approvedInvoiceIds: number[];
  approvedQty: string;
  quantityCoverage: { basis:"gross_invoice_before_supplier_credits"; approvedPieces: string; requiredPieces: number; complete: boolean };
};

/** Delegate economic authority to exact component sources. Invoice quantity
 * coverage is retained only as a diagnostic; it cannot establish product cost. */
export async function reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(
  purchaseOrderLineId: number,
  client: ApLedgerDbClient,
  actorId?: string,
): Promise<ApprovedInvoiceVarianceReconciliationResult> {
  const normalizedPoLineId = requireCommandId(purchaseOrderLineId, "purchaseOrderLineId");
  await lockInventoryCostGraph(client);
  const [poLine] = await client.select({
    id: purchaseOrderLines.id, purchaseOrderId: purchaseOrderLines.purchaseOrderId,
    lineType: purchaseOrderLines.lineType, status: purchaseOrderLines.status,
    orderQty: purchaseOrderLines.orderQty, receivedQty: purchaseOrderLines.receivedQty,
  }).from(purchaseOrderLines).where(eq(purchaseOrderLines.id, normalizedPoLineId)).for("update");
  if (!poLine) throw new ApLedgerError("Purchase order line not found", 404, {
    code: "AP_PURCHASE_ORDER_LINE_NOT_FOUND", purchaseOrderLineId: normalizedPoLineId,
  });
  const orderQty = requireNonnegativeInteger(poLine.orderQty, "purchaseOrderLine.orderQty");
  const receivedQty = requireNonnegativeInteger(poLine.receivedQty ?? 0, "purchaseOrderLine.receivedQty");
  const costCoverageQty = ["received", "closed"].includes(poLine.status) ? receivedQty : orderQty;
  const candidateLines = await client.select({
    id: vendorInvoiceLines.id, vendorInvoiceId: vendorInvoiceLines.vendorInvoiceId,
    qtyInvoiced: vendorInvoiceLines.qtyInvoiced,
  }).from(vendorInvoiceLines).where(eq(vendorInvoiceLines.purchaseOrderLineId, normalizedPoLineId))
    .orderBy(asc(vendorInvoiceLines.vendorInvoiceId), asc(vendorInvoiceLines.id)).for("share");
  const candidateInvoiceIds = uniqueNumbers(candidateLines.map((line) => line.vendorInvoiceId));
  const invoiceRows = candidateInvoiceIds.length === 0 ? [] : await client.select({
    id: vendorInvoices.id, status: vendorInvoices.status,
  }).from(vendorInvoices).where(inArray(vendorInvoices.id, candidateInvoiceIds));
  const approvedInvoiceIds = invoiceRows.filter((invoice) => ["approved", "partially_paid", "paid"].includes(invoice.status))
    .map((invoice) => invoice.id).sort((left, right) => left - right);
  const approvedSet = new Set(approvedInvoiceIds);
  const approvedQty = candidateLines.filter((line) => approvedSet.has(Number(line.vendorInvoiceId)))
    .reduce((sum, line) => sum + BigInt(requireNonnegativeInteger(line.qtyInvoiced, `vendorInvoiceLine[${line.id}].qtyInvoiced`)), BigInt(0));
  const quantityCoverage = { basis:"gross_invoice_before_supplier_credits" as const, approvedPieces: approvedQty.toString(), requiredPieces: costCoverageQty,
    complete: costCoverageQty > 0 && approvedQty === BigInt(costCoverageQty) };
  if (poLine.lineType !== "product") {
    const result: ApprovedInvoiceVarianceReconciliationResult = {
      purchaseOrderLineId: normalizedPoLineId, state: "not_applicable_non_product", costSourceState: "not_applicable",
      costApplicationState: "not_applicable", authoritativeUnitCostMills: null, approvedInvoiceIds, approvedQty: approvedQty.toString(),
      quantityCoverage, lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0, costApplications: [], costSources: [],
    };
    await appendApMutationAudit("po_line_cost_reconciliation_skipped", `purchase_order_line:${normalizedPoLineId}`, actorId,
      { purchaseOrderId: poLine.purchaseOrderId, ...result }, client);
    return result;
  }
  const costResult = await reconcilePurchaseCostEvidence(client as any, normalizedPoLineId,
    new COGSService(client as any), actorId || "system:ap", new Date());
  const summary = summarizeInvoiceCostReconciliation(costResult);
  const result: ApprovedInvoiceVarianceReconciliationResult = { purchaseOrderLineId: normalizedPoLineId, ...summary,
    approvedInvoiceIds, approvedQty: approvedQty.toString(), quantityCoverage, ...costResult };
  await appendApMutationAudit("po_line_cost_reconciled", `purchase_order_line:${normalizedPoLineId}`, actorId,
    { purchaseOrderId: poLine.purchaseOrderId, orderQty, receivedQty, ...result }, client);
  return result;
}
export async function approveInvoice(id: number, userId?: string) {
  const mutation = await runApCostTransaction((tx: ApLedgerDbClient) =>
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
  const mutation = await runApCostTransaction((tx: ApLedgerDbClient) =>
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
  await assertInvoiceHasNoCreditHistory(tx, id);
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
  const mutation = await runApCostTransaction((tx: ApLedgerDbClient) =>
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

  const result = await runApCostTransaction(async (tx: ApLedgerDbClient) => {
    const invoice = await lockEditableInvoice(tx, normalizedInvoiceId);
    await assertInvoiceSourceCapability(tx, normalizedInvoiceId, "purchaseOrderLinks");
    await lockMatchingPurchaseOrder(tx, normalizedPoId, invoice.vendorId, invoice.currency);

    // The invoice lock serializes this relationship owner. An existing link
    // with no supplied metadata is a valid retry, not an empty UPDATE command.
    const [existingLink] = await tx.select().from(vendorInvoicePoLinks).where(and(
      eq(vendorInvoicePoLinks.vendorInvoiceId, normalizedInvoiceId),
      eq(vendorInvoicePoLinks.purchaseOrderId, normalizedPoId),
    )).for("update");
    let upserted = existingLink;
    if (!existingLink) {
      [upserted] = await tx.insert(vendorInvoicePoLinks).values({
        vendorInvoiceId: normalizedInvoiceId,
        purchaseOrderId: normalizedPoId,
        allocatedAmountCents: normalizedAllocation,
        notes: normalizedNotes,
      }).returning();
    } else if (normalizedAllocation !== undefined || normalizedNotes !== undefined) {
      [upserted] = await tx.update(vendorInvoicePoLinks).set({
        ...(normalizedAllocation === undefined ? {} : { allocatedAmountCents: normalizedAllocation }),
        ...(normalizedNotes === undefined ? {} : { notes: normalizedNotes }),
      }).where(eq(vendorInvoicePoLinks.id, existingLink.id)).returning();
    }
    if (!upserted) {
      throw new ApLedgerError("Invoice purchase-order link could not be saved", 500, {
        code: "AP_INVOICE_PO_LINK_SAVE_FAILED", invoiceId: normalizedInvoiceId, purchaseOrderId: normalizedPoId,
      });
    }

    const imported = await importLinesFromPOWithClient(normalizedInvoiceId, normalizedPoId, tx);
    await recalculateInvoiceFromLines(normalizedInvoiceId, tx);
    const affectedPoIds = await recomputeLinkedPurchaseOrders(normalizedInvoiceId, tx, {
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
        affectedPurchaseOrderIds: affectedPoIds,
        importedLineIds: imported.map((line) => line.id),
      },
      tx,
    );
    return { link: upserted, affectedPoIds };
  });

  await runPoFinancialDetectionHooksForMany(result.affectedPoIds);
  return result.link;
}

export async function unlinkPoFromInvoice(
  invoiceId: number,
  purchaseOrderId: number,
  actorId?: string,
) {
  const normalizedInvoiceId = requireCommandId(invoiceId, "invoiceId");
  const normalizedPoId = requireCommandId(purchaseOrderId, "purchaseOrderId");
  const result = await runApCostTransaction(async (tx: ApLedgerDbClient) => {
    const invoice = await lockEditableInvoice(tx, normalizedInvoiceId);
    await assertInvoiceSourceCapability(tx, normalizedInvoiceId, "purchaseOrderLinks");
    await lockMatchingPurchaseOrder(tx, normalizedPoId, invoice.vendorId, invoice.currency);
    const [existingLink] = await tx
      .select({ id: vendorInvoicePoLinks.id })
      .from(vendorInvoicePoLinks)
      .where(and(
        eq(vendorInvoicePoLinks.vendorInvoiceId, normalizedInvoiceId),
        eq(vendorInvoicePoLinks.purchaseOrderId, normalizedPoId),
      ))
      .for("update");
    if (!existingLink) return { changed: false, affectedPoIds: [] };

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
    // Recalculate both sides: remaining relationships observe the new invoice
    // total, while the removed PO must lose this invoice from its context.
    const affectedPoIds = [...new Set([
      normalizedPoId, ...await getPoIdsForInvoice(normalizedInvoiceId, tx),
    ])].sort((left, right) => left - right);
    await recomputePoFinancialAggregatesForMany(affectedPoIds, tx, {
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
        affectedPurchaseOrderIds: affectedPoIds,
      },
      tx,
    );
    return { changed: true, affectedPoIds };
  });

  await runPoFinancialDetectionHooksForMany(result.affectedPoIds);
  return { ok: true, changed: result.changed };
}

export async function getInvoicesForPo(purchaseOrderId: number) {
  return db.transaction(async tx=>{
  const links = await tx
    .select({
      link: vendorInvoicePoLinks,
      invoice: vendorInvoices,
    })
    .from(vendorInvoicePoLinks)
    .innerJoin(vendorInvoices, eq(vendorInvoicePoLinks.vendorInvoiceId, vendorInvoices.id))
    .where(eq(vendorInvoicePoLinks.purchaseOrderId, purchaseOrderId))
    .orderBy(desc(vendorInvoices.invoiceDate));

  const settlements=await readVerifiedInvoiceSettlementProjections(tx,links.map(row=>row.invoice));
  return links.map((r) => ({ ...r.invoice, ...settlements.get(r.invoice.id)!, allocatedAmountCents: r.link.allocatedAmountCents }));
  },{isolationLevel:"repeatable read",accessMode:"read only"});
}

/**
 * Phase 2: Return all ap_payments linked to a PO via the chain:
 *   vendor_invoice_po_links → vendor_invoices → ap_payment_allocations → ap_payments
 *
 * Columns: paymentDate, paymentMethod, appliedAmountCents, invoiceNumber, referenceNumber
 * Only completed settlements are returned. The invoice/payment detail retains full history.
 */
export async function getPaymentsForPo(purchaseOrderId: number) {
  // Step 1: find all vendor invoice IDs linked to this PO
  const invoiceLinks = await db
    .select({ vendorInvoiceId: vendorInvoicePoLinks.vendorInvoiceId })
    .from(vendorInvoicePoLinks)
    .where(eq(vendorInvoicePoLinks.purchaseOrderId, purchaseOrderId));

  if (invoiceLinks.length === 0) return [];

  const invoiceIds = invoiceLinks.map((l) => l.vendorInvoiceId);

  // Step 2: fetch completed payment allocations for those invoices
  const rows = await db
    .select({
      allocationId: apPaymentAllocations.id,
      apPaymentId: apPaymentAllocations.apPaymentId,
      appliedAmountCents: apPaymentAllocations.appliedAmountCents,
      vendorInvoiceId: apPaymentAllocations.vendorInvoiceId,
      invoiceNumber: vendorInvoices.invoiceNumber,
      paymentDate: apPayments.paymentDate,
        paymentCalendarDate: apPayments.paymentCalendarDate,
        paymentDateSource: sql<"recorded_calendar_date" | "legacy_timestamp">`CASE WHEN ${apPayments.paymentCalendarDate} IS NULL THEN 'legacy_timestamp' ELSE 'recorded_calendar_date' END`,
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
        eq(apPayments.status, COMPLETED_AP_PAYMENT_STATUS),
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
  if (!isRecordableApPaymentStatus(data.status)) {
    throw new ApLedgerError("Record payment only accepts completed payments. Scheduled, returned or other payment states require their own workflow.", 400, {
      code: "AP_PAYMENT_STATUS_INVALID",
    });
  }
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
  if (data.paymentCalendarDate != null) {
    const date = paymentCalendarDateSchema.safeParse(data.paymentCalendarDate);
    if (!date.success || data.paymentDate.toISOString() !== `${date.data}T00:00:00.000Z`) {
      throw new ApLedgerError("paymentCalendarDate must agree with its canonical payment date", 400, { code: "AP_PAYMENT_DATE_INVALID" });
    }
  }
  if (typeof data.paymentMethod !== "string" || !data.paymentMethod.trim() || data.paymentMethod.length > 20) {
    throw new ApLedgerError("paymentMethod must be between 1 and 20 characters", 400, {
      code: "AP_PAYMENT_METHOD_INVALID",
    });
  }
  if (!Number.isSafeInteger(data.totalAmountCents) || data.totalAmountCents <= 0) {
    throw new ApLedgerError("totalAmountCents must be a positive integer", 400, {
      code: "AP_PAYMENT_TOTAL_INVALID",
    });
  }

  for (const [field, maximum] of [["referenceNumber", 100], ["checkNumber", 50], ["bankAccountLabel", 100]] as const) {
    const value = data[field];
    if (value != null && (typeof value !== "string" || value.length > maximum))
      throw new ApLedgerError(`${field} must be text with no more than ${maximum} characters`, 400, { code: "AP_PAYMENT_METADATA_INVALID", field });
  }
  if (data.notes != null && typeof data.notes !== "string") throw new ApLedgerError("notes must be text", 400, { code: "AP_PAYMENT_METADATA_INVALID", field: "notes" });
  if (!Array.isArray(data.allocations)) throw new ApLedgerError("allocations must be an array", 400, { code: "AP_PAYMENT_ALLOCATION_INVALID" });
  const seenInvoiceIds = new Set<number>();
  for (const allocation of data.allocations) {
    if (!allocation || typeof allocation !== "object") throw new ApLedgerError("Every allocation must identify an invoice and amount", 400, { code: "AP_PAYMENT_ALLOCATION_INVALID" });
    if (allocation.notes != null && typeof allocation.notes !== "string") throw new ApLedgerError("Allocation notes must be text", 400, { code: "AP_PAYMENT_METADATA_INVALID", field: "allocations.notes" });
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
  data: Pick<RecordApPaymentInput, "vendorId" | "allocations">,
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
      invoicedAmountCents: vendorInvoices.invoicedAmountCents,paidAmountCents:vendorInvoices.paidAmountCents,creditedAmountCents:vendorInvoices.creditedAmountCents,
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
    await assertInvoiceSourceCapability(tx, invoice.id, "payment");
    const balanceCents = databaseMoneyToBigInt(
      invoice.balanceCents,
      `invoice[${invoice.id}].balanceCents`,
    );
    await assertInvoiceSettlementEvidence(tx, invoice);
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
  at: Date,
): Promise<PaymentMutationResult<any>> {
  validateRecordPaymentInput(data);
  const paymentCurrency = requireUsdFinancialDocumentCurrency(data.currency, "currency");
  try {
    await lockAndValidatePaymentInvoices(tx, data, paymentCurrency);
  } catch (error) {
    // Preserve the established new-cash rejection contract; applying existing funds
    // reports the specific evidence conflict without recording another payment.
    if (error instanceof SupplierCreditEvidenceError && error.details.code === "AP_INVOICE_PAYMENT_EVIDENCE_REVIEW") {
      throw new ApLedgerError("The payment references invalid or incompatible AP records", 422, { code: "AP_PAYMENT_REFERENCE_INVALID" });
    }
    throw error;
  }
  const paymentNumber = await generatePaymentNumber(tx, at);
  const affectedPoIds = new Set<number>();

  try {
    const [inserted] = await tx
      .insert(apPayments)
      .values({
        paymentNumber,
        vendorId: data.vendorId,
        paymentDate: data.paymentDate,
        // Legacy Date callers remain explicitly unverified; only date-only input supplies this field.
        paymentCalendarDate: data.paymentCalendarDate ?? null,
        paymentMethod: data.paymentMethod,
        referenceNumber: data.referenceNumber,
        checkNumber: data.checkNumber,
        bankAccountLabel: data.bankAccountLabel,
        totalAmountCents: data.totalAmountCents,
        currency: paymentCurrency,
        status: COMPLETED_AP_PAYMENT_STATUS,
        createdAt: at,
        updatedAt: at,
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
          createdAt: at,
          notes: a.notes,
        }))
      );

      for (const alloc of data.allocations) {
        await recalculateInvoiceBalance(alloc.vendorInvoiceId, tx, at);
        const poIds = await getPoIdsForInvoice(alloc.vendorInvoiceId, tx);
        for (const poId of poIds) affectedPoIds.add(poId);
      }

      await recomputePoFinancialAggregatesForMany(affectedPoIds, tx, {
        actorId: data.createdBy,
        reason: `AP payment ${inserted.id} recorded.`,
        now: at,
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

export async function recordPayment(data: RecordApPaymentInput, options: ApPaymentClockOptions = {}) {
  const at = requirePaymentCommandTime(options.now ?? new Date());
  validateRecordPaymentInput(data);
  const result = await runApCostTransaction((tx: ApLedgerDbClient) =>
    recordPaymentInTransaction(tx, data, at),
  );

  await runPoFinancialDetectionHooksForMany(result.affectedPoIds);

  return result.value;
}

export async function getPaymentById(id: number) {
  return db.transaction(async tx => {
    const [record] = await tx.select({ payment: apPayments, vendorName: vendors.name, vendorCode: vendors.code })
      .from(apPayments).leftJoin(vendors, eq(apPayments.vendorId, vendors.id)).where(eq(apPayments.id, id));
    if (!record) return null;
    const allocations = await tx.select({ id: apPaymentAllocations.id, vendorInvoiceId: apPaymentAllocations.vendorInvoiceId,
      appliedAmountCents: apPaymentAllocations.appliedAmountCents, notes: apPaymentAllocations.notes,
      invoiceNumber: vendorInvoices.invoiceNumber, invoiceDate: vendorInvoices.invoiceDate,
      invoicedAmountCents: vendorInvoices.invoicedAmountCents, balanceCents: vendorInvoices.balanceCents,
    }).from(apPaymentAllocations).leftJoin(vendorInvoices, eq(apPaymentAllocations.vendorInvoiceId, vendorInvoices.id))
      .where(eq(apPaymentAllocations.apPaymentId, id)).orderBy(apPaymentAllocations.id);
    const paymentBalance = (await readPaymentBalances(tx, [record.payment])).get(id)!;
    return { ...record.payment, vendorName: record.vendorName, vendorCode: record.vendorCode, allocations, paymentBalance,
      paymentDateSource: record.payment.paymentCalendarDate === null ? "legacy_timestamp" : "recorded_calendar_date" };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function listPaymentWorkList(query: PaymentWorkListQuery): Promise<PaymentWorkListPage> {
  return readPaymentWorkList(query);
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
  const conditions: SQL[] = [];

  if (filters.vendorId) conditions.push(eq(apPayments.vendorId, filters.vendorId));
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    conditions.push(inArray(apPayments.status, statuses));
  }
  if (filters.paymentMethod) conditions.push(eq(apPayments.paymentMethod, filters.paymentMethod));
  if (filters.dateFrom) conditions.push(gte(apPayments.paymentDate, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(apPayments.paymentDate, filters.dateTo));

  return db.transaction(async tx => {
    const rows = await tx.select({
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
    const balances = await readPaymentBalances(tx, rows.map(row => row.payment));
    return rows.map(row => ({ ...row, payment: { ...row.payment,
      paymentBalance: balances.get(row.payment.id)!, paymentDateSource: row.payment.paymentCalendarDate === null ? "legacy_timestamp" : "recorded_calendar_date" } }));
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function voidPaymentInTransaction(
  tx: ApLedgerDbClient,
  id: number,
  reason: string,
  userId: string | undefined,
  at: Date,
): Promise<PaymentMutationResult<{ ok: true }>> {
  const affectedPoIds = new Set<number>();
  const [payment] = await tx
    .select()
    .from(apPayments)
    .where(eq(apPayments.id, id))
    .for("update");
  if (!payment) throw new ApLedgerError("Payment not found", 404);
  if (payment.status === "voided") throw new ApLedgerError("Payment is already voided", 409);
  if (classifyApPaymentState(payment.status) === "review_required") {
    throw new ApLedgerError("This payment has an unsupported historical status. Review its evidence before changing it.", 409, {
      code: "AP_PAYMENT_STATUS_REVIEW_REQUIRED", paymentId: id,
    });
  }

  await tx
    .update(apPayments)
    .set({ status: "voided", voidedAt: at, voidedBy: userId, voidReason: reason, updatedBy: userId, updatedAt: at })
    .where(eq(apPayments.id, id));
  const affectedAllocs = await tx
    .select({ vendorInvoiceId: apPaymentAllocations.vendorInvoiceId })
    .from(apPaymentAllocations)
    .where(eq(apPaymentAllocations.apPaymentId, id))
    .orderBy(asc(apPaymentAllocations.vendorInvoiceId));

  for (const alloc of affectedAllocs) {
    await recalculateInvoiceBalance(alloc.vendorInvoiceId, tx, at);
    const poIds = await getPoIdsForInvoice(alloc.vendorInvoiceId, tx);
    for (const poId of poIds) affectedPoIds.add(poId);
  }
  await recomputePoFinancialAggregatesForMany(affectedPoIds, tx, {
    actorId: userId,
    reason: `AP payment ${id} voided.`,
    now: at,
  });

  return { value: { ok: true }, affectedPoIds: [...affectedPoIds] };
}

export async function voidPayment(id: number, reason: string, userId?: string, options: ApPaymentClockOptions = {}) {
  const at = requirePaymentCommandTime(options.now ?? new Date());
  const result = await runApCostTransaction((tx: ApLedgerDbClient) =>
    voidPaymentInTransaction(tx, id, reason, userId, at),
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
  if (typeof reason !== "string" || !reason.trim() || reason.length > 2000) {
    throw new ApLedgerError("reason must contain between 1 and 2000 characters", 400, { code: "AP_COMMAND_REASON_INVALID" });
  }
  return reason.trim();
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
  await lockInventoryCostGraph(tx as any);
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

/** Apply already-recorded cash. Application rows are append-only, including repeated invoice targets. */
async function applyRecordedPaymentInTransaction(tx: ApLedgerDbClient, paymentId: number, input: ApLedgerCommandInput, at: Date) {
  const parsed = paymentApplicationInputSchema.safeParse(input.application);
  if (!parsed.success) throw new ApLedgerError("Review the payment application amounts and reason.", 400,
    { code: "AP_PAYMENT_APPLICATION_INVALID", issues: parsed.error.issues });
  const application = parsed.data;
  const actorId = input.userId;
  if (!actorId) throw new ApLedgerError("An authenticated operator is required.", 403, { code: "AP_PAYMENT_AUTHORITY_REQUIRED" });
  const [payment] = await tx.select().from(apPayments).where(eq(apPayments.id, paymentId)).for("update");
  if (!payment) throw new ApLedgerError("Payment not found.", 404, { code: "AP_PAYMENT_NOT_FOUND" });
  const before = (await readPaymentBalances(tx, [payment])).get(paymentId)!;
  if (before.state === "review_required") throw new ApLedgerError(before.issue!.message, 409, { code: before.issue!.code });
  if (before.version !== application.expectedVersion) throw new ApLedgerError("Payment evidence changed. Reload its balance and review the application.", 409, { code: "AP_PAYMENT_VERSION_CONFLICT" });
  if (before.state !== "available") throw new ApLedgerError("This payment has no available funds to apply.", 409, { code: "AP_PAYMENT_NO_AVAILABLE_FUNDS" });
  const requestedTotal = application.allocations.reduce((sum, row) => sum + BigInt(row.appliedAmountCents), BigInt(0));
  if (requestedTotal > BigInt(before.unappliedAmountCents!)) throw new ApLedgerError("Applications exceed the payment's remaining funds.", 409, { code: "AP_PAYMENT_APPLICATION_EXCEEDS_REMAINDER" });
  const allocations = [...application.allocations].sort((a, b) => a.vendorInvoiceId - b.vendorInvoiceId);
  await lockAndValidatePaymentInvoices(tx, { vendorId: payment.vendorId, allocations }, payment.currency);
  // Cached balances are not spending authority. Check them against immutable settlement evidence while invoice locks are held.
  const targetIds = allocations.map(row => row.vendorInvoiceId);
  const targets = await tx.select().from(vendorInvoices).where(inArray(vendorInvoices.id, targetIds)).orderBy(vendorInvoices.id);
  for (const invoice of targets) await assertInvoiceSettlementEvidence(tx, invoice);
  const applications = await tx.insert(apPaymentAllocations).values(allocations.map(row => ({ apPaymentId: paymentId,
    vendorInvoiceId: row.vendorInvoiceId, appliedAmountCents: row.appliedAmountCents, notes: application.reason, createdAt: at })))
    .returning({ allocationId: apPaymentAllocations.id, vendorInvoiceId: apPaymentAllocations.vendorInvoiceId, appliedAmountCents: apPaymentAllocations.appliedAmountCents });
  const poIds = new Set<number>();
  for (const row of allocations) {
    await recalculateInvoiceBalance(row.vendorInvoiceId, tx, at);
    for (const poId of await getPoIdsForInvoice(row.vendorInvoiceId, tx)) poIds.add(poId);
  }
  await recomputePoFinancialAggregatesForMany(poIds, tx, { actorId, reason: `Existing payment ${paymentId} applied. ${application.reason}`, now: at });
  const after = (await readPaymentBalances(tx, [payment])).get(paymentId)!;
  if (after.state === "review_required") throw new Error("Payment application produced inconsistent balance evidence.");
  const apLedgerOutcome = buildApLedgerOutcome({ command: "apply_payment", entityType: "payment", entityId: paymentId,
    affectedInvoiceIds: targetIds, affectedPaymentIds: [paymentId], affectedPurchaseOrderIds: [...poIds] });
  await appendApMutationAudit("apply_payment", `payment:${paymentId}`, actorId,
    { ...apLedgerOutcome, reason: application.reason, before, after, applications }, tx, at);
  return { applications, paymentBalance: after, apLedgerOutcome };
}

export type ApPaymentFinancialCommand = "record_payment" | "apply_payment" | "void_payment";

/**
 * Apply a cash-moving AP command using the caller's transaction. The payment,
 * allocations, invoice/PO balances, command audit, and durable HTTP result can
 * therefore commit or roll back as one unit under the financial command ledger.
 */
export async function executeApPaymentCommandInTransaction(
  command: ApPaymentFinancialCommand,
  input: ApPaymentCommandInput,
  tx: ApLedgerDbClient,
) {
  const at = requirePaymentCommandTime(input.now);
  await lockInventoryCostGraph(tx as any);
  const actor = input.userId ?? input.payment?.createdBy;
  if (!actor) throw new ApLedgerError("An authenticated operator is required.", 403, { code: "AP_PAYMENT_AUTHORITY_REQUIRED" });
  const authority = await readCommandAuthorityActor(tx, actor);
  if (!authority.active || !authority.permissions.includes("purchasing:approve"))
    throw new ApLedgerError("Current purchasing approval permission is required for payment commands.", 403, { code: "AP_PAYMENT_AUTHORITY_REQUIRED" });

  if (command === "record_payment") {
    if (!input.payment) throw new ApLedgerError("payment is required");
    const mutation = await recordPaymentInTransaction(tx, input.payment, at);
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
    await appendApLedgerCommandAudit(outcome, actor, tx, at);
    const applications = await tx.select({ allocationId: apPaymentAllocations.id, vendorInvoiceId: apPaymentAllocations.vendorInvoiceId,
      appliedAmountCents: apPaymentAllocations.appliedAmountCents }).from(apPaymentAllocations)
      .where(eq(apPaymentAllocations.apPaymentId, mutation.value.id)).orderBy(apPaymentAllocations.id);
    const paymentBalance = (await readPaymentBalances(tx, [mutation.value])).get(mutation.value.id)!;
    return attachApLedgerOutcome({ ...mutation.value, applications, paymentBalance,
      paymentDateSource: mutation.value.paymentCalendarDate == null ? "legacy_timestamp" : "recorded_calendar_date" }, outcome);
  }

  const paymentId = requireCommandId(input.paymentId, "paymentId");
  if (command === "apply_payment") return applyRecordedPaymentInTransaction(tx, paymentId, input, at);
  const affectedInvoiceIds = await getInvoiceIdsForPayment(paymentId, tx);
  const mutation = await voidPaymentInTransaction(
    tx,
    paymentId,
    requireCommandReason(input.reason),
    input.userId,
    at,
  );
  const outcome = buildApLedgerOutcome({
    command,
    entityType: "payment",
    entityId: paymentId,
    affectedInvoiceIds,
    affectedPaymentIds: [paymentId],
    affectedPurchaseOrderIds: mutation.affectedPoIds,
  });
  await appendApLedgerCommandAudit(outcome, actor, tx, at);
  return { ok: true, status: "voided" as const, apLedgerOutcome: outcome };
}

export async function runApPaymentCommandPostCommit(
  outcome: ApLedgerCommandOutcome,
): Promise<void> {
  await runPoFinancialDetectionHooksForMany(outcome.affectedPurchaseOrderIds);
}

export async function getApSummary(options: { now?: Date } = {}) {
  const requestedNow = options.now ?? new Date();
  const nowEpoch = requestedNow instanceof Date ? requestedNow.getTime() : Number.NaN;
  if (!Number.isFinite(nowEpoch)) {
    throw new ApLedgerError("AP summary clock is invalid", 500, {
      code: "AP_SUMMARY_CLOCK_INVALID",
    });
  }
  // Capture the caller's instant before awaiting a connection. All summary
  // balances, activity and aggregates need the same snapshot and aging clock.
  const now = new Date(nowEpoch);
  return db.transaction(
    tx => readApSummaryInSnapshot(tx, now),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function readApSummaryInSnapshot(
  tx: Pick<ApLedgerDbClient, "select" | "execute">,
  now: Date,
) {
  const openStatuses = ["received", "approved", "partially_paid", "disputed"];

  const allOpen = await tx
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
  let disputedOutstanding = BigInt(0);
  let disputedInvoiceCount = 0;

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
    if (inv.status === "disputed") {
      disputedOutstanding += balance;
      disputedInvoiceCount += 1;
    }

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
    tx.select({ total: sql<number>`COALESCE(SUM(${apPayments.totalAmountCents}), 0)` })
      .from(apPayments)
      .where(and(eq(apPayments.status, COMPLETED_AP_PAYMENT_STATUS), gte(apPayments.paymentDate, startOfMonth))),
    tx.select({ total: sql<number>`COALESCE(SUM(${apPayments.totalAmountCents}), 0)` })
      .from(apPayments)
      .where(eq(apPayments.status, COMPLETED_AP_PAYMENT_STATUS)),
  ]);

  const paidThisMonthCents = bigintMoneyToNumber(
    databaseMoneyToBigInt(paidThisMonthResult[0]?.total ?? 0, "paidThisMonthCents"),
    "paidThisMonthCents",
  );
  const paidAllTimeCents = bigintMoneyToNumber(
    databaseMoneyToBigInt(paidAllTimeResult[0]?.total ?? 0, "paidAllTimeCents"),
    "paidAllTimeCents",
  );

  const creditTotals=await tx.execute(sql`SELECT coalesce(sum(a.applied_amount_cents),0) AS total
    FROM procurement.supplier_credit_applications a JOIN procurement.supplier_credits c ON c.id=a.supplier_credit_id
    LEFT JOIN procurement.supplier_credit_application_reversals r ON r.application_id=a.id WHERE c.status='approved' AND r.id IS NULL`);
  const creditedAllTimeCents=bigintMoneyToNumber(databaseMoneyToBigInt(creditTotals.rows[0]?.total??0,"creditedAllTimeCents"),"creditedAllTimeCents");
  // Recent payments (last 10)
  const recentPayments = await tx
    .select({
      id: apPayments.id,
      paymentNumber: apPayments.paymentNumber,
      vendorName: vendors.name,
      paymentDate: apPayments.paymentDate,
        paymentCalendarDate: apPayments.paymentCalendarDate,
        paymentDateSource: sql<"recorded_calendar_date" | "legacy_timestamp">`CASE WHEN ${apPayments.paymentCalendarDate} IS NULL THEN 'legacy_timestamp' ELSE 'recorded_calendar_date' END`,
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
  const recentlyPaid = await tx
    .select({
      id: vendorInvoices.id,
      invoiceNumber: vendorInvoices.invoiceNumber,
      vendorName: vendors.name,
      invoicedAmountCents: vendorInvoices.invoicedAmountCents,
      paidAmountCents: vendorInvoices.paidAmountCents,
      creditedAmountCents: vendorInvoices.creditedAmountCents,
      updatedAt: vendorInvoices.updatedAt,
    })
    .from(vendorInvoices)
    .leftJoin(vendors, eq(vendorInvoices.vendorId, vendors.id))
    .where(eq(vendorInvoices.status, "paid"))
    .orderBy(desc(vendorInvoices.updatedAt))
    .limit(10);

  return {
    totalOutstandingCents: bigintMoneyToNumber(totalOutstanding, "totalOutstandingCents"),
    disputedOutstandingCents: bigintMoneyToNumber(disputedOutstanding, "disputedOutstandingCents"),
    disputedInvoiceCount,
    overdueCents: bigintMoneyToNumber(overdue, "overdueCents"),
    dueSoonCents: bigintMoneyToNumber(dueSoon, "dueSoonCents"),
    paidThisMonthCents,
    paidAllTimeCents,creditedAllTimeCents,
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
    const unitCostMills = readIntegerMills(pol.unitCostMills ?? centsToMills(readIntegerCents(pol.unitCostCents ?? 0, "unit cost")), "unit cost", true);
    const unitCostCents = millsToCents(unitCostMills);
    const qty = pol.orderQty;
    // Use the actual PO line total — it includes discounts + tax, no recomputation
    const lineTotal = pol.lineTotalCents != null
      ? readIntegerCents(pol.lineTotalCents, "line total", true)
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
        costComponentEvidence: pol.lineType === "product" && pol.totalProductCostCents != null && pol.packagingCostCents != null ? {
          contractVersion: 1, packagingTreatment: "separate", source: "purchase_order_import",
          productMills: costInteger((BigInt(costInteger(pol.totalProductCostCents, "po.productCents")) * BigInt(100)).toString(), "invoice.productMills"),
          packagingMills: costInteger((BigInt(costInteger(pol.packagingCostCents, "po.packagingCents")) * BigInt(100)).toString(), "invoice.packagingMills"),
          adjustmentMills: costInteger(((BigInt(costInteger(lineTotal, "lineTotal")) - BigInt(costInteger(pol.totalProductCostCents, "po.productCents")) - BigInt(costInteger(pol.packagingCostCents, "po.packagingCents"))) * BigInt(100)).toString(), "invoice.adjustmentMills", -Number.MAX_SAFE_INTEGER),
        } : null,
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
  const result = await runApCostTransaction(async (tx: ApLedgerDbClient) => {
    const invoice = await lockEditableInvoice(tx, normalizedInvoiceId);
    await assertInvoiceSourceCapability(tx, normalizedInvoiceId, "purchaseOrderLinks");
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
    const affectedPoIds = await recomputeLinkedPurchaseOrders(normalizedInvoiceId, tx, {
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
        affectedPurchaseOrderIds: affectedPoIds,
        importedLineIds: imported.map((line) => line.id),
      },
      tx,
    );
    return { lines: imported, affectedPoIds };
  });

  await runPoFinancialDetectionHooksForMany(result.affectedPoIds);
  return result.lines;
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

  const result = await runApCostTransaction(async (tx: ApLedgerDbClient) => {
    await lockEditableInvoice(tx, normalizedInvoiceId);
    if (purchaseOrderLineId !== undefined || productVariantId !== undefined) await assertInvoiceSourceCapability(tx, normalizedInvoiceId, "purchaseOrderLinks");
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
  lineTotalCents?: number;
  description?: string;
  notes?: string;
}, actorId?: string) {
  rejectUnexpectedFields(data as Record<string, unknown>, new Set([
    "qtyInvoiced",
    "unitCostCents",
    "unitCostMills",
    "lineTotalCents",
    "description",
    "notes",
  ]), "invoice line update");
  // This route receives raw JSON. Do not let Number(null), booleans, or
  // strings masquerade as a price/quantity change (notably legacy null mills).
  for (const field of ["qtyInvoiced", "unitCostCents", "unitCostMills", "lineTotalCents"] as const) {
    const value = data[field];
    if (value === undefined) continue;
    const positive = field === "qtyInvoiced";
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
      throw new ApLedgerError(
        `${field} must be a ${positive ? "positive" : "non-negative"} safe integer number`,
        400,
        { code: positive ? "AP_INPUT_POSITIVE_INTEGER_REQUIRED" : "AP_INPUT_NONNEGATIVE_INTEGER_REQUIRED", field },
      );
    }
  }
  const providedFields = Object.keys(data).filter(
    (field) => (data as Record<string, unknown>)[field] !== undefined,
  );
  if (providedFields.length === 0) {
    throw new ApLedgerError("Invoice line update requires at least one field", 400, {
      code: "AP_INVOICE_LINE_UPDATE_EMPTY",
    });
  }
  const normalizedLineId = requireCommandId(lineId, "lineId");
  const result = await runApCostTransaction(async (tx: ApLedgerDbClient) => {
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

    const qtyInvoiced = data.qtyInvoiced ?? existing.qtyInvoiced;
    const suppliedCents = data.unitCostCents;
    const suppliedMills = data.unitCostMills;
    const unchangedMills = suppliedMills === undefined
      || suppliedMills === existing.unitCostMills
      || (existing.unitCostMills == null
        && Number.isSafeInteger(existing.unitCostCents)
        && BigInt(suppliedMills) === BigInt(existing.unitCostCents) * BigInt(100));
    const economicsChanged = qtyInvoiced !== existing.qtyInvoiced
      || (suppliedCents !== undefined && suppliedCents !== existing.unitCostCents)
      || !unchangedMills
      || (data.lineTotalCents !== undefined && data.lineTotalCents !== existing.lineTotalCents);
    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    // Imported totals can include packaging, tax, discounts, and exact-cent
    // residuals that unit price * quantity cannot reconstruct. Metadata edits
    // and unchanged form echoes must also preserve legacy null/stale mirrors.
    // Only an actual economic change follows the existing repricing path.
    if (economicsChanged) {
      const normalizedCost = suppliedCents === undefined && suppliedMills === undefined
        ? normalizeUnitCost({
          unitCostCents: existing.unitCostCents,
          unitCostMills: existing.unitCostMills ?? undefined,
        })
        : normalizeUnitCost({ unitCostCents: suppliedCents, unitCostMills: suppliedMills });
      const oldUnitMills = existing.unitCostMills ?? centsToMills(existing.unitCostCents);
      const oldUnitExtendedCents = computeLineTotalCentsFromMills(oldUnitMills, existing.qtyInvoiced);
      if (data.lineTotalCents === undefined && oldUnitExtendedCents !== existing.lineTotalCents) {
        throw new ApLedgerError("This invoice line contains an extended amount that its unit price does not explain. Supply the reviewed line total with an economic edit.", 422,
          { code: "AP_INVOICE_EXTENDED_TOTAL_REQUIRED", existingLineTotalCents: existing.lineTotalCents });
      }
      Object.assign(updates, {
        qtyInvoiced,
        unitCostCents: normalizedCost.unitCostCents,
        unitCostMills: normalizedCost.unitCostMills,
        lineTotalCents: data.lineTotalCents ?? computeLineTotalCentsFromMills(normalizedCost.unitCostMills, qtyInvoiced),
        costComponentEvidence: null,
        matchStatus: "pending",
      });
    }
    const metadataBefore: Record<string, string | null> = {};
    const metadataAfter: Record<string, string | null> = {};
    if (data.description !== undefined) {
      metadataBefore.description = existing.description;
      metadataAfter.description = normalizeOptionalText(data.description, "description", 10_000) ?? null;
      updates.description = metadataAfter.description;
    }
    if (data.notes !== undefined) {
      metadataBefore.notes = existing.notes;
      metadataAfter.notes = normalizeOptionalText(data.notes, "notes", 10_000) ?? null;
      updates.notes = metadataAfter.notes;
    }

    const [updated] = await tx
      .update(vendorInvoiceLines)
      .set(updates)
      .where(eq(vendorInvoiceLines.id, normalizedLineId))
      .returning();
    let affectedPoIds: number[] = [];
    if (economicsChanged) {
      await recalculateInvoiceFromLines(existing.vendorInvoiceId, tx);
      affectedPoIds = await recomputeLinkedPurchaseOrders(existing.vendorInvoiceId, tx, {
        actorId,
        reason: `Invoice line ${normalizedLineId} updated.`,
      });
    }
    await appendApMutationAudit(
      "invoice_line_updated",
      `invoice:${existing.vendorInvoiceId}`,
      actorId,
      {
        invoiceId: existing.vendorInvoiceId,
        invoiceLineId: normalizedLineId,
        affectedPoIds,
        economicsChanged,
        economicsBefore: {
          qtyInvoiced: existing.qtyInvoiced,
          unitCostCents: existing.unitCostCents,
          unitCostMills: existing.unitCostMills,
          lineTotalCents: existing.lineTotalCents,
          costComponentEvidence: existing.costComponentEvidence,
          matchStatus: existing.matchStatus,
        },
        economicsAfter: {
          qtyInvoiced: updated.qtyInvoiced,
          unitCostCents: updated.unitCostCents,
          unitCostMills: updated.unitCostMills,
          lineTotalCents: updated.lineTotalCents,
          costComponentEvidence: updated.costComponentEvidence,
          matchStatus: updated.matchStatus,
        },
        metadataBefore,
        metadataAfter,
      },
      tx,
    );
    return { updated, affectedPoIds };
  });

  await runPoFinancialDetectionHooksForMany(result.affectedPoIds);
  return result.updated;
}

export async function removeInvoiceLine(lineId: number, actorId?: string) {
  const normalizedLineId = requireCommandId(lineId, "lineId");
  const affectedPoIds = await runApCostTransaction(async (tx: ApLedgerDbClient) => {
    const [lineReference] = await tx
      .select({
        vendorInvoiceId: vendorInvoiceLines.vendorInvoiceId,
        freightCostId: vendorInvoiceLines.freightCostId,
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
    if (lineReference.freightCostId !== null) throw new ApLedgerError(
      "Shipment source lines are retained billing evidence. Void the invoice and use its reviewed replacement workflow.",
      409, { code: "AP_SHIPMENT_INVOICE_SOURCE_IMMUTABLE", lineId: normalizedLineId });
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
  at: Date = new Date(),
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
  const balance = linesTotalCents - paidAmountCents - requireNonnegativeInteger(inv.creditedAmountCents,`invoice[${invoiceId}].creditedAmountCents`);

  await client
    .update(vendorInvoices)
    .set({
      invoicedAmountCents: linesTotalCents,
      balanceCents: Math.max(0, balance),
      updatedAt: at,
    })
    .where(eq(vendorInvoices.id, invoiceId));
}

/** Recalculate an explicitly approved invoice revision inside its existing
 * command transaction. Payments, receiving, stock and cost applications are
 * untouched; cost evidence review remains a separate operation. */
export async function recalculateCorrectedInvoiceFinancialsInTransaction(
  invoiceId: number, client: ApLedgerDbClient, actorId: string, at: Date,
): Promise<void> {
  requireCommandId(invoiceId, "invoiceId");
  await recalculateInvoiceFromLines(invoiceId, client, at);
  await recalculateInvoiceBalance(invoiceId, client, at);
  await recomputeLinkedPurchaseOrders(invoiceId, client, {
    actorId, now: at, reason: `Administrator corrected invoice ${invoiceId}.`,
  });
}

// ─── 3-Way Match ──────────────────────────────────────────────────────────────

type PersistedInvoiceMatchResult = ReturnType<typeof evaluatePurchaseOrderInvoiceMatches>[number];

async function persistInvoiceMatchResults(
  client: ApLedgerDbClient,
  results: PersistedInvoiceMatchResult[],
  actorId?: string,
  context: Record<string, unknown> = {},
  evaluatedAt = new Date(),
): Promise<void> {
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
  evaluatedAt = new Date(),
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
  }, evaluatedAt);

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
  const updatedLines = await runApCostTransaction(async (tx: ApLedgerDbClient) => {
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

async function assertInvoiceEvidenceNotReplaced(client: ApLedgerDbClient, invoiceId: number): Promise<void> {
  const [successor] = await client.select({ id: vendorInvoices.id }).from(vendorInvoices)
    .where(eq(vendorInvoices.replacesInvoiceId, invoiceId)).limit(1);
  if (successor) throw new ApLedgerError("The replaced invoice is retained as historical evidence. Open its successor to make changes.", 409,
    { code: "AP_INVOICE_REPLACEMENT_HISTORY_IMMUTABLE", invoiceId, successorInvoiceId: successor.id });
}

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

  return runApCostTransaction(async (tx: ApLedgerDbClient) => {
    const [invoice] = await tx
      .select({ id: vendorInvoices.id })
      .from(vendorInvoices)
      .where(eq(vendorInvoices.id, normalizedInvoiceId))
      .for("update");
    if (!invoice) {
      throw new ApLedgerError("Invoice not found", 404, { code: "AP_INVOICE_NOT_FOUND" });
    }
    await assertInvoiceEvidenceNotReplaced(tx, normalizedInvoiceId);
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
  return runApCostTransaction(async (tx: ApLedgerDbClient) => {
    const [attachment] = await tx
      .select()
      .from(vendorInvoiceAttachments)
      .where(eq(vendorInvoiceAttachments.id, normalizedAttachmentId))
      .for("update");
    if (!attachment) return null;
    await assertInvoiceEvidenceNotReplaced(tx, attachment.vendorInvoiceId);
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
async function readUnbilledShipmentCosts(client: ApLedgerDbClient, shipmentId: number, vendorId?: number) {
  const rows = await client.select({ cost: inboundFreightCosts, vendorDisplayName: vendors.name })
    .from(inboundFreightCosts).leftJoin(vendors, eq(vendors.id, inboundFreightCosts.vendorId))
    .where(and(eq(inboundFreightCosts.inboundShipmentId, shipmentId),
      ...(vendorId === undefined ? [] : [eq(inboundFreightCosts.vendorId, vendorId)])))
    .orderBy(asc(inboundFreightCosts.id));
  const ownership = await readShipmentBillingOwnership(client, rows.map(row => row.cost));
  return rows.flatMap(row => {
    const billingOwnership = ownership.get(row.cost.id)!;
    return billingOwnership.canCreateInvoice ? [{ ...row.cost, vendorDisplayName: row.vendorDisplayName, billingOwnership }] : [];
  });
}

export async function getCostVendorsForShipment(shipmentId: number) {
  return db.transaction(async tx => {
    const costs = await readUnbilledShipmentCosts(tx, requireCommandId(shipmentId, "shipmentId"));
    const groups = new Map<number, { vendorId: number; vendorName: string; unbilledCostCount: number; total: bigint }>();
    for (const cost of costs) {
      if (cost.vendorId === null || cost.vendorDisplayName === null) continue;
      const group = groups.get(cost.vendorId) ?? { vendorId: cost.vendorId, vendorName: cost.vendorDisplayName, unbilledCostCount: 0, total: BigInt(0) };
      group.unbilledCostCount++;
      group.total += databaseMoneyToBigInt(cost.actualCents ?? cost.estimatedCents ?? 0, "shipmentCost.amountCents");
      groups.set(cost.vendorId, group);
    }
    return { vendors: [...groups.values()].sort((a, b) => a.vendorName.localeCompare(b.vendorName)).map(({ total, ...group }) => ({
      ...group, unbilledTotalCents: bigintMoneyToNumber(total, "shipmentCosts.unbilledTotalCents"),
    })) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Candidate availability is the same source ownership decision used by writes. */
export async function listCostsForInvoiceCreation(shipmentId: number, vendorId: number) {
  return db.transaction(tx => readUnbilledShipmentCosts(tx,
    requireCommandId(shipmentId, "shipmentId"), requireCommandId(vendorId, "vendorId")),
  { isolationLevel: "repeatable read", accessMode: "read only" });
}

/**
 * Create an invoice from a shipment's unbilled cost rows for a specific vendor.
 * Race-safe: uses SELECT ... FOR UPDATE on candidate rows inside a transaction.
 *
 * Mirrors the addLinesFromPO pattern from shipment-tracking.service.ts.
 */
export type CreateShipmentCostInvoiceInput = {
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
  };

export async function createInvoiceFromShipmentCosts(shipmentId: number, data: CreateShipmentCostInvoiceInput, actorId?: string) {
  const now = new Date();
  return runApCostTransaction(tx => createInvoiceFromShipmentCostsInTransaction(tx, shipmentId, data, actorId, now));
}

export async function createInvoiceFromShipmentCostsInTransaction(tx: ApLedgerDbClient, shipmentId: number,
  data: CreateShipmentCostInvoiceInput, actorId: string | undefined, now: Date) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new ApLedgerError("A valid invoice command clock is required", 500);
  await lockInventoryCostGraph(tx);
  rejectUnexpectedFields(data as Record<string, unknown>, new Set([
    "vendorId",
    "invoiceNumber",
    "invoiceDate",
    "dueDate",
    "costRowIds",
    "lineOverrides",
    "notes",
  ]), "shipment cost invoice create");
  const normalizedShipmentId = requireCommandId(shipmentId, "shipmentId");
  const vendorId = requireCommandId(data.vendorId, "vendorId");
  const invoiceNumber = normalizeRequiredText(data.invoiceNumber, "invoiceNumber", 100);
  const invoiceDateInput = normalizeOptionalDate(data.invoiceDate, "invoiceDate");
  const dueDateInput = normalizeOptionalDate(data.dueDate, "dueDate");
  const notes = normalizeOptionalText(data.notes, "notes", 10_000);
  if (data.costRowIds !== undefined && !Array.isArray(data.costRowIds)) throw new ApLedgerError("costRowIds must be an array", 400);
  if (data.lineOverrides !== undefined && !Array.isArray(data.lineOverrides)) throw new ApLedgerError("lineOverrides must be an array", 400);
  const requestedCostIds = data.costRowIds === undefined
    ? undefined
    : [...new Set(data.costRowIds.map((id) => requireCommandId(id, "costRowIds[]")))]
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
               performed_by_name, vendor_id, vendor_invoice_id, cost_status, currency, inbound_shipment_id
        FROM procurement.inbound_freight_costs
        WHERE inbound_shipment_id = ${normalizedShipmentId}
          AND vendor_id = ${vendorId}
          AND vendor_invoice_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines source WHERE source.freight_cost_id=procurement.inbound_freight_costs.id)
          AND id = ANY(ARRAY[${sql.join(requestedCostIds, sql`, `)}]::integer[])
        ORDER BY id
        FOR UPDATE
      `);
    } else {
      lockedRows = await tx.execute(sql`
        SELECT id, cost_type, description, actual_cents, estimated_cents,
               performed_by_name, vendor_id, vendor_invoice_id, cost_status, currency, inbound_shipment_id
        FROM procurement.inbound_freight_costs
        WHERE inbound_shipment_id = ${normalizedShipmentId}
          AND vendor_id = ${vendorId}
          AND vendor_invoice_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines source WHERE source.freight_cost_id=procurement.inbound_freight_costs.id)
        ORDER BY id
        FOR UPDATE
      `);
    }

    const costs = lockedRows.rows as any[];
    const ownership = await readShipmentBillingOwnership(tx, costs.map(cost => ({ id: cost.id,
      inboundShipmentId: cost.inbound_shipment_id, vendorId: cost.vendor_id,
      vendorInvoiceId: cost.vendor_invoice_id, currency: cost.currency, actualCents:cost.actual_cents,estimatedCents:cost.estimated_cents })));
    const blocked = costs.filter(cost => !ownership.get(cost.id)?.canCreateInvoice);
    if (blocked.length) throw new ApLedgerError("Selected charges have existing or ambiguous invoice ownership. Review their source invoices.", 409,
      { code: "AP_SHIPMENT_BILLING_REVIEW_REQUIRED", costIds: blocked.map(cost => cost.id) });


    if (costs.length === 0) {
      throw new ApLedgerError("No available unbilled cost rows found for this vendor on this shipment", requestedCostIds ? 409 : 400,
        { code: requestedCostIds ? "AP_SHIPMENT_COST_SELECTION_STALE" : "AP_SHIPMENT_COST_SELECTION_EMPTY" });
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
      const override = overrideMap.get(costId);
      const recordedAmount = cost.actual_cents ?? cost.estimated_cents;
      if (override === undefined && (recordedAmount === null || recordedAmount === undefined)) {
        throw new ApLedgerError("This charge has no recorded amount. Enter an explicit invoice line amount before creating the invoice.", 422,
          { code: "AP_SHIPMENT_COST_AMOUNT_REQUIRED", shipmentCostId: costId });
      }
      const label = String(cost.cost_type).replace(/_/g, " ");
      const defaultDescription = `${label}: ${cost.performed_by_name || vendor.name}`;

      const qtyInvoiced = override?.qtyInvoiced ?? 1;
      const unitCostMills = override?.unitCostMills ?? centsToMills(
        requireNonnegativeInteger(recordedAmount, `shipmentCost[${cost.id}].amountCents`));
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
    const totalCents = readIntegerCents(totalCentsBigInt, "invoice total", true);

    // ── 5. Insert vendor_invoices row ──
    const invoiceDate = invoiceDateInput ?? now;
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
          receivedDate: now,
          dueDate: dueDate ?? null,
          invoicedAmountCents: totalCents,
          balanceCents: totalCents,
          paidAmountCents: 0,
          currency: "USD",
          notes: notes ?? null,
          createdBy: actorId,
          updatedBy: actorId, createdAt: now, updatedAt: now,
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
        matchStatus: "matched", createdAt: now, updatedAt: now,
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
          updated_at = ${now}
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
      tx, now,
    );

    return {
      ...invoiceRow,
      lines,
      inboundShipmentId: normalizedShipmentId,
    };
}


/**
 * Get payment status for each shipment cost + summary totals.
 */
export async function getShipmentCostPaymentStatus(shipmentId: number) {
  return db.transaction(async tx => {
  const costs = await tx
    .select({
      costId: inboundFreightCosts.id,
      vendorId: inboundFreightCosts.vendorId, currency: inboundFreightCosts.currency,
      inboundShipmentId: inboundFreightCosts.inboundShipmentId,
      costType: inboundFreightCosts.costType,
      description: inboundFreightCosts.description,
      performedByName: inboundFreightCosts.performedByName,
      performedByVendorId: inboundFreightCosts.performedByVendorId,
      actualCents: inboundFreightCosts.actualCents,
      estimatedCents: inboundFreightCosts.estimatedCents,
      vendorInvoiceId: inboundFreightCosts.vendorInvoiceId,
      invoiceStatus: vendorInvoices.status,
      invoiceNumber: vendorInvoices.invoiceNumber,
      invoicedAmountCents: vendorInvoices.invoicedAmountCents,
      paidAmountCents: vendorInvoices.paidAmountCents,
      creditedAmountCents: vendorInvoices.creditedAmountCents,
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

  const ownership = await readShipmentBillingOwnership(tx, costs.map(cost => ({ ...cost, id: cost.costId })));
  if (costs.some(cost => ownership.get(cost.costId)?.state === "review_required")) {
    throw new ApLedgerError("Shipment payment totals are unavailable until conflicting invoice ownership is reviewed.", 409,
      { code: "AP_SHIPMENT_BILLING_REVIEW_REQUIRED", shipmentId });
  }
  let totalCents = 0;
  let linkedCents = 0;
  let paidCents = 0; let creditedCents = 0;
  let outstandingCents = 0;

  // Shipment costs may include signed credits (for example, a seller
  // promotion). Preserve their sign in the payment projection so its totals
  // reconcile to the same net amount used by shipment costing.
  const normalizedCosts = costs.map((cost, index) => ({
    ...cost,
    amountCents: requireSignedInteger(
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
    let costPaidCents = 0; let costCreditedCents = 0;
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

    if(c.vendorInvoiceId && c.invoiceStatus!=="voided" && (c.creditedAmountCents??0)>0){
      const invoiceCosts=normalizedCosts.filter(row=>row.vendorInvoiceId===c.vendorInvoiceId);
      if(invoiceCosts.length!==1||amount!==c.invoicedAmountCents)throw new ApLedgerError("Invoice credit settlement has no exact split across its shipment charges. Review the original invoice application.",409,{code:"AP_SHIPMENT_CREDIT_ATTRIBUTION_REQUIRED",shipmentId});
      costPaidCents=requireNonnegativeInteger(c.paidAmountCents,"shipment.invoice.cash");costCreditedCents=requireNonnegativeInteger(c.creditedAmountCents,"shipment.invoice.credit");
      costOutstandingCents=amount-costPaidCents-costCreditedCents;
      if(costOutstandingCents<0)throw new ApLedgerError("Shipment invoice settlement exceeds its amount.",409,{code:"AP_SHIPMENT_CREDIT_EVIDENCE_REVIEW"});
    }
    creditedCents+=costCreditedCents;
    paidCents += costPaidCents;
    outstandingCents += costOutstandingCents;

    return {
      costId: c.costId,
      billingOwnership: ownership.get(c.costId)!,
      costType: c.costType,
      description: c.description,
      performedByName: c.performedByName,
      performedByVendorId: c.performedByVendorId,
      amountCents: amount,
      vendorInvoiceId: c.vendorInvoiceId,
      invoiceNumber: c.invoiceNumber,
      invoiceStatus: c.invoiceStatus,
      paymentStatus,
      paidCents: costPaidCents, creditedCents:costCreditedCents,
      outstandingCents: costOutstandingCents,
    };
  });

  if (paidCents + creditedCents + outstandingCents !== totalCents) {
    throw new ApLedgerError("Shipment cost payment summary checksum failed", 500, {
      code: "AP_SHIPMENT_PAYMENT_CHECKSUM_FAILED",
      shipmentId,
      totalCents,
      paidCents,creditedCents,
      outstandingCents,
    });
  }

  return {
    costs: costStatuses,
    summary: {
      totalCents,
      linkedCents,
      paidCents,creditedCents,
      outstandingCents,
    },
  };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/**
 * Get all invoices linked to a shipment with summary totals.
 * Uses vendor_invoices.inbound_shipment_id direct FK.
 */
export async function getShipmentInvoicesSummary(shipmentId: number) {
  return db.transaction(async tx => {
  const costs = await tx.select().from(inboundFreightCosts).where(eq(inboundFreightCosts.inboundShipmentId, shipmentId));
  const ownership = await readShipmentBillingOwnership(tx, costs);
  if ([...ownership.values()].some(owner => owner.state === "review_required")) throw new ApLedgerError(
    "Shipment invoice totals are unavailable until conflicting billing ownership is reviewed.", 409,
    { code: "AP_SHIPMENT_BILLING_REVIEW_REQUIRED", shipmentId });
  const rows = await tx
    .select({
      invoice: vendorInvoices,
      vendorName: vendors.name,
      vendorCode: vendors.code,
    })
    .from(vendorInvoices)
    .leftJoin(vendors, eq(vendorInvoices.vendorId, vendors.id))
    .where(sql`${vendorInvoices.inboundShipmentId}=${shipmentId}
      OR EXISTS(SELECT 1 FROM procurement.inbound_freight_costs cost WHERE cost.inbound_shipment_id=${shipmentId}
        AND (cost.vendor_invoice_id=${vendorInvoices.id} OR EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines line
          WHERE line.vendor_invoice_id=${vendorInvoices.id} AND line.freight_cost_id=cost.id)))`)
    .orderBy(desc(vendorInvoices.invoiceDate));

  let totalInvoiced = BigInt(0);
  let totalPaid = BigInt(0); let totalCredited = BigInt(0);
  let activeInvoiceCount = 0;

  const settlements=await readVerifiedInvoiceSettlementProjections(tx,rows.map(row=>row.invoice));
  const invoices = rows.map((r, index) => {
    if (r.invoice.status !== "voided") {
      activeInvoiceCount++;
      totalCredited += databaseMoneyToBigInt(r.invoice.creditedAmountCents,`shipmentInvoices[${index}].creditedAmountCents`);
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
      ...r.invoice, ...settlements.get(r.invoice.id)!,
      vendorName: r.vendorName,
      vendorCode: r.vendorCode,
    };
  });

  const outstanding = totalInvoiced > totalPaid + totalCredited ? totalInvoiced - totalPaid - totalCredited : BigInt(0);
  const totalInvoicedCents = bigintMoneyToNumber(totalInvoiced, "shipment.totalInvoicedCents");
  const totalPaidCents = bigintMoneyToNumber(totalPaid, "shipment.totalPaidCents");

  return {
    invoices,
    summary: {
      totalInvoicedCents,
      totalPaidCents, totalCreditedCents:bigintMoneyToNumber(totalCredited,"shipment.totalCreditedCents"),
      outstandingCents: bigintMoneyToNumber(outstanding, "shipment.outstandingCents"),
      invoiceCount: invoices.length,
      activeInvoiceCount,
    },
  };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/**
 * Enrich shipment cost rows with linked invoice info and derived status.
 * Returns enriched cost array with linkedInvoice and derivedStatus fields.
 */
export async function enrichCostsWithInvoiceInfo(shipmentId: number) {
  return db.transaction(async tx => {
  const costVendor = alias(vendors, "shipment_cost_vendor");
  const costs = await tx
    .select({
      cost: inboundFreightCosts,
      vendorName: costVendor.name,
      invoiceId: vendorInvoices.id,
      invoiceNumber: vendorInvoices.invoiceNumber,
      invoiceVendorId: vendorInvoices.vendorId,
      invoiceStatus: vendorInvoices.status,
      invoiceVendorName: vendors.name,
      invoicedAmountCents: vendorInvoices.invoicedAmountCents,
      paidAmountCents: vendorInvoices.paidAmountCents,
      creditedAmountCents: vendorInvoices.creditedAmountCents,
      balanceCents: vendorInvoices.balanceCents,
    })
    .from(inboundFreightCosts)
    .leftJoin(vendorInvoices, eq(inboundFreightCosts.vendorInvoiceId, vendorInvoices.id))
    .leftJoin(vendors, eq(vendorInvoices.vendorId, vendors.id))
    .leftJoin(costVendor, eq(inboundFreightCosts.vendorId, costVendor.id))
    .where(eq(inboundFreightCosts.inboundShipmentId, shipmentId));

  const ownership = await readShipmentBillingOwnership(tx, costs.map(row => row.cost));
  return costs.map((c) => {
    const billingOwnership = ownership.get(c.cost.id)!;
    const linkedInvoice = c.invoiceId
      ? {
          id: c.invoiceId,
          invoiceNumber: c.invoiceNumber,
          vendorId: c.invoiceVendorId,
          vendorName: c.invoiceVendorName,
          status: c.invoiceStatus,
        }
      : null;

    let derivedStatus: "unbilled" | "invoiced" | "paid" | "voided" | "review_required" = "unbilled";
    if (billingOwnership.state === "review_required") {
      derivedStatus = "review_required";
    } else if (c.invoiceId && c.invoiceStatus) {
      if (c.invoiceStatus === "voided") {
        derivedStatus = "voided";
      } else {
        const balance = readIntegerCents(c.balanceCents, "balance", true);
        derivedStatus = balance <= 0 ? "paid" : "invoiced";
      }
    }

    return {
      ...c.cost,
      billingOwnership,
      vendorName: c.vendorName,
      linkedInvoice,
      derivedStatus,
    };
  });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/**
 * Link a single shipment cost to an existing vendor invoice.
 */
export async function linkCostToInvoice(costId: number, vendorInvoiceId: number, actorId?: string, invoiceLineId?: number) {
  const normalizedCostId = requireCommandId(costId, "costId");
  const normalizedInvoiceId = requireCommandId(vendorInvoiceId, "vendorInvoiceId");
  const normalizedLineId = invoiceLineId === undefined ? undefined : requireCommandId(invoiceLineId, "invoiceLineId");
  const now = new Date();
  return runApCostTransaction(async tx => {
    const [cost] = await tx.select().from(inboundFreightCosts).where(eq(inboundFreightCosts.id, normalizedCostId)).for("update");
    if (!cost) throw new ApLedgerError("Shipment cost not found", 404, { code: "AP_SHIPMENT_COST_NOT_FOUND", costId });
    const owner = (await readShipmentBillingOwnership(tx, [cost])).get(cost.id)!;
    if (owner.state === "billed" && owner.activeInvoiceId === normalizedInvoiceId
      && (normalizedLineId === undefined || owner.activeInvoiceLineIds.includes(normalizedLineId))) {
      return { costId: cost.id, vendorInvoiceId: normalizedInvoiceId, invoiceLineId: normalizedLineId ?? owner.activeInvoiceLineId, changed: false };
    }
    if (!owner.canLinkExistingLine || (cost.vendorInvoiceId !== null && cost.vendorInvoiceId !== normalizedInvoiceId)) {
      throw new ApLedgerError("This charge already has invoice source evidence. Review the original invoice; billing ownership cannot be reassigned.", 409,
        { code: "AP_SHIPMENT_BILLING_REVIEW_REQUIRED", costId, billingOwnership: owner });
    }
    await lockEditableInvoice(tx, normalizedInvoiceId);
    if (normalizedLineId === undefined) throw new ApLedgerError("Select the exact existing invoice line that bills this charge.", 422,
      { code: "AP_SHIPMENT_INVOICE_LINE_REQUIRED", costId });
    const [invoice] = await tx.select().from(vendorInvoices).where(eq(vendorInvoices.id, normalizedInvoiceId));
    if (!invoice || invoice.vendorId !== cost.vendorId || invoice.currency !== cost.currency || invoice.currency !== "USD"
      || (invoice.inboundShipmentId !== null && invoice.inboundShipmentId !== cost.inboundShipmentId)) {
      throw new ApLedgerError("The charge and invoice must have the same supplier, shipment and USD currency.", 422,
        { code: "AP_SHIPMENT_COST_VENDOR_MISMATCH", costId, invoiceId: normalizedInvoiceId });
    }
    const [shipment] = await tx.select({ status: inboundShipments.status }).from(inboundShipments)
      .where(eq(inboundShipments.id, cost.inboundShipmentId)).for("update");
    if (!shipment || shipment.status === "cancelled") throw new ApLedgerError("A cancelled or missing shipment cannot acquire new billing ownership.", 409,
      { code: "AP_SHIPMENT_CANCELLED", costId });
    const lines = await tx.select().from(vendorInvoiceLines).where(eq(vendorInvoiceLines.vendorInvoiceId, normalizedInvoiceId)).orderBy(asc(vendorInvoiceLines.id)).for("update");
    const line = lines.find(candidate => candidate.id === normalizedLineId);
    const poLinks = await tx.select({ id: vendorInvoicePoLinks.id }).from(vendorInvoicePoLinks)
      .where(eq(vendorInvoicePoLinks.vendorInvoiceId, normalizedInvoiceId));
    if (!line || line.freightCostId !== null || poLinks.length > 0
      || lines.some(candidate => candidate.purchaseOrderLineId !== null || candidate.productVariantId !== null)) {
      throw new ApLedgerError("Select an unassigned shipment charge line on an invoice without product or purchase-order sources.", 409,
        { code: "AP_SHIPMENT_INVOICE_LINE_SOURCE_INVALID", invoiceId: normalizedInvoiceId, invoiceLineId: normalizedLineId });
    }
    const chargeAmount = cost.actualCents ?? cost.estimatedCents;
    if (chargeAmount === null || chargeAmount === undefined) {
      throw new ApLedgerError("The shipment charge has no recorded amount to verify against the selected invoice line.", 422,
        { code: "AP_SHIPMENT_COST_AMOUNT_REQUIRED", shipmentCostId: costId });
    }
    const amount = requireNonnegativeInteger(chargeAmount, "shipmentCost.amountCents");
    const unitCost = normalizeUnitCost({ unitCostCents: line.unitCostCents, unitCostMills: line.unitCostMills ?? undefined });
    if (!Number.isSafeInteger(line.qtyInvoiced) || line.qtyInvoiced <= 0 || line.lineTotalCents !== amount
      || computeLineTotalCentsFromMills(unitCost.unitCostMills, line.qtyInvoiced) !== amount
      || lines.reduce((sum, candidate) => sum + BigInt(requireNonnegativeInteger(candidate.lineTotalCents, "invoiceLine.lineTotalCents")), BigInt(0)) !== BigInt(invoice.invoicedAmountCents)) {
      throw new ApLedgerError("The selected invoice line must account for this entire charge and its invoice total must reconcile. No amount split is inferred.", 422,
        { code: "AP_SHIPMENT_INVOICE_LINE_AMOUNT_MISMATCH", costId, invoiceLineId: normalizedLineId });
    }
    await tx.update(vendorInvoiceLines).set({ freightCostId: cost.id, updatedAt: now }).where(eq(vendorInvoiceLines.id, line.id));
    await tx.update(inboundFreightCosts).set({ vendorInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate, dueDate: invoice.dueDate, costStatus: "invoiced", updatedAt: now }).where(eq(inboundFreightCosts.id, cost.id));
    if (invoice.inboundShipmentId === null) await tx.update(vendorInvoices).set({ inboundShipmentId: cost.inboundShipmentId,
      updatedBy: actorId, updatedAt: now }).where(eq(vendorInvoices.id, invoice.id));
    await appendApMutationAudit("shipment_cost_invoice_linked", `shipment_cost:${cost.id}`, actorId,
      { costId: cost.id, vendorInvoiceId: invoice.id, invoiceLineId: line.id, inboundShipmentId: cost.inboundShipmentId,
        before: { vendorInvoiceId: cost.vendorInvoiceId, freightCostId: line.freightCostId },
        after: { vendorInvoiceId: invoice.id, freightCostId: cost.id } }, tx, now);
    return { costId: cost.id, vendorInvoiceId: invoice.id, invoiceLineId: line.id, changed: true };
  });
}

/** A pointer alone still records an invoice liability association. Never discard
 * its last source evidence and expose the charge for another bill. */
export async function unlinkCostFromInvoice(costId: number, _actorId?: string) {
  const normalizedCostId = requireCommandId(costId, "costId");
  return runApCostTransaction(async tx => {
    const [cost] = await tx.select().from(inboundFreightCosts).where(eq(inboundFreightCosts.id, normalizedCostId)).for("update");
    if (!cost) throw new ApLedgerError("Shipment cost not found", 404, { code: "AP_SHIPMENT_COST_NOT_FOUND", costId });
    const owner = (await readShipmentBillingOwnership(tx, [cost])).get(cost.id)!;
    if (owner.state === "unbilled") return { ok: true, changed: false };
    // Preserve the established financial-history rejection before the stronger
    // source immutability rejection for a document that was already recognized.
    if (cost.vendorInvoiceId !== null) await lockEditableInvoice(tx, cost.vendorInvoiceId);
    throw new ApLedgerError("The invoice association is retained billing evidence. Resolve its exact source line, then use invoice void or reviewed replacement.", 409,
      { code: "AP_SHIPMENT_INVOICE_SOURCE_IMMUTABLE", costId, billingOwnership: owner });
  });
}

/** Acquire the shared cost-graph lock before invoice/PO/catalog row locks. */
async function runApCostTransaction<T>(work: (tx: ApLedgerDbClient) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => { await lockInventoryCostGraph(tx as any); return work(tx as any); });
}

export function invoiceCostReviewVersion(line: { id: number; qtyInvoiced: number; unitCostCents: number; unitCostMills: number | null; lineTotalCents: number; costComponentEvidence?: unknown }): string {
  return costFingerprint({ id: line.id, qtyInvoiced: line.qtyInvoiced, unitCostCents: line.unitCostCents,
    unitCostMills: line.unitCostMills, lineTotalCents: line.lineTotalCents, costComponentEvidence: line.costComponentEvidence ?? null });
}
