import express, { type Express, Request, Response } from "express";
import { pool } from "../../db";
import { walletService } from "./wallet.service";
import rateLimit from "express-rate-limit";

export function registerStripeWebhookRoute(app: Express): void {
  const stripeWebhookLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // Limit each IP to 100 webhook requests per `window`
    message: "Too many webhooks from this IP, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Use express.raw() to capture the raw body buffer exactly as Stripe sent it
  app.post(
    "/api/webhooks/stripe-dropship",
    stripeWebhookLimiter,
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      try {
        const Stripe = (await import("stripe")).default;
        if (!process.env.STRIPE_SECRET_KEY) throw new Error("FATAL: STRIPE_SECRET_KEY missing");
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-12-18.acacia" as any });

        const webhookSecret = process.env.STRIPE_DROPSHIP_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
        if (!webhookSecret) {
          throw new Error("FATAL: STRIPE_WEBHOOK_SECRET missing. Payload cannot be verified.");
        }

        const sig = req.headers["stripe-signature"] as string;
        if (!sig) {
          return res.status(400).json({ error: "missing_signature" });
        }

        let event;
        try {
          event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        } catch (err: any) {
          console.error(`[Stripe Webhook] Signature verification failed: ${err.message}`);
          return res.status(400).json({ error: "webhook_signature_failed" });
        }

        const eventType = event.type;
        console.log(`[Stripe Webhook] Received: ${eventType}`);

        if (eventType === "checkout.session.completed" || eventType === "payment_intent.succeeded") {
          let vendorId: number | null = null;
          let amountCents: number = 0;
          let paymentIntentId: string | null = null;
          let paymentMethod = "stripe_card";
          let depositType = "wallet_deposit";

          if (eventType === "checkout.session.completed") {
            const session = event.data.object;
            vendorId = session.metadata?.vendor_id ? parseInt(session.metadata.vendor_id) : null;
            amountCents = session.amount_total || 0;
            paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null;
            depositType = session.metadata?.type || "wallet_deposit";
          } else {
            const pi = event.data.object;
            vendorId = pi.metadata?.vendor_id ? parseInt(pi.metadata.vendor_id) : null;
            amountCents = pi.amount || 0;
            paymentIntentId = pi.id;
            depositType = pi.metadata?.type || "wallet_deposit";
            if (pi.payment_method_types?.includes("us_bank_account")) {
              paymentMethod = "stripe_ach";
            }
          }

          if (!vendorId || !amountCents) {
            console.warn(`[Stripe Webhook] Missing vendor_id or amount in ${eventType}`);
            return res.json({ received: true });
          }

          if (paymentIntentId) {
            const client = await pool.connect();
            try {
              const existing = await client.query(
                `SELECT id FROM dropship_wallet_ledger WHERE reference_type = 'stripe_payment' AND reference_id = $1 LIMIT 1`,
                [paymentIntentId],
              );
              if (existing.rows.length > 0) {
                console.log(`[Stripe Webhook] Already processed payment ${paymentIntentId} - skipping`);
                return res.json({ received: true });
              }
            } finally {
              client.release();
            }
          }

          const ledgerType = depositType === "auto_reload" ? "auto_reload" : "deposit";

          const result = await walletService.creditWallet(
            vendorId,
            amountCents,
            "stripe_payment",
            paymentIntentId || `stripe_${Date.now()}`,
            paymentMethod,
            `${ledgerType === "auto_reload" ? "Auto-reload" : "Wallet deposit"} via Stripe`,
            ledgerType,
          );

          if (result.success) {
            console.log(`[Stripe Webhook] Credited $${(amountCents / 100).toFixed(2)} to vendor ${vendorId}`);
          } else {
            console.error(`[Stripe Webhook] Credit failed for vendor ${vendorId}: ${(result as any).message}`);
          }
        } else if (eventType === "payment_intent.payment_failed") {
          const pi = event.data.object;
          const vendorId = pi.metadata?.vendor_id;
          console.warn(`[Stripe Webhook] Payment failed for vendor ${vendorId}: ${pi.last_payment_error?.message || "unknown error"}`);
        }

        return res.json({ received: true });
      } catch (error: any) {
        console.error("Stripe webhook error:", error);
        return res.status(500).json({ error: "internal_error" });
      }
    }
  );
}
