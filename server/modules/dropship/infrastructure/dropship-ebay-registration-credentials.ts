import { DropshipError } from "../domain/errors";
import { isEbayTokenRefreshAuthFailureStatus } from "./dropship-ebay-auth-failure";
import {
  createDropshipMarketplaceCredentialRepositoryFromEnv,
  type DropshipMarketplaceCredentialRepository,
  type DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";

const EBAY_REFRESH_BUFFER_MS = 5 * 60 * 1_000;
const EBAY_TOKEN_URLS = {
  sandbox: "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
  production: "https://api.ebay.com/identity/v1/oauth2/token",
} as const;
const EBAY_SELLING_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.stores",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
].join(" ");

interface EbayRefreshTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
}

interface Clock {
  now(): Date;
}

export interface DropshipEbayRegistrationCredentialProvider {
  /**
   * May maintain OAuth credentials, but exposes no listing, catalog, offer, or
   * inventory mutation method.
   */
  loadFreshForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipMarketplaceStoreCredentials>;
}

export class RefreshingDropshipEbayRegistrationCredentialProvider
  implements DropshipEbayRegistrationCredentialProvider
{
  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly oauthClient: {
      clientId: string | null;
      clientSecret: string | null;
    },
    private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  static fromEnv(
    credentials: DropshipMarketplaceCredentialRepository,
  ): RefreshingDropshipEbayRegistrationCredentialProvider {
    return new RefreshingDropshipEbayRegistrationCredentialProvider(
      credentials,
      {
        clientId: configuredEnv("DROPSHIP_EBAY_CLIENT_ID")
          ?? configuredEnv("EBAY_CLIENT_ID"),
        clientSecret: configuredEnv("DROPSHIP_EBAY_CLIENT_SECRET")
          ?? configuredEnv("EBAY_CLIENT_SECRET"),
      },
    );
  }

  async loadFreshForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipMarketplaceStoreCredentials> {
    const credential = await this.credentials.loadForStoreConnection({
      ...input,
      platform: "ebay",
    });
    const environment = resolveDropshipEbayProviderEnvironment(credential);
    const now = this.clock.now();
    assertValidDate(now);
    if (
      credential.accessTokenExpiresAt
      && credential.accessTokenExpiresAt.getTime() - now.getTime()
        > EBAY_REFRESH_BUFFER_MS
    ) {
      return credential;
    }
    if (!credential.refreshToken) {
      await this.recordAuthFailure(credential, {
        failureCode: "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED",
        message: "eBay refresh token is missing for marketplace registration observation.",
        statusCode: undefined,
        now,
      });
      throw new DropshipError(
        "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED",
        "eBay refresh token is required for marketplace registration observation.",
        { storeConnectionId: credential.storeConnectionId, retryable: false },
      );
    }
    const clientId = normalizedSecret(this.oauthClient.clientId);
    const clientSecret = normalizedSecret(this.oauthClient.clientSecret);
    if (!clientId || !clientSecret) {
      throw new DropshipError(
        "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED",
        "eBay OAuth client credentials are missing.",
        { retryable: false },
      );
    }

    let response: Response;
    try {
      response = await this.fetchFn(EBAY_TOKEN_URLS[environment], {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          scope: EBAY_SELLING_SCOPES,
        }).toString(),
      });
    } catch (error) {
      throw new DropshipError(
        "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
        "eBay token refresh failed before a response was received.",
        { retryable: true, errorName: error instanceof Error ? error.name : "UnknownError" },
      );
    }
    const text = await response.text();
    if (!response.ok) {
      if (isEbayTokenRefreshAuthFailureStatus(response.status)) {
        await this.recordAuthFailure(credential, {
          failureCode: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
          message: `eBay token refresh failed with HTTP ${response.status}.`,
          statusCode: response.status,
          now,
        });
      }
      throw new DropshipError(
        "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
        `eBay token refresh failed with HTTP ${response.status}.`,
        {
          retryable: response.status >= 500 || response.status === 429,
          status: response.status,
          body: text.slice(0, 1_000),
        },
      );
    }
    const token = parseTokenResponse(text);
    return this.credentials.replaceTokens({
      vendorId: credential.vendorId,
      storeConnectionId: credential.storeConnectionId,
      platform: "ebay",
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessTokenExpiresAt: new Date(
        now.getTime() + token.expiresInSeconds * 1_000,
      ),
      now,
    });
  }

  private async recordAuthFailure(
    credential: DropshipMarketplaceStoreCredentials,
    input: {
      failureCode: string;
      message: string;
      statusCode: number | undefined;
      now: Date;
    },
  ): Promise<void> {
    if (!this.credentials.recordAuthFailure) return;
    await this.credentials.recordAuthFailure({
      vendorId: credential.vendorId,
      storeConnectionId: credential.storeConnectionId,
      platform: "ebay",
      status: "needs_reauth",
      failureCode: input.failureCode,
      message: input.message,
      retryable: false,
      statusCode: input.statusCode,
      now: input.now,
    });
  }
}

export function createDropshipEbayRegistrationCredentialProviderFromEnv(): DropshipEbayRegistrationCredentialProvider {
  return RefreshingDropshipEbayRegistrationCredentialProvider.fromEnv(
    createDropshipMarketplaceCredentialRepositoryFromEnv(),
  );
}

export function resolveDropshipEbayProviderEnvironment(
  credential: DropshipMarketplaceStoreCredentials,
): "sandbox" | "production" {
  const persisted = normalizedSecret(credential.providerEnvironment);
  const metadata = isRecord(credential.config.tokenMetadata)
    ? credential.config.tokenMetadata
    : {};
  const legacy = normalizedSecret(metadata.environment);
  const environment = (persisted ?? legacy)?.toLowerCase();
  if (environment === "sandbox" || environment === "production") {
    return environment;
  }
  throw new DropshipError(
    "DROPSHIP_MARKETPLACE_REGISTRATION_ENVIRONMENT_REQUIRED",
    "The eBay provider environment is missing or invalid on the store connection.",
    { storeConnectionId: credential.storeConnectionId, retryable: false },
  );
}

function parseTokenResponse(text: string): {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
} {
  let raw: EbayRefreshTokenResponse;
  try {
    raw = JSON.parse(text) as EbayRefreshTokenResponse;
  } catch {
    throw new DropshipError(
      "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE",
      "eBay token refresh returned invalid JSON.",
      { retryable: true },
    );
  }
  const accessToken = normalizedSecret(raw.access_token);
  const expiresInSeconds = raw.expires_in;
  if (
    !accessToken
    || typeof expiresInSeconds !== "number"
    || !Number.isSafeInteger(expiresInSeconds)
    || expiresInSeconds <= 0
  ) {
    throw new DropshipError(
      "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID",
      "eBay token refresh response was invalid.",
      { retryable: true },
    );
  }
  return {
    accessToken,
    refreshToken: normalizedSecret(raw.refresh_token),
    expiresInSeconds,
  };
}

function configuredEnv(name: string): string | null {
  return normalizedSecret(process.env[name]);
}

function normalizedSecret(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DropshipError(
      "DROPSHIP_MARKETPLACE_REGISTRATION_CLOCK_INVALID",
      "The registration credential clock returned an invalid timestamp.",
    );
  }
}
