import { Request, Response } from "express";
import Stripe from "stripe";
import { WalletOrchestrator } from "../../application/walletOrchestrator";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_mock", {
  apiVersion: "2023-10-16",
});

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || "whsec_mock";

export class WebhookController {
  
  /**
   * Universal Webhook parser mapping explicit cryptographic checks against incoming Stripe payments.
   * Required: Express must be configured to pass raw `req.body` arrays natively for this hook definitively.
   */
  static async handleStripeEvent(req: Request, res: Response) {
    const signature = req.headers['stripe-signature'];
    let event: Stripe.Event;

    try {
      // Physical AES signature generation bounding authenticity securely
      event = stripe.webhooks.constructEvent(req.body, signature as string, endpointSecret);
    } catch (err: any) {
      console.error(\`[Webhook] Identity boundary broken: \${err.message}\`);
      return res.status(400).send(\`Webhook Error: \${err.message}\`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;

      if (session.metadata?.type === 'wallet_load' && session.metadata?.dropship_vendor_id) {
        const vendorId = parseInt(session.metadata.dropship_vendor_id, 10);
        const amountCents = session.amount_total || 0;
        
        // Idempotency string mapping explicitly preserving uniqueness
        const chargeId = typeof session.payment_intent === 'string' ? session.payment_intent : session.id;

        try {
          // Route into the strict BEGIN / COMMIT DB Locks securely preventing overlapping funding hits
          await WalletOrchestrator.confirmDeposit(vendorId, amountCents, chargeId);
          console.log(\`[Webhook] Verified $ \${(amountCents/100).toFixed(2)} routed safely to Ledger \${vendorId}\`);
        } catch (error) {
          console.error(\`[Webhook] DB Ledger Locks crashed execution. Emitting 500 natively so Stripe Retries:\`, error);
          // A 500 prevents Stripe from registering the payment mapped, forcing an automated retry natively.
          return res.status(500).json({ error: "System Boundary Locked" });
        }
      }
    }

    return res.status(200).json({ received: true });
  }
}
