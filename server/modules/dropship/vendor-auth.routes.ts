import type { Express } from "express";
import { registerVendor, loginVendor, requireVendorAuth } from "./vendor-auth";
import { pool } from "../../db";

export function registerVendorAuthRoutes(app: Express) {
  // POST /api/vendor/auth/register
  app.post("/api/vendor/auth/register", async (req, res) => {
    try {
      const { email, password, name, companyName, phone, shellzClubMemberId } = req.body;

      if (!email || !password || !name) {
        return res.status(400).json({ error: "missing_fields", message: "Email, password, and name are required" });
      }

      const result = await registerVendor(email, password, name, companyName, phone, shellzClubMemberId);

      if ("error" in result) {
        return res.status(400).json(result);
      }

      return res.status(201).json(result);
    } catch (error) {
      console.error("Vendor registration error:", error);
      return res.status(500).json({ error: "internal_error", message: "Registration failed" });
    }
  });

  // POST /api/vendor/auth/login
  app.post("/api/vendor/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: "missing_fields", message: "Email and password are required" });
      }

      const result = await loginVendor(email, password);

      if ("error" in result) {
        const statusCode = result.error === "invalid_credentials" ? 401 : 403;
        return res.status(statusCode).json(result);
      }

      return res.json(result);
    } catch (error) {
      console.error("Vendor login error:", error);
      return res.status(500).json({ error: "internal_error", message: "Login failed" });
    }
  });

  // POST /api/vendor/auth/logout (client-side JWT invalidation)
  app.post("/api/vendor/auth/logout", (_req, res) => {
    return res.json({ success: true });
  });

  // GET /api/vendor/auth/me
  app.get("/api/vendor/auth/me", requireVendorAuth, async (req, res) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT id, name, email, company_name, phone, status, tier,
                  wallet_balance_cents, auto_reload_enabled, auto_reload_threshold_cents,
                  auto_reload_amount_cents, ebay_user_id, stripe_customer_id, created_at
           FROM dropship_vendors WHERE id = $1`,
          [req.vendor!.id]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "not_found" });
        }

        const v = result.rows[0];
        return res.json({
          id: v.id,
          email: v.email,
          name: v.name,
          company_name: v.company_name,
          phone: v.phone,
          status: v.status,
          tier: v.tier,
          wallet_balance_cents: v.wallet_balance_cents,
          auto_reload_enabled: v.auto_reload_enabled,
          auto_reload_threshold_cents: v.auto_reload_threshold_cents,
          auto_reload_amount_cents: v.auto_reload_amount_cents,
          ebay_connected: !!v.ebay_user_id,
          ebay_user_id: v.ebay_user_id,
          stripe_customer_id: v.stripe_customer_id,
          created_at: v.created_at,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Vendor me error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });
}
