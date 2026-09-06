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
  };
  return labels[value] ?? value.split(":").map(formatStatus).join(": ");
}

export function listingPreviewStatusTone(status: DropshipListingPreviewRow["previewStatus"]): string {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-800";
}
