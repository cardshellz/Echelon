import { listingPriceCentsSchema, listingPriceTargetSchema, listingPriceResponseSchema, saveListingPriceInputSchema, saveListingPriceResponseSchema,
  type ListingPriceSetting, type SaveListingPriceInput } from "@shared/dropship/listing-price";

export type ListingPriceIdentity = { storeConnectionId: number; productVariantId: number };
export type ListingPriceDraft = { useDefault: boolean; useRules?: boolean; value: string; baseline: ListingPriceSetting };
export type ListingPriceSaveAttempt = { fingerprint: string; request: SaveListingPriceInput };

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

export function draftFromListingPrice(price: ListingPriceSetting): ListingPriceDraft {
  return { useDefault: price.pricingMode !== "rules" && price.overridePriceCents === null && price.source !== "saved_listing",
    ...(price.pricingMode === "rules" ? { useRules: true } : {}),
    value: listingPriceInput(price.overridePriceCents ?? price.effectivePriceCents), baseline: price };
}

export function isListingPriceDirty(draft: ListingPriceDraft): boolean {
  if (draft.useRules) return draft.baseline.pricingMode !== "rules";
  if (draft.baseline.pricingMode === "rules") return true;
  if (draft.useDefault) return draft.baseline.overridePriceCents !== null || draft.baseline.source === "saved_listing";
  try { return parseListingPriceCents(draft.value) !== (draft.baseline.source === "saved_listing"
    ? draft.baseline.effectivePriceCents : draft.baseline.overridePriceCents); }
  catch { return true; }
}

export function reconcileListingPriceDraft(current: ListingPriceDraft | null, saved: ListingPriceSetting): ListingPriceDraft {
  // Background refreshes may update the visible saved price, but must not replace
  // the vendor's edit or its optimistic-concurrency revision underneath them.
  return current && isListingPriceDirty(current) ? current : draftFromListingPrice(saved);
}

/** The same uncertain write must retain its original payload and key on retry. */
export function prepareListingPriceSave(identity: ListingPriceIdentity, draft: ListingPriceDraft,
  previous: ListingPriceSaveAttempt | null, createKey: () => string): ListingPriceSaveAttempt {
  listingPriceEndpoint(identity);
  const priceCents = draft.useDefault || draft.useRules ? null : parseListingPriceCents(draft.value);
  const expectedRevisionId = draft.baseline.revisionId;
  const fingerprint = JSON.stringify([identity.storeConnectionId, identity.productVariantId, priceCents, expectedRevisionId, ...(draft.useRules ? ["rules"] : [])]);
  if (previous?.fingerprint === fingerprint) return previous;
  const request = saveListingPriceInputSchema.parse({ priceCents, expectedRevisionId, idempotencyKey: createKey(), ...(draft.useRules ? { pricingMode: "rules" } : {}) });
  return { fingerprint, request };
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
