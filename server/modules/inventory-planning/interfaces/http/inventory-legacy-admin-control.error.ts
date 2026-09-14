import type { Response } from "express";

import { InventoryAvailabilityRuntimeAtpError } from "../../application/inventory-availability-runtime-atp.service";
import { InventoryLegacyAdminControlError } from "../../application/inventory-legacy-admin-control.service";

/** Writes the shared structured failure contract and returns whether it handled the error. */
export function sendInventoryLegacyAdminControlError(res: Response, error: unknown): boolean {
  if (error instanceof InventoryLegacyAdminControlError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
    return true;
  }
  if (error instanceof InventoryAvailabilityRuntimeAtpError) {
    res.status(503).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
    return true;
  }
  return false;
}
