import { pool } from "../../../db";
import { Vendor } from "../domain/vendor";
import { DropshipError } from "../domain/errors";

export class DropshipRepository {
  /**
   * Fetches Shellz Club plan details strictly mapping SQL schema fields over.
   */
  static async getMembershipDetailsByEmail(email: string): Promise<{ id: number, planName: string, includesDropship: boolean, planTier: string } | null> {
    const client = await pool.connect();
    try {
      const memberRes = await client.query(
        `SELECT id FROM membership.members WHERE LOWER(email) = LOWER($1)`,
        [email.trim()]
      );

      if (memberRes.rows.length === 0) return null;
      const memberId = memberRes.rows[0].id;

      const planRes = await client.query(
        `SELECT mcm.plan_name, p.includes_dropship, p.tier as plan_tier
         FROM member_current_membership mcm
         LEFT JOIN membership.plans p ON p.id = mcm.plan_id
         WHERE mcm.member_id = $1 LIMIT 1`,
        [memberId]
      );

      // Handle raw members with no active paid subscriptions
      if (planRes.rows.length === 0) {
        return { id: memberId, planName: "none", includesDropship: false, planTier: "none" };
      }

      return {
        id: memberId,
        planName: planRes.rows[0].plan_name || "",
        includesDropship: planRes.rows[0].includes_dropship || false,
        planTier: planRes.rows[0].plan_tier || "",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Validates if a dropship account is already hooked to this identity.
   */
  static async vendorExists(email: string, memberId: number): Promise<boolean> {
    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT id FROM dropship_vendors WHERE shellz_club_member_id = $1 OR LOWER(email) = LOWER($2)`,
        [memberId, email.trim()]
      );
      return res.rows.length > 0;
    } finally {
      client.release();
    }
  }

  /**
   * Inserts the vendor entity cleanly utilizing parameterization. 
   * Handled inside native postgres query since it's a single insert statement.
   */
  static async insertVendor(vendor: Vendor): Promise<Vendor> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO dropship_vendors (name, email, company_name, phone, shellz_club_member_id, status, tier, stripe_customer_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, email, company_name as "companyName", status, tier, wallet_balance_cents as "walletBalanceCents"`,
        [vendor.name, vendor.email, vendor.companyName, vendor.phone, vendor.shellzClubMemberId, vendor.status, vendor.tier, vendor.stripeCustomerId]
      );

      return result.rows[0] as Vendor;
    } catch (error: any) {
      if (error.code === '23505') { // Postgres Unique Constraint Violation
        throw new DropshipError("DUPLICATE_ACCOUNT", "Vendor account already exists natively inside dropship mapping.", { detail: error.detail });
      }
      throw error; 
    } finally {
      client.release();
    }
  }
}
