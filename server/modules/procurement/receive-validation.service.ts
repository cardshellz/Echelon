/**
 * Receive-time validation warnings (Spec D, Part 2, 2026-08-07).
 *
 * Pure, deterministic detectors run at receiving-line close (and previewed
 * live in the receive UI). Warnings never block by default — receiving must
 * go on — but each warning is logged persistently through the PO exceptions
 * pattern (payload-hash deduped) and shown inline in the UI.
 *
 * Three detector families:
 *   1. UOM disagreement — the receiving variant's units_per_variant disagrees
 *      with the linked PO line's UOM fields (units_per_uom /
 *      expected_receive_units_per_variant), or the variant is_base_unit while
 *      the PO line implies a pack size > 1. (The March 2026 incident class.)
 *   2. Cost way off — resolved per-piece cost differs from the PO line's
 *      implied per-piece cost by more than a configurable threshold (default
 *      ±25%, echelon_settings key `receiving_cost_variance_warn_pct`), or is
 *      an order of magnitude off (ratio > 5× or < 0.2×) — hard warn.
 *   3. Variant config sanity — case-named variant (units_per_variant > 1)
 *      flagged is_base_unit, or missing parent_variant_id where siblings
 *      have one.
 *
 * Money discipline (Rule #3): integer mills only. Ratios are computed with
 * integer cross-multiplication — no floats anywhere on the money path.
 */

import { sql } from "drizzle-orm";

// ── Types ───────────────────────────────────────────────────────────────────

