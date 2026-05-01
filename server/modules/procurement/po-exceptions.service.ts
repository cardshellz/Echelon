/**
 * PO Exceptions Service
 *
 * Manages the lifecycle of per-PO exception events: upsert, acknowledge,
 * resolve, dismiss, and auto-detection helpers wired to existing data hooks.
 *
 * Design principles:
 * - Rule #3: integer money only (cents). No floats.
 * - Rule #5: structured errors with code/message/context.
 * - Rule #6: upsertException is idempotent via payload_hash.
 * - Rule #7: lifecycle mutations are wrapped in transactions.
 * - Rule #8: every lifecycle event writes a po_status_history audit row.
 * - Rule #11: kind values come from EXCEPTION_KINDS constant only.
 */

import { createHash } from "crypto";
import { db } from "../../db";
import {
  poExceptions,
  poStatusHistory,
  purchaseOrders,
  purchaseOrderLines,
  vendors,
  vendorInvoices,
  vendorInvoicePoLinks,
  vendorInvoiceLines,
  EXCEPTION_KINDS,
  type ExceptionKind,
  type ExceptionSeverity,
  type ExceptionStatus,
  type PoException,
} from "@shared/schema";
import { eq, and, inArray, sql, desc } from "drizzle-orm";

// ─── Error class ──────────────────────────────────────────────────────────────

export class PoExceptionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PoExceptionError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hash for idempotent exception deduplication.
 * Input: po_id + kind + canonically sorted payload JSON.
 * This is the same hash stored in the payload_hash column.
 */
export function computePayloadHash(
  poId: number,
  kind: string,
  payload: Record<string, unknown>,
): string {
  // Canonical JSON: sort keys for determinism (Rule #2 — determinism).
  const canonical = JSON.stringify(sortKeys(payload));
  const raw = `${poId}|${kind}|${canonical}`;
  return createHash("sha256").update(raw).digest("hex");
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
}

/**
 * Format cents as a dollar string for human-readable audit notes.
 * Integer math only (Rule #3).
 */
function formatCents(cents: number | null | undefined): string {
  const n = Number(cents ?? 0);
  const dollars = Math.floor(Math.abs(n) / 100);
  const c = Math.abs(n) % 100;
  const sign = n < 0 ? "-" : "";
  return `${sign}$${dollars}.${c.toString().padStart(2, "0")}`;
}

// ─── Core CRUD ───────────────────────────────────────────────────────────────

export interface UpsertExceptionInput {
  poId: number;
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  title: string;
  message?: string;
  payload?: Record<string, unknown>;
  detectedBy?: string;
}

/**
 * Idempotent insert/update for exception detection.
 *
 * If an exception with the same (po_id, kind, payload_hash) already exists
 * with status=open or status=acknowledged, this updates detected_at, payload,
 * and updated_at instead of inserting a new row. This prevents duplicate flags
 * when detection hooks fire repeatedly for the same underlying issue (Rule #6).
 *
 * For genuinely new exceptions, inserts and writes an audit row to
 * po_status_history (Rule #8).
 */
export async function upsertException(
  input: UpsertExceptionInput,
): Promise<PoException> {
  const payload = input.payload ?? {};
  const hash = computePayloadHash(input.poId, input.kind, payload);
  const now = new Date();

  return await db.transaction(async (tx) => {
    // Check for an existing open/acknowledged exception with the same hash.
    const [existing] = await tx
      .select()
      .from(poExceptions)
      .where(
        and(
          eq(poExceptions.payloadHash, hash),
          inArray(poExceptions.status, ["open", "acknowledged"] as ExceptionStatus[]),
        ),
      );

    if (existing) {
      // Update the timestamp so the user knows it was re-detected.
      const [updated] = await tx
        .update(poExceptions)
        .set({
          detectedAt: now,
          updatedAt: now,
          payload: payload as any,
          // Re-stamp severity/title/message in case the detection logic
          // has been updated with better text.
          severity: input.severity,
          title: input.title,
          message: input.message ?? existing.message,
        })
        .where(eq(poExceptions.id, existing.id))
        .returning();
      return updated;
    }

    // Insert new exception.
    const [inserted] = await tx
      .insert(poExceptions)
      .values({
        poId: input.poId,
        kind: input.kind,
        severity: input.severity,
        status: "open",
        payload: payload as any,
        payloadHash: hash,
        title: input.title,
        message: input.message,
        detectedAt: now,
        detectedBy: input.detectedBy ?? "system",
        updatedAt: now,
      })
      .returning();

    // Audit row (Rule #8).
    await _writeAuditRow(tx, {
      poId: input.poId,
      notes: `Exception detected: ${input.kind} — ${input.title}`,
    });

    return inserted;
  });
}

