import { DropshipError } from "../domain/errors";
import type {
  DropshipReturnTrackingProvider,
  DropshipReturnTrackingSnapshot,
} from "../application/dropship-no-inspection-watcher-service";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";
import { isEbayResourceAuthFailureStatus } from "./dropship-ebay-auth-failure";
import { buildEbayPostOrderAuthorization } from "./dropship-ebay-post-order-auth";

/**
 * Return-leg tracking provider (stack 4/4, item E): implements the PR 3
 * DropshipReturnTrackingProvider port so the no-inspection watcher's
 * carrier-lost-status path becomes live.
 *
 * eBay: Post-Order API return detail → returnShipment tracking events. The
 * channel knows the return label it issued, so carrier status is available
 * for eBay-issued labels.
 *
 * Shopify: best-effort. Reverse fulfillment order deliverables carry a
 * tracking number + carrier but no event history; without a carrier
 * integration the snapshot reports the RFO status as the carrier status and
 * an empty event list. The watcher's delivery-timeout path still covers
 * Shopify returns with an expected delivery date.
 *
 * Unknown store connections / missing channel data → null (the watcher
 * treats null as "no tracking signal", never an error).
 */

type FetchLike = typeof fetch;
type EbayEnvironment = "sandbox" | "production";

interface Clock {
  now(): Date;
}

interface EbayReturnDetailResponse {
  returnId?: string;
  returnShipment?: {
    trackingNumber?: string;
    carrierEnum?: string;
    carrier?: string;
    status?: string;
    expectedDeliveryDate?: string;
    deliveredDate?: string;
    shipmentTrackingEvents?: Array<{
      status?: string;
      eventDate?: string;
      description?: string;
    }>;
  };
  [key: string]: unknown;
}

interface StoreConnectionChannelRow {
  platform: string;
  channel_return_id: string | null;
}

export interface DropshipReturnTrackingRepository {
  findChannelReturnForTracking(input: {
    storeConnectionId: number;
    trackingNumber: string;
  }): Promise<StoreConnectionChannelRow | null>;
}

const EBAY_BASE_URLS: Record<EbayEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
};

const EBAY_MAX_ATTEMPTS = 3;

export class DropshipChannelReturnTrackingProvider implements DropshipReturnTrackingProvider {
  constructor(
    private readonly deps: {
      credentials: DropshipMarketplaceCredentialRepository;
      repository: DropshipReturnTrackingRepository;
      fetchImpl?: FetchLike;
      clock?: Clock;
    },
  ) {}

  async fetchReturnTracking(input: {
    vendorId: number;
    storeConnectionId: number | null;
    trackingNumber: string;
  }): Promise<DropshipReturnTrackingSnapshot | null> {
    if (!input.storeConnectionId) return null;
    const channel = await this.deps.repository.findChannelReturnForTracking({
      storeConnectionId: input.storeConnectionId,
      trackingNumber: input.trackingNumber,
    });
    if (!channel || channel.platform !== "ebay" || !channel.channel_return_id) {
      // Shopify + non-channel RMAs: best-effort null (see class docstring).
      return null;
    }

    const credential = await this.deps.credentials.loadForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: "ebay",
    });
    const environment = resolveEbayEnvironment(credential.config);
    const marketplaceId = resolveMarketplaceId(credential.config);

    const detail = await this.fetchEbayReturnDetail({
      credential,
      environment,
      marketplaceId,
      returnId: channel.channel_return_id,
    });
    const shipment = detail?.returnShipment;
    if (!shipment || shipment.trackingNumber !== input.trackingNumber) {
      return null;
    }
    return {
      trackingNumber: input.trackingNumber,
      carrierStatus: shipment.status ?? "unknown",
      deliveredAt: parseOptionalDate(shipment.deliveredDate),
      events: Array.isArray(shipment.shipmentTrackingEvents)
        ? shipment.shipmentTrackingEvents.map((event) => ({
            status: event.status ?? "unknown",
            occurredAt: event.eventDate ?? "",
            description: event.description ?? null,
          }))
        : [],
    };
  }

  private async fetchEbayReturnDetail(input: {
    credential: DropshipMarketplaceStoreCredentials;
    environment: EbayEnvironment;
    marketplaceId: string;
    returnId: string;
  }): Promise<EbayReturnDetailResponse | null> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const clock = this.deps.clock ?? { now: () => new Date() };
    for (let attempt = 1; attempt <= EBAY_MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${EBAY_BASE_URLS[input.environment]}/post-order/v2/return/${encodeURIComponent(input.returnId)}`,
          {
            method: "GET",
            headers: {
              Authorization: buildEbayPostOrderAuthorization(input.credential.accessToken),
              Accept: "application/json",
              "X-EBAY-C-MARKETPLACE-ID": input.marketplaceId,
            },
          },
        );
      } catch (error) {
        if (attempt < EBAY_MAX_ATTEMPTS) {
          await delay(Math.min(1000 * Math.pow(2, attempt - 1), 10_000));
          continue;
        }
        throw new DropshipError(
          "DROPSHIP_RETURN_TRACKING_NETWORK_ERROR",
          "eBay return tracking fetch failed before receiving an HTTP response.",
          { retryable: true, cause: error instanceof Error ? error.message : String(error) },
        );
      }
      const text = await response.text();
      if (response.status === 404) {
        return null;
      }
      if (response.ok) {
        try {
          return JSON.parse(text) as EbayReturnDetailResponse;
        } catch {
          throw new DropshipError(
            "DROPSHIP_RETURN_TRACKING_INVALID_RESPONSE",
            "eBay return tracking fetch returned invalid JSON.",
            { body: text.slice(0, 1000), retryable: true },
          );
        }
      }
      if (isEbayResourceAuthFailureStatus(response.status)) {
        await this.deps.credentials.recordAuthFailure?.({
          vendorId: input.credential.vendorId,
          storeConnectionId: input.credential.storeConnectionId,
          platform: "ebay",
          status: "needs_reauth",
          failureCode: "DROPSHIP_RETURN_TRACKING_HTTP_ERROR",
          message: `eBay return tracking fetch failed with HTTP ${response.status}.`,
          retryable: false,
          statusCode: response.status,
          now: clock.now(),
        });
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < EBAY_MAX_ATTEMPTS) {
        await delay(Math.min(1000 * Math.pow(2, attempt - 1), 10_000));
        continue;
      }
      throw new DropshipError(
        "DROPSHIP_RETURN_TRACKING_HTTP_ERROR",
        `eBay return tracking fetch failed with HTTP ${response.status}.`,
        { retryable, status: response.status, body: text.slice(0, 1000) },
      );
    }
    throw new DropshipError(
      "DROPSHIP_RETURN_TRACKING_RETRY_EXHAUSTED",
      "eBay return tracking fetch retry attempts were exhausted.",
      { retryable: true },
    );
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

function parseOptionalDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
