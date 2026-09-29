/**
 * eBay's manufacturer part number (MPN) for a dropship listing.
 *
 * eBay refuses to publish an offer in the categories that require product
 * identifiers when the inventory item carries a Brand but no MPN
 * ("25002 ... Input data for tag <BrandMPN> is invalid or missing"). The
 * push sends the catalog's MPN when there is one, then an "MPN" item
 * specific, then eBay's placeholder for products without one; the preview
 * warns the vendor when the placeholder is what eBay will show.
 *
 * ASSUMPTION: "Does Not Apply" is the value eBay accepts for a product
 * without a manufacturer part number. eBay's developer site could not be
 * reached from the build environment to re-read this; a refusal would show
 * as the push's failure reason, with the eBay call that refused.
 */
export const EBAY_MPN_NOT_APPLICABLE = "Does Not Apply";
export const EBAY_MPN_PLACEHOLDER_WARNING = "ebay_mpn_placeholder";

export interface EbayMpnInput {
  mpn: string | null;
  itemSpecifics: Record<string, unknown> | null;
}

export interface EbayMpnResolution {
  mpn: string;
  /** True when eBay's placeholder is sent because the catalog has no MPN. */
  placeholder: boolean;
}

export function resolveEbayMpn(input: EbayMpnInput): EbayMpnResolution {
  const known = normalizedText(input.mpn) ?? normalizedText(firstItemSpecific(input.itemSpecifics, "MPN"));
  return known
    ? { mpn: known, placeholder: false }
    : { mpn: EBAY_MPN_NOT_APPLICABLE, placeholder: true };
}

/** Preview warnings for the eBay product identifiers the catalog lacks. */
export function ebayProductIdentifierWarnings(input: EbayMpnInput): string[] {
  return resolveEbayMpn(input).placeholder ? [EBAY_MPN_PLACEHOLDER_WARNING] : [];
}

function firstItemSpecific(specifics: Record<string, unknown> | null, name: string): unknown {
  if (!specifics) return null;
  const key = Object.keys(specifics).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (key === undefined) return null;
  const value = specifics[key];
  return Array.isArray(value) ? value[0] : value;
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
