import { describeDropshipListingMode, parseDropshipListingMode, type DropshipListingPreviewRow } from "./dropship-ops-surface";
import { isSafeDropshipPreviewImageUrl } from "@shared/dropship/listing-presentation";
import { LISTING_SHIPPING_ESTIMATE_WARNING } from "@shared/dropship/listing-shipping-estimate";
import { catalogStepPath } from "./dropship-catalog-steps";
import { STORE_DEFAULT_LABELS } from "./dropship-listing-settings-drafts";
import { drawerSearch } from "./dropship-listing-settings-drawer";
import { NOT_SET_NEEDED_TO_LIST, fulfillmentIssueReason, setupPolicyName, type PolicySetupFacts } from "./dropship-listing-settings-words";

/**
 * Step 3 ("Publish") of the Catalog page, in the vendor's words (Listing
 * settings PR 10h, plan §11): the issue words for every code the preview and
 * the queue can show, the link that replaces the step 3 editors, and the
 * policy names it can show without reading eBay. Pure: no React, no network.
 *
 * Words marked "Interim (PR 10 PROPOSAL)" are not in the design record (its
 * screen sections were lost); they live here only, so a later PR changes them
 * in one place. No function returns a code, an id or a category number.
 */

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

// ---------------------------------------------------------------------------
// Step 3 words outside the issue table (plan 11.2, 12.2 "Step 3")
// ---------------------------------------------------------------------------

// Interim (PR 10 PROPOSAL) except `changeInListingSettings` (REC:921), the row labels (R:90, STORE_DEFAULT_LABELS)
// and `skuUnavailable` (the sheet's words before PR 10h).
export const LISTING_PREVIEW_WORDS = Object.freeze({
  /** The link that replaces step 3's price and description editors (REC:921). */
  changeInListingSettings: "Change in Listing settings ›",
  /** Where a policy's name can't be read this visit (D14): a link, never an id. */
  setInListingSettingsLink: "Set in Listing settings ›",
  /** A value a product, category or size set (replaces "Listing override"). */
  setInListingSettings: "Set in Listing settings",
  storeDefault: "Store default",
  storeShelf: STORE_DEFAULT_LABELS.shelf,
  /** The sheet's heading over the three policy rows (replaces "Effective listing policies"). */
  listingPolicies: "Listing policies",
  /** A size without a SKU, in the table and the sheet; never the size's id. */
  skuUnavailable: "SKU unavailable",
  /** A problem code this page doesn't know; the code itself is never shown (REC:910). */
  unknownIssue: "Card Shellz can't list this yet. Contact support.",
  /** The line above the table, now that nothing on this step edits (replaces "Edit the listing price here, …"). */
  intro: "Product costs are for one sellable pack. Open a preview for details, images and shipping estimates. Prices and text are changed in Listing settings.",
});

/**
 * The row's listing mode in the store's own words ("Drafts only", "Live"),
 * never the Title-Cased code; "Not set" for a missing or unknown one.
 */
export function listingPreviewModeWords(listingMode: string | null | undefined): string {
  return describeDropshipListingMode(parseDropshipListingMode(listingMode ?? "")).label;
}

// ---------------------------------------------------------------------------
// Issue words: one table, keyed by code and by family (plan 12.3; mS3 c.1-c.3)
// ---------------------------------------------------------------------------

/**
 * Words for every code the preview row, the preview sheet and a blocked queue
 * item can carry (plan 12.3). Rows marked "keep" are PR 7's or older words,
 * kept as they were; every other row is Interim (PR 10 PROPOSAL).
 */
