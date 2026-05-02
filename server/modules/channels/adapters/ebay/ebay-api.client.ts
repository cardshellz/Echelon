/**
 * eBay REST API Client
 *
 * Handles all HTTP communication with eBay's REST APIs:
 * - Automatic OAuth2 token injection via EbayAuthService
 * - Exponential backoff with jitter on retries
 * - Rate limit header parsing and respect
 * - DRY_RUN mode support (logs but doesn't call)
 * - Request/response logging for debugging
 */

import type { EbayAuthService } from "./ebay-auth.service";
import type {
  EbayInventoryItem,
  EbayOffer,
  EbayInventoryItemGroup,
  EbayOrdersResponse,
  EbayShippingFulfillmentRequest,
  EbayShippingFulfillmentResponse,
  EbayBulkPriceQuantityRequest,
  EbayBulkPriceQuantityResponse,
  EbayErrorResponse,
} from "./ebay-types";
import {
  buildEbayShippingFulfillmentPath,
  extractEbayFulfillmentIdFromLocation,
} from "./ebay-fulfillment.util";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE_URLS = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
} as const;

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 15000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

interface RequestOptions {
  method: HttpMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** If true, expect 204 No Content response */
  expectNoContent?: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class EbayApiClient {
  private readonly baseUrl: string;
  private readonly isDryRun: boolean;

  constructor(
    private readonly authService: EbayAuthService,
    private readonly channelId: number,
    private readonly environment: "sandbox" | "production" = "production",
  ) {
    this.baseUrl = API_BASE_URLS[environment];
    this.isDryRun = process.env.DRY_RUN === "true";
  }

  // -------------------------------------------------------------------------
  // Inventory API — Inventory Items
  // -------------------------------------------------------------------------

  /**
   * Create or replace an inventory item by SKU.
   * PUT /sell/inventory/v1/inventory_item/{sku}
   * Idempotent — safe to call repeatedly.
   */
  async createOrReplaceInventoryItem(
    sku: string,
    item: Omit<EbayInventoryItem, "sku">,
  ): Promise<void> {
    await this.request({
      method: "PUT",
      path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      body: item,
      headers: { "Content-Language": "en-US" },
      expectNoContent: true,
    });
  }

  /**
   * Get an inventory item by SKU.
   * GET /sell/inventory/v1/inventory_item/{sku}
   */
  async getInventoryItem(sku: string): Promise<EbayInventoryItem | null> {
    try {
      return await this.request({
        method: "GET",
        path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      });
    } catch (err: any) {
      if (err.message?.includes("404")) return null;
      throw err;
    }
  }

  /**
   * Delete an inventory item by SKU.
   * DELETE /sell/inventory/v1/inventory_item/{sku}
   */
  async deleteInventoryItem(sku: string): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      expectNoContent: true,
    });
  }

  // -------------------------------------------------------------------------
  // Inventory API — Offers
  // -------------------------------------------------------------------------

  /**
   * Create an offer for a SKU.
   * POST /sell/inventory/v1/offer
   * Returns the offerId.
   */
  async createOffer(offer: EbayOffer): Promise<string> {
    const response = await this.request({
      method: "POST",
      path: "/sell/inventory/v1/offer",
      body: offer,
    });
    return response?.offerId || "";
  }

  /**
   * Update an existing offer.
   * PUT /sell/inventory/v1/offer/{offerId}
   */
  async updateOffer(offerId: string, offer: EbayOffer): Promise<void> {
    await this.request({
      method: "PUT",
      path: `/sell/inventory/v1/offer/${offerId}`,
      body: offer,
      expectNoContent: true,
    });
  }

  /**
   * Get offers for a SKU.
   * GET /sell/inventory/v1/offer?sku={sku}&marketplace_id=EBAY_US
   */
  async getOffers(
    sku: string,
    marketplaceId: string = "EBAY_US",
  ): Promise<{ offers: Array<EbayOffer & { offerId: string; listingId?: string }> }> {
    try {
      return await this.request({
        method: "GET",
        path: `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`,
      });
    } catch (err: any) {
      if (err.message?.includes("404")) return { offers: [] };
      throw err;
    }
  }

  /**
   * Publish an offer (single-variation listing).
   * POST /sell/inventory/v1/offer/{offerId}/publish
   */
  async publishOffer(offerId: string): Promise<{ listingId: string }> {
    return await this.request({
      method: "POST",
      path: `/sell/inventory/v1/offer/${offerId}/publish`,
    });
  }

  /**
   * Bulk update price and quantity for offers.
   * POST /sell/inventory/v1/bulk_update_price_quantity
   */
  async bulkUpdatePriceQuantity(
    request: EbayBulkPriceQuantityRequest,
  ): Promise<EbayBulkPriceQuantityResponse> {
    return await this.request({
      method: "POST",
      path: "/sell/inventory/v1/bulk_update_price_quantity",
      body: request,
    });
  }

  // -------------------------------------------------------------------------
  // Inventory API — Inventory Item Groups (Multi-Variation)
  // -------------------------------------------------------------------------

  /**
   * Create or replace an inventory item group.
   * PUT /sell/inventory/v1/inventory_item_group/{inventoryItemGroupKey}
   * Idempotent.
   */
  async createOrReplaceInventoryItemGroup(
    groupKey: string,
    group: Omit<EbayInventoryItemGroup, "inventoryItemGroupKey">,
  ): Promise<void> {
    await this.request({
      method: "PUT",
      path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
      body: { ...group, inventoryItemGroupKey: groupKey },
      headers: { "Content-Language": "en-US" },
      expectNoContent: true,
    });
  }

  /**
   * Publish offers by inventory item group (multi-variation listing).
   * POST /sell/inventory/v1/offer/publish_by_inventory_item_group
   */
  async publishOfferByInventoryItemGroup(
    inventoryItemGroupKey: string,
    marketplaceId: string = "EBAY_US",
  ): Promise<{ listingId: string }> {
    return await this.request({
      method: "POST",
      path: "/sell/inventory/v1/offer/publish_by_inventory_item_group",
      body: { inventoryItemGroupKey, marketplaceId },
    });
  }

  // -------------------------------------------------------------------------
  // Fulfillment API — Orders
  // -------------------------------------------------------------------------

  /**
   * Get orders with filters.
   * GET /sell/fulfillment/v1/order
   */
  async getOrders(params: {
    filter?: string;
    limit?: number;
    offset?: number;
  }): Promise<EbayOrdersResponse> {
    const searchParams = new URLSearchParams();
    if (params.filter) searchParams.set("filter", params.filter);
    if (params.limit) searchParams.set("limit", String(params.limit));
    if (params.offset) searchParams.set("offset", String(params.offset));

    const query = searchParams.toString();
    return await this.request({
      method: "GET",
      path: `/sell/fulfillment/v1/order${query ? `?${query}` : ""}`,
    });
  }

  /**
   * Get a single order by ID.
   * GET /sell/fulfillment/v1/order/{orderId}
   */
  async getOrder(orderId: string): Promise<any> {
    return await this.request({
      method: "GET",
      path: `/sell/fulfillment/v1/order/${orderId}`,
    });
  }

  // -------------------------------------------------------------------------
  // Fulfillment API — Shipping Fulfillment
  // -------------------------------------------------------------------------

  /**
   * Create a shipping fulfillment for an order.
   * POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment
   *
   * eBay returns 201 Created with an empty body. The fulfillment ID is
   * only available in the `Location` response header
   * (e.g. …/shipping_fulfillment/{fulfillmentId}).  We extract it there
   * so callers always get a usable `fulfillmentId`.
   */
  async createShippingFulfillment(
    orderId: string,
    fulfillment: EbayShippingFulfillmentRequest,
  ): Promise<EbayShippingFulfillmentResponse> {
    const path = buildEbayShippingFulfillmentPath(orderId);

    // DRY_RUN: log but don't call
    if (this.isDryRun) {
      console.log(
        `[EbayApi] DRY_RUN: POST ${path}`,
        JSON.stringify(fulfillment).substring(0, 500),
      );
      return { fulfillmentId: "DRY_RUN_FULFILLMENT_ID" };
    }

    const accessToken = await this.authService.getAccessToken(this.channelId);
    const url = `${this.baseUrl}${path}`;

    return await this.createShippingFulfillmentWithRetry(
      path,
      url,
      accessToken,
      fulfillment,
    );
  }

  private async createShippingFulfillmentWithRetry(
    path: string,
    url: string,
    accessToken: string,
    fulfillment: EbayShippingFulfillmentRequest,
  ): Promise<EbayShippingFulfillmentResponse> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
          },
          body: JSON.stringify(fulfillment),
        });

        if (response.status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = parseInt(response.headers.get("Retry-After") || "5", 10);
          console.warn(
            `[EbayApi] Rate limited on POST ${path}, retrying in ${retryAfter}s (attempt ${attempt}/${MAX_RETRIES})`,
          );
          await this.delay(retryAfter * 1000);
          continue;
        }

        if (response.ok) {
          return await this.parseCreateShippingFulfillmentResponse(response);
        }

        const errorBody = await response.text();
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          const delay = this.getRetryDelay(attempt);
          console.warn(
            `[EbayApi] Server error ${response.status} on POST ${path}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`,
          );
          await this.delay(delay);
          continue;
        }

        throw new Error(
          `eBay API POST ${path} failed (${response.status}): ${this.formatEbayError(errorBody)}`,
        );
      } catch (err: any) {
        if (
          attempt < MAX_RETRIES &&
          (err.code === "ECONNRESET" ||
            err.code === "ETIMEDOUT" ||
            err.code === "ENOTFOUND" ||
            err.message?.includes("fetch failed"))
        ) {
          const delay = this.getRetryDelay(attempt);
          console.warn(
            `[EbayApi] Network error on POST ${path}: ${err.message}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`,
          );
          await this.delay(delay);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`eBay API POST ${path} failed after ${MAX_RETRIES} retries`);
  }

  private async parseCreateShippingFulfillmentResponse(
    response: Response,
  ): Promise<EbayShippingFulfillmentResponse> {
    const fulfillmentId = extractEbayFulfillmentIdFromLocation(
      response.headers.get("Location") || response.headers.get("location"),
    );
    if (fulfillmentId) {
      return { fulfillmentId };
    }

    const text = await response.text();
    if (text) {
      try {
        return JSON.parse(text);
      } catch { /* fall through */ }
    }

    return {} as EbayShippingFulfillmentResponse;
  }

  private formatEbayError(errorBody: string): string {
    let errorDetail = errorBody;
    try {
      const parsed: EbayErrorResponse = JSON.parse(errorBody);
      errorDetail =
        parsed.errors
          ?.map((e) => `[${e.errorId}] ${e.message}`)
          .join("; ") || errorBody;
    } catch { /* use raw body */ }
    return errorDetail;
  }

  // -------------------------------------------------------------------------
  // Core HTTP Request Method
  // -------------------------------------------------------------------------

  private async request<T = any>(options: RequestOptions): Promise<T> {
    const { method, path, body, headers: extraHeaders, expectNoContent } = options;
    const url = `${this.baseUrl}${path}`;

    // DRY_RUN: log but don't execute writes
    if (this.isDryRun && method !== "GET") {
      console.log(
        `[EbayApi] DRY_RUN: ${method} ${path}`,
        body ? JSON.stringify(body).substring(0, 500) : "",
      );
      // Return plausible mock response
      if (expectNoContent) return undefined as T;
      return { offerId: "DRY_RUN_OFFER_ID", listingId: "DRY_RUN_LISTING_ID" } as T;
    }

    const accessToken = await this.authService.getAccessToken(this.channelId);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
            ...extraHeaders,
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        // Rate limit handling
        if (response.status === 429) {
          const retryAfter = parseInt(
            response.headers.get("Retry-After") || "5",
            10,
          );
          console.warn(
            `[EbayApi] Rate limited on ${method} ${path}, ` +
            `retrying in ${retryAfter}s (attempt ${attempt}/${MAX_RETRIES})`,
          );
          await this.delay(retryAfter * 1000);
          continue;
        }

        // 204 No Content (success for PUT/DELETE operations)
        if (response.status === 204) {
          return undefined as T;
        }

        // Success
        if (response.ok) {
          const text = await response.text();
          return text ? JSON.parse(text) : (undefined as T);
        }

        // Client errors (4xx) — don't retry (except 429 handled above)
        if (response.status >= 400 && response.status < 500) {
          const errorBody = await response.text();
          let errorDetail = errorBody;
          try {
            const parsed: EbayErrorResponse = JSON.parse(errorBody);
            errorDetail = parsed.errors
              ?.map((e) => `[${e.errorId}] ${e.message}`)
              .join("; ") || errorBody;
          } catch { /* use raw body */ }

          throw new Error(
            `eBay API ${method} ${path} failed (${response.status}): ${errorDetail}`,
          );
        }

        // Server errors (5xx) — retry with backoff
        if (response.status >= 500) {
          const errorBody = await response.text();
          if (attempt < MAX_RETRIES) {
            const delay = this.getRetryDelay(attempt);
            console.warn(
              `[EbayApi] Server error ${response.status} on ${method} ${path}, ` +
              `retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`,
            );
            await this.delay(delay);
            continue;
          }
          throw new Error(
            `eBay API ${method} ${path} failed after ${MAX_RETRIES} retries (${response.status}): ${errorBody}`,
          );
        }
      } catch (err: any) {
        // Network errors — retry
        if (
          attempt < MAX_RETRIES &&
          (err.code === "ECONNRESET" ||
            err.code === "ETIMEDOUT" ||
            err.code === "ENOTFOUND" ||
            err.message?.includes("fetch failed"))
        ) {
          const delay = this.getRetryDelay(attempt);
          console.warn(
            `[EbayApi] Network error on ${method} ${path}: ${err.message}, ` +
            `retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`,
          );
          await this.delay(delay);
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      `eBay API ${method} ${path} failed after ${MAX_RETRIES} retries`,
    );
  }

  private getRetryDelay(attempt: number): number {
    // Exponential backoff with jitter
    const base = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.random() * base * 0.5;
    return Math.min(base + jitter, MAX_RETRY_DELAY_MS);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEbayApiClient(
  authService: EbayAuthService,
  channelId: number,
  environment?: "sandbox" | "production",
): EbayApiClient {
  return new EbayApiClient(
    authService,
    channelId,
    environment || (process.env.EBAY_ENVIRONMENT as any) || "production",
  );
}
