import { z } from "zod";

const nullableCents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const nullableUnits = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();

/** Browser presentation only. Never render descriptionText as HTML. */
export const dropshipListingPresentationSchema = z.object({
  source: z.enum(["resolved_listing", "catalog_fallback"]),
  title: z.string(),
  descriptionText: z.string().nullable(),
  productName: z.string(),
  variantName: z.string(),
  unitsPerVariant: nullableUnits,
  brand: z.string().nullable(),
  condition: z.string().nullable(),
  itemSpecifics: z.array(z.object({ name: z.string(), values: z.array(z.string()) }).strict()),
  images: z.array(z.object({
    assetId: z.number().int().positive().nullable(),
    url: z.string().refine(isSafeDropshipPreviewImageUrl, "Unsafe preview image URL").nullable(),
    altText: z.string().nullable(),
    source: z.enum(["external_url", "catalog_file"]),
    publicationStatus: z.enum(["included", "not_included", "unavailable"]),
    reason: z.string().nullable(),
  }).strict()),
  issues: z.array(z.string()),
}).strict();

export const dropshipListingEconomicsSchema = z.object({
  currency: z.literal("USD"),
  basis: z.literal("one_sellable_variant"),
  unitsPerVariant: nullableUnits,
  referenceRetailPriceCents: nullableCents,
  listingPriceCents: nullableCents,
  vendorProductCostCents: nullableCents,
  // Retained for older clients; current costs come from the exact Shellz Club plan price source.
  channelDiscountPercent: z.number().int().min(0).max(100).nullable(),
  productCostSource: z.enum(["variant_fixed_price", "variant_percent", "plan_percent", "retail"]).nullable().optional(),
  productCostStatus: z.enum(["available", "unavailable"]),
  issues: z.array(z.string()),
}).strict();

export type DropshipListingPresentation = z.infer<typeof dropshipListingPresentationSchema>;
export type DropshipListingEconomics = z.infer<typeof dropshipListingEconomicsSchema>;

/** Exact authorized file route; external URLs must not contain embedded credentials. */
export function isSafeDropshipPreviewImageUrl(value: string): boolean {
  if (/^\/api\/dropship\/listings\/stores\/[1-9]\d*\/variants\/[1-9]\d*\/assets\/[1-9]\d*\/file$/.test(value)) return true;
  return isSafeDropshipExternalImageUrl(value);
}

export function isSafeDropshipExternalImageUrl(value: string): boolean {
  if (value !== value.trim() || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && !url.username && !url.password;
  } catch {
    return false;
  }
}
