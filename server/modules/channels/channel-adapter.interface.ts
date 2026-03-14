/**
 * Channel Adapter Interface
 *
 * Standardized contract that ALL channel adapters must implement.
 * Channel-agnostic — no Shopify, eBay, or any platform-specific
 * assumptions in this contract.
 *
 * Each adapter handles the transformation from Echelon's canonical
 * format to the channel's native API format and back.
 */

// ---------------------------------------------------------------------------
// Canonical Types — channel-agnostic data structures
// ---------------------------------------------------------------------------

/** Product listing data ready to push to a channel */
export interface ChannelListingPayload {
  productId: number;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[] | null;
  status: "active" | "draft" | "archived";
  variants: ChannelVariantPayload[];
  images: ChannelImagePayload[];
  /** Channel-specific metadata (item specifics, listing format, etc.) */
  metadata?: Record<string, unknown>;
}

export interface ChannelVariantPayload {
  variantId: number;
  sku: string | null;
  name: string;
  barcode: string | null;
  gtin: string | null;
  mpn: string | null;
  weightGrams: number | null;
  priceCents: number | null;
  compareAtPriceCents: number | null;
  isListed: boolean;
  /** External variant ID on the channel (null = new) */
  externalVariantId: string | null;
  /** External inventory item ID on the channel */
  externalInventoryItemId: string | null;
}

export interface ChannelImagePayload {
  url: string;
  altText: string | null;
  position: number;
  variantSku: string | null;
}

/** Result from pushing a listing to a channel */
export interface ListingPushResult {
  productId: number;
  status: "created" | "updated" | "skipped" | "error";
  externalProductId?: string;
  externalVariantIds?: Record<number, string>; // variantId → externalVariantId
  error?: string;
}

/** Per-variant inventory quantity to push */
export interface InventoryPushItem {
  variantId: number;
  sku: string | null;
  externalVariantId: string | null;
  externalInventoryItemId: string | null;
  allocatedQty: number; // From allocation engine, NOT raw ATP
  /** Per-warehouse breakdown (for channels that support multi-location) */
  warehouseBreakdown?: Array<{
    warehouseId: number;
    externalLocationId: string;
    qty: number;
  }>;
}

export interface InventoryPushResult {
  variantId: number;
  pushedQty: number;
  status: "success" | "error" | "skipped";
  error?: string;
}

/** Per-variant pricing to push */
export interface PricingPushItem {
  variantId: number;
  externalVariantId: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  currency: string;
}

export interface PricingPushResult {
  variantId: number;
  status: "success" | "error" | "skipped";
  error?: string;
}

/** Canonical order from any channel */
export interface ChannelOrder {
  externalOrderId: string;
  channelId: number;
  source: string; // shopify, ebay, tiktok, etc.
  customerEmail: string | null;
  customerName: string | null;
  shippingAddress: {
    name: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    country: string | null;
    phone: string | null;
  } | null;
  lineItems: ChannelOrderLineItem[];
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  discountCents: number;
  totalCents: number;
  currency: string;
  financialStatus: string | null; // paid, pending, refunded, etc.
  fulfillmentStatus: string | null; // unfulfilled, fulfilled, partial
  notes: string | null;
  tags: string[] | null;
  orderDate: Date;
  rawPayload?: unknown; // Original payload for debugging
}

export interface ChannelOrderLineItem {
  externalLineItemId: string;
  sku: string;
  title: string;
  quantity: number;
  priceCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

/** Order ingestion result */
export interface OrderIngestionResult {
  externalOrderId: string;
  status: "created" | "updated" | "duplicate" | "error";
  internalOrderId?: number;
  error?: string;
}

/** Fulfillment/tracking data to push to a channel */
export interface FulfillmentPayload {
  externalOrderId: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  lineItems: Array<{
    externalLineItemId: string;
    quantity: number;
  }>;
  notifyCustomer: boolean;
}

export interface FulfillmentPushResult {
  externalOrderId: string;
  externalFulfillmentId?: string;
  status: "success" | "error" | "skipped";
  error?: string;
}

/** Cancellation data to push to a channel */
export interface CancellationPayload {
  externalOrderId: string;
  reason: string | null;
  /** Specific line items to cancel (null = full order cancellation) */
  lineItems: Array<{
    externalLineItemId: string;
    quantity: number;
  }> | null;
  notifyCustomer: boolean;
  refund: boolean;
}

export interface CancellationPushResult {
  externalOrderId: string;
  status: "success" | "error" | "not_supported";
  error?: string;
}

// ---------------------------------------------------------------------------
// Channel Adapter Interface
// ---------------------------------------------------------------------------

/**
 * The contract every channel adapter must implement.
 *
 * Adapters are responsible for:
 * 1. Translating Echelon's canonical data into the channel's native format
 * 2. Making API calls to the channel
 * 3. Translating channel responses back into canonical format
 * 4. Handling rate limits, retries, and error mapping
 *
 * Adapters are NOT responsible for:
 * - Allocation logic (handled by allocation engine)
 * - Source lock checks (handled by orchestration layer)
 * - Audit logging (handled by orchestration layer)
 * - Database writes to Echelon tables (handled by orchestration layer)
 */
export interface IChannelAdapter {
  /** Human-readable adapter name (e.g., "Shopify", "eBay") */
  readonly adapterName: string;

