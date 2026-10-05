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
import {
  EbayApiClient,
  EbayFulfillmentIdempotencyConflictError,
} from "../../channels/adapters/ebay/ebay-api.client";
import { buildEbayShippingFulfillmentPath, normalizeEbayTrackingNumber } from "../../channels/adapters/ebay/ebay-fulfillment.util";
import { mapCarrierToEbay } from "../../channels/adapters/ebay/ebay-category-map";
import type {
  EbayShippingFulfillmentRequest,
  EbayShippingFulfillmentResponse,
} from "../../channels/adapters/ebay/ebay-types";
import { ChannelFulfillmentProviderError } from "../../channels/channel-fulfillment-provider.error";
import {
  isEbayResourceAuthFailureStatus,
  recordEbayAccessTokenRejection,
} from "./dropship-ebay-auth-failure";
import { DropshipEbayTokenOwner, resolveDropshipEbayProviderEnvironment } from "./dropship-ebay-token-owner";

type FetchLike = typeof fetch;

interface Clock {
  now(): Date;
}

/** The same bound as Card Shellz's own eBay fulfillment calls (channel-fulfillment-provider-clients.service.ts). */
const EBAY_TRACKING_REQUEST_TIMEOUT_MS = 15_000;
/** eBay error bodies are kept for diagnosis, cut to this length. */
const EBAY_ERROR_BODY_MAX_LENGTH = 1000;
const EBAY_MARKETPLACE_HEADER = "X-EBAY-C-MARKETPLACE-ID";
const DEFAULT_EBAY_MARKETPLACE_ID = "EBAY_US";

/**
 * eBay answered with an error status. It is a ChannelFulfillmentProviderError
 * so the eBay client passes it through unchanged, and it keeps the status so a
 * rejected token is still recorded against the store connection.
 */
class EbayTrackingHttpRejection extends ChannelFulfillmentProviderError {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly body: string,
  ) {
    super(
      "DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
      `eBay tracking push failed with HTTP ${status}.`,
      status === 408 || status === 429 || status >= 500 ? "transient" : "permanent",
    );
    this.name = "EbayTrackingHttpRejection";
  }
}

/** No HTTP response came back, so whether eBay acted on the request is unknown. */
class EbayTrackingTransportFailure extends ChannelFulfillmentProviderError {
  constructor(
    readonly method: string,
    readonly causeMessage: string,
  ) {
    super(
      "DROPSHIP_EBAY_TRACKING_NETWORK_ERROR",
      "eBay tracking push failed before receiving an HTTP response.",
      "transient",
    );
    this.name = "EbayTrackingTransportFailure";
  }
}

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

  /**
   * Adds the package's tracking to the vendor's eBay order with the eBay client
   * Card Shellz's own store uses (EbayApiClient.createShippingFulfillment). It
   * reads the order's shipments first and adds one only when none carries this
   * tracking, then reads again to confirm. A failed call is not repeated here:
   * the caller's next attempt starts with that read, so a request eBay acted on
   * without answering is never sent a second time.
   */
  async pushTracking(
    input: DropshipMarketplaceTrackingRequest,
  ): Promise<DropshipMarketplaceTrackingResult> {
    // Checked before any eBay call, including a token refresh.
    const fulfillment = buildShippingFulfillment(input);
    const credential = await this.tokenOwner.loadFreshForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      operation: "tracking",
    });
    const environment = resolveDropshipEbayProviderEnvironment(credential);
    const marketplaceId = resolveMarketplaceId(credential.config);
    const orderId = input.sourceOrderId ?? input.externalOrderId;

    const transport = createEbayTrackingTransport(this.fetchImpl, marketplaceId);
    const client = new EbayApiClient(
      // The token was loaded for this push above; the client asks for it by
      // channel id, which a vendor store does not have, so the id is ignored.
      { getAccessToken: async () => credential.accessToken },
      input.storeConnectionId,
      environment,
      {
        request: transport.request,
        now: () => this.clock.now(),
        strictFulfillmentReadback: true,
      },
    );

    let shipment: EbayShippingFulfillmentResponse;
    try {
      shipment = await client.createShippingFulfillment(orderId, fulfillment);
    } catch (error) {
      throw await this.toTrackingError(error, credential, {
        orderId,
        trackingNumber: fulfillment.trackingNumber,
      });
    }

    return {
      status: "succeeded",
      externalFulfillmentId: shipment.fulfillmentId,
      rawResult: {
        provider: "ebay",
        environment,
        marketplaceId,
        externalFulfillmentId: shipment.fulfillmentId,
        requestPath: buildEbayShippingFulfillmentPath(orderId),
        // False when eBay already had this shipment, e.g. after an earlier
        // attempt whose answer was lost.
        shipmentAdded: transport.postCount() > 0,
        ...(shipment.quantityEvidenceSource
          ? { quantityEvidenceSource: shipment.quantityEvidenceSource }
          : {}),
      },
    };
  }

  private async toTrackingError(
    error: unknown,
    credential: DropshipMarketplaceStoreCredentials,
    context: { orderId: string; trackingNumber: string },
  ): Promise<DropshipError> {
    if (error instanceof DropshipError) {
      return error;
    }
    if (error instanceof EbayTrackingHttpRejection) {
      const accessTokenRejected = isEbayResourceAuthFailureStatus(error.status);
      if (accessTokenRejected) {
        await recordEbayAccessTokenRejection({
          credentials: this.credentials,
          credential,
          status: error.status,
          failureCode: error.code,
          message: error.message,
          now: this.clock.now(),
        });
      }
      return new DropshipError(error.code, error.message, {
        retryable: error.failureClass === "transient" || accessTokenRejected,
        status: error.status,
        method: error.method,
        body: error.body,
      });
    }
    if (error instanceof EbayTrackingTransportFailure) {
      return new DropshipError(error.code, error.message, {
        retryable: true,
        method: error.method,
        cause: error.causeMessage,
      });
    }
    if (error instanceof EbayFulfillmentIdempotencyConflictError) {
      // eBay already holds a shipment with this tracking that does not match
      // this package, or its shipment list was not complete. Adding another
      // could duplicate it, so a person decides.
      return new DropshipError(
        "DROPSHIP_EBAY_TRACKING_SHIPMENT_CONFLICT",
        `eBay already lists tracking ${context.trackingNumber} on this order for different items, or its shipment list was incomplete. Check the order in eBay before adding tracking by hand.`,
        {
          retryable: false,
          orderId: context.orderId,
          trackingNumber: context.trackingNumber,
        },
      );
    }
    if (error instanceof ChannelFulfillmentProviderError) {
      // The eBay client's own read checks (an unreadable or changing shipment
      // list). No tracking was added without a complete read.
      return new DropshipError(
        "DROPSHIP_EBAY_TRACKING_SHIPMENTS_UNREADABLE",
        "eBay's shipments for this order could not be read in full, so no tracking was added.",
        {
          retryable: error.failureClass === "transient",
          providerCode: error.code,
        },
      );
    }
    // E.g. eBay accepted the shipment but it could not be read back yet. The
    // next attempt reads eBay first, as for Card Shellz's own store.
    return new DropshipError(
      "DROPSHIP_EBAY_TRACKING_UNCONFIRMED",
      "eBay did not confirm the shipment; the next attempt checks eBay first.",
      {
        retryable: true,
        cause: formatUnknownError(error),
      },
    );
  }
}

