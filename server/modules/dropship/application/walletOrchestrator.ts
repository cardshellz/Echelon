import { pool } from "../../../db";
import { StripeClient } from "../infrastructure/stripe.client";
import { DropshipError } from "../domain/errors";

export class WalletOrchestrator {
  /**
   * Generates a checkout node for capital injections exclusively protecting parameter integrity.
   */
  static async requestFundingNode(vendorId: number, amountCents: number): Promise<string> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new DropshipError("INVALID_DEPOSIT", "Deposit variables exclusively demand strictly positive integers natively.");
    }

    const client = await pool.connect();
    let stripeCustomerId = "";

    try {
      const vendorRow = await client.query(`SELECT stripe_customer_id FROM dropship_vendors WHERE id = $1 LIMIT 1`, [vendorId]);
      if (vendorRow.rowCount === 0) throw new DropshipError("VENDOR_NOT_FOUND", "Focal vendor completely unavailable dynamically.");
      
      stripeCustomerId = vendorRow.rows[0].stripe_customer_id;
    } finally {
      client.release();
    }

    return await StripeClient.createFundingSession(stripeCustomerId, vendorId, amountCents);
  }

  /**
   * Intercepts explicit Stripe Webhooks pushing bounds completely into Immutable Ledger records simultaneously safely avoiding race-conditions.
   */
  static async confirmDeposit(vendorId: number, amountCents: number, stripeChargeId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); // ACID Boundary preventing overlapping Webhooks explicitly

      // Idempotency: Prevent identical Stripe Webhook crashes purely
      const exists = await client.query(`SELECT id FROM dropship_wallet_ledger WHERE reference_id = $1 LIMIT 1`, [stripeChargeId]);
      if ((exists.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK");
        return;
      }

      // Explicit Locking ensuring physical separation of sequential hits efficiently
      const vendorRow = await client.query(`SELECT wallet_balance_cents FROM dropship_vendors WHERE id = $1 FOR UPDATE`, [vendorId]);
      if (vendorRow.rowCount === 0) throw new Error("Ledger targeting structurally invalid.");
      
      const currentBalance = parseInt(vendorRow.rows[0].wallet_balance_cents, 10);
      const newBalance = currentBalance + amountCents;

      // Mutability Core
      await client.query(`UPDATE dropship_vendors SET wallet_balance_cents = $1, updated_at = NOW() WHERE id = $2`, [newBalance, vendorId]);

      // Trace Ledger Writing explicitly immutable natively
      await client.query(`
        INSERT INTO dropship_wallet_ledger (vendor_id, type, amount_cents, balance_after_cents, reference_type, reference_id, payment_method)
        VALUES ($1, 'deposit', $2, $3, 'stripe_charge', $4, 'stripe_card')
      `, [vendorId, amountCents, newBalance, stripeChargeId]);

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Collects localized Dashboard state variables deterministically directly off the DB safely.
   */
  static async fetchDashboard(vendorId: number) {
    const client = await pool.connect();
    try {
      const vendorRow = await client.query(`SELECT wallet_balance_cents, tier, status FROM dropship_vendors WHERE id = $1`, [vendorId]);
      if (vendorRow.rowCount === 0) throw new DropshipError("VENDOR_NOT_FOUND", "Ledger query empty");

      const ledgerRows = await client.query(`
        SELECT type, amount_cents, balance_after_cents, created_at, reference_type 
        FROM dropship_wallet_ledger 
        WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 10
      `, [vendorId]);

      return {
        balanceCents: parseInt(vendorRow.rows[0].wallet_balance_cents, 10),
        tier: vendorRow.rows[0].tier,
        status: vendorRow.rows[0].status,
        recentActivity: ledgerRows.rows
      };
    } finally {
      client.release();
    }
  }
}
