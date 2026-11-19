import { parseDecimalCents } from "@shared/money-read";
import { createHash } from "node:crypto";
import { z } from "zod";
import { MAX_LISTING_PRICE_CENTS } from "../../../../shared/dropship/listing-price";

/**
 * eBay sync-back (plan v4 §4): what a read of a vendor's live eBay listing
 * says, validated before anything trusts it. The caller GETs the offer by its
 * saved id and the inventory item by our SKU (vendor token, GET only) and
 * passes the raw JSON here; nothing in this module reads a clock, the
 * database or the network. The live title and description are kept in memory
 * exactly as eBay sent them, only so a push can send a vendor's edit back
 * unchanged (owner rule 2); they are never stored, sanitized or shortened.
 */

/** Listing statuses that mean the listing is on sale (SB7). */
export const EBAY_LIVE_LISTING_STATUSES = ["ACTIVE", "OUT_OF_STOCK"] as const;
/**
 * Listing statuses that mean it is not on sale. HYPOTHESIS: these are the rest
 * of the Inventory API's listing status values (eBay's documentation cannot be
 * reached from this build); any other value is unreadable, so an unknown
 * status only flags the listing and never ends it (SB7).
 */
export const EBAY_NOT_LIVE_LISTING_STATUSES = ["ENDED", "EBAY_ENDED", "INACTIVE", "NOT_LISTED"] as const;
/** The only offer format a dropship listing has; any other is a variation listing (F9). */
export const EBAY_FIXED_PRICE_FORMAT = "FIXED_PRICE";
/** The only currency the listing builder sends (plan §4.4). */
export const EBAY_LISTING_CURRENCY = "USD";
/** Bounds on the read so a malformed answer cannot make the guard do unbounded work. */
const MAX_OBSERVED_GROUP_IDS = 1_000;
const MAX_BEST_OFFER_TERMS_JSON_LENGTH = 4_000;

const quantitySchema = z.number().int().nonnegative().safe();
const identitySchema = z.string().min(1).max(255).refine((value) => value === value.trim(), "Identity has surrounding spaces.");
const policyIdSchema = z.string().min(1).max(100).refine((value) => value.trim() !== "", "Policy id is blank.");
const amountSchema = z.object({ value: z.string().max(40), currency: z.string().max(10) });

/** The fields of `GET /sell/inventory/v1/offer/{offerId}` sync-back reads. Unknown fields are ignored, never kept. */
export const observedEbayOfferSchema = z.object({
  offerId: identitySchema,
  sku: identitySchema,
  marketplaceId: identitySchema,
  format: z.string().min(1).max(40),
  status: z.string().min(1).max(40),
  availableQuantity: quantitySchema,
  listingDescription: z.string().optional(),
  pricingSummary: z.object({ price: amountSchema }),
  listingPolicies: z.object({
    fulfillmentPolicyId: policyIdSchema.optional(),
    paymentPolicyId: policyIdSchema.optional(),
    returnPolicyId: policyIdSchema.optional(),
    // Vendor-owned and never written by Card Shellz: carried, not modelled (SB25).
    bestOfferTerms: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  listing: z.object({
    listingId: identitySchema.optional(),
    listingStatus: z.string().min(1).max(40).optional(),
  }).optional(),
});

/** The fields of `GET /sell/inventory/v1/inventory_item/{sku}` sync-back reads. */
export const observedEbayInventoryItemSchema = z.object({
  sku: identitySchema,
  product: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
  }).optional(),
  availability: z.object({ shipToLocationAvailability: z.object({ quantity: quantitySchema }) }),
  groupIds: z.array(z.string()).max(MAX_OBSERVED_GROUP_IDS).optional(),
  inventoryItemGroupKeys: z.array(z.string()).max(MAX_OBSERVED_GROUP_IDS).optional(),
});

export type ObservedEbayOffer = z.infer<typeof observedEbayOfferSchema>;
export type ObservedEbayInventoryItem = z.infer<typeof observedEbayInventoryItemSchema>;

/** Why a read cannot be used at all: the listing is flagged observation_unreadable and nothing is adopted. */
export type MarketplaceObservationUnreadableReason =
  | "offer_schema" | "inventory_item_schema" | "offer_id_mismatch" | "currency" | "price"
  | "offer_status_unknown" | "listing_status_unknown" | "policies_missing" | "best_offer_terms";