const ISSUE_WORDS: ReadonlyMap<string, string> = new Map<string, string>([
  // Step 1 (vendor-selection.ts).
  ["selection:not_exposed_by_admin", "Card Shellz doesn't offer this size right now."],
  ["selection:excluded_by_vendor_rule", "You left this size out in step 1."],
  ["selection:missing_vendor_include_rule", "This size isn't chosen in step 1."],
  ["selection:disabled_by_vendor_override", "You turned this size off in step 1."],
  // The store's listing setup (preview service; the config-driven provider).
  ["listing_config_required", "Your store's listing setup isn't finished. Open Listing settings."],
  ["listing_config_platform_mismatch", "This store's listing setup is for another marketplace. Contact support."],
  ["listing_config_inactive", "This store's listing setup is turned off. Contact support."],
  ["listing_config_manual_only", "This store lists by hand only. Contact support."],
  ["marketplace_quantity_unavailable", "Card Shellz couldn't work out how many to list. Preview again later."],
  // Card Shellz packaging and rates.
  ["catalog_package_data_required", "Card Shellz hasn't added this size's package size yet. Contact support."],
  ["active_box_required", "Card Shellz has no shipping box for this size yet. Contact support."],
  ["active_rate_table_required", "Card Shellz shipping rates aren't set up yet. Contact support."],
  // Prices (SH/pricing-rules.ts, SH/listing-price.ts, listing-price-cost.ts).
  ["vendor_retail_price_required", "This size has no price. Give it an exact price in Listing settings."],
  ["pricing_rules_not_configured", "No price is set. Set a store price in Listing settings."],
  ["pricing_rule_priority_conflict", "Two of your older price rules apply to this size. Give it a price in Listing settings."],
  ["pricing_basis_unavailable", "Card Shellz doesn't have the cost or retail price this price starts from."],
  ["pricing_result_out_of_range", "This price works out too high or too low. Change it in Listing settings."],
  // Interim (PR 12 PROPOSAL): the neighbours' action, now that pricing rules can't be edited.
  ["pricing_rule_outside_limit", "Your pricing rules give this size a price outside a Card Shellz price limit, so it can't be listed at that price. Give it an exact price in Listing settings."],
  // keep
  ["price_below_product_cost", "Priced below your .ops product cost: you lose money on every sale at this price. Raise the price, or list anyway and take the loss."],
  // The description (listing-content-resolver.ts).
  ["listing_content_template_conflict", "Two of your older description rules apply to this size. Set its description in Listing settings."],
  ["listing_content_catalog_review_required", "Card Shellz changed this product. Check your own text in Listing settings."],
  // keep
  ["listing_content_description_required", "Add a description or contact support to complete the catalog copy."],
  // keep
  ["listing_content_catalog_too_large", "The catalog description exceeds the supported size. Contact support."],
  ["listing_content_description_too_large", "The description is too long. Shorten your own text in Listing settings."],
  // eBay setup keys (the provider's `missing_config:<key>`; the other keys are the family below).
  ["missing_config:merchantLocationKey", "Your ship-from location isn't set. Update it in Listing settings."],
  ["missing_config:businessPolicies.fulfillmentPolicyId", "No shipping policy. Choose one in Listing settings."],
  ["missing_config:businessPolicies.returnPolicyId", "No return policy. Choose one in Listing settings."],
  ["missing_config:businessPolicies.paymentPolicyId", "No payment policy. Choose one in Listing settings."],
  // Product details (the provider's `missing_product_field:<field>`; other fields are the family below).
  ["missing_product_field:sku", "This size has no SKU. Contact support."],
  ["missing_product_field:title", "This product has no title. Contact support."],
  ["missing_product_field:description", "This product has no description. Contact support."],
  // keep
  ["missing_product_field:imageUrls", "This product has no photo that can be sent to the marketplace. Contact support."],
  ["listing_title_required", "This listing needs a title. Contact support."],
  ["variant_sku_required", "This size needs a SKU. Contact support."],
  ["listing_description_missing", "This listing has no description. Add your own in Listing settings."],
  ["ebay_browse_category_required", "No eBay category. Pick one in Listing settings."],
  // keep
  ["ebay_mpn_placeholder", "The catalog has no manufacturer part number (MPN) for this product, so eBay will show \"Does Not Apply\". Contact support if the product has one."],
  // eBay return and payment policies (ebay-return-payment-policy-blockers.ts): keep, naming Listing settings instead of "step 2, Listing settings".
  ["ebay_return_policy:not_found", "Your return policy is no longer on eBay. Choose a return policy in Listing settings."],
  ["ebay_payment_policy:not_found", "Your payment policy is no longer on eBay. Choose a payment policy in Listing settings."],
  ["ebay_return_policy:verification_unavailable", "Your return policy couldn't be checked with eBay. Refresh the preview; contact support if this continues."],
  ["ebay_payment_policy:verification_unavailable", "Your payment policy couldn't be checked with eBay. Refresh the preview; contact support if this continues."],
  // The catalog row and pack size.
  ["catalog_variant_not_found", "This size is no longer in the Card Shellz catalog."],
  ["sellable_pack_size_invalid", "Card Shellz's pack size for this product needs fixing. Contact support."],
  // The preview sheet (listing-presentation.ts).
  ["publication_preview_unavailable", "The preview couldn't be built. Preview again."],
  ["catalog_media_unavailable", "Card Shellz photos couldn't be loaded. Preview again."],
  ["images_unavailable", "Photos couldn't be loaded. Preview again."],
  ["unsafe_image_url", "This photo can't be sent to eBay."],
  ["not_in_publication_payload", "This photo isn't sent with the listing."],
  ["image_unavailable_or_unsafe", "This photo couldn't be loaded."],
  ["authenticated_catalog_image_only", "This photo is private to Card Shellz, so it isn't sent."],
  // keep (listing-photo-reasons.ts)
  ["catalog_photo_public_address_missing", "An uploaded catalog photo can't be sent to the marketplace yet, so this listing goes out without it. Card Shellz has to finish setting up photo hosting. Contact support."],
  ["catalog_photo_unavailable", "An uploaded catalog photo is missing, too large, or not a JPEG, PNG, WebP or GIF file, so this listing goes out without it. Contact support."],
  // Your product cost (dropship-product-cost.ts): keep, except the three "support review" rows.
  ["vendor_unavailable", "Your Shellz Club account is unavailable. Contact support."],
  ["plan_unavailable", "Your .ops price list is unavailable. Contact support."],
  ["entitlement_inactive", "Your Shellz Club .ops access is inactive. Contact support."],
  ["variant_unmapped", "This product is not linked to your .ops price list. Contact support."],
  ["variant_ambiguous", "Your Card Shellz price list needs a support check. Contact support."],
  ["variant_identity_mismatch", "The product identity does not match your .ops price list. Contact support."],
  ["override_ambiguous", "The .ops product price has conflicting entries. Contact support."],
  ["override_invalid", "Your Card Shellz price list needs a support check. Contact support."],
  ["retail_unavailable", "The catalog retail price is unavailable. Contact support."],
  ["pricing_configuration_invalid", "Your Card Shellz price list needs a support check. Contact support."],
  ["source_read_failed", "The .ops product cost could not be loaded. Refresh the preview; contact support if this continues."],
  ["product_cost_source_unavailable", "The .ops product cost could not be loaded. Refresh the preview; contact support if this continues."],
  // keep (listing-tiers.ts)
  ["listing_tier:autopay_off", "This listing's tier is not active: autopay is off, so your wallet has no reserve. Turn on autopay in Wallet."],
  ["listing_tier:reserve_below_tier", "This listing's tier is not active: your reserve is below the tier's amount. Raise your reserve in Wallet."],
  ["listing_tier:balance_below_tier", "This listing's tier is not active: your balance has not reached the tier's amount yet. Add money in Wallet."],
  // keep: the shipping estimate's one warning is already a sentence (SH/listing-shipping-estimate.ts) and passes through as it is.
  [LISTING_SHIPPING_ESTIMATE_WARNING, LISTING_SHIPPING_ESTIMATE_WARNING],
]);

