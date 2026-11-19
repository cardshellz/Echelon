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
import { quantityVarianceLineLabel } from "./purchase-order-quantity-exceptions.policy";
import { synchronizePoFinancialExceptions } from "./po-financial-exceptions.service";
import { db } from "../../db";
import {
  poExceptions,
  poStatusHistory,
  purchaseOrders,
  purchaseOrderLines,
  vendorInvoices,
  vendorInvoicePoLinks,
  vendorInvoiceLines,
  EXCEPTION_KINDS,
  RECEIPT_RECONCILIATION_FAILED_KIND,
  type ExceptionKind,
  type ExceptionSeverity,
  type ExceptionStatus,
  type PoException,
} from "@shared/schema";
import { eq, and, inArray, sql, desc } from "drizzle-orm";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import { computePurchaseOrderInvoiceMatchSourceFingerprint } from "./purchase-order-invoice-match";
import { isRetiredReceiveExceptionKind } from "./receive-warning-policy";

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

// ─── Core CRUD ───────────────────────────────────────────────────────────────

export interface UpsertExceptionInput {
  poId: number;
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  title: string;
  message?: string;
  payload?: Record<string, unknown>;
  detectedBy?: string;
  preserveResolved?: boolean;
}

export interface RecordReceivingReconciliationFailureInput {
  poId: number;
  receivingOrderId: number;
  userId?: string | null;
  message: string;
  details?: Record<string, unknown>;
}

export async function recordReceivingReconciliationFailure(
  input: RecordReceivingReconciliationFailureInput,
): Promise<PoException> {
  return await upsertException({
    poId: input.poId,
    kind: RECEIPT_RECONCILIATION_FAILED_KIND,
    severity: "error",
    title: `Receipt reconciliation failed - RCV #${input.receivingOrderId}`,
    message: input.message,
    payload: {
      receivingOrderId: input.receivingOrderId,
      ...(input.details ?? {}),
    },
    detectedBy: input.userId ?? "system",
  });
}

// ─── Receive-time validation warnings (Spec D, Part 2) ─────────────────────
//
// The receiving close path evaluates receive-validation.service.ts detectors
// and reports each warning here. Warnings map to receive_* exception kinds
// (migration 187 extends the CHECK). Payload-hash dedup means re-closing or
// re-evaluating the same receipt never double-logs the same warning.

export interface ReceiveValidationWarningInput {
  kind: string;
  severity: "warn" | "error";
  receivingLineId: number;
  purchaseOrderLineId?: number;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
}

const RECEIVE_WARNING_KIND_TO_EXCEPTION_KIND: Record<string, ExceptionKind> = {
  cost_variance_soft: "receive_cost_variance_soft",
  cost_variance_hard: "receive_cost_variance_hard",
};

