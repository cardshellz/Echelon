/**
 * Ledger replay — Phase 0 ground-truth reconciler (read-only).
 *
 * Replays `inventory.inventory_transactions` to reconstruct the expected
 * physical on-hand (`variant_qty`) per (productVariantId, warehouseLocationId),
 * then a runner diffs that against actual `inventory.inventory_levels`.
 *
 * This module is the INSTRUMENT for the WMS trust work: it turns "are the
 * numbers right?" into a per-bin variance number, and it is the regression
 * oracle for every later phase (see WMS-INVENTORY-REFACTOR.md §0).
 *
 * SCOPE: on-hand bucket only. The ledger records signed `variant_qty_delta`
 * for physical on-hand; it does NOT record signed deltas for the reserved /
 * picked / packed / backorder buckets (finding C6), so those cannot be
 * replayed here. Reserved-bucket reconciliation is deferred to Phase 1 once
 * the ledger carries bucket deltas.
 *
 * The replay rules below were derived by reading every `createInventoryTransaction`
 * call site in inventory.use-cases.ts, returns.service.ts, and inventory.routes.ts
 * (NOT from documentation — the conventions are non-uniform). Each rule cites
 * the write site it mirrors.
 *
 * Pure + deterministic by design (no DB, no clock) so the convention rules are
 * unit-testable in isolation. The DB I/O lives in the runner script.
 */

/** A single ledger row, narrowed to the fields replay needs. */
export interface LedgerRow {
  transactionType: string;
  variantQtyDelta: number;
  productVariantId: number | null;
  fromLocationId: number | null;
  toLocationId: number | null;
}

/** Actual on-hand for one (variant, location) cell. */
export interface LevelRow {
  productVariantId: number;
  warehouseLocationId: number;
  variantQty: number;
}

/** Per-cell on-hand effect a ledger row contributes. */
interface CellDelta {
  productVariantId: number;
  warehouseLocationId: number;
  delta: number;
}

/**
 * Transaction types that do NOT move physical on-hand and must be skipped:
 *
 * - reserve / unreserve: delta is 0, they move the reserved bucket only
 *   (inventory.use-cases.ts:483, :542).
 * - reserve_move: moves the reserved bucket alongside a transfer; the paired
 *   `transfer` row already accounts for the on-hand movement
 *   (inventory.use-cases.ts:760).
 * - return: informational row written ALONGSIDE a real receipt/adjustment that
 *   already moved on-hand; counting it would double-count
 *   (returns.service.ts:136, :187 — paired with receiveInventory/adjustInventory).
 */
const NON_ONHAND_TYPES = new Set([
  "reserve",
  "unreserve",
  "reserve_move",
  "return",
]);

/**
 * Map one ledger row to its on-hand cell effect(s).
 *
 * Convention (verified against write sites):
 * - `transfer` is the ONLY dual-location, on-hand-moving type: it stores a
 *   POSITIVE delta with BOTH from/to set, meaning `from -= delta`, `to += delta`
 *   (inventory.use-cases.ts:741). Returns two cell deltas.
 * - All other on-hand types are single-location and the SIGN of the delta
 *   already encodes direction; the affected location is
 *   COALESCE(fromLocationId, toLocationId):
 *     receipt   → toLocationId,  +qty   (use-cases.ts:96)
 *     pick      → fromLocationId, -qty  (use-cases.ts:173)
 *     unpick    → fromLocationId, +qty  (use-cases.ts:227)
 *     ship      → fromLocationId, -qty  (use-cases.ts:344)
 *     adjustment→ from if delta<0 else to, signed (use-cases.ts:429)
 *     sku_correction → from(-) / to(+) as two separate single-loc rows
 *                      (use-cases.ts:849/873, routes.ts:257/277)
 *     csv_upload→ single-location signed (routes.ts)
 *     break/assemble/replenish → emitted as `adjustment` rows via adjustInventory,
 *       so they never appear under their own type here.
 */
