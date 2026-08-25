import { DropshipError } from "../domain/errors";
import type {
  DropshipReturnIntakeDraft,
  DropshipReturnIntakeFetchResult,
  DropshipReturnIntakeProvider,
  DropshipReturnIntakeStoreConnection,
} from "../application/dropship-return-intake-provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";
import {
  buildEbayReturnIntakeDraft,
  shouldRecordEbayReturnCase,
  type EbayReturnCase,
} from "./dropship-ebay-return-intake.mapper";
import {
  isEbayResourceAuthFailureStatus,
  isEbayTokenRefreshAuthFailureStatus,
} from "./dropship-ebay-auth-failure";
import { buildEbayPostOrderAuthorization } from "./dropship-ebay-post-order-auth";

/**
 * eBay return-intake provider (design spec D2a): polls the Post-Order API
 * return search endpoint for one connected eBay store and maps each return
 * case to a normalized draft. Read-only — all persistence lives in the poll
 * service / intake service.
 *
 * Auth mirrors the eBay order-intake provider: user token via refresh-token
 * grant, needs_reauth recorded on 401/403, bounded retry on 429/5xx.
 */

type FetchLike = typeof fetch;
type EbayEnvironment = "sandbox" | "production";

interface Clock {
  now(): Date;
}

interface EbayTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
}

interface EbayReturnSearchResponse {
  returns?: EbayReturnCase[];
  total?: number;
  limit?: number;
  offset?: number;
}

const EBAY_BASE_URLS: Record<EbayEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
};

const EBAY_TOKEN_URLS: Record<EbayEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
  production: "https://api.ebay.com/identity/v1/oauth2/token",
};

const EBAY_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const EBAY_RETURN_INTAKE_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");
const EBAY_MAX_ATTEMPTS = 3;
const EBAY_PAGE_SIZE = 50;

export class EbayDropshipReturnIntakeProvider implements DropshipReturnIntakeProvider {
  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async fetchReturns(input: {
    connection: DropshipReturnIntakeStoreConnection;
    since: Date;
    until: Date;
  }): Promise<DropshipReturnIntakeFetchResult> {
    let credential = await this.credentials.loadForStoreConnection({
      vendorId: input.connection.vendorId,
      storeConnectionId: input.connection.storeConnectionId,
      platform: "ebay",
    });
    const environment = resolveEbayEnvironment(credential.config);
    const marketplaceId = resolveMarketplaceId(credential.config);
    credential = await this.ensureFreshAccessToken(credential, environment);

    const returnCases = await this.fetchAllReturnCases({
      credential,
      environment,
      marketplaceId,
      since: input.since,
      until: input.until,
    });

    const result: DropshipReturnIntakeFetchResult = { drafts: [], ignored: 0 };
    for (const returnCase of returnCases) {
      const decision = shouldRecordEbayReturnCase({ returnCase });
      if (!decision.record) {
        result.ignored += 1;
        continue;
      }
      result.drafts.push(buildEbayReturnIntakeDraft({ returnCase }));
    }
    return result;
  }

  private async fetchAllReturnCases(input: {
    credential: DropshipMarketplaceStoreCredentials;
    environment: EbayEnvironment;
    marketplaceId: string;
    since: Date;
    until: Date;
  }): Promise<EbayReturnCase[]> {
    const returns: EbayReturnCase[] = [];
    let offset = 0;
    while (true) {
      const response = await this.fetchReturnPage({ ...input, offset });
      if (!Array.isArray(response.returns) || response.returns.length === 0) {
        break;
      }
      returns.push(...response.returns);
      offset += response.returns.length;
      if (response.returns.length < EBAY_PAGE_SIZE || offset >= (response.total ?? offset)) {
        break;
      }
    }
    return returns;
  }

  private async fetchReturnPage(input: {
    credential: DropshipMarketplaceStoreCredentials;
    environment: EbayEnvironment;
    marketplaceId: string;
    since: Date;
    until: Date;
    offset: number;
  }): Promise<EbayReturnSearchResponse> {
    const params = new URLSearchParams({
      creation_date_range_from: input.since.toISOString(),
      creation_date_range_to: input.until.toISOString(),
      limit: String(EBAY_PAGE_SIZE),
      offset: String(input.offset),
    });
    return this.requestEbay<EbayReturnSearchResponse>({
      environment: input.environment,
      credential: input.credential,
      marketplaceId: input.marketplaceId,
      path: `/post-order/v2/return/search?${params.toString()}`,
    });
  }

  private async ensureFreshAccessToken(
    credential: DropshipMarketplaceStoreCredentials,
    environment: EbayEnvironment,
  ): Promise<DropshipMarketplaceStoreCredentials> {
    if (
      credential.accessTokenExpiresAt
      && credential.accessTokenExpiresAt.getTime() - this.clock.now().getTime() > EBAY_REFRESH_BUFFER_MS
    ) {
      return credential;
    }
    if (!credential.refreshToken) {
      await this.recordNeedsReauth(credential, {
        failureCode: "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED",
        message: "eBay refresh token is missing for dropship return intake.",
      });
      throw new DropshipError("DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED", "eBay refresh token is required.", {
        storeConnectionId: credential.storeConnectionId,
        retryable: false,
      });
    }
    const clientId = process.env.DROPSHIP_EBAY_CLIENT_ID ?? process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.DROPSHIP_EBAY_CLIENT_SECRET ?? process.env.EBAY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new DropshipError("DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED", "eBay OAuth client credentials are missing.", {
        retryable: false,
      });
    }

