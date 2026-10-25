/**
 * Shopify's absolute stock write for one exact inventory item at one location
 * (`POST /inventory_levels/set.json`, shopify.adapter.ts setInventoryLevel).
 *
 * Two answers are permanent for that exact request, so the canonical outbox must
 * stop instead of retrying it for about two hours (10 attempts,
 * inventory-publication-outbox.repository.ts recordFailure/retryAt):
 * - 404 SHOPIFY_INVENTORY_ITEM_NOT_FOUND: the inventory item, or its level at that
 *   location, does not exist (for example the product was deleted and re-added);
 * - 422 SHOPIFY_INVENTORY_REJECTED: Shopify refused the request for that item
 *   (for example the item is not stocked or not tracked at that location).
 * The same request cannot succeed on retry; a person must fix the link or the
 * store item (PLAN-CH-v3 section 6 "Outbox (PR1)"). Ops Health shows the stopped
 * update (CHANNEL_STOCK_UPDATE_DEAD_LETTER).
 *
 * Every other status keeps its existing handling: 400/401/403 still surface as a
 * plain retryable `Error`, 429 and 5xx keep the adapter's own retry, and every
 * other Shopify path is untouched. The error is still an `Error` with the same
 * message, so callers that only read `message` see no difference.
 *
 * HYPOTHESIS (PLAN-CH-v3 section 12): Shopify returns these statuses for item-level
 * problems; a deleted location could also return 404. Either way the request is
 * not retryable, and a burst on one store shows as one Ops Health line per store.
 */
export const SHOPIFY_INVENTORY_WRITE_PATH = "/inventory_levels/set.json";

export type ShopifyInventoryWriteRejectionCode =
  | "SHOPIFY_INVENTORY_ITEM_NOT_FOUND"
  | "SHOPIFY_INVENTORY_REJECTED";

const REJECTION_CODE_BY_STATUS: Readonly<Record<number, ShopifyInventoryWriteRejectionCode>> = Object.freeze({
  404: "SHOPIFY_INVENTORY_ITEM_NOT_FOUND",
  422: "SHOPIFY_INVENTORY_REJECTED",
});

/** The stock write: any non-GET request to inventory_levels/set.json. The adapter's
 * quantity admission and the rejection mapping below share this one predicate. */
export function isShopifyInventoryWrite(method: string, path: string): boolean {
  return method !== "GET" && path === SHOPIFY_INVENTORY_WRITE_PATH;
}

/** The permanent rejection code for a failed Shopify response, or null when the
 * request is not the stock write or the status keeps its existing handling. */
export function shopifyInventoryWriteRejectionCode(
  method: string,
  path: string,
  status: number,
): ShopifyInventoryWriteRejectionCode | null {
  if (!isShopifyInventoryWrite(method, path)) return null;
  return REJECTION_CODE_BY_STATUS[status] ?? null;
}

/** Permanent (never retried) refusal of one exact Shopify stock write. */
export class ShopifyInventoryWriteRejectedError extends Error {
  readonly retryable = false as const;
  readonly classification = "permanent" as const;
  readonly context: Readonly<{ httpStatus: number; path: string }>;

  constructor(
    readonly code: ShopifyInventoryWriteRejectionCode,
    message: string,
    httpStatus: number,
  ) {
    super(message);
    this.name = "ShopifyInventoryWriteRejectedError";
    this.context = Object.freeze({ httpStatus, path: SHOPIFY_INVENTORY_WRITE_PATH });
  }
}
