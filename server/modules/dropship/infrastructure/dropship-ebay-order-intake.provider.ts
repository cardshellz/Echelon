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
import {
  fetchEbayFulfillmentResource,
  paginateEbayFulfillmentOrders,
  type EbayOrder,
  type EbayRestEnvironment,
} from "../../channels/ebay-connector.api";
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
import {
  DropshipEbayTokenOwner,
  resolveDropshipEbayProviderEnvironment,
} from "./dropship-ebay-token-owner";

type FetchLike = typeof fetch;

interface Clock {
  now(): Date;
}

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
    const dropshipListingIds = new Set(input.connection.dropshipListingIds);
    if (dropshipListingIds.size === 0) {
      return {
        orders: [],
        ignored: 0,
        saleLines: [],
        cancelledOrders: [],
        unmatchedLines: [],
      };
    }

    const credential = await this.tokenOwner.loadFreshForStoreConnection({
      vendorId: input.connection.vendorId,
      storeConnectionId: input.connection.storeConnectionId,
      operation: "order_intake",
    });
    const environment = resolveDropshipEbayProviderEnvironment(credential);
    const marketplaceId = resolveMarketplaceId(credential.config);

    const orders = await paginateEbayFulfillmentOrders({
      ...this.buildEbayTransportOptions(credential, environment, marketplaceId),
      filter: `lastmodifieddate:[${input.since.toISOString()}..${input.until.toISOString()}],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}`,
      pageSize: EBAY_PAGE_SIZE,
    });

    const index = storeItemIndex(input.connection);
    const result: DropshipEbayOrderIntakeFetchResult = {
      orders: [],
      ignored: 0,
      saleLines: [],
      cancelledOrders: [],
      unmatchedLines: [],
    };
    for (const order of orders) {
      const facts = readEbayOrderPollFacts(order, index);
      result.saleLines.push(...facts.saleLines);
      result.unmatchedLines.push(...facts.unmatchedLines);
      if (facts.cancelled && facts.hasDropshipLine) {
        result.cancelledOrders.push({ externalOrderId: order.orderId });
      }
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

  async fetchOrder(input: {
    connection: DropshipEbayOrderIntakeStoreConnection;
    externalOrderId: string;
  }): Promise<DropshipEbayOrderLookup> {
    const externalOrderId = input.externalOrderId.trim();
    if (!externalOrderId) {
      throw new DropshipError(
        "DROPSHIP_EBAY_ORDER_ID_REQUIRED",
        "An eBay order id is required to read the order.",
        { retryable: false },
      );
    }
    const credential = await this.tokenOwner.loadFreshForStoreConnection({
      vendorId: input.connection.vendorId,
      storeConnectionId: input.connection.storeConnectionId,
      operation: "order_intake",
    });
    const environment = resolveDropshipEbayProviderEnvironment(credential);
    const marketplaceId = resolveMarketplaceId(credential.config);

    let order: EbayOrder;
    try {
      order = await fetchEbayFulfillmentResource<EbayOrder, DropshipError>({
        ...this.buildEbayTransportOptions(credential, environment, marketplaceId),
        path: `/sell/fulfillment/v1/order/${encodeURIComponent(externalOrderId)}`,
      });
    } catch (error) {
      if (error instanceof DropshipError && error.context?.status === 404) {
        return { kind: "not_found" };
      }
      throw error;
    }

    const decision = shouldRecordEbayDropshipOrder({
      order,
      dropshipListingIds: new Set(input.connection.dropshipListingIds),
    });
    return {
      kind: "order",
      cancelled: isEbayOrderCancelled(order),
      fulfilled: order.orderFulfillmentStatus === "FULFILLED",
      recordable: decision.record
        ? {
            externalOrderId: order.orderId,
            input: buildDropshipOrderInputNamingTheOrder({
              store: {
                vendorId: input.connection.vendorId,
                storeConnectionId: input.connection.storeConnectionId,
              },
              order,
              lineItems: decision.lineItems,
            }),
          }
        : null,
    };
  }

  private buildEbayTransportOptions(
    credential: DropshipMarketplaceStoreCredentials,
    environment: EbayRestEnvironment,
    marketplaceId: string,
  ) {
    return {
      environment,
      accessToken: credential.accessToken,
      marketplaceId,
      fetchImpl: this.fetchImpl,
      maxAttempts: EBAY_MAX_ATTEMPTS,
      onHttpFailure: async (status: number) => {
        if (isEbayResourceAuthFailureStatus(status)) {
          await recordEbayAccessTokenRejection({
            credentials: this.credentials,
            credential,
            status,
            failureCode: "DROPSHIP_EBAY_ORDER_INTAKE_HTTP_ERROR",
            message: `eBay order intake failed with HTTP ${status}.`,
            now: this.clock.now(),
          });
        }
      },
      createNetworkError: (error: unknown) =>
        new DropshipError(
          "DROPSHIP_EBAY_ORDER_INTAKE_NETWORK_ERROR",
          "eBay order intake failed before receiving an HTTP response.",
          {
            retryable: true,
            cause: error instanceof Error ? error.message : String(error),
          },
        ),
      createInvalidJsonError: (text: string) =>
        new DropshipError(
          "DROPSHIP_EBAY_ORDER_INTAKE_INVALID_RESPONSE",
          "eBay order intake returned invalid JSON.",
          {
            body: text.slice(0, 1000),
            retryable: true,
          },
        ),
      createHttpError: (status: number, text: string, retryable: boolean) =>
        new DropshipError(
          "DROPSHIP_EBAY_ORDER_INTAKE_HTTP_ERROR",
          `eBay order intake failed with HTTP ${status}.`,
          {
            retryable: retryable || isEbayResourceAuthFailureStatus(status),
            status,
            body: text.slice(0, 1000),
          },
        ),
      createRetryExhaustedError: () =>
        new DropshipError(
          "DROPSHIP_EBAY_ORDER_INTAKE_RETRY_EXHAUSTED",
          "eBay order intake retry attempts were exhausted.",
          { retryable: true },
        ),
    };
  }
}

function storeItemIndex(
  connection: DropshipEbayOrderIntakeStoreConnection,
): EbayStoreItemIndex {
  const listingIdByItemNumber = new Map<string, number>();
  for (const item of connection.itemNumbers) {
    if (!listingIdByItemNumber.has(item.externalListingId)) {
      listingIdByItemNumber.set(item.externalListingId, item.listingId);
    }
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

function buildDropshipOrderInputNamingTheOrder(
  input: Parameters<typeof buildEbayDropshipOrderIntakeInput>[0],
): ReturnType<typeof buildEbayDropshipOrderIntakeInput> {
  try {
    return buildEbayDropshipOrderIntakeInput(input);
  } catch (error) {
    if (!(error instanceof DropshipError)) throw error;
    const field =
      typeof error.context?.field === "string"
        ? `, field ${error.context.field}`
        : "";
    throw new DropshipError(
      error.code,
      `${error.message} (eBay order ${String(input.order.orderId)}${field})`,
      { ...error.context, externalOrderId: input.order.orderId },
    );
  }
}
