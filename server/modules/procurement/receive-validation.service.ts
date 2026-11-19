import { readIntegerMills, readIntegerCents } from "@shared/money-read";
import { RETIRED_RECEIVE_WARNING_KINDS } from "./receive-warning-policy";
/**
 * Receive-time validation warnings (Spec D, Part 2, 2026-08-07).
 *
 * Pure, deterministic detectors run at receiving-line close (and previewed
 * live in the receive UI). Warnings never block by default — receiving must
 * go on — but each warning is logged persistently through the PO exceptions
 * pattern (payload-hash deduped) and shown inline in the UI.
 *
 * Cost way off — resolved per-piece cost differs from the PO line's
 * implied per-piece cost by more than a configurable threshold (default
 * ±25%, echelon_settings key `receiving_cost_variance_warn_pct`), or is
 * an order of magnitude off (ratio > 5× or < 0.2×) — hard warn.
 * The receiving owner validates and saves the receipt's count configuration.
 * That frozen factor owns inventory, lot costs and PO received pieces. A PO's
 * preferred pack or catalog classification cannot invalidate a saved receipt
 * configuration. Unit/source errors are rejected by the receiving command;
 * they are not advisory comparisons against another document's pack size.
 *
 * Money discipline (Rule #3): integer mills only. Ratios are computed with
 * integer cross-multiplication — no floats anywhere on the money path.
 */

import { sql } from "drizzle-orm";

// ── Types ───────────────────────────────────────────────────────────────────

export const RECEIVE_WARNING_KINDS = [
  "cost_variance_soft",
  "cost_variance_hard",
  ...RETIRED_RECEIVE_WARNING_KINDS, // Historical records remain readable.
] as const;
export type ReceiveWarningKind = typeof RECEIVE_WARNING_KINDS[number];

export type ReceiveWarning = {
  kind: ReceiveWarningKind;
  severity: "warn" | "error";
  receivingLineId: number;
  purchaseOrderLineId?: number;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
};

export type ReceiveWarningInput = {
  receivingLineId: number;
  purchaseOrderLineId?: number | null;
  receivedQty: number;
  // Resolved per-PIECE cost on the receiving line (mills authoritative).
  unitCostMills?: number | null;
  unitCostCents?: number | null;
  /** @deprecated Accepted for older callers; a live catalog variant is not the receipt's count authority. */
  variant?: {
    id: number;
    unitsPerVariant: number;
    isBaseUnit?: boolean | null;
    /** @deprecated Accepted for older callers; never used to infer conversion permissions. */
    parentVariantId?: number | null;
    name?: string | null;
  } | null;
  /** @deprecated Accepted for older callers; the missing-parent detector is retired. */
  siblingsHaveParent?: boolean;
  // Linked PO line.
  poLine?: {
    id: number;
    /** @deprecated Purchase quantity does not define the saved receipt pack. */
    orderQty?: number;
    unitCostMills?: number | null;
    unitCostCents?: number | null;
    /** @deprecated A PO pack preference is not a receiving validation rule. */
    unitsPerUom?: number | null;
    /** @deprecated The saved receipt configuration supersedes this preference. */
    expectedReceiveUnitsPerVariant?: number | null;
  } | null;
};

// ── Constants (Rule #11 — no magic numbers) ─────────────────────────────────

/** Default soft cost-variance threshold: ±25%. Configurable via
 *  echelon_settings key `receiving_cost_variance_warn_pct` (integer percent). */
export const DEFAULT_COST_VARIANCE_WARN_PCT = 25;

/** Hard-warn ratio bounds: > 5× or < 1/5 of the PO-implied per-piece cost. */
export const COST_VARIANCE_HARD_RATIO_NUM = 5;

// ── Detectors ───────────────────────────────────────────────────────────────

/**
 * Evaluate all receive-time warnings for one receiving line. Pure function:
 * no I/O, no clocks, no randomness (Rule #2). Caller supplies every fact.
 */
