/**
 * eBay OAuth2 Routes
 * 
 * GET  /api/ebay/oauth/consent   — Redirects seller to eBay consent page
 * GET  /api/ebay/oauth/callback  — Handles eBay redirect after consent
 * GET  /api/ebay/oauth/declined  — Handles declined consent
 * GET  /api/ebay/oauth/status    — Check token status for a channel
 */

import type { Express, Request, Response } from "express";
import { db } from "../db";
import { EbayAuthService, type EbayAuthConfig } from "../modules/channels/adapters/ebay/ebay-auth.service";

function getEbayAuthConfig(): EbayAuthConfig | null {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_RUNAME;

  if (!clientId || !clientSecret || !ruName) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    ruName,
    environment: (process.env.EBAY_ENVIRONMENT as "sandbox" | "production") || "production",
  };
}

export function registerEbayOAuthRoutes(app: Express): void {
  // -----------------------------------------------------------------------
  // GET /api/ebay/oauth/consent — Redirect to eBay consent page
  // -----------------------------------------------------------------------
  app.get("/api/ebay/oauth/consent", (_req: Request, res: Response) => {
    const config = getEbayAuthConfig();
    if (!config) {
      res.status(500).json({
        error: "eBay OAuth not configured. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RUNAME.",
      });
      return;
    }

    const authService = new EbayAuthService(db as any, config);
    const consentUrl = authService.getConsentUrl("echelon-ebay-setup");
    res.redirect(consentUrl);
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/oauth/callback — Exchange auth code for tokens
  // -----------------------------------------------------------------------
  app.get("/api/ebay/oauth/callback", async (req: Request, res: Response) => {
    const config = getEbayAuthConfig();
    if (!config) {
      res.status(500).json({ error: "eBay OAuth not configured." });
      return;
    }

    const code = req.query.code as string | undefined;
    const error = req.query.error as string | undefined;

    if (error) {
      console.error(`[eBay OAuth] Error from eBay: ${error}`);
      res.status(400).send(`
        <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1>❌ eBay Authorization Failed</h1>
          <p>eBay returned an error: <code>${error}</code></p>
          <p>Please try again or check your eBay developer settings.</p>
        </body></html>
      `);
      return;
    }

    if (!code) {
      res.status(400).send(`
        <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1>❌ Missing Authorization Code</h1>
          <p>No authorization code received from eBay.</p>
        </body></html>
      `);
      return;
    }

    try {
      const authService = new EbayAuthService(db as any, config);

      // Find or create the eBay channel — use channel_id from query or default
      const channelIdParam = req.query.state === "echelon-ebay-setup" ? undefined : req.query.state;
      
      // Look up the eBay channel in DB
      const { channels } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      let channelId: number;

      if (channelIdParam) {
        channelId = parseInt(channelIdParam as string, 10);
      } else {
        // Find existing eBay channel or inform user to create one
        const [ebayChannel] = await (db as any)
          .select()
          .from(channels)
          .where(eq(channels.provider, "ebay"))
          .limit(1);

        if (!ebayChannel) {
          // Auto-create the eBay channel
          const [newChannel] = await (db as any)
            .insert(channels)
            .values({
              name: "eBay",
              provider: "ebay",
              status: "active",
              priority: 1,
            })
            .returning();
          channelId = newChannel.id;
          console.log(`[eBay OAuth] Auto-created eBay channel with ID ${channelId}`);
        } else {
          channelId = ebayChannel.id;
        }
      }

      // Exchange the authorization code for tokens
      await authService.exchangeAuthorizationCode(channelId, code);

      console.log(`[eBay OAuth] ✅ Successfully authorized for channel ${channelId}`);

      res.status(200).send(`
        <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1>✅ eBay Connected!</h1>
          <p>Echelon is now authorized to manage your eBay listings.</p>
          <p><strong>Channel ID:</strong> ${channelId}</p>
          <p>You can close this window and return to Echelon.</p>
          <p style="margin-top: 30px; color: #666;">
            Access token will auto-refresh. Refresh token valid for 18 months.
          </p>
        </body></html>
      `);
    } catch (err: any) {
      console.error("[eBay OAuth] Token exchange failed:", err.message);
      res.status(500).send(`
        <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1>❌ Token Exchange Failed</h1>
          <p>${err.message}</p>
          <p>Check Heroku logs for details.</p>
        </body></html>
      `);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/oauth/declined — User declined consent
  // -----------------------------------------------------------------------
  app.get("/api/ebay/oauth/declined", (_req: Request, res: Response) => {
    res.status(200).send(`
      <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h1>⚠️ eBay Authorization Declined</h1>
        <p>You declined the authorization request. Echelon cannot manage your eBay listings without permission.</p>
        <p><a href="/api/ebay/oauth/consent">Try again</a></p>
      </body></html>
    `);
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/oauth/status — Check token status
  // -----------------------------------------------------------------------
  app.get("/api/ebay/oauth/status", async (req: Request, res: Response) => {
    const config = getEbayAuthConfig();
    if (!config) {
      res.json({ configured: false, error: "EBAY env vars not set" });
      return;
    }

    try {
      const { ebayOauthTokens } = await import("@shared/schema");
      const tokens = await (db as any).select().from(ebayOauthTokens);
      
      res.json({
        configured: true,
        environment: config.environment,
        tokens: tokens.map((t: any) => ({
          channelId: t.channelId,
          environment: t.environment,
          hasAccessToken: !!t.accessToken,
          accessTokenExpiresAt: t.accessTokenExpiresAt,
          hasRefreshToken: !!t.refreshToken,
          refreshTokenExpiresAt: t.refreshTokenExpiresAt,
          updatedAt: t.updatedAt,
        })),
      });
    } catch (err: any) {
      res.json({ configured: true, error: err.message });
    }
  });
}
