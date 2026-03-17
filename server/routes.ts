import type { Express } from "express";
import { createServer, type Server } from "http";
import { seedRBAC, seedDefaultChannels, seedAdjustmentReasons } from "./modules/identity/rbac";

import { registerAuthRoutes } from "./modules/identity/identity.routes";
import { registerLocationRoutes } from "./modules/warehouse/locations.routes";
import { registerPickingRoutes } from "./modules/orders/picking.routes";
import { registerShopifyRoutes } from "./routes/shopify.routes";
import { registerWarehouseRoutes } from "./modules/warehouse/warehouse.routes";
import { registerProductRoutes } from "./modules/catalog/catalog.routes";
import { registerInventoryRoutes } from "./modules/inventory/inventory.routes";
import { registerChannelRoutes } from "./modules/channels/channels.routes";
import { registerSettingsRoutes } from "./modules/warehouse/settings.routes";
import { registerPurchasingRoutes } from "./modules/procurement/procurement.routes";
import { registerEbayOAuthRoutes } from "./routes/ebay-oauth.routes";
import { registerEbaySettingsRoutes } from "./routes/ebay-settings.routes";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await seedRBAC();
  await seedDefaultChannels();
  await seedAdjustmentReasons();

  registerAuthRoutes(app);
  registerLocationRoutes(app);
  registerPickingRoutes(app);
  registerShopifyRoutes(app);
  registerWarehouseRoutes(app);
  registerProductRoutes(app);
  registerInventoryRoutes(app);
  registerChannelRoutes(app);
  registerSettingsRoutes(app);
  registerPurchasingRoutes(app);
  registerEbayOAuthRoutes(app);
  registerEbaySettingsRoutes(app);

  return httpServer;
}
