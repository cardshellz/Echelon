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
import {
  isEbayResourceAuthFailureStatus,
  recordEbayAccessTokenRejection,
} from "./dropship-ebay-auth-failure";
import { DropshipEbayTokenOwner, resolveDropshipEbayProviderEnvironment } from "./dropship-ebay-token-owner";

type FetchLike = typeof fetch;
type EbayEnvironment = "sandbox" | "production";

interface Clock {
  now(): Date;
}

const EBAY_BASE_URLS: Record<EbayEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
};

const EBAY_MAX_ATTEMPTS = 3;

export class EbayDropshipMarketplaceTrackingProvider implements DropshipMarketplaceTrackingProvider {
  private readonly tokenOwner: DropshipEbayTokenOwner;

  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: Clock = { now: () => new Date() },
  ) {
    this.tokenOwner = new DropshipEbayTokenOwner({
      credentials,
      fetchFn: fetchImpl,
      clock,
    });
  }

  async pushTracking(
    input: DropshipMarketplaceTrackingRequest,
  ): Promise<DropshipMarketplaceTrackingResult> {
    const credential = await this.tokenOwner.loadFreshForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      operation: "tracking",
    });
    const environment = resolveDropshipEbayProviderEnvironment(credential);
    const marketplaceId = resolveMarketplaceId(credential.config);

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
      marketplaceId,
      path,
      body: payload,
    });
    return {
      status: "succeeded",
      externalFulfillmentId: response.fulfillmentId,
      rawResult: {
        provider: "ebay",
        environment,
        marketplaceId,
        externalFulfillmentId: response.fulfillmentId,
        requestPath: path,
      },
    };
  }

  private async requestEbay(input: {
    environment: EbayEnvironment;
    credential: DropshipMarketplaceStoreCredentials;
    marketplaceId: string;
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
            "X-EBAY-C-MARKETPLACE-ID": input.marketplaceId,
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
      const accessTokenRejected = isEbayResourceAuthFailureStatus(response.status);
      if (accessTokenRejected) {
        await recordEbayAccessTokenRejection({
          credentials: this.credentials,
          credential: input.credential,
          status: response.status,
          failureCode: "DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
          message: `eBay tracking push failed with HTTP ${response.status}.`,
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
          retryable: retryable || accessTokenRejected,
          status: response.status,
          body: text.slice(0, 1000),
        },
      );
    }
    throw new DropshipError("DROPSHIP_EBAY_TRACKING_RETRY_EXHAUSTED", "eBay tracking push retry attempts were exhausted.", {
      retryable: true,
    });
  }

}

function resolveMarketplaceId(config: Record<string, unknown>): string {
  return typeof config.marketplaceId === "string" && config.marketplaceId.trim()
    ? config.marketplaceId.trim()
    : "EBAY_US";
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
