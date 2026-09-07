import { formatStatus, type DropshipListingPreviewRow } from "./dropship-ops-surface";
import { isSafeDropshipPreviewImageUrl } from "@shared/dropship/listing-presentation";

/** Limit mounted rows; the existing preview request is still capped separately. */
export const LISTING_PREVIEW_PAGE_SIZE = 50;

export function pageListingPreviews(rows: readonly DropshipListingPreviewRow[], search: string, requestedPage: number) {
  const query = search.trim().toLocaleLowerCase("en-US");
  const matching = query ? rows.filter((row) =>
    [row.title, row.sku, row.presentation?.variantName].some((value) => value?.toLocaleLowerCase("en-US").includes(query))) : rows;
  const pages = Math.max(1, Math.ceil(matching.length / LISTING_PREVIEW_PAGE_SIZE));
  const page = Math.max(1, Math.min(pages, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const offset = (page - 1) * LISTING_PREVIEW_PAGE_SIZE;
  return { rows: matching.slice(offset, offset + LISTING_PREVIEW_PAGE_SIZE), page, pages, total: matching.length,
    start: matching.length ? offset + 1 : 0, end: Math.min(offset + LISTING_PREVIEW_PAGE_SIZE, matching.length) };
}

/** Server-authorized catalog files or external HTTP(S) images only; never active/data URLs. */
export function safeListingImageUrl(value: string | null | undefined): string | null {
  if (!value || value.trim() !== value || /[\u0000-\u0020\\]/.test(value)) return null;
  return isSafeDropshipPreviewImageUrl(value) ? value : null;
}

export function formatListingPreviewIssue(value: string): string {
  const labels: Record<string, string> = {
    "missing_config:marketplaceId": "eBay setup: Marketplace",
    "missing_config:merchantLocationKey": "eBay setup: Inventory location",
    "missing_config:businessPolicies.paymentPolicyId": "eBay setup: Payment policy",
    "missing_config:businessPolicies.returnPolicyId": "eBay setup: Return policy",
    "missing_config:businessPolicies.fulfillmentPolicyId": "eBay setup: Fulfillment policy",
    ebay_browse_category_required: "Card Shellz marketplace category setup required",
    vendor_unavailable: "Your Shellz Club account is unavailable. Contact support.",
    plan_unavailable: "Your .ops price list is unavailable. Contact support.",
    entitlement_inactive: "Your Shellz Club .ops access is inactive. Contact support.",
    variant_unmapped: "This product is not linked to your .ops price list. Contact support.",
    variant_ambiguous: "The .ops product mapping needs support review.",
    variant_identity_mismatch: "The product identity does not match your .ops price list. Contact support.",
    override_ambiguous: "The .ops product price has conflicting entries. Contact support.",
    override_invalid: "The .ops product price needs support review.",
    retail_unavailable: "The catalog retail price is unavailable. Contact support.",
    pricing_configuration_invalid: "Your .ops price list configuration needs support review.",
    source_read_failed: "The .ops product cost could not be loaded. Refresh the preview; contact support if this continues.",
    product_cost_source_unavailable: "The .ops product cost could not be loaded. Refresh the preview; contact support if this continues.",
  };
  return labels[value] ?? value.split(":").map(formatStatus).join(": ");
}

export function listingPreviewStatusTone(status: DropshipListingPreviewRow["previewStatus"]): string {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-800";
}