export function ledgerRowToCellDeltas(row: LedgerRow): CellDelta[] {
  if (row.productVariantId == null) return []; // cannot attribute to a cell
  if (NON_ONHAND_TYPES.has(row.transactionType)) return [];
  if (row.variantQtyDelta === 0) return [];

  if (row.transactionType === "transfer") {
    // Dual-location move: positive delta, from -= delta, to += delta.
    // If either side is null we cannot fully attribute; emit the side we have.
    const out: CellDelta[] = [];
    if (row.fromLocationId != null) {
      out.push({
        productVariantId: row.productVariantId,
        warehouseLocationId: row.fromLocationId,
        delta: -row.variantQtyDelta,
      });
    }
    if (row.toLocationId != null) {
      out.push({
        productVariantId: row.productVariantId,
        warehouseLocationId: row.toLocationId,
        delta: row.variantQtyDelta,
      });
    }
    return out;
  }

  // Single-location, sign-encoded. Prefer fromLocationId when present
  // (outbound rows set from; inbound rows set to), else toLocationId.
  const locationId = row.fromLocationId ?? row.toLocationId;
  if (locationId == null) return [];

  return [
    {
      productVariantId: row.productVariantId,
      warehouseLocationId: locationId,
      delta: row.variantQtyDelta,
    },
  ];
}

/** Stable string key for a (variant, location) cell. */
export function cellKey(productVariantId: number, warehouseLocationId: number): string {
  return `${productVariantId}:${warehouseLocationId}`;
}

/**
 * Replay all ledger rows into expected on-hand per cell.
 * Returns a Map keyed by cellKey() → expected variant_qty.
 */
export function replayLedger(rows: Iterable<LedgerRow>): Map<string, number> {
  const expected = new Map<string, number>();
  for (const row of rows) {
    for (const cd of ledgerRowToCellDeltas(row)) {
      const key = cellKey(cd.productVariantId, cd.warehouseLocationId);
      expected.set(key, (expected.get(key) ?? 0) + cd.delta);
    }
  }
  return expected;
}

/** One reconciliation discrepancy. */
export interface Variance {
  productVariantId: number;
  warehouseLocationId: number;
  expected: number; // from ledger replay
  actual: number; // from inventory_levels
  diff: number; // actual - expected
}

export interface ReconcileResult {
  /** Cells whose replayed on-hand differs from the live level. */
  variances: Variance[];
  /** Total cells examined (union of ledger cells and level cells). */
  cellsChecked: number;
  /** Sum of |diff| across all variances — a single drift magnitude. */
  totalAbsDrift: number;
}

/**
 * Diff replayed expected on-hand against actual inventory_levels.
 *
 * Examines the UNION of cells: a cell present only in the ledger (expected≠0,
 * no level row) or only in levels (a level row with no ledger history) both
 * surface as variances — those are exactly the trust gaps we want to find
 * (e.g. the receiving case-break path that mutates levels without a ledger row,
 * finding C4).
 */
export function reconcile(
  expected: Map<string, number>,
  levels: Iterable<LevelRow>,
): ReconcileResult {
  // Build actual map and remember cell identity for output.
  const actual = new Map<string, number>();
  const cellMeta = new Map<string, { variant: number; location: number }>();

  for (const lvl of levels) {
    const key = cellKey(lvl.productVariantId, lvl.warehouseLocationId);
    actual.set(key, (actual.get(key) ?? 0) + lvl.variantQty);
    cellMeta.set(key, {
      variant: lvl.productVariantId,
      location: lvl.warehouseLocationId,
    });
  }

  // Ensure ledger-only cells are represented in cellMeta too.
  for (const key of expected.keys()) {
    if (!cellMeta.has(key)) {
      const [variant, location] = key.split(":").map(Number);
      cellMeta.set(key, { variant, location });
    }
  }

  const variances: Variance[] = [];
  let totalAbsDrift = 0;

  for (const [key, meta] of cellMeta) {
    const exp = expected.get(key) ?? 0;
    const act = actual.get(key) ?? 0;
    if (exp !== act) {
      const diff = act - exp;
      variances.push({
        productVariantId: meta.variant,
        warehouseLocationId: meta.location,
        expected: exp,
        actual: act,
        diff,
      });
      totalAbsDrift += Math.abs(diff);
    }
  }

  // Largest absolute drift first — most material discrepancies on top.
  variances.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    variances,
    cellsChecked: cellMeta.size,
    totalAbsDrift,
  };
}
