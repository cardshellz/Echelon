import { readIntegerCents } from "@shared/money-read";
import type { Express } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { procurementStorage } from "../..";
import { logger } from "../../../../platform/observability/logger";

export function registerProcurementReportRoutes(app: Express) {
  app.get("/api/reports/order-profitability", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      const rows = await procurementStorage.getOrderProfitabilityReport(limit, offset);
      res.json({ orders: rows });
    } catch (error: any) {
      logger.error("procurement.report_routes", { message: "Error fetching order profitability:", error: error });
      res.status(500).json({ error: error.message || "Failed to fetch order profitability" });
    }
  });

  app.get("/api/reports/product-profitability", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      const rows = await procurementStorage.getProductProfitabilityReport(limit, offset);
      res.json({ products: rows });
    } catch (error: any) {
      logger.error("procurement.report_routes", { message: "Error fetching product profitability:", error: error });
      res.status(500).json({ error: error.message || "Failed to fetch product profitability" });
    }
  });

  app.get("/api/reports/inventory-valuation", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { inventoryLots } = req.app.locals.services;
      const valuation = await inventoryLots.getInventoryValuation();
      res.json(valuation);
    } catch (error: any) {
      logger.error("procurement.report_routes", { message: "Error computing inventory valuation:", error: error });
      res.status(500).json({ error: error.message || "Failed to compute inventory valuation" });
    }
  });

  app.get("/api/reports/vendor-spend", requirePermission("purchasing", "view"), async (_req, res) => {
    try {
      const rows = await procurementStorage.getVendorSpendReport();
      res.json({ vendors: rows });
    } catch (error: any) {
      logger.error("procurement.report_routes", { message: "Error fetching vendor spend:", error: error });
      res.status(500).json({ error: error.message || "Failed to fetch vendor spend" });
    }
  });

  app.get("/api/reports/cost-variance", requirePermission("purchasing", "view"), async (_req, res) => {
    try {
      const rows = await procurementStorage.getCostVarianceReport();
      res.json({ variances: rows });
    } catch (error: any) {
      logger.error("procurement.report_routes", { message: "Error fetching cost variance:", error: error });
      res.status(500).json({ error: error.message || "Failed to fetch cost variance" });
    }
  });

  app.get("/api/reports/open-po-summary", requirePermission("purchasing", "view"), async (_req, res) => {
    try {
      const rows = await procurementStorage.getOpenPoSummaryReport();
      const total = (rows as any[]).reduce(
        (acc: any, r: any) => ({
          poCount: acc.poCount + Number(r.po_count),
          valueCents: acc.valueCents + readIntegerCents(r.total_value_cents ?? 0, "value", true),
        }),
        { poCount: 0, valueCents: 0 },
      );
      res.json({ byStatus: rows, total });
    } catch (error: any) {
      logger.error("procurement.report_routes", { message: "Error fetching open PO summary:", error: error });
      res.status(500).json({ error: error.message || "Failed to fetch open PO summary" });
    }
  });

  app.get("/api/reports/po-aging", requirePermission("purchasing", "view"), async (_req, res) => {
    try {
      const rows = await procurementStorage.getPoAgingReport();
      res.json({ orders: rows });
    } catch (error: any) {
      logger.error("procurement.report_routes", { message: "Error fetching PO aging:", error: error });
      res.status(500).json({ error: error.message || "Failed to fetch PO aging" });
    }
  });

  app.get("/api/reports/expected-receipts", requirePermission("purchasing", "view"), async (_req, res) => {
    try {
      const rows = await procurementStorage.getExpectedReceiptsReport();
      res.json({ receipts: rows });
    } catch (error: any) {
      logger.error("procurement.report_routes", { message: "Error fetching expected receipts:", error: error });
      res.status(500).json({ error: error.message || "Failed to fetch expected receipts" });
    }
  });
}
