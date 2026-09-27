import type { Express } from "express";
import { requirePermission } from "../../../../routes/middleware";
import {
  InventoryPublicationMembershipError,
  type InventoryPublicationMembershipService,
} from "../../application/inventory-publication-membership.service";
import { sendError } from "./inventory-product-definition.routes";

/** The listing UI calls the existing inventory owner; HTTP never writes stock,
 * mappings, drafts or runtime authority directly. */
export function registerInventoryPublicationMembershipRoutes(
  app: Express,
  service: Pick<
    InventoryPublicationMembershipService,
    "inspect" | "review" | "apply"
  >,
): void {
  const respond = (res: Parameters<typeof sendError>[0], error: unknown) => {
    if (error instanceof InventoryPublicationMembershipError) {
      if (error.status >= 500)
        console.error(
          JSON.stringify({
            event: "publication_membership_command_failed",
            code: error.code,
          }),
        );
      res
        .status(error.status)
        .json({ error: { code: error.code, message: error.message } });
      return;
    }
    sendError(res, error);
  };
  app.post(
    "/api/inventory-planning/admin/publication-membership/inspect",
    requirePermission("inventory_planning", "view"),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        res.json(await service.inspect(req.body));
      } catch (error) {
        respond(res, error);
      }
    },
  );
  app.post(
    "/api/inventory-planning/admin/publication-membership/review",
    requirePermission("inventory_planning", "view"),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        res.json(await service.review(req.body));
      } catch (error) {
        respond(res, error);
      }
    },
  );
  app.post(
    "/api/inventory-planning/admin/publication-membership/apply",
    requirePermission("inventory_planning", "activate"),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        res.json(await service.apply(req.body, req.session?.user?.id));
      } catch (error) {
        respond(res, error);
      }
    },
  );
}
