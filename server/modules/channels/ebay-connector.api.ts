/**
 * Internal API facade for shared eBay connector primitives (CI-03 / CHN-2).
 *
 * Peer modules (`catalog`, `dropship`, `marketplace-listings`, `oms`) must
 * import shared eBay API clients, auth helpers, quantity transport, listing
 * builders, and wire contracts through this facade rather than reaching into
 * `channels/adapters/ebay/*`.
 */

export {
  EbayApiClient,
  createEbayApiClient,
  EBAY_FULFILLMENT_IDEMPOTENCY_CONFLICT,
  EbayFulfillmentIdempotencyConflictError,
} from "./adapters/ebay/ebay-api.client";
export {
  EbayAuthService,
  createEbayAuthConfig,
} from "./adapters/ebay/ebay-auth.service";
export {
  EbayApiRequestError,
  isMissingEbayOfferCollection,
} from "./adapters/ebay/ebay-api-error";
export {
  EbayListingBuilder,
  type EbayListingConfig,
} from "./adapters/ebay/ebay-listing-builder";
export {
  readEbayPublishedContent,
} from "./adapters/ebay/ebay-published-content.reader";
export {
  readEbayNativePackage,
} from "./adapters/ebay/ebay-native-package.reader";
export {
  normalizeEbayObservedOffers,
} from "./adapters/ebay/ebay-offer-observation";
export {
  executeEbayQuantityHttp,
  executeEbayQuantityHttpResponse,
  EbayQuantityResponseUncertainError,
} from "./adapters/ebay/ebay-quantity-http";
export {
  sendEbayQuantityUpdates,
} from "./adapters/ebay/ebay-quantity-update";
export {
  EbayInventoryQuantityError,
  EbayInventoryQuantityPreflightError,
  discoverEbayInventoryOffers,
  ebayInventoryMarketplace,
  ebayInventoryOffersPath,
  publishEbayInventoryQuantity,
  readEbayInventoryQuantity,
  type EbayInventoryQuantityClient,
  type EbayResolvedPublishedOffer,
} from "./adapters/ebay/ebay-inventory-quantity";
export {
  buildEbayShippingFulfillmentPath,
  normalizeEbayTrackingNumber,
} from "./adapters/ebay/ebay-fulfillment.util";
export {
  mapCarrierToEbay,
} from "./adapters/ebay/ebay-category-map";
export type {
  EbayAmount,
  EbayBulkPriceQuantityRequest,
  EbayBulkPriceQuantityResponse,
  EbayInventoryItem,
  EbayInventoryItemGroup,
  EbayListingPolicies,
  EbayNotificationPayload,
  EbayOffer,
  EbayOrder,
  EbayOrderLineItem,
  EbayOrdersResponse,
  EbayShippingFulfillmentRequest,
  EbayShippingFulfillmentResponse,
} from "./adapters/ebay/ebay-types";
