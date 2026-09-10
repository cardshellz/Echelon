import type { RequestHandler, Response } from "express";
import { readInventoryQuantityCapabilities } from "../infrastructure/quantity-authority.query";
import { InventoryQuantityError } from "../domain/quantity-ledger";

/** Transport validation only. The transaction-owning inventory application
 * validates the semantic payload and persists replay evidence atomically.
 */
export const validateInventoryCommandKey: RequestHandler = (req, res, next) => {
  const key: unknown = req.body?.commandKey;
  if (key !== undefined && (typeof key !== "string" || key.trim() !== key || key.length === 0 || key.length > 120)) {
    res.status(400).json({ code: "INVENTORY_COMMAND_KEY_INVALID", error: "commandKey must contain 1–120 characters without surrounding whitespace." });
    return;
  }
  next();
};

export function sendInventoryQuantityError(res: Response, error: unknown): boolean {
  if (!(error instanceof InventoryQuantityError)) return false;
  const invalid = error.code === "QUANTITY_COMMAND_KEY_REQUIRED" || error.code === "QUANTITY_COMMAND_INVALID";
  res.status(invalid ? 400 : 409).json({ code: error.code, error: error.message, context: error.context });
  return true;
}

/** These old tools set aggregate balances or invent lot layers. They cannot be
 * used with ledger authority. The database projection guard also blocks a
 * concurrent cutover between this read and an old writer's transaction.
 */
export const requireLegacyQuantityImport: RequestHandler = async (_req, res, next) => {
  try {
    if (!(await readInventoryQuantityCapabilities()).legacyQuantityImportAllowed) {
      res.status(409).json({ code: "LEGACY_QUANTITY_IMPORT_RETIRED",
        error: "This legacy quantity import is retired under ledger authority. Use a receiving document, an audited inventory adjustment, or a claim-aware cycle count; changing costs alone must not create stock." });
      return;
    }
    next();
  } catch (error) { next(error); }
};
