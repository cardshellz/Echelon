import { sha256Canonical } from "../../../domain/canonical-hash";
import { MarketplaceListingRegistrationError } from "../../../domain/registration-errors";
import type { ListingOwnerRef } from "../../../domain/listing-replacement-plan";
import { MARKETPLACE_PROVIDER_IDENTITY_SCHEME } from "../../../domain/listing-registration-plan";

const EBAY_PROVIDER = "ebay" as const;

export const EBAY_REGISTRATION_ENVIRONMENTS = [
  "sandbox",
  "production",
] as const;
export type EbayRegistrationEnvironment =
  (typeof EBAY_REGISTRATION_ENVIRONMENTS)[number];

export const EBAY_REGISTRATION_IDENTITY_ROLES = [
  "inventory_item_group",
  "listing",
  "offer",
  "inventory_item",
] as const;
export type EbayRegistrationIdentityRole =
  (typeof EBAY_REGISTRATION_IDENTITY_ROLES)[number];

const EBAY_INVENTORY_API_ORIGINS: Readonly<
  Record<EbayRegistrationEnvironment, string>
> = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
};

const EBAY_IDENTITY_API_ORIGINS: Readonly<
  Record<EbayRegistrationEnvironment, string>
> = {
  sandbox: "https://apiz.sandbox.ebay.com",
  production: "https://apiz.ebay.com",
};

const EBAY_REGISTRATION_READ_PATH_PREFIXES = [
  "/commerce/identity/v1/",
  "/sell/inventory/v1/",
] as const;
export const EBAY_REGISTRATION_READ_TIMEOUT_MS = 30_000;
export const EBAY_REGISTRATION_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;


export interface EbayRegistrationReadCredential {
  readonly accessToken: string;
  readonly environment: EbayRegistrationEnvironment;
}

/**
 * Owner-specific adapters may refresh credentials, but the provider observer
 * receives no catalog, listing, offer, or inventory write capability.
 */
export interface EbayRegistrationCredentialProvider {
  loadFreshCredential(
    owner: ListingOwnerRef,
  ): Promise<EbayRegistrationReadCredential>;
}

export interface EbayRegistrationReadRequest {
  readonly environment: EbayRegistrationEnvironment;
  readonly path: string;
  readonly accessToken: string;
  readonly marketplaceId: string | null;
}

export interface EbayRegistrationReadResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Deliberately GET-only provider boundary for preview and confirmation. */
export interface EbayRegistrationReadTransport {
  get(
    request: EbayRegistrationReadRequest,
  ): Promise<EbayRegistrationReadResponse>;
}
export interface FetchEbayRegistrationReadTransportOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}


/**
 * The only production HTTP transport available to registration. It accepts a
 * relative path, selects one of two hard-coded eBay origins from a closed
 * environment value, and exposes no arbitrary request method.
 */
