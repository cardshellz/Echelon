import { ebayListingIssueSchema, type EbayListingIssue } from "./types/ebay-listing-issue";

export interface EbayListingIssueInput {
  code?: string | null;
  message?: string | null;
  productId?: number;
  jobId?: string;
  state?: string;
}

/** One presentation contract for API results, saved work, and older server responses.
 * Codes determine available actions. Provider prose never decides permissions or retry policy. */
export function resolveEbayListingIssue(input: EbayListingIssueInput): EbayListingIssue {
  const code = input.code && /^[A-Z0-9_]{1,100}$/.test(input.code) ? input.code : "EBAY_LISTING_OPERATION_FAILED";
  const productPath = Number.isSafeInteger(input.productId) && input.productId! > 0 ? `/products/${input.productId}` : "/channels/ebay";
  const reference = input.jobId && /^[a-f0-9-]{36}$/i.test(input.jobId) ? input.jobId : undefined;
  const message = safeListingDiagnostic(input.message);
  const issue = (title: string, fallback: string, nextStep: string, retryable: boolean,
    kind: EbayListingIssue["action"]["kind"], label: string, href?: string): EbayListingIssue =>
    ebayListingIssueSchema.parse({ code, title, message: message || fallback, nextStep, retryable,
      action: { kind, label, ...(href ? { href } : {}) }, ...(reference ? { reference } : {}),
      ...(input.productId ? { details: [{ label: "Product ID", value: String(input.productId) }] } : {}) });

  if (["EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED", "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED", "PUBLICATION_REQUEST_EVIDENCE_INCOMPLETE",
    "EBAY_QUANTITY_RESPONSE_UNCERTAIN", "QUANTITY_PROVIDER_REQUEST_TIMEOUT"].includes(code))
    return issue("An earlier quantity update needs review", "Echelon cannot confirm the outcome of an earlier eBay quantity request.",
      "Review the saved request and its response. An inventory administrator can authorize a fresh update using current inventory when the old outcome remains unknown.",
      false, "check_recovery", "Review blocked update");
  if (["EBAY_RECOVERY_BUSY", "EBAY_RECOVERY_PREVIEW_CHANGED", "EBAY_RECOVERY_STATE_CHANGED", "EBAY_RECOVERY_SCOPE_CHANGED", "EBAY_RECOVERY_REPLAY_CONFLICT"].includes(code))
    return issue("Review the latest request details", "The saved request changed while recovery was being reviewed.",
      "Refresh the request details. If a request is still running, wait for it to finish; otherwise review and confirm the updated recovery preview.",
      false, "check_recovery", "Refresh request details");
  if (code === "EBAY_RECOVERY_FOLLOWUP_PENDING")
    return issue("Recovery is saved; the follow-up is pending", "The recovery decision committed, but the immediate listing follow-up could not be queued.",
      "Refresh the saved sync status. If it remains blocked, retry the same recovery confirmation; its saved receipt prevents a duplicate recovery decision.",
      false, "check_recovery", "Review saved recovery");
  if (["EBAY_MAPPING_REVIEW_STALE", "EBAY_MAPPING_REVIEW_CHANGED"].includes(code))
    return issue("Review the current listing before applying this fix", "The listing or saved mapping changed after this review.",
      "Recheck the mapping to load the current comparison and recommendation. Review those changes before applying a new correction.",
      false, "review_mapping", "Review current mapping");
  if (code === "EBAY_MAPPING_COMMAND_CONFLICT")
    return issue("The saved request belongs to a different confirmation", "This request reference is already associated with another product, review, or requester.",
      "Keep the request reference shown in the mapping dialog. An administrator must compare its saved receipt with this product and requester before another correction is sent.",
      false, "review_mapping", "Check saved mapping request");
  if (["EBAY_MAPPING_REPAIR_UNSAFE", "EBAY_MAPPING_OWNERSHIP_CONFLICT", "EBAY_MAPPING_CANONICAL_CONFLICT", "EBAY_MAPPING_SOURCE_INVALID", "EBAY_MAPPING_SCOPE_INVALID"].includes(code))
    return issue("This mapping needs a different correction", "Echelon cannot safely apply the proposed mapping correction.",
      "Open the current mapping review for the exact conflicting variants and the recommended next action.",
      false, "review_mapping", "Review mapping issue");
  if (["EBAY_MAPPING_PERSISTENCE_FAILED", "EBAY_MAPPING_RECEIPT_SCOPE_INVALID"].includes(code))
    return issue("Check the saved mapping repair", "The result of this mapping repair could not be confirmed.",
      "Keep this request reference. Use Check saved request or Retry this fix in the mapping dialog; Echelon will reuse the same request instead of creating another repair.",
      false, "review_mapping", "Check mapping repair");
  if (code === "EBAY_MAPPING_PRODUCT_NOT_ELIGIBLE")
    return issue("Choose which variants to update", "This product has no included variants available for listing sync.",
      "Enable the intended product and variant inclusion switches in the listing feed, then recheck this product's mapping.",
      false, "edit_listing", "Open listing feed", "/channels/ebay");
  if (["EBAY_SYNC_PRODUCT_NOT_FOUND", "EBAY_LISTING_INPUT_INVALID"].includes(code))
    return issue("Refresh the listing selection", "The selected product is missing or the request is invalid.",
      "Return to the listing feed and refresh it. Select the current product before requesting another update.",
      false, "edit_listing", "Open listing feed", "/channels/ebay");
  if (code === "EBAY_SYNC_COMMAND_UNCONFIRMED")
    return issue("The sync response was lost", "Echelon could not confirm whether this request was saved.",
      "Retry this request. Echelon will reuse its command reference to find or save the same update without creating a duplicate.",
      true, "retry_sync", "Retry this request");
  if (code === "EBAY_LISTING_CAPACITY_CONFIGURATION")
    return issue("Publishing needs an administrator configuration change", "The database connection limit cannot safely run listing publication.",
      "Give this code and the connection requirement above to an administrator. After they adjust the database pool capacity, retry this product.",
      false, "contact_support", "Copy diagnostic details");
  if (["EBAY_AUTH_CONFIGURATION_INVALID", "EBAY_AUTH_RESPONSE_INVALID"].includes(code))
    return issue("The eBay connection needs administrator attention", "Echelon could not validate the eBay authorization configuration or response.",
      "Open Connection settings and give the displayed error code to an administrator. After correcting the connection, retry the listing update.",
      false, "reconnect", "Open connection settings", "/channels/ebay#connection");
  if (code === "EBAY_PROVIDER_ACCESS_DENIED")
    return issue("eBay denied access to this listing operation", "eBay returned an access denial for this request.",
      "Review the eBay error above and the seller account's access to this listing or API. An administrator must correct the permission or account restriction before retrying.",
      false, "reconnect", "Open connection settings", "/channels/ebay#connection");
  if (code === "EBAY_LISTING_ALREADY_PUBLISHED")
    return issue("This product already has an eBay listing", "The saved product mapping identifies an existing published listing.",
      "Use Sync to update the existing listing. This verifies its saved eBay SKU, offer and group before changing it.",
      true, "retry_sync", "Sync existing listing");
  if (["EBAY_SYNC_AUTH_REQUIRED", "EBAY_AUTH_REQUIRED", "EBAY_AUTH_EXPIRED", "EBAY_TOKEN_EXPIRED", "EBAY_NOT_CONNECTED",
    "EBAY_OAUTH_SCOPE_MISSING", "EBAY_PROVIDER_ACCOUNT_IDENTITY_CONFLICT", "EBAY_PROVIDER_ACCOUNT_IDENTITY_NOT_PERSISTED"].includes(code))
    return issue("Reconnect the eBay account", "The saved eBay connection cannot authorize this operation.",
      "Open Connection settings, reconnect the intended eBay account, then return to this product and retry the update.",
      false, "reconnect", "Open connection settings", "/channels/ebay#connection");
  if (["EBAY_CATALOG_PHOTO_REQUIRED", "EBAY_CATALOG_PHOTO_UNAVAILABLE", "EBAY_EXISTING_GROUP_PHOTOS_REQUIRED", "EBAY_PHOTO_SCOPE_INVALID"].includes(code))
    return issue("Review this product's photos", "An included variant has no usable catalog photo for eBay.",
      "Open Images. Include a usable product photo for All variants or assign a photo to each included variant, save, then retry the listing update.",
      false, "edit_photos", "Open product images", `${productPath}?tab=images`);
  if (code === "EBAY_LISTING_REVIEW_CHANGED")
    return issue("Review the listing again", "The listing changed after its previous review.",
      "Close the previous review and run Analyze listing again. Review the current members and proposed change before confirming the available update action.",
      false, "review_mapping", "Review listing again");
  if (code === "EBAY_LISTING_RESTORE_FAILED")
    return issue("The listing change needs recovery", "A partial variation change could not be restored automatically.",
      "Review the current eBay group, offers and listing before making another change. An administrator must reconcile the partially applied membership against the saved review.",
      false, "review_mapping", "Review current listing");
  if (code === "EBAY_SYNC_PROVIDER_RESPONSE_INVALID")
    return issue("eBay returned an incomplete listing response", "Echelon could not validate a required provider response.",
      "Review the current listing and saved request before retrying. A creation or publication may have completed even when its response was incomplete; Echelon must rediscover the exact existing identity first.",
      false, "review_mapping", "Review current listing");
  if (["EBAY_SYNC_IDENTITY_CHANGED", "EBAY_SYNC_OFFER_IDENTITY_CHANGED", "EBAY_SYNC_PROJECTION_IDENTITY_CHANGED", "EBAY_SYNC_PROVIDER_IDENTITY_CHANGED",
    "EBAY_SYNC_OFFER_MISSING", "EBAY_SYNC_SOURCE_INVALID", "EBAY_SYNC_SCOPE_UNAVAILABLE", "PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN",
    "EBAY_SYNC_DRAFT_SCOPE_INVALID", "EBAY_SYNC_PROVIDER_MEMBERSHIP_UNPROVEN", "EBAY_SYNC_MAPPING_INVALID",
    "EBAY_SYNC_LISTING_IDENTITY_REQUIRED", "EBAY_SYNC_MEMBERSHIP_CHANGED", "EBAY_SYNC_GROUP_IDENTITY_REQUIRED", "EBAY_SYNC_PROVIDER_IDENTITY_INVALID",
    "EBAY_SYNC_RETAINED_IDENTITY_CHANGED"].includes(code))
    return issue("Review the existing listing mapping", "The saved product-to-eBay mapping could not be verified.",
      "Open the mapping review to compare the saved mapping with eBay, see the exact issue and review the recommended correction. Apply the verified fix there when available.",
      false, "review_mapping", "Review listing mapping");
  if (["EBAY_QUANTITY_DAILY_LIMIT", "PUBLICATION_PROVIDER_COOLDOWN", "EBAY_PROVIDER_RATE_LIMITED"].includes(code))
    return issue("eBay is temporarily limiting updates", "eBay has asked Echelon to wait before another update.",
      reference && input.state !== "needs_attention"
        ? "Your saved update will retry after the displayed retry time. Repeated Sync clicks do not shorten eBay's waiting period."
        : "Wait for eBay's stated retry period, then retry this product. Repeated clicks do not shorten eBay's waiting period.",
      false, "check_recovery", "View update status");
  if (["PUBLICATION_GLOBAL_STOP_ACTIVE", "PUBLICATION_GLOBAL_DISABLED", "QUANTITY_PUBLICATION_SUPPRESSED", "PUBLICATION_LEGACY_CHANNEL_NOT_LIVE"].includes(code))
    return issue("Inventory publishing is paused", "The inventory publication owner currently prevents this listing update.",
      "An inventory administrator must review the channel's publication status. Once publishing is allowed, saved sync work continues automatically; retry Publish if this product has no saved sync job.",
      false, "edit_listing", "Open inventory settings", "/channels/inventory");
  if (["EBAY_SYNC_READBACK_PENDING", "EBAY_PHOTO_READ_FAILED", "EBAY_SYNC_PERSISTENCE_FAILED", "PUBLICATION_RESPONSE_RECOVERY_FAILED",
    "PUBLICATION_SCOPE_BUSY", "PUBLICATION_ADMISSION_CAPACITY_BUSY", "QUANTITY_PUBLICATION_DRAIN_BUSY", "EBAY_SYNC_ADMISSION_UNSAVED",
    "EBAY_SYNC_ADMISSION_FAILED", "EBAY_REGISTRATION_READ_TIMEOUT", "EBAY_REGISTRATION_READ_FAILED", "EBAY_AUTH_UNAVAILABLE", "EBAY_AUTH_REFRESH_SUPERSEDED",
    "EBAY_LISTING_SYNC_FAILED", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(code))
    return issue(input.state === "recovering" ? "Echelon is recovering this update" : "The update could not finish",
      "A temporary provider or local persistence failure interrupted the update.",
      input.state === "recovering" ? "The saved update will retry automatically. Open its status to see the latest result."
        : "Retry this product. Echelon checks the saved request and existing listing before sending another update.",
      input.state !== "recovering", input.state === "recovering" ? "check_recovery" : "retry_sync",
      input.state === "recovering" ? "View update status" : "Retry this product");
  if (["EBAY_SYNC_PRODUCT_NOT_ELIGIBLE", "EBAY_SYNC_CONTENT_SCOPE_EMPTY"].includes(code))
    return issue("Review which variants are included", "This product has no eligible existing listing update.",
      "Check the product and variant inclusion switches in the eBay listing feed. Enable the intended sellable variants; use Publish for a product without an existing eBay listing.",
      false, "edit_listing", "Open listing feed", "/channels/ebay");
  if (["EBAY_QUANTITY_REJECTED", "EBAY_LISTING_VALIDATION_FAILED", "EBAY_LISTING_PREFLIGHT_FAILED", "STOCK_LISTING_ATP_NOT_READY"].includes(code))
    return issue("Listing details need attention", "The listing does not meet a required eBay or inventory condition.",
      "Review the specific requirement above. Open this product's listing settings to correct its category, item specifics, policies or availability, then retry.",
      false, "edit_listing", "Open listing settings", `${productPath}?tab=channels`);
  return issue("This listing needs investigation", "The listing operation failed without a recognized recovery classification.",
    reference
      ? "Copy the diagnostic details, including the product and reference, for an administrator. The saved update remains available for inspection."
      : "Copy the diagnostic details and product ID for an administrator. Check the listing feed for its current state before retrying.",
    false, "contact_support", "Copy diagnostic details");
}

export function safeListingDiagnostic(value: string | null | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi, "[URL]")
    .replace(/(access_token|refresh_token|client_secret|authorization)[\s:=]+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000);
}