export function evaluateReceiveWarnings(
  input: ReceiveWarningInput,
  opts: { costVarianceWarnPct?: number } = {},
): ReceiveWarning[] {
  const warnings: ReceiveWarning[] = [];
  const warnPct = normalizeWarnPct(opts.costVarianceWarnPct);

  const poLine = input.poLine ?? null;

  // Both prices are per piece, independent of the receipt's chosen pack size.
  if (poLine) {
    const actualMills = resolvePerPieceMills(input.unitCostMills, input.unitCostCents);
    const poMills = resolvePerPieceMills(poLine.unitCostMills, poLine.unitCostCents);
    if (actualMills !== null && poMills !== null && poMills > 0 && actualMills >= 0) {
      const hard = isHardVariance(actualMills, poMills);
      const soft = !hard && isSoftVariance(actualMills, poMills, warnPct);
      if (hard || soft) {
        warnings.push({
          kind: hard ? "cost_variance_hard" : "cost_variance_soft",
          severity: hard ? "error" : "warn",
          receivingLineId: input.receivingLineId,
          purchaseOrderLineId: poLine.id,
          title: hard
            ? "Receive cost is an order of magnitude off the PO"
            : "Receive cost differs from PO cost",
          detail: hard
            ? `Resolved per-piece cost (${actualMills} mills) is more than ${COST_VARIANCE_HARD_RATIO_NUM}× ` +
              `or less than 1/${COST_VARIANCE_HARD_RATIO_NUM} of the PO line cost (${poMills} mills). ` +
              `This usually means a case cost was entered against a piece-priced line.`
            : `Resolved per-piece cost (${actualMills} mills) differs from the PO line cost ` +
              `(${poMills} mills) by more than ${warnPct}%.`,
          payload: {
            receivingLineId: input.receivingLineId,
            purchaseOrderLineId: poLine.id,
            actualUnitCostMills: actualMills,
            poUnitCostMills: poMills,
            warnPct,
          },
        });
      }
    }
  }

  return warnings;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeWarnPct(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_COST_VARIANCE_WARN_PCT;
  const parsed = Math.trunc(value);
  if (parsed <= 0 || parsed > 1000) return DEFAULT_COST_VARIANCE_WARN_PCT;
  return parsed;
}

function resolvePerPieceMills(
  mills: number | null | undefined,
  cents: number | null | undefined,
): number | null {
  if (typeof mills === "number" && Number.isSafeInteger(mills) && mills >= 0) return mills;
  if (typeof cents === "number" && Number.isSafeInteger(cents) && cents >= 0) {
    const millsFromCents = BigInt(cents) * BigInt(100);
    return millsFromCents <= BigInt(Number.MAX_SAFE_INTEGER)
      ? readIntegerMills(millsFromCents, "Received per-piece unit cost") : null;
  }
  return null;
}

/**
 * Hard variance: actual > 5× po OR actual < po / 5. Integer cross-multiplication
 * (Rule #3 — no floats): actual × 1 > po × 5, or actual × 5 < po × 1.
 */
function isHardVariance(actualMills: number, poMills: number): boolean {
  return (
    BigInt(actualMills) > BigInt(poMills) * BigInt(COST_VARIANCE_HARD_RATIO_NUM) ||
    BigInt(actualMills) * BigInt(COST_VARIANCE_HARD_RATIO_NUM) < BigInt(poMills)
  );
}

/**
 * Soft variance: |actual - po| / po > pct/100, computed as
 * |actual - po| × 100 > po × pct (integer math only).
 */
function isSoftVariance(actualMills: number, poMills: number, pct: number): boolean {
  const delta = BigInt(actualMills) - BigInt(poMills);
  const diff = delta < BigInt(0) ? -delta : delta;
  return diff * BigInt(100) > BigInt(poMills) * BigInt(pct);
}

export const __testing__ = {
  resolvePerPieceMills,
  isHardVariance,
  isSoftVariance,
  normalizeWarnPct,
};

// ── Fact-gathering service ──────────────────────────────────────────────────
//
// Reads per-piece receipt/PO prices in one statement and runs the pure
// evaluator. Pack conversion remains owned by the saved receipt. Used by:
//   * the receive UI preview endpoint (GET .../validation-warnings), and
//   * the receiving close path, which persists warnings through the PO
//     exceptions pattern (payload-hash deduped, detectQtyVariance-style).

type ValidationDb = {
  execute: (query: any) => Promise<{ rows: any[] }>;
};

export class ReceiveValidationService {
  constructor(
    private db: ValidationDb,
    private getSetting?: (key: string) => Promise<string | null>,
  ) {}

  /** Evaluate warnings for every line on a receiving order. */
  async evaluateOrder(receivingOrderId: number): Promise<ReceiveWarning[]> {
    if (!Number.isSafeInteger(receivingOrderId) || receivingOrderId <= 0) {
      return [];
    }

    const warnPct = await this.resolveWarnPct();

    const lineRows = await this.db.execute(sql`
      SELECT rl.id AS receiving_line_id,
             rl.purchase_order_line_id,
             rl.received_qty,
             rl.unit_cost,
             rl.unit_cost_mills,
             po.id AS matched_po_line_id,
             po.unit_cost_mills AS po_unit_cost_mills,
             po.unit_cost_cents AS po_unit_cost_cents
      FROM procurement.receiving_lines rl
      LEFT JOIN procurement.purchase_order_lines po ON po.id=rl.purchase_order_line_id
      WHERE rl.receiving_order_id = ${receivingOrderId}
        AND rl.received_qty > 0
      ORDER BY rl.id
    `);
    if (lineRows.rows.length === 0) return [];

    const warnings: ReceiveWarning[] = [];
    for (const row of lineRows.rows) {
      let poLine: ReceiveWarningInput["poLine"] = null;
      const poLineId = Number(row.matched_po_line_id);
      if (Number.isSafeInteger(poLineId) && poLineId > 0) {
        poLine = {
          id: poLineId,
          unitCostMills: row.po_unit_cost_mills === null ? null : readIntegerMills(row.po_unit_cost_mills, "PO unit cost", true),
          unitCostCents: row.po_unit_cost_cents === null ? null : readIntegerCents(row.po_unit_cost_cents, "PO unit cost", true),
        };
      }

      warnings.push(
        ...evaluateReceiveWarnings(
          {
            receivingLineId: Number(row.receiving_line_id),
            purchaseOrderLineId: Number.isSafeInteger(poLineId) && poLineId > 0 ? poLineId : null,
            receivedQty: Number(row.received_qty) || 0,
            unitCostMills: row.unit_cost_mills === null ? null : readIntegerMills(row.unit_cost_mills, "unit cost", true),
            unitCostCents: row.unit_cost === null ? null : readIntegerCents(row.unit_cost, "received unit cost", true),
            poLine,
          },
          { costVarianceWarnPct: warnPct },
        ),
      );
    }

    return warnings;
  }

  private async resolveWarnPct(): Promise<number> {
    if (!this.getSetting) return DEFAULT_COST_VARIANCE_WARN_PCT;
    try {
      const raw = await this.getSetting("receiving_cost_variance_warn_pct");
      const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_COST_VARIANCE_WARN_PCT;
    } catch {
      return DEFAULT_COST_VARIANCE_WARN_PCT;
    }
  }
}

export function createReceiveValidationService(
  db: ValidationDb,
  getSetting?: (key: string) => Promise<string | null>,
) {
  return new ReceiveValidationService(db, getSetting);
}