  /** Provider key matching channels.provider column */
  readonly providerKey: string;

  // -------------------------------------------------------------------------
  // Listings
  // -------------------------------------------------------------------------

  /**
   * Push product listings to the channel.
   * Creates new listings or updates existing ones.
   *
   * @param channelId - Internal channel ID
   * @param listings - Array of product listings to push
   * @returns Per-product results
   */
  pushListings(
    channelId: number,
    listings: ChannelListingPayload[],
  ): Promise<ListingPushResult[]>;

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  /**
   * Push allocated inventory quantities to the channel.
   * Uses allocation engine output, NOT raw ATP.
   *
   * @param channelId - Internal channel ID
   * @param items - Per-variant allocated quantities
   * @returns Per-variant push results
   */
  pushInventory(
    channelId: number,
    items: InventoryPushItem[],
  ): Promise<InventoryPushResult[]>;

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  /**
   * Push pricing updates to the channel.
   * Uses channel_pricing table values (with markups already applied).
   *
   * @param channelId - Internal channel ID
   * @param items - Per-variant pricing
   * @returns Per-variant push results
   */
  pushPricing(
    channelId: number,
    items: PricingPushItem[],
  ): Promise<PricingPushResult[]>;

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  /**
   * Pull orders from the channel via polling.
   * The adapter handles pagination, date filtering, etc.
   *
   * @param channelId - Internal channel ID
   * @param since - Only fetch orders created/updated after this time
   * @returns Canonical orders ready for ingestion
   */
  pullOrders(
    channelId: number,
    since: Date,
  ): Promise<ChannelOrder[]>;

  /**
   * Receive and parse an order from a webhook/push notification.
   * The adapter validates the payload and converts to canonical format.
   *
   * @param channelId - Internal channel ID
   * @param rawPayload - The raw webhook body
   * @param headers - HTTP headers for signature verification
   * @returns Canonical order, or null if the payload is not an order event
   */
  receiveOrder(
    channelId: number,
    rawPayload: unknown,
    headers: Record<string, string>,
  ): Promise<ChannelOrder | null>;

  // -------------------------------------------------------------------------
  // Fulfillment
  // -------------------------------------------------------------------------

  /**
   * Push fulfillment/tracking information to the channel.
   *
   * @param channelId - Internal channel ID
   * @param fulfillments - Array of fulfillment payloads
   * @returns Per-order fulfillment results
   */
  pushFulfillment(
    channelId: number,
    fulfillments: FulfillmentPayload[],
  ): Promise<FulfillmentPushResult[]>;

  // -------------------------------------------------------------------------
  // Cancellations (stub — future implementation)
  // -------------------------------------------------------------------------

  /**
   * Push cancellation to the channel.
   * Currently a stub — implementations should return "not_supported".
   *
   * @param channelId - Internal channel ID
   * @param cancellations - Array of cancellation payloads
   * @returns Per-order cancellation results
   */
  pushCancellation(
    channelId: number,
    cancellations: CancellationPayload[],
  ): Promise<CancellationPushResult[]>;
}

// ---------------------------------------------------------------------------
// Adapter Registry
// ---------------------------------------------------------------------------

/**
 * Registry of channel adapters by provider key.
 * The orchestration layer uses this to route operations to the correct adapter.
 */
export class ChannelAdapterRegistry {
  private adapters = new Map<string, IChannelAdapter>();

  register(adapter: IChannelAdapter): void {
    if (this.adapters.has(adapter.providerKey)) {
      throw new Error(`Adapter already registered for provider "${adapter.providerKey}"`);
    }
    this.adapters.set(adapter.providerKey, adapter);
    console.log(`[AdapterRegistry] Registered adapter: ${adapter.adapterName} (${adapter.providerKey})`);
  }

  get(providerKey: string): IChannelAdapter | undefined {
    return this.adapters.get(providerKey);
  }

  getOrThrow(providerKey: string): IChannelAdapter {
    const adapter = this.adapters.get(providerKey);
    if (!adapter) {
      throw new Error(`No adapter registered for provider "${providerKey}"`);
    }
    return adapter;
  }

  has(providerKey: string): boolean {
    return this.adapters.has(providerKey);
  }

  getAll(): IChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  getRegisteredProviders(): string[] {
    return Array.from(this.adapters.keys());
  }
}
