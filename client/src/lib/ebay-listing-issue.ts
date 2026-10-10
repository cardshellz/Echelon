import { ebayListingIssueSchema, type EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";

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
