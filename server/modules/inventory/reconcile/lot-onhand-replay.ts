/**
 * Lot → levels on-hand reconciler (read-only).
 *
 * The trust ORACLE for the Lot-Identity & Lineage arc (see WMS-INVENTORY-REFACTOR.md
 * §6). `inventory.inventory_lots` are the FIFO cost layers; their physical on-hand
 * per (variant, location) MUST equal `inventory.inventory_levels.variant_qty` — the
 * ledger-reconciled spine that Phases 0–1 drove to zero variance. This module sums
 * lot on-hand per cell; the runner diffs it against inventory_levels. It mirrors the
 * Phase 0 ledger reconciler (ledger-replay.ts) but for the lot layer.
 *
 * Why it exists: the Lot-Identity refactor (L1–L3) moves lot storage from
 * "location is a column on the lot" to a lot↔location quantity table. This oracle is
 * the REGRESSION GATE for that migration — the lot-vs-level on-hand sum must stay at
 * zero variance at every step (backfill, dual-write, read-switch, write-switch).
 *
 * SCOPE: on-hand bucket only — matches the Phase 0 ledger reconciler's on-hand scope
 * (reserved/picked parity is a fast-follow, same rationale as finding C6).
 *
 * Pure + deterministic (no DB, no clock) so the summation is unit-testable; the DB
 * I/O lives in scripts/reconcile-lot-onhand.ts. The diff machinery (reconcile/cellKey/
 * Variance) is reused from ledger-replay so lot and ledger reconciliation share
 * identical variance semantics.
 */

import { cellKey } from "./ledger-replay";

// Re-export the shared diff machinery so the runner + tests import from one module.
export { reconcile, cellKey } from "./ledger-replay";
export type { LevelRow, Variance, ReconcileResult } from "./ledger-replay";

/** One inventory_lots row, narrowed to what on-hand reconciliation needs. */
export interface LotRow {
  productVariantId: number;
  warehouseLocationId: number;
  qtyOnHand: number;
}

/**
 * Sum lot on-hand per (variant, location) cell into the `expected` map shape that
 * the shared reconcile() consumes.
 *
 * Status note: qty_on_hand is summed regardless of lot status. Depleted lots carry
 * qty_on_hand = 0 (no effect); an expired lot with qty_on_hand > 0 is still
 * physically present and therefore still counted in inventory_levels.variant_qty, so
 * it must be counted here too — this is a PHYSICAL reconciliation, not a
 * sellable/FIFO-eligible one.
 */
export function sumLotsOnHand(rows: Iterable<LotRow>): Map<string, number> {
  const expected = new Map<string, number>();
  for (const row of rows) {
    if (row.productVariantId == null || row.warehouseLocationId == null) continue;
    const key = cellKey(row.productVariantId, row.warehouseLocationId);
    expected.set(key, (expected.get(key) ?? 0) + (Number(row.qtyOnHand) || 0));
  }
  return expected;
}