export class FetchEbayRegistrationReadTransport
  implements EbayRegistrationReadTransport
{
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    options: FetchEbayRegistrationReadTransportOptions = {},
  ) {
    this.timeoutMs = parsePositiveTransportLimit(
      options.timeoutMs ?? EBAY_REGISTRATION_READ_TIMEOUT_MS,
      "timeoutMs",
    );
    this.maxResponseBytes = parsePositiveTransportLimit(
      options.maxResponseBytes ?? EBAY_REGISTRATION_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
  }

  async get(
    request: EbayRegistrationReadRequest,
  ): Promise<EbayRegistrationReadResponse> {
    const url = buildEbayRegistrationReadUrl(
      request.path,
      request.environment,
    );
    const accessToken = normalizeText(
      request.accessToken,
      "accessToken",
      16_384,
    );
    const marketplaceId = request.marketplaceId === null
      ? null
      : parseEbayRegistrationMarketplaceId(request.marketplaceId);

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchFn(url.toString(), {
        method: "GET",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...(marketplaceId === null
            ? {}
            : { "X-EBAY-C-MARKETPLACE-ID": marketplaceId }),
        },
      });
      const responseText = await readBoundedResponseText(
        response,
        this.maxResponseBytes,
        {
          environment: request.environment,
          path: url.pathname,
        },
      );
      let body: unknown = null;
      if (responseText.length > 0) {
        try {
          body = JSON.parse(responseText);
        } catch {
          body = responseText;
        }
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof MarketplaceListingRegistrationError) throw error;
      throw registrationError(
        timedOut
          ? "EBAY_REGISTRATION_PROVIDER_READ_TIMEOUT"
          : "EBAY_REGISTRATION_PROVIDER_READ_UNAVAILABLE",
        timedOut
          ? "The eBay registration read exceeded its timeout."
          : "The eBay registration read failed before a complete response was received.",
        {
          environment: request.environment,
          path: url.pathname,
          ...(timedOut ? { timeoutMs: this.timeoutMs } : {}),
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedResponseText(
  response: Response,
  maxResponseBytes: number,
  context: Readonly<Record<string, unknown>>,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^[0-9]+$/.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxResponseBytes) {
      throw responseTooLarge(maxResponseBytes, context);
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let observedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      observedBytes += value.byteLength;
      if (observedBytes > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge(maxResponseBytes, context);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function responseTooLarge(
  maxResponseBytes: number,
  context: Readonly<Record<string, unknown>>,
): MarketplaceListingRegistrationError {
  return registrationError(
    "EBAY_REGISTRATION_PROVIDER_RESPONSE_TOO_LARGE",
    "The eBay registration response exceeded the configured byte limit.",
    { ...context, maxResponseBytes },
  );
}

function parsePositiveTransportLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw registrationError(
      "EBAY_REGISTRATION_TRANSPORT_CONFIG_INVALID",
      "The eBay registration transport limit must be a positive safe integer.",
      { field },
    );
  }
  return value;
}

export function ebayProviderAccountNamespace(
  environment: EbayRegistrationEnvironment,
): string {
  return assertEbayRegistrationEnvironment(environment);
}

export function buildEbayProviderAccountEvidenceHash(
  environment: EbayRegistrationEnvironment,
  externalAccountId: string,
): string {
  return sha256Canonical({
    provider: EBAY_PROVIDER,
    environment: assertEbayRegistrationEnvironment(environment),
    externalAccountId: normalizeText(
      externalAccountId,
      "externalAccountId",
      255,
    ),
    identityScheme: MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
  });
}

/** Closed canonical namespace for every eBay publication identity role. */
export function buildEbayRegistrationIdentityNamespace(input: {
  readonly environment: EbayRegistrationEnvironment;
  readonly marketplaceId: string;
  readonly role: EbayRegistrationIdentityRole;
}): string {
  const environment = assertEbayRegistrationEnvironment(input.environment);
  const marketplaceId = parseEbayRegistrationMarketplaceId(input.marketplaceId);
  if (!EBAY_REGISTRATION_IDENTITY_ROLES.includes(input.role)) {
    throw registrationError(
      "EBAY_REGISTRATION_IDENTITY_ROLE_INVALID",
      "The eBay identity namespace role is not supported.",
      { role: String(input.role) },
    );
  }
  return `ebay:${environment}:${marketplaceId}:${input.role}`;
}

export function assertEbayRegistrationEnvironment(
  value: unknown,
): EbayRegistrationEnvironment {
  if (value === "sandbox" || value === "production") return value;
  throw registrationError(
    "EBAY_REGISTRATION_ENVIRONMENT_INVALID",
    "The eBay registration environment must be sandbox or production.",
    { environment: typeof value === "string" ? value : null },
  );
}

function buildEbayRegistrationReadUrl(
  value: unknown,
  environmentValue: unknown,
): URL {
  const environment = assertEbayRegistrationEnvironment(environmentValue);
  if (typeof value !== "string") {
    throw registrationError(
      "EBAY_REGISTRATION_READ_PATH_INVALID",
      "The eBay registration read path must be text.",
    );
  }
  const path = value.trim();
  if (
    path !== value
    || path.length === 0
    || path.length > 2_000
    || !path.startsWith("/")
    || path.startsWith("//")
    || path.includes("\\")
    || path.includes("#")
  ) {
    throw registrationError(
      "EBAY_REGISTRATION_READ_PATH_INVALID",
      "The eBay registration read path is invalid.",
      { path: safePathForContext(path) },
    );
  }

  const allowedOrigin = path.startsWith("/commerce/identity/v1/")
    ? EBAY_IDENTITY_API_ORIGINS[environment]
    : EBAY_INVENTORY_API_ORIGINS[environment];
  let url: URL;
  try {
    url = new URL(path, allowedOrigin);
  } catch {
    throw registrationError(
      "EBAY_REGISTRATION_READ_PATH_INVALID",
      "The eBay registration read path is invalid.",
      { path: safePathForContext(path) },
    );
  }
  const pathAllowed = EBAY_REGISTRATION_READ_PATH_PREFIXES.some((prefix) =>
    url.pathname.startsWith(prefix)
  );
  if (
    url.protocol !== "https:"
    || url.origin !== allowedOrigin
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || !pathAllowed
  ) {
    throw registrationError(
      "EBAY_REGISTRATION_READ_PATH_FORBIDDEN",
      "The registration transport only permits approved eBay read endpoints.",
      {
        environment,
        origin: url.origin,
        path: safePathForContext(url.pathname),
      },
    );
  }
  return url;
}

export function parseEbayRegistrationMarketplaceId(
  value: unknown,
): string {
  const marketplaceId = normalizeText(value, "marketplaceId", 100);
  if (!/^[A-Za-z0-9_-]+$/.test(marketplaceId)) {
    throw registrationError(
      "EBAY_REGISTRATION_MARKETPLACE_INVALID",
      "The eBay marketplace ID contains unsupported characters.",
      { marketplaceId },
    );
  }
  return marketplaceId;
}

function normalizeText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw registrationError(
      "EBAY_REGISTRATION_TEXT_INVALID",
      "An eBay registration value must be text.",
      { field },
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw registrationError(
      "EBAY_REGISTRATION_TEXT_INVALID",
      "An eBay registration value is empty or too long.",
      { field, maxLength },
    );
  }
  return normalized;
}

function safePathForContext(value: string): string | null {
  const path = value.split("?", 1)[0];
  return path.length > 0 ? path.slice(0, 500) : null;
}

function registrationError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(code, message, context);
}
