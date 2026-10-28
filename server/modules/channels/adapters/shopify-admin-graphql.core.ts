/**
 * One Shopify Admin GraphQL request against one store's own connection (channels PR2, PLAN-CH2 v4.1 §6.1, SAF-14).
 * Shared by the fulfillment client (shopify-fulfillment.client.ts) and the stock-link adapter
 * (shopify-stock-link.adapter.ts), which use the same per-store token (CH/channel-fulfillment-provider-clients.service.ts).
 *
 * What the core guarantees for every caller:
 * - the request goes only to `https://<shop>.myshopify.com/admin/api/<apiVersion>/graphql.json`, never follows a
 *   redirect, and is bounded by its own timeout (plus the caller's signal, when it gives one);
 * - no retry: each call is one HTTP request, and the caller's error class decides what happens next;
 * - no provider body, URL or credential ever reaches an error: a failure is reported to the caller's `errorFactory`
 *   as a small, closed description, and the caller builds its own structured error from it.
 */

/** The parts of a connection a request uses (CH/adapters/shopify-identity.reader.ts ShopifyIdentityConnection). */
export interface ShopifyAdminGraphQLConnection {
  readonly shopDomain: string;
  readonly accessToken: string;
}

export interface ShopifyAdminGraphQLOperation {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
}

/**
 * Why a request failed, without any provider text. `graphql.codes` holds each error's `extensions.code` upper-cased
 * (null for an error without one), or is null when `errors` was not an array.
 */
export type ShopifyAdminGraphQLFailure =
  | { readonly kind: "connection_invalid" }
  | { readonly kind: "transport" }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "response_invalid"; readonly reason: "json" | "envelope" | "data" }
  | { readonly kind: "graphql"; readonly codes: readonly (string | null)[] | null };

/**
 * What arrived with a response, reported once per HTTP response before it is classified. `extensions` is the
 * envelope's raw `extensions` (Shopify's query cost and throttle status), or null when the body was not read or was
 * not a JSON object; the caller validates whatever it uses.
 */
export interface ShopifyAdminGraphQLResponseMeta {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly apiVersion: string | null;
  readonly extensions: unknown;
}

export interface ShopifyAdminGraphQLRequestOptions {
  readonly apiVersion: string;
  readonly timeoutMs: number;
  /** The caller's own bound (for example a tick's time budget); the request stops at whichever comes first. */
  readonly signal?: AbortSignal;
  readonly errorFactory: (failure: ShopifyAdminGraphQLFailure) => Error;
  readonly onResponseMeta?: (meta: ShopifyAdminGraphQLResponseMeta) => void;
}

const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
/** Shopify's dated versions (YYYY-MM). Each caller pins or validates its own value. */
const API_VERSION_PATTERN = /^\d{4}-\d{2}$/;

/** Whether a connection may be sent a request: a myshopify.com host (no scheme, port, path or user), a dated API
 * version and a non-blank token. Checked before any HTTP. */
export function isShopifyAdminGraphQLConnectionValid(connection: ShopifyAdminGraphQLConnection, apiVersion: string): boolean {
  return SHOP_DOMAIN_PATTERN.test(connection.shopDomain) && API_VERSION_PATTERN.test(apiVersion)
    && connection.accessToken.trim().length > 0;
}

/**
 * Sends one GraphQL operation and returns the envelope's `data` object. Every failure is thrown as
 * `options.errorFactory(failure)`; nothing else is thrown.
 */
export async function requestShopifyAdminGraphQL(
  connection: ShopifyAdminGraphQLConnection,
  operation: ShopifyAdminGraphQLOperation,
  options: ShopifyAdminGraphQLRequestOptions,
  request: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const { shopDomain, accessToken } = connection;
  if (!isShopifyAdminGraphQLConnectionValid(connection, options.apiVersion)) {
    throw options.errorFactory({ kind: "connection_invalid" });
  }
  const url = `https://${shopDomain}/admin/api/${options.apiVersion}/graphql.json`;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await request(url, {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query: operation.query, variables: operation.variables }),
    });
  } catch {
    // Deliberately dropped: a fetch error can carry the URL, a redirect target or the token in its text.
    throw options.errorFactory({ kind: "transport" });
  }
  const meta = (extensions: unknown): ShopifyAdminGraphQLResponseMeta => ({
    status: response.status, retryAfter: response.headers.get("Retry-After"),
    apiVersion: response.headers.get("X-Shopify-API-Version"), extensions,
  });
  if (!response.ok) {
    // The body of a refused request is never read: it is provider text, and the status alone decides.
    options.onResponseMeta?.(meta(null));
    throw options.errorFactory({ kind: "http", status: response.status });
  }
  let payload: unknown;
  try { payload = await response.json(); } catch {
    // Deliberately dropped: the parser's message quotes the provider body.
    options.onResponseMeta?.(meta(null));
    throw options.errorFactory({ kind: "response_invalid", reason: "json" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    options.onResponseMeta?.(meta(null));
    throw options.errorFactory({ kind: "response_invalid", reason: "envelope" });
  }
  const result = payload as { data?: unknown; errors?: unknown; extensions?: unknown };
  options.onResponseMeta?.(meta(result.extensions ?? null));
  if (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length > 0)) {
    // Partial data beside errors is never returned. Only each error's code is kept, never its message.
    throw options.errorFactory({ kind: "graphql",
      codes: Array.isArray(result.errors) ? result.errors.map(graphqlErrorCode) : null });
  }
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    throw options.errorFactory({ kind: "response_invalid", reason: "data" });
  }
  return result.data as Record<string, unknown>;
}

function graphqlErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("extensions" in error)) return null;
  const extensions = error.extensions;
  return !!extensions && typeof extensions === "object" && "code" in extensions && typeof extensions.code === "string"
    ? extensions.code.toUpperCase() : null;
}
