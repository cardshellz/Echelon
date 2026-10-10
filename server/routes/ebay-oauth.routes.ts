import { requireAuth, requirePermission } from "./middleware";
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
import { EbayAuthService, createEbayAuthConfig, type EbayAuthConfig } from "../modules/channels/adapters/ebay/ebay-auth.service";
import { createDropshipStoreConnectionServiceFromEnv } from "../modules/dropship/infrastructure/dropship-store-connection.factory";
import { DropshipError } from "../modules/dropship/domain/errors";
import { parseDropshipOAuthCallbackQuery } from "../modules/dropship/interfaces/http/dropship-store-connection.routes";
import { buildDropshipPortalOAuthRedirect } from "../modules/dropship/interfaces/http/dropship-oauth-redirect";

import { randomBytes } from "node:crypto";
import { channelMethods } from "../modules/channels";
import { createEbayOAuthAuthorization, verifyEbayOAuthAuthorization, resolveEbayOAuthChannel, type EbayOAuthAuthorization } from "../modules/channels/ebay-oauth-authorization";
import { safeListingDiagnostic } from "@shared/ebay-listing-issue";

declare module "express-session" {
  interface SessionData { ebayOAuthAuthorization?: EbayOAuthAuthorization; }
}
const DROPSHIP_PORTAL_URL = process.env.DROPSHIP_PORTAL_URL || "https://cardshellz.io";

function getEbayAuthConfig(): EbayAuthConfig | null {
  try { return createEbayAuthConfig(); } catch { return null; }
}

function saveOAuthSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

