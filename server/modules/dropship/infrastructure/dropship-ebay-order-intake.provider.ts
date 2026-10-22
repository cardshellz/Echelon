import { DropshipError } from "../domain/errors";
import type {
  DropshipEbayOrderIntakeFetchResult,
  DropshipEbayOrderIntakeProvider,
  DropshipEbayOrderIntakeStoreConnection,
  DropshipEbayOrderLookup,
} from "../application/dropship-ebay-order-intake-poll-service";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";
import type { EbayOrder, EbayOrdersResponse } from "../../channels/adapters/ebay/ebay-types";
import {
  buildEbayDropshipOrderIntakeInput,
  isEbayOrderCancelled,
  readEbayOrderPollFacts,
  shouldRecordEbayDropshipOrder,
  type EbayStoreItemIndex,
} from "./dropship-ebay-order-intake.mapper";
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
const EBAY_PAGE_SIZE = 50;

export class EbayDropshipOrderIntakeProvider implements DropshipEbayOrderIntakeProvider {
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

  async fetchOrders(input: {
    connection: DropshipEbayOrderIntakeStoreConnection;
    since: Date;
    until: Date;
  }): Promise<DropshipEbayOrderIntakeFetchResult> {
    // A store with no dropship listing can have no dropship order: the vendor's
    // own sales on it are none of intake's business, so eBay is not even asked.
    const dropshipListingIds = new Set(input.connection.dropshipListingIds);
    if (dropshipListingIds.size === 0) {
      return { orders: [], ignored: 0, saleLines: [], cancelledOrders: [], unmatchedLines: [] };
    }

    const credential = await this.tokenOwner.loadFreshForStoreConnection({
      vendorId: input.connection.vendorId,
      storeConnectionId: input.connection.storeConnectionId,
      operation: "order_intake",
    });
    const environment = resolveDropshipEbayProviderEnvironment(credential);
    const marketplaceId = resolveMarketplaceId(credential.config);

    const orders = await this.fetchAllOrders({
      credential,
      environment,
      marketplaceId,
      since: input.since,
      until: input.until,
    });

    const index = storeItemIndex(input.connection);
    const result: DropshipEbayOrderIntakeFetchResult = { orders: [], ignored: 0, saleLines: [], cancelledOrders: [], unmatchedLines: [] };
    for (const order of orders) {
      // Every order, recorded or not, feeds the sales ledger and the parked lines (plan v4 §6.4, §7.3); a cancelled
      // one that sold through the store's listings is applied to its intake (§7.2).
      const facts = readEbayOrderPollFacts(order, index);
      result.saleLines.push(...facts.saleLines);
      result.unmatchedLines.push(...facts.unmatchedLines);
      if (facts.cancelled && facts.hasDropshipLine) result.cancelledOrders.push({ externalOrderId: order.orderId });
      const decision = shouldRecordEbayDropshipOrder({ order, dropshipListingIds });
      if (!decision.record) {
        result.ignored += 1;
        continue;
      }
      result.orders.push({
        externalOrderId: order.orderId,
        input: buildDropshipOrderInputNamingTheOrder({
          store: {
            vendorId: input.connection.vendorId,
            storeConnectionId: input.connection.storeConnectionId,
          },
          order,
          lineItems: decision.lineItems,
        }),
      });
    }
    return result;
  }

  /**
   * One order by id (plan v2 §7.2 hourly check; §7.3 parked lines): GET only.
   * A 404 is `not_found`; any other failure throws for the caller to log and
   * leave for the next poll.
   */
  async fetchOrder(input: {
    connection: DropshipEbayOrderIntakeStoreConnection;
    externalOrderId: string;
  }): Promise<DropshipEbayOrderLookup> {
    const externalOrderId = input.externalOrderId.trim();
    if (!externalOrderId) {
      throw new DropshipError("DROPSHIP_EBAY_ORDER_ID_REQUIRED", "An eBay order id is required to read the order.", { retryable: false });
    }
    const credential = await this.tokenOwner.loadFreshForStoreConnection({
      vendorId: input.connection.vendorId,
      storeConnectionId: input.connection.storeConnectionId,
      operation: "order_intake",
    });
    let order: EbayOrder;
    try {
      order = await this.requestEbay<EbayOrder>({
        environment: resolveDropshipEbayProviderEnvironment(credential),
        credential,
        marketplaceId: resolveMarketplaceId(credential.config),
        path: `/sell/fulfillment/v1/order/${encodeURIComponent(externalOrderId)}`,
      });
    } catch (error) {
      if (error instanceof DropshipError && error.context?.status === 404) return { kind: "not_found" };
      throw error;
    }
    const decision = shouldRecordEbayDropshipOrder({ order, dropshipListingIds: new Set(input.connection.dropshipListingIds) });
    return {
      kind: "order",
      cancelled: isEbayOrderCancelled(order),
      fulfilled: order.orderFulfillmentStatus === "FULFILLED",
      recordable: decision.record
        ? {
          externalOrderId: order.orderId,
          input: buildDropshipOrderInputNamingTheOrder({
            store: { vendorId: input.connection.vendorId, storeConnectionId: input.connection.storeConnectionId },
            order,
            lineItems: decision.lineItems,
          }),
        }
        : null,
    };
  }

