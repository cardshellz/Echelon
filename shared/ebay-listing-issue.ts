import { ebayListingIssueSchema, type EbayListingIssue } from "./types/ebay-listing-issue";
import type { EbayListingSyncJob } from "./types/ebay-listing-sync";

function isAutomaticResponseRecovery(code: string | null | undefined, state: string | undefined): boolean {
  return state === "recovering" && (code === "EBAY_QUANTITY_RESPONSE_UNCERTAIN" || code === "QUANTITY_PROVIDER_REQUEST_TIMEOUT");
}

function isUnresolvedListingRequest(code: string | null | undefined): boolean {
  return code === "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED" || code === "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED"
    || code === "PUBLICATION_REQUEST_EVIDENCE_INCOMPLETE";
}

/** A previous attempt's error can remain on a queued/running snapshot. Only
 * the saved stopped or recovering state makes that diagnostic actionable. */
export function resolveEbayListingJobIssue(job: EbayListingSyncJob): EbayListingIssue | null {
  if (["queued", "running", "completed"].includes(job.state)) return null;
  if (job.state === "recovering" && !job.code && !job.issue) return null;
  // Older responses classified these transport failures as manual recovery.
  // The saved job's automatic retry state takes precedence over that old card.
  const code = job.code ?? job.issue?.code;
  if (isAutomaticResponseRecovery(code, job.state)) return resolveEbayListingIssue({ code,
    productId: job.productId, jobId: job.id, state: job.state });
  // These codes cover publication and content requests as well as quantities.
  // Replace older cached quantity-only copy without changing the saved outcome.
  if (isUnresolvedListingRequest(code)) return resolveEbayListingIssue({ code,
    message: job.message, productId: job.productId, jobId: job.id, state: job.state, operation: job.operation });
  return job.issue ?? resolveEbayListingIssue({ code: job.code, message: job.message,
    productId: job.productId, jobId: job.id, state: job.state });
}

export interface EbayListingIssueInput {
  code?: string | null;
  message?: string | null;
  productId?: number;
  jobId?: string;
  state?: string;
  operation?: EbayListingSyncJob["operation"];
  quantityBlockerCodes?: readonly string[];
}

/** One presentation contract for API results, saved work, and older server responses.
 * Codes determine available actions. Provider prose never decides permissions or retry policy. */
