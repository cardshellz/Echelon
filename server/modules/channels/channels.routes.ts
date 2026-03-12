import type { Express } from "express";
import { z } from "zod";
import { eq, sql, and } from "drizzle-orm";
import { db } from "../../db";
import { channelsStorage } from "../channels";
import { ordersStorage } from "../orders";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
const storage = { ...channelsStorage, ...ordersStorage, ...catalogStorage, ...warehouseStorage, ...inventoryStorage };
import { requirePermission } from "../../routes/middleware";
import { insertChannelSchema, insertChannelConnectionSchema, insertPartnerProfileSchema, insertChannelReservationSchema, channels, channelListings, productVariants, products, orders, orderItems, inventoryLevels } from "@shared/schema";

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
      const { channelFeeds: cf } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const [existing] = await db.select().from(cf)
        .where(and(eq(cf.channelId, channelId), eq(cf.productVariantId, productVariantId)))
        .limit(1);
      if (existing) {
        // Reactivate if disabled
        if (existing.isActive !== 1) {
          await db.update(cf).set({ isActive: 1, updatedAt: new Date() }).where(eq(cf.id, existing.id));
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
        const { productLineProducts: plp, channelProductLines: cpl } = await import("@shared/schema");
        const { inArray } = await import("drizzle-orm");
        const prodLines = (await db.select({ plId: plp.productLineId }).from(plp).where(eq(plp.productId, product.id))).map((r: any) => r.plId);
        if (prodLines.length > 0) {
          const chLines = (await db.select({ plId: cpl.productLineId }).from(cpl).where(and(eq(cpl.channelId, channelId), eq(cpl.isActive, true)))).map((r: any) => r.plId);
          const overlap = prodLines.some((pl: number) => chLines.includes(pl));
          if (!overlap) {
            return res.status(403).json({ error: "This product's product line is not assigned to this channel" });
          }
        }
      }

      const channelProductId = channel.provider === "shopify" && product?.shopifyProductId
        ? product.shopifyProductId
        : null;

      const [feed] = await db.insert(cf).values({
        channelId,
        productVariantId,
        channelType: channel.provider || "manual",
        channelVariantId,
        channelProductId,
        channelSku: variant.sku || null,
        isActive: 1,
      }).returning();

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
  app.get("/api/oms/orders", requirePermission("orders", "view"), async (req, res) => {
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

  app.post("/api/oms/orders", requirePermission("orders", "edit"), async (req, res) => {
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
  app.get("/api/oms/orders/:id", requirePermission("orders", "view"), async (req, res) => {
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

      // Pull financial summary from shopify_orders raw table if available
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
          const rawFinancials = await db.execute<{
            total_price_cents: number | null;
            subtotal_price_cents: number | null;
            total_tax_cents: number | null;
            total_shipping_cents: number | null;
            total_discounts_cents: number | null;
            discount_codes: any;
          }>(sql`
            SELECT
              total_price_cents,
              subtotal_price_cents,
              total_tax_cents,
              total_shipping_cents,
              total_discounts_cents,
              discount_codes
            FROM shopify_orders
            WHERE id = ${order.sourceTableId}
            LIMIT 1
          `);

          if (rawFinancials.rows.length > 0) {
            const raw = rawFinancials.rows[0];
            financials = {
              subtotalCents: raw.subtotal_price_cents,
              taxCents: raw.total_tax_cents,
              shippingCents: raw.total_shipping_cents,
              discountCents: raw.total_discounts_cents,
              totalCents: raw.total_price_cents,
              discountCodes: Array.isArray(raw.discount_codes)
                ? raw.discount_codes.map((dc: any) => typeof dc === "string" ? dc : dc.code || dc.title || String(dc))
                : [],
              shippingMethod: null,
            };
          }
        } catch {
          // shopify_orders table may not have these columns — fall back silently
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
          const memberResult = await db.execute<{ plan_name: string }>(sql`
            SELECT p.name as plan_name
            FROM members m
            JOIN plans p ON m.plan_id = p.id
            WHERE LOWER(m.email) = LOWER(${order.customerEmail})
            LIMIT 1
          `);
          if (memberResult.rows.length > 0) {
            memberPlan = memberResult.rows[0].plan_name;
          }
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
  app.put("/api/oms/orders/:id", requirePermission("orders", "edit"), async (req, res) => {
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
      const { channelProductPush } = req.app.locals.services as any;
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
      const { channelProductPush } = req.app.locals.services as any;
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
      const { channelProductPush } = req.app.locals.services as any;
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
      const { channelProductPush } = req.app.locals.services as any;
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
        // Return all listings for this channel - use raw query
        const allListings = await db.select().from(channelListings).where(eq(channelListings.channelId, channelId));
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
      const { channelProductAllocation: cpa } = await import("@shared/schema");
      const rows = await db.select().from(cpa);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get allocations" });
    }
  });

  app.get("/api/channel-product-allocation/:channelId/:productId", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { channelProductAllocation: cpa } = await import("@shared/schema");
      const { and, eq } = await import("drizzle-orm");
      const channelId = parseInt(req.params.channelId);
      const productId = parseInt(req.params.productId);
      const [row] = await db.select().from(cpa).where(
        and(eq(cpa.channelId, channelId), eq(cpa.productId, productId))
      ).limit(1);
      res.json(row || null);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get allocation" });
    }
  });

  app.put("/api/channel-product-allocation", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { channelProductAllocation: cpa } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const { channelId, productId, minAtpBase, maxAtpBase, isListed, notes } = req.body;

      if (!channelId || !productId) {
        return res.status(400).json({ error: "channelId and productId are required" });
      }

      // Upsert
      const [existing] = await db.select().from(cpa).where(
        and(eq(cpa.channelId, channelId), eq(cpa.productId, productId))
      ).limit(1);

      if (existing) {
        const [updated] = await db.update(cpa).set({
          minAtpBase: minAtpBase ?? null,
          maxAtpBase: maxAtpBase ?? null,
          isListed: isListed ?? 1,
          notes: notes ?? null,
          updatedAt: new Date(),
        }).where(eq(cpa.id, existing.id)).returning();
        res.json(updated);
      } else {
        const [created] = await db.insert(cpa).values({
          channelId,
          productId,
          minAtpBase: minAtpBase ?? null,
          maxAtpBase: maxAtpBase ?? null,
          isListed: isListed ?? 1,
          notes: notes ?? null,
        }).returning();
        res.json(created);
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to save allocation" });
    }
  });

  app.delete("/api/channel-product-allocation/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { channelProductAllocation: cpa } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const id = parseInt(req.params.id);
      await db.delete(cpa).where(eq(cpa.id, id));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to delete allocation" });
    }
  });

  // --- Product-level allocation data for ProductDetail Channels tab ---

  app.get("/api/products/:productId/allocation", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { channelProductAllocation: cpa, channelReservations: cr, channelFeeds: cf, channels: ch, productVariants: pv } = await import("@shared/schema");
      const { eq, and, inArray } = await import("drizzle-orm");
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) return res.status(400).json({ error: "Invalid product ID" });

      const activeChannels = await db.select().from(ch).where(eq(ch.status, "active"));
      const variants = await db.select().from(pv).where(eq(pv.productId, productId));
      const variantIds = variants.map((v: any) => v.id);

      // Product-level allocation rules per channel
      const productAllocs = await db.select().from(cpa).where(eq(cpa.productId, productId));

      // Variant-level reservations for this product's variants
      const variantReservations = variantIds.length > 0
        ? await db.select().from(cr).where(inArray(cr.productVariantId, variantIds))
        : [];

      // Feed data for this product's variants
      const feeds = variantIds.length > 0
        ? await db.select({
            id: cf.id,
            channelId: cf.channelId,
            productVariantId: cf.productVariantId,
            lastSyncedQty: cf.lastSyncedQty,
            lastSyncedAt: cf.lastSyncedAt,
            isActive: cf.isActive,
          }).from(cf).where(inArray(cf.productVariantId, variantIds))
        : [];

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
      const { productVariants: pv, products: p, inventoryLevels: il } = await import("@shared/schema");
      const { eq, and, gt, or, ilike } = await import("drizzle-orm");

      const q = ((req.query.q as string) || "").trim();
      if (q.length < 2) return res.json([]);

      const pattern = `%${q}%`;
      const results = await db
        .selectDistinct({
          variantId: pv.id,
          sku: pv.sku,
          variantName: pv.name,
          productName: p.name,
        })
        .from(pv)
        .innerJoin(p, eq(p.id, pv.productId))
        .innerJoin(il, eq(il.productVariantId, pv.id))
        .where(and(
          eq(pv.isActive, true),
          gt(il.variantQty, 0),
          or(
            ilike(pv.sku, pattern),
            ilike(pv.name, pattern),
            ilike(p.name, pattern),
          ),
        ))
        .limit(15);

      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- Product Lines CRUD ---

  // List all product lines
  app.get("/api/product-lines", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { productLines, productLineProducts, channelProductLines } = await import("@shared/schema");
      const { eq, sql, count } = await import("drizzle-orm");

      const lines = await db.select().from(productLines).orderBy(productLines.sortOrder, productLines.name);

      // Get product counts per line
      const productCounts = await db
        .select({ productLineId: productLineProducts.productLineId, count: count() })
        .from(productLineProducts)
        .groupBy(productLineProducts.productLineId);
      const countMap = new Map(productCounts.map((r: any) => [r.productLineId, Number(r.count)]));

      // Get channel counts per line
      const channelCounts = await db
        .select({ productLineId: channelProductLines.productLineId, count: count() })
        .from(channelProductLines)
        .where(eq(channelProductLines.isActive, true))
        .groupBy(channelProductLines.productLineId);
      const chCountMap = new Map(channelCounts.map((r: any) => [r.productLineId, Number(r.count)]));

      const result = lines.map((l: any) => ({
        ...l,
        productCount: countMap.get(l.id) ?? 0,
        channelCount: chCountMap.get(l.id) ?? 0,
      }));

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get single product line with details
  app.get("/api/product-lines/:id", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { productLines, productLineProducts, channelProductLines, products, channels } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const lineId = parseInt(req.params.id);

      const [line] = await db.select().from(productLines).where(eq(productLines.id, lineId));
      if (!line) return res.status(404).json({ error: "Product line not found" });

      // Get assigned products
      const assignedProducts = await db
        .select({ productId: productLineProducts.productId, productName: products.name, sku: products.sku })
        .from(productLineProducts)
        .innerJoin(products, eq(products.id, productLineProducts.productId))
        .where(eq(productLineProducts.productLineId, lineId))
        .orderBy(products.name);

      // Get assigned channels
      const assignedChannels = await db
        .select({ channelId: channelProductLines.channelId, channelName: channels.name, provider: channels.provider, isActive: channelProductLines.isActive })
        .from(channelProductLines)
        .innerJoin(channels, eq(channels.id, channelProductLines.channelId))
        .where(eq(channelProductLines.productLineId, lineId))
        .orderBy(channels.name);

      res.json({ ...line, products: assignedProducts, channels: assignedChannels });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create product line
  app.post("/api/product-lines", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { productLines } = await import("@shared/schema");
      const { code, name, description } = req.body;
      if (!code || !name) return res.status(400).json({ error: "code and name required" });

      const [created] = await db.insert(productLines).values({
        code: code.toUpperCase().replace(/\s+/g, "_"),
        name,
        description: description || null,
      }).returning();

      res.json(created);
    } catch (error: any) {
      if (error.code === "23505") return res.status(409).json({ error: "Product line code already exists" });
      res.status(500).json({ error: error.message });
    }
  });

  // Update product line
  app.put("/api/product-lines/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { productLines } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const lineId = parseInt(req.params.id);
      const { name, description, isActive, sortOrder } = req.body;

      const updates: any = { updatedAt: new Date() };
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (isActive !== undefined) updates.isActive = isActive;
      if (sortOrder !== undefined) updates.sortOrder = sortOrder;

      const [updated] = await db.update(productLines).set(updates).where(eq(productLines.id, lineId)).returning();
      if (!updated) return res.status(404).json({ error: "Product line not found" });

      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Assign products to a product line (bulk)
  app.put("/api/product-lines/:id/products", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { productLineProducts } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const lineId = parseInt(req.params.id);
      const { productIds } = req.body as { productIds: number[] };
      if (!Array.isArray(productIds)) return res.status(400).json({ error: "productIds array required" });

      // Replace all assignments: delete existing, insert new
      await db.delete(productLineProducts).where(eq(productLineProducts.productLineId, lineId));
      if (productIds.length > 0) {
        await db.insert(productLineProducts).values(
          productIds.map((pid: number) => ({ productLineId: lineId, productId: pid }))
        ).onConflictDoNothing();
      }

      res.json({ productLineId: lineId, productCount: productIds.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Add single product to a product line
  app.post("/api/product-lines/:id/products", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { productLineProducts } = await import("@shared/schema");
      const lineId = parseInt(req.params.id);
      const { productId } = req.body;
      if (!productId) return res.status(400).json({ error: "productId required" });

      const [created] = await db.insert(productLineProducts).values({
        productLineId: lineId,
        productId,
      }).onConflictDoNothing().returning();

      res.json(created || { productLineId: lineId, productId, alreadyAssigned: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Remove product from a product line
  app.delete("/api/product-lines/:lineId/products/:productId", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { productLineProducts } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const lineId = parseInt(req.params.lineId);
      const productId = parseInt(req.params.productId);

      await db.delete(productLineProducts).where(
        and(eq(productLineProducts.productLineId, lineId), eq(productLineProducts.productId, productId))
      );

      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Assign product lines to a channel
  app.put("/api/channels/:id/product-lines", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { channelProductLines } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const channelId = parseInt(req.params.id);
      const { productLineIds } = req.body as { productLineIds: number[] };
      if (!Array.isArray(productLineIds)) return res.status(400).json({ error: "productLineIds array required" });

      // Replace all assignments
      await db.delete(channelProductLines).where(eq(channelProductLines.channelId, channelId));
      if (productLineIds.length > 0) {
        await db.insert(channelProductLines).values(
          productLineIds.map((plId: number) => ({ channelId, productLineId: plId }))
        ).onConflictDoNothing();
      }

      res.json({ channelId, productLineCount: productLineIds.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get product lines assigned to a channel
  app.get("/api/channels/:id/product-lines", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { channelProductLines, productLines } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const channelId = parseInt(req.params.id);

      const assigned = await db
        .select({ id: productLines.id, code: productLines.code, name: productLines.name, isActive: channelProductLines.isActive })
        .from(channelProductLines)
        .innerJoin(productLines, eq(productLines.id, channelProductLines.productLineId))
        .where(eq(channelProductLines.channelId, channelId))
        .orderBy(productLines.sortOrder, productLines.name);

      res.json(assigned);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- Channel Allocation View (grid data for UI) ---

  app.get("/api/channel-allocation/grid", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { atp: inventoryAtp } = req.app.locals.services;
      const { channelProductAllocation: cpa, channelReservations: cr, channelFeeds: cf, channels: ch, productVariants: pv, products: p, productLines: pl, productLineProducts: plp, channelProductLines: cpl } = await import("@shared/schema");
      const { eq, and, inArray, gt, like, or } = await import("drizzle-orm");

      const search = ((req.query.search as string) || "").trim().toLowerCase();
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      // Filter: "all" | "unfed:<channelId>" | "override" | "blocked"
      const filter = ((req.query.filter as string) || "").trim();
      const productLineId = req.query.productLineId ? parseInt(req.query.productLineId as string) : null;

      // Load available product lines for the dropdown
      const allProductLines = await db.select({ id: pl.id, code: pl.code, name: pl.name }).from(pl).where(eq(pl.isActive, true)).orderBy(pl.sortOrder, pl.name);

      // Get all active channels
      const activeChannels = await db.select().from(ch).where(eq(ch.status, "active"));

      // Get ALL variants that have inventory (not just ones with feeds)
      const variantsWithInventoryRaw = await db
        .selectDistinct({ id: pv.id })
        .from(pv)
        .innerJoin(inventoryLevels, eq(inventoryLevels.productVariantId, pv.id))
        .where(and(eq(pv.isActive, true), gt(inventoryLevels.variantQty, 0)));

      let allVariantIds = variantsWithInventoryRaw.map((v: any) => v.id);

      // Product line filter: restrict to products in the selected line
      if (productLineId) {
        const lineProductIds = (await db
          .select({ productId: plp.productId })
          .from(plp)
          .where(eq(plp.productLineId, productLineId))
        ).map((r: any) => r.productId);

        if (lineProductIds.length > 0) {
          const lineVariantIds = new Set(
            (await db.select({ id: pv.id }).from(pv).where(inArray(pv.productId, lineProductIds))).map((v: any) => v.id)
          );
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
      const allVariants = await db.select().from(pv).where(inArray(pv.id, allVariantIds));
      const productIds = Array.from(new Set(allVariants.map((v: any) => v.productId)));
      const prods = await db.select().from(p).where(inArray(p.id, productIds));
      const prodMap = new Map(prods.map((pr: any) => [pr.id, pr]));

      // Load active feeds (for hasFeed display per cell)
      const feeds = await db.select({
        feedId: cf.id,
        channelId: cf.channelId,
        productVariantId: cf.productVariantId,
        lastSyncedQty: cf.lastSyncedQty,
        lastSyncedAt: cf.lastSyncedAt,
      }).from(cf).where(eq(cf.isActive, 1));

      // Load all allocation rules + reservations (needed for stats and filtering)
      const productAllocs = await db.select().from(cpa);
      const allReservations = await db.select().from(cr);

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
      const plpRows = await db.select({ productId: plp.productId, productLineId: plp.productLineId }).from(plp);
      const cplRows = await db.select({ channelId: cpl.channelId, productLineId: cpl.productLineId }).from(cpl);
      const productLineMap = new Map<number, Set<number>>();
      for (const r of plpRows) {
        if (!productLineMap.has(r.productId)) productLineMap.set(r.productId, new Set());
        productLineMap.get(r.productId)!.add(r.productLineId);
      }
      const channelLineMap = new Map<number, Set<number>>();
      for (const r of cplRows) {
        if (!channelLineMap.has(r.channelId)) channelLineMap.set(r.channelId, new Set());
        channelLineMap.get(r.channelId)!.add(r.productLineId);
      }

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
      const { channelSyncLog: csl, channelConnections: cc } = await import("@shared/schema");
      const { desc, sql: sqlTag, max } = await import("drizzle-orm");
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
        const [errorRow] = await db.select({ cnt: sqlTag`COUNT(*)::int` }).from(csl)
          .where(and(eq(csl.channelId, c.id), eq(csl.status, "error"), gt(csl.createdAt, oneDayAgo)));
        const recentErrors = (errorRow as any)?.cnt ?? 0;

        // Last error message
        let lastError: string | null = null;
        if (recentErrors > 0) {
          const [lastErrRow] = await db.select({ errorMessage: csl.errorMessage }).from(csl)
            .where(and(eq(csl.channelId, c.id), eq(csl.status, "error")))
            .orderBy(desc(csl.createdAt)).limit(1);
          lastError = (lastErrRow as any)?.errorMessage ?? null;
          // Truncate long HTML errors
          if (lastError && lastError.length > 200) lastError = lastError.substring(0, 200) + "...";
        }

        // Connection status
        const [conn] = await db.select({ syncStatus: cc.syncStatus }).from(cc).where(eq(cc.channelId, c.id)).limit(1);

        syncStatsPerChannel[c.id] = {
          lastSyncAt,
          lastError,
          recentErrors,
          syncStatus: (conn as any)?.syncStatus ?? null,
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
}
