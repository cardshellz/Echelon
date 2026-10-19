import type { ListingMemberIdentity } from "@shared/types/listing-member-lifecycle";
import type { ListingMemberLifecycleAdapter } from "../../../marketplace-listings/application/listing-member-lifecycle.port";
import { ListingMemberLifecycleError } from "../../../marketplace-listings/domain/listing-member-lifecycle";
import type { WalmartListingLifecycleProvider } from "./walmart-listing-lifecycle.provider";
import { WalmartApiError } from "./walmart-client";

// These guards execute before WalmartListingApi.retire dispatches DELETE.
// Nonretryable response parsing errors are deliberately not in this set.
const PRE_DISPATCH_CODES = new Set([
  "WALMART_ACCOUNT_CHANGED", "WALMART_CONNECTION_REQUIRED", "WALMART_LIVE_DISABLED",
  "WALMART_SANDBOX_IMPORT_BLOCKED", "WALMART_CREDENTIAL_SCOPE_MISMATCH", "WALMART_VAULT_UNCONFIGURED",
]);

export class WalmartListingMemberAdapter implements ListingMemberLifecycleAdapter {
  constructor(private readonly provider: Pick<WalmartListingLifecycleProvider, "account" | "observe" | "retire">) {}
  async account(identity: ListingMemberIdentity) {
    if (!identity.channelId || identity.destinationKind !== "channel_connection" || !identity.externalSku)
      throw new ListingMemberLifecycleError("LISTING_MEMBER_IDENTITY_INCOMPLETE", "The Walmart channel and saved seller SKU are required.");
    const account = await this.provider.account(identity.channelId);
    if (account.connectionId !== identity.connectionId || account.accountId !== identity.accountId || account.environment !== identity.environment || account.market !== identity.market)
      throw new ListingMemberLifecycleError("LISTING_MEMBER_ACCOUNT_CHANGED", "The Walmart seller account changed. Reconcile the saved listing before removal.");
    return account;
  }
  async observe(identity: ListingMemberIdentity) {
    const item = await this.provider.observe(await this.account(identity), identity.externalSku!);
    if (item.sku !== identity.externalSku)
      throw new ListingMemberLifecycleError("LISTING_MEMBER_IDENTITY_CHANGED", "Walmart returned a different seller SKU.");
    return { identity, retired: item.retired };
  }
  async retire(identity: ListingMemberIdentity, operationId: string) {
    const account = await this.account(identity);
    try { await this.provider.retire(account, identity.externalSku!, operationId); }
    catch (error) {
      const rejected = error instanceof WalmartApiError && (PRE_DISPATCH_CODES.has(error.code) ||
        (error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 408));
      throw new ListingMemberLifecycleError(rejected ? "LISTING_MEMBER_REMOVAL_REJECTED" : "LISTING_MEMBER_REMOVAL_UNCERTAIN",
        rejected ? "Walmart rejected this variant removal. Check the connection and listing restrictions."
          : "The Walmart removal response was not confirmed. Echelon will verify this exact seller SKU.",
        rejected ? "not_submitted" : "unknown");
    }
  }
}