function sendOAuthPage(res: Response, status: number, title: string, message: string): void {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  res.status(status).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head><body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:20px"><h1>${escape(title)}</h1><p>${escape(message)}</p><p><a href="/channels/ebay#connection">Return to eBay Connection settings</a></p></body></html>`);
}
export function registerEbayOAuthRoutes(app: Express): void {
  // -----------------------------------------------------------------------
  // GET /api/ebay/oauth/consent — Redirect to eBay consent page
  // -----------------------------------------------------------------------
  app.get("/api/ebay/oauth/consent", requireAuth, requirePermission("channels", "edit"), async (req: Request, res: Response) => {
    const config = getEbayAuthConfig();
    if (!config) { sendOAuthPage(res, 503, "eBay connection is not configured", "An administrator must configure the eBay application credentials before you can connect. Return to Connection settings after configuration."); return; }
    try {
      const channelInput = singleQueryParam(req.query.channelId);
      if (req.query.channelId !== undefined && (!channelInput || !/^[1-9][0-9]*$/.test(channelInput))) throw new Error("Select a valid eBay channel before connecting.");
      const channelId = await resolveEbayOAuthChannel(channelMethods, channelInput === undefined ? undefined : Number(channelInput));
      const challenge = createEbayOAuthAuthorization({ nonce: randomBytes(32).toString("hex"), actorId: String(req.session.user!.id), channelId, environment: config.environment, now: Date.now() });
      req.session.ebayOAuthAuthorization = challenge.authorization;
      // Persist before redirect so another web process can validate the callback.
      await saveOAuthSession(req);
      res.redirect(new EbayAuthService(db as any, config).getConsentUrl(challenge.state));
    } catch (error) {
      console.error(JSON.stringify({ event: "ebay_oauth_consent_failed", actorId: String(req.session.user!.id) }));
      sendOAuthPage(res, 400, "eBay connection could not start", safeListingDiagnostic(error instanceof Error ? error.message : undefined) ?? "Return to Connection settings and start the connection again.");
    }
  });

  // Dropship owns its signed state and account binding; it has no Echelon operator session.
  app.get("/api/ebay/oauth/callback", async (req: Request, res: Response, next) => {
    if (isLikelyDropshipOAuthState(req.query.state)) { await handleDropshipEbayOAuthCallback(req, res); return; }
    next();
  }, requireAuth, requirePermission("channels", "edit"), async (req: Request, res: Response) => {
    const config = getEbayAuthConfig();
    if (!config) { sendOAuthPage(res, 503, "eBay connection is not configured", "Ask an administrator to restore the eBay application credentials, then reconnect from Connection settings."); return; }
    try {
      const authorization = verifyEbayOAuthAuthorization({ state: req.query.state, authorization: req.session.ebayOAuthAuthorization, actorId: String(req.session.user!.id), environment: config.environment, now: Date.now() });
      // Consume this challenge before any token exchange. A sequential callback replay
      // cannot reuse the session's prior permission to connect a channel.
      delete req.session.ebayOAuthAuthorization;
      await saveOAuthSession(req);
      const channelId = await resolveEbayOAuthChannel(channelMethods, authorization.channelId);
      if (singleQueryParam(req.query.error)) {
        sendOAuthPage(res, 400, "eBay authorization was not completed", "eBay did not grant authorization. Return to Connection settings, choose Reconnect, and approve the requested access for the intended eBay account."); return;
      }
      const code = singleQueryParam(req.query.code);
      if (!code?.trim() || code.length > 10_000) { sendOAuthPage(res, 400, "eBay authorization code is missing", "Start a new connection from eBay Connection settings. This callback cannot be retried without a new authorization."); return; }
      await new EbayAuthService(db as any, config).exchangeAuthorizationCode(channelId, code);
      console.info(JSON.stringify({ event: "ebay_oauth_connected", channelId, actorId: String(req.session.user!.id), environment: config.environment }));
      sendOAuthPage(res, 200, "eBay connected", "Return to eBay Connection settings and choose Refresh connection. Existing listing updates can then be retried.");
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : "EBAY_OAUTH_CONNECTION_FAILED";
      console.error(JSON.stringify({ event: "ebay_oauth_connection_failed", code, actorId: String(req.session.user!.id) }));
      const message = safeListingDiagnostic(error instanceof Error ? error.message : undefined) ?? "Return to eBay Connection settings and reconnect. If the problem continues, give the connection error code to an administrator.";
      sendOAuthPage(res, 400, "eBay connection needs attention", `${message} Error code: ${code}.`);
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
  app.get("/api/ebay/oauth/status", requireAuth, requirePermission("channels", "view"), async (req: Request, res: Response) => {
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
    } catch {
      console.error(JSON.stringify({ event: "ebay_oauth_status_failed", actorId: String(req.session.user!.id), environment: config.environment }));
      res.status(503).json({ configured: true, code: "EBAY_AUTH_STATUS_UNAVAILABLE", error: "The saved connection status could not be loaded. Refresh Connection settings; if it still fails, give this error code to an administrator." });
    }
  });
}

async function handleDropshipEbayOAuthCallback(req: Request, res: Response): Promise<void> {
  let returnTo: string | null = null;
  try {
    const input = parseDropshipOAuthCallbackQuery(req.query);
    const service = createDropshipStoreConnectionServiceFromEnv();
    returnTo = service.resolveOAuthCallbackReturnTo(input.state);
    const result = await service.completeOAuthCallback({
      ...input,
      platform: "ebay",
    });
    res.redirect(buildDropshipPortalOAuthRedirect({
      portalUrl: DROPSHIP_PORTAL_URL,
      status: "connected",
      returnTo: result.returnTo,
    }));
  } catch (error) {
    const code = error instanceof DropshipError ? error.code : "DROPSHIP_STORE_CONNECTION_INTERNAL_ERROR";
    res.redirect(buildDropshipPortalOAuthRedirect({
      portalUrl: DROPSHIP_PORTAL_URL,
      status: "error",
      returnTo,
      errorCode: code,
    }));
  }
}

export function isLikelyDropshipOAuthState(value: unknown): value is string {
  if (typeof value !== "string" || !value.includes(".")) {
    return false;
  }

  const [encodedPayload, signature, extra] = value.split(".");
  if (!encodedPayload || !signature || extra !== undefined) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
      version?: unknown;
      memberId?: unknown;
      vendorId?: unknown;
      platform?: unknown;
    };
    return payload.version === 1
      && typeof payload.memberId === "string"
      && typeof payload.vendorId === "number"
      && payload.platform === "ebay";
  } catch {
    return false;
  }
}

function singleQueryParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
