/**
 * Once the quantity ledger is open, an inventory level row can never be deleted:
 * even an empty bin row keeps its census, receiving and cost provenance
 * (inventory.guard_quantity_projection_delete, migration 242). An empty row for a
 * bin the variant is not assigned to holds no stock and no work, so views hide it
 * instead of offering a delete that the database must refuse.
 */
export interface InventoryLevelBalances {
  variantQty: number;
  reservedQty: number;
  pickedQty: number;
  packedQty: number;
}

export function isRetiredEmptyLevel(level: InventoryLevelBalances, isAssigned: boolean): boolean {
  return !isAssigned
    && level.variantQty === 0
    && level.reservedQty === 0
    && level.pickedQty === 0
    && level.packedQty === 0;
}

/** Postgres error raised by the ledger's projection delete guard. */
export const LEVEL_DELETE_FORBIDDEN_MESSAGE = "QUANTITY_PROJECTION_IDENTITY_DELETE_FORBIDDEN";

export function isLevelDeleteForbiddenError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "23514" && String(candidate.message ?? "").includes(LEVEL_DELETE_FORBIDDEN_MESSAGE)) return true;
    current = candidate.cause;
  }
  return false;
}
