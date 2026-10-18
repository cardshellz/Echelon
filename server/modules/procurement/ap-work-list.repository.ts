import { and, desc, eq, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { apPayments, purchaseOrders, vendorInvoicePoLinks, vendorInvoices, vendors } from "@shared/schema";
import { invoiceWorkListPageSchema, paymentWorkListPageSchema, type InvoiceWorkListQuery, type PaymentWorkListQuery, type InvoiceWorkListPage, type PaymentWorkListPage } from "@shared/procurement/ap-work-list";

// Search is literal text: SQL wildcards typed by an operator must not broaden the list.
function contains(value: string): string { return `%${value.replace(/[\\%_]/g, character => `\\${character}`)}%`; }
function pageMetadata(total: number, query: { limit: number; offset: number }, length: number) {
  return { total, limit: query.limit, offset: query.offset, nextOffset: query.offset + length < total ? query.offset + length : null };
}

export async function readInvoiceWorkList(query: InvoiceWorkListQuery, now: Date): Promise<InvoiceWorkListPage> {
  const conditions: SQL[] = [];
  if (query.vendorId !== undefined) conditions.push(eq(vendorInvoices.vendorId, query.vendorId));
  if (query.status) conditions.push(inArray(vendorInvoices.status, query.status));
  if (query.overdue) {
    // Preserve the existing AP list owner's overdue policy; payment eligibility is checked by its command owner.
    conditions.push(lt(vendorInvoices.dueDate, now), inArray(vendorInvoices.status, ["received", "approved", "partially_paid"]));
  }
  if (query.search) {
    const pattern = contains(query.search);
    conditions.push(or(ilike(vendorInvoices.invoiceNumber, pattern), ilike(vendorInvoices.ourReference, pattern),
      ilike(vendors.name, pattern), ilike(vendors.code, pattern),
      sql`EXISTS (SELECT 1 FROM ${vendorInvoicePoLinks} link JOIN ${purchaseOrders} po ON po.id = link.purchase_order_id WHERE link.vendor_invoice_id = ${vendorInvoices.id} AND po.po_number ILIKE ${pattern})`)!);
  }
  const predicate = and(...conditions);
  // Count, page, and linked PO labels are one read snapshot. IDs break timestamp ties deterministically.
  return db.transaction(async tx => {
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(vendorInvoices).leftJoin(vendors, eq(vendors.id, vendorInvoices.vendorId)).where(predicate);
    const rows = await tx.select({
      id: vendorInvoices.id, vendorId: vendorInvoices.vendorId, invoiceNumber: vendorInvoices.invoiceNumber,
      ourReference: vendorInvoices.ourReference, vendorName: vendors.name, vendorCode: vendors.code, status: vendorInvoices.status,
      invoiceDate: vendorInvoices.invoiceDate, dueDate: vendorInvoices.dueDate, invoicedAmountCents: vendorInvoices.invoicedAmountCents,
      paidAmountCents: vendorInvoices.paidAmountCents, balanceCents: vendorInvoices.balanceCents, inboundShipmentId: vendorInvoices.inboundShipmentId,
      currency: vendorInvoices.currency,
    }).from(vendorInvoices).leftJoin(vendors, eq(vendors.id, vendorInvoices.vendorId)).where(predicate)
      .orderBy(desc(vendorInvoices.createdAt), desc(vendorInvoices.id)).limit(query.limit).offset(query.offset);
    const links = rows.length ? await tx.select({ invoiceId: vendorInvoicePoLinks.vendorInvoiceId, poNumber: purchaseOrders.poNumber })
      .from(vendorInvoicePoLinks).innerJoin(purchaseOrders, eq(purchaseOrders.id, vendorInvoicePoLinks.purchaseOrderId))
      .where(inArray(vendorInvoicePoLinks.vendorInvoiceId, rows.map(row => row.id))).orderBy(purchaseOrders.poNumber, purchaseOrders.id) : [];
    const items = rows.map(row => ({ ...row, invoiceDate: row.invoiceDate?.toISOString() ?? null, dueDate: row.dueDate?.toISOString() ?? null,
      poNumbers: links.filter(link => link.invoiceId === row.id).map(link => link.poNumber) }));
    return invoiceWorkListPageSchema.parse({ items, ...pageMetadata(count.total, query, items.length) });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function readPaymentWorkList(query: PaymentWorkListQuery): Promise<PaymentWorkListPage> {
  const conditions: SQL[] = [];
  if (query.vendorId !== undefined) conditions.push(eq(apPayments.vendorId, query.vendorId));
  if (query.status) conditions.push(inArray(apPayments.status, query.status));
  if (query.paymentMethod) conditions.push(eq(apPayments.paymentMethod, query.paymentMethod));
  if (query.search) {
    const pattern = contains(query.search);
    conditions.push(or(ilike(apPayments.paymentNumber, pattern), ilike(apPayments.referenceNumber, pattern), ilike(apPayments.checkNumber, pattern), ilike(vendors.name, pattern), ilike(vendors.code, pattern))!);
  }
  const predicate = and(...conditions);
  return db.transaction(async tx => {
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(apPayments).leftJoin(vendors, eq(vendors.id, apPayments.vendorId)).where(predicate);
    const rows = await tx.select({ id: apPayments.id, vendorId: apPayments.vendorId, paymentNumber: apPayments.paymentNumber,
      vendorName: vendors.name, vendorCode: vendors.code, paymentDate: apPayments.paymentDate, paymentMethod: apPayments.paymentMethod,
      referenceNumber: apPayments.referenceNumber, checkNumber: apPayments.checkNumber, totalAmountCents: apPayments.totalAmountCents,
      currency: apPayments.currency, status: apPayments.status,
    }).from(apPayments).leftJoin(vendors, eq(vendors.id, apPayments.vendorId)).where(predicate)
      .orderBy(desc(apPayments.paymentDate), desc(apPayments.id)).limit(query.limit).offset(query.offset);
    const items = rows.map(row => ({ ...row, paymentDate: row.paymentDate.toISOString() }));
    return paymentWorkListPageSchema.parse({ items, ...pageMetadata(count.total, query, items.length) });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