// Interim (PR 10 PROPOSAL): words for whole families of codes (plan 12.3).
const ISSUE_FAMILY_WORDS = Object.freeze({
  /** `pricing:below_floor:policy_<id>` and `pricing:above_ceiling:policy_<id>`: the policy number is never shown. */
  priceLimit: "Outside a Card Shellz price limit.",
  /** Any other `missing_config:<key>`. */
  missingConfig: "Your eBay setup is missing a setting. Open Listing settings.",
  /** Any other `missing_product_field:<field>`. */
  missingProductField: "Card Shellz is missing product details. Contact support.",
  /** `ebay_fulfillment_policy:verification_unavailable`: eBay couldn't be asked, which is not "can't use". */
  fulfillmentUnchecked: "Your shipping policy couldn't be checked with eBay. Preview again later.",
  /** `ebay_fulfillment_policy:destination_coverage_incomplete`: Card Shellz's own gap, which step 2 also treats as unchecked. */
  fulfillmentCoverageGap: "Card Shellz can't check your shipping policy yet. Contact support.",
});

const PRICE_LIMIT_PREFIXES = ["pricing:below_floor:", "pricing:above_ceiling:"] as const;
const MISSING_CONFIG_PREFIX = "missing_config:";
const MISSING_PRODUCT_FIELD_PREFIX = "missing_product_field:";
const FULFILLMENT_POLICY_PREFIX = "ebay_fulfillment_policy:";

