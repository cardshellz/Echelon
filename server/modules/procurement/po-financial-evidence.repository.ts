import { asc, eq, inArray } from "drizzle-orm";
import {
  apPaymentAllocations,
  apPayments,
  purchaseOrderLines,
  purchaseOrders,
  vendorInvoiceLines,
  vendorInvoicePoLinks,
  vendorInvoices,
} from "@shared/schema";
import type { db } from "../../db";
import type { PoFinancialEvidenceInput } from "./domain/po-financial-evidence";

export type PoFinancialEvidenceDatabase = Pick<typeof db, "transaction">;

export class PoFinancialEvidenceSourceError extends Error {
  readonly code = "PO_FINANCIAL_EVIDENCE_SOURCE_MISSING";
  constructor() {
    super(
      "A linked invoice source is missing. Review the linked invoice records.",
    );
    this.name = "PoFinancialEvidenceSourceError";
  }
}

function groupByInvoice<Row extends { vendorInvoiceId: number }>(
  rows: readonly Row[],
): Map<number, Omit<Row, "vendorInvoiceId">[]> {
  const groups = new Map<number, Omit<Row, "vendorInvoiceId">[]>();
  for (const row of rows) {
    const group = groups.get(row.vendorInvoiceId) ?? [];
    const { vendorInvoiceId: _invoiceId, ...evidence } = row;
    group.push(evidence);
    groups.set(row.vendorInvoiceId, group);
  }
  return groups;
}

/** Preserve the complete invoice footprint, including other POs and non-completed
 * payment history. No allocation policy or money arithmetic belongs in this read. */
export async function readPoFinancialEvidenceSource(
  database: PoFinancialEvidenceDatabase,
  purchaseOrderId: number,
): Promise<PoFinancialEvidenceInput | null> {
  return database.transaction(
    async (tx) => {
      const [po] = await tx
        .select({
          id: purchaseOrders.id,
          vendorId: purchaseOrders.vendorId,
          currency: purchaseOrders.currency,
        })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, purchaseOrderId));
      if (!po) return null;
      const linked = await tx
        .select({ invoice: vendorInvoices })
        .from(vendorInvoicePoLinks)
        .leftJoin(
          vendorInvoices,
          eq(vendorInvoicePoLinks.vendorInvoiceId, vendorInvoices.id),
        )
        .where(eq(vendorInvoicePoLinks.purchaseOrderId, purchaseOrderId))
        .orderBy(asc(vendorInvoicePoLinks.id));
      const invoices = linked.map((row) => {
        if (!row.invoice) throw new PoFinancialEvidenceSourceError();
        return row.invoice;
      });
      const invoiceIds = [...new Set(invoices.map((invoice) => invoice.id))];
      if (invoiceIds.length === 0)
        return {
          purchaseOrderId: po.id,
          vendorId: po.vendorId,
          currency: po.currency,
          invoices: [],
        };

      const links = await tx
        .select({
          vendorInvoiceId: vendorInvoicePoLinks.vendorInvoiceId,
          purchaseOrderId: vendorInvoicePoLinks.purchaseOrderId,
          purchaseOrderVendorId: purchaseOrders.vendorId,
          purchaseOrderCurrency: purchaseOrders.currency,
        })
        .from(vendorInvoicePoLinks)
        .leftJoin(
          purchaseOrders,
          eq(vendorInvoicePoLinks.purchaseOrderId, purchaseOrders.id),
        )
        .where(inArray(vendorInvoicePoLinks.vendorInvoiceId, invoiceIds))
        .orderBy(asc(vendorInvoicePoLinks.id));
      const lines = await tx
        .select({
          vendorInvoiceId: vendorInvoiceLines.vendorInvoiceId,
          id: vendorInvoiceLines.id,
          purchaseOrderLineId: vendorInvoiceLines.purchaseOrderLineId,
          purchaseOrderId: purchaseOrderLines.purchaseOrderId,
          freightCostId: vendorInvoiceLines.freightCostId,
          lineTotalCents: vendorInvoiceLines.lineTotalCents,
        })
        .from(vendorInvoiceLines)
        .leftJoin(
          purchaseOrderLines,
          eq(vendorInvoiceLines.purchaseOrderLineId, purchaseOrderLines.id),
        )
        .where(inArray(vendorInvoiceLines.vendorInvoiceId, invoiceIds))
        .orderBy(asc(vendorInvoiceLines.id));
      const payments = await tx
        .select({
          vendorInvoiceId: apPaymentAllocations.vendorInvoiceId,
          allocationId: apPaymentAllocations.id,
          paymentId: apPaymentAllocations.apPaymentId,
          paymentVendorId: apPayments.vendorId,
          paymentCurrency: apPayments.currency,
          paymentStatus: apPayments.status,
          appliedAmountCents: apPaymentAllocations.appliedAmountCents,
        })
        .from(apPaymentAllocations)
        .leftJoin(
          apPayments,
          eq(apPaymentAllocations.apPaymentId, apPayments.id),
        )
        .where(inArray(apPaymentAllocations.vendorInvoiceId, invoiceIds))
        .orderBy(asc(apPaymentAllocations.id));
      const linksByInvoice = groupByInvoice(links),
        linesByInvoice = groupByInvoice(lines),
        paymentsByInvoice = groupByInvoice(payments);
      return {
        purchaseOrderId: po.id,
        vendorId: po.vendorId,
        currency: po.currency,
        invoices: invoices.map((invoice) => ({
          id: invoice.id,
          vendorId: invoice.vendorId,
          currency: invoice.currency,
          status: invoice.status,
          invoicedAmountCents: invoice.invoicedAmountCents,
          paidAmountCents: invoice.paidAmountCents,
          balanceCents: invoice.balanceCents,
          links: linksByInvoice.get(invoice.id) ?? [],
          lines: linesByInvoice.get(invoice.id) ?? [],
          payments: paymentsByInvoice.get(invoice.id) ?? [],
        })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
