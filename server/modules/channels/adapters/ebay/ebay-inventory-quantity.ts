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
  /** Read only for evidence (discoverEbayInventoryOffers); never validated, so its shape can never refuse a write. */
  listing: z.unknown().optional(),
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
  constructor(readonly code: string, message: string, readonly retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "EbayInventoryQuantityError";
  }
}

/** The read/validation phase has no mutation callback. Admission still checks
 * its independent request journal before accepting this no-send classification. */
export class EbayInventoryQuantityPreflightError extends EbayInventoryQuantityError {
  readonly effect = "not_sent" as const;
  constructor(cause: unknown) {
    super(cause instanceof EbayInventoryQuantityError ? cause.code : "EBAY_INVENTORY_PREFLIGHT_FAILED",
      cause instanceof Error ? cause.message : String(cause),
      cause instanceof EbayInventoryQuantityError ? cause.retryable : true, { cause });
    this.name = "EbayInventoryQuantityPreflightError";
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

type EbayInventoryOffer = z.infer<typeof offerSchema>;

/** One offer of a SKU as complete discovery found it; `listingId` only when eBay sent one (evidence, never identity). */
export interface EbayDiscoveredOffer {
  readonly offerId: string;
  readonly sku: string;
  readonly marketplaceId: string;
  readonly status: "PUBLISHED" | "UNPUBLISHED";
  readonly listingId: string | null;
}

/**
 * Every offer eBay holds for the exact SKU on the marketplace, read completely and validated, or thrown. Read-only;
 * shared by the quantity write (exactly one PUBLISHED offer) and the Dropship stock-link lookup (channels PR3), so
 * both apply the same page bound, pagination checks and exact SKU/marketplace scope.
 */
export async function discoverEbayInventoryOffers(client: Pick<EbayInventoryQuantityClient, "getInventoryOffersPage">,
  sku: string, marketplaceId: string): Promise<EbayDiscoveredOffer[]> {
  return (await discoverOffers(client, sku, marketplaceId)).map(offer => ({ offerId: offer.offerId, sku: offer.sku,
    marketplaceId: offer.marketplaceId, status: offer.status, listingId: offerListingId(offer.listing) }));
}

async function discoverOffers(client: Pick<EbayInventoryQuantityClient, "getInventoryOffersPage">, sku: string,
  marketplaceId: string): Promise<EbayInventoryOffer[]> {
  if (!identitySchema.safeParse(sku).success) {
    throw new EbayInventoryQuantityError("EBAY_INVENTORY_ID_REQUIRED", "An exact eBay inventory SKU is required.");
  }
  const seen = new Set<string>();
  const offers: EbayInventoryOffer[] = [];
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
      offers.push(offer);
    }
  } while (seen.size < total);
  return offers;
}

/** eBay's offer.listing.listingId when it is a trimmed non-empty string; anything else is "not sent". */
function offerListingId(listing: unknown): string | null {
  if (!listing || typeof listing !== "object" || !("listingId" in listing)) return null;
  const value = (listing as { listingId: unknown }).listingId;
  return typeof value === "string" && value.length > 0 && value === value.trim() ? value : null;
}

async function publishedOffer(client: EbayInventoryQuantityClient, sku: string, marketplaceId: string) {
  const published = (await discoverOffers(client, sku, marketplaceId)).filter(offer => offer.status === "PUBLISHED");
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
  quantityConsistent: boolean;
}

/** The one PUBLISHED offer discovery resolved, as an owner's identity check sees it. */
export interface EbayResolvedPublishedOffer {
  readonly offerId: string;
  readonly sku: string;
  readonly marketplaceId: string;
  /** The offer's quantity on eBay now; null when eBay sent no whole number (the write path validates it separately). */
  readonly availableQuantity: number | null;
}

export interface EbayInventoryQuantityOptions {
  /**
   * Owner identity check on the resolved PUBLISHED offer, run before any item read
   * or quantity write. A throw means nothing was sent (publish wraps it as a
   * preflight refusal). Absent: any single PUBLISHED offer for the SKU is used,
   * as before (the channel adapter passes none).
   */
  readonly expectOffer?: (offer: EbayResolvedPublishedOffer) => void;
}

function checkExpectedOffer(offer: EbayInventoryOffer, options: EbayInventoryQuantityOptions): void {
  const availableQuantity = quantitySchema.safeParse(offer.availableQuantity);
  options.expectOffer?.({ offerId: offer.offerId, sku: offer.sku, marketplaceId: offer.marketplaceId,
    availableQuantity: availableQuantity.success ? availableQuantity.data : null });
}

/** Provider availability, not an ATP formula: eBay caps a listing by BOTH quantities. */
export async function readEbayInventoryQuantity(
  client: EbayInventoryQuantityClient, sku: string, marketplaceId: string, options: EbayInventoryQuantityOptions = {},
): Promise<EbayInventoryQuantityObservation> {
  const offer = await publishedOffer(client, sku, marketplaceId);
  checkExpectedOffer(offer, options);
  return observeQuantity(client, sku, marketplaceId, offer);
}

async function observeQuantity(client: EbayInventoryQuantityClient, sku: string, marketplaceId: string,
  offer: z.infer<typeof offerSchema>): Promise<EbayInventoryQuantityObservation> {
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
    quantityConsistent: inventoryItemQuantity === offerQuantity.data,
  };
}

export type EbayInventoryQuantityPublication = {
  sku: string; marketplaceId: string; offerId: string; quantity: number;
} & ({ effect: "updated"; providerWriteAttempted: true }
  | { effect: "already_current"; providerWriteAttempted: false; observation: EbayInventoryQuantityObservation });

/** Converges the existing item AND offer. A fresh exact match is a read-only
 * result, not a claimed mutation acknowledgement. The outbox still performs its
 * independent readback under the ordinary exact-scope admission boundary. */
export async function publishEbayInventoryQuantity(
  client: EbayInventoryQuantityClient, sku: string, marketplaceId: string, quantity: number,
  options: EbayInventoryQuantityOptions = {},
): Promise<EbayInventoryQuantityPublication> {
  let offer: z.infer<typeof offerSchema>;
  try {
    if (!quantitySchema.safeParse(quantity).success) {
      throw new EbayInventoryQuantityError("EBAY_INVENTORY_QUANTITY_INVALID", "The desired eBay quantity must be a nonnegative safe integer.");
    }
    offer = await publishedOffer(client, sku, marketplaceId);
    // Inside the preflight: an identity refusal is a proven no-send.
    checkExpectedOffer(offer, options);
    if (offer.availableQuantity === quantity) {
      const observation = await observeQuantity(client, sku, marketplaceId, offer);
      // Matching min(item, offer) is insufficient: the other limit must not be
      // left above or below the requested absolute quantity.
      if (observation.inventoryItemQuantity === quantity) {
        return { sku, marketplaceId, offerId: offer.offerId, quantity,
          effect: "already_current", providerWriteAttempted: false, observation };
      }
    }
  } catch (error) {
    throw new EbayInventoryQuantityPreflightError(error);
  }
  // Once dispatch begins, an exception must preserve its original uncertainty.
  const [result] = await sendEbayQuantityUpdates(
    request => client.bulkUpdatePriceQuantity(request, marketplaceId),
    [{ sku, offerId: offer.offerId, quantity }],
  );
  if (!result?.confirmed) throw acknowledgementError();
  return { sku, marketplaceId, offerId: offer.offerId, quantity, effect: "updated", providerWriteAttempted: true };
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
