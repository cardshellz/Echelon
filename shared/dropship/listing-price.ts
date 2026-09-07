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
  pricingMode: z.enum(["fixed", "catalog_default", "rules"]).optional(),
  expectedRevisionId: z.number().int().positive().max(2_147_483_647).nullable(),
  idempotencyKey: z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/),
}).strict().refine((input) => !input.pricingMode || (input.pricingMode === "fixed") === (input.priceCents !== null),
  "Only a fixed price may contain a price override.");
export const listingPriceSettingSchema = listingPriceTargetSchema.extend({
  revisionId: z.number().int().positive().max(2_147_483_647).nullable(),
  overridePriceCents: listingPriceCentsSchema.nullable(),
  effectivePriceCents: listingPriceCentsSchema.nullable(),
  defaultPriceCents: listingPriceCentsSchema.nullable(),
  source: z.enum(["override", "catalog_default", "saved_listing", "rules", "unavailable"]),
  pricingMode: z.enum(["fixed", "catalog_default", "rules"]).optional(),
  ruleName: z.string().nullable().optional(),
  pricingIssue: z.string().nullable().optional(),
  rulePriceCents: listingPriceCentsSchema.nullable().optional(),
  rulesConfigured: z.boolean().optional(),
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
  pricingMode?: "fixed" | "catalog_default" | "rules";
  updatedAt: string;
}

export function resolveListingPrice(input: {
  saved: Pick<SavedListingPriceRevision, "overridePriceCents" | "pricingMode"> | null;
  existingListingPriceCents: number | null;
  defaultPriceCents: number | null;
  rulePrice?: { priceCents: number | null } | null;
}): Pick<ListingPriceSetting, "effectivePriceCents" | "source"> {
  if (input.saved?.pricingMode === "rules" || (!input.saved && input.existingListingPriceCents === null && input.rulePrice)) {
    const parsed = listingPriceCentsSchema.safeParse(input.rulePrice?.priceCents);
    return parsed.success ? { effectivePriceCents: parsed.data, source: "rules" }
      : { effectivePriceCents: null, source: "unavailable" };
  }
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
