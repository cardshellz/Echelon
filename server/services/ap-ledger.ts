/**
 * AP Ledger Service
 * Handles vendor invoice lifecycle, payment recording, and invoice balance tracking.
 */

import { db } from "../db";
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
} from "../../shared/schema";
import { eq, and, inArray, sql, desc, lt, lte, gte, ne, asc } from "drizzle-orm";
import { format } from "date-fns";

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

async function generatePaymentNumber(): Promise<string> {
  const dateStr = format(new Date(), "yyyyMMdd");
  const prefix = `PAY-${dateStr}-`;

  const result = await db
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

async function recalculateInvoiceBalance(invoiceId: number): Promise<void> {
  // Sum all non-voided payment allocations
  const allocResult = await db
    .select({ total: sql<number>`COALESCE(SUM(${apPaymentAllocations.appliedAmountCents}), 0)` })
    .from(apPaymentAllocations)
    .innerJoin(apPayments, eq(apPaymentAllocations.apPaymentId, apPayments.id))
    .where(
      and(
        eq(apPaymentAllocations.vendorInvoiceId, invoiceId),
        ne(apPayments.status, "voided"),
      )
    );

  const paidAmount = Number(allocResult[0]?.total ?? 0);

  const [invoice] = await db
    .select({ invoicedAmountCents: vendorInvoices.invoicedAmountCents, status: vendorInvoices.status })
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, invoiceId));

  if (!invoice) return;

  const invoicedAmount = Number(invoice.invoicedAmountCents);
  const balance = invoicedAmount - paidAmount;

  let newStatus = invoice.status;
  if (invoice.status !== "voided" && invoice.status !== "disputed") {
    if (balance <= 0) {
      newStatus = "paid";
    } else if (paidAmount > 0) {
      newStatus = "partially_paid";
    } else if (invoice.status === "paid" || invoice.status === "partially_paid") {
      // Payment was voided, revert to approved
      newStatus = "approved";
    }
  }

  await db
    .update(vendorInvoices)
    .set({
      paidAmountCents: paidAmount,
      balanceCents: Math.max(0, balance),
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(eq(vendorInvoices.id, invoiceId));
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
  const [invoice] = await db
    .insert(vendorInvoices)
    .values({
      invoiceNumber: data.invoiceNumber,
      ourReference: data.ourReference,
      vendorId: data.vendorId,
      status: "received",
      receivedDate: new Date(),
      invoiceDate: data.invoiceDate,
      dueDate: data.dueDate,
      invoicedAmountCents: data.invoicedAmountCents ?? 0,
      paidAmountCents: 0,
      balanceCents: data.invoicedAmountCents ?? 0,
      currency: data.currency ?? "USD",
      paymentTermsDays: data.paymentTermsDays,
      paymentTermsType: data.paymentTermsType,
      notes: data.notes,
      internalNotes: data.internalNotes,
      createdBy: data.createdBy,
      updatedBy: data.createdBy,
    })
    .returning();

  if (data.poIds?.length) {
    await db.insert(vendorInvoicePoLinks).values(
      data.poIds.map((poId) => ({
        vendorInvoiceId: invoice.id,
        purchaseOrderId: poId,
      }))
    );

    // Auto-import lines from all linked POs
    for (const poId of data.poIds) {
      await importLinesFromPO(invoice.id, poId);
    }

    // Recalculate header total from lines
    await recalculateInvoiceFromLines(invoice.id);
  }

  // Re-fetch to get updated totals
  const [final] = await db.select().from(vendorInvoices).where(eq(vendorInvoices.id, invoice.id));
  return final;
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
  status?: string | string[];
  overdue?: boolean;
  dueBefore?: Date;
  limit?: number;
  offset?: number;
}) {
  const conditions = [];

  if (filters.vendorId) conditions.push(eq(vendorInvoices.vendorId, filters.vendorId));
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
    updatedBy: string;
  }>
) {
  const [updated] = await db
    .update(vendorInvoices)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(vendorInvoices.id, id))
    .returning();
  return updated;
}

