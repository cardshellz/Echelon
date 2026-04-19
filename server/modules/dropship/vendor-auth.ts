import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../../db";

if (!process.env.VENDOR_JWT_SECRET) {
  throw new Error("FATAL: VENDOR_JWT_SECRET environment variable is missing.");
}
const VENDOR_JWT_SECRET = process.env.VENDOR_JWT_SECRET;
const VENDOR_JWT_EXPIRES_IN = process.env.VENDOR_JWT_EXPIRES_IN || "24h";

export interface VendorPayload {
  vendor_id: number;
  email: string;
  tier: string;
  status: string;
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      vendor?: VendorPayload & { id: number; name: string; company_name: string | null };
    }
  }
}

function signToken(vendor: { id: number; email: string; tier: string; status: string }): string {
  // expiresIn accepts number (seconds) or zeit/ms string like "24h"
  return (jwt.sign as any)(
    { vendor_id: vendor.id, email: vendor.email, tier: vendor.tier, status: vendor.status },
    VENDOR_JWT_SECRET,
    { expiresIn: VENDOR_JWT_EXPIRES_IN }
  );
}

export async function registerVendor(
  email: string,
  name: string,
  companyName?: string,
  phone?: string,
  shellzClubMemberId?: number
) {
  const client = await pool.connect();
  try {
    // Validate email not taken
    const existingEmail = await client.query(
      `SELECT id FROM dropship_vendors WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    if (existingEmail.rows.length > 0) {
      return { error: "email_taken", message: "Email is already registered" };
    }

    // Validate Shellz Club membership by email match
    let tier = "standard";
    let shellzClubMemberIdResolved: string | null = null;
    
    const member = await client.query(
      `SELECT id FROM membership.members WHERE LOWER(email) = LOWER($1)`,
      [email.trim()]
    );
    
    if (member.rows.length > 0) {
      shellzClubMemberIdResolved = member.rows[0].id;
      
      // Check if already registered
      const existingMember = await client.query(
        `SELECT id FROM dropship_vendors WHERE shellz_club_member_id = $1`,
        [shellzClubMemberIdResolved]
      );
      if (existingMember.rows.length > 0) {
        return { error: "already_registered", message: "A vendor account already exists for this membership" };
      }

      // Derive tier from membership — Gold tier required for dropship access
      try {
        const membership = await client.query(
          `SELECT mcm.plan_name, p.includes_dropship, p.tier as plan_tier
           FROM member_current_membership mcm
           LEFT JOIN membership.plans p ON p.id = mcm.plan_id
           WHERE mcm.member_id = $1 LIMIT 1`,
          [shellzClubMemberIdResolved]
        );
        if (membership.rows.length > 0) {
          const plan = (membership.rows[0].plan_name || "").toLowerCase();
          const includesDropship = membership.rows[0].includes_dropship;
          const planTier = membership.rows[0].plan_tier;

          // Check if plan includes dropship access (Gold tier)
          if (includesDropship === false && planTier !== "gold" && !plan.includes("gold")) {
            return {
              error: "plan_upgrade_required",
              message: "Your Shellz Club plan doesn't include dropship access. Upgrade to Gold to unlock the vendor portal."
            };
          }

          if (plan.includes("gold") || planTier === "gold") tier = "gold";
          else if (plan.includes("elite")) tier = "elite";
          else if (plan.includes("pro")) tier = "pro";
        }
      } catch {
        // Table may not exist — default to standard
      }
    } else if (shellzClubMemberId) {
      // Fallback: try by member ID directly
      const memberById = await client.query(
        `SELECT id FROM membership.members WHERE id = $1`,
        [shellzClubMemberId]
      );
      if (memberById.rows.length > 0) {
        shellzClubMemberIdResolved = memberById.rows[0].id;
      }
    }

    // Create Stripe Customer
    let stripeCustomerId: string | null = null;
    try {
      const Stripe = (await import("stripe")).default;
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (stripeKey) {
        const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" as any });
        const customer = await stripe.customers.create({
          email: email.toLowerCase().trim(),
          name: companyName || name,
          metadata: { type: "dropship_vendor" },
        });
        stripeCustomerId = customer.id;
      }
    } catch (stripeErr: any) {
      console.error(`[VendorAuth] Stripe customer creation failed: ${stripeErr.message}`);
      // Non-fatal — continue registration without Stripe
    }

    const result = await client.query(
      `INSERT INTO dropship_vendors (name, email, company_name, phone, shellz_club_member_id, status, tier, stripe_customer_id)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING id, name, email, company_name, status, tier, wallet_balance_cents, created_at`,
      [name, email.toLowerCase().trim(), companyName || null, phone || null, shellzClubMemberIdResolved || null, tier, stripeCustomerId]
    );

    const vendor = result.rows[0];
    const token = signToken(vendor);

    return {
      vendor: {
        id: vendor.id,
        email: vendor.email,
        name: vendor.name,
        company_name: vendor.company_name,
        status: vendor.status,
        tier: vendor.tier,
        wallet_balance_cents: vendor.wallet_balance_cents,
      },
      token,
    };
  } finally {
    client.release();
  }
}

export async function loginVendorSSO(shellzClubMemberId: number) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT id, name, email, company_name, status, tier, wallet_balance_cents,
              ebay_user_id, created_at
       FROM dropship_vendors WHERE shellz_club_member_id = $1`,
      [shellzClubMemberId]
    );

    if (result.rows.length === 0) {
      return { error: "unregistered", message: "No dropship account associated with this membership." };
    }

    const vendor = result.rows[0];

    if (vendor.status === "suspended") {
      return { error: "account_suspended", message: "Your account has been suspended. Contact support." };
    }
    if (vendor.status === "closed") {
      return { error: "account_closed", message: "This account has been closed." };
    }

    const token = signToken(vendor);

    return {
      vendor: {
        id: vendor.id,
        email: vendor.email,
        name: vendor.name,
        company_name: vendor.company_name,
        status: vendor.status,
        tier: vendor.tier,
        wallet_balance_cents: vendor.wallet_balance_cents,
        ebay_connected: !!vendor.ebay_user_id,
      },
      token,
    };
  } finally {
    client.release();
  }
}