    const response = await this.fetchImpl(EBAY_TOKEN_URLS[environment], {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        scope: EBAY_RETURN_INTAKE_SCOPES,
      }).toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      if (isEbayTokenRefreshAuthFailureStatus(response.status)) {
        await this.recordNeedsReauth(credential, {
          failureCode: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
          message: `eBay token refresh failed with HTTP ${response.status}.`,
          statusCode: response.status,
        });
      }
      throw new DropshipError(
        "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
        `eBay token refresh failed with HTTP ${response.status}.`,
        {
          retryable: response.status >= 500 || response.status === 429,
          status: response.status,
          body: text.slice(0, 1000),
        },
      );
    }
    const token = parseEbayJson<EbayTokenResponse>({
      text,
      code: "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE",
      message: "eBay token refresh returned invalid JSON.",
    });
    if (!token.access_token || typeof token.expires_in !== "number" || token.expires_in <= 0) {
      throw new DropshipError("DROPSHIP_EBAY_TOKEN_REFRESH_INVALID", "eBay token refresh response was invalid.", {
        retryable: true,
      });
    }
    const now = this.clock.now();
    return this.credentials.replaceTokens({
      vendorId: credential.vendorId,
      storeConnectionId: credential.storeConnectionId,
      platform: "ebay",
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      accessTokenExpiresAt: new Date(now.getTime() + token.expires_in * 1000),
      now,
    });
  }

  private async requestEbay<T>(input: {
    environment: EbayEnvironment;
    credential: DropshipMarketplaceStoreCredentials;
    marketplaceId: string;
    path: string;
  }): Promise<T> {
    for (let attempt = 1; attempt <= EBAY_MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${EBAY_BASE_URLS[input.environment]}${input.path}`, {
          method: "GET",
          headers: {
            Authorization: buildEbayPostOrderAuthorization(input.credential.accessToken),
            Accept: "application/json",
            "X-EBAY-C-MARKETPLACE-ID": input.marketplaceId,
          },
        });
      } catch (error) {
        if (attempt < EBAY_MAX_ATTEMPTS) {
          await delay(resolveRetryDelayMs(null, attempt));
          continue;
        }
        throw new DropshipError(
          "DROPSHIP_EBAY_RETURN_INTAKE_NETWORK_ERROR",
          "eBay return intake failed before receiving an HTTP response.",
          {
            retryable: true,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }

      const text = await response.text();
      if (response.ok) {
        return parseEbayJson<T>({
          text,
          code: "DROPSHIP_EBAY_RETURN_INTAKE_INVALID_RESPONSE",
          message: "eBay return intake returned invalid JSON.",
        });
      }
      if (isEbayResourceAuthFailureStatus(response.status)) {
        await this.credentials.recordAuthFailure?.({
          vendorId: input.credential.vendorId,
          storeConnectionId: input.credential.storeConnectionId,
          platform: "ebay",
          status: "needs_reauth",
          failureCode: "DROPSHIP_EBAY_RETURN_INTAKE_HTTP_ERROR",
          message: `eBay return intake failed with HTTP ${response.status}.`,
          retryable: false,
          statusCode: response.status,
          now: this.clock.now(),
        });
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < EBAY_MAX_ATTEMPTS) {
        await delay(resolveRetryDelayMs(response, attempt));
        continue;
      }
      throw new DropshipError(
        "DROPSHIP_EBAY_RETURN_INTAKE_HTTP_ERROR",
        `eBay return intake failed with HTTP ${response.status}.`,
        {
          retryable,
          status: response.status,
          body: text.slice(0, 1000),
        },
      );
    }
    throw new DropshipError(
      "DROPSHIP_EBAY_RETURN_INTAKE_RETRY_EXHAUSTED",
      "eBay return intake retry attempts were exhausted.",
      { retryable: true },
    );
  }

  private async recordNeedsReauth(
    credential: DropshipMarketplaceStoreCredentials,
    input: {
      failureCode: string;
      message: string;
      statusCode?: number;
    },
  ): Promise<void> {
    await this.credentials.recordAuthFailure?.({
      vendorId: credential.vendorId,
      storeConnectionId: credential.storeConnectionId,
      platform: "ebay",
      status: "needs_reauth",
      failureCode: input.failureCode,
      message: input.message,
      retryable: false,
      statusCode: input.statusCode,
      now: this.clock.now(),
    });
  }
}

function resolveEbayEnvironment(config: Record<string, unknown>): EbayEnvironment {
  return config.environment === "sandbox" ? "sandbox" : "production";
}

function resolveMarketplaceId(config: Record<string, unknown>): string {
  return typeof config.marketplaceId === "string" && config.marketplaceId.trim()
    ? config.marketplaceId.trim()
    : "EBAY_US";
}

function parseEbayJson<T>(input: { text: string; code: string; message: string }): T {
  try {
    return JSON.parse(input.text) as T;
  } catch {
    throw new DropshipError(input.code, input.message, {
      body: input.text.slice(0, 1000),
      retryable: true,
    });
  }
}

function resolveRetryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