// ─── Invoice Status Transitions ───────────────────────────────────────────────

export async function approveInvoice(id: number, userId?: string) {
  const [inv] = await db.select().from(vendorInvoices).where(eq(vendorInvoices.id, id));
  if (!inv || !["received", "disputed"].includes(inv.status)) {
    throw new Error("Invoice must be in received or disputed status to approve");
  }

  const [updated] = await db
    .update(vendorInvoices)
    .set({ status: "approved", approvedAt: new Date(), approvedBy: userId, updatedBy: userId, updatedAt: new Date() })
    .where(eq(vendorInvoices.id, id))
    .returning();
  return updated;
}

export async function disputeInvoice(id: number, reason: string, userId?: string) {
  const [inv] = await db.select().from(vendorInvoices).where(eq(vendorInvoices.id, id));
  if (!inv || !["received", "approved", "partially_paid"].includes(inv.status)) {
    throw new Error("Cannot dispute invoice in its current status");
  }

  const [updated] = await db
    .update(vendorInvoices)
    .set({ status: "disputed", disputeReason: reason, updatedBy: userId, updatedAt: new Date() })
    .where(eq(vendorInvoices.id, id))
    .returning();
  return updated;
}

export async function voidInvoice(id: number, reason: string, userId?: string) {
  const [inv] = await db.select().from(vendorInvoices).where(eq(vendorInvoices.id, id));
  if (!inv || inv.status === "voided") throw new Error("Invoice is already voided");
  if (inv.paidAmountCents > 0) throw new Error("Cannot void an invoice with payments applied — void the payments first");

  const [updated] = await db
    .update(vendorInvoices)
    .set({ status: "voided", internalNotes: `${inv.internalNotes ? inv.internalNotes + "\n" : ""}VOIDED: ${reason}`, updatedBy: userId, updatedAt: new Date() })
    .where(eq(vendorInvoices.id, id))
    .returning();
  return updated;
}

// ─── PO Links ─────────────────────────────────────────────────────────────────

export async function linkPoToInvoice(
  invoiceId: number,
  purchaseOrderId: number,
  allocatedAmountCents?: number,
  notes?: string
) {
  const [link] = await db
    .insert(vendorInvoicePoLinks)
    .values({ vendorInvoiceId: invoiceId, purchaseOrderId, allocatedAmountCents, notes })
    .onConflictDoUpdate({
      target: [vendorInvoicePoLinks.vendorInvoiceId, vendorInvoicePoLinks.purchaseOrderId],
      set: { allocatedAmountCents, notes },
    })
    .returning();

  // Auto-import PO lines and recalculate invoice total
  await importLinesFromPO(invoiceId, purchaseOrderId);
  await recalculateInvoiceFromLines(invoiceId);

  return link;
}

export async function unlinkPoFromInvoice(invoiceId: number, purchaseOrderId: number) {
  // Remove the link
  await db
    .delete(vendorInvoicePoLinks)
    .where(
      and(
        eq(vendorInvoicePoLinks.vendorInvoiceId, invoiceId),
        eq(vendorInvoicePoLinks.purchaseOrderId, purchaseOrderId)
      )
    );

  // Remove imported lines that came from this PO
  const poLineIds = await db
    .select({ id: purchaseOrderLines.id })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));

  if (poLineIds.length > 0) {
    await db
      .delete(vendorInvoiceLines)
      .where(
        and(
          eq(vendorInvoiceLines.vendorInvoiceId, invoiceId),
          inArray(vendorInvoiceLines.purchaseOrderLineId, poLineIds.map(p => p.id))
        )
      );
    await recalculateInvoiceFromLines(invoiceId);
  }
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

// ─── Payments ─────────────────────────────────────────────────────────────────

