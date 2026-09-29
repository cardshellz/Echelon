import { z } from "zod";
import type { EbayBulkPriceQuantityRequest } from "./ebay-types";
import { readEbayQuantityUpdateResults, sendEbayQuantityUpdates } from "./ebay-quantity-update";

const quantitySchema = z.number().int().nonnegative().safe();
const identitySchema = z.string().min(1).refine((value) => value === value.trim());
const offerSchema = z.object({
  offerId: identitySchema,
  sku: identitySchema,
  marketplaceId: identitySchema,
  status: z.enum(["PUBLISHED", "UNPUBLISHED"]),
  availableQuantity: z.unknown(),
});
const pageSchema = z.object({ total: quantitySchema, offers: z.array(offerSchema) });
const PAGE_SIZE = 200;
const MAX_OFFERS = 1_000; // Bound work; an incomplete discovery must never authorize a write.

export interface EbayInventoryQuantityClient {
  getInventoryItem(sku: string): Promise<unknown>;
  getInventoryOffersPage(sku: string, marketplaceId: string, offset: number, limit: number): Promise<unknown>;
  bulkUpdatePriceQuantity(request: EbayBulkPriceQuantityRequest, marketplaceId: string): Promise<unknown>;
}

export class EbayInventoryQuantityError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "EbayInventoryQuantityError";
  }
}

/** Match the marketplace already used by listing creation; never select an arbitrary offer. */
export function ebayInventoryMarketplace(value: unknown): string {
  const marketplace = value ?? "EBAY_US";
  if (typeof marketplace !== "string" || !/^EBAY_[A-Z]{2,8}$/.test(marketplace)) {
    throw new EbayInventoryQuantityError("EBAY_INVENTORY_MARKETPLACE_INVALID", "The configured eBay marketplace is invalid.");
  }
  return marketplace;
}

export function ebayInventoryOffersPath(sku: string, marketplaceId: string, offset: number, limit: number): string {
  return `/sell/inventory/v1/offer?${new URLSearchParams({
    sku, marketplace_id: marketplaceId, offset: String(offset), limit: String(limit),
  })}`;
}

async function publishedOffer(client: EbayInventoryQuantityClient, sku: string, marketplaceId: string) {
  if (!identitySchema.safeParse(sku).success) {
    throw new EbayInventoryQuantityError("EBAY_INVENTORY_ID_REQUIRED", "An exact eBay inventory SKU is required.");
  }
  const seen = new Set<string>();
  const published: z.infer<typeof offerSchema>[] = [];
  let total: number | undefined;
  do {
    const parsed = pageSchema.safeParse(await client.getInventoryOffersPage(sku, marketplaceId, seen.size, PAGE_SIZE));
    if (!parsed.success || parsed.data.total > MAX_OFFERS || parsed.data.offers.length > PAGE_SIZE
      || (total !== undefined && parsed.data.total !== total)) {
      throw new EbayInventoryQuantityError("EBAY_INVENTORY_OFFERS_INVALID", "eBay offer discovery was invalid, changed during pagination, or exceeded its safety bound.", true);
    }
    total = parsed.data.total;
    if (seen.size + parsed.data.offers.length > total || (seen.size < total && parsed.data.offers.length === 0)) {
      throw new EbayInventoryQuantityError("EBAY_INVENTORY_OFFERS_INCOMPLETE", "eBay did not return complete offer discovery.", true);
    }
    for (const offer of parsed.data.offers) {
      if (offer.sku !== sku || offer.marketplaceId !== marketplaceId || seen.has(offer.offerId)) {
        throw new EbayInventoryQuantityError("EBAY_INVENTORY_OFFER_SCOPE_INVALID", "eBay returned another SKU, marketplace, or a duplicate offer.");
      }
      seen.add(offer.offerId);
      if (offer.status === "PUBLISHED") published.push(offer);
    }
  } while (seen.size < total);
  if (published.length !== 1) {
    throw new EbayInventoryQuantityError("EBAY_INVENTORY_OFFER_AMBIGUOUS", "Exactly one published offer must resolve for the selected eBay SKU and marketplace; no listing is created or guessed.");
  }
  return published[0]!;
}

export interface EbayInventoryQuantityObservation {
  sku: string;
  marketplaceId: string;
  offerId: string;
  inventoryItemQuantity: number;
  offerQuantity: number;
  observedQuantity: number;
}

/** Provider availability, not an ATP formula: eBay caps a listing by BOTH quantities. */
export async function readEbayInventoryQuantity(
  client: EbayInventoryQuantityClient, sku: string, marketplaceId: string,
): Promise<EbayInventoryQuantityObservation> {
  const offer = await publishedOffer(client, sku, marketplaceId);
  const item = z.object({
    sku: z.literal(sku),
    availability: z.object({ shipToLocationAvailability: z.object({ quantity: quantitySchema }) }),
  }).safeParse(await client.getInventoryItem(sku));
  const offerQuantity = quantitySchema.safeParse(offer.availableQuantity);
  if (!item.success || !offerQuantity.success) {
    throw new EbayInventoryQuantityError("EBAY_INVENTORY_QUANTITY_INVALID", "eBay did not return the exact SKU with numeric, nonnegative safe-integer item and offer quantities.", true);
  }
  const inventoryItemQuantity = item.data.availability.shipToLocationAvailability.quantity;
  return {
    sku, marketplaceId, offerId: offer.offerId, inventoryItemQuantity, offerQuantity: offerQuantity.data,
    observedQuantity: Math.min(inventoryItemQuantity, offerQuantity.data),
  };
}

/** One quantity-only operation updates the existing item AND offer. No product replacement or relisting. */
export async function publishEbayInventoryQuantity(
  client: EbayInventoryQuantityClient, sku: string, marketplaceId: string, quantity: number,
): Promise<{ sku: string; marketplaceId: string; offerId: string; quantity: number }> {
  if (!quantitySchema.safeParse(quantity).success) {
    throw new EbayInventoryQuantityError("EBAY_INVENTORY_QUANTITY_INVALID", "The desired eBay quantity must be a nonnegative safe integer.");
  }
  const offer = await publishedOffer(client, sku, marketplaceId);
  const [result] = await sendEbayQuantityUpdates(
    request => client.bulkUpdatePriceQuantity(request, marketplaceId),
    [{ sku, offerId: offer.offerId, quantity }],
  );
  if (!result?.confirmed) throw acknowledgementError();
  return { sku, marketplaceId, offerId: offer.offerId, quantity };
}

// The existing client also checks admission. Keep protocol validation here so the
// independently credentialed Dropship transport receives the same protection.
export function assertEbayQuantityAcknowledgement(value: unknown, sku: string, offerId: string): void {
  const [result] = readEbayQuantityUpdateResults(value, [{ sku, offerId, quantity: 0 }]);
  if (!result?.confirmed) throw acknowledgementError();
}

function acknowledgementError(): EbayInventoryQuantityError {
  // Unknown does not mean rejected: do not issue a fallback mutation here.
  return new EbayInventoryQuantityError("EBAY_INVENTORY_ACKNOWLEDGEMENT_INVALID", "eBay did not confirm the exact SKU/offer quantity operation.", true);
}
