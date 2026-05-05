import { DropshipError } from "../domain/errors";
import type {
  DropshipMarketplaceTrackingProvider,
  DropshipMarketplaceTrackingRequest,
  DropshipMarketplaceTrackingResult,
} from "../application/dropship-marketplace-tracking-provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";
import { buildEbayShippingFulfillmentPath, extractEbayFulfillmentIdFromLocation, normalizeEbayTrackingNumber } from "../../channels/adapters/ebay/ebay-fulfillment.util";
import { mapCarrierToEbay } from "../../channels/adapters/ebay/ebay-category-map";

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

const EBAY_BASE_URLS: Record<EbayEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
};

const EBAY_TOKEN_URLS: Record<EbayEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
  production: "https://api.ebay.com/identity/v1/oauth2/token",
};

const EBAY_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const EBAY_MAX_ATTEMPTS = 3;
const EBAY_TRACKING_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");

export class EbayDropshipMarketplaceTrackingProvider implements DropshipMarketplaceTrackingProvider {
  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async pushTracking(
    input: DropshipMarketplaceTrackingRequest,
  ): Promise<DropshipMarketplaceTrackingResult> {
    let credential = await this.credentials.loadForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: "ebay",
    });
    const environment = resolveEbayEnvironment(credential.config);
    credential = await this.ensureFreshAccessToken(credential, environment);

    const lineItems = input.lineItems
      .filter((line) => line.externalLineItemId && Number.isInteger(line.quantity) && line.quantity > 0)
      .map((line) => ({
        lineItemId: line.externalLineItemId as string,
        quantity: line.quantity,
      }));
    if (lineItems.length === 0) {
      throw new DropshipError(
        "DROPSHIP_EBAY_TRACKING_LINE_ITEM_IDS_REQUIRED",
        "eBay tracking push requires marketplace line item ids.",
        {
          intakeId: input.intakeId,
          omsOrderId: input.omsOrderId,
          retryable: false,
        },
      );
    }

    const orderId = input.sourceOrderId ?? input.externalOrderId;
    const path = buildEbayShippingFulfillmentPath(orderId);
    const payload = {
      lineItems,
      shippedDate: input.shippedAt.toISOString(),
      shippingCarrierCode: mapCarrierToEbay(input.carrier),
      trackingNumber: normalizeEbayTrackingNumber(input.trackingNumber),
    };
    const response = await this.requestEbay({
      environment,
      credential,
      path,
      body: payload,
    });
    return {
      status: "succeeded",
      externalFulfillmentId: response.fulfillmentId,
      rawResult: {
        provider: "ebay",
        environment,
        externalFulfillmentId: response.fulfillmentId,
        requestPath: path,
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
        message: "eBay refresh token is missing for dropship tracking push.",
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
        scope: EBAY_TRACKING_SCOPES,
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

  private async requestEbay(input: {
    environment: EbayEnvironment;
    credential: DropshipMarketplaceStoreCredentials;
    path: string;
    body: unknown;
  }): Promise<{ fulfillmentId: string | null }> {
    for (let attempt = 1; attempt <= EBAY_MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${EBAY_BASE_URLS[input.environment]}${input.path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.credential.accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Content-Language": "en-US",
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
          },
          body: JSON.stringify(input.body),
        });
      } catch (error) {
        if (attempt < EBAY_MAX_ATTEMPTS) {
          await delay(resolveRetryDelayMs(null, attempt));
          continue;
        }
        throw new DropshipError(
          "DROPSHIP_EBAY_TRACKING_NETWORK_ERROR",
          "eBay tracking push failed before receiving an HTTP response.",
          {
            retryable: true,
            cause: formatUnknownError(error),
          },
        );
      }
      const text = await response.text();
      if (response.ok) {
        return {
          fulfillmentId: extractEbayFulfillmentIdFromLocation(
            response.headers.get("Location") || response.headers.get("location"),
          ),
        };
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (isPermanentAuthFailureStatus(response.status)) {
        await this.credentials.recordAuthFailure?.({
          vendorId: input.credential.vendorId,
          storeConnectionId: input.credential.storeConnectionId,
          platform: "ebay",
          status: "needs_reauth",
          failureCode: "DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
          message: `eBay tracking push failed with HTTP ${response.status}.`,
          retryable: false,
          statusCode: response.status,
          now: this.clock.now(),
        });
      }
      if (retryable && attempt < EBAY_MAX_ATTEMPTS) {
        await delay(resolveRetryDelayMs(response, attempt));
        continue;
      }
      throw new DropshipError(
        "DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
        `eBay tracking push failed with HTTP ${response.status}.`,
        {
          retryable,
          status: response.status,
          body: text.slice(0, 1000),
        },
      );
    }
    throw new DropshipError("DROPSHIP_EBAY_TRACKING_RETRY_EXHAUSTED", "eBay tracking push retry attempts were exhausted.", {
      retryable: true,
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

function resolveEbayEnvironment(config: Record<string, unknown>): EbayEnvironment {
  return config.environment === "sandbox" ? "sandbox" : "production";
}

function isPermanentAuthFailureStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
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

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
