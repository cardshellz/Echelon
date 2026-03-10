import type { Express } from "express";
import { createServer, type Server } from "http";
import { seedRBAC, seedDefaultChannels, seedAdjustmentReasons } from "./rbac";

import { registerAuthRoutes } from "./routes/auth.routes";
import { registerLocationRoutes } from "./routes/locations.routes";
import { registerPickingRoutes } from "./routes/picking.routes";
import { registerShopifyRoutes } from "./routes/shopify.routes";
import { registerWarehouseRoutes } from "./routes/warehouse.routes";
import { registerProductRoutes } from "./routes/products.routes";
import { registerInventoryRoutes } from "./routes/inventory.routes";
import { registerChannelRoutes } from "./routes/channels.routes";
import { registerSettingsRoutes } from "./routes/settings.routes";
import { registerPurchasingRoutes } from "./routes/purchasing.routes";

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

  return httpServer;
}