export interface MarketplaceListingObservation {
  offerId: string;
  sku: string;
  inventoryItemSku: string;
  marketplaceId: string;
  format: string;
  offerStatus: "PUBLISHED" | "UNPUBLISHED";
  listingId: string | null;
  listingStatus: string | null;
  /** Live = PUBLISHED and the listing ACTIVE or OUT_OF_STOCK (SB7). */
  live: boolean;
  priceCents: number;
  currency: typeof EBAY_LISTING_CURRENCY;
  /** Null only on an UNPUBLISHED offer that carries no policy. */
  policies: { fulfillmentPolicyId: string | null; returnPolicyId: string | null; paymentPolicyId: string | null };
  bestOfferTerms: Readonly<Record<string, unknown>> | null;
  bestOfferTermsHash: string | null;
  /** Qe = min(offer, inventory item): eBay limits a listing by both (CH/adapters/ebay/ebay-inventory-quantity.ts). */
  quantity: { offer: number; inventoryItem: number; observed: number };
  /** The inventory item's title exactly as eBay sent it; null when it sent none. In memory only (owner rule 2). */
  title: string | null;
  /**
   * The description the listing shows, exactly as eBay sent it: the offer's
   * listing description when present, else the inventory item's (which one a
   * Seller Hub edit changes is sandbox check 13). In memory only.
   */
  description: string | null;
  /** sha256 of the offer's own listing description (the push guard, SB5); null when the offer has none. */
  offerDescriptionHash: string | null;
  groupIds: readonly string[];
}

export type MarketplaceObservationParse =
  | { kind: "observed"; observation: MarketplaceListingObservation }
  | { kind: "unreadable"; reason: MarketplaceObservationUnreadableReason };

/**
 * Validates one read. `expectedOfferId` is the saved id the offer was read
 * by: an answer for another offer is unreadable, never adopted. The SKU is
 * compared with ours by the decision (sku_changed), not here.
 */
export function parseMarketplaceListingObservation(input: {
  offer: unknown; inventoryItem: unknown; expectedOfferId: string;
}): MarketplaceObservationParse {
  const offer = observedEbayOfferSchema.safeParse(input.offer);
  if (!offer.success) return { kind: "unreadable", reason: "offer_schema" };
  const item = observedEbayInventoryItemSchema.safeParse(input.inventoryItem);
  if (!item.success) return { kind: "unreadable", reason: "inventory_item_schema" };
  if (offer.data.offerId !== input.expectedOfferId) return { kind: "unreadable", reason: "offer_id_mismatch" };
  const price = parseEbayListingPriceCents(offer.data.pricingSummary.price);
  if (!price.ok) return { kind: "unreadable", reason: price.reason };
  const status = offer.data.status;
  if (status !== "PUBLISHED" && status !== "UNPUBLISHED") return { kind: "unreadable", reason: "offer_status_unknown" };
  const listingStatus = offer.data.listing?.listingStatus ?? null;
  // An unknown status, or a published offer without one, only flags the listing; it never ends it (SB7).
  if (listingStatus !== null && !isKnownListingStatus(listingStatus)) return { kind: "unreadable", reason: "listing_status_unknown" };
  if (status === "PUBLISHED" && listingStatus === null) return { kind: "unreadable", reason: "listing_status_unknown" };
  const live = status === "PUBLISHED" && listingStatus !== null && isLiveListingStatus(listingStatus);
  const policies = {
    fulfillmentPolicyId: offer.data.listingPolicies?.fulfillmentPolicyId ?? null,
    returnPolicyId: offer.data.listingPolicies?.returnPolicyId ?? null,
    paymentPolicyId: offer.data.listingPolicies?.paymentPolicyId ?? null,
  };
  // A published listing always has its three policies; one without them is not an eBay answer we understand.
  if (status === "PUBLISHED" && (!policies.fulfillmentPolicyId || !policies.returnPolicyId || !policies.paymentPolicyId)) {
    return { kind: "unreadable", reason: "policies_missing" };
  }
  const bestOfferTerms = offer.data.listingPolicies?.bestOfferTerms ?? null;
  let bestOfferTermsHash: string | null = null;
  if (bestOfferTerms !== null) {
    const json = canonicalJson(bestOfferTerms);
    if (json === null || json.length > MAX_BEST_OFFER_TERMS_JSON_LENGTH) return { kind: "unreadable", reason: "best_offer_terms" };
    bestOfferTermsHash = sha256Hex(json);
  }
  const itemQuantity = item.data.availability.shipToLocationAvailability.quantity;
  const offerDescription = offer.data.listingDescription;
  return {
    kind: "observed",
    observation: {
      offerId: offer.data.offerId,
      sku: offer.data.sku,
      inventoryItemSku: item.data.sku,
      marketplaceId: offer.data.marketplaceId,
      format: offer.data.format,
      offerStatus: status,
      listingId: offer.data.listing?.listingId ?? null,
      listingStatus,
      live,
      priceCents: price.cents,
      currency: EBAY_LISTING_CURRENCY,
      policies,
      bestOfferTerms,
      bestOfferTermsHash,
      quantity: { offer: offer.data.availableQuantity, inventoryItem: itemQuantity,
        observed: Math.min(offer.data.availableQuantity, itemQuantity) },
      title: item.data.product?.title ?? null,
      description: offerDescription ?? item.data.product?.description ?? null,
      offerDescriptionHash: offerDescription === undefined ? null : sha256Hex(offerDescription),
      groupIds: [...(item.data.groupIds ?? []), ...(item.data.inventoryItemGroupKeys ?? [])],
    },
  };
}

