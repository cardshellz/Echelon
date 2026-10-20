import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { supplierCredits, supplierCreditLines, supplierCreditApplications, supplierCreditApplicationReversals, vendorInvoices, vendorInvoiceLines, vendors } from "@shared/schema";
import { supplierCreditDetailSchema, supplierCreditDispositionSchema, supplierCreditOptionsSchema, type SupplierCreditDetail, type SupplierCreditOptions } from "@shared/procurement/supplier-credit";
import { canonicalJson } from "@shared/utils/canonical-json";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import type { db } from "../../db";
import { readSupplierCreditSourceOptions, readSupplierCreditCostStatus, type SupplierCreditCostReadCache } from "./supplier-credit-source.service";
export type CreditTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class SupplierCreditError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message);
    this.name = "SupplierCreditError";
  }
}
export const creditHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const creditCapability = (allowed: boolean, code: string, reason: string) => ({
  allowed,
  code,
  reason
});
export async function loadSupplierCredit(tx: CreditTransaction, id: number, lock = false) {
  const query = tx.select().from(supplierCredits).where(eq(supplierCredits.id, id));
  const [credit] = await (lock ? query.for("update") : query);
  if (!credit) throw new SupplierCreditError("SUPPLIER_CREDIT_NOT_FOUND", "Supplier credit not found.", 404);
  return credit;
}
export async function loadSupplierCreditSource(tx: CreditTransaction, invoiceId: number, lock = false) {
  const query = tx.select().from(vendorInvoices).where(eq(vendorInvoices.id, invoiceId));
  const [invoice] = await (lock ? query.for("update") : query);
  if (!invoice) throw new SupplierCreditError("SUPPLIER_CREDIT_SOURCE_NOT_FOUND", "Original supplier invoice not found.", 404);
  const linesQuery = tx.select().from(vendorInvoiceLines).where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId)).orderBy(asc(vendorInvoiceLines.id));
  const lines = await (lock ? linesQuery.for("update") : linesQuery);
  const totals = await tx.execute(sql`SELECT l.invoice_line_id,coalesce(sum(l.amount_cents),0) AS amount
    FROM procurement.supplier_credit_lines l JOIN procurement.supplier_credits c ON c.id=l.supplier_credit_id
    WHERE c.source_invoice_id=${invoiceId} AND c.status='approved' GROUP BY l.invoice_line_id`);
  const credited = new Map(totals.rows.map(row => [costInteger(row.invoice_line_id, "credit.sourceLine", 1), costInteger(row.amount, "credit.sourceAmount")]));
  const sourceSnapshot = {
    invoice: {
      id: invoice.id,
      vendorId: invoice.vendorId,
      currency: invoice.currency,
      invoicedAmountCents: invoice.invoicedAmountCents
    },
    lines: lines.map(line => ({
      id: line.id,
      vendorInvoiceId: line.vendorInvoiceId,
      purchaseOrderLineId: line.purchaseOrderLineId,
      freightCostId: line.freightCostId,
      productVariantId: line.productVariantId,
      qtyInvoiced: line.qtyInvoiced,
      unitCostCents: line.unitCostCents,
      unitCostMills: line.unitCostMills,
      costComponentEvidence: line.costComponentEvidence,
      lineTotalCents: line.lineTotalCents
    }))
  };
  const version = creditHash({
    sourceSnapshot,
    status: invoice.status,
    credits: [...credited].sort((a, b) => a[0] - b[0])
  });
  return {
    invoice,
    lines,
    credited,
    version,
    sourceSnapshot
  };
}
export async function readSupplierCreditDetail(tx: CreditTransaction, id: number, canApprove: boolean, canCreate = false, cache?: SupplierCreditCostReadCache): Promise<SupplierCreditDetail> {
  const credit = await loadSupplierCredit(tx, id);
  const [source] = await tx.select({
    invoiceNumber: vendorInvoices.invoiceNumber,
    vendorName: vendors.name
  }).from(vendorInvoices).innerJoin(vendors, eq(vendors.id, vendorInvoices.vendorId)).where(eq(vendorInvoices.id, credit.sourceInvoiceId));
  if (!source) throw new SupplierCreditError("SUPPLIER_CREDIT_SOURCE_REVIEW", "Supplier or original invoice evidence is missing.");
  const [replacement] = await tx.select({
    id: supplierCredits.id
  }).from(supplierCredits).where(eq(supplierCredits.replacesCreditId, id));
  const lineRows = await tx.select({
    line: supplierCreditLines,
    source: vendorInvoiceLines
  }).from(supplierCreditLines).leftJoin(vendorInvoiceLines, eq(vendorInvoiceLines.id, supplierCreditLines.invoiceLineId)).where(eq(supplierCreditLines.supplierCreditId, id)).orderBy(asc(supplierCreditLines.id));
  const applicationRows = await tx.select({
    application: supplierCreditApplications,
    reversal: supplierCreditApplicationReversals,
    invoice: vendorInvoices
  }).from(supplierCreditApplications).leftJoin(supplierCreditApplicationReversals, eq(supplierCreditApplicationReversals.applicationId, supplierCreditApplications.id)).leftJoin(vendorInvoices, eq(vendorInvoices.id, supplierCreditApplications.vendorInvoiceId)).where(eq(supplierCreditApplications.supplierCreditId, id)).orderBy(asc(supplierCreditApplications.id));
  const issues: Array<{
    code: string;
    message: string;
  }> = [];
  const total = credit.totalAmountCents;
  let lineTotal = BigInt(0),
    applied = BigInt(0);
  for (const row of lineRows) {
    if (!Number.isSafeInteger(row.line.amountCents) || row.line.amountCents <= 0 || row.source?.vendorInvoiceId !== credit.sourceInvoiceId) issues.push({
      code: "SUPPLIER_CREDIT_LINE_REVIEW",
      message: "Original invoice line evidence is missing or invalid."
    });else lineTotal += BigInt(row.line.amountCents);
  }
  if (!Number.isSafeInteger(total) || total <= 0 || lineTotal !== BigInt(total)) issues.push({
    code: "SUPPLIER_CREDIT_TOTAL_REVIEW",
    message: "Credit lines do not reconcile to the original document amount."
  });
  for (const {
    application,
    reversal,
    invoice
  } of applicationRows) {
    if (!Number.isSafeInteger(application.appliedAmountCents) || application.appliedAmountCents <= 0 || !invoice || invoice.vendorId !== credit.vendorId || invoice.currency !== credit.currency || !reversal && credit.status !== "approved") issues.push({
      code: "SUPPLIER_CREDIT_APPLICATION_REVIEW",
      message: "A retained credit application has incompatible evidence."
    });else if (!reversal) applied += BigInt(application.appliedAmountCents);
  }
  if (Number.isSafeInteger(total) && applied > BigInt(total) || applied > BigInt(Number.MAX_SAFE_INTEGER)) issues.push({
    code: "SUPPLIER_CREDIT_OVERAPPLIED",
    message: "Credit applications exceed the recorded supplier document."
  });
  const cost = await readSupplierCreditCostStatus(tx, {
    creditId: id,
    cache
  });
  const version = creditHash({
    credit,
    lines: lineRows.map(row => row.line),
    applications: applicationRows.map(row => ({
      application: row.application,
      reversal: row.reversal
    })),
    cost
  });
  const eligible = canApprove && issues.length === 0;
  const lines = lineRows.map(({
    line,
    source: invoiceLine
  }) => ({
    id: line.id,
    invoiceLineId: line.invoiceLineId,
    amountCents: line.amountCents,
    label: invoiceLine?.description || invoiceLine?.productName || invoiceLine?.sku || `Invoice line ${line.invoiceLineId}`,
    disposition: supplierCreditDispositionSchema.parse(line.disposition),
    sourceEvidence: line.sourceEvidence,
    costState: cost.lines.find(row => row.id === line.id)?.costState ?? line.costState,
    costIssues: cost.lines.find(row => row.id === line.id)?.costIssues ?? line.costIssues,
    ...(cost.lines.find(row => row.id === line.id)?.inventoryEffect
      ? { inventoryEffect: cost.lines.find(row => row.id === line.id)!.inventoryEffect } : {}),
  }));
  const result = {
    ...credit,
    replacedByCreditId: replacement?.id ?? null,
    sourceInvoiceNumber: source.invoiceNumber,
    vendorName: source.vendorName,
    version,
    appliedAmountCents: issues.length ? null : Number(applied),
    unappliedAmountCents: issues.length ? null : credit.status === "approved" ? total - Number(applied) : 0,
    balanceState: issues.length ? "review_required" : credit.status === "draft" ? "draft" : credit.status === "voided" ? "voided" : applied === BigInt(total) ? "fully_applied" : "available",
    balanceIssues: issues,
    costStatus: cost.costStatus,
    costIssues: cost.costIssues,
    lines,
    applications: applicationRows.map(({
      application,
      reversal,
      invoice
    }) => ({
      ...application,
      invoiceNumber: invoice?.invoiceNumber ?? "Missing invoice",
      reversal: reversal ? {
        id: reversal.id,
        actorId: reversal.actorId,
        recordedAt: reversal.recordedAt,
        reason: reversal.reason
      } : null,
      canReverse: creditCapability(eligible && credit.status === "approved" && !reversal, "SUPPLIER_CREDIT_REVERSE", !canApprove ? "Purchasing approval permission required." : reversal ? "Application already reversed." : "Reverse this recorded noncash application.")
    })),
    capabilities: {
      reconcileCosts: creditCapability(
        eligible && credit.status === "approved" && ["pending", "review_required"].includes(cost.costStatus),
        "SUPPLIER_CREDIT_RECONCILE_COSTS",
        !canApprove ? "Purchasing approval permission required."
          : issues.length > 0 ? "Resolve supplier credit balance evidence before rechecking costs."
          : credit.status !== "approved" ? "Only an approved supplier credit can recheck its cost evidence."
          : cost.costStatus === "posted" ? "The current supplier credit cost evidence is already complete."
          : "Recheck current receipt and cost evidence. Unresolved issues remain visible; credit amounts and applications are unchanged.",
      ),
      replace: creditCapability(canCreate && credit.status === "voided" && !replacement, "SUPPLIER_CREDIT_REPLACE", replacement ? "An explicit replacement already exists." : "Create a reviewed replacement preserving this voided document."),
      approve: creditCapability(eligible && credit.status === "draft", "SUPPLIER_CREDIT_APPROVE", eligible ? "Approve the reviewed supplier document." : "Resolve evidence and permission requirements."),
      apply: creditCapability(eligible && credit.status === "approved" && applied < BigInt(total), "SUPPLIER_CREDIT_APPLY", eligible ? "Apply available credit to an approved invoice." : "Resolve evidence and permission requirements."),
      void: creditCapability(eligible && credit.status !== "voided" && applied === BigInt(0), "SUPPLIER_CREDIT_VOID", applied > BigInt(0) ? "Reverse active applications before voiding this credit." : "Void with an explicit reason; retained history is preserved.")
    }
  };
  // Only the declared DTO crosses the boundary; database transport Date values become ISO strings.
  const {
    sourceInvoiceId,
    vendorId,
    supplierReference,
    creditCalendarDate,
    totalAmountCents,
    currency,
    status,
    reason,
    createdBy,
    createdAt,
    approvedBy,
    approvedAt,
    voidedBy,
    voidedAt,
    voidReason
  } = result;
  return supplierCreditDetailSchema.parse(JSON.parse(JSON.stringify({
    id,
    sourceInvoiceId,
    vendorId,
    supplierReference,
    creditCalendarDate,
    totalAmountCents,
    currency,
    status,
    reason,
    createdBy,
    createdAt,
    approvedBy,
    approvedAt,
    voidedBy,
    voidedAt,
    voidReason,
    replacesCreditId: credit.replacesCreditId,
    replacedByCreditId: result.replacedByCreditId,
    sourceInvoiceNumber: result.sourceInvoiceNumber,
    vendorName: result.vendorName,
    version,
    appliedAmountCents: result.appliedAmountCents,
    unappliedAmountCents: result.unappliedAmountCents,
    balanceState: result.balanceState,
    balanceIssues: issues,
    costStatus: cost.costStatus,
    costIssues: cost.costIssues,
    lines,
    applications: result.applications.map(({
      supplierCreditId: _credit,
      ...row
    }) => row),
    capabilities: result.capabilities
  })));
}
export async function readSupplierCreditOptions(tx: CreditTransaction, invoiceId: number, actorId: string, canCreate: boolean, at: Date): Promise<SupplierCreditOptions> {
  const source = await loadSupplierCreditSource(tx, invoiceId);
  const [vendor] = await tx.select({
    name: vendors.name
  }).from(vendors).where(eq(vendors.id, source.invoice.vendorId));
  const choices = await readSupplierCreditSourceOptions(tx, {
    invoiceId,
    actorId,
    at
  });
  const allowed = canCreate && source.invoice.currency === "USD" && ["approved", "partially_paid", "paid"].includes(source.invoice.status);
  return supplierCreditOptionsSchema.parse({
    sourceInvoiceId: invoiceId,
    invoiceNumber: source.invoice.invoiceNumber,
    vendorId: source.invoice.vendorId,
    vendorName: vendor?.name ?? "Missing supplier",
    currency: source.invoice.currency,
    sourceVersion: source.version,
    canCreate: creditCapability(allowed, "SUPPLIER_CREDIT_SOURCE_REQUIRED", allowed ? "Record an explicit credit against this approved invoice." : "An approved USD invoice and purchasing edit permission are required."),
    lines: source.lines.map(line => {
      const option = choices.find(row => row.invoiceLineId === line.id);
      const credited = source.credited.get(line.id) ?? 0;
      if (!Number.isSafeInteger(line.lineTotalCents) || line.lineTotalCents < 0 || credited > line.lineTotalCents) throw new SupplierCreditError("SUPPLIER_CREDIT_SOURCE_REVIEW", "Original invoice line totals need review.");
      return {
        invoiceLineId: line.id,
        label: line.description || line.productName || line.sku || `Invoice line ${line.id}`,
        lineAmountCents: line.lineTotalCents,
        creditedAmountCents: credited,
        availableAmountCents: line.lineTotalCents - credited,
        components: option?.components ?? [],
        returnDispositions: option?.returnDispositions ?? [],
        acceptedReturns: option?.acceptedReturns ?? [],
        issues: option?.issues ?? []
      };
    })
  });
}