export function resolveEbayListingIssue(input: EbayListingIssueInput): EbayListingIssue {
  const code = input.code && /^[A-Z0-9_]{1,100}$/.test(input.code) ? input.code : "EBAY_LISTING_OPERATION_FAILED";
  const automaticResponseRecovery = isAutomaticResponseRecovery(code, input.state);
  const productPath = Number.isSafeInteger(input.productId) && input.productId! > 0 ? `/products/${input.productId}` : "/channels/ebay";
  const inventoryPath = Number.isSafeInteger(input.productId) && input.productId! > 0 ? `/channels/inventory?product=${input.productId}` : "/channels/inventory";
  const reference = input.jobId && /^[a-f0-9-]{36}$/i.test(input.jobId) ? input.jobId : undefined;
  // Read failures can contain database/transport diagnostics. Only our fixed
  // copy is public; details and references are supplied by the read boundary.
  const isFeedReadIssue = input.code === "EBAY_LISTING_FEED_UNAVAILABLE" || input.code?.startsWith("EBAY_FEED_QUANTITY_")
    || input.code?.startsWith("CANONICAL_CHANNEL_QUANTITY_");
  // Older jobs saved generic contention prose and described invalid prepared
  // drafts as mapping faults. Present the classified cause and current action.
  const message = isFeedReadIssue || automaticResponseRecovery || (input.state === "recovering" && isUnresolvedListingRequest(code))
    || ["INVENTORY_PUBLICATION_TARGET_BUSY", "EBAY_SYNC_DRAFT_SCOPE_INVALID", "CANONICAL_PUBLICATION_MAPPING_MISSING", "PUBLICATION_AUTOMATIC_RECOVERY_FAILED"].includes(code)
    ? undefined : safeListingDiagnostic(input.message);
  const issue = (title: string, fallback: string, nextStep: string, retryable: boolean,
    kind: EbayListingIssue["action"]["kind"], label: string, href?: string): EbayListingIssue =>
    ebayListingIssueSchema.parse({ code, title, message: message || fallback, nextStep, retryable,
      action: { kind, label, ...(href ? { href } : {}) }, ...(reference ? { reference } : {}),
      ...(input.productId ? { details: [{ label: "Product ID", value: String(input.productId) }] } : {}) });

  if (code === "EBAY_LISTING_FEED_UNAVAILABLE")
    return issue("Listings could not be loaded", "Echelon could not read the listing feed. Listing status and quantities are unavailable.",
      "Use Reload listings to try the read again. If it still fails, copy the diagnostic reference for an administrator to investigate the failed read.",
      false, "contact_support", "Copy diagnostic details");
  if (code === "EBAY_FEED_QUANTITY_UNAVAILABLE")
    return issue("Inventory could not be loaded", "Echelon could not read this product's current eBay quantity. Other products can still be viewed.",
      "Use Reload inventory to try this read again. If it still fails, copy the diagnostic reference for an administrator. Publishing checks current stock separately.",
      false, "contact_support", "Copy diagnostic details");
  if (code === "EBAY_FEED_QUANTITY_MISSING")
    return issue("A variant has no stock destination quantity", "The inventory reader did not return a quantity for one or more selected, inventory-managed variants in this product.",
      "Open inventory settings for this product and check the eBay destination and variant eligibility. After correcting the reported setup, use Reload inventory. An unavailable quantity is not zero stock.",
      false, "edit_listing", "Open inventory settings", inventoryPath);
  if (code === "EBAY_FEED_QUANTITY_INVALID")
    return issue("Inventory returned an invalid quantity", "The inventory reader returned an invalid or duplicate variant quantity, so this product's stock cannot be displayed reliably.",
      "Copy the diagnostic reference for an administrator to inspect the inventory result. Do not change stock quantities or listing links to work around this error.",
      false, "contact_support", "Copy diagnostic details");
  if (code === "CANONICAL_CHANNEL_QUANTITY_BLOCKED")
    return issue("Stock setup needs a correction", input.quantityBlockerCodes?.map(blocker => Object.hasOwn(quantityReadBlockerMessages, blocker)
      ? quantityReadBlockerMessages[blocker] : undefined).find(Boolean)
      ?? "The inventory source, channel policy or listing selection failed a stock check for this product.",
      "Open inventory settings for this product and review the reported inventory check and stock destination. Correct the setup, then use Reload inventory.",
      false, "edit_listing", "Open inventory settings", inventoryPath);
  if (["CANONICAL_CHANNEL_QUANTITY_TARGET_AMBIGUOUS", "CANONICAL_CHANNEL_QUANTITY_TARGET_DUPLICATE"].includes(code))
    return issue("More than one stock destination matched", "Echelon found duplicate or conflicting eBay stock destinations for a variant and cannot choose its quantity.",
      "Open inventory settings for this product. An administrator must correct the duplicate or conflicting eBay destinations, then use Reload inventory.",
      false, "edit_listing", "Open inventory settings", inventoryPath);
  if (code === "PUBLICATION_SELECTION_BUSY")
    return issue("A stock update is finishing", "Your channel selection was not saved because a stock update is still finishing.",
      "Wait a moment, then retry the same selection change. If the inclusion dialog is open, use its retry button so the original request reference is kept.",
      false, "edit_listing", "Return to listing selection", "/channels/ebay");
  if (code === "CHANNEL_SELECTION_CONNECTION_UNRESOLVED")
    return issue("Correct the saved eBay connection", "The stock destination does not identify one exact saved channel connection.",
      "Open Connection settings and verify the intended seller account. An administrator must correct any missing, duplicate or mismatched saved connection before you retry this listing request.",
      false, "reconnect", "Open connection settings", "/channels/ebay#connection");
  if (["CHANNEL_SELECTION_JOB_SCOPE_CHANGED", "CHANNEL_SELECTION_AMBIGUOUS", "PUBLICATION_SELECTION_IDENTITY_INCOMPLETE"].includes(code))
    return issue("Review the saved listing identities", "The saved listing selection does not identify one consistent product and variant scope.",
      "Open the mapping review and compare the product, variants and saved eBay identities. Correct any verified mapping issue there; if duplicate or conflicting saved records remain, copy this code and request reference for an administrator.",
      false, "review_mapping", "Review listing mapping");
  if (["DROPSHIP_STOCK_SELECTION_AMBIGUOUS", "DROPSHIP_STOCK_STORE_NOT_FOUND"].includes(code))
    return issue("Correct the Dropship store connection", "A stock destination's Dropship store connection or listing selection could not be resolved.",
      "Open Dropship administration and check the affected store connection and listing configuration. An administrator must correct the missing connection or duplicate selection records before this saved listing request can continue.",
      false, "edit_listing", "Open Dropship administration", "/dropship");
  if (code === "DROPSHIP_CATALOG_VARIANT_UOM_TYPE_INVALID")
    return issue("Correct the variant's unit of measure", "A catalog variant has an invalid unit of measure, so its store listing eligibility cannot be verified.",
      "Open this product's variants and correct the affected variant's unit of measure. Then retry the saved listing request so stock selection can be checked again.",
      false, "edit_listing", "Open product variants", `${productPath}?tab=variants`);
  if (code === "PUBLICATION_SELECTION_DESTINATION_INVALID")
    return issue("Correct the inventory destination", "The stock destination has inconsistent channel or store connection ownership.",
      "Open Channel Inventory for this product and check the selected destination. An administrator must correct its channel or store connection ownership before retrying the saved listing request.",
      false, "edit_listing", "Open inventory settings", inventoryPath);
  if (code === "PUBLICATION_SELECTION_CLOCK_INVALID")
    return issue("Stock selection needs an administrator check", "The saved operation could not obtain a valid transaction time for stock selection.",
      "Copy this code and request reference for an administrator to inspect the failed operation. Its saved request remains available; do not change listing mappings to work around this failure.",
      false, "contact_support", "Copy diagnostic details");
  if (["EBAY_PUBLICATION_STOCK_REVIEW_REQUIRED", "EBAY_PUBLICATION_STOCK_APPLY_RETIRED", "STOCK_LISTING_EXCLUDED"].includes(code))
    return issue("Continue publishing this selected product", "The previous publication stopped before its inventory connections were ready.",
      "Retry this product. The saved publishing workflow checks the existing offers and prepares matching inventory connections from your channel selection before publishing with current stock and pictures.",
      true, "retry_sync", "Retry publishing");
  if (["EBAY_PUBLICATION_STOCK_REVIEW_STALE", "STOCK_MAPPING_CONCURRENT_CHANGE", "STOCK_MAPPING_PROVIDER_BUSY", "STOCK_MAPPING_CLEANUP_UNCERTAIN",
    "STOCK_MAPPING_REVIEW_STALE", "STOCK_MAPPING_TARGET_CHANGED"].includes(code))
    return issue("Inventory preparation needs another check", "The inventory connection changed or has earlier work to finish.",
      "Echelon retries this saved request using current inventory connections. If automatic retries stop, use Sync to continue with the current stock and pictures.",
      true, "retry_sync", "Retry saved listing");
  if (code === "STOCK_MAPPING_COMMAND_CONFLICT")
    return issue("Check the saved inventory preparation request", "This request reference belongs to different inventory preparation inputs.",
      "Keep the original request reference and copy its diagnostic details for an administrator to inspect. Do not replace it while the saved outcome is being checked.",
      false, "contact_support", "Copy diagnostic details");
  if (code === "STOCK_LISTING_NOT_SELECTED")
    return issue("This product is not selected for eBay", "The channel selection excludes this product or variant.",
      "Return to the eBay listing feed and enable the product and variants you intend to sell. Then use Publish; inventory preparation follows that selection.",
      false, "edit_listing", "Review channel selection", "/channels/ebay");
  if (["STOCK_LISTING_ATP_NOT_READY", "EBAY_PUBLICATION_STOCK_REVIEW_BLOCKED", "STOCK_LISTING_TARGET_MISMATCH", "STOCK_LISTING_GLOBAL_STOP",
    "STOCK_LISTING_HELD", "STOCK_LISTING_QUANTITY_UNAVAILABLE", "STOCK_LISTING_MAPPING_CONFLICT", "STOCK_LISTING_MAPPING_REVIEW_REQUIRED",
    "STOCK_MAPPING_NOT_READY", "STOCK_LISTING_TARGET_UNAVAILABLE", "STOCK_MAPPING_SCOPE_TOO_LARGE", "STOCK_MAPPING_AUTHORITY_CHANGED"].includes(code))
    return issue("Correct the inventory issue before publishing", "The canonical inventory checks did not allow this listing to publish.",
      "Open Channel Inventory for this product, choose eBay, and correct the reported stock destination, warehouse, hold, mapping or quantity issue. Then return to the listing feed and retry Publish.",
      false, "edit_listing", "Open inventory settings", inventoryPath);
  if (code === "STOCK_LISTING_ACCOUNT_CHANGED")
    return issue("Reconnect the expected eBay seller account", "The inventory destination and current eBay account do not match.",
      "Open Connection settings and reconnect the intended seller account. Retry Publish after the account is verified.",
      false, "reconnect", "Open connection settings", "/channels/ebay#connection");
  if (code === "STOCK_LISTING_SOURCE_CHANGED")
    return issue("Review the selected product variants", "A catalog variant or its exact eBay SKU changed before publication.",
      "Open this product's variants and check their SKU and sale eligibility. Correct the reported variant, then review its eBay listing mapping before retrying Publish.",
      false, "edit_listing", "Open product variants", `${productPath}?tab=variants`);
  if (code === "EBAY_PUBLICATION_STOCK_COMMAND_CONFLICT")
    return issue("Check the saved stock request", "This command reference is already associated with a different stock review or requester.",
      "Keep the original request reference. An administrator must compare the saved receipt's product, review and requester before another command is sent. Copy the diagnostic details for that check.",
      false, "contact_support", "Copy diagnostic details");
  if (code === "EBAY_PUBLICATION_STOCK_SOURCE_CHANGED")
    return issue("Review the current listing before connecting stock", "The product's account, inclusion or eBay mapping changed after its stock review.",
      "Refresh the listing and check its current mapping. Correct the reported identity or selection change, then retry Publish from the listing feed.",
      false, "review_mapping", "Review current listing");
  if (["EBAY_WITHDRAWAL_IN_PROGRESS", "EBAY_WITHDRAWAL_READBACK_PENDING", "EBAY_WITHDRAWAL_UNVERIFIED"].includes(code))
    return issue("Checking removal from eBay", "The saved removal has not yet been verified complete on eBay.",
      "Open the saved removal status. Echelon checks eBay's response and listing state before marking it ended; the product stays excluded while removal is pending.",
      false, "check_status", "View removal status");
  if (code === "EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN")
    return issue("Removal was interrupted", "Echelon cannot confirm whether the earlier removal request reached eBay.",
      "Review the saved removal. An inventory administrator can authorize that same request to check the exact eBay listing and resume removal if it remains published.",
      false, "check_recovery", "Review interrupted removal");
  if (code === "EBAY_WITHDRAWAL_OWNER_REQUIRED")
    return issue("Removal must use the saved listing request", "This removal did not run through the listing operation owner.",
      "Return to this product in the listing feed and use its removal action. If this code repeats, copy the request reference for an administrator to inspect the saved job.",
      false, "edit_listing", "Open listing feed", "/channels/ebay");
  if (code === "EBAY_EXCLUSION_PERSISTENCE_FAILED")
    return issue("The removal request's saved result is not confirmed", "Echelon could not confirm the saved inclusion change and its removal job.",
      "Check the saved request or retry that same request in the inclusion dialog. Echelon reuses the original reference; do not create a replacement command while its outcome is unknown.",
      true, "retry_sync", "Retry same request");

  if (code === "EBAY_PUBLICATION_RESPONSE_UNCERTAIN")
    return issue("Publication was interrupted", "Echelon cannot confirm whether an earlier publish request reached eBay.",
      "Review the saved publication. An inventory administrator can authorize it to check the existing offers and resume using current inventory and catalog pictures.",
      false, "check_recovery", "Review interrupted publication");
  if (automaticResponseRecovery || code === "PUBLICATION_AUTOMATIC_RECOVERY_FAILED")
    return issue("Recovering an interrupted update", automaticResponseRecovery
      ? "Echelon did not receive a final response to an earlier eBay update. That request's outcome remains unknown."
      : "Echelon could not finish preparing a fresh update after an earlier eBay response was lost.",
      "The saved update will retry automatically using current listing content and inventory. View its status for the recorded step and retry eligibility.",
      false, "check_status", "View update status");
  if (isUnresolvedListingRequest(code)) {
    const recovering = input.state === "recovering";
    const withdrawal = input.operation === "withdraw";
    const result = issue(recovering ? "Checking an earlier eBay request" : "An earlier eBay request needs checking",
      "Echelon has not yet confirmed the outcome of an earlier request for this listing.",
      input.state === "recovering"
        ? "The saved update will check the earlier request again automatically. View its status for the recorded result and next check."
        : input.operation === "withdraw"
          ? "Review the saved removal and the earlier request's response. Continue through removal recovery; this product must not be republished while removal is unfinished."
        : "Use Sync to check the saved response and continue this listing's existing request. If eBay's response is still unknown, the recovery details show what could be verified before another write.",
      !recovering && !withdrawal, recovering ? "check_status" : withdrawal ? "check_recovery" : "retry_sync",
      recovering ? "View update status" : withdrawal ? "Review blocked update" : "Sync");
    return recovering || withdrawal ? result : ebayListingIssueSchema.parse({ ...result,
      diagnosticAction: { kind: "check_recovery", label: "Saved request details" } });
  }
  if (["EBAY_QUANTITY_RESPONSE_UNCERTAIN", "QUANTITY_PROVIDER_REQUEST_TIMEOUT"].includes(code))
    return issue("An earlier quantity update needs review", "Echelon cannot confirm the outcome of an earlier eBay quantity request.",
      "Review the saved request and its response. An inventory administrator can authorize a fresh update using current inventory when the old outcome remains unknown.",
      false, "check_recovery", "Review blocked update");
  if (code === "EBAY_PUBLICATION_READBACK_PENDING")
    return issue("Checking published listing and pictures", "eBay accepted the publication request. Echelon is still checking the complete listing and its pictures.",
      "The saved publication will check again automatically without publishing a second time. View its status or refresh the check; completion appears after the listing and pictures are verified.",
      false, "check_status", "View publishing status");
  if (code === "EBAY_PUBLICATION_PRIOR_WORK_REQUIRED")
    return issue("An earlier publication must finish first", "An earlier saved publication may already have reached eBay.",
      "Open the earlier publishing request to check its result or follow its recovery step before starting another publication.",
      false, "check_status", "View earlier publication");
  if (code === "EBAY_PUBLICATION_RETRY_NOT_ALLOWED")
    return issue("Check the saved publication before retrying", "This publication cannot be authorized for another attempt in its current state.",
      "View its current status. An accepted publication is checked automatically; do not start another publish while its result is being verified.",
      false, "check_status", "View publishing status");
  if (code === "EBAY_PUBLICATION_RETRY_REVIEW_CHANGED")
    return issue("Review the updated publication", "The saved publication changed after the recovery review.",
      "Refresh the saved publication details and review the current outcome before confirming its recovery again.",
      false, "check_recovery", "Review current publication");
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
    "EBAY_OAUTH_SCOPE_MISSING", "EBAY_PROVIDER_ACCOUNT_IDENTITY_CONFLICT", "EBAY_PROVIDER_ACCOUNT_IDENTITY_NOT_PERSISTED", "EBAY_SYNC_ACCOUNT_CHANGED", "EBAY_SYNC_ACCOUNT_UNVERIFIED"].includes(code))
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
  if (["EBAY_REGISTRATION_UNPUBLISHED_GROUP_AMBIGUOUS", "EBAY_REGISTRATION_UNPUBLISHED_GROUP_CHANGED",
    "EBAY_REGISTRATION_UNPUBLISHED_GROUP_MEMBERSHIP_MISMATCH", "EBAY_PUBLICATION_TARGET_UNVERIFIED"].includes(code))
    return issue("Review the offers before publishing", "eBay did not verify the exact offers and product variants expected by this publishing request.",
      "Open the publication review to compare the saved offers and every SKU with the current eBay group. Follow its recommended correction, then finish publishing only when that review verifies the intended offers.",
      false, "review_mapping", "Review publication");
  if (["EBAY_SYNC_IDENTITY_CHANGED", "EBAY_SYNC_OFFER_IDENTITY_CHANGED", "EBAY_SYNC_PROJECTION_IDENTITY_CHANGED", "EBAY_SYNC_PROVIDER_IDENTITY_CHANGED",
    "EBAY_SYNC_OFFER_MISSING", "EBAY_SYNC_SOURCE_INVALID", "EBAY_SYNC_SCOPE_UNAVAILABLE", "PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN",
    "EBAY_SYNC_PROVIDER_MEMBERSHIP_UNPROVEN", "EBAY_SYNC_MAPPING_INVALID",
    "EBAY_SYNC_LISTING_IDENTITY_REQUIRED", "EBAY_SYNC_MEMBERSHIP_CHANGED", "EBAY_SYNC_GROUP_IDENTITY_REQUIRED", "EBAY_SYNC_PROVIDER_IDENTITY_INVALID",
    "EBAY_SYNC_RETAINED_IDENTITY_CHANGED"].includes(code))
    return issue("Review the existing listing mapping", "The saved product-to-eBay mapping could not be verified.",
      "Open the mapping review to compare the saved mapping with eBay, see the exact issue and review the recommended correction. Apply the verified fix there when available.",
      false, "review_mapping", "Review listing mapping");
  if (code === "EBAY_SYNC_DRAFT_SCOPE_INVALID")
    return issue("The listing update was prepared incorrectly", "Echelon rejected its prepared update because it did not match the saved listing's identity or variants. This does not establish a problem with your eBay mapping.",
      "Use Sync existing listing. Echelon automatically verifies the existing listing and prepares a fresh update with current pictures. If this error returns, give its reference to an administrator to inspect the prepared update.",
      true, "retry_sync", "Sync existing listing");
  if (code === "CANONICAL_PUBLICATION_MAPPING_MISSING")
    return issue("Inventory setup stopped this update", "Echelon could not prepare the inventory connection needed for this listing. Its pictures have not been confirmed updated.",
      "Retry Sync to recheck this listing and prepare missing inventory connections for its verified variants.",
      true, "retry_sync", "Retry Sync");
  if (["EBAY_QUANTITY_DAILY_LIMIT", "PUBLICATION_PROVIDER_COOLDOWN", "EBAY_PROVIDER_RATE_LIMITED"].includes(code))
    return issue("eBay is temporarily limiting updates", "eBay has asked Echelon to wait before another update.",
      reference && input.state !== "needs_attention"
        ? "Your saved update will retry after the displayed retry time. Repeated Sync clicks do not shorten eBay's waiting period."
        : "Wait for eBay's stated retry period, then retry this product. Repeated clicks do not shorten eBay's waiting period.",
      false, "check_status", "View update status");
  if (["PUBLICATION_GLOBAL_STOP_ACTIVE", "PUBLICATION_GLOBAL_DISABLED", "QUANTITY_PUBLICATION_SUPPRESSED", "PUBLICATION_LEGACY_CHANNEL_NOT_LIVE"].includes(code))
    return issue("Inventory publishing is paused", "The inventory publication owner currently prevents this listing update.",
      "An inventory administrator must review the channel's publication status. Once publishing is allowed, saved sync work continues automatically; retry Publish if this product has no saved sync job.",
      false, "edit_listing", "Open inventory settings", "/channels/inventory");
  if (code === "INVENTORY_PUBLICATION_TARGET_BUSY") {
    const automatic = !!reference && ["queued", "running", "recovering", "awaiting_evidence"].includes(input.state ?? "");
    return issue(automatic ? "Waiting for an inventory update" : "An inventory update interrupted this sync",
      "Another inventory update was using this listing. Its pictures and listing details have not all been verified.",
      automatic
        ? "Your saved update will retry automatically, then check the listing and pictures on eBay. View its status for the next check."
        : "Use Retry this product to finish updating the existing listing and pictures. Echelon checks the saved requests and current inventory before continuing.",
      !automatic, automatic ? "check_status" : "retry_sync", automatic ? "View update status" : "Retry this product");
  }
  if (["EBAY_SYNC_READBACK_PENDING", "EBAY_PHOTO_READ_FAILED", "EBAY_SYNC_PERSISTENCE_FAILED", "PUBLICATION_RESPONSE_RECOVERY_FAILED",
    "PUBLICATION_SCOPE_BUSY", "PUBLICATION_ADMISSION_CAPACITY_BUSY", "QUANTITY_PUBLICATION_DRAIN_BUSY", "EBAY_SYNC_ADMISSION_UNSAVED",
    "EBAY_SYNC_ADMISSION_FAILED", "EBAY_REGISTRATION_READ_TIMEOUT", "EBAY_REGISTRATION_READ_FAILED", "EBAY_AUTH_UNAVAILABLE", "EBAY_AUTH_REFRESH_SUPERSEDED",
    "EBAY_LISTING_SYNC_FAILED", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(code))
    return issue(input.state === "recovering" ? "Echelon is recovering this update" : "The update could not finish",
      "A temporary provider or local persistence failure interrupted the update.",
      input.state === "recovering" ? "The saved update will retry automatically. Open its status to see the latest result."
        : "Retry this product. Echelon checks the saved request and existing listing before sending another update.",
      input.state !== "recovering", input.state === "recovering" ? "check_status" : "retry_sync",
      input.state === "recovering" ? "View update status" : "Retry this product");
  if (["EBAY_SYNC_PRODUCT_NOT_ELIGIBLE", "EBAY_SYNC_CONTENT_SCOPE_EMPTY"].includes(code))
    return issue("Review which variants are included", "This product has no eligible existing listing update.",
      "Check the product and variant inclusion switches in the eBay listing feed. Enable the intended sellable variants; use Publish for a product without an existing eBay listing.",
      false, "edit_listing", "Open listing feed", "/channels/ebay");
  if (code === "EBAY_SHIPPING_POLICY_REJECTED")
    return issue("eBay rejected the shipping policy", "eBay rejected this listing's selected shipping policy. This update did not complete.",
      "Open business policies and check Shipping. A product type, product or variant Fulfillment override may supply a different policy. Correct the rejected policy, save, then Sync this product to continue with its current inventory and pictures.",
      false, "edit_listing", "Open business policies", "/channels/ebay#business-policies");
  if (["EBAY_QUANTITY_REJECTED", "EBAY_LISTING_VALIDATION_FAILED", "EBAY_LISTING_PREFLIGHT_FAILED"].includes(code))
    return issue("Listing details need attention", "The listing does not meet a required eBay or inventory condition.",
      "Review the specific requirement above. Open this product's listing settings to correct its category, item specifics, policies or availability, then retry.",
      false, "edit_listing", "Open listing settings", `${productPath}?tab=channels`);
  return issue("The automated update stopped", "Echelon could not identify a recovery step for this error. The update is not confirmed complete.",
    reference
      ? "Open the saved update details to see its last recorded step and failure code. Checking status does not send another update."
      : "Open the listing feed to check the latest saved request and its failure code. Checking the feed does not send another update.",
    false, reference ? "check_status" : "edit_listing", reference ? "View saved update details" : "Open listing feed",
    reference ? undefined : "/channels/ebay");
}

