import type { Express } from "express";
import { AgentController } from "./interfaces/http/agent.controller";
import { requireVendorAuth } from "./vendor-auth";

export function registerVendorOrderRoutes(app: Express) {
  /**
   * Extensible Ingestion Route.
   * Can be hooked by native `cardshellz.io` clients generating simulated hits, 
   * OR natively intercepted via authentic platform webhooks parsing logic identically.
   */
  app.post("/api/agent/orders/ingest", requireVendorAuth, AgentController.ingestOrderRoute);
}
