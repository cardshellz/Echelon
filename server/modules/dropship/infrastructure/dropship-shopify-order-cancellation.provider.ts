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
interface Clock {
  now(): Date;
}

interface ShopifyCancellationConfig {
  apiVersion: string;
  notifyCustomer: boolean;
  refundOriginalPaymentMethods: boolean;
  restock: boolean;
  reason: ShopifyOrderCancelReason;
  staffNote: string | null;
}

type ShopifyOrderCancelReason = "CUSTOMER" | "DECLINED" | "FRAUD" | "INVENTORY" | "OTHER" | "STAFF";

interface ShopifyOrderCancelResponse {
  data?: {
    orderCancel?: {
      job?: {
        id?: string;
        done?: boolean;
      } | null;
      orderCancelUserErrors?: ShopifyUserError[];
      userErrors?: ShopifyUserError[];
    } | null;
  };
  errors?: Array<{
    message?: string;
    extensions?: Record<string, unknown>;
  }>;
}

interface ShopifyUserError {
  code?: string;
  field?: string[] | null;
  message?: string;
}

const DEFAULT_SHOPIFY_GRAPHQL_API_VERSION = "2026-04";
const SHOPIFY_CANCEL_REASONS = new Set<ShopifyOrderCancelReason>([
  "CUSTOMER",
  "DECLINED",
  "FRAUD",
  "INVENTORY",
  "OTHER",
  "STAFF",
]);

