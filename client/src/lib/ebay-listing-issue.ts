import { ebayListingIssueSchema, type EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { ChannelListingInventoryScopeError } from "@shared/types/channel-listing-inventory";

/** Feed reads expose only the server's validated public issue, never raw database
 * or proxy errors. Reloading this read must not become a listing command retry. */
export function listingFeedIssueFromError(error: unknown): EbayListingIssue {
  if (error instanceof Error) {
    try {
      const response: unknown = JSON.parse(error.message.replace(/^\d{3}:\s*/, ""));
      if (typeof response === "object" && response !== null && "issue" in response) {
        const issue = ebayListingIssueSchema.safeParse(response.issue);
        if (issue.success) return issue.data;
      }
    } catch {
      // A malformed or older response has no validated public diagnostic.
    }
  }
  return resolveEbayListingIssue({ code: "EBAY_LISTING_FEED_UNAVAILABLE" });
}

/** An inventory read retains its server reference but never renders a raw proxy error. */
export function listingInventoryIssueFromError(error: unknown, productId: number): EbayListingIssue {
  if (error instanceof ChannelListingInventoryScopeError)
    return resolveEbayListingIssue({ code: error.code, productId });
  const issue = listingFeedIssueFromError(error);
  return issue.code === "EBAY_LISTING_FEED_UNAVAILABLE"
    ? resolveEbayListingIssue({ code: "EBAY_FEED_QUANTITY_UNAVAILABLE", productId }) : issue;
}

/** apiRequest retains the JSON response in Error.message; validate before rendering it. */
export function listingIssueFromError(error: unknown, productId?: number): EbayListingIssue {
  const message = error instanceof Error ? error.message : "The listing request could not be completed.";
  const body = message.replace(/^\d{3}:\s*/, "");
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const response = parsed as Record<string, unknown>;
      const issue = ebayListingIssueSchema.safeParse(response.issue);
      if (issue.success) return issue.data;
      return resolveEbayListingIssue({
        code: typeof response.code === "string" ? response.code : undefined,
        message: typeof response.error === "string" ? response.error : undefined,
        productId,
      });
    }
  } catch {
    // Older responses and network errors are plain text rather than structured issues.
  }
  return resolveEbayListingIssue({ message: /<!DOCTYPE|<html/i.test(message)
    ? "The server returned an unexpected response before completion could be confirmed." : message, productId });
}

/** A lost or unreadable command response is not proof that admission failed.
 * Keep explicit validation/permission responses and recognized server issues. */
export function listingSyncIssueFromError(error: unknown, productId: number): EbayListingIssue {
  const issue = listingIssueFromError(error, productId);
  const responseMessage = error instanceof Error ? error.message : "";
  const explicitRejection = /^(?:400|401|403|404|409|422):\s/.test(responseMessage);
  return issue.code === "EBAY_LISTING_OPERATION_FAILED" && !explicitRejection
    ? resolveEbayListingIssue({ code: "EBAY_SYNC_COMMAND_UNCONFIRMED", productId })
    : issue;
}