/**
 * `ebay_fulfillment_policy:<code>`: the step 2 reason for the code (R:575
 * words), read without Card Shellz shipping, so a too-short handling time
 * reads "too short for Card Shellz" rather than naming the days.
 */
function fulfillmentPolicyIssueWords(code: string): string {
  if (code === "verification_unavailable") return ISSUE_FAMILY_WORDS.fulfillmentUnchecked;
  if (code === "destination_coverage_incomplete") return ISSUE_FAMILY_WORDS.fulfillmentCoverageGap;
  return `Your shipping policy can't be used: ${fulfillmentIssueReason({ code }, null)}.`;
}

/** A problem code in the vendor's words. An unknown code reads as a Card Shellz problem; the code itself is never shown. */
export function formatListingPreviewIssue(value: string): string {
  const exact = ISSUE_WORDS.get(value);
  if (exact !== undefined) return exact;
  if (PRICE_LIMIT_PREFIXES.some((prefix) => value.startsWith(prefix))) return ISSUE_FAMILY_WORDS.priceLimit;
  if (value.startsWith(MISSING_CONFIG_PREFIX)) return ISSUE_FAMILY_WORDS.missingConfig;
  if (value.startsWith(MISSING_PRODUCT_FIELD_PREFIX)) return ISSUE_FAMILY_WORDS.missingProductField;
  if (value.startsWith(FULFILLMENT_POLICY_PREFIX)) return fulfillmentPolicyIssueWords(value.slice(FULFILLMENT_POLICY_PREFIX.length));
  return LISTING_PREVIEW_WORDS.unknownIssue;
}

// ---------------------------------------------------------------------------
// The link that replaces the editors (plan 11.2; REC:921)
// ---------------------------------------------------------------------------

function isPositiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * What a step 3 link opens in the drawer: a price lands on the size, whose
 * Exact price box gets focus (`size=`, R:360); the product's own things (its
 * description, its policies) open the drawer on the product alone (mS3 a.4).
 */
export type ListingPreviewSettingsTarget = "price" | "product";

/**
 * Where a step 3 row's price and text are changed: the product's drawer in
 * Listing settings (`/catalog/setup?product=&size=`, D21), landing on this
 * size for a price. Portal-relative; the page adds `dropshipPortalPath`. Null
 * for a row whose size is no longer in the catalog (the server sends
 * `productId: 0`), which has nothing to open.
 */
export function listingPreviewSettingsLink(
  row: Pick<DropshipListingPreviewRow, "productId" | "productVariantId">,
  target: ListingPreviewSettingsTarget = "price",
): string | null {
  if (!isPositiveId(row.productId)) return null;
  const drawerTarget = target === "price" && isPositiveId(row.productVariantId)
    ? { productId: row.productId, productVariantId: row.productVariantId }
    : { productId: row.productId };
  return `${catalogStepPath("setup")}${drawerSearch("", drawerTarget)}`;
}

// Interim (PR 10 PROPOSAL): the links' names for a screen reader, so identical links tell apart (plan 3.4).
// Each starts with the link's visible words, then names its row.
/** "Change in Listing settings: <size>", the size being its SKU or, without one, the listing's title. */
export function listingPreviewSettingsLinkName(size: string): string {
  return `Change in Listing settings: ${size}`;
}
/** "Change in Listing settings: description of <listing>": the sheet's description link, told apart from its price link. */
export function listingPreviewDescriptionLinkName(title: string): string {
  return `Change in Listing settings: description of ${title}`;
}
/** "Return policy: Set in Listing settings": a policy row's link, named by its row. */
export function listingPreviewPolicyLinkName(label: string): string {
  return `${label}: ${LISTING_PREVIEW_WORDS.setInListingSettings}`;
}

