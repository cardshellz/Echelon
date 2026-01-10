import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertProductLocationSchema, updateProductLocationSchema } from "@shared/schema";
import { fetchAllShopifyProducts, verifyShopifyWebhook, extractSkusFromWebhookPayload } from "./shopify";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Product Locations API
  
  // Get all locations
  app.get("/api/locations", async (req, res) => {
    try {
      const locations = await storage.getAllProductLocations();
      res.json(locations);
    } catch (error) {
      console.error("Error fetching locations:", error);
      res.status(500).json({ error: "Failed to fetch locations" });
    }
  });

  // Get location by ID
  app.get("/api/locations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const location = await storage.getProductLocationById(id);
      
      if (!location) {
        return res.status(404).json({ error: "Location not found" });
      }
      
      res.json(location);
    } catch (error) {
      console.error("Error fetching location:", error);
      res.status(500).json({ error: "Failed to fetch location" });
    }
  });

  // Get location by SKU
  app.get("/api/locations/sku/:sku", async (req, res) => {
    try {
      const sku = req.params.sku;
      const location = await storage.getProductLocationBySku(sku);
      
      if (!location) {
        return res.status(404).json({ error: "Location not found" });
      }
      
      res.json(location);
    } catch (error) {
      console.error("Error fetching location by SKU:", error);
      res.status(500).json({ error: "Failed to fetch location" });
    }
  });

  // Create location
  app.post("/api/locations", async (req, res) => {
    try {
      const parsed = insertProductLocationSchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request data", details: parsed.error });
      }
      
      const location = await storage.createProductLocation(parsed.data);
      res.status(201).json(location);
    } catch (error: any) {
      console.error("Error creating location:", error);
      if (error.code === "23505") { // Unique constraint violation
        return res.status(409).json({ error: "SKU already exists" });
      }
      res.status(500).json({ error: "Failed to create location" });
    }
  });

  // Update location
  app.patch("/api/locations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const parsed = updateProductLocationSchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request data", details: parsed.error });
      }
      
      const location = await storage.updateProductLocation(id, parsed.data);
      
      if (!location) {
        return res.status(404).json({ error: "Location not found" });
      }
      
      res.json(location);
    } catch (error: any) {
      console.error("Error updating location:", error);
      if (error.code === "23505") {
        return res.status(409).json({ error: "SKU already exists" });
      }
      res.status(500).json({ error: "Failed to update location" });
    }
  });

  // Delete location
  app.delete("/api/locations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteProductLocation(id);
      
      if (!deleted) {
        return res.status(404).json({ error: "Location not found" });
      }
      
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting location:", error);
      res.status(500).json({ error: "Failed to delete location" });
    }
  });

  // Shopify Sync API
  app.post("/api/shopify/sync", async (req, res) => {
    try {
      console.log("Starting Shopify SKU sync...");
      
      const shopifyProducts = await fetchAllShopifyProducts();
      console.log(`Fetched ${shopifyProducts.length} SKUs from Shopify`);
      
      let created = 0;
      let updated = 0;
      
      for (const product of shopifyProducts) {
        const existing = await storage.getProductLocationBySku(product.sku);
        await storage.upsertProductLocationBySku(product.sku, product.name);
        if (existing) {
          updated++;
        } else {
          created++;
        }
      }
      
      const validSkus = shopifyProducts.map(p => p.sku);
      const deleted = await storage.deleteOrphanedSkus(validSkus);
      
      console.log(`Sync complete: ${created} created, ${updated} updated, ${deleted} deleted`);
      
      res.json({
        success: true,
        created,
        updated,
        deleted,
        total: shopifyProducts.length,
      });
    } catch (error: any) {
      console.error("Shopify sync error:", error);
      res.status(500).json({ 
        error: "Failed to sync with Shopify",
        message: error.message 
      });
    }
  });

  // Shopify Webhooks - need raw body for HMAC verification
  app.post("/api/shopify/webhooks/products/create", async (req: Request, res: Response) => {
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody;
      
      if (rawBody && !verifyShopifyWebhook(rawBody, hmac)) {
        console.error("Invalid Shopify webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
      
      const payload = req.body;
      const skus = extractSkusFromWebhookPayload(payload);
      
      for (const { sku, name } of skus) {
        await storage.upsertProductLocationBySku(sku, name);
      }
      
      console.log(`Webhook: Created/updated ${skus.length} SKUs from product create`);
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Product create webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  app.post("/api/shopify/webhooks/products/update", async (req: Request, res: Response) => {
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody;
      
      if (rawBody && !verifyShopifyWebhook(rawBody, hmac)) {
        console.error("Invalid Shopify webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
      
      const payload = req.body;
      const skus = extractSkusFromWebhookPayload(payload);
      
      for (const { sku, name } of skus) {
        await storage.upsertProductLocationBySku(sku, name);
      }
      
      console.log(`Webhook: Updated ${skus.length} SKUs from product update`);
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Product update webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  app.post("/api/shopify/webhooks/products/delete", async (req: Request, res: Response) => {
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody;
      
      if (rawBody && !verifyShopifyWebhook(rawBody, hmac)) {
        console.error("Invalid Shopify webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
      
      const payload = req.body;
      const skus = extractSkusFromWebhookPayload(payload);
      const skuList = skus.map(s => s.sku);
      
      const deleted = await storage.deleteProductLocationsBySku(skuList);
      console.log(`Webhook: Deleted ${deleted} SKUs from product delete`);
      
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Product delete webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  return httpServer;
}