/** Public descriptions of the planner's checks; unknown diagnostics stay private. */
const quantityReadBlockerMessages: Readonly<Record<string, string>> = {
  CHANNEL_SOURCE_BINDING_MISSING: "The eBay stock destination has no active source warehouse configured.",
  CHANNEL_SOURCE_NODE_NOT_ACTIVE: "The eBay stock destination uses a fulfillment location that is inactive.",
  CHANNEL_SOURCE_WAREHOUSE_DUPLICATE: "The same warehouse is connected more than once to this eBay stock destination.",
  CHANNEL_SOURCE_WAREHOUSE_NOT_ACTIVE: "A warehouse supplying this eBay stock destination is missing or inactive.",
  CHANNEL_SOURCE_OVERRIDE_UNAVAILABLE: "This variant's stock source override refers to a missing, duplicate or inactive warehouse.",
  CHANNEL_EXPOSURE_POLICY_INCOMPLETE: "This product's eBay stock policy is missing settings required to calculate its listing quantity.",
  PUBLICATION_MEMBER_VARIANT_UNAVAILABLE: "A selected variant is missing or no longer eligible for inventory publication.",
  PUBLICATION_TARGET_HAS_NO_MANAGED_SKUS: "This product has no active physical variant managed by inventory for this stock destination.",
};

export function safeListingDiagnostic(value: string | null | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi, "[URL]")
    .replace(/(access_token|refresh_token|client_secret|authorization)[\s:=]+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000);
}