export async function requireVendorAuth(req: Request, res: Response, next: NextFunction) {
  // Read token from cookie first, fall back to Authorization header
  let token = req.cookies?.vendor_token;
  
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }

  if (!token) {
    return res.status(401).json({ error: "unauthorized", message: "Missing or invalid authorization token" });
  }

  try {
    const decoded = jwt.verify(token, VENDOR_JWT_SECRET) as VendorPayload;

    if (decoded.status !== "active" && decoded.status !== "pending") {
      return res.status(403).json({ error: "account_not_active", status: decoded.status });
    }

    // Attach vendor info to request — load fresh from DB for critical fields
    let client;
    try {
      client = await pool.connect();
      const result = await client.query(
        `SELECT id, name, email, company_name, status, tier FROM dropship_vendors WHERE id = $1`,
        [decoded.vendor_id]
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ error: "unauthorized", message: "Vendor not found" });
      }
      const vendor = result.rows[0];
      if (vendor.status !== "active") {
        return res.status(403).json({ error: "account_not_active", status: vendor.status });
      }
      req.vendor = {
        vendor_id: vendor.id,
        id: vendor.id,
        email: vendor.email,
        name: vendor.name,
        company_name: vendor.company_name,
        tier: vendor.tier,
        status: vendor.status,
      };
      
      return next();
    } catch (dbErr) {
      return res.status(500).json({ error: "internal_error" });
    } finally {
      if (client) client.release();
    }
  } catch (err: any) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "token_expired", message: "Token has expired" });
    }
    return res.status(401).json({ error: "unauthorized", message: "Invalid token" });
  }
}
