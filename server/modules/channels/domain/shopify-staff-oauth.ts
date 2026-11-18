import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ShopifyStaffOAuthError, type ShopifyStaffOAuthConfig } from "../shopify-staff-oauth.types";

export const AUTHORIZATION_WINDOW_MS = 10 * 60 * 1000;
const MAX_FUTURE_TIMESTAMP_MS = 120 * 1000;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_QUERY_FIELDS = 32;
const MAX_KEY_LENGTH = 128;
const MAX_VALUE_LENGTH = 2048;
const MAX_CODE_LENGTH = 512;

const DEFAULT_REDIRECT_URI = "https://cardshellz-echelon-f21ea7da3008.herokuapp.com/api/shopify/oauth/callback";
const SCOPES = Object.freeze([
  "read_products", "write_products",
  "read_inventory", "write_inventory",
  "read_orders", "write_orders",
  "read_fulfillments", "write_fulfillments",
  "read_shipping", "read_locations",
]);
const SHOP_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const SHOP_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Only a Shopify-owned DNS host may become a token-exchange destination. */
export function normalizeShopifyShop(value: unknown, allowBare = false): string {
  if (typeof value !== "string" || /[^\x21-\x7e]/.test(value)) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_SHOP_INVALID");
  }
  if (SHOP_DOMAIN.test(value)) return value.toLowerCase();
  if (allowBare && SHOP_LABEL.test(value)) return `${value.toLowerCase()}.myshopify.com`;
  throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_SHOP_INVALID");
}

export function hashShopifyOAuthValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Configuration identity binds an authorization challenge to its exact credentials. */
export function parseShopifyStaffOAuthConfig(env: Record<string, string | undefined>): ShopifyStaffOAuthConfig {
  const clientId = env.SHOPIFY_API_KEY;
  const clientSecret = env.SHOPIFY_API_SECRET;
  const redirectUri = env.SHOPIFY_OAUTH_REDIRECT_URI || DEFAULT_REDIRECT_URI;
  if (!clientId || !clientSecret || clientId.length > 512 || clientSecret.length > 2048
    || /[^\x21-\x7e]/.test(clientId) || /[^\x21-\x7e]/.test(clientSecret)) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CONFIG_INVALID", 503);
  }
  let shopDomain: string;
  try {
    shopDomain = normalizeShopifyShop(env.SHOPIFY_SHOP_DOMAIN || "card-shellz", true);
    if (redirectUri.length > 2048 || !/^https:\/\//i.test(redirectUri)
      || /[\s\\\u0000-\u001f\u007f]/.test(redirectUri)) throw new Error();
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== "https:" || !redirect.hostname || redirect.username || redirect.password || redirect.hash) {
      throw new Error();
    }
  } catch {
    // Never attach the rejected URI, credentials or parser error as a cause.
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CONFIG_INVALID", 503);
  }
  const fingerprint = hashShopifyOAuthValue(JSON.stringify([
    "shopify-staff-oauth-v1", shopDomain, clientId, clientSecret, redirectUri, SCOPES,
  ]));
  return Object.freeze({ shopDomain, clientId, clientSecret, redirectUri, scopes: SCOPES, fingerprint });
}

function readCallbackFields(rawQuery: string): Map<string, string> {
  if (typeof rawQuery !== "string" || rawQuery.length > MAX_QUERY_BYTES
    || Buffer.byteLength(rawQuery, "utf8") > MAX_QUERY_BYTES || CONTROL_CHARACTERS.test(rawQuery)) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CALLBACK_INVALID");
  }
  const query = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  const rawFields = query.split("&");
  if (!query || rawFields.length > MAX_QUERY_FIELDS || rawFields.some(field => !field || !field.includes("="))) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CALLBACK_INVALID");
  }
  try {
    // URLSearchParams otherwise tolerates invalid escapes/UTF-8 by replacing them.
    // This is validation only; the decoded callback below is never decoded again.
    decodeURIComponent(query.replace(/\+/g, " "));
  } catch {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CALLBACK_INVALID");
  }
  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(query)) {
    if (!key || key.length > MAX_KEY_LENGTH || value.length > MAX_VALUE_LENGTH
      || CONTROL_CHARACTERS.test(key) || CONTROL_CHARACTERS.test(value) || fields.has(key)) {
      throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CALLBACK_INVALID");
    }
    fields.set(key, value);
  }
  return fields;
}

/**
 * Verify the original, once-decoded query before normalizing shop identity.
 * Every signed scalar extension is included; only hmac itself is excluded.
 * Challenge/session claiming and single-use enforcement belong to the command.
 */
export function parseAndVerifyShopifyStaffOAuthCallback(
  rawQuery: string,
  config: ShopifyStaffOAuthConfig,
  now: Date,
): { code: string; shopDomain: string; state: string; stateHash: string } {
  const fields = readCallbackFields(rawQuery);
  const code = fields.get("code");
  const shop = fields.get("shop");
  const state = fields.get("state");
  const hmac = fields.get("hmac");
  const timestamp = fields.get("timestamp");
  if (!code || !code.trim() || code.length > MAX_CODE_LENGTH || !shop || !state || !hmac || !timestamp) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CALLBACK_INVALID");
  }
  if (!/^[a-f0-9]{64}$/i.test(hmac)) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_HMAC_INVALID");
  const message = [...fields.entries()]
    .filter(([key]) => key !== "hmac")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("&");
  const expected = createHmac("sha256", config.clientSecret).update(message, "utf8").digest();
  if (!timingSafeEqual(expected, Buffer.from(hmac, "hex"))) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_HMAC_INVALID");
  }
  if (!/^echelon-shopify-[a-f0-9]{64}$/.test(state)) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_STATE_INVALID");
  }
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  const timestampSeconds = /^\d{1,12}$/.test(timestamp) ? Number(timestamp) : Number.NaN;
  const timestampMs = timestampSeconds * 1000;
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(timestampMs) || timestampMs < 0
    || nowMs - timestampMs > AUTHORIZATION_WINDOW_MS || timestampMs - nowMs > MAX_FUTURE_TIMESTAMP_MS) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_TIMESTAMP_INVALID");
  }
  const shopDomain = normalizeShopifyShop(shop);
  if (shopDomain !== config.shopDomain) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_SHOP_MISMATCH");
  return { code, shopDomain, state, stateHash: hashShopifyOAuthValue(state) };
}
