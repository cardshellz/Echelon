import type { InventoryQuantityError } from "../domain/quantity-ledger";

/** One transport classification for quantity validation and operational conflicts. */
export function inventoryQuantityErrorStatus(
  error: InventoryQuantityError,
): 400 | 409 {
  return error.code === "QUANTITY_COMMAND_KEY_REQUIRED" ||
    error.code === "QUANTITY_COMMAND_INVALID"
    ? 400
    : 409;
}
