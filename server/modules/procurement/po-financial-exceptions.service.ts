import { db } from "../../db";
import type { PoException } from "@shared/schema";
import { poFinancialEvidenceIdSchema } from "@shared/procurement/po-financial-evidence";
import {
  FINANCIAL_EXCEPTION_KINDS,
  FINANCIAL_EXCEPTION_OWNER,
  evaluatePoFinancialExceptions,
  type FinancialExceptionKind,
} from "./domain/po-financial-exceptions";
import {
  PoFinancialEvidenceSourceError,
  type PoFinancialEvidenceDatabase,
} from "./po-financial-evidence.repository";
import {
  appendFinancialAlertAudit,
  insertFinancialAlert,
  lockFinancialExceptionScope,
  readFinancialExceptionEvidence,
  retireFinancialAlert,
} from "./po-financial-exceptions.repository";

function payload(row: PoException): Record<string, unknown> {
  return row.payload !== null &&
    typeof row.payload === "object" &&
    !Array.isArray(row.payload)
    ? (row.payload as Record<string, unknown>)
    : {};
}
function owned(row: PoException): boolean {
  return (
    row.detectedBy === "system" &&
    payload(row).owner === FINANCIAL_EXCEPTION_OWNER
  );
}
function active(row: PoException): boolean {
  return row.status === "open" || row.status === "acknowledged";
}
function legacyOwned(row: PoException): boolean {
  if (row.detectedBy !== "system" || payload(row).owner !== undefined)
    return false;
  const keys = Object.keys(payload(row)).sort().join(",");
  return row.kind === "overpaid"
    ? keys === "invoicedCents,overageCents,paidCents"
    : row.kind === "past_due" &&
        keys === "daysOverdue,outstandingCents,termsDays";
}
function manuallyDisposed(row: PoException): boolean {
  return (
    row.status === "dismissed" ||
    (row.status === "resolved" &&
      row.resolvedBy !== "system:financial-evidence")
  );
}
export interface FinancialExceptionSyncOptions {
  asOf: Date;
  kinds?: readonly FinancialExceptionKind[];
}

export function createPoFinancialExceptionService(
  database: PoFinancialEvidenceDatabase,
) {
  return {
    async synchronize(
      poId: number,
      options: FinancialExceptionSyncOptions,
    ): Promise<void> {
      poFinancialEvidenceIdSchema.parse(poId);
      if (
        !(options.asOf instanceof Date) ||
        !Number.isFinite(options.asOf.getTime())
      )
        throw new TypeError("Financial exception asOf must be a valid Date");
      const kinds = [...new Set(options.kinds ?? FINANCIAL_EXCEPTION_KINDS)];
      if (kinds.some((kind) => !FINANCIAL_EXCEPTION_KINDS.includes(kind)))
        throw new TypeError("Unsupported financial exception kind");
      const now = new Date(options.asOf.getTime());
      await database.transaction(
        async (tx) => {
          const locked = await lockFinancialExceptionScope(tx, poId);
          if (!locked) return;
          let evidence: Awaited<
            ReturnType<typeof readFinancialExceptionEvidence>
          >;
          try {
            evidence = await readFinancialExceptionEvidence(tx, poId);
          } catch (error) {
            if (!(error instanceof PoFinancialEvidenceSourceError)) throw error;
            console.error(
              JSON.stringify({
                code: error.code,
                purchaseOrderId: poId,
                action: "financial_alerts_preserved",
                asOf: now.toISOString(),
              }),
            );
            return;
          }
          const evaluation = evaluatePoFinancialExceptions(
            evidence.source,
            evidence.schedules,
            now,
          );
          if (evaluation.diagnostics.length)
            console.warn(
              JSON.stringify({
                code: "PO_FINANCIAL_ALERT_EVIDENCE_UNKNOWN",
                purchaseOrderId: poId,
                diagnostics: evaluation.diagnostics,
                preservedKinds: evaluation.unknownKinds,
                asOf: now.toISOString(),
              }),
            );
          for (const kind of kinds) {
            if (evaluation.unknownKinds.includes(kind)) continue;
            const desired = evaluation.alerts.filter(
              (alert) => alert.kind === kind,
            );
            const rows = locked.exceptions.filter((row) => row.kind === kind);
            for (const row of rows.filter(active)) {
              if (!owned(row) && !legacyOwned(row)) continue;
              const replacement = desired.find(
                (alert) => alert.identity === row.payloadHash,
              );
              if (
                replacement &&
                payload(row).sourceFingerprint === replacement.sourceFingerprint
              )
                continue;
              const reason = legacyOwned(row)
                ? "Legacy PO aggregate alert superseded by verified current linked-invoice evidence."
                : replacement
                  ? "Linked invoice evidence changed; this previous alert is superseded."
                  : !evaluation.invoiceIds.includes(
                        Number(payload(row).invoiceId),
                      )
                    ? "Invoice is no longer linked to this PO; this does not assert that its debt was paid."
                    : "Current linked invoice evidence no longer meets this alert condition.";
              const retired = await retireFinancialAlert(tx, row, reason, now);
              await appendFinancialAlertAudit(
                tx,
                locked.po,
                row,
                retired,
                reason,
                now,
                {
                  invoiceIds: evaluation.invoiceIds,
                  invoiceEvidence: evaluation.invoiceEvidence,
                },
              );
            }
            for (const alert of desired) {
              const unchangedActive = rows.some(
                (row) =>
                  owned(row) &&
                  active(row) &&
                  row.payloadHash === alert.identity &&
                  payload(row).sourceFingerprint === alert.sourceFingerprint,
              );
              const manuallySuppressed = rows.some(
                (row) =>
                  owned(row) &&
                  manuallyDisposed(row) &&
                  row.payloadHash === alert.identity &&
                  payload(row).sourceFingerprint === alert.sourceFingerprint,
              );
              if (unchangedActive || manuallySuppressed) continue;
              const created = await insertFinancialAlert(tx, poId, alert, now);
              await appendFinancialAlertAudit(
                tx,
                locked.po,
                null,
                created,
                "Verified current linked invoice requires financial follow-up.",
                now,
                {
                  invoiceIds: evaluation.invoiceIds,
                  invoiceEvidence: evaluation.invoiceEvidence,
                },
              );
            }
          }
        },
        { isolationLevel: "read committed" },
      );
    },
  };
}

/** Explicit stateful boundary: production callers supply wall time here; the
 * decision engine and injectable application service never read the clock. */
export async function synchronizePoFinancialExceptions(
  poId: number,
  options: FinancialExceptionSyncOptions,
): Promise<void> {
  await createPoFinancialExceptionService(db).synchronize(poId, options);
}
