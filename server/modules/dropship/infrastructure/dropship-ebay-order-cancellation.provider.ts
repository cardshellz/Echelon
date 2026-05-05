import { DropshipError } from "../domain/errors";
import type {
  DropshipMarketplaceOrderCancellationProvider,
  DropshipMarketplaceOrderCancellationRequest,
  DropshipMarketplaceOrderCancellationResult,
} from "../application/dropship-marketplace-order-cancellation-provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";

type FetchLike = typeof fetch;
type EbayEnvironment = "sandbox" | "production";

interface Clock {
  now(): Date;
}

interface EbayCancellationConfig {
  environment: EbayEnvironment;
  cancelReason: string;
  buyerPaid: boolean | null;
}

interface EbayTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
}

interface EbayCancellationResponse {
  cancelId?: string;
  cancellationId?: string;
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

const EBAY_ORDER_CANCELLATION_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
].join(" ");

export class EbayDropshipOrderCancellationProvider implements DropshipMarketplaceOrderCancellationProvider {
  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async cancelOrder(
    input: DropshipMarketplaceOrderCancellationRequest,
  ): Promise<DropshipMarketplaceOrderCancellationResult> {
    let credential = await this.credentials.loadForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: "ebay",
    });
    const config = parseEbayCancellationConfig(credential.config);
    credential = await this.ensureFreshAccessToken(credential, config.environment);

    const body = buildEbayCancellationPayload(input, config);
    const cancellation = await this.requestEbay<EbayCancellationResponse>({
      credential,
      config,
      method: "POST",
      path: "/post-order/v2/cancellation",
      body,
    });
    const externalCancellationId = cancellation.cancelId ?? cancellation.cancellationId ?? null;
    return {
      status: "cancelled",
      externalCancellationId,
      rawResult: {
        provider: "ebay",
        environment: config.environment,
        externalCancellationId,
      },
    };
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
        message: "eBay refresh token is missing for dropship order cancellation.",
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
        scope: EBAY_ORDER_CANCELLATION_SCOPES,
      }).toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      if (isPermanentAuthFailureStatus(response.status)) {
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
    credential: DropshipMarketplaceStoreCredentials;
    config: EbayCancellationConfig;
    method: "POST";
    path: string;
    body: unknown;
  }): Promise<T> {
    const response = await this.fetchImpl(`${EBAY_BASE_URLS[input.config.environment]}${input.path}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.credential.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Language": "en-US",
      },
      body: JSON.stringify(input.body),
    });
    const text = await response.text();
    if (!response.ok) {
      if (isPermanentAuthFailureStatus(response.status)) {
        await this.credentials.recordAuthFailure?.({
          vendorId: input.credential.vendorId,
          storeConnectionId: input.credential.storeConnectionId,
          platform: "ebay",
          status: "needs_reauth",
          failureCode: "DROPSHIP_EBAY_ORDER_CANCELLATION_HTTP_ERROR",
          message: `eBay order cancellation failed with HTTP ${response.status}.`,
          retryable: false,
          statusCode: response.status,
          now: this.clock.now(),
        });
      }
      throw new DropshipError(
        "DROPSHIP_EBAY_ORDER_CANCELLATION_HTTP_ERROR",
        `eBay order cancellation failed with HTTP ${response.status}.`,
        {
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
          body: text.slice(0, 1000),
        },
      );
    }
    return parseEbayJson<T>({
      text,
      code: "DROPSHIP_EBAY_ORDER_CANCELLATION_INVALID_RESPONSE",
      message: "eBay order cancellation returned invalid JSON.",
    });
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

function parseEbayCancellationConfig(config: Record<string, unknown>): EbayCancellationConfig {
  const cancellation = recordFromConfig(config, "cancellation");
  return {
    environment: config.environment === "sandbox" ? "sandbox" : "production",
    cancelReason: requiredConfigString(cancellation, "cancelReason"),
    buyerPaid: optionalConfigBoolean(cancellation, "buyerPaid"),
  };
}

function isPermanentAuthFailureStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

function buildEbayCancellationPayload(
  input: DropshipMarketplaceOrderCancellationRequest,
  config: EbayCancellationConfig,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    legacyOrderId: input.sourceOrderId ?? input.externalOrderId,
    cancelReason: config.cancelReason,
  };
  if (config.buyerPaid !== null) {
    payload.buyerPaid = config.buyerPaid;
    if (config.buyerPaid) {
      if (!input.orderedAt) {
        throw new DropshipError(
          "DROPSHIP_EBAY_ORDER_CANCELLATION_PAID_DATE_REQUIRED",
          "eBay paid order cancellation requires an orderedAt timestamp.",
          { intakeId: input.intakeId, retryable: false },
        );
      }
      payload.buyerPaidDate = input.orderedAt;
    }
  }
  return payload;
}

function requiredConfigString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new DropshipError(
      "DROPSHIP_EBAY_ORDER_CANCELLATION_CONFIG_REQUIRED",
      "eBay order cancellation configuration is incomplete.",
      { missingKey: `cancellation.${key}`, retryable: false },
    );
  }
  return value.trim();
}

function optionalConfigBoolean(config: Record<string, unknown>, key: string): boolean | null {
  const value = config[key];
  return typeof value === "boolean" ? value : null;
}

function recordFromConfig(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseEbayJson<T>(input: {
  text: string;
  code: string;
  message: string;
}): T {
  if (!input.text) return {} as T;
  try {
    return JSON.parse(input.text) as T;
  } catch {
    throw new DropshipError(input.code, input.message, { retryable: true });
  }
}
