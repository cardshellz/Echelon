import { and, asc, eq, inArray } from "drizzle-orm";
import {
  auditEvents,
  poExceptions,
  poStatusHistory,
  purchaseOrders,
  vendorInvoices,
  type PoException,
} from "@shared/schema";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import {
  PoFinancialEvidenceSourceError,
  readPoFinancialEvidenceSourcesWithClient,
} from "./po-financial-evidence.repository";
import {
  FINANCIAL_EXCEPTION_KINDS,
  type FinancialAlert,
  type FinancialAlertEvaluation,
} from "./domain/po-financial-exceptions";

export async function lockFinancialExceptionScope(
  tx: AmendmentTransaction,
  poId: number,
) {
  await lockInventoryCostGraph(tx);
  const [po] = await tx
    .select({ id: purchaseOrders.id, status: purchaseOrders.status })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .for("update");
  if (!po) return null;
  const exceptions = await tx
    .select()
    .from(poExceptions)
    .where(
      and(
        eq(poExceptions.poId, poId),
        inArray(poExceptions.kind, [...FINANCIAL_EXCEPTION_KINDS]),
      ),
    )
    .orderBy(asc(poExceptions.id))
    .for("update");
  return { po, exceptions };
}
export async function readFinancialExceptionEvidence(
  tx: AmendmentTransaction,
  poId: number,
) {
  const source = (
    await readPoFinancialEvidenceSourcesWithClient(tx, [poId])
  ).get(poId);
  if (!source) throw new PoFinancialEvidenceSourceError();
  const ids = [...new Set(source.invoices.map((invoice) => invoice.id))];
  const schedules = ids.length
    ? await tx
        .select({
          id: vendorInvoices.id,
          invoiceNumber: vendorInvoices.invoiceNumber,
          dueDate: vendorInvoices.dueDate,
        })
        .from(vendorInvoices)
        .where(inArray(vendorInvoices.id, ids))
        .orderBy(asc(vendorInvoices.id))
    : [];
  return { source, schedules };
}
export async function insertFinancialAlert(
  tx: AmendmentTransaction,
  poId: number,
  alert: FinancialAlert,
  now: Date,
): Promise<PoException> {
  const [row] = await tx
    .insert(poExceptions)
    .values({
      poId,
      kind: alert.kind,
      severity: "warn",
      status: "open",
      payload: alert.payload,
      payloadHash: alert.identity,
      title: alert.title,
      message: alert.message,
      detectedBy: "system",
      detectedAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}
export async function retireFinancialAlert(
  tx: AmendmentTransaction,
  row: PoException,
  reason: string,
  now: Date,
): Promise<PoException> {
  const [updated] = await tx
    .update(poExceptions)
    .set({
      status: "resolved",
      resolvedAt: now,
      resolvedBy: "system:financial-evidence",
      resolutionNote: reason,
      updatedAt: now,
    })
    .where(eq(poExceptions.id, row.id))
    .returning();
  return updated;
}
export async function appendFinancialAlertAudit(
  tx: AmendmentTransaction,
  po: { id: number; status: string },
  before: PoException | null,
  after: PoException,
  reason: string,
  now: Date,
  evidence: Pick<FinancialAlertEvaluation, "invoiceIds" | "invoiceEvidence">,
): Promise<void> {
  await tx.insert(poStatusHistory).values({
    purchaseOrderId: po.id,
    fromStatus: po.status,
    toStatus: po.status,
    changedBy: null,
    changedAt: now,
    notes: `Financial exception #${after.id}: ${reason}`,
  });
  // Append-only before/after evidence is part of the same transaction. Failure
  // to record this final audit rolls back both the alert and status history.
  await tx.insert(auditEvents).values({
    actor: "system:financial-evidence",
    action: "po_financial_exception.synchronized",
    target: `po_exception:${after.id}`,
    timestamp: now,
    changes: { before, after },
    context: {
      purchaseOrderId: po.id,
      reason,
      asOf: now.toISOString(),
      evidence,
    },
  });
}
