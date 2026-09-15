import type { Express, Request, Response } from "express";
import {
  INVENTORY_RUNTIME_AUTHORITY_READOUT_PATH,
  inventoryRuntimeAuthorityReadoutSchema,
} from "@shared/types/inventory-runtime-authority";
import { requireAnyPermission, type PermissionGrant } from "../../../../routes/middleware";
import { logger } from "../../../../platform/observability/logger";
import { InventoryRuntimeAuthorityReadoutService } from "../../application/inventory-runtime-authority-readout.service";
import { InventoryRuntimeAuthorityReadoutError } from "../../domain/inventory-runtime-authority-readout";
import { PostgresInventoryRuntimeAuthorityReadoutRepository } from "../../infrastructure/inventory-runtime-authority-readout.repository";

/**
 * Both operator screens that depend on the live allocator may read it:
 * Channel Allocation is gated by channels:view and Channel Inventory by
 * inventory_planning:view. Either grant is sufficient; nothing here mutates.
 */
export const INVENTORY_RUNTIME_AUTHORITY_GRANTS: readonly PermissionGrant[] = [
  ["channels", "view"],
  ["inventory_planning", "view"],
];

const READ_FAILED = {
  code: "INVENTORY_RUNTIME_AUTHORITY_READ_FAILED",
  message: "The inventory runtime authority could not be read.",
} as const;

export function registerInventoryRuntimeAuthorityRoutes(
  app: Express,
  service: Pick<InventoryRuntimeAuthorityReadoutService, "read"> =
    new InventoryRuntimeAuthorityReadoutService(new PostgresInventoryRuntimeAuthorityReadoutRepository()),
): void {
  app.get(
    INVENTORY_RUNTIME_AUTHORITY_READOUT_PATH,
    requireAnyPermission(...INVENTORY_RUNTIME_AUTHORITY_GRANTS),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      if (Object.keys(req.query).length > 0 || (req.body && Object.keys(req.body).length > 0)) {
        return res.status(400).json({ error: {
          code: "INVENTORY_RUNTIME_AUTHORITY_INVALID_REQUEST",
          message: "This read accepts no filters or commands.",
        } });
      }
      try {
        // Re-validate the service output so a malformed readout never reaches an operator.
        const readout = inventoryRuntimeAuthorityReadoutSchema.parse(await service.read());
        return res.json(readout);
      } catch (error) {
        if (error instanceof InventoryRuntimeAuthorityReadoutError) {
          // Transient read failures recover on reload; a missing or invalid singleton needs a human.
          const entry = {
            outcome: "failed",
            error_code: error.code,
            error_class: error.classification,
            context: error.context,
          };
          if (error.classification === "transient") logger.warn("inventory_runtime_authority_read", entry);
          else logger.error("inventory_runtime_authority_read", entry);
          return res.status(error.status).json({ error: { code: error.code, message: error.message } });
        }
        logger.error("inventory_runtime_authority_read", {
          outcome: "failed",
          error_code: READ_FAILED.code,
          error_class: "permanent",
          error_type: error instanceof Error ? error.name : "UnknownError",
        });
        return res.status(500).json({ error: READ_FAILED });
      }
    },
  );
}