function buildShippingFulfillment(
  input: DropshipMarketplaceTrackingRequest,
): EbayShippingFulfillmentRequest {
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

  let trackingNumber: string;
  try {
    trackingNumber = normalizeEbayTrackingNumber(input.trackingNumber);
  } catch (error) {
    // The same number fails the same way on every attempt.
    throw new DropshipError(
      "DROPSHIP_EBAY_TRACKING_NUMBER_INVALID",
      `Tracking number ${input.trackingNumber} cannot be sent to eBay: ${formatUnknownError(error)}`,
      {
        intakeId: input.intakeId,
        omsOrderId: input.omsOrderId,
        retryable: false,
      },
    );
  }

  return {
    lineItems,
    shippedDate: input.shippedAt.toISOString(),
    shippingCarrierCode: mapCarrierToEbay(input.carrier),
    trackingNumber,
  };
}

/**
 * The eBay client's HTTP calls for one push: bounded like Card Shellz's own
 * eBay fulfillment calls, on the vendor's marketplace, failing every error
 * status with its status kept.
 */
function createEbayTrackingTransport(
  fetchImpl: FetchLike,
  marketplaceId: string,
): { request: FetchLike; postCount(): number } {
  let posts = 0;
  const request: FetchLike = async (url, init) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    // The eBay client names the US marketplace; the vendor's store may be on another.
    headers.set(EBAY_MARKETPLACE_HEADER, marketplaceId);
    if (method === "POST") {
      posts += 1;
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(EBAY_TRACKING_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new EbayTrackingTransportFailure(method, formatUnknownError(error));
    }
    if (!response.ok) {
      throw new EbayTrackingHttpRejection(response.status, method, await readErrorBody(response));
    }
    return response;
  };
  return { request, postCount: () => posts };
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, EBAY_ERROR_BODY_MAX_LENGTH);
  } catch (error) {
    return `(error body unreadable: ${formatUnknownError(error)})`;
  }
}

function resolveMarketplaceId(config: Record<string, unknown>): string {
  return typeof config.marketplaceId === "string" && config.marketplaceId.trim()
    ? config.marketplaceId.trim()
    : DEFAULT_EBAY_MARKETPLACE_ID;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
