import { registerReceiptInvoiceCostRoutes } from "./receipt-invoice-costs.routes";
import { registerPurchasePipelineRoutes } from "./purchase-pipeline.routes";
import { registerPurchaseTaxRoutes } from "./purchase-tax.routes";
import { db } from "../../db";
import { registerDocumentRelationshipRoutes } from "./document-relationships.routes";
import { createDocumentRelationshipRepository } from "./document-relationships.repository";
import { createDocumentRelationshipService } from "./document-relationships.service";
import type { Express } from "express";
import { procurementStorage } from "../procurement";
import { requirePermission } from "../../routes/middleware";
import { registerReceivingRoutes } from "./receiving.routes";
import { registerPurchaseOrderRoutes } from "./purchase-order.routes";
import { registerPurchasingAdminRoutes } from "./purchasing-admin.routes";
import { registerInboundShipmentRoutes } from "./inbound-shipment.routes";
import { registerApLedgerRoutes } from "./ap-ledger.routes";
import { registerProcurementReportRoutes } from "./procurement-report.routes";
import { registerProcurementHealthRoutes } from "./procurement-health.routes";
import {
  registerPurchasingRecommendationAdminRoutes,
  registerPurchasingRecommendationRoutes,
} from "./purchasing-recommendation.routes";
import { registerDemandEventRoutes } from "./demand-events.routes";
import { registerEnterpriseDashboardRoutes } from "./enterprise-dashboard.routes";
import { registerPurchaseForecastBacktestingRoutes } from "./purchase-forecast-backtesting.routes";

export function registerPurchasingRoutes(app: Express) {
  registerPurchaseTaxRoutes(app);
  registerReceiptInvoiceCostRoutes(app);
  registerDocumentRelationshipRoutes(app, createDocumentRelationshipService(createDocumentRelationshipRepository(db)));
  // ===== VENDORS API =====
  
  app.get("/api/vendors", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const vendors = await procurementStorage.getAllVendors();
      res.json(vendors);
    } catch (error) {
      console.error("Error fetching vendors:", error);
      res.status(500).json({ error: "Failed to fetch vendors" });
    }
  });
  
  app.get("/api/vendors/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const vendor = await procurementStorage.getVendorById(id);
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }
      res.json(vendor);
    } catch (error) {
      console.error("Error fetching vendor:", error);
      res.status(500).json({ error: "Failed to fetch vendor" });
    }
  });
  
  app.post("/api/vendors", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const { vendor: vendorService } = req.app.locals.services;
      const vendor = await vendorService.create(req.body ?? {}, req.session.user?.id);
      res.status(201).json(vendor);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, ...error.details });
      console.error("Error creating vendor:", error);
      res.status(500).json({ error: "Failed to create vendor" });
    }
  });
  
  app.patch("/api/vendors/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { vendor: vendorService } = req.app.locals.services;
      const vendor = await vendorService.update(req.params.id, req.body ?? {}, req.session.user?.id);
      res.json(vendor);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, ...error.details });
      console.error("Error updating vendor:", error);
      res.status(500).json({ error: "Failed to update vendor" });
    }
  });
  
  app.delete("/api/vendors/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { vendor: vendorService } = req.app.locals.services;
      const vendor = await vendorService.deactivate(req.params.id, req.session.user?.id);
      res.json({ success: true, vendor });
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, ...error.details });
      console.error("Error deleting vendor:", error);
      res.status(500).json({ error: "Failed to deactivate vendor" });
    }
  });
  
  registerReceivingRoutes(app);

  registerPurchasingRecommendationRoutes(app);
  registerPurchaseForecastBacktestingRoutes(app);

  // ==========================================================================
  // PURCHASING - Purchase Orders, Vendor Products, Approval Tiers
  // ==========================================================================

  registerPurchaseOrderRoutes(app);
  registerPurchasingAdminRoutes(app);

  registerPurchasePipelineRoutes(app);
  registerProcurementReportRoutes(app);
  registerProcurementHealthRoutes(app);

  registerInboundShipmentRoutes(app);

  registerApLedgerRoutes(app);

  registerPurchasingRecommendationAdminRoutes(app);

  registerDemandEventRoutes(app, {
    getForecastPolicy: async () => (await procurementStorage.getAutoDraftSettings()).forecastPolicy,
  });

  registerEnterpriseDashboardRoutes(app);
}