/**
 * The offer fields the push guard compares (SB5), from an offer as the
 * connector observed it just before its first write. They are computed the
 * same way parseMarketplaceListingObservation computes them from the pre-read,
 * so an unchanged offer gives equal values. Null when the offer is not one
 * this module can read; the guard then treats it as changed.
 */
export interface ObservedOfferGuardFields {
  offerId: string;
  listingId: string | null;
  priceCents: number | null;
  currency: string;
  policies: { fulfillmentPolicyId: string | null; returnPolicyId: string | null; paymentPolicyId: string | null };
  bestOfferTermsHash: string | null;
  offerDescriptionHash: string | null;
  availableQuantity: number;
}

export function observedOfferGuardFields(rawOffer: unknown): ObservedOfferGuardFields | null {
  const parsed = observedEbayOfferSchema.safeParse(rawOffer);
  if (!parsed.success) return null;
  const offer = parsed.data;
  const price = parseEbayListingPriceCents(offer.pricingSummary.price);
  const bestOfferTerms = offer.listingPolicies?.bestOfferTerms ?? null;
  const bestOfferJson = bestOfferTerms === null ? null : canonicalJson(bestOfferTerms);
  if (bestOfferTerms !== null && (bestOfferJson === null || bestOfferJson.length > MAX_BEST_OFFER_TERMS_JSON_LENGTH)) return null;
  return {
    offerId: offer.offerId,
    listingId: offer.listing?.listingId ?? null,
    priceCents: price.ok ? price.cents : null,
    currency: offer.pricingSummary.price.currency,
    policies: {
      fulfillmentPolicyId: offer.listingPolicies?.fulfillmentPolicyId ?? null,
      returnPolicyId: offer.listingPolicies?.returnPolicyId ?? null,
      paymentPolicyId: offer.listingPolicies?.paymentPolicyId ?? null,
    },
    bestOfferTermsHash: bestOfferJson === null ? null : sha256Hex(bestOfferJson),
    offerDescriptionHash: offer.listingDescription === undefined ? null : sha256Hex(offer.listingDescription),
    availableQuantity: offer.availableQuantity,
  };
}

export function isLiveListingStatus(status: string): boolean {
  return (EBAY_LIVE_LISTING_STATUSES as readonly string[]).includes(status);
}

function isKnownListingStatus(status: string): boolean {
  return isLiveListingStatus(status) || (EBAY_NOT_LIVE_LISTING_STATUSES as readonly string[]).includes(status);
}

export type ParsedEbayPrice =
  | { ok: true; cents: number }
  | { ok: false; reason: "currency" | "price" };

/**
 * eBay's price string as integer cents, never through floating point (plan
 * §4.4): USD only, `^(\d{1,8})(?:\.(\d{1,2}))?$`, 1..2,147,483,647 cents
 * (the listing price columns' limit, shared/dropship/listing-price.ts).
 */
export function parseEbayListingPriceCents(amount: { value: string; currency: string }): ParsedEbayPrice {
  if (amount.currency !== EBAY_LISTING_CURRENCY) return { ok: false, reason: "currency" };
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(amount.value);
  if (!match) return { ok: false, reason: "price" };
  // The source grammar and listing-specific range remain stricter than the shared reader.
  const cents = parseDecimalCents(amount.value, "observed listing price");
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_LISTING_PRICE_CENTS) return { ok: false, reason: "price" };
  return { ok: true, cents };
}

/**
 * JSON with object keys sorted at every level, so equal values always hash
 * equal. Null for a value JSON cannot carry exactly (a function, a symbol, a
 * non-finite number or a cycle), which the caller treats as unreadable.
 */
export function canonicalJson(value: unknown): string | null {
  const seen = new Set<object>();
  const visit = (current: unknown): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new CanonicalJsonError();
      return current;
    }
    if (typeof current !== "object") throw new CanonicalJsonError();
    if (seen.has(current)) throw new CanonicalJsonError();
    seen.add(current);
    const result = Array.isArray(current) ? current.map(visit)
      : Object.fromEntries(Object.keys(current).sort(compareCodeUnits)
        .map((key) => [key, visit((current as Record<string, unknown>)[key])]));
    seen.delete(current);
    return result;
  };
  try { return JSON.stringify(visit(value)); }
  catch (error) {
    if (error instanceof CanonicalJsonError) return null;
    throw error;
  }
}

class CanonicalJsonError extends Error {}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Sorts by UTF-16 code units, never by locale, so a hash never depends on the server's locale. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
