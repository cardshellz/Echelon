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

type FetchLike = typeof fetch;

interface ShopifyTrackingConfig {
  apiVersion: string;
  notifyCustomer: boolean;
  message: string | null;
}

interface ShopifyGraphqlResponse<TData> {
  data?: TData;
  errors?: Array<{
    message?: string;
    extensions?: Record<string, unknown>;
  }>;
}

interface ShopifyOrderFulfillmentLookupData {
  order?: {
    id?: string;
    fulfillments?: Array<{
      id?: string;
      trackingInfo?: Array<{
        number?: string | null;
        company?: string | null;
        url?: string | null;
      }> | null;
    }> | null;
    fulfillmentOrders?: {
      nodes?: Array<{
        id?: string;
        lineItems?: {
          nodes?: Array<{
            id?: string;
            remainingQuantity?: number;
            lineItem?: {
              id?: string;
            } | null;
          }>;
        } | null;
      }>;
    } | null;
  } | null;
}

interface ShopifyFulfillmentCreateData {
  fulfillmentCreate?: {
    fulfillment?: {
      id?: string;
    } | null;
    userErrors?: ShopifyUserError[];
  } | null;
}

interface ShopifyUserError {
  field?: string[] | null;
  message?: string;
}

interface ShopifyFulfillmentOrderLineItemInput {
  id: string;
  quantity: number;
}

interface ShopifyLineItemsByFulfillmentOrderInput {
  fulfillmentOrderId: string;
  fulfillmentOrderLineItems: ShopifyFulfillmentOrderLineItemInput[];
}

const DEFAULT_SHOPIFY_GRAPHQL_API_VERSION = "2026-04";
const SHOPIFY_MAX_ATTEMPTS = 3;

export class ShopifyDropshipMarketplaceTrackingProvider implements DropshipMarketplaceTrackingProvider {
  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async pushTracking(
    input: DropshipMarketplaceTrackingRequest,
  ): Promise<DropshipMarketplaceTrackingResult> {
    const requestedLineItems = normalizeRequestedLineItems(input);
    const credential = await this.credentials.loadForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: "shopify",
    });
    assertShopifyCredential(credential);
    const config = parseShopifyTrackingConfig(credential.config);
    const orderId = toShopifyOrderGid(input.externalOrderId);

    const lookup = await this.callGraphql<ShopifyOrderFulfillmentLookupData>(credential, config.apiVersion, {
      query: ORDER_FULFILLMENT_LOOKUP_QUERY,
      variables: { orderId },
    });
    const order = lookup.data?.order;
    if (!order?.id) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_TRACKING_ORDER_NOT_FOUND",
        "Shopify order could not be loaded for tracking push.",
        { orderId, retryable: false },
      );
    }

    const existingFulfillmentId = findExistingFulfillmentId(order, input.trackingNumber);
    if (existingFulfillmentId) {
      return {
        status: "succeeded",
        externalFulfillmentId: existingFulfillmentId,
        rawResult: {
          provider: "shopify",
          apiVersion: config.apiVersion,
          orderId,
          externalFulfillmentId: existingFulfillmentId,
          dedupedByTrackingNumber: true,
        },
      };
    }

    const lineItemsByFulfillmentOrder = buildLineItemsByFulfillmentOrder({
      order,
      requestedLineItems,
      intakeId: input.intakeId,
      omsOrderId: input.omsOrderId,
    });
    const fulfillment = await this.callGraphql<ShopifyFulfillmentCreateData>(credential, config.apiVersion, {
      query: FULFILLMENT_CREATE_MUTATION,
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder,
          notifyCustomer: config.notifyCustomer,
          trackingInfo: {
            company: input.carrier.trim(),
            number: input.trackingNumber.trim(),
          },
        },
        message: config.message,
      },
    });
    const fulfillmentCreate = fulfillment.data?.fulfillmentCreate;
    const userErrors = fulfillmentCreate?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_TRACKING_REJECTED",
        "Shopify rejected the tracking fulfillment.",
        { retryable: false, userErrors },
      );
    }
    const fulfillmentId = fulfillmentCreate?.fulfillment?.id;
    if (!fulfillmentId) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_TRACKING_MISSING_FULFILLMENT",
        "Shopify tracking push did not return a fulfillment id.",
        { retryable: true },
      );
    }

    return {
      status: "succeeded",
      externalFulfillmentId: fulfillmentId,
      rawResult: {
        provider: "shopify",
        apiVersion: config.apiVersion,
        orderId,
        externalFulfillmentId: fulfillmentId,
        fulfillmentOrderCount: lineItemsByFulfillmentOrder.length,
      },
    };
  }

  private async callGraphql<TData>(
    credential: DropshipMarketplaceStoreCredentials,
    apiVersion: string,
    payload: {
      query: string;
      variables: Record<string, unknown>;
    },
  ): Promise<ShopifyGraphqlResponse<TData>> {
    for (let attempt = 1; attempt <= SHOPIFY_MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(
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
      } catch (error) {
        if (attempt < SHOPIFY_MAX_ATTEMPTS) {
          await delay(resolveRetryDelayMs(null, attempt));
          continue;
        }
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_TRACKING_NETWORK_ERROR",
          "Shopify tracking push failed before receiving an HTTP response.",
          {
            retryable: true,
            cause: formatUnknownError(error),
          },
        );
      }

      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < SHOPIFY_MAX_ATTEMPTS) {
          await delay(resolveRetryDelayMs(response, attempt));
          continue;
        }
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_TRACKING_HTTP_ERROR",
          `Shopify tracking push failed with HTTP ${response.status}.`,
          {
            retryable,
            status: response.status,
            body: text.slice(0, 1000),
          },
        );
      }

      const parsed = parseShopifyGraphqlResponse<TData>(text);
      if (parsed.errors?.length) {
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_TRACKING_GRAPHQL_ERROR",
          "Shopify tracking push failed with GraphQL errors.",
          { retryable: false, errors: parsed.errors },
        );
      }
      return parsed;
    }

    throw new DropshipError(
      "DROPSHIP_SHOPIFY_TRACKING_RETRY_EXHAUSTED",
      "Shopify tracking push retry attempts were exhausted.",
      { retryable: true },
    );
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

