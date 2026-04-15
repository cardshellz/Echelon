import type { Express } from "express";
import { WalletController } from "./interfaces/http/wallet.controller";
import { requireVendorAuth } from "./vendor-auth";

export function registerVendorWalletRoutes(app: Express) {
  /**
   * Routing arrays ensuring strictly authenticated wallet modifications structurally mapping to Orchestrator endpoints safely.
   */
  app.post("/api/vendor/wallet/checkout", requireVendorAuth, WalletController.requestCheckoutRouting);
  app.get("/api/vendor/wallet/dashboard", requireVendorAuth, WalletController.fetchDashboardData);
}
