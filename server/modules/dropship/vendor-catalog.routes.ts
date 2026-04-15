import type { Express } from "express";
import { CatalogController } from "./interfaces/http/catalog.controller";
import { requireVendorAuth } from "./vendor-auth";

export function registerVendorCatalogRoutes(app: Express) {
  /**
   * Primary Entrypoint for rendering the Wholesale grid directly to cardshellz.io
   * Guarded universally by Vendor level JWT checks inside requireVendorAuth.
   */
  app.get("/api/vendor/catalog", requireVendorAuth, CatalogController.fetchGrid);
}