/**
 * Mark an exception as acknowledged (user has seen it).
 * No confirmation prompt needed — fires immediately.
 */
export async function acknowledgeException(
  id: number,
  userId: string,
): Promise<PoException> {
  return await db.transaction(async (tx) => {
    const exc = await _requireException(tx, id);

    if (exc.status !== "open") {
      throw new PoExceptionError(
        `Cannot acknowledge exception in '${exc.status}' status`,
        "INVALID_STATUS_TRANSITION",
        400,
        { id, currentStatus: exc.status },
      );
    }

    const now = new Date();
    const [updated] = await tx
      .update(poExceptions)
      .set({ status: "acknowledged", acknowledgedAt: now, acknowledgedBy: userId, updatedAt: now })
      .where(eq(poExceptions.id, id))
      .returning();

    await _writeAuditRow(tx, {
      poId: exc.poId,
      notes: `Exception acknowledged: ${exc.kind} — ${exc.title} (by ${userId})`,
    });

    return updated;
  });
}

/**
 * Mark an exception as resolved with a mandatory resolution note.
 */
export async function resolveException(
  id: number,
  userId: string,
  resolutionNote: string,
): Promise<PoException> {
  if (!resolutionNote || resolutionNote.trim().length === 0) {
    throw new PoExceptionError(
      "resolutionNote is required to resolve an exception",
      "RESOLUTION_NOTE_REQUIRED",
      400,
      { id },
    );
  }

  return await db.transaction(async (tx) => {
    const exc = await _requireException(tx, id);

    if (exc.status === "resolved" || exc.status === "dismissed") {
      throw new PoExceptionError(
        `Cannot resolve exception in '${exc.status}' status`,
        "INVALID_STATUS_TRANSITION",
        400,
        { id, currentStatus: exc.status },
      );
    }

    const now = new Date();
    const [updated] = await tx
      .update(poExceptions)
      .set({
        status: "resolved",
        resolvedAt: now,
        resolvedBy: userId,
        resolutionNote: resolutionNote.trim(),
        updatedAt: now,
      })
      .where(eq(poExceptions.id, id))
      .returning();

    await _writeAuditRow(tx, {
      poId: exc.poId,
      notes: `Exception resolved: ${exc.kind} — ${exc.title}. Note: ${resolutionNote.trim()} (by ${userId})`,
    });

    return updated;
  });
}

/**
 * Dismiss an exception (false alarm or not actionable).
 * Reason note is optional.
 */
export async function dismissException(
  id: number,
  userId: string,
  note?: string,
): Promise<PoException> {
  return await db.transaction(async (tx) => {
    const exc = await _requireException(tx, id);

    if (exc.status === "resolved" || exc.status === "dismissed") {
      throw new PoExceptionError(
        `Cannot dismiss exception in '${exc.status}' status`,
        "INVALID_STATUS_TRANSITION",
        400,
        { id, currentStatus: exc.status },
      );
    }

    const now = new Date();
    const [updated] = await tx
      .update(poExceptions)
      .set({
        status: "dismissed",
        dismissedAt: now,
        dismissedBy: userId,
        dismissNote: note?.trim() ?? null,
        updatedAt: now,
      })
      .where(eq(poExceptions.id, id))
      .returning();

    await _writeAuditRow(tx, {
      poId: exc.poId,
      notes: `Exception dismissed: ${exc.kind} — ${exc.title}${note ? `. Reason: ${note.trim()}` : ""} (by ${userId})`,
    });

    return updated;
  });
}

