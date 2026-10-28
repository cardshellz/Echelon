import {
  stockLinkDestinationSchema, stockLinkOfferLookupSchema, type StockLinkDestination, type StockLinkOfferLookup,
} from "@shared/types/stock-link";
import type { StockLinkOfferAdapter, StockLinkProviderCallOptions } from "../../inventory-planning/application/stock-link.ports";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../../inventory-planning/domain/stock-link-errors";
import {
  EbayInventoryQuantityError, discoverEbayInventoryOffers, ebayInventoryMarketplace, ebayInventoryOffersPath,
} from "../../channels/adapters/ebay/ebay-inventory-quantity";
import { boundedProviderRetryAfterSeconds } from "../../channels/provider-request-limits";
import { DropshipError } from "../domain/errors";
import { ebaySellRequestHeaders } from "./ebay-sell-headers";
import type { DropshipInventoryPublicationDestinationReader } from "./dropship-ebay-inventory-publication.adapter";
import {
  resolveDropshipEbayProviderEnvironment, type DropshipEbayRegistrationCredentialProvider,
} from "./dropship-ebay-registration-credentials";

/**
 * The stock-link engine's Dropship eBay adapter (channels PR3, PLAN-CH-v3 §2 "Adapters", §9 PR3): one read-only call
 * shape, every offer eBay holds for one SKU on the vendor store's marketplace, with that store's own login. It is the
 * same offer discovery the Dropship quantity transport writes through (channels ebay-inventory-quantity.ts
 * discoverEbayInventoryOffers: page bound, pagination checks, exact SKU and marketplace), so the link and the write
 * read eBay the same way. It decides nothing (unpublished offers are returned with their status) and never writes:
 * no quantity, no offer, no credential health row. Every refusal is a classified StockLinkError (its class comes
 * from the engine's table, domain/stock-link-errors.ts); a refusal of the whole store is destination-scoped, a 4xx
 * naming this one SKU's request is the row's (STOCK_LINK_LOOKUP_REJECTED). No retry inside: the tick decides.
 */

const EBAY_BASE_URLS = Object.freeze({ sandbox: "https://api.sandbox.ebay.com", production: "https://api.ebay.com" });
/** One request's bound; the tick's own signal (30 s / 45 s budget) can stop it sooner. */
export const DROPSHIP_EBAY_STOCK_LINK_REQUEST_TIMEOUT_MS = 15_000;
/** Retry-After fallback when eBay throttles without one (seconds; bounded by PROVIDER_RETRY_AFTER_MAX_SECONDS). */
const THROTTLE_RETRY_AFTER_FALLBACK_SECONDS = 15;

const C = STOCK_LINK_ERROR_CODES;

export interface DropshipEbayStockLinkAdapterDependencies {
  readonly destinations: DropshipInventoryPublicationDestinationReader;
  readonly credentials: DropshipEbayRegistrationCredentialProvider;
  readonly fetch?: typeof fetch;
  readonly clock: () => Date;
}

function refusal(code: string, message: string, context: Readonly<Record<string, unknown>> = {},
  options?: ErrorOptions & { retryAfterMs?: number | null }): StockLinkError {
  return new StockLinkError(code, message, context, options);
}

function scopeOf(destination: StockLinkDestination): { storeConnectionId: number; accountId: string } {
  const parsed = stockLinkDestinationSchema.safeParse(destination);
  if (!parsed.success || parsed.data.destinationKind !== "dropship_store_connection" || parsed.data.providerKey !== "ebay"
    || parsed.data.dropshipStoreConnectionId === null || parsed.data.providerScopeType !== "account") {
    throw refusal(C.adapterContract, "The Dropship eBay stock-link adapter was given another kind of destination.");
  }
  return { storeConnectionId: parsed.data.dropshipStoreConnectionId, accountId: parsed.data.externalScopeId };
}

/** A page of offers as discovery reads it; a 404 on the first page is eBay's "this SKU has no offer" (25713). */
type OffersPage = Record<string, unknown>;