function parseShopifyTrackingConfig(config: Record<string, unknown>): ShopifyTrackingConfig {
  const tracking = recordFromConfig(config, "tracking");
  const fulfillment = recordFromConfig(config, "fulfillment");
  return {
    apiVersion: resolveShopifyApiVersion(config),
    notifyCustomer: booleanFromConfig(tracking, "notifyCustomer")
      ?? booleanFromConfig(fulfillment, "notifyCustomer")
      ?? true,
    message: stringFromConfig(tracking, "message"),
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

function normalizeRequestedLineItems(
  input: DropshipMarketplaceTrackingRequest,
): Map<string, number> {
  if (input.lineItems.length === 0) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_TRACKING_LINE_ITEMS_REQUIRED",
      "Shopify tracking push requires marketplace line items.",
      { intakeId: input.intakeId, omsOrderId: input.omsOrderId, retryable: false },
    );
  }

  const lineItems = new Map<string, number>();
  for (const line of input.lineItems) {
    if (!line.externalLineItemId?.trim()) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_TRACKING_LINE_ITEM_IDS_REQUIRED",
        "Shopify tracking push requires marketplace line item ids.",
        { intakeId: input.intakeId, omsOrderId: input.omsOrderId, retryable: false },
      );
    }
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_TRACKING_LINE_ITEM_QUANTITY_INVALID",
        "Shopify tracking push line item quantities must be positive integers.",
        { intakeId: input.intakeId, omsOrderId: input.omsOrderId, quantity: line.quantity, retryable: false },
      );
    }
    const lineItemId = toShopifyLineItemGid(line.externalLineItemId);
    lineItems.set(lineItemId, (lineItems.get(lineItemId) ?? 0) + line.quantity);
  }
  return lineItems;
}

function findExistingFulfillmentId(
  order: NonNullable<ShopifyOrderFulfillmentLookupData["order"]>,
  trackingNumber: string,
): string | null {
  const normalized = normalizeTrackingNumber(trackingNumber);
  for (const fulfillment of order.fulfillments ?? []) {
    if (!fulfillment?.id) {
      continue;
    }
    const hasTrackingNumber = (fulfillment.trackingInfo ?? []).some((tracking) => {
      return normalizeTrackingNumber(tracking?.number ?? "") === normalized;
    });
    if (hasTrackingNumber) {
      return fulfillment.id;
    }
  }
  return null;
}