export async function recordPayment(data: {
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
}) {
  const paymentNumber = await generatePaymentNumber();

  // Validate allocations sum <= total
  const allocTotal = data.allocations.reduce((s, a) => s + a.appliedAmountCents, 0);
  if (allocTotal > data.totalAmountCents) {
    throw new Error(`Allocation total (${allocTotal}) exceeds payment total (${data.totalAmountCents})`);
  }

  const [payment] = await db
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
      currency: data.currency ?? "USD",
      status: data.status ?? "completed",
      notes: data.notes,
      createdBy: data.createdBy,
      updatedBy: data.createdBy,
    })
    .returning();

  if (data.allocations.length > 0) {
    await db.insert(apPaymentAllocations).values(
      data.allocations.map((a) => ({
        apPaymentId: payment.id,
        vendorInvoiceId: a.vendorInvoiceId,
        appliedAmountCents: a.appliedAmountCents,
        notes: a.notes,
      }))
    );

    // Recalculate balance on each affected invoice
    for (const alloc of data.allocations) {
      await recalculateInvoiceBalance(alloc.vendorInvoiceId);
    }
  }

  return payment;
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

export async function voidPayment(id: number, reason: string, userId?: string) {
  const [payment] = await db.select().from(apPayments).where(eq(apPayments.id, id));
  if (!payment || payment.status === "voided") throw new Error("Payment is already voided");

  await db
    .update(apPayments)
    .set({ status: "voided", voidedAt: new Date(), voidedBy: userId, voidReason: reason, updatedBy: userId, updatedAt: new Date() })
    .where(eq(apPayments.id, id));

  // Get affected invoices and recalculate their balances
  const affectedAllocs = await db
    .select({ vendorInvoiceId: apPaymentAllocations.vendorInvoiceId })
    .from(apPaymentAllocations)
    .where(eq(apPaymentAllocations.apPaymentId, id));

  for (const alloc of affectedAllocs) {
    await recalculateInvoiceBalance(alloc.vendorInvoiceId);
  }
}

// ─── AP Summary / Aging ───────────────────────────────────────────────────────

export async function getApSummary() {
  const now = new Date();
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

  let totalOutstandingCents = 0;
  let overdueCents = 0;
  let dueSoonCents = 0; // Due within 7 days

  const agingBuckets = { current: 0, days1_30: 0, days31_60: 0, days61_90: 0, days90plus: 0 };
  const vendorAging: Record<number, { vendorName: string; current: number; days1_30: number; days31_60: number; days61_90: number; days90plus: number; total: number }> = {};

  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  for (const inv of allOpen) {
    const balance = Number(inv.balanceCents);
    totalOutstandingCents += balance;

    if (inv.dueDate && inv.dueDate < in7Days) dueSoonCents += balance;

    const daysPastDue = inv.dueDate ? Math.floor((now.getTime() - inv.dueDate.getTime()) / (1000 * 60 * 60 * 24)) : 0;

    let bucket: keyof typeof agingBuckets;
    if (daysPastDue <= 0) { bucket = "current"; }
    else if (daysPastDue <= 30) { bucket = "days1_30"; overdueCents += balance; }
    else if (daysPastDue <= 60) { bucket = "days31_60"; overdueCents += balance; }
    else if (daysPastDue <= 90) { bucket = "days61_90"; overdueCents += balance; }
    else { bucket = "days90plus"; overdueCents += balance; }

    agingBuckets[bucket] += balance;

    if (!vendorAging[inv.vendorId]) {
      vendorAging[inv.vendorId] = { vendorName: inv.vendorName ?? "", current: 0, days1_30: 0, days31_60: 0, days61_90: 0, days90plus: 0, total: 0 };
    }
    vendorAging[inv.vendorId][bucket] += balance;
    vendorAging[inv.vendorId].total += balance;
  }

  // Paid this month
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const paidThisMonthResult = await db
    .select({ total: sql<number>`COALESCE(SUM(${apPayments.totalAmountCents}), 0)` })
    .from(apPayments)
    .where(and(eq(apPayments.status, "completed"), gte(apPayments.paymentDate, startOfMonth)));

  const paidThisMonthCents = Number(paidThisMonthResult[0]?.total ?? 0);

  return {
    totalOutstandingCents,
    overdueCents,
    dueSoonCents,
    paidThisMonthCents,
    agingBuckets,
    vendorAging: Object.entries(vendorAging).map(([vendorId, data]) => ({
      vendorId: Number(vendorId),
      ...data,
    })),
  };
}

