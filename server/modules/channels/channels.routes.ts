import type { Express } from "express";
import { z } from "zod";
import { channelsStorage } from "../channels";
import { ordersStorage } from "../orders";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
const storage = { ...channelsStorage, ...ordersStorage, ...catalogStorage, ...warehouseStorage, ...inventoryStorage };
import { requirePermission } from "../../routes/middleware";
import { insertChannelSchema, insertChannelReservationSchema } from "@shared/schema";
import { db } from "../../storage/base";
import {
  channelWarehouseAssignments,
  channelAllocationRules,
  channels as channelsTable,
  warehouses,
  products,
  productVariants,
  eq, and, inArray, isNull, sql,
} from "../../storage/base";

export function registerChannelRoutes(app: Express) {

  // ============================================
  // CHANNEL FEEDS (from inventory section)
  // ============================================

  app.get("/api/inventory/channel-feeds", async (req, res) => {
    try {
      const channelType = (req.query.channel as string) || "shopify";
      const feeds = await storage.getChannelFeedsByChannel(channelType);
      res.json(feeds);
    } catch (error) {
      console.error("Error fetching channel feeds:", error);
      res.status(500).json({ error: "Failed to fetch feeds" });
    }
  });

  // Enable a channel feed for a variant (create the link so sync can push inventory)
  app.post("/api/channel-feeds/enable", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { channelId, productVariantId } = req.body;
      if (!channelId || !productVariantId) {
        return res.status(400).json({ error: "channelId and productVariantId are required" });
      }

      // Check if feed already exists
      const existing = await storage.getChannelFeedByChannelAndVariant(channelId, productVariantId);
      if (existing) {
        // Reactivate if disabled
        if (existing.isActive !== 1) {
          await storage.reactivateChannelFeed(existing.id);
        }
        return res.json(existing);
      }

      // Look up channel and variant
      const channel = await storage.getChannelById(channelId);
      if (!channel) return res.status(404).json({ error: "Channel not found" });

      const variant = await storage.getProductVariantById(productVariantId);
      if (!variant) return res.status(404).json({ error: "Variant not found" });

      // Use shopifyVariantId for Shopify channels, SKU for others
      const channelVariantId = channel.provider === "shopify" && variant.shopifyVariantId
        ? variant.shopifyVariantId
        : variant.sku || String(variant.id);

      const product = await storage.getProductById(variant.productId);

      // Product line gate: check if this product's lines match the channel's lines
      if (product) {
        const prodLines = await storage.getProductLineIdsByProduct(product.id);
        if (prodLines.length > 0) {
          const chLines = await storage.getActiveChannelProductLineIds(channelId);
          const overlap = prodLines.some((pl: number) => chLines.includes(pl));
          if (!overlap) {
            return res.status(403).json({ error: "This product's product line is not assigned to this channel" });
          }
        }
      }

      const channelProductId = channel.provider === "shopify" && product?.shopifyProductId
        ? product.shopifyProductId
        : null;

      const feed = await storage.createChannelFeedDirect({
        channelId,
        productVariantId,
        channelType: channel.provider || "manual",
        channelVariantId,
        channelProductId,
        channelSku: variant.sku || null,
        isActive: 1,
      });

      res.json(feed);
    } catch (error: any) {
      console.error("Error enabling channel feed:", error);
      res.status(500).json({ error: error.message || "Failed to enable feed" });
    }
  });

  // ============================================
  // ORDER MANAGEMENT SYSTEM (OMS) API
  // ============================================

  // Get all orders with channel info (for OMS page)
  app.get("/api/wms/orders", requirePermission("orders", "view"), async (req, res) => {
    try {
      const { status, channelId, source, limit = "50", offset = "0" } = req.query;

      // Get all orders with items
      const statusFilter = status ? (Array.isArray(status) ? status : [status]) as string[] : undefined;
      const allOrders = await storage.getOrdersWithItems(statusFilter as any);

      // Get all channels for enrichment
      const allChannels = await storage.getAllChannels();
      const channelMap = new Map(allChannels.map(c => [c.id, c]));

      // Enrich orders with channel info and apply filters
      let enrichedOrders = allOrders.map(order => ({
        ...order,
        channel: order.channelId ? channelMap.get(order.channelId) : null
      }));

      // Filter by channelId if specified
      if (channelId) {
        const cid = parseInt(channelId as string);
        enrichedOrders = enrichedOrders.filter(o => o.channelId === cid);
      }

      // Filter by source if specified
      if (source) {
        enrichedOrders = enrichedOrders.filter(o => o.source === source);
      }

      // Sort by creation date descending (newest first)
      enrichedOrders.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      // Apply pagination
      const limitNum = parseInt(limit as string);
      const offsetNum = parseInt(offset as string);
      const paginatedOrders = enrichedOrders.slice(offsetNum, offsetNum + limitNum);

      res.json({
        orders: paginatedOrders,
        total: enrichedOrders.length,
        limit: limitNum,
        offset: offsetNum
      });
    } catch (error) {
      console.error("Error fetching OMS orders:", error);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  // Create a manual order
  const createOrderSchema = z.object({
    orderNumber: z.string().min(1, "Order number required"),
    customerName: z.string().min(1, "Customer name required"),
    customerEmail: z.string().email().optional().or(z.literal("")),
    customerPhone: z.string().optional(),
    channelId: z.number().optional().nullable(),
    source: z.enum(["shopify", "ebay", "amazon", "etsy", "manual", "api"]).default("manual"),
    priority: z.enum(["rush", "high", "normal"]).default("normal"),
    totalAmount: z.string().optional(),
    currency: z.string().default("USD"),
    shippingAddress: z.string().optional(),
    shippingCity: z.string().optional(),
    shippingState: z.string().optional(),
    shippingPostalCode: z.string().optional(),
    shippingCountry: z.string().optional(),
    notes: z.string().optional(),
    items: z.array(z.object({
      sku: z.string().min(1, "SKU required"),
      name: z.string().min(1, "Item name required"),
      quantity: z.number().min(1, "Quantity must be at least 1"),
      location: z.string().optional(),
      zone: z.string().optional(),
    })).min(1, "At least one item required"),
  });

  app.post("/api/wms/orders", requirePermission("orders", "edit"), async (req, res) => {
    try {
      const parseResult = createOrderSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: "Invalid order data",
          details: parseResult.error.errors
        });
      }

      const data = parseResult.data;

      // Create order
      const orderData = {
        orderNumber: data.orderNumber,
        customerName: data.customerName,
        customerEmail: data.customerEmail || null,
        customerPhone: data.customerPhone || null,
        channelId: data.channelId || null,
        source: data.source,
        priority: data.priority,
        totalAmount: data.totalAmount || null,
        currency: data.currency,
        shippingAddress: data.shippingAddress || null,
        shippingCity: data.shippingCity || null,
        shippingState: data.shippingState || null,
        shippingPostalCode: data.shippingPostalCode || null,
        shippingCountry: data.shippingCountry || null,
        notes: data.notes || null,
        warehouseStatus: "ready" as const,
        itemCount: data.items.reduce((sum, item) => sum + item.quantity, 0),
        orderPlacedAt: new Date(),
        shopifyOrderId: null, // Manual orders don't have Shopify ID
        externalOrderId: null, // Manual orders don't have external ID
      };

      // Create items
      const itemsData = data.items.map(item => ({
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        location: item.location || "UNASSIGNED",
        zone: item.zone || "U",
        status: "pending" as const,
      }));

      const order = await storage.createOrderWithItems(orderData as any, itemsData as any);

      res.status(201).json(order);
    } catch (error) {
      console.error("Error creating manual order:", error);
      res.status(500).json({ error: "Failed to create order" });
    }
  });

  // Get single order with channel info
  app.get("/api/wms/orders/:id", requirePermission("orders", "view"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }

      const order = await storage.getOrderById(id);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      const items = await storage.getOrderItems(id);
      const channel = order.channelId ? await storage.getChannelById(order.channelId) : null;

      // Pull financial summary from oms_orders (source of truth)
      let financials: {
        subtotalCents: number | null;
        taxCents: number | null;
        shippingCents: number | null;
        discountCents: number | null;
        totalCents: number | null;
        discountCodes: string[];
        shippingMethod: string | null;
      } = {
        subtotalCents: null,
        taxCents: null,
        shippingCents: null,
        discountCents: null,
        totalCents: null,
        discountCodes: [],
        shippingMethod: null,
      };

      if (order.sourceTableId) {
        try {
          const rawFinancials = await storage.getShopifyOrderFinancials(order.sourceTableId);

          if (rawFinancials) {
            financials = {
              subtotalCents: rawFinancials.subtotalCents,
              taxCents: rawFinancials.taxCents,
              shippingCents: rawFinancials.shippingCents,
              discountCents: rawFinancials.discountCents,
              totalCents: rawFinancials.totalCents,
              discountCodes: Array.isArray(rawFinancials.discountCodes)
                ? rawFinancials.discountCodes.map((dc: any) => typeof dc === "string" ? dc : dc.code || dc.title || String(dc))
                : [],
              shippingMethod: null,
            };
          }
        } catch {
          // oms_orders may not have this order yet — fall back silently
        }
      }

      // Compute from items as fallback
      if (financials.subtotalCents == null) {
        const itemsSubtotal = items.reduce((s: number, i: any) => {
          if (i.priceCents != null) return s + (i.priceCents * i.quantity);
          if (i.totalPriceCents != null) return s + i.totalPriceCents + (i.discountCents || 0) * i.quantity;
          return s;
        }, 0);
        if (itemsSubtotal > 0) financials.subtotalCents = itemsSubtotal;
      }
      if (financials.totalCents == null && order.totalAmount) {
        financials.totalCents = Math.round(parseFloat(order.totalAmount) * 100);
      }
      if (financials.discountCents == null) {
        const itemDiscounts = items.reduce((s: number, i: any) => s + ((i.discountCents || 0) * i.quantity), 0);
        if (itemDiscounts > 0) financials.discountCents = itemDiscounts;
      }

      // Look up member plan from members/plans tables (shared DB with shellz-club-app)
      let memberPlan: string | null = null;
      if (order.customerEmail) {
        try {
          memberPlan = await storage.getMemberPlanByEmail(order.customerEmail);
        } catch {
          // members/plans tables may not exist — ignore
        }
      }

      res.json({ ...order, items, channel, financials, memberPlan });
    } catch (error) {
      console.error("Error fetching order:", error);
      res.status(500).json({ error: "Failed to fetch order" });
    }
  });

  // Update order (for editing manual orders)
  app.put("/api/wms/orders/:id", requirePermission("orders", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }

      const order = await storage.getOrderById(id);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      const { priority, notes, status, onHold } = req.body;

      // Only allow updating certain fields
      const updates: any = {};
      if (priority !== undefined) updates.priority = priority;
      if (notes !== undefined) updates.notes = notes;
      if (status !== undefined) updates.status = status;
      if (onHold !== undefined) updates.onHold = onHold ? 1 : 0;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid updates provided" });
      }

      // Use existing update methods for special fields that have side effects
      if (updates.status) {
        await storage.updateOrderStatus(id, updates.status);
        delete updates.status;
      }
      if (updates.priority) {
        await storage.setOrderPriority(id, updates.priority);
        delete updates.priority;
      }
      if (updates.onHold !== undefined) {
        if (updates.onHold) {
          await storage.holdOrder(id);
        } else {
          await storage.releaseHoldOrder(id);
        }
        delete updates.onHold;
      }

      // Use generic update for remaining fields (notes, etc.)
      if (Object.keys(updates).length > 0) {
        await storage.updateOrderFields(id, updates);
      }

      // Fetch updated order
      const updatedOrder = await storage.getOrderById(id);
      res.json(updatedOrder);
    } catch (error) {
      console.error("Error updating order:", error);
      res.status(500).json({ error: "Failed to update order" });
    }
  });

  // ============================================
  // CHANNELS MANAGEMENT API
  // ============================================

  // Get all channels
  app.get("/api/channels", requirePermission("channels", "view"), async (req, res) => {
    try {
      const allChannels = await storage.getAllChannels();

      // Enrich with connection info
      const enrichedChannels = await Promise.all(
        allChannels.map(async (channel) => {
          const connection = await storage.getChannelConnection(channel.id);
          const partnerProfile = channel.type === 'partner'
            ? await storage.getPartnerProfile(channel.id)
            : null;
          return {
            ...channel,
            connection: connection || null,
            partnerProfile: partnerProfile || null
          };
        })
      );

      res.json(enrichedChannels);
    } catch (error) {
      console.error("Error fetching channels:", error);
      res.status(500).json({ error: "Failed to fetch channels" });
    }
  });

  // Get single channel
  app.get("/api/channels/:id", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);

      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }

      const connection = await storage.getChannelConnection(channelId);
      const partnerProfile = channel.type === 'partner'
        ? await storage.getPartnerProfile(channelId)
        : null;

      res.json({
        ...channel,
        connection: connection || null,
        partnerProfile: partnerProfile || null
      });
    } catch (error) {
      console.error("Error fetching channel:", error);
      res.status(500).json({ error: "Failed to fetch channel" });
    }
  });

  // Create channel
  app.post("/api/channels", requirePermission("channels", "create"), async (req, res) => {
    try {
      const channelData = {
        ...req.body,
        priority: req.body.priority ?? 0,
        isDefault: req.body.isDefault ?? 0,
        status: req.body.status ?? "pending_setup",
      };

      const parseResult = insertChannelSchema.safeParse(channelData);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Invalid channel data", details: parseResult.error.errors });
      }

      const channel = await storage.createChannel(parseResult.data);
      res.status(201).json(channel);
    } catch (error) {
      console.error("Error creating channel:", error);
      res.status(500).json({ error: "Failed to create channel" });
    }
  });

  // Update channel
  app.put("/api/channels/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.updateChannel(channelId, req.body);

      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }

      res.json(channel);
    } catch (error) {
      console.error("Error updating channel:", error);
      res.status(500).json({ error: "Failed to update channel" });
    }
  });

  // Delete channel
  app.delete("/api/channels/:id", requirePermission("channels", "delete"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const deleted = await storage.deleteChannel(channelId);

      if (!deleted) {
        return res.status(404).json({ error: "Channel not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting channel:", error);
      res.status(500).json({ error: "Failed to delete channel" });
    }
  });

  // Update channel connection
  app.put("/api/channels/:id/connection", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);

      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }

      const connection = await storage.upsertChannelConnection({
        channelId,
        ...req.body
      });

      res.json(connection);
    } catch (error) {
      console.error("Error updating channel connection:", error);
      res.status(500).json({ error: "Failed to update channel connection" });
    }
  });

  // Auto-setup Shopify connection using configured secrets
  app.post("/api/channels/:id/setup-shopify", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);

      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }

      if (channel.provider !== 'shopify') {
        return res.status(400).json({ error: "This channel is not a Shopify channel" });
      }

      // Read credentials from request body (per-channel, not env vars)
      const { shopDomain: rawDomain, accessToken } = req.body as { shopDomain?: string; accessToken?: string };
      if (!rawDomain || !accessToken) {
        return res.status(400).json({
          error: "Missing credentials",
          message: "Please provide shopDomain and accessToken",
        });
      }
      // Normalize: "my-store" → "my-store.myshopify.com"
      const shopDomain = rawDomain.includes('.myshopify.com') ? rawDomain : `${rawDomain}.myshopify.com`;
      const store = shopDomain.replace(/\.myshopify\.com$/, '');

      // Test the connection by fetching shop info
      const testResponse = await fetch(
        `https://${store}.myshopify.com/admin/api/2024-01/shop.json`,
        {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
        }
      );

      if (!testResponse.ok) {
        return res.status(400).json({
          error: "Failed to connect to Shopify",
          message: `Shopify API returned ${testResponse.status}`
        });
      }

      const shopData = await testResponse.json();

      // Create/update the connection (store credentials per-channel)
      const connection = await storage.upsertChannelConnection({
        channelId,
        shopDomain,
        accessToken,
        syncStatus: 'connected',
        lastSyncAt: new Date(),
      });

      // Update channel status to active
      await storage.updateChannel(channelId, { status: 'active' });

      // Fetch Shopify locations
      let locations: any[] = [];
      try {
        const locResponse = await fetch(
          `https://${store}.myshopify.com/admin/api/2024-01/locations.json`,
          {
            headers: {
              "X-Shopify-Access-Token": accessToken,
              "Content-Type": "application/json",
            },
          }
        );
        if (locResponse.ok) {
          const locData = await locResponse.json();
          locations = (locData.locations || []).map((loc: any) => ({
            id: String(loc.id),
            name: loc.name,
            address1: loc.address1,
            city: loc.city,
            province: loc.province,
            country: loc.country_name,
            active: loc.active,
          }));
        }
      } catch (locErr) {
        console.warn("Could not fetch Shopify locations:", locErr);
      }

      // Fetch current warehouse mappings
      const warehouses = await storage.getAllWarehouses();
      const mappings = warehouses
        .filter((w: any) => w.shopifyLocationId)
        .map((w: any) => ({ warehouseId: w.id, warehouseCode: w.code, warehouseName: w.name, shopifyLocationId: w.shopifyLocationId }));

      // Auto-create channel feeds for all product variants with Shopify variant IDs
      let feedsCreated = 0;
      let feedsUpdated = 0;
      try {
        const allVariants = await storage.getAllProductVariants();
        const shopifyVariants = allVariants.filter((v: any) => v.shopifyVariantId);

        // Build product ID → Shopify product ID map
        const productIds = [...new Set(shopifyVariants.map((v: any) => v.productId))];
        const productMap = new Map<number, string>();
        for (const pid of productIds) {
          const prod = await storage.getProductById(pid);
          if (prod?.shopifyProductId) {
            productMap.set(pid, prod.shopifyProductId);
          }
        }

        for (const pv of shopifyVariants) {
          const existing = await storage.getChannelFeedByVariantAndChannel(pv.id, 'shopify');
          await storage.upsertChannelFeed({
            channelId: channelId,
            productVariantId: pv.id,
            channelType: 'shopify',
            channelVariantId: pv.shopifyVariantId!,
            channelProductId: productMap.get(pv.productId) || null,
            channelSku: pv.sku || null,
            isActive: 1,
          });
          if (existing) feedsUpdated++;
          else feedsCreated++;
        }
        console.log(`[Setup Shopify] Channel feeds: ${feedsCreated} created, ${feedsUpdated} updated`);
      } catch (feedErr) {
        console.warn("Could not auto-create channel feeds:", feedErr);
      }

      res.json({
        success: true,
        connection,
        shop: {
          name: shopData.shop?.name,
          domain: shopData.shop?.domain,
          email: shopData.shop?.email,
        },
        locations,
        mappings,
        feeds: { created: feedsCreated, updated: feedsUpdated },
      });
    } catch (error) {
      console.error("Error setting up Shopify connection:", error);
      res.status(500).json({ error: "Failed to setup Shopify connection" });
    }
  });

  // Fetch Shopify locations for a connected channel
  app.get("/api/channels/:id/shopify-locations", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (channel.provider !== 'shopify') return res.status(400).json({ error: "Not a Shopify channel" });

      // Read credentials from channel's stored connection
      const connRecord = await storage.getChannelConnection(channelId);
      if (!connRecord?.shopDomain || !connRecord?.accessToken) {
        return res.status(400).json({ error: "Channel has no Shopify credentials. Please connect first." });
      }
      const store = connRecord.shopDomain.replace(/\.myshopify\.com$/, '');

      const locResponse = await fetch(
        `https://${store}.myshopify.com/admin/api/2024-01/locations.json`,
        {
          headers: {
            "X-Shopify-Access-Token": connRecord.accessToken,
            "Content-Type": "application/json",
          },
        }
      );
      if (!locResponse.ok) {
        return res.status(502).json({ error: `Shopify API returned ${locResponse.status}` });
      }
      const locData = await locResponse.json();
      const locationsList = (locData.locations || []).map((loc: any) => ({
        id: String(loc.id),
        name: loc.name,
        address1: loc.address1,
        city: loc.city,
        province: loc.province,
        country: loc.country_name,
        active: loc.active,
      }));

      // Include current warehouse mappings
      const warehouses = await storage.getAllWarehouses();
      const mappingsList = warehouses
        .filter((w: any) => w.shopifyLocationId)
        .map((w: any) => ({ warehouseId: w.id, warehouseCode: w.code, warehouseName: w.name, shopifyLocationId: w.shopifyLocationId }));

      res.json({ locations: locationsList, mappings: mappingsList });
    } catch (error) {
      console.error("Error fetching Shopify locations:", error);
      res.status(500).json({ error: "Failed to fetch Shopify locations" });
    }
  });

  // Save Shopify location → warehouse mappings
  app.post("/api/channels/:id/map-locations", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);
      if (!channel) return res.status(404).json({ error: "Channel not found" });

      const { mappings } = req.body as { mappings: Array<{ shopifyLocationId: string; warehouseId: number | null }> };
      if (!Array.isArray(mappings)) {
        return res.status(400).json({ error: "mappings must be an array" });
      }

      // Clear all existing Shopify location mappings first
      const allWarehouses = await storage.getAllWarehouses();
      for (const wh of allWarehouses) {
        if ((wh as any).shopifyLocationId) {
          await storage.updateWarehouse(wh.id, { shopifyLocationId: null } as any);
        }
      }

      // Apply new mappings
      for (const m of mappings) {
        if (m.warehouseId) {
          await storage.updateWarehouse(m.warehouseId, { shopifyLocationId: m.shopifyLocationId } as any);
        }
      }

      // Return updated state
      const updatedWarehouses = await storage.getAllWarehouses();
      const updatedMappings = updatedWarehouses
        .filter((w: any) => w.shopifyLocationId)
        .map((w: any) => ({ warehouseId: w.id, warehouseCode: w.code, warehouseName: w.name, shopifyLocationId: w.shopifyLocationId }));

      res.json({ success: true, mappings: updatedMappings });
    } catch (error) {
      console.error("Error saving location mappings:", error);
      res.status(500).json({ error: "Failed to save location mappings" });
    }
  });

  // Update partner profile
  app.put("/api/channels/:id/partner-profile", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);

      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }

      if (channel.type !== 'partner') {
        return res.status(400).json({ error: "Partner profile only available for partner channels" });
      }

      const profile = await storage.upsertPartnerProfile({
        channelId,
        ...req.body
      });

      res.json(profile);
    } catch (error) {
      console.error("Error updating partner profile:", error);
      res.status(500).json({ error: "Failed to update partner profile" });
    }
  });

  // ============================================
  // CHANNEL PRODUCT PUSH API
  // ============================================

  // Preview resolved product for a channel (master + overrides merged)
  app.get("/api/channel-push/preview/:productId/:channelId", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { channelProductPush } = req.app.locals.services;
      const productId = parseInt(req.params.productId);
      const channelId = parseInt(req.params.channelId);
      const resolved = await channelProductPush.getResolvedProductForChannel(productId, channelId);
      if (!resolved) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json(resolved);
    } catch (error) {
      console.error("Error previewing product:", error);
      res.status(500).json({ error: "Failed to preview product" });
    }
  });

  // Push product to all active channels
  app.post("/api/channel-push/product/:productId", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { channelProductPush } = req.app.locals.services;
      const productId = parseInt(req.params.productId);
      const results = await channelProductPush.pushProductToAllChannels(productId);
      res.json({ success: true, results });
    } catch (error) {
      console.error("Error pushing product:", error);
      res.status(500).json({ error: "Failed to push product" });
    }
  });

  // Push product to specific channel
  app.post("/api/channel-push/product/:productId/channel/:channelId", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { channelProductPush } = req.app.locals.services;
      const productId = parseInt(req.params.productId);
      const channelId = parseInt(req.params.channelId);
      const result = await channelProductPush.pushProduct(productId, channelId);
      res.json(result);
    } catch (error) {
      console.error("Error pushing product to channel:", error);
      res.status(500).json({ error: "Failed to push product" });
    }
  });

  // Push all products to a channel (bulk)
  app.post("/api/channel-push/all/:channelId", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { channelProductPush } = req.app.locals.services;
      const channelId = parseInt(req.params.channelId);
      const result = await channelProductPush.pushAllProducts(channelId);
      res.json(result);
    } catch (error) {
      console.error("Error bulk pushing products:", error);
      res.status(500).json({ error: "Failed to push products" });
    }
  });

  // Get channel sync status for a product
  app.get("/api/products/:productId/channel-status", requirePermission("channels", "view"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const activeChannels = await storage.getAllChannels();
      const statuses = [];
      for (const channel of activeChannels) {
        const listings = await storage.getChannelListingsByProduct(channel.id, productId);
        const override = await storage.getChannelProductOverride(channel.id, productId);
        statuses.push({
          channelId: channel.id,
          channelName: channel.name,
          provider: channel.provider,
          isListed: override ? override.isListed === 1 : true,
          listings: listings.map((l) => ({
            variantId: l.productVariantId,
            externalProductId: l.externalProductId,
            externalVariantId: l.externalVariantId,
            syncStatus: l.syncStatus,
            syncError: l.syncError,
            lastSyncedAt: l.lastSyncedAt,
          })),
        });
      }
      res.json(statuses);
    } catch (error) {
      console.error("Error fetching channel status:", error);
      res.status(500).json({ error: "Failed to fetch channel status" });
    }
  });

  // ============================================
  // CHANNEL PRODUCT OVERRIDES API
  // ============================================

  app.get("/api/channels/:channelId/products/:productId/overrides", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const productId = parseInt(req.params.productId);
      const override = await storage.getChannelProductOverride(channelId, productId);
      res.json(override || null);
    } catch (error) {
      console.error("Error fetching product override:", error);
      res.status(500).json({ error: "Failed to fetch override" });
    }
  });

  app.put("/api/channels/:channelId/products/:productId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const productId = parseInt(req.params.productId);
      const override = await storage.upsertChannelProductOverride({
        channelId,
        productId,
        ...req.body,
      });
      res.json(override);
    } catch (error) {
      console.error("Error saving product override:", error);
      res.status(500).json({ error: "Failed to save override" });
    }
  });

  app.delete("/api/channels/:channelId/products/:productId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const productId = parseInt(req.params.productId);
      const deleted = await storage.deleteChannelProductOverride(channelId, productId);
      res.json({ deleted });
    } catch (error) {
      console.error("Error deleting product override:", error);
      res.status(500).json({ error: "Failed to delete override" });
    }
  });

  // Channel variant overrides
  app.get("/api/channels/:channelId/variants/:variantId/overrides", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const override = await storage.getChannelVariantOverride(channelId, variantId);
      res.json(override || null);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch variant override" });
    }
  });

  app.put("/api/channels/:channelId/variants/:variantId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const override = await storage.upsertChannelVariantOverride({
        channelId,
        productVariantId: variantId,
        ...req.body,
      });
      res.json(override);
    } catch (error) {
      res.status(500).json({ error: "Failed to save variant override" });
    }
  });

  app.delete("/api/channels/:channelId/variants/:variantId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const deleted = await storage.deleteChannelVariantOverride(channelId, variantId);
      res.json({ deleted });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete variant override" });
    }
  });

  // Channel pricing
  app.get("/api/channels/:channelId/variants/:variantId/pricing", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const pricing = await storage.getChannelPricing(channelId, variantId);
      res.json(pricing || null);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch pricing" });
    }
  });

  app.put("/api/channels/:channelId/variants/:variantId/pricing", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const pricing = await storage.upsertChannelPricing({
        channelId,
        productVariantId: variantId,
        ...req.body,
      });
      res.json(pricing);
    } catch (error) {
      res.status(500).json({ error: "Failed to save pricing" });
    }
  });

  app.delete("/api/channels/:channelId/variants/:variantId/pricing", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const deleted = await storage.deleteChannelPricing(channelId, variantId);
      res.json({ deleted });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete pricing" });
    }
  });

  // Channel asset overrides
  app.get("/api/channels/:channelId/products/:productId/asset-overrides", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const productId = parseInt(req.params.productId);
      const overrides = await storage.getChannelAssetOverridesByProduct(channelId, productId);
      res.json(overrides);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch asset overrides" });
    }
  });

  app.put("/api/channels/:channelId/assets/:assetId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const assetId = parseInt(req.params.assetId);
      const override = await storage.upsertChannelAssetOverride({
        channelId,
        productAssetId: assetId,
        ...req.body,
      });
      res.json(override);
    } catch (error) {
      res.status(500).json({ error: "Failed to save asset override" });
    }
  });

  app.delete("/api/channels/:channelId/assets/:assetId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const assetId = parseInt(req.params.assetId);
      const deleted = await storage.deleteChannelAssetOverride(channelId, assetId);
      res.json({ deleted });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete asset override" });
    }
  });

  // Channel listings
  app.get("/api/channels/:channelId/listings", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const productId = req.query.productId ? parseInt(req.query.productId as string) : undefined;
      if (productId) {
        const listings = await storage.getChannelListingsByProduct(channelId, productId);
        res.json(listings);
      } else {
        // Return all listings for this channel
        const allListings = await storage.getChannelListingsByChannel(channelId);
        res.json(allListings);
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch listings" });
    }
  });

  // ============================================
  // CHANNEL RESERVATIONS API
  // ============================================

  // Get all reservations (optionally filtered by channel)
  app.get("/api/channel-reservations", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = req.query.channelId ? parseInt(req.query.channelId as string) : undefined;
      const reservations = await storage.getChannelReservations(channelId);
      res.json(reservations);
    } catch (error) {
      console.error("Error fetching reservations:", error);
      res.status(500).json({ error: "Failed to fetch reservations" });
    }
  });

  // Upsert reservation
  app.post("/api/channel-reservations", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const parseResult = insertChannelReservationSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Invalid reservation data", details: parseResult.error.errors });
      }

      const reservation = await storage.upsertChannelReservation(parseResult.data);
      res.json(reservation);
    } catch (error) {
      console.error("Error creating reservation:", error);
      res.status(500).json({ error: "Failed to create reservation" });
    }
  });

  // Delete reservation
  app.delete("/api/channel-reservations/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteChannelReservation(id);

      if (!deleted) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting reservation:", error);
      res.status(500).json({ error: "Failed to delete reservation" });
    }
  });

  // --- Channel Product Allocation (product-level rules per channel) ---

  app.get("/api/channel-product-allocation", requirePermission("channels", "view"), async (req, res) => {
    try {
      const rows = await storage.getAllChannelProductAllocations();
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get allocations" });
    }
  });

  app.get("/api/channel-product-allocation/:channelId/:productId", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const productId = parseInt(req.params.productId);
      const row = await storage.getChannelProductAllocation(channelId, productId);
      res.json(row || null);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get allocation" });
    }
  });

  app.put("/api/channel-product-allocation", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { channelId, productId, minAtpBase, maxAtpBase, isListed, notes } = req.body;

      if (!channelId || !productId) {
        return res.status(400).json({ error: "channelId and productId are required" });
      }

      const result = await storage.upsertChannelProductAllocation({
        channelId,
        productId,
        minAtpBase: minAtpBase ?? null,
        maxAtpBase: maxAtpBase ?? null,
        isListed: isListed ?? 1,
        notes: notes ?? null,
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to save allocation" });
    }
  });

  app.delete("/api/channel-product-allocation/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deleteChannelProductAllocation(id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to delete allocation" });
    }
  });

  // --- Product-level allocation data for ProductDetail Channels tab ---

  app.get("/api/products/:productId/allocation", requirePermission("channels", "view"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) return res.status(400).json({ error: "Invalid product ID" });

      const activeChannels = await storage.getActiveChannels();
      const variants = await storage.getProductVariantsByProductId(productId);
      const variantIds = variants.map((v: any) => v.id);

      // Product-level allocation rules per channel
      const productAllocs = await storage.getChannelProductAllocationsByProduct(productId);

      // Variant-level reservations for this product's variants
      const variantReservations = await storage.getChannelReservationsByVariantIds(variantIds);

      // Feed data for this product's variants
      const feeds = await storage.getChannelFeedsByVariantIds(variantIds);

      // ATP data
      const { atp: inventoryAtp } = req.app.locals.services;
      const atpBase = await inventoryAtp.getAtpBase(productId);
      const variantAtp = await inventoryAtp.getAtpPerVariant(productId);

      res.json({
        channels: activeChannels,
        variants: variants.map((v: any) => ({
          id: v.id,
          sku: v.sku,
          name: v.name,
          unitsPerVariant: v.unitsPerVariant,
          atpUnits: variantAtp.find((va: any) => va.productVariantId === v.id)?.atpUnits ?? 0,
        })),
        atpBase,
        productAllocations: productAllocs,
        variantReservations,
        feeds,
      });
    } catch (error: any) {
      console.error("Error fetching product allocation:", error);
      res.status(500).json({ error: error.message || "Failed to fetch product allocation" });
    }
  });

  // --- SKU typeahead for channel allocation ---
  app.get("/api/channel-allocation/search", requirePermission("channels", "view"), async (req, res) => {
    try {
      const q = ((req.query.q as string) || "").trim();
      if (q.length < 2) return res.json([]);

      const results = await storage.searchVariantsWithInventory(q);
      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- Product Lines CRUD ---

  // List all product lines
  app.get("/api/product-lines", requirePermission("channels", "view"), async (req, res) => {
    try {
      const result = await storage.getProductLinesWithCounts();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get single product line with details
  app.get("/api/product-lines/:id", requirePermission("channels", "view"), async (req, res) => {
    try {
      const lineId = parseInt(req.params.id);

      const line = await storage.getProductLineById(lineId);
      if (!line) return res.status(404).json({ error: "Product line not found" });

      // Get assigned products
      const assignedProducts = await storage.getProductLineAssignedProducts(lineId);

      // Get assigned channels
      const assignedChannels = await storage.getProductLineAssignedChannels(lineId);

      res.json({ ...line, products: assignedProducts, channels: assignedChannels });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create product line
  app.post("/api/product-lines", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { code, name, description } = req.body;
      if (!code || !name) return res.status(400).json({ error: "code and name required" });

      const created = await storage.createProductLine({ code, name, description });
      res.json(created);
    } catch (error: any) {
      if (error.code === "23505") return res.status(409).json({ error: "Product line code already exists" });
      res.status(500).json({ error: error.message });
    }
  });

  // Update product line
  app.put("/api/product-lines/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const lineId = parseInt(req.params.id);
      const { name, description, isActive, sortOrder } = req.body;

      const updated = await storage.updateProductLine(lineId, { name, description, isActive, sortOrder });
      if (!updated) return res.status(404).json({ error: "Product line not found" });

      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Assign products to a product line (bulk)
  app.put("/api/product-lines/:id/products", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const lineId = parseInt(req.params.id);
      const { productIds } = req.body as { productIds: number[] };
      if (!Array.isArray(productIds)) return res.status(400).json({ error: "productIds array required" });

      await storage.replaceProductLineProducts(lineId, productIds);

      res.json({ productLineId: lineId, productCount: productIds.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Add single product to a product line
  app.post("/api/product-lines/:id/products", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const lineId = parseInt(req.params.id);
      const { productId } = req.body;
      if (!productId) return res.status(400).json({ error: "productId required" });

      const created = await storage.addProductToProductLine(lineId, productId);
      res.json(created || { productLineId: lineId, productId, alreadyAssigned: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Remove product from a product line
  app.delete("/api/product-lines/:lineId/products/:productId", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const lineId = parseInt(req.params.lineId);
      const productId = parseInt(req.params.productId);

      await storage.removeProductFromProductLine(lineId, productId);

      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Assign product lines to a channel
  app.put("/api/channels/:id/product-lines", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const { productLineIds } = req.body as { productLineIds: number[] };
      if (!Array.isArray(productLineIds)) return res.status(400).json({ error: "productLineIds array required" });

      await storage.replaceChannelProductLines(channelId, productLineIds);

      res.json({ channelId, productLineCount: productLineIds.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get product lines assigned to a channel
  app.get("/api/channels/:id/product-lines", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const assigned = await storage.getChannelProductLinesForChannel(channelId);
      res.json(assigned);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- Channel Allocation View (grid data for UI) ---

  app.get("/api/channel-allocation/grid", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { atp: inventoryAtp } = req.app.locals.services;

      const search = ((req.query.search as string) || "").trim().toLowerCase();
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      // Filter: "all" | "unfed:<channelId>" | "override" | "blocked"
      const filter = ((req.query.filter as string) || "").trim();
      const productLineId = req.query.productLineId ? parseInt(req.query.productLineId as string) : null;

      // Load available product lines for the dropdown
      const allProductLines = await storage.getActiveProductLinesForDropdown();

      // Get all active channels
      const activeChannels = await storage.getActiveChannels();

      // Get ALL variants that have inventory (not just ones with feeds)
      let allVariantIds = await storage.getVariantIdsWithInventory();

      // Product line filter: restrict to products in the selected line
      if (productLineId) {
        const lineProductIds = await storage.getProductLineProductIds(productLineId);

        if (lineProductIds.length > 0) {
          const lineVariantIds = new Set(await storage.getVariantIdsByProductIds(lineProductIds));
          allVariantIds = allVariantIds.filter((id: number) => lineVariantIds.has(id));
        } else {
          allVariantIds = [];
        }
      }
      if (allVariantIds.length === 0) {
        const emptyStats = activeChannels.reduce((acc: any, c: any) => {
          acc[c.id] = { fed: 0, unfed: 0, blocked: 0, overrides: 0 };
          return acc;
        }, {});
        return res.json({ channels: activeChannels, rows: [], totalCount: 0, page, limit, stats: { totalVariants: 0, channels: emptyStats } });
      }

      // Load all variants and products
      const allVariants = await storage.getProductVariantsByIds(allVariantIds);
      const productIds = Array.from(new Set(allVariants.map((v: any) => v.productId)));
      const prods = await storage.getProductsByIds(productIds);
      const prodMap = new Map(prods.map((pr: any) => [pr.id, pr]));

      // Load active feeds (for hasFeed display per cell)
      const feeds = await storage.getActiveChannelFeeds();

      // Load all allocation rules + reservations (needed for stats and filtering)
      const productAllocs = await storage.getAllChannelProductAllocations();
      const allReservations = await storage.getChannelReservationsByVariantIds(allVariantIds);

      // Build feed lookup: channelId -> Set of variantIds
      const feedsByChannel = new Map<number, Set<number>>();
      for (const f of feeds) {
        if (!f.channelId) continue;
        if (!feedsByChannel.has(f.channelId)) feedsByChannel.set(f.channelId, new Set());
        feedsByChannel.get(f.channelId)!.add(f.productVariantId);
      }

      // Build reservation lookup
      const reservationMap = new Map<string, any>();
      for (const r of allReservations) {
        if ((r as any).channelId) {
          reservationMap.set(`${(r as any).channelId}:${(r as any).productVariantId}`, r);
        }
      }

      // Build product alloc lookup
      const productAllocMap = new Map<string, any>();
      for (const pa of productAllocs) {
        productAllocMap.set(`${pa.channelId}:${pa.productId}`, pa);
      }

      // Build product line eligibility maps: product -> lines, channel -> lines
      const productLineMap = await storage.getProductLineProductMap();
      const channelLineMap = await storage.getChannelProductLineMap();

      // Compute global stats (across ALL variants, not filtered)
      const channelStats: Record<number, { fed: number; unfed: number; blocked: number; overrides: number }> = {};
      for (const c of activeChannels) {
        const fedSet = feedsByChannel.get(c.id) ?? new Set();
        let blocked = 0, overrides = 0;
        for (const v of allVariants) {
          const pa = productAllocMap.get(`${c.id}:${v.productId}`);
          if (pa?.isListed === 0) blocked++;
          const res = reservationMap.get(`${c.id}:${v.id}`);
          if (res?.overrideQty != null) overrides++;
        }
        channelStats[c.id] = {
          fed: fedSet.size,
          unfed: allVariants.length - fedSet.size,
          blocked,
          overrides,
        };
      }

      // Sync stats per channel (last sync, recent errors)
      const syncStatsPerChannel: Record<number, { lastSyncAt: string | null; lastError: string | null; recentErrors: number; syncStatus: string | null }> = {};
      for (const c of activeChannels) {
        // Last successful sync from feeds
        const fedSet = feedsByChannel.get(c.id) ?? new Set();
        let lastSyncAt: string | null = null;
        for (const f of feeds) {
          if (f.channelId === c.id && f.lastSyncedAt) {
            const ts = new Date(f.lastSyncedAt).toISOString();
            if (!lastSyncAt || ts > lastSyncAt) lastSyncAt = ts;
          }
        }

        // Recent errors (last 24h)
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentErrors = await storage.getChannelSyncErrorCount(c.id, oneDayAgo);

        // Last error message
        let lastError: string | null = null;
        if (recentErrors > 0) {
          lastError = await storage.getLastChannelSyncError(c.id);
          // Truncate long HTML errors
          if (lastError && lastError.length > 200) lastError = lastError.substring(0, 200) + "...";
        }

        // Connection status
        const syncStatus = await storage.getChannelConnectionStatus(c.id);

        syncStatsPerChannel[c.id] = {
          lastSyncAt,
          lastError,
          recentErrors,
          syncStatus,
        };
      }

      // Server-side search filter
      let filteredVariants = allVariants;
      if (search) {
        filteredVariants = filteredVariants.filter((v: any) => {
          const prod = prodMap.get(v.productId);
          return (v.sku || "").toLowerCase().includes(search)
            || (v.name || "").toLowerCase().includes(search)
            || (prod?.name || "").toLowerCase().includes(search)
            || (prod?.sku || "").toLowerCase().includes(search);
        });
      }

      // Apply status filter
      if (filter.startsWith("unfed:")) {
        const channelId = parseInt(filter.split(":")[1]);
        const fedSet = feedsByChannel.get(channelId) ?? new Set();
        filteredVariants = filteredVariants.filter((v: any) => !fedSet.has(v.id));
      } else if (filter === "override") {
        filteredVariants = filteredVariants.filter((v: any) =>
          activeChannels.some((c: any) => reservationMap.get(`${c.id}:${v.id}`)?.overrideQty != null)
        );
      } else if (filter === "blocked") {
        filteredVariants = filteredVariants.filter((v: any) =>
          activeChannels.some((c: any) => productAllocMap.get(`${c.id}:${v.productId}`)?.isListed === 0)
        );
      }

      const totalCount = filteredVariants.length;
      const paginatedVariants = filteredVariants.slice((page - 1) * limit, page * limit);

      // Batch ATP
      const paginatedProductIds = Array.from(new Set(paginatedVariants.map((v: any) => v.productId)));
      const atpMap = await inventoryAtp.getBulkAtp(paginatedProductIds);

      const variantAtpMap = new Map<number, any>();
      for (const pid of paginatedProductIds) {
        const variantAtp = await inventoryAtp.getAtpPerVariant(pid);
        for (const v of variantAtp) {
          variantAtpMap.set(v.productVariantId, v);
        }
      }

      // Build grid rows — effective ATP mirrors sync engine logic
      const rows = paginatedVariants.map((v: any) => {
        const prod = prodMap.get(v.productId);
        const vatpInfo = variantAtpMap.get(v.id);
        const atpBase = atpMap.get(v.productId) ?? 0;
        const rawAtpUnits = vatpInfo?.atpUnits ?? 0;
        const unitsPerVariant = vatpInfo?.unitsPerVariant ?? v.unitsPerVariant ?? 1;

        const channelData: Record<number, any> = {};
        for (const c of activeChannels) {
          const feed = feeds.find((f: any) => f.channelId === c.id && f.productVariantId === v.id);
          const prodAlloc = productAllocMap.get(`${c.id}:${v.productId}`);
          const varRes = reservationMap.get(`${c.id}:${v.id}`);

          let effective = rawAtpUnits;
          let status = "normal";

          // 0. PRODUCT LINE GATE — check if product's lines overlap with channel's lines
          const prodLines = productLineMap.get(v.productId);
          const chanLines = channelLineMap.get(c.id);
          const isEligible = !prodLines || !chanLines || prodLines.size === 0 || chanLines.size === 0
            || Array.from(prodLines).some(lid => chanLines.has(lid));

          if (!isEligible) {
            channelData[c.id] = {
              hasFeed: false,
              lastSyncedQty: null,
              lastSyncedAt: null,
              productFloor: null,
              productCap: null,
              isListed: 1,
              variantFloor: null,
              variantCap: null,
              overrideQty: null,
              effectiveAtp: 0,
              status: "not_eligible",
              isEligible: false,
            };
            continue;
          }

          // 1. VARIANT HARD OVERRIDE — absolute precedence
          if ((varRes as any)?.overrideQty != null) {
            effective = (varRes as any).overrideQty;
            status = effective === 0 ? "override_zero" : "override";
          } else {
            // 2. PRODUCT BLOCK
            if (prodAlloc?.isListed === 0) {
              effective = 0;
              status = "blocked";
            }

            // 3. CHANNEL ALLOCATION (% or fixed)
            if (status === "normal") {
              if ((c as any).allocationFixedQty != null) {
                const allocUnits = Math.floor((c as any).allocationFixedQty / unitsPerVariant);
                effective = Math.min(effective, allocUnits);
              } else if ((c as any).allocationPct != null) {
                const allocBase = Math.floor(atpBase * (c as any).allocationPct / 100);
                const allocUnits = Math.floor(allocBase / unitsPerVariant);
                effective = Math.min(effective, allocUnits);
              }
            }

            // 4. PRODUCT FLOOR
            if (status === "normal" && prodAlloc?.minAtpBase != null && atpBase < prodAlloc.minAtpBase) {
              effective = 0;
              status = "product_floor";
            }

            // 5. PRODUCT CAP
            if (status === "normal" && prodAlloc?.maxAtpBase != null) {
              const capUnits = Math.floor(prodAlloc.maxAtpBase / unitsPerVariant);
              effective = Math.min(effective, capUnits);
            }

            // 6. VARIANT FLOOR + CAP
            if (status === "normal" && varRes) {
              if ((varRes as any).minStockBase != null && (varRes as any).minStockBase > 0 && effective < (varRes as any).minStockBase) {
                effective = 0;
                status = "variant_floor";
              }
              if ((varRes as any).maxStockBase != null && effective > 0) {
                const maxUnits = Math.floor((varRes as any).maxStockBase / unitsPerVariant);
                effective = Math.min(effective, maxUnits);
              }
            }
          }

          channelData[c.id] = {
            hasFeed: !!feed,
            lastSyncedQty: feed?.lastSyncedQty ?? null,
            lastSyncedAt: feed?.lastSyncedAt ?? null,
            productFloor: prodAlloc?.minAtpBase ?? null,
            productCap: prodAlloc?.maxAtpBase ?? null,
            isListed: prodAlloc?.isListed ?? 1,
            variantFloor: (varRes as any)?.minStockBase ?? null,
            variantCap: (varRes as any)?.maxStockBase ?? null,
            overrideQty: (varRes as any)?.overrideQty ?? null,
            effectiveAtp: Math.max(effective, 0),
            status,
            isEligible: true,
          };
        }

        return {
          productVariantId: v.id,
          productId: v.productId,
          sku: v.sku || prod?.sku || "",
          productName: prod?.name || "",
          variantName: v.name || "",
          unitsPerVariant: v.unitsPerVariant,
          atpBase,
          atpUnits: rawAtpUnits,
          channels: channelData,
        };
      });

      // Build product line name lookup
      const plNameMap = new Map(allProductLines.map((pl: any) => [pl.id, pl.name]));

      // Include allocation config + product line names on channel objects
      const channelsWithAllocation = activeChannels.map((c: any) => {
        const lineIds = channelLineMap.get(c.id);
        const lineNames = lineIds ? Array.from(lineIds).map(id => plNameMap.get(id)).filter(Boolean) : [];
        return {
          ...c,
          allocationPct: c.allocationPct ?? null,
          allocationFixedQty: c.allocationFixedQty ?? null,
          productLineNames: lineNames,
        };
      });

      res.json({
        channels: channelsWithAllocation,
        rows,
        totalCount,
        page,
        limit,
        productLines: allProductLines,
        activeProductLineId: productLineId,
        stats: {
          totalVariants: allVariants.length,
          channels: channelStats,
          sync: syncStatsPerChannel,
        },
      });
    } catch (error: any) {
      console.error("Error building allocation grid:", error);
      res.status(500).json({ error: error.message || "Failed to build allocation grid" });
    }
  });

  // ============================================
  // CHANNEL WAREHOUSE ASSIGNMENTS API (new parallel model)
  // ============================================

  // List all assignments (with warehouse name)
  app.get("/api/channel-warehouse-assignments", requirePermission("channels", "view"), async (req, res) => {
    try {
      const rows = await db
        .select({
          id: channelWarehouseAssignments.id,
          channelId: channelWarehouseAssignments.channelId,
          warehouseId: channelWarehouseAssignments.warehouseId,
          priority: channelWarehouseAssignments.priority,
          enabled: channelWarehouseAssignments.enabled,
          createdAt: channelWarehouseAssignments.createdAt,
          updatedAt: channelWarehouseAssignments.updatedAt,
          warehouseName: warehouses.name,
          warehouseCode: warehouses.code,
          warehouseType: warehouses.warehouseType,
          channelName: channelsTable.name,
        })
        .from(channelWarehouseAssignments)
        .leftJoin(warehouses, eq(channelWarehouseAssignments.warehouseId, warehouses.id))
        .leftJoin(channelsTable, eq(channelWarehouseAssignments.channelId, channelsTable.id))
        .orderBy(channelWarehouseAssignments.channelId, channelWarehouseAssignments.priority);

      res.json(rows);
    } catch (error: any) {
      console.error("Error fetching warehouse assignments:", error);
      res.status(500).json({ error: error.message || "Failed to fetch warehouse assignments" });
    }
  });

  // Create assignment
  app.post("/api/channel-warehouse-assignments", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const schema = z.object({
        channelId: z.number().int().positive(),
        warehouseId: z.number().int().positive(),
        priority: z.number().int().default(0),
        enabled: z.boolean().default(true),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid data", details: parsed.error.errors });
      }

      const [created] = await db.insert(channelWarehouseAssignments).values(parsed.data).returning();
      res.status(201).json(created);
    } catch (error: any) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "This warehouse is already assigned to this channel" });
      }
      console.error("Error creating warehouse assignment:", error);
      res.status(500).json({ error: error.message || "Failed to create warehouse assignment" });
    }
  });

  // Update assignment (priority, enabled)
  app.put("/api/channel-warehouse-assignments/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const schema = z.object({
        priority: z.number().int().optional(),
        enabled: z.boolean().optional(),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid data", details: parsed.error.errors });
      }

      const updates: any = { ...parsed.data, updatedAt: new Date() };
      const [updated] = await db
        .update(channelWarehouseAssignments)
        .set(updates)
        .where(eq(channelWarehouseAssignments.id, id))
        .returning();

      if (!updated) return res.status(404).json({ error: "Assignment not found" });
      res.json(updated);
    } catch (error: any) {
      console.error("Error updating warehouse assignment:", error);
      res.status(500).json({ error: error.message || "Failed to update warehouse assignment" });
    }
  });

  // Delete assignment
  app.delete("/api/channel-warehouse-assignments/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const [deleted] = await db
        .delete(channelWarehouseAssignments)
        .where(eq(channelWarehouseAssignments.id, id))
        .returning();

      if (!deleted) return res.status(404).json({ error: "Assignment not found" });
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting warehouse assignment:", error);
      res.status(500).json({ error: error.message || "Failed to delete warehouse assignment" });
    }
  });

  // ============================================
  // CHANNEL ALLOCATION RULES API (new parallel model)
  // ============================================

  const allocationRuleSchema = z.object({
    channelId: z.number().int().positive().nullable(), // null = global "All Channels" rule
    productId: z.number().int().positive().nullable().optional(),
    productVariantId: z.number().int().positive().nullable().optional(),
    mode: z.enum(["mirror", "share", "fixed"]),
    sharePct: z.number().int().min(1).max(100).nullable().optional(),
    fixedQty: z.number().int().min(0).nullable().optional(),
    floorAtp: z.number().int().min(0).default(0),
    floorType: z.enum(["units", "days"]).default("units"),
    ceilingQty: z.number().int().min(0).nullable().optional(),
    eligible: z.boolean().default(true),
    notes: z.string().nullable().optional(),
  }).refine((data) => {
    if (data.mode === "share" && (data.sharePct == null || data.sharePct <= 0)) return false;
    if (data.mode === "fixed" && data.fixedQty == null) return false;
    return true;
  }, { message: "share mode requires sharePct; fixed mode requires fixedQty" });

  // List all rules (with optional ?channelId= filter)
  app.get("/api/channel-allocation-rules", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = req.query.channelId ? parseInt(req.query.channelId as string) : undefined;

      let query = db
        .select({
          id: channelAllocationRules.id,
          channelId: channelAllocationRules.channelId,
          productId: channelAllocationRules.productId,
          productVariantId: channelAllocationRules.productVariantId,
          mode: channelAllocationRules.mode,
          sharePct: channelAllocationRules.sharePct,
          fixedQty: channelAllocationRules.fixedQty,
          floorAtp: channelAllocationRules.floorAtp,
          floorType: channelAllocationRules.floorType,
          ceilingQty: channelAllocationRules.ceilingQty,
          eligible: channelAllocationRules.eligible,
          notes: channelAllocationRules.notes,
          createdAt: channelAllocationRules.createdAt,
          updatedAt: channelAllocationRules.updatedAt,
          channelName: channelsTable.name,
          productName: products.name,
          variantName: productVariants.name,
          variantSku: productVariants.sku,
        })
        .from(channelAllocationRules)
        .leftJoin(channelsTable, eq(channelAllocationRules.channelId, channelsTable.id))
        .leftJoin(products, eq(channelAllocationRules.productId, products.id))
        .leftJoin(productVariants, eq(channelAllocationRules.productVariantId, productVariants.id));

      if (channelId) {
        // Show rules for this channel PLUS global rules (channelId IS NULL)
        query = query.where(
          sql`(${channelAllocationRules.channelId} = ${channelId} OR ${channelAllocationRules.channelId} IS NULL)`
        ) as any;
      }

      const rows = await (query as any).orderBy(channelAllocationRules.channelId, channelAllocationRules.productId, channelAllocationRules.productVariantId);
      res.json(rows);
    } catch (error: any) {
      console.error("Error fetching allocation rules:", error);
      res.status(500).json({ error: error.message || "Failed to fetch allocation rules" });
    }
  });

  // Get rules for a specific channel (with product/variant names)
  app.get("/api/channel-allocation-rules/:channelId", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      if (isNaN(channelId)) return res.status(400).json({ error: "Invalid channel ID" });

      const rows = await db
        .select({
          id: channelAllocationRules.id,
          channelId: channelAllocationRules.channelId,
          productId: channelAllocationRules.productId,
          productVariantId: channelAllocationRules.productVariantId,
          mode: channelAllocationRules.mode,
          sharePct: channelAllocationRules.sharePct,
          fixedQty: channelAllocationRules.fixedQty,
          floorAtp: channelAllocationRules.floorAtp,
          floorType: channelAllocationRules.floorType,
          ceilingQty: channelAllocationRules.ceilingQty,
          eligible: channelAllocationRules.eligible,
          notes: channelAllocationRules.notes,
          createdAt: channelAllocationRules.createdAt,
          updatedAt: channelAllocationRules.updatedAt,
          channelName: channelsTable.name,
          productName: products.name,
          variantName: productVariants.name,
          variantSku: productVariants.sku,
        })
        .from(channelAllocationRules)
        .leftJoin(channelsTable, eq(channelAllocationRules.channelId, channelsTable.id))
        .leftJoin(products, eq(channelAllocationRules.productId, products.id))
        .leftJoin(productVariants, eq(channelAllocationRules.productVariantId, productVariants.id))
        .where(eq(channelAllocationRules.channelId, channelId))
        .orderBy(channelAllocationRules.productId, channelAllocationRules.productVariantId);

      res.json(rows);
    } catch (error: any) {
      console.error("Error fetching channel allocation rules:", error);
      res.status(500).json({ error: error.message || "Failed to fetch channel allocation rules" });
    }
  });

  // Create rule
  app.post("/api/channel-allocation-rules", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const parsed = allocationRuleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid rule data", details: parsed.error.errors });
      }

      const data = {
        channelId: parsed.data.channelId ?? null, // null = global "All Channels" rule
        productId: parsed.data.productId ?? null,
        productVariantId: parsed.data.productVariantId ?? null,
        mode: parsed.data.mode,
        sharePct: parsed.data.mode === "share" ? parsed.data.sharePct! : null,
        fixedQty: parsed.data.mode === "fixed" ? parsed.data.fixedQty! : null,
        floorAtp: parsed.data.floorAtp,
        floorType: parsed.data.floorType ?? "units",
        ceilingQty: parsed.data.ceilingQty ?? null,
        eligible: parsed.data.eligible,
        notes: parsed.data.notes ?? null,
      };

      const [created] = await db.insert(channelAllocationRules).values(data).returning();

      // Trigger immediate sync for the affected product
      if (created.productId) {
        const { echelonOrchestrator } = req.app.locals.services;
        if (echelonOrchestrator) {
          echelonOrchestrator.syncInventoryForProduct(created.productId, { dryRun: false }, "allocation_rule_created")
            .catch((err: any) => console.warn(`[AllocationRule] Post-create sync failed: ${err.message}`));
        }
      }

      res.status(201).json(created);
    } catch (error: any) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "A rule already exists for this channel/product/variant combination" });
      }
      console.error("Error creating allocation rule:", error);
      res.status(500).json({ error: error.message || "Failed to create allocation rule" });
    }
  });

  // Update rule
  app.put("/api/channel-allocation-rules/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const updateSchema = z.object({
        mode: z.enum(["mirror", "share", "fixed"]).optional(),
        sharePct: z.number().int().min(1).max(100).nullable().optional(),
        fixedQty: z.number().int().min(0).nullable().optional(),
        floorAtp: z.number().int().min(0).optional(),
        floorType: z.enum(["units", "days"]).optional(),
        ceilingQty: z.number().int().min(0).nullable().optional(),
        eligible: z.boolean().optional(),
        notes: z.string().nullable().optional(),
      });

      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid data", details: parsed.error.errors });
      }

      const updates: any = { ...parsed.data, updatedAt: new Date() };

      // Clean up mode-dependent fields
      if (updates.mode) {
        if (updates.mode !== "share") updates.sharePct = null;
        if (updates.mode !== "fixed") updates.fixedQty = null;
      }

      const [updated] = await db
        .update(channelAllocationRules)
        .set(updates)
        .where(eq(channelAllocationRules.id, id))
        .returning();

      if (!updated) return res.status(404).json({ error: "Rule not found" });

      // Trigger immediate sync for the affected product
      if (updated.productId) {
        const { echelonOrchestrator } = req.app.locals.services;
        if (echelonOrchestrator) {
          echelonOrchestrator.syncInventoryForProduct(updated.productId, { dryRun: false }, "allocation_rule_updated")
            .catch((err: any) => console.warn(`[AllocationRule] Post-update sync failed: ${err.message}`));
        }
      }

      res.json(updated);
    } catch (error: any) {
      console.error("Error updating allocation rule:", error);
      res.status(500).json({ error: error.message || "Failed to update allocation rule" });
    }
  });

  // Delete rule
  app.delete("/api/channel-allocation-rules/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const [deleted] = await db
        .delete(channelAllocationRules)
        .where(eq(channelAllocationRules.id, id))
        .returning();

      if (!deleted) return res.status(404).json({ error: "Rule not found" });
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting allocation rule:", error);
      res.status(500).json({ error: error.message || "Failed to delete allocation rule" });
    }
  });

  // Get average daily usage (velocity) for a product — used by UI for days-of-cover preview
  app.get("/api/channel-allocation/velocity/:productId", requirePermission("channels", "view"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) return res.status(400).json({ error: "Invalid product ID" });

      const lookbackDays = 90;
      const result: any = await db.execute(sql`
        SELECT COALESCE(SUM(oi.quantity * pv.units_per_variant), 0)::numeric AS total_outbound
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN product_variants pv ON pv.sku = oi.sku AND pv.is_active = true
        WHERE pv.product_id = ${productId}
          AND o.cancelled_at IS NULL
          AND o.warehouse_status != 'cancelled'
          AND oi.status != 'cancelled'
          AND o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${lookbackDays})
      `);

      const totalOutbound = Number(result.rows?.[0]?.total_outbound ?? result[0]?.total_outbound ?? 0);
      const avgDailyUsage = lookbackDays > 0 ? totalOutbound / lookbackDays : 0;

      res.json({
        productId,
        lookbackDays,
        totalOutbound: Math.round(totalOutbound),
        avgDailyUsage: Math.round(avgDailyUsage * 100) / 100,
      });
    } catch (error: any) {
      console.error("Error fetching product velocity:", error);
      res.status(500).json({ error: error.message || "Failed to fetch velocity" });
    }
  });
}
