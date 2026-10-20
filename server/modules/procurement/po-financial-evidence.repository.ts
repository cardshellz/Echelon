import { readInvoiceCreditEvidence } from "./supplier-credit-settlement.repository";
import { asc, eq, inArray } from "drizzle-orm";
import { poFinancialEvidenceIdSchema } from "@shared/procurement/po-financial-evidence";
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
type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PoFinancialEvidenceReadClient = Pick<TransactionClient, "select" | "execute">;

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

/** At most six queries for the whole batch, including each shared invoice's full
 * footprint. The caller owns snapshot/locking policy; this helper never opens a
 * transaction or writes. Missing POs are absent from the returned map. */
export async function readPoFinancialEvidenceSourcesWithClient(
  client: PoFinancialEvidenceReadClient,
  purchaseOrderIds: readonly number[],
): Promise<Map<number, PoFinancialEvidenceInput>> {
  const ids = [
    ...new Set(poFinancialEvidenceIdSchema.array().parse(purchaseOrderIds)),
  ].sort((left, right) => left - right);
  const sources = new Map<number, PoFinancialEvidenceInput>();
  if (ids.length === 0) return sources;
  const orders = await client
    .select({
      id: purchaseOrders.id,
      vendorId: purchaseOrders.vendorId,
      currency: purchaseOrders.currency,
    })
    .from(purchaseOrders)
    .where(inArray(purchaseOrders.id, ids))
    .orderBy(asc(purchaseOrders.id));
  if (orders.length === 0) return sources;
  const linked = await client
    .select({
      purchaseOrderId: vendorInvoicePoLinks.purchaseOrderId,
      invoice: vendorInvoices,
    })
    .from(vendorInvoicePoLinks)
    .leftJoin(
      vendorInvoices,
      eq(vendorInvoicePoLinks.vendorInvoiceId, vendorInvoices.id),
    )
    .where(
      inArray(
        vendorInvoicePoLinks.purchaseOrderId,
        orders.map((po) => po.id),
      ),
    )
    .orderBy(asc(vendorInvoicePoLinks.id));
  const invoicesByPo = new Map<
    number,
    (typeof vendorInvoices.$inferSelect)[]
  >();
  const invoiceIds = new Set<number>();
  for (const row of linked) {
    if (!row.invoice) throw new PoFinancialEvidenceSourceError();
    const invoices = invoicesByPo.get(row.purchaseOrderId) ?? [];
    // Preserve duplicate target links so domain validation can classify them.
    invoices.push(row.invoice);
    invoicesByPo.set(row.purchaseOrderId, invoices);
    invoiceIds.add(row.invoice.id);
  }
  // Invoice lines can prove a PO association even when the required header
  // relationship is missing. Preserve that invoice so domain validation reports
  // the broken relationship instead of presenting the PO as unbilled.
  const owned = await client
    .select({
      purchaseOrderId: purchaseOrderLines.purchaseOrderId,
      invoice: vendorInvoices,
    })
    .from(vendorInvoiceLines)
    .innerJoin(
      purchaseOrderLines,
      eq(vendorInvoiceLines.purchaseOrderLineId, purchaseOrderLines.id),
    )
    .leftJoin(
      vendorInvoices,
      eq(vendorInvoiceLines.vendorInvoiceId, vendorInvoices.id),
    )
    .where(
      inArray(
        purchaseOrderLines.purchaseOrderId,
        orders.map((po) => po.id),
      ),
    )
    .orderBy(asc(vendorInvoiceLines.id));
  const discoveredByPo = new Map(
    [...invoicesByPo].map(([poId, invoices]) => [
      poId,
      new Set(invoices.map((invoice) => invoice.id)),
    ]),
  );
  for (const row of owned) {
    if (!row.invoice) throw new PoFinancialEvidenceSourceError();
    const discovered =
      discoveredByPo.get(row.purchaseOrderId) ?? new Set<number>();
    if (discovered.has(row.invoice.id)) continue;
    discovered.add(row.invoice.id);
    discoveredByPo.set(row.purchaseOrderId, discovered);
    const invoices = invoicesByPo.get(row.purchaseOrderId) ?? [];
    invoices.push(row.invoice);
    invoicesByPo.set(row.purchaseOrderId, invoices);
    invoiceIds.add(row.invoice.id);
  }
  for (const po of orders) {
    sources.set(po.id, {
      purchaseOrderId: po.id,
      vendorId: po.vendorId,
      currency: po.currency,
      invoices: [],
    });
  }
  if (invoiceIds.size === 0) return sources;
  const linkedInvoiceIds = [...invoiceIds].sort((left, right) => left - right);
  const links = await client
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
    .where(inArray(vendorInvoicePoLinks.vendorInvoiceId, linkedInvoiceIds))
    .orderBy(asc(vendorInvoicePoLinks.id));
  const lines = await client
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
    .where(inArray(vendorInvoiceLines.vendorInvoiceId, linkedInvoiceIds))
    .orderBy(asc(vendorInvoiceLines.id));
  const payments = await client
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
    .leftJoin(apPayments, eq(apPaymentAllocations.apPaymentId, apPayments.id))
    .where(inArray(apPaymentAllocations.vendorInvoiceId, linkedInvoiceIds))
    .orderBy(asc(apPaymentAllocations.id));
  const creditsByInvoice = await readInvoiceCreditEvidence(client, linkedInvoiceIds);
  const linksByInvoice = groupByInvoice(links);
  const linesByInvoice = groupByInvoice(lines);
  const paymentsByInvoice = groupByInvoice(payments);
  for (const po of orders) {
    sources.set(po.id, {
      purchaseOrderId: po.id,
      vendorId: po.vendorId,
      currency: po.currency,
      invoices: (invoicesByPo.get(po.id) ?? []).map((invoice) => ({
        id: invoice.id,
        vendorId: invoice.vendorId,
        currency: invoice.currency,
        status: invoice.status,
        invoicedAmountCents: invoice.invoicedAmountCents,
        paidAmountCents: invoice.paidAmountCents,
        creditedAmountCents: invoice.creditedAmountCents, credits: creditsByInvoice.get(invoice.id) ?? [],
        balanceCents: invoice.balanceCents,
        links: linksByInvoice.get(invoice.id) ?? [],
        lines: linesByInvoice.get(invoice.id) ?? [],
        payments: paymentsByInvoice.get(invoice.id) ?? [],
      })),
    });
  }
  return sources;
}

/** Preserve the single-PO API and read all evidence in one consistent snapshot. */
export async function readPoFinancialEvidenceSource(
  database: PoFinancialEvidenceDatabase,
  purchaseOrderId: number,
): Promise<PoFinancialEvidenceInput | null> {
  const id = poFinancialEvidenceIdSchema.parse(purchaseOrderId);
  return database.transaction(
    async (tx) =>
      (await readPoFinancialEvidenceSourcesWithClient(tx, [id])).get(id) ??
      null,
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
