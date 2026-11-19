import {
  stockLinkDestinationSchema, stockLinkOfferLookupSchema, type StockLinkDestination, type StockLinkOfferLookup,
} from "@shared/types/stock-link";
import type { StockLinkOfferAdapter, StockLinkProviderCallOptions } from "../../../inventory-planning/application/stock-link.ports";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../../../inventory-planning/domain/stock-link-errors";
import { InventoryPublicationConfigurationError } from "../../channel-adapter.interface";
import { EbayApiRequestError } from "./ebay-api-error";
import { EbayInventoryQuantityError, type EbayDiscoveredOffer } from "./ebay-inventory-quantity";

/**
 * The stock-link engine's Card Shellz eBay adapter (channels PR4, PLAN-CH-v3 §2 "Adapters"): every offer eBay holds for
 * one SKU on the connection's marketplace, read with the exact verified publication account through the channel's own
 * eBay client and the shared offer discovery (ebay-inventory-quantity.ts discoverEbayInventoryOffers: page bound,
 * pagination checks, exact SKU and marketplace; the same reads the quantity write makes). Read-only, decides nothing;
 * every refusal is a classified StockLinkError. HYPOTHESIS: the channel client's own bounded retry on 429/5xx
 * (ebay-api.client.ts request) can hold one lookup longer than the tick's 15 s call budget; the tick stops starting
 * calls after 30 s.
 */

const C = STOCK_LINK_ERROR_CODES;

export interface ChannelEbayStockLinkAdapterDependencies {
  readonly ebay: { discoverStockLinkOffers(channelId: number, channelConnectionId: number, externalScopeId: string, sku: string):
    Promise<{ marketplaceId: string; offers: EbayDiscoveredOffer[] }> };
  readonly clock: () => Date;
}

function refusal(code: string, message: string, context: Readonly<Record<string, unknown>> = {},
  options?: ErrorOptions & { retryAfterMs?: number | null }): StockLinkError {
  return new StockLinkError(code, message, context, options);
}

function scopeOf(destination: StockLinkDestination): { channelId: number; connectionId: number; accountId: string } {
  const parsed = stockLinkDestinationSchema.safeParse(destination);
  if (!parsed.success || parsed.data.destinationKind !== "channel_connection" || parsed.data.providerKey !== "ebay"
    || parsed.data.channelConnectionId === null || parsed.data.providerScopeType !== "account") {
    throw refusal(C.adapterContract, "The Card Shellz eBay stock-link adapter was given another kind of destination.");
  }
  return { channelId: parsed.data.channelId, connectionId: parsed.data.channelConnectionId, accountId: parsed.data.externalScopeId };
}

export function classifyChannelEbayStockLinkError(error: unknown, context: Readonly<Record<string, unknown>>): StockLinkError {
  if (error instanceof StockLinkError) return error;
  if (error instanceof EbayInventoryQuantityError) {
    return error.retryable
      ? refusal(C.lookupIncomplete, "eBay's offer discovery was incomplete.", { ...context, code: error.code }, { cause: error })
      : refusal(C.adapterContract, "eBay's offer discovery broke its contract.", { ...context, code: error.code }, { cause: error });
  }
  // The connection's verified publication account is not this destination's (or is missing): nothing is read with it.
  if (error instanceof InventoryPublicationConfigurationError)
    return refusal(C.storeAuthRefused, "The eBay connection is not the destination's verified account.", context, { cause: error });
  if (error instanceof EbayApiRequestError) {
    const status = error.statusCode;
    if (status === 401 || status === 403) return refusal(C.storeAuthRefused, `eBay refused the login (HTTP ${status}).`, { ...context, status }, { cause: error });
    if (status === 429) return refusal(C.providerThrottled, "eBay throttled the offer lookup.", { ...context, status }, { cause: error });
    if (status === undefined || status === 408 || status === 425 || status >= 500)
      return refusal(C.providerUnavailable, "eBay could not answer the offer lookup.", { ...context, status }, { cause: error });
    return refusal(C.lookupRejected, `eBay refused the offer lookup (HTTP ${status}).`, { ...context, status }, { cause: error });
  }
  // eBay down after the client's own retries, a network failure, a token refresh that failed: the store pauses and
  // the pause lifts on the first answered read.
  return refusal(C.storeUnavailable, "eBay did not answer the offer lookup.", { ...context,
    errorName: error instanceof Error ? error.name : "UnknownError" }, { cause: error });
}

export class ChannelEbayStockLinkAdapter implements StockLinkOfferAdapter {
  readonly destinationKind = "channel_connection" as const;
  readonly providerKey = "ebay";

  constructor(private readonly deps: ChannelEbayStockLinkAdapterDependencies) {}

  async findOffersBySku(destination: StockLinkDestination, sku: string, _options: StockLinkProviderCallOptions): Promise<StockLinkOfferLookup> {
    const scope = scopeOf(destination);
    const asked = sku.trim();
    if (asked.length === 0 || asked !== sku) throw refusal(C.adapterContract, "An eBay offer lookup needs one trimmed SKU.");
    const context = { channelId: scope.channelId, connectionId: scope.connectionId };
    const observedAt = this.deps.clock().toISOString();
    let read: { marketplaceId: string; offers: EbayDiscoveredOffer[] };
    try {
      read = await this.deps.ebay.discoverStockLinkOffers(scope.channelId, scope.connectionId, scope.accountId, asked);
    } catch (error) {
      throw classifyChannelEbayStockLinkError(error, context);
    }
    const parsed = stockLinkOfferLookupSchema.safeParse({ observedAt, sku: asked, marketplaceId: read.marketplaceId,
      offers: read.offers.map(offer => ({ offerId: offer.offerId, sku: offer.sku, status: offer.status, listingId: offer.listingId })) });
    if (!parsed.success) throw refusal(C.adapterContract, "eBay's offers do not fit the stock-link contract.", context);
    return parsed.data;
  }
}

export function createChannelEbayStockLinkAdapter(deps: ChannelEbayStockLinkAdapterDependencies): ChannelEbayStockLinkAdapter {
  return new ChannelEbayStockLinkAdapter(deps);
}