export const RECEIVE_WARNING_KINDS = [
  "uom_disagreement",
  "base_unit_pack_conflict",
  "cost_variance_soft",
  "cost_variance_hard",
  "variant_base_unit_misconfig",
  "variant_missing_parent",
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
  // Receiving variant (looked up live).
  variant?: {
    id: number;
    unitsPerVariant: number;
    isBaseUnit?: boolean | null;
    parentVariantId?: number | null;
    name?: string | null;
  } | null;
  // True when at least one sibling variant of the same product has a
  // parent_variant_id (used by the missing-parent detector).
  siblingsHaveParent?: boolean;
  // Linked PO line.
  poLine?: {
    id: number;
    orderQty: number;
    unitCostMills?: number | null;
    unitCostCents?: number | null;
    unitsPerUom?: number | null;
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

  const variant = input.variant ?? null;
  const poLine = input.poLine ?? null;
  const unitsPerVariant = Math.max(1, Number(variant?.unitsPerVariant) || 1);

  // ── 1. UOM disagreement ────────────────────────────────────────────────
  if (poLine && variant) {
    const poImpliedPack = resolvePoImpliedPackSize(poLine);
    if (poImpliedPack !== null && poImpliedPack !== unitsPerVariant) {
      warnings.push({
        kind: "uom_disagreement",
        severity: "warn",
        receivingLineId: input.receivingLineId,
        purchaseOrderLineId: poLine.id,
        title: "Receive UOM disagrees with PO line",
        detail:
          `Receiving variant packs ${unitsPerVariant} piece${unitsPerVariant === 1 ? "" : "s"} ` +
          `but the PO line implies ${poImpliedPack} per receive unit. ` +
          `Received qty is interpreted in the variant's units — verify the pack size before closing.`,
        payload: {
          receivingLineId: input.receivingLineId,
          purchaseOrderLineId: poLine.id,
          variantUnitsPerVariant: unitsPerVariant,
          poImpliedPackSize: poImpliedPack,
        },
      });
    }

    // Variant flagged base-unit while the PO line implies a pack > 1.
    if (variant.isBaseUnit === true && poImpliedPack !== null && poImpliedPack > 1) {
      warnings.push({
        kind: "base_unit_pack_conflict",
        severity: "warn",
        receivingLineId: input.receivingLineId,
        purchaseOrderLineId: poLine.id,
        title: "Base-unit variant vs PO pack size",
        detail:
          `Receiving variant is flagged as the base unit but the PO line implies ` +
          `a pack size of ${poImpliedPack}. A base-unit variant receiving against a ` +
          `case-priced PO line posts pieces as cases (the March 2026 incident class).`,
        payload: {
          receivingLineId: input.receivingLineId,
          purchaseOrderLineId: poLine.id,
          variantIsBaseUnit: true,
          poImpliedPackSize: poImpliedPack,
        },
      });
    }
  }

  // ── 2. Cost way off ────────────────────────────────────────────────────
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

  // ── 3. Variant config sanity ───────────────────────────────────────────
  if (variant) {
    if (unitsPerVariant > 1 && variant.isBaseUnit === true) {
      warnings.push({
        kind: "variant_base_unit_misconfig",
        severity: "warn",
        receivingLineId: input.receivingLineId,
        purchaseOrderLineId: poLine?.id,
        title: "Case-sized variant flagged as base unit",
        detail:
          `Variant "${variant.name ?? variant.id}" packs ${unitsPerVariant} pieces but is ` +
          `flagged is_base_unit. Catalog misconfiguration — receiving will credit ` +
          `${unitsPerVariant}× too few pieces per unit.`,
        payload: {
          receivingLineId: input.receivingLineId,
          variantId: variant.id,
          unitsPerVariant,
          isBaseUnit: true,
        },
      });
    }

    const missingParent =
      (variant.parentVariantId === null || variant.parentVariantId === undefined) &&
      input.siblingsHaveParent === true &&
      unitsPerVariant > 1;
    if (missingParent) {
      warnings.push({
        kind: "variant_missing_parent",
        severity: "warn",
        receivingLineId: input.receivingLineId,
        purchaseOrderLineId: poLine?.id,
        title: "Case variant missing parent link",
        detail:
          `Variant "${variant.name ?? variant.id}" packs ${unitsPerVariant} pieces but has no ` +
          `parent_variant_id while sibling variants do. Catalog hierarchy is incomplete.`,
        payload: {
          receivingLineId: input.receivingLineId,
          variantId: variant.id,
          unitsPerVariant,
        },
      });
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

/**
 * The pack size the PO line implies for receiving. Prefers
 * expected_receive_units_per_variant (the modern field), falls back to the
 * legacy units_per_uom. Returns null when neither implies a pack size
 * (both unset or <= 1 means pieces — no disagreement possible).
 */
function resolvePoImpliedPackSize(poLine: {
  unitsPerUom?: number | null;
  expectedReceiveUnitsPerVariant?: number | null;
}): number | null {
  const expected = Number(poLine.expectedReceiveUnitsPerVariant);
  if (Number.isSafeInteger(expected) && expected > 0) return expected;
  const legacy = Number(poLine.unitsPerUom);
  if (Number.isSafeInteger(legacy) && legacy > 0) return legacy;
  return null;
}

function resolvePerPieceMills(
  mills: number | null | undefined,
  cents: number | null | undefined,
): number | null {
  if (typeof mills === "number" && Number.isSafeInteger(mills) && mills >= 0) return mills;
  if (typeof cents === "number" && Number.isSafeInteger(cents) && cents >= 0) return cents * 100;
  return null;
}

/**
 * Hard variance: actual > 5× po OR actual < po / 5. Integer cross-multiplication
 * (Rule #3 — no floats): actual × 1 > po × 5, or actual × 5 < po × 1.
 */
function isHardVariance(actualMills: number, poMills: number): boolean {
  return (
    actualMills > poMills * COST_VARIANCE_HARD_RATIO_NUM ||
    actualMills * COST_VARIANCE_HARD_RATIO_NUM < poMills
  );
}

/**
 * Soft variance: |actual - po| / po > pct/100, computed as
 * |actual - po| × 100 > po × pct (integer math only).
 */
function isSoftVariance(actualMills: number, poMills: number, pct: number): boolean {
  const diff = Math.abs(actualMills - poMills);
  return diff * 100 > poMills * pct;
}

export const __testing__ = {
  resolvePoImpliedPackSize,
  resolvePerPieceMills,
  isHardVariance,
  isSoftVariance,
  normalizeWarnPct,
};

// ── Fact-gathering service ──────────────────────────────────────────────────
//
// Pulls the live variant / PO-line facts for each receiving line and runs the
// pure evaluator. Used by:
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
             rl.product_variant_id,
             rl.product_id
      FROM procurement.receiving_lines rl
      WHERE rl.receiving_order_id = ${receivingOrderId}
        AND rl.received_qty > 0
      ORDER BY rl.id
    `);
    if (lineRows.rows.length === 0) return [];

    const warnings: ReceiveWarning[] = [];
    for (const row of lineRows.rows) {
      const variantId = Number(row.product_variant_id);
      let variant: ReceiveWarningInput["variant"] = null;
      let siblingsHaveParent = false;

      if (Number.isSafeInteger(variantId) && variantId > 0) {
        const variantRows = await this.db.execute(sql`
          SELECT id, units_per_variant, is_base_unit, parent_variant_id, name, product_id
          FROM catalog.product_variants
          WHERE id = ${variantId}
          LIMIT 1
        `);
        const v = variantRows.rows?.[0];
        if (v) {
          variant = {
            id: Number(v.id),
            unitsPerVariant: Math.max(1, Number(v.units_per_variant) || 1),
            isBaseUnit: v.is_base_unit === true,
            parentVariantId: v.parent_variant_id === null ? null : Number(v.parent_variant_id),
            name: v.name ?? null,
          };
          const productId = Number(v.product_id ?? row.product_id);
          if (Number.isSafeInteger(productId) && productId > 0) {
            const siblingRows = await this.db.execute(sql`
              SELECT COUNT(*)::int AS n
              FROM catalog.product_variants
              WHERE product_id = ${productId}
                AND id <> ${variantId}
                AND parent_variant_id IS NOT NULL
            `);
            siblingsHaveParent = Number(siblingRows.rows?.[0]?.n ?? 0) > 0;
          }
        }
      }

      let poLine: ReceiveWarningInput["poLine"] = null;
      const poLineId = Number(row.purchase_order_line_id);
      if (Number.isSafeInteger(poLineId) && poLineId > 0) {
        const poLineRows = await this.db.execute(sql`
          SELECT id, order_qty, unit_cost_mills, unit_cost_cents,
                 units_per_uom, expected_receive_units_per_variant
          FROM procurement.purchase_order_lines
          WHERE id = ${poLineId}
          LIMIT 1
        `);
        const p = poLineRows.rows?.[0];
        if (p) {
          poLine = {
            id: Number(p.id),
            orderQty: Number(p.order_qty) || 0,
            unitCostMills: p.unit_cost_mills === null ? null : Number(p.unit_cost_mills),
            unitCostCents: p.unit_cost_cents === null ? null : Number(p.unit_cost_cents),
            unitsPerUom: p.units_per_uom === null ? null : Number(p.units_per_uom),
            expectedReceiveUnitsPerVariant:
              p.expected_receive_units_per_variant === null
                ? null
                : Number(p.expected_receive_units_per_variant),
          };
        }
      }

      warnings.push(
        ...evaluateReceiveWarnings(
          {
            receivingLineId: Number(row.receiving_line_id),
            purchaseOrderLineId: Number.isSafeInteger(poLineId) && poLineId > 0 ? poLineId : null,
            receivedQty: Number(row.received_qty) || 0,
            unitCostMills: row.unit_cost_mills === null ? null : Number(row.unit_cost_mills),
            unitCostCents: row.unit_cost === null ? null : Number(row.unit_cost),
            variant,
            siblingsHaveParent,
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
