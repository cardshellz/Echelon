import type { Express } from "express";
import { requirePermission } from "../../../../routes/middleware";

/** Old clients receive a correction instead of saving a second inclusion
 * decision. Historical journals are preserved unchanged. */
export function registerInventoryPublicationMembershipRoutes(app: Express): void {
  for (const operation of ["inspect", "review", "apply"] as const) {
    app.post(`/api/inventory-planning/admin/publication-membership/${operation}`,
      requirePermission("inventory_planning", operation === "apply" ? "activate" : "view"), (_req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.status(410).json({ error: { code: "PUBLICATION_MEMBERSHIP_RETIRED",
          message: "Stock now follows the existing channel listing selection. Include or exclude the product in its channel listing; no separate stock inclusion is required." } });
      });
  }
}
