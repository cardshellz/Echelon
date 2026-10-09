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

/**
 * What a size's current price is built from, in the words the pricing review
 * uses ("Reference retail $12.49", ".ops cost $10.89").
 */
export function describeListingPriceBuiltFrom(price: Pick<ListingPriceSetting,
  "source" | "ruleName" | "ruleBasis" | "defaultPriceCents" | "productCostCents">): string {
  switch (price.source) {
    case "override": return "Exact price";
    case "catalog_default": return "Catalog reference retail";
    case "saved_listing": return "Price last sent to eBay";
    case "unavailable": return "No price yet";
    case "rules": {
      const rule = price.ruleName ?? "Pricing rules";
      const start = price.ruleBasis === "catalog_retail" ? price.defaultPriceCents
        : price.ruleBasis === "product_cost" ? price.productCostCents ?? null : null;
      if (start === null || !price.ruleBasis) return rule;
      return `${rule}, from ${price.ruleBasis === "catalog_retail" ? "reference retail" : ".ops cost"} ${displayListingPrice(start)}`;
    }
  }
}

/** A note when a typed price is below the vendor's .ops cost. Below cost is allowed; it is never blocked. */
export function belowCostNote(value: string, productCostCents: number | null | undefined): string | null {
  if (productCostCents == null) return null;
  let priceCents: number;
  try { priceCents = parseListingPriceCents(value); } catch { return null; }
  return priceCents < productCostCents ? `This is below your .ops cost of ${displayListingPrice(productCostCents)}.` : null;
}

/**
 * Whether the size follows the store's pricing rules now. An `inherit` size
 * follows them only while they give it a price; otherwise it is on the retail
 * price (owner decision L1), which the old editors show as the catalog default.
 */
export function followsRulesNow(price: Pick<ListingPriceSetting, "pricingMode" | "source">): boolean {
  return price.pricingMode === "rules" || (price.pricingMode === "inherit" && price.source === "rules");
}

/**
 * The price a size would get once saved as `inherit` (owner decision L1): the
 * rule price when the store's rules give one, otherwise the retail price, and
 * null when neither exists (the server then refuses the save as
 * DROPSHIP_LISTING_PRICE_WOULD_BE_LOST if the size has a price today).
 * Card Shellz price limits are checked by the server only.
 */
export function inheritedListingPrice(price: Pick<ListingPriceSetting, "rulePriceCents" | "defaultPriceCents">): {
  priceCents: number | null; from: "rules" | "retail" | null;
} {
  if (price.rulePriceCents != null) return { priceCents: price.rulePriceCents, from: "rules" };
  if (price.defaultPriceCents !== null) return { priceCents: price.defaultPriceCents, from: "retail" };
  return { priceCents: null, from: null };
}

export function draftFromListingPrice(price: ListingPriceSetting): ListingPriceDraft {
  const rules = followsRulesNow(price);
  return { useDefault: !rules && price.overridePriceCents === null && price.source !== "saved_listing",
    ...(rules ? { useRules: true } : {}),
    value: listingPriceInput(price.overridePriceCents ?? price.effectivePriceCents), baseline: price };
}

export function isListingPriceDirty(draft: ListingPriceDraft): boolean {
  if (draft.useRules) return !followsRulesNow(draft.baseline);
  if (followsRulesNow(draft.baseline)) return true;
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