// ─── Invoice Lines ────────────────────────────────────────────────────────────

export async function importLinesFromPO(invoiceId: number, purchaseOrderId: number) {
  const poLines = await db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(purchaseOrderLines.lineNumber));

  if (poLines.length === 0) return [];

  // Get current max line number on this invoice
  const existing = await db
    .select({ maxLine: sql<number>`COALESCE(MAX(${vendorInvoiceLines.lineNumber}), 0)` })
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId));
  let lineNum = Number(existing[0]?.maxLine ?? 0);

  const newLines = [];
  for (const pol of poLines) {
    if (pol.status === "cancelled") continue;
    lineNum++;
    const unitCost = Number(pol.unitCostCents || 0);
    const qty = pol.orderQty;
    // Use the actual PO line total — it includes discounts + tax, no recomputation
    const lineTotal = pol.lineTotalCents != null
      ? Number(pol.lineTotalCents)
      : qty * unitCost; // Fallback only if PO line has no total
    const [line] = await db
      .insert(vendorInvoiceLines)
      .values({
        vendorInvoiceId: invoiceId,
        purchaseOrderLineId: pol.id,
        productVariantId: pol.productVariantId,
        lineNumber: lineNum,
        sku: pol.sku,
        productName: pol.productName,
        description: pol.description,
        qtyInvoiced: qty,
        qtyOrdered: qty,
        qtyReceived: pol.receivedQty ?? 0,
        unitCostCents: unitCost,
        lineTotalCents: lineTotal,
        matchStatus: "pending",
      })
      .returning();
    newLines.push(line);
  }

  return newLines;
}

export async function addInvoiceLine(invoiceId: number, data: {
  purchaseOrderLineId?: number;
  productVariantId?: number;
  sku?: string;
  productName?: string;
  description?: string;
  qtyInvoiced: number;
  unitCostCents: number;
  notes?: string;
}) {
  // Get next line number
  const existing = await db
    .select({ maxLine: sql<number>`COALESCE(MAX(${vendorInvoiceLines.lineNumber}), 0)` })
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId));
  const lineNumber = Number(existing[0]?.maxLine ?? 0) + 1;

  const [line] = await db
    .insert(vendorInvoiceLines)
    .values({
      vendorInvoiceId: invoiceId,
      purchaseOrderLineId: data.purchaseOrderLineId,
      productVariantId: data.productVariantId,
      lineNumber,
      sku: data.sku,
      productName: data.productName,
      description: data.description,
      qtyInvoiced: data.qtyInvoiced,
      unitCostCents: data.unitCostCents,
      lineTotalCents: data.qtyInvoiced * data.unitCostCents,
      matchStatus: "pending",
      notes: data.notes,
    })
    .returning();

  await recalculateInvoiceFromLines(invoiceId);
  return line;
}

export async function updateInvoiceLine(lineId: number, data: {
  qtyInvoiced?: number;
  unitCostCents?: number;
  description?: string;
  notes?: string;
}) {
  const [existing] = await db.select().from(vendorInvoiceLines).where(eq(vendorInvoiceLines.id, lineId));
  if (!existing) throw new Error("Invoice line not found");

  const qty = data.qtyInvoiced ?? existing.qtyInvoiced;
  const unitCost = data.unitCostCents ?? existing.unitCostCents;

  const [updated] = await db
    .update(vendorInvoiceLines)
    .set({
      ...data,
      lineTotalCents: qty * unitCost,
      matchStatus: "pending", // Reset match on edit
      updatedAt: new Date(),
    })
    .where(eq(vendorInvoiceLines.id, lineId))
    .returning();

  await recalculateInvoiceFromLines(existing.vendorInvoiceId);
  return updated;
}

