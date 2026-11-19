import type { Express, Request, Response, RequestHandler } from "express";
import { requireAuth } from "./middleware";
import { getShopifyStaffOAuthService, ShopifyStaffOAuthError, type ShopifyStaffOAuthService } from "../modules/channels/shopify-staff-oauth";

const secureResponse: RequestHandler = (req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" });
  // Express routes GET handlers for HEAD too; HEAD must not issue/consume state.
  if (req.method !== "GET") return void res.status(405).set("Allow", "GET").end();
  next();
};

function identity(req: Request) {
  return { actorId: req.session.user!.id, sessionId: req.sessionID };
}
function sendFailure(res: Response, error: unknown) {
  const safe = error instanceof ShopifyStaffOAuthError && /^SHOPIFY_OAUTH_[A-Z0-9_]{1,75}$/.test(error.code)
    ? error : new ShopifyStaffOAuthError("SHOPIFY_OAUTH_UNAVAILABLE", 503, "exchange_unknown");
  const message = safe.outcome === "exchange_unknown"
    ? "The Shopify authorization outcome is uncertain. Do not retry this callback. Review the authorization attempt before starting a new connection."
    : "Shopify authorization could not be completed. Check your access and connection configuration, then start a new authorization.";
  // Never echo query fields, provider bodies, exception messages or causes.
  return res.status(safe.httpStatus).type("text/plain").send(`${message}\n${safe.code}${safe.operationId ? `\nReference: ${safe.operationId}` : ""}`);
}

/** Existing staff URLs are retained. Current permission is enforced by the
 * Channels command in its transactions, not inferred from the session/UI. */
export function registerShopifyOAuthRoutes(app: Express,
  resolve: () => Promise<ShopifyStaffOAuthService> = getShopifyStaffOAuthService) {
  app.get("/api/shopify/oauth/install", secureResponse, requireAuth, async (req, res) => {
    try {
      const query = req.originalUrl.split("?").slice(1).join("?");
      const params = new URLSearchParams(query);
      const values = params.getAll("channelId");
      if (values.length > 1 || (values.length === 1 && !/^[1-9][0-9]*$/.test(values[0]))) {
        throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CHANNEL_INVALID");
      }
      if (values.length && !Number.isSafeInteger(Number(values[0]))) {
        throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CHANNEL_INVALID");
      }
      const result = await (await resolve()).begin({ ...identity(req),
        ...(values.length ? { channelId: Number(values[0]) } : {}) });
      return res.redirect(result.authorizationUrl);
    } catch (error) { return sendFailure(res, error); }
  });
  app.get("/api/shopify/oauth/callback", secureResponse, requireAuth, async (req, res) => {
    try {
      // Use the untouched query. Express's parser may collapse repeated keys or
      // produce objects; neither is a valid signed Shopify scalar contract.
      const separator = req.originalUrl.indexOf("?");
      const rawQuery = separator < 0 ? "" : req.originalUrl.slice(separator + 1);
      const result = await (await resolve()).callback({ ...identity(req), rawQuery });
      if (result.status === "connected") {
        return res.status(200).type("text/plain").send("Shopify authorization completed. The bound connection was updated. You can close this tab.");
      }
      const messages = {
        in_progress: "This authorization is already in progress. Do not repeat the exchange. If it remains pending, review the recorded attempt.",
        exchange_unknown: "The provider outcome is uncertain. Review the recorded attempt before starting a new authorization.",
        failed: "This authorization failed. Start a new authorization after reviewing the recorded failure.",
        superseded: "A newer authorization replaced this attempt. Continue with the newer authorization.",
      };
      return res.status(result.status === "failed" ? 400 : 409).type("text/plain")
        .send(`${messages[result.status]}\nReference: ${result.operationId}`);
    } catch (error) { return sendFailure(res, error); }
  });
}
