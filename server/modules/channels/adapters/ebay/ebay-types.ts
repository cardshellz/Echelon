/**
 * eBay API Type Definitions
 *
 * Types for the eBay REST APIs used by the adapter:
 * - Sell Inventory API (items, offers, groups)
 * - Sell Fulfillment API (orders)
 * - Commerce Notification API (webhooks)
 */

// ---------------------------------------------------------------------------
// Inventory API Types
// ---------------------------------------------------------------------------

export interface EbayInventoryItem {
  sku: string;
  locale?: string;
  product: EbayProduct;
  condition: EbayConditionEnum;
  conditionDescription?: string;
  availability: EbayAvailability;
  packageWeightAndSize?: EbayPackageWeightAndSize;
}

export interface EbayProduct {
  title: string;
  description?: string;
  aspects?: Record<string, string[]>;
  brand?: string;
  mpn?: string;
  ean?: string[];
  upc?: string[];
  isbn?: string[];
  imageUrls: string[];
}

export interface EbayAvailability {
  shipToLocationAvailability: {
    quantity: number;
  };
}

export interface EbayPackageWeightAndSize {
  weight?: {
    value: number;
    unit: "POUND" | "KILOGRAM" | "GRAM" | "OUNCE";
  };
  dimensions?: {
    length: number;
    width: number;
    height: number;
    unit: "INCH" | "FEET" | "CENTIMETER" | "METER";
  };
  packageType?: string;
}

export type EbayConditionEnum =
  | "NEW"
  | "LIKE_NEW"
  | "NEW_OTHER"
  | "NEW_WITH_DEFECTS"
  | "MANUFACTURER_REFURBISHED"
  | "CERTIFIED_REFURBISHED"
  | "EXCELLENT_REFURBISHED"
  | "VERY_GOOD_REFURBISHED"
  | "GOOD_REFURBISHED"
  | "SELLER_REFURBISHED"
  | "USED_EXCELLENT"
  | "USED_VERY_GOOD"
  | "USED_GOOD"
  | "USED_ACCEPTABLE"
  | "FOR_PARTS_OR_NOT_WORKING";

// ---------------------------------------------------------------------------
// Offer Types
// ---------------------------------------------------------------------------

export interface EbayOffer {
  sku: string;
  marketplaceId: EbayMarketplaceId;
  format: "FIXED_PRICE";
  availableQuantity: number;
  categoryId: string;
  listingDescription?: string;
  listingPolicies: EbayListingPolicies;
  merchantLocationKey: string;
  pricingSummary: EbayPricingSummary;
  quantityLimitPerBuyer?: number;
  tax?: EbayTax;
  storeCategoryNames?: string[];
  /** Offer ID — returned after creation, used for updates */
  offerId?: string;
}

export interface EbayListingPolicies {
  paymentPolicyId: string;
  returnPolicyId: string;
  fulfillmentPolicyId: string;
}

export interface EbayPricingSummary {
  price: EbayAmount;
  originalRetailPrice?: EbayAmount;
}

export interface EbayAmount {
  value: string; // Decimal string, e.g., "19.99"
  currency: string; // ISO 4217, e.g., "USD"
}

export interface EbayTax {
  applyTax: boolean;
  thirdPartyTaxCategory?: string;
}

export type EbayMarketplaceId =
  | "EBAY_US"
  | "EBAY_CA"
  | "EBAY_GB"
  | "EBAY_AU"
  | "EBAY_DE"
  | "EBAY_FR"
  | "EBAY_IT"
  | "EBAY_ES";

// ---------------------------------------------------------------------------
// Inventory Item Group Types (Multi-Variation Listings)
// ---------------------------------------------------------------------------

export interface EbayInventoryItemGroup {
  aspects: Record<string, string[]>;
  description: string;
  inventoryItemGroupKey: string;
  imageUrls: string[];
  title: string;
  variesBy: EbayVariesBy;
}

export interface EbayVariesBy {
  aspectsImageVariesBy?: string[];
  specifications: EbaySpecification[];
}

export interface EbaySpecification {
  name: string;
  values: string[];
}

// ---------------------------------------------------------------------------
// Bulk Update Types
// ---------------------------------------------------------------------------

export interface EbayBulkPriceQuantityRequest {
  requests: EbayPriceQuantityItem[];
}