export async function removeInvoiceLine(lineId: number) {
  const [existing] = await db.select().from(vendorInvoiceLines).where(eq(vendorInvoiceLines.id, lineId));
  if (!existing) throw new Error("Invoice line not found");

  await db.delete(vendorInvoiceLines).where(eq(vendorInvoiceLines.id, lineId));
  await recalculateInvoiceFromLines(existing.vendorInvoiceId);
}

export async function getInvoiceLines(invoiceId: number) {
  return db
    .select()
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId))
    .orderBy(asc(vendorInvoiceLines.lineNumber));
}

async function recalculateInvoiceFromLines(invoiceId: number) {
  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${vendorInvoiceLines.lineTotalCents}), 0)` })
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId));

  // Round to whole cents for invoice header totals (bigint columns)
  const linesTotalCents = Math.round(Number(result[0]?.total ?? 0));

  const [inv] = await db.select().from(vendorInvoices).where(eq(vendorInvoices.id, invoiceId));
  if (!inv) return;

  const balance = linesTotalCents - Number(inv.paidAmountCents);

  await db
    .update(vendorInvoices)
    .set({
      invoicedAmountCents: linesTotalCents,
      balanceCents: Math.max(0, balance),
      updatedAt: new Date(),
    })
    .where(eq(vendorInvoices.id, invoiceId));
}

// ─── 3-Way Match ──────────────────────────────────────────────────────────────

export async function runInvoiceMatch(invoiceId: number) {
  const lines = await db
    .select()
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId));

  for (const line of lines) {
    let matchStatus = "pending";

    if (line.purchaseOrderLineId) {
      // Fetch current PO line data for comparison
      const [poLine] = await db
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.id, line.purchaseOrderLineId));

      if (poLine) {
        const poUnitCost = Number(poLine.unitCostCents || 0);
        const invoiceUnitCost = Number(line.unitCostCents);
        const qtyReceived = poLine.receivedQty ?? 0;

        // Update received qty from latest PO data
        await db
          .update(vendorInvoiceLines)
          .set({ qtyReceived: qtyReceived })
          .where(eq(vendorInvoiceLines.id, line.id));

        if (invoiceUnitCost !== poUnitCost) {
          matchStatus = "price_discrepancy";
        } else if (line.qtyInvoiced > qtyReceived && qtyReceived > 0) {
          matchStatus = "over_billed";
        } else if (line.qtyInvoiced !== poLine.orderQty) {
          matchStatus = "qty_discrepancy";
        } else {
          matchStatus = "matched";
        }
      }
    }

    await db
      .update(vendorInvoiceLines)
      .set({ matchStatus, updatedAt: new Date() })
      .where(eq(vendorInvoiceLines.id, line.id));
  }

  // Return updated lines
  return db
    .select()
    .from(vendorInvoiceLines)
    .where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId))
    .orderBy(asc(vendorInvoiceLines.lineNumber));
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
  const [attachment] = await db
    .insert(vendorInvoiceAttachments)
    .values({
      vendorInvoiceId: invoiceId,
      fileName: data.fileName,
      fileType: data.fileType,
      fileSizeBytes: data.fileSizeBytes,
      filePath: data.filePath,
      uploadedBy: data.uploadedBy,
      notes: data.notes,
    })
    .returning();
  return attachment;
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

export async function removeAttachment(id: number) {
  await db.delete(vendorInvoiceAttachments).where(eq(vendorInvoiceAttachments.id, id));
}
