import { resolveEbayListingIssue, type EbayListingIssueInput } from "@shared/ebay-listing-issue";
import type { EbayAuthService } from "./adapters/ebay/ebay-auth.service";
import { EbayListingSyncError } from "./ebay-listing-sync.domain";
import { ChannelFulfillmentProviderError } from "./channel-fulfillment-provider.error";

/** Credential presence and a verified live connection are different facts. */
export async function readEbayConnectionHealth(
  auth: Pick<EbayAuthService, "getAccessToken" | "getVerifiedProviderAccount" | "observeProviderAccount">,
  channelId: number,
) {
  try {
    const token = await auth.getAccessToken(channelId);
    const observed = await auth.observeProviderAccount(token);
    const saved = await auth.getVerifiedProviderAccount(channelId);
    if (!saved || saved.externalAccountId !== observed.externalAccountId)
      throw new EbayListingSyncError("EBAY_PROVIDER_ACCOUNT_IDENTITY_CONFLICT", "The connected eBay account does not match the saved account identity. Reconnect the intended account before publishing.");
    return { connectionHealth: "verified" as const, connectionIssue: null, ebayUsername: observed.externalAccountDisplayName };
  } catch (error) {
    const code = error instanceof ChannelFulfillmentProviderError
      ? error.failureClass === "permanent" ? "EBAY_AUTH_REQUIRED" : "EBAY_AUTH_UNAVAILABLE"
      : error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("EBAY_")
        ? error.code : "EBAY_AUTH_UNAVAILABLE";
    const input: EbayListingIssueInput = { code, message: error instanceof EbayListingSyncError ? error.message : undefined };
    console.error(JSON.stringify({ event: "ebay_connection_verification_failed", channelId, code }));
    const issue = resolveEbayListingIssue(input);
    const connectionIssue = issue.action.kind === "retry_sync"
      ? {
          ...issue,
          title: "Connection could not be verified",
          nextStep: "Refresh the connection check. If it still fails, give the displayed code to an administrator.",
          action: { ...issue.action, label: "Check connection again" },
        }
      : issue;
    return { connectionHealth: "needs_attention" as const, connectionIssue, ebayUsername: null };
  }
}