export interface EbayPriceQuantityItem {
  offerId: string;
  availableQuantity: number;
  price: EbayAmount;
}

export interface EbayBulkPriceQuantityResponse {
  responses: Array<{
    statusCode: number;
    offerId: string;
    sku: string;
    errors?: EbayError[];
    warnings?: EbayError[];
  }>;
}

// ---------------------------------------------------------------------------
// Fulfillment API Types (Orders)
// ---------------------------------------------------------------------------

export interface EbayOrdersResponse {
  href: string;
  total: number;
  limit: number;
  offset: number;
  orders: EbayOrder[];
  next?: string;
  prev?: string;
}

export interface EbayOrder {
  orderId: string;
  legacyOrderId?: string;
  creationDate: string;
  lastModifiedDate: string;
  orderFulfillmentStatus: "NOT_STARTED" | "IN_PROGRESS" | "FULFILLED";
  orderPaymentStatus: "PENDING" | "FAILED" | "FULLY_REFUNDED" | "PAID" | "PARTIALLY_REFUNDED";
  sellerId: string;
  buyer: {
    username: string;
    taxAddress?: {
      stateOrProvince?: string;
      postalCode?: string;
      countryCode?: string;
    };
  };
  pricingSummary: {
    priceSubtotal: EbayAmount;
    deliveryCost: EbayAmount;
    tax?: EbayAmount;
    total: EbayAmount;
    priceDiscount?: EbayAmount;
  };
  fulfillmentStartInstructions: EbayFulfillmentInstruction[];
  lineItems: EbayOrderLineItem[];
  cancelStatus?: {
    cancelState: string;
    cancelRequests?: Array<{
      cancelReason: string;
      cancelRequestedDate: string;
    }>;
  };
  salesRecordReference?: string;
}

export interface EbayFulfillmentInstruction {
  fulfillmentInstructionsType: string;
  shippingStep: {
    shippingCarrierCode?: string;
    shippingServiceCode: string;
    shipTo: EbayShippingAddress;
  };
}

export interface EbayShippingAddress {
  fullName: string;
  contactAddress: {
    addressLine1: string;
    addressLine2?: string;
    city: string;
    stateOrProvince: string;
    postalCode: string;
    countryCode: string;
  };
  primaryPhone?: {
    phoneNumber: string;
  };
  email?: string;
}

export interface EbayOrderLineItem {
  lineItemId: string;
  legacyItemId?: string;
  legacyVariationId?: string;
  sku: string;
  title: string;
  quantity: number;
  lineItemCost: EbayAmount;
  deliveryCost?: {
    shippingCost: EbayAmount;
  };
  tax?: {
    amount: EbayAmount;
  };
  discountedLineItemCost?: EbayAmount;
  total: EbayAmount;
  lineItemFulfillmentStatus: "NOT_STARTED" | "IN_PROGRESS" | "FULFILLED";
}

// ---------------------------------------------------------------------------
// Fulfillment Push Types
// ---------------------------------------------------------------------------

export interface EbayShippingFulfillmentRequest {
  lineItems: Array<{
    lineItemId: string;
    quantity: number;
  }>;
  shippedDate: string; // ISO 8601
  shippingCarrierCode: string;
  trackingNumber: string;
}

export interface EbayShippingFulfillmentResponse {
  fulfillmentId: string;
}

// ---------------------------------------------------------------------------
// OAuth Types
// ---------------------------------------------------------------------------

export interface EbayTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  token_type: string;
  refresh_token?: string;
  refresh_token_expires_in?: number; // seconds
}

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export interface EbayError {
  errorId: number;
  domain: string;
  subdomain?: string;
  category: string;
  message: string;
  longMessage?: string;
  parameters?: Array<{
    name: string;
    value: string;
  }>;
}

export interface EbayErrorResponse {
  errors: EbayError[];
  warnings?: EbayError[];
}

// ---------------------------------------------------------------------------
// Notification Types
// ---------------------------------------------------------------------------

export interface EbayNotificationPayload {
  metadata: {
    topic: string;
    schemaVersion: string;
    deprecated: boolean;
  };
  notification: {
    notificationId: string;
    eventDate: string;
    publishDate: string;
    publishAttemptCount: number;
    data: Record<string, unknown>;
  };
}

export interface EbayOrderConfirmationData {
  orderId: string;
  legacyOrderId?: string;
}