export class DropshipEbayStockLinkAdapter implements StockLinkOfferAdapter {
  readonly destinationKind = "dropship_store_connection" as const;
  readonly providerKey = "ebay";
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: DropshipEbayStockLinkAdapterDependencies) {
    this.fetchFn = deps.fetch ?? fetch;
  }

  async findOffersBySku(destination: StockLinkDestination, sku: string, options: StockLinkProviderCallOptions): Promise<StockLinkOfferLookup> {
    const scope = scopeOf(destination);
    const asked = sku.trim();
    if (asked.length === 0 || asked !== sku) throw refusal(C.adapterContract, "A Dropship eBay offer lookup needs one trimmed SKU.");
    const store = await this.deps.destinations.load(scope.storeConnectionId);
    if (!store || store.storeConnectionId !== scope.storeConnectionId || store.providerKey !== "ebay") {
      throw refusal(C.adapterContract, "The Dropship eBay store connection is not this destination's.", { storeConnectionId: scope.storeConnectionId });
    }
    // A paused or disconnected store answers nothing for now; the pause lifts on the first answered read.
    if (store.status !== "connected") {
      throw refusal(C.storeUnavailable, "The Dropship eBay store is not connected.", { storeConnectionId: scope.storeConnectionId, status: store.status });
    }
    const credential = await this.loadCredential(store.vendorId, scope.storeConnectionId);
    if (credential.vendorId !== store.vendorId || credential.storeConnectionId !== scope.storeConnectionId || credential.platform !== "ebay"
      || credential.externalAccountIdentityScheme !== "provider_user_id" || credential.externalAccountId?.trim() !== scope.accountId) {
      // The login is not the destination's verified eBay account: nothing is read with it until it is reconnected.
      throw refusal(C.storeAuthRefused, "The Dropship eBay login is not the destination's verified account.",
        { storeConnectionId: scope.storeConnectionId });
    }
    let marketplaceId: string;
    let baseUrl: string;
    try {
      marketplaceId = ebayInventoryMarketplace(credential.config.marketplaceId);
      baseUrl = EBAY_BASE_URLS[resolveDropshipEbayProviderEnvironment(credential)];
    } catch (error) {
      throw refusal(C.providerRejected, "The Dropship eBay store's marketplace or environment is not configured.",
        { storeConnectionId: scope.storeConnectionId }, { cause: error });
    }
    const observedAt = this.deps.clock().toISOString();
    let offers;
    try {
      offers = await discoverEbayInventoryOffers({ getInventoryOffersPage: (pageSku, pageMarketplace, offset, limit) =>
        this.readOffersPage(baseUrl, credential.accessToken, ebayInventoryOffersPath(pageSku, pageMarketplace, offset, limit),
          marketplaceId, offset, scope.storeConnectionId, options.signal) }, asked, marketplaceId);
    } catch (error) {
      if (error instanceof StockLinkError) throw error;
      if (error instanceof EbayInventoryQuantityError) {
        // An invalid, changing or over-long discovery may pass next time; another SKU or marketplace in the answer is
        // a broken contract (never trusted).
        throw error.retryable
          ? refusal(C.lookupIncomplete, "eBay's offer discovery was incomplete.", { storeConnectionId: scope.storeConnectionId, code: error.code }, { cause: error })
          : refusal(C.adapterContract, "eBay's offer discovery broke its contract.", { storeConnectionId: scope.storeConnectionId, code: error.code }, { cause: error });
      }
      throw error;
    }
    const parsed = stockLinkOfferLookupSchema.safeParse({ observedAt, sku: asked, marketplaceId,
      offers: offers.map(offer => ({ offerId: offer.offerId, sku: offer.sku, status: offer.status, listingId: offer.listingId })) });
    if (!parsed.success) throw refusal(C.adapterContract, "eBay's offers do not fit the stock-link contract.", { storeConnectionId: scope.storeConnectionId });
    return parsed.data;
  }

  /** The store's fresh login (the shared token owner refreshes it when due); a refusal pauses or retries the store. */
  private async loadCredential(vendorId: number, storeConnectionId: number) {
    try {
      return await this.deps.credentials.loadFreshForStoreConnection({ vendorId, storeConnectionId, operation: "stock-link-read" });
    } catch (error) {
      if (error instanceof DropshipError) {
        // A refresh that may pass (eBay down) retries; a login that cannot be used pauses the store until it is fixed.
        throw error.context?.retryable === true
          ? refusal(C.providerUnavailable, "The Dropship eBay login could not be refreshed now.", { storeConnectionId, code: error.code }, { cause: error })
          : refusal(C.storeAuthRefused, "The Dropship eBay login cannot be used.", { storeConnectionId, code: error.code }, { cause: error });
      }
      throw error;
    }
  }

  private async readOffersPage(baseUrl: string, accessToken: string, path: string, marketplaceId: string, offset: number,
    storeConnectionId: number, signal: AbortSignal): Promise<OffersPage> {
    let response: Response;
    try {
      response = await this.fetchFn(`${baseUrl}${path}`, {
        method: "GET", redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(DROPSHIP_EBAY_STOCK_LINK_REQUEST_TIMEOUT_MS)]),
        headers: ebaySellRequestHeaders({ accessToken, method: "GET", marketplaceId }),
      });
    } catch (error) {
      throw refusal(C.providerUnavailable, "eBay did not answer the offer lookup.", { storeConnectionId,
        errorName: error instanceof Error ? error.name : "UnknownError" }, { cause: error });
    }
    const status = response.status;
    const text = await response.text().catch(() => "");
    if (status === 404 && offset === 0) return { total: 0, offers: [] };
    if (status === 401 || status === 403) throw refusal(C.storeAuthRefused, `eBay refused the store's login (HTTP ${status}).`, { storeConnectionId, status });
    if (status === 429) {
      const seconds = boundedProviderRetryAfterSeconds(response.headers.get("retry-after"), THROTTLE_RETRY_AFTER_FALLBACK_SECONDS);
      throw refusal(C.providerThrottled, "eBay throttled the offer lookup.", { storeConnectionId, status }, { retryAfterMs: seconds * 1_000 });
    }
    if (status === 408 || status === 425 || status >= 500) {
      throw refusal(C.providerUnavailable, `eBay could not answer the offer lookup (HTTP ${status}).`, { storeConnectionId, status });
    }
    if (status < 200 || status >= 300) {
      // Any other refusal names this one SKU's request (eBay looks up one SKU a call): the size stops, the store goes on.
      throw refusal(C.lookupRejected, `eBay refused the offer lookup (HTTP ${status}).`, { storeConnectionId, status });
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as OffersPage;
    } catch {
      // Classified below without exposing the provider body.
    }
    throw refusal(C.providerResponseInvalid, "eBay's offer lookup was not valid JSON.", { storeConnectionId, status });
  }
}

export function createDropshipEbayStockLinkAdapter(deps: DropshipEbayStockLinkAdapterDependencies): DropshipEbayStockLinkAdapter {
  return new DropshipEbayStockLinkAdapter(deps);
}
