import type { Express } from "express";
import { procurementStorage } from "../procurement";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
import { ordersStorage } from "../orders";
const storage = { ...procurementStorage, ...catalogStorage, ...warehouseStorage, ...inventoryStorage, ...ordersStorage };
import { requirePermission } from "../../routes/middleware";
import { requireIdempotency } from "../../middleware/idempotency";
import { PurchasingError } from "./purchasing.service";

export function registerPurchasingAdminRoutes(app: Express) {
  const { purchasing } = app.locals.services;


  // Vendor Products

  app.get("/api/vendor-products", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const filters = {
        vendorId: req.query.vendorId ? Number(req.query.vendorId) : undefined,
        productId: req.query.productId ? Number(req.query.productId) : undefined,
        productVariantId: req.query.productVariantId ? Number(req.query.productVariantId) : undefined,
        isActive: req.query.isActive !== undefined ? Number(req.query.isActive) : undefined,
      };
      const vendorProducts = await purchasing.getVendorProducts(filters);
      res.json({ vendorProducts });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/vendor-products", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const vp = await purchasing.createVendorProduct(req.body);
      res.status(201).json(vp);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Upsert: create or update vendor catalog entry by (vendorId, productId, productVariantId)
  app.post("/api/vendor-products/upsert", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { vendorId, productId, productVariantId, vendorSku, unitCostCents, packSize, isPreferred } = req.body;
      if (!vendorId || !productId || !productVariantId) {
        return res.status(400).json({ error: "vendorId, productId, and productVariantId are required" });
      }
      const existing = await purchasing.getVendorProducts({ vendorId, productId, productVariantId });
      let vp;
      if (existing.length > 0) {
        vp = await purchasing.updateVendorProduct(existing[0].id, {
          vendorSku: vendorSku || existing[0].vendorSku,
          unitCostCents: unitCostCents ?? existing[0].unitCostCents,
          packSize: packSize ?? existing[0].packSize,
          isPreferred: isPreferred ? 1 : existing[0].isPreferred,
        });
      } else {
        vp = await purchasing.createVendorProduct({
          vendorId,
          productId,
          productVariantId,
          vendorSku,
          unitCostCents: unitCostCents ?? 0,
          packSize: packSize ?? 1,
          isPreferred: isPreferred ? 1 : 0,
          isActive: 1,
        });
      }
      res.json({ vp, created: existing.length === 0 });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/vendor-products/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const vp = await purchasing.updateVendorProduct(Number(req.params.id), req.body);
      if (!vp) return res.status(404).json({ error: "Vendor product not found" });
      res.json(vp);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/vendor-products/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const deleted = await purchasing.deleteVendorProduct(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Vendor product not found" });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/products/:id/vendors", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const vendorProducts = await purchasing.getVendorProducts({ productId: Number(req.params.id) });
      res.json(vendorProducts);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/vendors/:id/products", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const vendorProducts = await purchasing.getVendorProducts({ vendorId: Number(req.params.id) });
      res.json({ vendorProducts });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Spec A follow-up: bulk upsert vendor catalog entries. Backs the
  app.post(
    "/api/vendors/:vendorId/catalog/bulk-upsert",
    requirePermission("purchasing", "edit"),
    requireIdempotency(),
    async (req, res) => {
      try {
        const vendorId = Number(req.params.vendorId);
        if (!Number.isInteger(vendorId) || vendorId <= 0) {
          return res.status(400).json({ error: "Invalid vendorId" });
        }
        const rawEntries = Array.isArray(req.body?.entries) ? req.body.entries : null;
        if (!rawEntries || rawEntries.length === 0) {
          return res.status(400).json({ error: "entries must be a non-empty array" });
        }
        // Normalize snake_case and carry through both unit_cost_cents and
        // unit_cost_mills. The service validator enforces pair agreement.
        const entries = rawEntries.map((e: any) => {
          const out: any = {
            productId: e.productId ?? e.product_id,
            productVariantId: e.productVariantId ?? e.product_variant_id ?? null,
            packSize: e.packSize ?? e.pack_size,
            moq: e.moq,
            leadTimeDays: e.leadTimeDays ?? e.lead_time_days,
            vendorSku: e.vendorSku ?? e.vendor_sku,
            vendorProductName: e.vendorProductName ?? e.vendor_product_name,
            isPreferred: e.isPreferred ?? e.is_preferred,
          };
          const cents = e.unitCostCents ?? e.unit_cost_cents;
          const mills = e.unitCostMills ?? e.unit_cost_mills;
          if (cents !== undefined && cents !== null) out.unitCostCents = Number(cents);
          if (mills !== undefined && mills !== null) out.unitCostMills = Number(mills);
          return out;
        });
        const userId = req.session.user?.id;
        const result = await purchasing.bulkUpsertVendorCatalog(vendorId, entries, userId);
        res.json(result);
      } catch (error: any) {
        if (error instanceof PurchasingError) {
          return res.status(error.statusCode).json({ error: error.message });
        }
        console.error("[catalog bulk-upsert] error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Spec A follow-up: two-layer catalog typeahead for the new PO editor.
  // Returns vendor-catalog matches (top) and non-catalog product matches (bottom).
  app.get(
    "/api/vendors/:vendorId/catalog-search",
    requirePermission("purchasing", "view"),
    async (req, res) => {
      try {
        const vendorId = Number(req.params.vendorId);
        if (!Number.isInteger(vendorId) || vendorId <= 0) {
          return res.status(400).json({ error: "Invalid vendorId" });
        }
        const vendor = await storage.getVendorById(vendorId);
        if (!vendor) return res.status(404).json({ error: "Vendor not found" });
        const q = typeof req.query.q === "string" ? req.query.q : "";
        const limitRaw = Number(req.query.limit);
        const limit =
          Number.isFinite(limitRaw) && limitRaw > 0
            ? Math.min(100, Math.floor(limitRaw))
            : 50;
        const result = await storage.searchVendorCatalog({ vendorId, q, limit });
        res.json(result);
      } catch (error: any) {
        console.error("[catalog-search] error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Approval Tiers

  app.get("/api/purchasing/approval-tiers", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const tiers = await purchasing.getApprovalTiers();
      res.json({ tiers });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchasing/approval-tiers", requirePermission("settings", "edit"), async (req, res) => {
    try {
      const tier = await purchasing.createApprovalTier(req.body);
      res.status(201).json(tier);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/purchasing/approval-tiers/:id", requirePermission("settings", "edit"), async (req, res) => {
    try {
      const tier = await purchasing.updateApprovalTier(Number(req.params.id), req.body);
      if (!tier) return res.status(404).json({ error: "Approval tier not found" });
      res.json(tier);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/purchasing/approval-tiers/:id", requirePermission("settings", "edit"), async (req, res) => {
    try {
      const deleted = await purchasing.deleteApprovalTier(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Approval tier not found" });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Reorder to PO

  app.post("/api/purchasing/create-po-from-reorder", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const pos = await purchasing.createPOFromReorder(req.body.items, req.session.user?.id);
      res.status(201).json({ purchaseOrders: pos });
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

}