// ---------------------------------------------------------------------------
// Policy names on step 3 (plan D14: client-only, partly delivered)
// ---------------------------------------------------------------------------

export type ListingPreviewPolicyField = "fulfillmentPolicyId" | "returnPolicyId" | "paymentPolicyId";

const POLICY_KIND_BY_FIELD = {
  fulfillmentPolicyId: "shipping",
  returnPolicyId: "return",
  paymentPolicyId: "payment",
} as const;

/** The three policy rows in step 2's order, each with its step 2 name (R:90). */
export const LISTING_PREVIEW_POLICY_FIELDS: ReadonlyArray<{ field: ListingPreviewPolicyField; label: string }> = Object.freeze([
  { field: "fulfillmentPolicyId", label: STORE_DEFAULT_LABELS.shipping },
  { field: "returnPolicyId", label: STORE_DEFAULT_LABELS.return },
  { field: "paymentPolicyId", label: STORE_DEFAULT_LABELS.payment },
]);

/**
 * A policy's name on step 3 (D14): eBay's live name from the setup read step 2
 * made this visit, else the name stored for the store default, else null, so
 * the row shows "<Shipping policy>: Set in Listing settings ›" and never an id.
 * On a direct load of step 3 the setup cache is empty, so every row links.
 */
export function stepThreePolicyName(field: ListingPreviewPolicyField, policyId: string | null, setup: PolicySetupFacts | undefined): string | null {
  if (!policyId || setup === undefined) return null;
  return setupPolicyName(setup, POLICY_KIND_BY_FIELD[field], policyId);
}

/** A policy row's link to the product's drawer: portal-relative `href`, the visible `words` and the row's `name` (plan 3.4). */
export interface ListingPreviewPolicyLink { href: string; words: string; name: string }

export type ListingPreviewPolicyLine =
  | { field: ListingPreviewPolicyField; label: string; kind: "named"; name: string; source: string }
  /**
   * A policy is set but no name can be read this visit: the row is the link,
   * with its source under it, or its source alone when the size has nothing
   * to open (`link: null`). Under the link, a source of "Set in Listing
   * settings" would only repeat the link's own words, so it is null then.
   */
  | { field: ListingPreviewPolicyField; label: string; kind: "unnamed"; link: ListingPreviewPolicyLink | null; source: string | null }
  | { field: ListingPreviewPolicyField; label: string; kind: "not_set"; words: string };

/**
 * The "Listing policies" rows of the preview sheet, one per policy, from the
 * row's selection, the setup cache (D14) and the row's drawer address
 * (`listingPreviewSettingsLink(row, "product")`, null for a size with nothing
 * to open). The source reads "Store default", or "Set in Listing settings"
 * for a value a size, product or category set (the preview counts all three
 * as overridden, so no finer source is known).
 */
export function listingPreviewPolicyLines(
  selection: NonNullable<DropshipListingPreviewRow["businessPolicySelection"]>,
  setup: PolicySetupFacts | undefined,
  settingsPath: string | null,
): ListingPreviewPolicyLine[] {
  return LISTING_PREVIEW_POLICY_FIELDS.map(({ field, label }) => {
    const policyId = selection[field];
    if (!policyId) return { field, label, kind: "not_set", words: NOT_SET_NEEDED_TO_LIST };
    const overridden = selection.overriddenFields.includes(field);
    const source = overridden ? LISTING_PREVIEW_WORDS.setInListingSettings : LISTING_PREVIEW_WORDS.storeDefault;
    const name = stepThreePolicyName(field, policyId, setup);
    if (name !== null) return { field, label, kind: "named", name, source };
    const link: ListingPreviewPolicyLink | null = settingsPath === null ? null
      : { href: settingsPath, words: LISTING_PREVIEW_WORDS.setInListingSettingsLink, name: listingPreviewPolicyLinkName(label) };
    return { field, label, kind: "unnamed", link, source: link !== null && overridden ? null : source };
  });
}

export function listingPreviewStatusTone(status: DropshipListingPreviewRow["previewStatus"]): string {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-800";
}