  private async fetchAllOrders(input: {
    credential: DropshipMarketplaceStoreCredentials;
    environment: EbayEnvironment;
    marketplaceId: string;
    since: Date;
    until: Date;
  }): Promise<EbayOrder[]> {
    const orders: EbayOrder[] = [];
    let offset = 0;
    while (true) {
      const response = await this.fetchOrderPage({
        ...input,
        offset,
      });
      if (!Array.isArray(response.orders) || response.orders.length === 0) {
        break;
      }
      orders.push(...response.orders);
      offset += response.orders.length;
      if (response.orders.length < EBAY_PAGE_SIZE || offset >= response.total) {
        break;
      }
    }
    return orders;
  }

  private async fetchOrderPage(input: {
    credential: DropshipMarketplaceStoreCredentials;
    environment: EbayEnvironment;
    marketplaceId: string;
    since: Date;
    until: Date;
    offset: number;
  }): Promise<EbayOrdersResponse> {
    const params = new URLSearchParams({
      filter: `lastmodifieddate:[${input.since.toISOString()}..${input.until.toISOString()}],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}`,
      limit: String(EBAY_PAGE_SIZE),
      offset: String(input.offset),
    });
    return this.requestEbay<EbayOrdersResponse>({
      environment: input.environment,
      credential: input.credential,
      marketplaceId: input.marketplaceId,
      path: `/sell/fulfillment/v1/order?${params.toString()}`,
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
            Authorization: `Bearer ${input.credential.accessToken}`,
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
          "DROPSHIP_EBAY_ORDER_INTAKE_NETWORK_ERROR",
          "eBay order intake failed before receiving an HTTP response.",
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
          code: "DROPSHIP_EBAY_ORDER_INTAKE_INVALID_RESPONSE",
          message: "eBay order intake returned invalid JSON.",
        });
      }
      const accessTokenRejected = isEbayResourceAuthFailureStatus(response.status);
      if (accessTokenRejected) {
        await recordEbayAccessTokenRejection({
          credentials: this.credentials,
          credential: input.credential,
          status: response.status,
          failureCode: "DROPSHIP_EBAY_ORDER_INTAKE_HTTP_ERROR",
          message: `eBay order intake failed with HTTP ${response.status}.`,
          now: this.clock.now(),
        });
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < EBAY_MAX_ATTEMPTS) {
        await delay(resolveRetryDelayMs(response, attempt));
        continue;
      }
      throw new DropshipError(
        "DROPSHIP_EBAY_ORDER_INTAKE_HTTP_ERROR",
        `eBay order intake failed with HTTP ${response.status}.`,
        {
          retryable: retryable || accessTokenRejected,
          status: response.status,
          body: text.slice(0, 1000),
        },
      );
    }
    throw new DropshipError(
      "DROPSHIP_EBAY_ORDER_INTAKE_RETRY_EXHAUSTED",
      "eBay order intake retry attempts were exhausted.",
      { retryable: true },
    );
  }

}

function storeItemIndex(connection: DropshipEbayOrderIntakeStoreConnection): EbayStoreItemIndex {
  const listingIdByItemNumber = new Map<string, number>();
  for (const item of connection.itemNumbers) {
    // A current number is listed before an earlier one (the repository's order), so it wins.
    if (!listingIdByItemNumber.has(item.externalListingId)) listingIdByItemNumber.set(item.externalListingId, item.listingId);
  }
  const listingIdsBySku = new Map<string, number[]>();
  for (const listing of connection.listingSkus) {
    const key = listing.sku.trim().toUpperCase();
    if (!key) continue;
    const ids = listingIdsBySku.get(key) ?? [];
    if (!ids.includes(listing.listingId)) ids.push(listing.listingId);
    listingIdsBySku.set(key, ids);
  }
  return { listingIdByItemNumber, listingIdsBySku };
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

/**
 * Builds the intake input, and when the order cannot be read names the order and
 * the field in the error: the message is what the store's intake health records,
 * so it must be enough to find the order without the raw payload.
 */
function buildDropshipOrderInputNamingTheOrder(
  input: Parameters<typeof buildEbayDropshipOrderIntakeInput>[0],
): ReturnType<typeof buildEbayDropshipOrderIntakeInput> {
  try {
    return buildEbayDropshipOrderIntakeInput(input);
  } catch (error) {
    if (!(error instanceof DropshipError)) throw error;
    const field = typeof error.context?.field === "string" ? `, field ${error.context.field}` : "";
    throw new DropshipError(
      error.code,
      `${error.message} (eBay order ${String(input.order.orderId)}${field})`,
      { ...error.context, externalOrderId: input.order.orderId },
    );
  }
}
