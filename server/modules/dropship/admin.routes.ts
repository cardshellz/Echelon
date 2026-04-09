import type { Express } from "express";
import { requireAuth } from "../../routes/middleware";
import { pool } from "../../db";

export function registerDropshipAdminRoutes(app: Express) {
  // GET /api/admin/vendors — list all vendors
  app.get("/api/admin/vendors", requireAuth, async (req, res) => {
    try {
      const { status, search, page = "1", limit = "50" } = req.query;
      const pageNum = Math.max(1, parseInt(page as string) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 50));
      const offset = (pageNum - 1) * limitNum;

      let where = "WHERE 1=1";
      const params: any[] = [];

      if (status && status !== "all") {
        params.push(status);
        where += ` AND v.status = $${params.length}`;
      }
      if (search) {
        params.push(`%${search}%`);
        where += ` AND (v.name ILIKE $${params.length} OR v.email ILIKE $${params.length} OR v.company_name ILIKE $${params.length})`;
      }

      const client = await pool.connect();
      try {
        const countResult = await client.query(
          `SELECT COUNT(*) FROM dropship_vendors v ${where}`,
          params
        );
        const total = parseInt(countResult.rows[0].count);

        const vendorResult = await client.query(
          `SELECT v.id, v.name, v.company_name, v.email, v.status, v.tier,
                  v.wallet_balance_cents, v.ebay_user_id, v.created_at,
                  (SELECT COUNT(*) FROM oms.oms_orders o WHERE o.vendor_id = v.id) as total_orders
           FROM dropship_vendors v
           ${where}
           ORDER BY v.created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limitNum, offset]
        );

        return res.json({
          vendors: vendorResult.rows.map((v: any) => ({
            id: v.id,
            name: v.name,
            company_name: v.company_name,
            email: v.email,
            status: v.status,
            tier: v.tier,
            wallet_balance_cents: v.wallet_balance_cents,
            total_orders: parseInt(v.total_orders) || 0,
            ebay_connected: !!v.ebay_user_id,
            ebay_user_id: v.ebay_user_id,
            created_at: v.created_at,
          })),
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            total_pages: Math.ceil(total / limitNum),
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Admin list vendors error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // GET /api/admin/vendors/:id — vendor detail
  app.get("/api/admin/vendors/:id", requireAuth, async (req, res) => {
    try {
      const vendorId = parseInt(req.params.id);
      if (isNaN(vendorId)) return res.status(400).json({ error: "invalid_id" });

      const client = await pool.connect();
      try {
        const vendorResult = await client.query(
          `SELECT * FROM dropship_vendors WHERE id = $1`,
          [vendorId]
        );
        if (vendorResult.rows.length === 0) {
          return res.status(404).json({ error: "not_found" });
        }
        const v = vendorResult.rows[0];

        // Stats
        const statsResult = await client.query(
          `SELECT
             (SELECT COUNT(*) FROM oms.oms_orders WHERE vendor_id = $1) as total_orders,
             (SELECT COUNT(*) FROM oms.oms_orders WHERE vendor_id = $1 AND ordered_at >= date_trunc('month', NOW())) as orders_this_month,
             (SELECT COALESCE(SUM(total_cents), 0) FROM oms.oms_orders WHERE vendor_id = $1) as total_revenue_cents,
             (SELECT COUNT(*) FROM dropship_vendor_products WHERE vendor_id = $1 AND enabled = true) as products_selected`,
          [vendorId]
        );
        const stats = statsResult.rows[0];

        // Recent orders
        const ordersResult = await client.query(
          `SELECT id, external_order_id, status, customer_name, total_cents, tracking_number, ordered_at
           FROM oms.oms_orders WHERE vendor_id = $1 ORDER BY ordered_at DESC LIMIT 10`,
          [vendorId]
        );

        // Recent transactions
        const txResult = await client.query(
          `SELECT id, type, amount_cents, balance_after_cents, reference_type, reference_id, notes, created_at
           FROM dropship_wallet_ledger WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [vendorId]
        );

        return res.json({
          vendor: {
            id: v.id,
            name: v.name,
            company_name: v.company_name,
            email: v.email,
            phone: v.phone,
            status: v.status,
            tier: v.tier,
            shellz_club_member_id: v.shellz_club_member_id,
            wallet_balance_cents: v.wallet_balance_cents,
            auto_reload_enabled: v.auto_reload_enabled,
            auto_reload_threshold_cents: v.auto_reload_threshold_cents,
            auto_reload_amount_cents: v.auto_reload_amount_cents,
            ebay_user_id: v.ebay_user_id,
            ebay_token_expires_at: v.ebay_token_expires_at,
            stripe_customer_id: v.stripe_customer_id,
            created_at: v.created_at,
            updated_at: v.updated_at,
          },
          stats: {
            total_orders: parseInt(stats.total_orders) || 0,
            orders_this_month: parseInt(stats.orders_this_month) || 0,
            total_revenue_cents: parseInt(stats.total_revenue_cents) || 0,
            products_selected: parseInt(stats.products_selected) || 0,
          },
          recent_orders: ordersResult.rows,
          recent_transactions: txResult.rows,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Admin vendor detail error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // PUT /api/admin/vendors/:id — update vendor status
  app.put("/api/admin/vendors/:id", requireAuth, async (req, res) => {
    try {
      const vendorId = parseInt(req.params.id);
      if (isNaN(vendorId)) return res.status(400).json({ error: "invalid_id" });

      const { status, tier } = req.body;
      const validStatuses = ["pending", "active", "suspended", "closed"];
      const validTiers = ["standard", "pro", "elite"];

      const updates: string[] = [];
      const params: any[] = [];

      if (status) {
        if (!validStatuses.includes(status)) {
          return res.status(400).json({ error: "invalid_status", message: `Status must be one of: ${validStatuses.join(", ")}` });
        }
        params.push(status);
        updates.push(`status = $${params.length}`);
      }

      if (tier) {
        if (!validTiers.includes(tier)) {
          return res.status(400).json({ error: "invalid_tier", message: `Tier must be one of: ${validTiers.join(", ")}` });
        }
        params.push(tier);
        updates.push(`tier = $${params.length}`);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: "no_updates", message: "No valid fields to update" });
      }

      updates.push("updated_at = NOW()");
      params.push(vendorId);

      const client = await pool.connect();
      try {
        const result = await client.query(
          `UPDATE dropship_vendors SET ${updates.join(", ")} WHERE id = $${params.length} RETURNING id, status, tier, updated_at`,
          params
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "not_found" });
        }

        return res.json(result.rows[0]);
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Admin update vendor error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // PUT /api/admin/products/:id/dropship-eligible — toggle dropship eligibility
  app.put("/api/admin/products/:id/dropship-eligible", requireAuth, async (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      if (isNaN(productId)) return res.status(400).json({ error: "invalid_id" });

      const { eligible } = req.body;
      if (typeof eligible !== "boolean") {
        return res.status(400).json({ error: "invalid_body", message: "eligible must be a boolean" });
      }

      const client = await pool.connect();
      try {
        const result = await client.query(
          `UPDATE catalog.products SET dropship_eligible = $1 WHERE id = $2 RETURNING id, name, dropship_eligible`,
          [eligible, productId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "not_found" });
        }

        return res.json({
          id: result.rows[0].id,
          title: result.rows[0].name,
          dropship_eligible: result.rows[0].dropship_eligible,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Admin toggle dropship eligible error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // POST /api/admin/products/bulk-dropship-eligible — bulk toggle
  app.post("/api/admin/products/bulk-dropship-eligible", requireAuth, async (req, res) => {
    try {
      const { productIds, eligible } = req.body;
      if (!Array.isArray(productIds) || productIds.length === 0) {
        return res.status(400).json({ error: "invalid_body", message: "productIds must be a non-empty array" });
      }
      if (typeof eligible !== "boolean") {
        return res.status(400).json({ error: "invalid_body", message: "eligible must be a boolean" });
      }

      const client = await pool.connect();
      try {
        const result = await client.query(
          `UPDATE catalog.products SET dropship_eligible = $1 WHERE id = ANY($2::int[]) RETURNING id`,
          [eligible, productIds]
        );

        return res.json({
          updated: result.rowCount,
          product_ids: result.rows.map((r: any) => r.id),
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Admin bulk dropship eligible error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });
}