/**
 * List exceptions for a PO.
 * By default returns only open + acknowledged exceptions.
 * Pass includeResolved=true to include resolved + dismissed rows.
 */
export async function listExceptions(
  poId: number,
  opts: { includeResolved?: boolean } = {},
): Promise<PoException[]> {
  const conditions = [eq(poExceptions.poId, poId)];

  if (!opts.includeResolved) {
    conditions.push(
      inArray(poExceptions.status, ["open", "acknowledged"] as ExceptionStatus[]),
    );
  }

  return db
    .select()
    .from(poExceptions)
    .where(and(...conditions))
    .orderBy(desc(poExceptions.detectedAt));
}

/**
 * Return open exception count and maximum severity for a PO.
 * Used for list-view badge rendering without N+1 queries.
 */
export async function countOpenExceptions(
  poId: number,
): Promise<{ count: number; maxSeverity: ExceptionSeverity | null }> {
  const rows = await db
    .select({
      severity: poExceptions.severity,
    })
    .from(poExceptions)
    .where(
      and(
        eq(poExceptions.poId, poId),
        inArray(poExceptions.status, ["open", "acknowledged"] as ExceptionStatus[]),
      ),
    );

  if (rows.length === 0) return { count: 0, maxSeverity: null };

  // Severity ranking: error > warn > info (Rule #11).
  const SEVERITY_RANK: Record<string, number> = { info: 0, warn: 1, error: 2 };
  let maxRank = -1;
  for (const row of rows) {
    const rank = SEVERITY_RANK[row.severity] ?? 0;
    if (rank > maxRank) maxRank = rank;
  }
  const RANK_SEVERITY: Record<number, ExceptionSeverity> = { 0: "info", 1: "warn", 2: "error" };

  return {
    count: rows.length,
    maxSeverity: RANK_SEVERITY[maxRank] ?? null,
  };
}

// ─── Auto-detection helpers ───────────────────────────────────────────────────

/**
 * Detect quantity variance exceptions (qty_short / qty_over) for a PO.
 *
 * Walks all non-cancelled PO lines. For any line where receivedQty != orderQty,
 * raises the appropriate exception. Excludes cancelled/closed/short_closed POs
 * (they're terminal states — no action needed).
 */
export async function detectQtyVariance(poId: number): Promise<void> {
  const po = await _getPo(poId);
  if (!po || _isTerminalPo(po)) return;

  const lines = await db
    .select({
      id: purchaseOrderLines.id,
      orderQty: purchaseOrderLines.orderQty,
      receivedQty: purchaseOrderLines.receivedQty,
      status: purchaseOrderLines.status,
      // Product info for human-readable messages.
      sku: purchaseOrderLines.sku,
      description: purchaseOrderLines.description,
    })
    .from(purchaseOrderLines)
    .where(
      and(
        eq(purchaseOrderLines.purchaseOrderId, poId),
        // Exclude cancelled lines — they should not generate exceptions.
        sql`${purchaseOrderLines.status} != 'cancelled'`,
      ),
    );

  for (const line of lines) {
    const ordered = Number(line.orderQty ?? 0);
    const received = Number(line.receivedQty ?? 0);
    const label = line.sku ?? line.description ?? `Line #${line.id}`;

    if (received < ordered) {
      const shortage = ordered - received;
      await upsertException({
        poId,
        kind: EXCEPTION_KINDS[0], // 'qty_short'
        severity: "warn",
        title: `Quantity short — ${label}`,
        message: `Received ${received} of ${ordered} units. Short by ${shortage} unit${shortage !== 1 ? "s" : ""}.`,
        payload: { lineId: line.id, orderedQty: ordered, receivedQty: received, shortageQty: shortage, sku: label },
        detectedBy: "system",
      });
    } else if (received > ordered) {
      const overage = received - ordered;
      await upsertException({
        poId,
        kind: EXCEPTION_KINDS[1], // 'qty_over'
        severity: "warn",
        title: `Quantity over — ${label}`,
        message: `Received ${received} of ${ordered} units. Over by ${overage} unit${overage !== 1 ? "s" : ""}.`,
        payload: { lineId: line.id, orderedQty: ordered, receivedQty: received, overageQty: overage, sku: label },
        detectedBy: "system",
      });
    }
  }
}

