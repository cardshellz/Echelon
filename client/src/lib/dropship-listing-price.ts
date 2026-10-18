import { RULE_PRICE_OUTSIDE_LIMIT_ISSUE, listingPriceCentsSchema, listingPriceTargetSchema, listingPriceResponseSchema,
  saveListingPriceResponseSchema, type ListingPriceSetting } from "@shared/dropship/listing-price";

export type ListingPriceIdentity = { storeConnectionId: number; productVariantId: number };

export function listingPriceEndpoint(identity: ListingPriceIdentity): string {
  if (!listingPriceTargetSchema.safeParse(identity).success) {
    throw new Error("The listing identity is invalid.");
  }
  return `/api/dropship/listings/stores/${identity.storeConnectionId}/variants/${identity.productVariantId}/price`;
}

/** Parse decimal text directly to integer cents; never round a floating-point amount. */
export function parseListingPriceCents(value: string): number {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || text.length > 20) {
    throw new Error("Enter a USD price with no more than two decimal places, such as 8.99.");
  }
  const [dollars, fractional = ""] = text.split(".");
  const cents = BigInt(dollars) * BigInt(100) + BigInt(fractional.padEnd(2, "0"));
  const parsed = listingPriceCentsSchema.safeParse(Number(cents));
  if (!parsed.success) throw new Error("Enter a price from $0.01 to $21,474,836.47.");
  return Number(cents);
}

export function listingPriceInput(cents: number | null): string {
  if (cents === null) return "";
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("The saved price is invalid.");
  const value = BigInt(cents);
  return `${value / BigInt(100)}.${String(value % BigInt(100)).padStart(2, "0")}`;
}

export function displayListingPrice(cents: number | null): string {
  return cents === null ? "Unavailable" : `$${listingPriceInput(cents)}`;
}

/**
 * The price a size would get once saved as `inherit` (owner decision L1): the
 * rule price when the store's rules give a usable one, otherwise the retail
 * price, and null when neither exists (the server then refuses the save as
 * DROPSHIP_LISTING_PRICE_WOULD_BE_LOST if the size has a price today).
 * The server checks the Card Shellz price limits: W9 names a rule price a
 * blocking limit refuses (`pricingIssue` RULE_PRICE_OUTSIDE_LIMIT_ISSUE), and
 * such a size takes its retail price. Whether the retail price itself is
 * allowed is the server's to say on save.
 */
export function inheritedListingPrice(price: Pick<ListingPriceSetting, "rulePriceCents" | "defaultPriceCents" | "pricingIssue">): {
  priceCents: number | null; from: "rules" | "retail" | null;
} {
  if (price.rulePriceCents != null && price.pricingIssue !== RULE_PRICE_OUTSIDE_LIMIT_ISSUE) {
    return { priceCents: price.rulePriceCents, from: "rules" };
  }
  if (price.defaultPriceCents !== null) return { priceCents: price.defaultPriceCents, from: "retail" };
  return { priceCents: null, from: null };
}

function matchesIdentity(price: ListingPriceSetting, identity: ListingPriceIdentity): ListingPriceSetting {
  if (price.storeConnectionId !== identity.storeConnectionId || price.productVariantId !== identity.productVariantId) {
    throw new Error("The price response did not match this listing. Please refresh the saved price.");
  }
  return price;
}

export function readListingPrice(value: unknown, identity: ListingPriceIdentity): ListingPriceSetting {
  const result = listingPriceResponseSchema.safeParse(value);
  if (!result.success) throw new Error("The saved price response was invalid. Please try again.");
  return matchesIdentity(result.data.price, identity);
}

export function readSavedListingPrice(value: unknown, identity: ListingPriceIdentity): ListingPriceSetting {
  const result = saveListingPriceResponseSchema.safeParse(value);
  if (!result.success) throw new Error("The save response was invalid. Retry the same save to confirm its outcome.");
  return matchesIdentity(result.data.price, identity);
}
