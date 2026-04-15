import Stripe from "stripe";
import { DropshipError } from "../domain/errors";

// Strict API versioning locking determinism
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_mock", {
  apiVersion: "2023-10-16",
  typescript: true,
});

const VENDOR_PORTAL_URL = process.env.VENDOR_PORTAL_URL || "http://localhost:3001/dropship";

export class StripeClient {
  
  /**
   * Safely instantiates isolated Customer accounts preventing bleeding identities natively.
   */
  static async createCustomer(email: string, name: string): Promise<string> {
    try {
      const customer = await stripe.customers.create({ email, name });
      return customer.id;
    } catch (e: any) {
      console.error("[StripeClient] Customer instantiation failed:", e.message);
      return ""; // Do not strictly abort onboarding loops over async Stripe failures
    }
  }

  /**
   * Generates a dynamic Checkout node bound to explicit metadata matrices tracking deposits securely.
   */
  static async createFundingSession(stripeCustomerId: string, vendorId: number, amountCents: number): Promise<string> {
    try {
      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId || undefined,
        payment_method_types: ["card", "us_bank_account"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "Echelon Dropship Wallet Load",
                description: `Prepaid operational injection explicitly ensuring execution arrays.`,
              },
              unit_amount: amountCents,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${VENDOR_PORTAL_URL}/dashboard?deposit=success`,
        cancel_url: `${VENDOR_PORTAL_URL}/dashboard?deposit=cancelled`,
        metadata: {
          dropship_vendor_id: vendorId.toString(),
          type: "wallet_load"
        }
      });

      if (!session.url) throw new Error("Stripe natively failed to generate downstream routing blocks.");
      return session.url;
    } catch (e: any) {
      throw new DropshipError("STRIPE_API_ERROR", "Payment infrastructure denied execution sequence securely.", { detail: e.message });
    }
  }
}
