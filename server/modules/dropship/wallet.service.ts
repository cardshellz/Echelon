/**
 * Dropship Wallet Service
 *
 * Atomic wallet operations with row-level locking.
 * Every mutation creates an immutable ledger entry.
 * wallet_balance_cents on dropship_vendors is the cached balance,
 * source of truth is the ledger.
 */

import { pool } from "../../db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletOperationResult {
  success: true;
  newBalance: number;
  ledgerEntryId: number;
}

export interface WalletOperationFailure {
  success: false;
  reason: "insufficient_funds" | "vendor_not_found" | "error";
  message: string;
  requiredCents?: number;
  balanceCents?: number;
}

export type WalletResult = WalletOperationResult | WalletOperationFailure;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createWalletService() {
  /**
   * Get current wallet balance for a vendor.
   */
  async function getBalance(vendorId: number): Promise<number> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT wallet_balance_cents FROM dropship_vendors WHERE id = $1`,
        [vendorId],
      );
      if (result.rows.length === 0) return 0;
      return result.rows[0].wallet_balance_cents;
    } finally {
      client.release();
    }
  }

  /**
   * Debit vendor wallet. Fails if insufficient funds.
   * Atomic: row lock + ledger entry + balance update in one transaction.
   */
  async function debitWallet(
    vendorId: number,
    amountCents: number,
    referenceType: string,
    referenceId: string,
    notes?: string,
    existingClient?: any,
  ): Promise<WalletResult> {
    if (amountCents <= 0) {
      return { success: false, reason: "error", message: "Debit amount must be positive" };
    }

    const client = existingClient || await pool.connect();
    const ownClient = !existingClient;
    try {
      if (ownClient) await client.query("BEGIN");

      // Row lock on vendor
      const vendorResult = await client.query(
        `SELECT wallet_balance_cents FROM dropship_vendors WHERE id = $1 FOR UPDATE`,
        [vendorId],
      );

      if (vendorResult.rows.length === 0) {
        if (ownClient) await client.query("ROLLBACK");
        return { success: false, reason: "vendor_not_found", message: "Vendor not found" };
      }

      const currentBalance = vendorResult.rows[0].wallet_balance_cents;

      if (currentBalance < amountCents) {
        if (ownClient) await client.query("ROLLBACK");
        return {
          success: false,
          reason: "insufficient_funds",
          message: `Insufficient funds. Required: $${(amountCents / 100).toFixed(2)}, Balance: $${(currentBalance / 100).toFixed(2)}`,
          requiredCents: amountCents,
          balanceCents: currentBalance,
        };
      }

      const newBalance = currentBalance - amountCents;

      // Create ledger entry (negative amount for debits)
      const ledgerResult = await client.query(
        `INSERT INTO dropship_wallet_ledger
         (vendor_id, type, amount_cents, balance_after_cents, reference_type, reference_id, notes, created_by, created_at)
         VALUES ($1, 'order_debit', $2, $3, $4, $5, $6, $7, NOW())
         RETURNING id`,
        [vendorId, -amountCents, newBalance, referenceType, referenceId, notes || null, `system`],
      );

      // Update cached balance
      await client.query(
        `UPDATE dropship_vendors SET wallet_balance_cents = $1, updated_at = NOW() WHERE id = $2`,
        [newBalance, vendorId],
      );

      if (ownClient) await client.query("COMMIT");

      // Fire-and-forget: check auto-reload
      if (ownClient) {
        checkAutoReload(vendorId).catch((err) =>
          console.error(`[Wallet] Auto-reload check failed for vendor ${vendorId}: ${err.message}`),
        );
      }

      return {
        success: true,
        newBalance,
        ledgerEntryId: ledgerResult.rows[0].id,
      };
    } catch (err: any) {
      if (ownClient) {
        try { await client.query("ROLLBACK"); } catch {}
      }
      console.error(`[Wallet] Debit failed for vendor ${vendorId}: ${err.message}`);
      return { success: false, reason: "error", message: err.message };
    } finally {
      if (ownClient) client.release();
    }
  }

  /**
   * Credit vendor wallet.
   * Atomic: row lock + ledger entry + balance update in one transaction.
   */
  async function creditWallet(
    vendorId: number,
    amountCents: number,
    referenceType: string,
    referenceId: string,
    paymentMethod?: string,
    notes?: string,
    ledgerType?: string,
    existingClient?: any,
  ): Promise<WalletResult> {
    if (amountCents <= 0) {
      return { success: false, reason: "error", message: "Credit amount must be positive" };
    }

    const client = existingClient || await pool.connect();
    const ownClient = !existingClient;
    try {
      if (ownClient) await client.query("BEGIN");

      // Row lock on vendor
      const vendorResult = await client.query(
        `SELECT wallet_balance_cents FROM dropship_vendors WHERE id = $1 FOR UPDATE`,
        [vendorId],
      );

      if (vendorResult.rows.length === 0) {
        if (ownClient) await client.query("ROLLBACK");
        return { success: false, reason: "vendor_not_found", message: "Vendor not found" };
      }

      const currentBalance = vendorResult.rows[0].wallet_balance_cents;
      const newBalance = currentBalance + amountCents;
      const type = ledgerType || "deposit";

      // Create ledger entry (positive amount for credits)
      const ledgerResult = await client.query(
        `INSERT INTO dropship_wallet_ledger
         (vendor_id, type, amount_cents, balance_after_cents, reference_type, reference_id, payment_method, notes, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         RETURNING id`,
        [vendorId, type, amountCents, newBalance, referenceType, referenceId, paymentMethod || null, notes || null, `system`],
      );

      // Update cached balance
      await client.query(
        `UPDATE dropship_vendors SET wallet_balance_cents = $1, updated_at = NOW() WHERE id = $2`,
        [newBalance, vendorId],
      );

      if (ownClient) await client.query("COMMIT");

      return {
        success: true,
        newBalance,
        ledgerEntryId: ledgerResult.rows[0].id,
      };
    } catch (err: any) {
      if (ownClient) {
        try { await client.query("ROLLBACK"); } catch {}
      }
      console.error(`[Wallet] Credit failed for vendor ${vendorId}: ${err.message}`);
      return { success: false, reason: "error", message: err.message };
    } finally {
      if (ownClient) client.release();
    }
  }

  /**
   * Refund credit — credits wallet for cancelled/returned order.
   */
  async function refundCredit(
    vendorId: number,
    amountCents: number,
    referenceType: string,
    referenceId: string,
    notes?: string,
  ): Promise<WalletResult> {
    return creditWallet(vendorId, amountCents, referenceType, referenceId, undefined, notes, "refund_credit");
  }

  /**
   * Check auto-reload after a debit.
   * Fire-and-forget — does not block the caller.
   */
  async function checkAutoReload(vendorId: number): Promise<void> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT wallet_balance_cents, auto_reload_enabled, auto_reload_threshold_cents,
                auto_reload_amount_cents, stripe_customer_id
         FROM dropship_vendors WHERE id = $1`,
        [vendorId],
      );

      if (result.rows.length === 0) return;
      const vendor = result.rows[0];

      if (!vendor.auto_reload_enabled) return;
      if (vendor.wallet_balance_cents >= vendor.auto_reload_threshold_cents) return;
      if (!vendor.stripe_customer_id) return;

      // Try to charge saved payment method
      try {
        const Stripe = (await import("stripe")).default;
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) {
          console.error(`[Wallet AutoReload] Payments are not configured. Cannot auto-reload vendor ${vendorId}`);
          return;
        }
        const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" as any });

        // Get saved payment methods
        const paymentMethods = await stripe.paymentMethods.list({
          customer: vendor.stripe_customer_id,
          type: "card",
          limit: 1,
        });

        if (paymentMethods.data.length === 0) {
          // Try ACH
          const achMethods = await stripe.paymentMethods.list({
            customer: vendor.stripe_customer_id,
            type: "us_bank_account",
            limit: 1,
          });
          if (achMethods.data.length === 0) {
            console.log(`[Wallet AutoReload] No saved payment method for vendor ${vendorId}`);
            return;
          }
        }

        const pm = paymentMethods.data[0] || (await stripe.paymentMethods.list({
          customer: vendor.stripe_customer_id,
          type: "us_bank_account",
          limit: 1,
        })).data[0];

        if (!pm) return;

        const paymentIntent = await stripe.paymentIntents.create({
          amount: vendor.auto_reload_amount_cents,
          currency: "usd",
          customer: vendor.stripe_customer_id,
          payment_method: pm.id,
          off_session: true,
          confirm: true,
          metadata: { vendor_id: String(vendorId), type: "auto_reload" },
        });

        if (paymentIntent.status === "succeeded") {
          await creditWallet(
            vendorId,
            vendor.auto_reload_amount_cents,
            "stripe_payment",
            paymentIntent.id,
            pm.type === "card" ? "stripe_card" : "stripe_ach",
            "Auto-reload triggered by low balance",
            "auto_reload",
          );
          console.log(`[Wallet AutoReload] Charged $${(vendor.auto_reload_amount_cents / 100).toFixed(2)} for vendor ${vendorId}`);
        }
      } catch (stripeErr: any) {
        console.error(`[Wallet AutoReload] Stripe charge failed for vendor ${vendorId}: ${stripeErr.message}`);
        // Don't block — this is fire-and-forget
      }
    } finally {
      client.release();
    }
  }

  return {
    getBalance,
    debitWallet,
    creditWallet,
    refundCredit,
    checkAutoReload,
  };
}

export type WalletService = ReturnType<typeof createWalletService>;

// Singleton
export const walletService = createWalletService();