/**
 * Detect match_mismatch exception for a vendor invoice.
 *
 * Reads the invoice's linked PO and raises a match_mismatch exception when
 * any invoice line has a non-matched matchStatus.
 */
export async function detectMatchMismatch(invoiceId: number): Promise<void> {
  // Get invoice + its linked PO IDs.
  const [invoice] = await db
    .select({ id: vendorInvoices.id, invoiceNumber: vendorInvoices.invoiceNumber })
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, invoiceId));

  if (!invoice) return;

  const poLinks = await db
    .select({ purchaseOrderId: vendorInvoicePoLinks.purchaseOrderId })
    .from(vendorInvoicePoLinks)
    .where(eq(vendorInvoicePoLinks.vendorInvoiceId, invoiceId));

  if (poLinks.length === 0) return;

  // Get mismatched lines for this invoice.
  const mismatchedLines = await db
    .select({
      id: vendorInvoiceLines.id,
      matchStatus: vendorInvoiceLines.matchStatus,
      qtyInvoiced: vendorInvoiceLines.qtyInvoiced,
      unitCostCents: vendorInvoiceLines.unitCostCents,
    })
    .from(vendorInvoiceLines)
    .where(
      and(
        eq(vendorInvoiceLines.vendorInvoiceId, invoiceId),
        sql`${vendorInvoiceLines.matchStatus} != 'matched'`,
        sql`${vendorInvoiceLines.matchStatus} != 'pending'`,
      ),
    );

  if (mismatchedLines.length === 0) return;

  for (const poLink of poLinks) {
    const po = await _getPo(poLink.purchaseOrderId);
    if (!po || _isTerminalPo(po)) continue;

    await upsertException({
      poId: poLink.purchaseOrderId,
      kind: EXCEPTION_KINDS[8], // 'match_mismatch'
      severity: "warn",
      title: `3-way match discrepancy — Invoice ${invoice.invoiceNumber}`,
      message: `Invoice ${invoice.invoiceNumber} has ${mismatchedLines.length} line${mismatchedLines.length !== 1 ? "s" : ""} with match issues: ${[...new Set(mismatchedLines.map((l) => l.matchStatus))].join(", ")}.`,
      payload: {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        mismatchedLineCount: mismatchedLines.length,
        matchStatuses: [...new Set(mismatchedLines.map((l) => l.matchStatus))],
      },
      detectedBy: "system",
    });
  }
}

/**
 * Detect overpaid exception for a PO.
 *
 * Triggers when paidTotalCents > invoicedTotalCents. Uses integer arithmetic
 * only (Rule #3 — no floats).
 */
export async function detectOverpaid(poId: number): Promise<void> {
  const po = await _getPo(poId);
  if (!po || _isTerminalPo(po)) return;

  const paid = Number(po.paidTotalCents ?? 0);
  const invoiced = Number(po.invoicedTotalCents ?? 0);

  if (paid <= invoiced) return;

  const overageCents = paid - invoiced;

  await upsertException({
    poId,
    kind: EXCEPTION_KINDS[12], // 'overpaid'
    severity: "warn",
    title: "PO overpaid",
    message: `Paid ${formatCents(paid)} against ${formatCents(invoiced)} invoiced. Overpayment: ${formatCents(overageCents)}.`,
    payload: { paidCents: paid, invoicedCents: invoiced, overageCents },
    detectedBy: "system",
  });
}

