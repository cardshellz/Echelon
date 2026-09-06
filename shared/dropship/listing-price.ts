import { z } from "zod";

// Existing publication-price columns are PostgreSQL integers. This is a storage
// limit, not a suggested retail price or a marketplace-specific pricing rule.
export const MAX_LISTING_PRICE_CENTS = 2_147_483_647;
export const listingPriceCentsSchema = z.number().int().positive().max(MAX_LISTING_PRICE_CENTS);
export const listingPriceTargetSchema = z.object({
  storeConnectionId: z.number().int().positive().max(2_147_483_647),
  productVariantId: z.number().int().positive().max(2_147_483_647),
}).strict();
export const saveListingPriceInputSchema = z.object({
  priceCents: listingPriceCentsSchema.nullable(),
  expectedRevisionId: z.number().int().positive().max(2_147_483_647).nullable(),
  idempotencyKey: z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/),
}).strict();
export const listingPriceSettingSchema = listingPriceTargetSchema.extend({
  revisionId: z.number().int().positive().max(2_147_483_647).nullable(),
  overridePriceCents: listingPriceCentsSchema.nullable(),
  effectivePriceCents: listingPriceCentsSchema.nullable(),
  defaultPriceCents: listingPriceCentsSchema.nullable(),
  source: z.enum(["override", "catalog_default", "saved_listing", "unavailable"]),
  updatedAt: z.string().datetime().nullable(),
}).strict();
export const listingPriceResponseSchema = z.object({ price: listingPriceSettingSchema }).strict();
export const saveListingPriceResponseSchema = listingPriceResponseSchema.extend({ idempotentReplay: z.boolean() }).strict();
export type ListingPriceTarget = z.infer<typeof listingPriceTargetSchema>;
export type ListingPriceSetting = z.infer<typeof listingPriceSettingSchema>;
export type ListingPrice = ListingPriceSetting;
export type SaveListingPriceInput = z.infer<typeof saveListingPriceInputSchema>;

export interface SavedListingPriceRevision {
  productVariantId: number;
  revisionId: number;
  overridePriceCents: number | null;
  updatedAt: string;
}

export function resolveListingPrice(input: {
  saved: Pick<SavedListingPriceRevision, "overridePriceCents"> | null;
  existingListingPriceCents: number | null;
  defaultPriceCents: number | null;
}): Pick<ListingPriceSetting, "effectivePriceCents" | "source"> {
  // A saved null is an explicit reset, not absence. Never resurrect an older
  // published/queued price after the vendor chose the catalog default.
  const rawPrice = input.saved
    ? input.saved.overridePriceCents ?? input.defaultPriceCents
    : input.existingListingPriceCents ?? input.defaultPriceCents;
  const price = listingPriceCentsSchema.safeParse(rawPrice);
  if (!price.success) return { effectivePriceCents: null, source: "unavailable" };
  return {
    effectivePriceCents: price.data,
    source: input.saved?.overridePriceCents != null ? "override"
      : !input.saved && input.existingListingPriceCents != null ? "saved_listing" : "catalog_default",
  };
}
