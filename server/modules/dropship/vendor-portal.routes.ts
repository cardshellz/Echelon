import type { Express, Request, Response } from "express";
import { requireVendorAuth } from "./vendor-auth";
import { pool } from "../../db";
import { walletService } from "./wallet.service";

export function registerVendorPortalRoutes(app: Express) {
  // GET /api/vendor/products — list dropship-eligible products with ATP
  app.get("/api/vendor/products", requireVendorAuth, async (req, res) => {
    try {
      const vendorId = req.vendor!.id;
      const vendorTier = req.vendor!.tier;
      const { page = "1", limit = "50", search, selected } = req.query;
      const pageNum = Math.max(1, parseInt(page as string) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 50));
      const offset = (pageNum - 1) * limitNum;

      // Tier discount rates
      const tierDiscount: Record<string, number> = { standard: 0.15, pro: 0.25, elite: 0.30 };
      const discount = tierDiscount[vendorTier] || 0.15;

      const client = await pool.connect();
      try {
        let where = `WHERE p.dropship_eligible = true AND p.is_active = true`;
        const params: any[] = [vendorId];

        if (search) {
          params.push(`%${search}%`);
          where += ` AND (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`;
        }
        if (selected === "true") {
          where += ` AND dvp.id IS NOT NULL AND dvp.enabled = true`;
        } else if (selected === "false") {
          where += ` AND (dvp.id IS NULL OR dvp.enabled = false)`;
        }

        // Count
        const countResult = await client.query(
          `SELECT COUNT(DISTINCT p.id)
           FROM products p
           LEFT JOIN dropship_vendor_products dvp ON dvp.product_id = p.id AND dvp.vendor_id = $1
           ${where}`,
          params
        );
        const total = parseInt(countResult.rows[0].count);

        // Products with variant info + ATP
        const productResult = await client.query(
          `SELECT p.id, p.name as title, p.sku, p.product_type, p.image_url,
                  dvp.id as dvp_id, dvp.enabled as dvp_enabled,
                  COALESCE(
                    (SELECT json_agg(json_build_object(
                      'id', pv.id,
                      'sku', pv.sku,
                      'name', pv.name,
                      'weight_grams', pv.weight_grams,
                      'barcode', pv.barcode,
                      'shopify_price_cents', COALESCE(
                        (SELECT (cf.price_cents) FROM channels.channel_feeds cf
                         JOIN channels ch ON ch.id = cf.channel_id
                         WHERE cf.product_variant_id = pv.id AND ch.platform = 'shopify' LIMIT 1),
                        0
                      ),
                      'atp', COALESCE(
                        (SELECT SUM(il.variant_qty - il.reserved_qty - COALESCE(il.picked_qty, 0))
                         FROM inventory.inventory_levels il WHERE il.product_variant_id = pv.id),
                        0
                      )
                    ) ORDER BY pv.id)
                    FROM catalog.product_variants pv WHERE pv.product_id = p.id AND pv.is_active = true
                  , '[]'::json) as variants
           FROM products p
           LEFT JOIN dropship_vendor_products dvp ON dvp.product_id = p.id AND dvp.vendor_id = $1
           ${where}
           ORDER BY p.name ASC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limitNum, offset]
        );

        const products = productResult.rows.map((p: any) => {
          const variants = (typeof p.variants === 'string' ? JSON.parse(p.variants) : p.variants) || [];
          // Compute wholesale from highest shopify price variant
          const topPrice = Math.max(...variants.map((v: any) => v.shopify_price_cents || 0), 0);
          const wholesaleCents = Math.round(topPrice * (1 - discount));
          const totalAtp = variants.reduce((sum: number, v: any) => sum + (parseInt(v.atp) || 0), 0);

          return {
            id: p.id,
            title: p.title,
            sku: p.sku,
            product_type: p.product_type,
            image_url: p.image_url,
            retail_price_cents: topPrice,
            wholesale_price_cents: wholesaleCents,
            atp: totalAtp,
            selected: !!p.dvp_id && p.dvp_enabled,
            enabled: p.dvp_enabled ?? false,
            variants: variants.map((v: any) => ({
              id: v.id,
              sku: v.sku,
              name: v.name,
              wholesale_price_cents: Math.round((v.shopify_price_cents || 0) * (1 - discount)),
              atp: parseInt(v.atp) || 0,
              weight_grams: v.weight_grams,
              barcode: v.barcode,
            })),
          };
        });

        return res.json({
          products,
          pagination: { page: pageNum, limit: limitNum, total, total_pages: Math.ceil(total / limitNum) },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Vendor products error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // POST /api/vendor/products/select — add products to vendor selection
  app.post("/api/vendor/products/select", requireVendorAuth, async (req, res) => {
    try {
      const vendorId = req.vendor!.id;
      const { productIds } = req.body;

      if (!Array.isArray(productIds) || productIds.length === 0) {
        return res.status(400).json({ error: "invalid_body", message: "productIds must be a non-empty array" });
      }
      if (productIds.length > 500) {
        return res.status(400).json({ error: "too_many", message: "Max 500 products per selection" });
      }

      const client = await pool.connect();
      try {
        // Validate all products exist and are eligible
        const validResult = await client.query(
          `SELECT id FROM catalog.products WHERE id = ANY($1::int[]) AND dropship_eligible = true AND is_active = true`,
          [productIds]
        );
        const validIds = new Set(validResult.rows.map((r: any) => r.id));
        const invalidIds = productIds.filter((id: number) => !validIds.has(id));
        if (invalidIds.length > 0) {
          return res.status(400).json({ error: "invalid_products", message: `Products not eligible: ${invalidIds.join(", ")}` });
        }

        // Check existing count
        const countResult = await client.query(
          `SELECT COUNT(*) FROM dropship_vendor_products WHERE vendor_id = $1 AND enabled = true`,
          [vendorId]
        );
        const existing = parseInt(countResult.rows[0].count);
        if (existing + productIds.length > 500) {
          return res.status(400).json({ error: "limit_exceeded", message: `Would exceed 500 product limit (current: ${existing})` });
        }

        // Upsert
        let selected = 0;
        let alreadySelected = 0;
        const results: any[] = [];

        for (const productId of productIds) {
          const upsertResult = await client.query(
            `INSERT INTO dropship_vendor_products (vendor_id, product_id, enabled)
             VALUES ($1, $2, true)
             ON CONFLICT (vendor_id, product_id) DO UPDATE SET enabled = true
             RETURNING (xmax = 0) as is_new`,
            [vendorId, productId]
          );
          if (upsertResult.rows[0].is_new) {
            selected++;
            results.push({ product_id: productId, status: "selected" });
          } else {
            alreadySelected++;
            results.push({ product_id: productId, status: "already_selected" });
          }
        }

        return res.json({ selected, already_selected: alreadySelected, products: results });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Vendor select products error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // DELETE /api/vendor/products/:productId — remove from selection
  app.delete("/api/vendor/products/:productId", requireVendorAuth, async (req, res) => {
    try {
      const vendorId = req.vendor!.id;
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) return res.status(400).json({ error: "invalid_id" });

      const client = await pool.connect();
      try {
        const result = await client.query(
          `UPDATE dropship_vendor_products SET enabled = false WHERE vendor_id = $1 AND product_id = $2 RETURNING id`,
          [vendorId, productId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "not_found" });
        }

        return res.json({ product_id: productId, status: "removed" });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Vendor remove product error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // GET /api/vendor/wallet — current balance + recent transactions
  app.get("/api/vendor/wallet", requireVendorAuth, async (req, res) => {
    try {
      const vendorId = req.vendor!.id;
      const client = await pool.connect();
      try {
        const vendorResult = await client.query(
          `SELECT wallet_balance_cents, auto_reload_enabled, auto_reload_threshold_cents, auto_reload_amount_cents
           FROM dropship_vendors WHERE id = $1`,
          [vendorId]
        );
        const v = vendorResult.rows[0];

        const txResult = await client.query(
          `SELECT id, type, amount_cents, balance_after_cents, reference_type, reference_id, payment_method, notes, created_at
           FROM dropship_wallet_ledger WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [vendorId]
        );

        return res.json({
          balance_cents: v.wallet_balance_cents,
          auto_reload_enabled: v.auto_reload_enabled,
          auto_reload_threshold_cents: v.auto_reload_threshold_cents,
          auto_reload_amount_cents: v.auto_reload_amount_cents,
          recent_transactions: txResult.rows,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Vendor wallet error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // GET /api/vendor/wallet/ledger — full transaction history
  app.get("/api/vendor/wallet/ledger", requireVendorAuth, async (req, res) => {
    try {
      const vendorId = req.vendor!.id;
      const { page = "1", limit = "50", type } = req.query;
      const pageNum = Math.max(1, parseInt(page as string) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit as string) || 50));
      const offset = (pageNum - 1) * limitNum;

      const client = await pool.connect();
      try {
        let where = `WHERE vendor_id = $1`;
        const params: any[] = [vendorId];

        if (type) {
          params.push(type);
          where += ` AND type = $${params.length}`;
        }

        const countResult = await client.query(
          `SELECT COUNT(*) FROM dropship_wallet_ledger ${where}`,
          params
        );
        const total = parseInt(countResult.rows[0].count);

        const txResult = await client.query(
          `SELECT id, type, amount_cents, balance_after_cents, reference_type, reference_id, payment_method, notes, created_at
           FROM dropship_wallet_ledger ${where} ORDER BY created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limitNum, offset]
        );

        return res.json({
          transactions: txResult.rows,
          pagination: { page: pageNum, limit: limitNum, total, total_pages: Math.ceil(total / limitNum) },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Vendor ledger error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // GET /api/vendor/orders — vendor's orders
  app.get("/api/vendor/orders", requireVendorAuth, async (req, res) => {
    try {
      const vendorId = req.vendor!.id;
      const { page = "1", limit = "50", status } = req.query;
      const pageNum = Math.max(1, parseInt(page as string) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 50));
      const offset = (pageNum - 1) * limitNum;

      const client = await pool.connect();
      try {
        let where = `WHERE o.vendor_id = $1`;
        const params: any[] = [vendorId];

        if (status) {
          params.push(status);
          where += ` AND o.status = $${params.length}`;
        }

        const countResult = await client.query(
          `SELECT COUNT(*) FROM oms.oms_orders o ${where}`,
          params
        );
        const total = parseInt(countResult.rows[0].count);

        const ordersResult = await client.query(
          `SELECT o.id, o.external_order_id, o.status, o.customer_name,
                  o.ship_to_city, o.ship_to_state, o.total_cents,
                  o.tracking_number, o.tracking_carrier, o.shipped_at, o.ordered_at,
                  COALESCE(
                    (SELECT json_agg(json_build_object(
                      'sku', ol.sku,
                      'title', ol.title,
                      'quantity', ol.quantity,
                      'unit_price_cents', ol.unit_price_cents
                    ))
                    FROM oms_order_lines ol WHERE ol.order_id = o.id
                  ), '[]'::json) as items
           FROM oms.oms_orders o
           ${where}
           ORDER BY o.ordered_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limitNum, offset]
        );

        return res.json({
          orders: ordersResult.rows.map((o: any) => ({
            id: o.id,
            vendor_order_ref: o.external_order_id,
            status: o.status,
            customer_name: o.customer_name,
            ship_to_city: o.ship_to_city,
            ship_to_state: o.ship_to_state,
            total_cents: o.total_cents,
            items: typeof o.items === 'string' ? JSON.parse(o.items) : o.items,
            tracking_number: o.tracking_number,
            tracking_carrier: o.tracking_carrier,
            shipped_at: o.shipped_at,
            ordered_at: o.ordered_at,
          })),
          pagination: { page: pageNum, limit: limitNum, total, total_pages: Math.ceil(total / limitNum) },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Vendor orders error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/vendor/wallet/deposit — create Stripe Checkout Session
  // -----------------------------------------------------------------------
  app.post("/api/vendor/wallet/deposit", requireVendorAuth, async (req, res) => {
    try {
      const vendorId = req.vendor!.id;
      const { amount_cents } = req.body as { amount_cents: number };

      if (!amount_cents || typeof amount_cents !== "number") {
        return res.status(400).json({ error: "invalid_body", message: "amount_cents is required" });
      }
      if (amount_cents < 1000) {
        return res.status(400).json({ error: "minimum_deposit", message: "Minimum deposit is $10.00" });
      }
      if (amount_cents > 500000) {
        return res.status(400).json({ error: "maximum_deposit", message: "Maximum deposit is $5,000.00" });
      }

      const client = await pool.connect();
      try {
        // Get vendor's Stripe customer ID
        const vendorResult = await client.query(
          `SELECT stripe_customer_id, status FROM dropship_vendors WHERE id = $1`,
          [vendorId],
        );
        if (vendorResult.rows.length === 0) {
          return res.status(404).json({ error: "vendor_not_found" });
        }
        const vendor = vendorResult.rows[0];
        if (vendor.status !== "active") {
          return res.status(403).json({ error: "account_not_active" });
        }

        let stripeCustomerId = vendor.stripe_customer_id;

        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) {
          return res.status(500).json({ error: "missing_configuration", message: "Payments are not configured." });
        }
        const Stripe = (await import("stripe")).default;
        const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" as any });

        if (!stripeCustomerId) {
          const vendorDetail = await client.query(
            `SELECT name, email, company_name FROM dropship_vendors WHERE id = $1`,
            [vendorId],
          );
          const v = vendorDetail.rows[0];
          const customer = await stripe.customers.create({
            email: v.email,
            name: v.company_name || v.name,
            metadata: { vendor_id: String(vendorId), type: "dropship_vendor" },
          });
          stripeCustomerId = customer.id;
          await client.query(
            `UPDATE dropship_vendors SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2`,
            [stripeCustomerId, vendorId],
          );
        }

        const VENDOR_PORTAL_URL = process.env.VENDOR_PORTAL_URL || "https://vendors.cardshellz.ai";

        // Create Checkout Session
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          customer: stripeCustomerId,
          payment_method_types: ["card", "us_bank_account"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: "Dropship Wallet Deposit",
                  description: `Wallet deposit for Card Shellz dropship platform`,
                },
                unit_amount: amount_cents,
              },
              quantity: 1,
            },
          ],
          payment_intent_data: {
            setup_future_usage: "off_session", // Save payment method for auto-reload
          },
          success_url: `${VENDOR_PORTAL_URL}/wallet?deposit=success`,
          cancel_url: `${VENDOR_PORTAL_URL}/wallet?deposit=cancelled`,
          metadata: { vendor_id: String(vendorId), type: "wallet_deposit" },
        });

        return res.json({
          checkout_url: session.url,
          session_id: session.id,
        });
      } finally {
        client.release();
      }
    } catch (error: any) {
      console.error("Vendor deposit error:", error);
      return res.status(500).json({ error: "internal_error", message: error.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/vendor/wallet/auto-reload — update auto-reload settings
  // -----------------------------------------------------------------------
  app.post("/api/vendor/wallet/auto-reload", requireVendorAuth, async (req, res) => {
    try {
      const vendorId = req.vendor!.id;
      const { enabled, threshold_cents, amount_cents } = req.body as {
        enabled?: boolean;
        threshold_cents?: number;
        amount_cents?: number;
      };

      const updates: string[] = [];
      const params: any[] = [];

      if (typeof enabled === "boolean") {
        params.push(enabled);
        updates.push(`auto_reload_enabled = $${params.length}`);
      }
      if (typeof threshold_cents === "number" && threshold_cents >= 0) {
        params.push(threshold_cents);
        updates.push(`auto_reload_threshold_cents = $${params.length}`);
      }
      if (typeof amount_cents === "number" && amount_cents >= 1000) {
        params.push(amount_cents);
        updates.push(`auto_reload_amount_cents = $${params.length}`);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: "no_updates" });
      }

      updates.push("updated_at = NOW()");
      params.push(vendorId);

      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE dropship_vendors SET ${updates.join(", ")} WHERE id = $${params.length}`,
          params,
        );
        return res.json({ success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Vendor auto-reload error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });
}

// Webhooks have been moved to vendor-webhooks.ts