export async function recordReceiveValidationWarnings(input: {
  receivingOrderId: number;
  purchaseOrderId: number | null;
  warnings: ReceiveValidationWarningInput[];
  userId?: string | null;
}): Promise<void> {
  // Warnings are PO-scoped exceptions; without a PO there is nowhere to
  // persist them (blind receipts have no PO to attach an exception to).
  // The UI preview endpoint still surfaces them live.
  if (!input.purchaseOrderId) return;

  for (const warning of input.warnings) {
    const kind = RECEIVE_WARNING_KIND_TO_EXCEPTION_KIND[warning.kind];
    if (!kind) continue;
    try {
      await upsertException({
        poId: input.purchaseOrderId,
        kind,
        severity: warning.severity,
        title: warning.title,
        message: warning.detail,
        payload: {
          ...warning.payload,
          receivingOrderId: input.receivingOrderId,
          receivingLineId: warning.receivingLineId,
        },
        detectedBy: input.userId ?? "system",
      });
    } catch (error) {
      // Warning persistence must never fail the receiving close.
      console.warn(
        `[po-exceptions] Failed to persist receive warning ${warning.kind} for PO ${input.purchaseOrderId}:`,
        error,
      );
    }
  }
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
  if (isRetiredReceiveExceptionKind(input.kind)) {
    throw new PoExceptionError(
      "This obsolete receiving-pack warning is historical only. The saved receipt configuration owns its count unit.",
      "RETIRED_RECEIVE_PACK_WARNING", 400, { kind: input.kind },
    );
  }
  const payload = input.payload ?? {};
  const hash = computePayloadHash(input.poId, input.kind, payload);
  const now = new Date();

  return await db.transaction(async (tx) => {
    const reusableStatuses: ExceptionStatus[] = input.preserveResolved
      ? ["open", "acknowledged", "resolved"]
      : ["open", "acknowledged"];
    // Exact-source financial acceptances stay resolved. A changed source has a
    // different payload hash and therefore creates a new open exception.
    const [existing] = await tx
      .select()
      .from(poExceptions)
      .where(
        and(
          eq(poExceptions.payloadHash, hash),
          inArray(poExceptions.status, reusableStatuses),
        ),
      );

    if (existing) {
      if (existing.status === "resolved") return existing;
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
      actorId: userId,
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
    if (exc.kind === "match_mismatch") throw new PoExceptionError("A financial variance requires reviewed Administrator approval.", "PO_VARIANCE_ADMIN_APPROVAL_REQUIRED", 403, { id });

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
      actorId: userId,
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
      actorId: userId,
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
    const label = quantityVarianceLineLabel(line);

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
  const [invoice] = await db
    .select({
      id: vendorInvoices.id,
      invoiceNumber: vendorInvoices.invoiceNumber,
      status: vendorInvoices.status,
    })
    .from(vendorInvoices)
    .where(eq(vendorInvoices.id, invoiceId));

  if (!invoice || invoice.status === "voided") return;

  const poLinks = await db
    .select({ purchaseOrderId: vendorInvoicePoLinks.purchaseOrderId })
    .from(vendorInvoicePoLinks)
    .where(eq(vendorInvoicePoLinks.vendorInvoiceId, invoiceId));

  if (poLinks.length === 0) return;

  for (const poLink of poLinks) {
    const po = await _getPo(poLink.purchaseOrderId);
    if (!po || _isTerminalPo(po)) continue;

    const poLines = await db
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, poLink.purchaseOrderId));
    const allPoLinks = await db
      .select({ vendorInvoiceId: vendorInvoicePoLinks.vendorInvoiceId })
      .from(vendorInvoicePoLinks)
      .where(eq(vendorInvoicePoLinks.purchaseOrderId, poLink.purchaseOrderId));
    const linkedInvoiceIds = [...new Set(
      allPoLinks.map((link) => Number(link.vendorInvoiceId)),
    )].sort((left, right) => left - right);
    const linkedInvoices = linkedInvoiceIds.length === 0
      ? []
      : await db
        .select({ id: vendorInvoices.id, status: vendorInvoices.status })
        .from(vendorInvoices)
        .where(inArray(vendorInvoices.id, linkedInvoiceIds));
    const activeInvoices = linkedInvoices
      .filter((linkedInvoice) => linkedInvoice.status !== "voided")
      .sort((left, right) => left.id - right.id);
    const activeInvoiceIds = activeInvoices.map((linkedInvoice) => linkedInvoice.id);
    const allActiveInvoiceLines = activeInvoiceIds.length === 0
      ? []
      : await db
        .select()
        .from(vendorInvoiceLines)
        .where(inArray(vendorInvoiceLines.vendorInvoiceId, activeInvoiceIds));
    const poLineIds = new Set(poLines.map((line) => Number(line.id)));
    const scopedInvoiceLines = allActiveInvoiceLines.filter((line) =>
      line.purchaseOrderLineId == null || poLineIds.has(Number(line.purchaseOrderLineId)),
    );
    const mismatchedLines = scopedInvoiceLines.filter((line) =>
      Number(line.vendorInvoiceId) === invoiceId &&
      line.matchStatus !== "matched" &&
      line.matchStatus !== "pending",
    );
    if (mismatchedLines.length === 0) continue;

    const sourceFingerprint = computePurchaseOrderInvoiceMatchSourceFingerprint({
      purchaseOrderId: poLink.purchaseOrderId,
      purchaseOrderLines: poLines,
      activeInvoices,
      invoiceLines: scopedInvoiceLines,
    });

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
        mismatchedLineIds: mismatchedLines
          .map((line) => Number(line.id))
          .sort((left, right) => left - right),
        matchStatuses: [...new Set(mismatchedLines.map((l) => l.matchStatus))],
        sourceFingerprint,
        sourceVersion: 1,
      },
      detectedBy: "system",
      preserveResolved: true,
    });
  }
}

/** Financial detection shares one invoice-evidence synchronization owner. */
export async function detectFinancialExceptions(poId: number): Promise<void> {
  await synchronizePoFinancialExceptions(poId, { asOf: new Date() });
}
/** Compatibility wrapper for callers that request a single detector. */
export async function detectOverpaid(poId: number): Promise<void> {
  await synchronizePoFinancialExceptions(poId, { asOf: new Date(), kinds: ["overpaid"] });
}
/** Compatibility wrapper; recorded invoice due dates are the only due source. */
export async function detectPastDue(poId: number): Promise<void> {
  await synchronizePoFinancialExceptions(poId, { asOf: new Date(), kinds: ["past_due"] });
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

/** Physical receiving and matching detectors skip cancelled/short-closed POs.
 * Financial alerts use their separate invoice-evidence owner. */
function _isTerminalPo(po: { physicalStatus?: string | null; financialStatus?: string | null }): boolean {
  const physicalTerminal = ["cancelled", "short_closed"];
  return physicalTerminal.includes(po.physicalStatus ?? "");
}

/**
 * Require an exception row to exist, throw if not found.
 */
async function _requireException(tx: AmendmentTransaction, id: number): Promise<PoException> {
  const [scope] = await tx.select({ poId: poExceptions.poId }).from(poExceptions).where(eq(poExceptions.id, id));
  if (!scope) throw new PoExceptionError(`PO exception #${id} not found`, "EXCEPTION_NOT_FOUND", 404, { id });
  // Match the financial owners' graph -> PO -> exception order. Locking the
  // exception first can deadlock its history FK against a PO correction.
  await lockInventoryCostGraph(tx);
  const [po] = await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, scope.poId)).for("update");
  const [exception] = await tx.select().from(poExceptions).where(eq(poExceptions.id, id)).for("update");
  if (!po || !exception || exception.poId !== scope.poId) {
    throw new PoExceptionError("The exception scope changed. Reload the PO.", "EXCEPTION_STALE", 409, { id });
  }
  return exception;
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
  tx: AmendmentTransaction,
  opts: { poId: number; notes: string; actorId?: string },
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
    changedBy: opts.actorId ?? null,
    notes: opts.notes,
  });
}


