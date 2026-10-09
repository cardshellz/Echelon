import { z } from "zod";

// Existing publication-price columns are PostgreSQL integers. This is a storage
// limit, not a suggested retail price or a marketplace-specific pricing rule.
export const MAX_LISTING_PRICE_CENTS = 2_147_483_647;
export const listingPriceCentsSchema = z.number().int().positive().max(MAX_LISTING_PRICE_CENTS);
/** A known money amount in integer cents that may be zero: a cost or the amount a rule starts from. Never a listing price. */
export const listingAmountCentsSchema = z.number().int().min(0).max(MAX_LISTING_PRICE_CENTS);
/** What a pricing rule starts from: the vendor's .ops cost or the catalog reference retail. */
export const listingPriceBasisSchema = z.enum(["product_cost", "catalog_retail"]);
/**
 * How one size's price is chosen (`dropship_listing_price_settings.pricing_mode`):
 * - `fixed`: a price the vendor typed (the only mode with a price of its own);
 * - `catalog_default`: the Card Shellz retail price;
 * - `rules`: the store's pricing rules, and no price when they can't give one;
 * - `inherit`: no price of its own. The store's pricing rules when they give a
 *   price, otherwise the Card Shellz retail price, never the price an earlier
 *   push saved (migration 0732; owner decisions A3 and L1, 2026-10-09).
 */
export const LISTING_PRICING_MODES = ["fixed", "catalog_default", "rules", "inherit"] as const;
export type ListingPricingMode = (typeof LISTING_PRICING_MODES)[number];
export const listingPricingModeSchema = z.enum(LISTING_PRICING_MODES);
export const listingPriceTargetSchema = z.object({
  storeConnectionId: z.number().int().positive().max(2_147_483_647),
  productVariantId: z.number().int().positive().max(2_147_483_647),
}).strict();
export const saveListingPriceInputSchema = z.object({
  priceCents: listingPriceCentsSchema.nullable(),
  pricingMode: listingPricingModeSchema.optional(),
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
  pricingMode: listingPricingModeSchema.optional(),
  ruleName: z.string().nullable().optional(),
  pricingIssue: z.string().nullable().optional(),
  rulePriceCents: listingPriceCentsSchema.nullable().optional(),
  rulesConfigured: z.boolean().optional(),
  /** What the store's rule for this size starts from, when the store has rules. */
  ruleBasis: listingPriceBasisSchema.nullable().optional(),
  /** The vendor's .ops cost for one sellable pack, or null when it is not known. */
  productCostCents: listingAmountCentsSchema.nullable().optional(),
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
  pricingMode?: ListingPricingMode;
  updatedAt: string;
}

/**
 * Whether the store's pricing rules own this listing's price.
 *
 * A saved setting is the vendor's choice and decides on its own: rules, a
 * typed price, or the catalog default. Without one, the rules apply whenever
 * the store has them. The price an earlier push saved on the listing record
 * was derived at push time, not chosen by the vendor, so it does not shield
 * the listing from the rules; only a typed price does (owner decision,
 * 2026-09-28).
 *
 * `inherit` follows the rules only when they give the size a usable price.
 * A store with no rules, two group rules that tie, a missing cost or a price
 * out of range leave it on the retail price instead (owner decision L1,
 * 2026-10-09), so an `inherit` size is never blocked by a rule that can't
 * price it. `rules` keeps today's meaning: no price when the rules give none.
 */
export function listingPriceFollowsRules(input: {
  saved: Pick<SavedListingPriceRevision, "pricingMode"> | null;
  rulePrice?: { priceCents: number | null } | null;
}): boolean {
  if (input.saved?.pricingMode === "inherit") return listingPriceCentsSchema.safeParse(input.rulePrice?.priceCents).success;
  if (input.saved) return input.saved.pricingMode === "rules";
  return input.rulePrice != null;
}

/** Only a price the vendor typed is fixed; see `listingPriceFollowsRules`. */
export function isTypedListingPrice(saved: Pick<SavedListingPriceRevision, "overridePriceCents"> | null): boolean {
  return saved?.overridePriceCents != null;
}

/**
 * Precedence: the saved setting (rules, typed price or catalog default), then
 * the store's rules, then the price an earlier push saved on the listing,
 * then the catalog default.
 *
 * An `inherit` setting takes the rule price when the rules give one (see
 * `listingPriceFollowsRules`), and otherwise the catalog default with source
 * `catalog_default`. Its saved price is always null, so it never falls back to
 * the price an earlier push saved: that price is only used with no saved setting.
 */
export function resolveListingPrice(input: {
  saved: Pick<SavedListingPriceRevision, "overridePriceCents" | "pricingMode"> | null;
  existingListingPriceCents: number | null;
  defaultPriceCents: number | null;
  rulePrice?: { priceCents: number | null } | null;
}): Pick<ListingPriceSetting, "effectivePriceCents" | "source"> {
  if (listingPriceFollowsRules(input)) {
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
