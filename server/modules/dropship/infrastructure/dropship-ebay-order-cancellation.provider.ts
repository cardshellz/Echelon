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
import {
  isEbayResourceAuthFailureStatus,
  recordEbayAccessTokenRejection,
} from "./dropship-ebay-auth-failure";
import { DropshipEbayTokenOwner, resolveDropshipEbayProviderEnvironment } from "./dropship-ebay-token-owner";
import { buildEbayPostOrderAuthorization } from "./dropship-ebay-post-order-auth";

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

interface EbayCancellationResponse {
  cancelId?: string;
  cancellationId?: string;
}

const EBAY_BASE_URLS: Record<EbayEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
};

export class EbayDropshipOrderCancellationProvider implements DropshipMarketplaceOrderCancellationProvider {
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

  async cancelOrder(
    input: DropshipMarketplaceOrderCancellationRequest,
  ): Promise<DropshipMarketplaceOrderCancellationResult> {
    const credential = await this.tokenOwner.loadFreshForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      operation: "order_cancellation",
    });
    const config = {
      ...parseEbayCancellationConfig(credential.config),
      environment: resolveDropshipEbayProviderEnvironment(credential),
    };

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
        Authorization: buildEbayPostOrderAuthorization(input.credential.accessToken),
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Language": "en-US",
      },
      body: JSON.stringify(input.body),
    });
    const text = await response.text();
    if (!response.ok) {
      const accessTokenRejected = isEbayResourceAuthFailureStatus(response.status);
      if (accessTokenRejected) {
        await recordEbayAccessTokenRejection({
          credentials: this.credentials,
          credential: input.credential,
          status: response.status,
          failureCode: "DROPSHIP_EBAY_ORDER_CANCELLATION_HTTP_ERROR",
          message: `eBay order cancellation failed with HTTP ${response.status}.`,
          now: this.clock.now(),
        });
      }
      throw new DropshipError(
        "DROPSHIP_EBAY_ORDER_CANCELLATION_HTTP_ERROR",
        `eBay order cancellation failed with HTTP ${response.status}.`,
        {
          retryable: accessTokenRejected || response.status === 429 || response.status >= 500,
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

}

function parseEbayCancellationConfig(config: Record<string, unknown>): Omit<EbayCancellationConfig, "environment"> {
  const cancellation = recordFromConfig(config, "cancellation");
  return {
    cancelReason: requiredConfigString(cancellation, "cancelReason"),
    buyerPaid: optionalConfigBoolean(cancellation, "buyerPaid"),
  };
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
