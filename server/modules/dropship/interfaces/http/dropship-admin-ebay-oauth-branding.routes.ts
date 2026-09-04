import type { Express, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { DropshipEbayOAuthBrandingService } from "../../application/dropship-ebay-oauth-branding-service";

export function registerDropshipAdminEbayOAuthBrandingRoutes(
  app: Express,
  service: DropshipEbayOAuthBrandingService =
    new DropshipEbayOAuthBrandingService(process.env),
): void {
  app.get(
    "/api/dropship/admin/integrations/ebay/oauth-branding",
    requirePermission("dropship", "view"),
    (_req, res) => {
      try {
        return res.json({ configuration: service.getConfiguration() });
      } catch (error) {
        return sendEbayOAuthBrandingError(res, error);
      }
    },
  );
}

function sendEbayOAuthBrandingError(
  res: Response,
  error: unknown,
): Response {
  console.error(
    "[DropshipAdminEbayOAuthBrandingRoutes] Unexpected branding configuration error:",
    error,
  );
  return res.status(500).json({
    error: {
      code: "DROPSHIP_EBAY_OAUTH_BRANDING_INTERNAL_ERROR",
      message: "eBay OAuth branding configuration could not be loaded.",
    },
  });
}