function buildLineItemsByFulfillmentOrder(input: {
  order: NonNullable<ShopifyOrderFulfillmentLookupData["order"]>;
  requestedLineItems: Map<string, number>;
  intakeId: number;
  omsOrderId: number;
}): ShopifyLineItemsByFulfillmentOrderInput[] {
  const remaining = new Map(input.requestedLineItems);
  const groups: ShopifyLineItemsByFulfillmentOrderInput[] = [];

  for (const fulfillmentOrder of input.order.fulfillmentOrders?.nodes ?? []) {
    if (!fulfillmentOrder?.id) {
      continue;
    }
    const fulfillmentOrderLineItems: ShopifyFulfillmentOrderLineItemInput[] = [];
    for (const line of fulfillmentOrder.lineItems?.nodes ?? []) {
      if (!line?.id || !line.lineItem?.id) {
        continue;
      }
      const requestedQuantity = remaining.get(line.lineItem.id);
      if (!requestedQuantity) {
        continue;
      }
      const fulfillableQuantity = safePositiveInteger(line.remainingQuantity);
      if (fulfillableQuantity <= 0) {
        continue;
      }
      const quantity = Math.min(requestedQuantity, fulfillableQuantity);
      fulfillmentOrderLineItems.push({ id: line.id, quantity });
      const updatedRemaining = requestedQuantity - quantity;
      if (updatedRemaining <= 0) {
        remaining.delete(line.lineItem.id);
      } else {
        remaining.set(line.lineItem.id, updatedRemaining);
      }
    }
    if (fulfillmentOrderLineItems.length > 0) {
      groups.push({
        fulfillmentOrderId: fulfillmentOrder.id,
        fulfillmentOrderLineItems,
      });
    }
  }

  if (remaining.size > 0) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_TRACKING_LINE_ITEMS_NOT_FULFILLABLE",
      "Shopify fulfillment orders do not contain enough fulfillable quantity for the shipped line items.",
      {
        intakeId: input.intakeId,
        omsOrderId: input.omsOrderId,
        missingLineItemIds: Array.from(remaining.keys()),
        retryable: false,
      },
    );
  }
  if (groups.length === 0) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_TRACKING_FULFILLMENT_ORDERS_REQUIRED",
      "Shopify tracking push requires at least one fulfillable fulfillment order.",
      { intakeId: input.intakeId, omsOrderId: input.omsOrderId, retryable: false },
    );
  }
  return groups;
}

function toShopifyOrderGid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("gid://shopify/Order/")) {
    return trimmed;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_ORDER_ID_INVALID",
      "Shopify tracking push requires a Shopify numeric order id or order GID.",
      { externalOrderId: value, retryable: false },
    );
  }
  return `gid://shopify/Order/${trimmed}`;
}

function toShopifyLineItemGid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("gid://shopify/LineItem/")) {
    return trimmed;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_LINE_ITEM_ID_INVALID",
      "Shopify tracking push requires Shopify numeric line item ids or line item GIDs.",
      { externalLineItemId: value, retryable: false },
    );
  }
  return `gid://shopify/LineItem/${trimmed}`;
}

function safePositiveInteger(value: unknown): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

function normalizeTrackingNumber(value: string): string {
  return value.trim().replace(/\s+/g, "").toUpperCase();
}

function stringFromConfig(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanFromConfig(config: Record<string, unknown>, key: string): boolean | null {
  const value = config[key];
  return typeof value === "boolean" ? value : null;
}

function recordFromConfig(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseShopifyGraphqlResponse<TData>(text: string): ShopifyGraphqlResponse<TData> {
  if (!text) return {};
  try {
    return JSON.parse(text) as ShopifyGraphqlResponse<TData>;
  } catch {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_TRACKING_INVALID_RESPONSE",
      "Shopify tracking push returned invalid JSON.",
      { retryable: true },
    );
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

const ORDER_FULFILLMENT_LOOKUP_QUERY = `
query DropshipShopifyFulfillmentLookup($orderId: ID!) {
  order(id: $orderId) {
    id
    fulfillments(first: 25) {
      id
      trackingInfo(first: 10) {
        number
        company
        url
      }
    }
    fulfillmentOrders(first: 50) {
      nodes {
        id
        lineItems(first: 100) {
          nodes {
            id
            remainingQuantity
            lineItem {
              id
            }
          }
        }
      }
    }
  }
}
`;

const FULFILLMENT_CREATE_MUTATION = `
mutation DropshipShopifyFulfillmentCreate($fulfillment: FulfillmentInput!, $message: String) {
  fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
    fulfillment {
      id
    }
    userErrors {
      field
      message
    }
  }
}
`;