/**
 * Detect past_due exception for a PO.
 *
 * Triggers when:
 *   - PO has been invoiced (firstInvoicedAt is set)
 *   - Outstanding balance > 0
 *   - Age since first invoice > vendor payment terms (default: Net 30)
 *
 * Excludes terminal POs (cancelled, closed, short_closed, paid).
 * Uses integer arithmetic (Rule #3).
 */
export async function detectPastDue(poId: number): Promise<void> {
  const po = await _getPo(poId);
  if (!po || _isTerminalPo(po)) return;

  // No invoice yet or already paid in full.
  if (!po.firstInvoicedAt || Number(po.outstandingCents ?? 0) <= 0) return;

  // Get vendor payment terms.
  const [vendor] = await db
    .select({ paymentTermsDays: vendors.paymentTermsDays })
    .from(vendors)
    .where(eq(vendors.id, po.vendorId));

  const termsDays = Number(vendor?.paymentTermsDays ?? 30);
  const termsMs = termsDays * 24 * 60 * 60 * 1000;
  const ageMs = Date.now() - new Date(po.firstInvoicedAt).getTime();

  if (ageMs <= termsMs) return;

  const daysOverdue = Math.floor(ageMs / 86400000) - termsDays;

  await upsertException({
    poId,
    kind: EXCEPTION_KINDS[13], // 'past_due'
    severity: "warn",
    title: "Invoice past due",
    message: `Outstanding ${formatCents(Number(po.outstandingCents))} on PO. Vendor terms: Net ${termsDays}. Overdue by ${daysOverdue} day${daysOverdue !== 1 ? "s" : ""}.`,
    payload: {
      outstandingCents: Number(po.outstandingCents),
      termsDays,
      daysOverdue,
    },
    detectedBy: "system",
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _getPo(poId: number): Promise<any | null> {
  const [po] = await db
    .select({
      id: purchaseOrders.id,
      vendorId: purchaseOrders.vendorId,
      physicalStatus: purchaseOrders.physicalStatus,
      financialStatus: purchaseOrders.financialStatus,
      outstandingCents: purchaseOrders.outstandingCents,
      paidTotalCents: purchaseOrders.paidTotalCents,
      invoicedTotalCents: purchaseOrders.invoicedTotalCents,
      firstInvoicedAt: purchaseOrders.firstInvoicedAt,
    })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId));
  return po ?? null;
}

/**
 * POs in terminal states should not generate new exceptions.
 * Terminal physical: 'cancelled', 'short_closed'
 * Terminal financial: 'paid' (but overpaid can still fire for paid POs
 *   where paid > invoiced, so we only skip truly closed/cancelled ones)
 */
function _isTerminalPo(po: { physicalStatus?: string | null; financialStatus?: string | null }): boolean {
  const physicalTerminal = ["cancelled", "short_closed"];
  return physicalTerminal.includes(po.physicalStatus ?? "");
}

/**
 * Require an exception row to exist, throw if not found.
 */
async function _requireException(
  tx: any,
  id: number,
): Promise<PoException> {
  const [exc] = await tx
    .select()
    .from(poExceptions)
    .where(eq(poExceptions.id, id));

  if (!exc) {
    throw new PoExceptionError(
      `PO exception #${id} not found`,
      "EXCEPTION_NOT_FOUND",
      404,
      { id },
    );
  }
  return exc;
}

/**
 * Write an audit row to po_status_history for exception lifecycle events.
 * Rule #8: every critical action must log who/what/when.
 *
 * We use toStatus = fromStatus (or 'open' sentinel) because the PO's own
 * lifecycle status doesn't change when an exception is created/resolved.
 * The notes field carries the human-readable event description.
 */
async function _writeAuditRow(
  tx: any,
  opts: { poId: number; notes: string },
): Promise<void> {
  // Look up current PO status for the from/to status fields.
  const [po] = await tx
    .select({ status: purchaseOrders.status })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, opts.poId));

  const currentStatus = po?.status ?? "unknown";

  await tx.insert(poStatusHistory).values({
    purchaseOrderId: opts.poId,
    fromStatus: currentStatus,
    toStatus: currentStatus,
    changedBy: null,
    notes: opts.notes,
  });
}


