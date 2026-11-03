import { normalizeShopifyShop } from "../../domain/shopify-staff-oauth";
import {
  ShopifyStaffOAuthError,
  type ShopifyStaffOAuthConfig,
  type ShopifyStaffOAuthToken,
} from "../../shopify-staff-oauth.types";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_SCOPE_LENGTH = 8_192;
const MAX_SCOPES = 256;
const SCOPE = /^[a-z][a-z0-9_]{0,127}$/;

function unknownExchange(): ShopifyStaffOAuthError {
  return new ShopifyStaffOAuthError("SHOPIFY_OAUTH_EXCHANGE_UNKNOWN", 502, "exchange_unknown");
}

function boundedCredential(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && /^[\x21-\x7e]+$/.test(value);
}

function requestedScopes(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_SCOPES
    && value.every(scope => typeof scope === "string" && SCOPE.test(scope));
}

function coversScope(granted: ReadonlySet<string>, required: string): boolean {
  if (granted.has(required)) return true;
  // Shopify write access includes the corresponding read access; it does not
  // imply another resource, or write access from a read-only grant.
  const read = /^(unauthenticated_)?read_(.+)$/.exec(required);
  return read !== null && granted.has(`${read[1] ?? ""}write_${read[2]}`);
}

function parseToken(text: string, requested: readonly string[]): ShopifyStaffOAuthToken {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw unknownExchange();
  const token = value as Record<string, unknown>;
  // This connection currently stores non-expiring offline credentials only.
  // Reject an unsupported lifecycle instead of discarding the refresh/expiry
  // information. Unrelated future metadata is safe to ignore.
  if (["expires_in", "refresh_token", "refresh_token_expires_in", "associated_user", "associated_user_scope"]
    .some(key => Object.prototype.hasOwnProperty.call(token, key))) throw unknownExchange();
  if (!boundedCredential(token.access_token, MAX_TOKEN_LENGTH)
    || typeof token.scope !== "string" || token.scope.length === 0
    || token.scope.length > MAX_SCOPE_LENGTH) throw unknownExchange();
  const scopes = token.scope.split(",");
  if (scopes.length > MAX_SCOPES || scopes.some(scope => !SCOPE.test(scope))) throw unknownExchange();
  const granted = new Set(scopes);
  if (!requested.every(scope => coversScope(granted, scope))) throw unknownExchange();
  return { accessToken: token.access_token, scopes: token.scope };
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body || body.locked) return;
  // Cancellation is cleanup, not an exchange retry or a financial outcome.
  // A broken transport's cancellation must not extend the deadline or leak its error.
  void body.cancel().catch(() => undefined);
}

async function readBoundedBody(response: Response, maximum: number, signal: AbortSignal): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximum) {
    cancelBody(response.body);
    throw unknownExchange();
  }
  if (!response.body) throw unknownExchange();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw unknownExchange();
      const chunk = await reader.read();
      if (signal.aborted) throw unknownExchange();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) throw unknownExchange();
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** The application has already verified callback/state/current authority.
 * Exchange at most once. A timeout or unusable response can follow provider
 * acceptance, so it is uncertain and must never cause an automatic re-exchange.
 */
export async function exchangeShopifyStaffOAuthCode(
  config: ShopifyStaffOAuthConfig,
  code: string,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number } = {},
): Promise<ShopifyStaffOAuthToken> {
  let shop: string;
  try { shop = normalizeShopifyShop(config.shopDomain); }
  catch { throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CONFIG_INVALID"); }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximum = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!boundedCredential(config.clientId, 1_024) || !boundedCredential(config.clientSecret, 4_096)
    || !requestedScopes(config.scopes) || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS || !Number.isSafeInteger(maximum)
    || maximum < 1 || maximum > MAX_RESPONSE_BYTES) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CONFIG_INVALID");
  }
  if (!boundedCredential(code, 10_000)) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CODE_INVALID");

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(unknownExchange());
    }, timeoutMs);
  });
  const exchange = async () => {
    const response = await (options.fetch ?? fetch)(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
      // Preserve the existing non-expiring offline exchange. No expiring flag,
      // online grant, refresh request, or caller-supplied destination is accepted.
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
    });
    if (controller.signal.aborted || response.redirected || !response.ok) {
      cancelBody(response.body);
      if (!controller.signal.aborted && !response.redirected && response.status >= 400
        && response.status < 500 && response.status !== 408 && response.status !== 429) {
        throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_EXCHANGE_REJECTED", 400, "failed");
      }
      throw unknownExchange();
    }
    const body = await readBoundedBody(response, maximum, controller.signal);
    if (controller.signal.aborted) throw unknownExchange();
    return parseToken(body, config.scopes);
  };
  try {
    // Native fetch honors AbortSignal. Racing also bounds a stalled injected
    // transport/body; a late response is cancelled above and never persisted.
    return await Promise.race([exchange(), deadline]);
  } catch (error) {
    controller.abort();
    if (error instanceof ShopifyStaffOAuthError) throw error;
    throw unknownExchange();
  } finally {
    clearTimeout(timer);
  }
}
