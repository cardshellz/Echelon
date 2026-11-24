// subscription.webhooks.ts — Webhook routes for Shopify subscription events
// These routes must be registered BEFORE auth middleware (unauthenticated, signature-verified).
import type { Express, Request, Response } from "express";
import { verifyShopifyWebhook } from "../../../integrations/shopify.api";
import { logger } from "../../../../platform/observability/logger";
/*
import {
  handleContractCreated,
  handleContractUpdated,
  handleBillingSuccess,
  handleBillingFailure,
} from "./subscription.service";
*/

/**
 * Register subscription webhook routes.
 * Call this early in Express setup — before body-parsing middleware
 * would consume the raw body (though our app uses rawBody pattern).
 */
export function registerSubscriptionWebhookRoutes(app: Express): void {
  // Helper: verify webhook HMAC and parse payload
  async function processWebhook(req: Request, res: Response, handler: (payload: any) => Promise<void>) {
    try {
      // Verify HMAC signature
      const hmacHeader = req.headers["x-shopify-hmac-sha256"] as string;
      if (!hmacHeader) {
        logger.warn("subscriptions.subscription_webhooks", { message: "[SubWebhook] Missing HMAC header" });
        return res.status(401).json({ error: "Missing HMAC header" });
      }

      const rawBody = (req as any).rawBody as Buffer;
      if (!rawBody) {
        logger.warn("subscriptions.subscription_webhooks", { message: "[SubWebhook] Missing raw body" });
        return res.status(400).json({ error: "Missing raw body" });
      }

      if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
        logger.warn("subscriptions.subscription_webhooks", { message: "[SubWebhook] Invalid HMAC signature" });
        return res.status(401).json({ error: "Invalid signature" });
      }

      // Parse payload
      const payload = JSON.parse(rawBody.toString("utf-8"));

      // Return 200 immediately, process async
      res.status(200).json({ received: true });

      // Process in background
      handler(payload).catch(err => {
        logger.error("subscriptions.subscription_webhooks", { message: `[SubWebhook] Handler error: ${err.message}`, error: err.stack });
      });
    } catch (err: any) {
      logger.error("subscriptions.subscription_webhooks", { message: `[SubWebhook] Error: ${err.message}` });
      res.status(500).json({ error: "Internal error" });
    }
  }

  /*
  // Disabled: shellz-club-app is now the canonical membership webhook listener

  // subscription_contracts/create
  app.post("/api/webhooks/subscription-contracts/create", requireAuth, (req, res) => {
    processWebhook(req, res, handleContractCreated);
  });

  // subscription_contracts/update
  app.post("/api/webhooks/subscription-contracts/update", requireAuth, (req, res) => {
    processWebhook(req, res, handleContractUpdated);
  });

  // subscription_billing_attempts/success
  app.post("/api/webhooks/subscription-billing/success", requireAuth, (req, res) => {
    processWebhook(req, res, handleBillingSuccess);
  });

  // subscription_billing_attempts/failure
  app.post("/api/webhooks/subscription-billing/failure", requireAuth, (req, res) => {
    processWebhook(req, res, handleBillingFailure);
  });
  */

  logger.info("subscriptions.subscription_webhooks", { message: "[SubWebhook] Subscription webhook listener disabled in Echelon (owned by shellz-club-app)" });
}
