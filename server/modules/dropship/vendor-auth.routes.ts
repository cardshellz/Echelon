import type { Express } from "express";
import { registerVendor, loginVendorSSO, requireVendorAuth } from "./vendor-auth";
import { VendorController } from "./interfaces/http/vendor.controller";
import { pool } from "../../db";
import { requireAuth } from "../../routes/middleware";

export function registerVendorAuthRoutes(app: Express) {
  // POST /api/vendor/onboarding
  app.post("/api/vendor/onboarding", requireAuth, VendorController.initiateOnboarding);

  // POST /api/vendor/auth/sso
  app.post("/api/vendor/auth/sso", requireAuth, async (req, res) => {
    try {
      const { shellzClubMemberId } = req.body;

      if (!shellzClubMemberId) {
        return res.status(400).json({ error: "missing_fields", message: "Member ID is required for SSO." });
      }

      // Important: In production this route must verify a signed Shellz Club JWT mapping
      // to this shellzClubMemberId. For Phase 0 foundation, it's trusted.
      const result = await loginVendorSSO(shellzClubMemberId);

      if ("error" in result) {
        return res.status(401).json(result);
      }

      res.cookie('vendor_token', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      });

      return res.json({ vendor: result.vendor });
    } catch (error) {
      console.error("Vendor SSO login error:", error);
      return res.status(500).json({ error: "internal_error", message: "SSO Login failed" });
    }
  });

  // POST /api/vendor/auth/logout (client-side JWT invalidation)
  app.post("/api/vendor/auth/logout", (_req, res) => {
    res.clearCookie('vendor_token');
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