export class ShopifyDropshipOrderCancellationProvider implements DropshipMarketplaceOrderCancellationProvider {
  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async cancelOrder(
    input: DropshipMarketplaceOrderCancellationRequest,
  ): Promise<DropshipMarketplaceOrderCancellationResult> {
    const credential = await this.credentials.loadForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: "shopify",
    });
    assertShopifyCredential(credential);
    const config = parseShopifyCancellationConfig(credential.config);
    const orderId = toShopifyOrderGid(input.externalOrderId);
    const response = await this.callGraphql(credential, config.apiVersion, {
      query: ORDER_CANCEL_MUTATION,
      variables: {
        orderId,
        notifyCustomer: config.notifyCustomer,
        refundMethod: {
          originalPaymentMethodsRefund: config.refundOriginalPaymentMethods,
        },
        restock: config.restock,
        reason: config.reason,
        staffNote: config.staffNote,
      },
    });
    const orderCancel = response.data?.orderCancel;
    const userErrors = [
      ...(orderCancel?.orderCancelUserErrors ?? []),
      ...(orderCancel?.userErrors ?? []),
    ];
    if (userErrors.length > 0) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_ORDER_CANCELLATION_REJECTED",
        "Shopify rejected the order cancellation.",
        { retryable: false, userErrors },
      );
    }
    const jobId = orderCancel?.job?.id ?? null;
    return {
      status: "cancelled",
      externalCancellationId: jobId,
      rawResult: {
        provider: "shopify",
        apiVersion: config.apiVersion,
        orderId,
        jobDone: orderCancel?.job?.done ?? null,
      },
    };
  }

  private async callGraphql(
    credential: DropshipMarketplaceStoreCredentials,
    apiVersion: string,
    payload: {
      query: string;
      variables: Record<string, unknown>;
    },
  ): Promise<ShopifyOrderCancelResponse> {
    const response = await this.fetchImpl(
      `https://${credential.shopDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": credential.accessToken,
        },
        body: JSON.stringify(payload),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      if (isPermanentAuthFailureStatus(response.status)) {
        await this.credentials.recordAuthFailure?.({
          vendorId: credential.vendorId,
          storeConnectionId: credential.storeConnectionId,
          platform: "shopify",
          status: "needs_reauth",
          failureCode: "DROPSHIP_SHOPIFY_ORDER_CANCELLATION_HTTP_ERROR",
          message: `Shopify order cancellation failed with HTTP ${response.status}.`,
          retryable: false,
          statusCode: response.status,
          now: this.clock.now(),
        });
      }
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_ORDER_CANCELLATION_HTTP_ERROR",
        `Shopify order cancellation failed with HTTP ${response.status}.`,
        {
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
          body: text.slice(0, 1000),
        },
      );
    }

    const parsed = parseShopifyGraphqlResponse(text);
    if (parsed.errors?.length) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_ORDER_CANCELLATION_GRAPHQL_ERROR",
        "Shopify order cancellation failed with GraphQL errors.",
        { retryable: false, errors: parsed.errors },
      );
    }
    return parsed;
  }
}

function assertShopifyCredential(credential: DropshipMarketplaceStoreCredentials): void {
  if (credential.platform !== "shopify") {
    throw new DropshipError("DROPSHIP_SHOPIFY_CREDENTIAL_PLATFORM_MISMATCH", "Shopify credential platform mismatch.", {
      platform: credential.platform,
      retryable: false,
    });
  }
  if (!credential.shopDomain?.trim()) {
    throw new DropshipError("DROPSHIP_SHOPIFY_SHOP_DOMAIN_REQUIRED", "Shopify shop domain is required.", {
      retryable: false,
    });
  }
}

function parseShopifyCancellationConfig(config: Record<string, unknown>): ShopifyCancellationConfig {
  const cancellation = recordFromConfig(config, "cancellation");
  return {
    apiVersion: resolveShopifyApiVersion(config),
    notifyCustomer: booleanFromConfig(cancellation, "notifyCustomer", true),
    refundOriginalPaymentMethods: booleanFromConfig(cancellation, "refundOriginalPaymentMethods", true),
    restock: booleanFromConfig(cancellation, "restock", true),
    reason: resolveShopifyCancelReason(cancellation),
    staffNote: stringFromConfig(cancellation, "staffNote"),
  };
}

function resolveShopifyApiVersion(config: Record<string, unknown>): string {
  const configured = stringFromConfig(config, "apiVersion")
    ?? process.env.DROPSHIP_SHOPIFY_GRAPHQL_API_VERSION
    ?? process.env.SHOPIFY_API_VERSION
    ?? DEFAULT_SHOPIFY_GRAPHQL_API_VERSION;
  if (!/^\d{4}-\d{2}$/.test(configured)) {
    throw new DropshipError("DROPSHIP_SHOPIFY_API_VERSION_INVALID", "Shopify API version is invalid.", {
      apiVersion: configured,
      retryable: false,
    });
  }
  return configured;
}

function isPermanentAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function resolveShopifyCancelReason(config: Record<string, unknown>): ShopifyOrderCancelReason {
  const configured = stringFromConfig(config, "reason") ?? "OTHER";
  const normalized = configured.toUpperCase();
  if (!SHOPIFY_CANCEL_REASONS.has(normalized as ShopifyOrderCancelReason)) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_ORDER_CANCELLATION_REASON_INVALID",
      "Shopify order cancellation reason is invalid.",
      { reason: configured, retryable: false },
    );
  }
  return normalized as ShopifyOrderCancelReason;
}

function toShopifyOrderGid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("gid://shopify/Order/")) {
    return trimmed;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_ORDER_ID_INVALID",
      "Shopify order cancellation requires a Shopify numeric order id or order GID.",
      { externalOrderId: value, retryable: false },
    );
  }
  return `gid://shopify/Order/${trimmed}`;
}

function stringFromConfig(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanFromConfig(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = config[key];
  return typeof value === "boolean" ? value : fallback;
}

function recordFromConfig(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseShopifyGraphqlResponse(text: string): ShopifyOrderCancelResponse {
  if (!text) return {};
  try {
    return JSON.parse(text) as ShopifyOrderCancelResponse;
  } catch {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_ORDER_CANCELLATION_INVALID_RESPONSE",
      "Shopify order cancellation returned invalid JSON.",
      { retryable: true },
    );
  }
}

const ORDER_CANCEL_MUTATION = `
mutation DropshipOrderCancel($orderId: ID!, $notifyCustomer: Boolean, $refundMethod: OrderCancelRefundMethodInput!, $restock: Boolean!, $reason: OrderCancelReason!, $staffNote: String) {
  orderCancel(orderId: $orderId, notifyCustomer: $notifyCustomer, refundMethod: $refundMethod, restock: $restock, reason: $reason, staffNote: $staffNote) {
    job {
      id
      done
    }
    orderCancelUserErrors {
      field
      message
      code
    }
    userErrors {
      field
      message
    }
  }
}
`;
