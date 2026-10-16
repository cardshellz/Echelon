import type { QuantityPublicationScope } from "../inventory-planning/domain/quantity-publication-admission";
import type { EbayAutomaticPublicationRecoveryService } from "../inventory-planning/quantity-publication";
import { EbayListingSyncError, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";

export interface EbayListingRequestRecovery {
  reconcile(scopes: readonly QuantityPublicationScope[]): Promise<{ busy: boolean; resolved: string[]; unresolved: string[] }>;
}

/** Exact provider scope only. Catalog membership and provider identity are
 * validated by the calling listing operation before it requests recovery. */
export function ebayListingPublicationScopes(identity: EbayListingSyncIdentity): QuantityPublicationScope[] {
  const members = [
    ...(identity.groupKey === null ? [] : [{ sku: `group:${identity.groupKey}`, variantId: null }]),
    ...identity.variants.map(member => ({ sku: member.sku, variantId: member.variantId })),
  ];
  return members.map(member => ({ destinationKind: "channel_connection", connectionId: identity.connectionId,
    providerKey: "ebay", providerScopeType: "account", externalScopeId: identity.accountId,
    externalInventoryItemId: member.sku, productId: identity.productId, productVariantId: member.variantId }));
}

/** Inventory remains the single owner of response classification and replacement
 * recovery. Unknown lifecycle requests cannot be cleared by this content worker. */
export async function recoverPriorEbayListingRequests(input: {
  identity: EbayListingSyncIdentity;
  recovery: EbayListingRequestRecovery;
  automaticRecovery?: Pick<EbayAutomaticPublicationRecoveryService, "recover">;
  context?: { jobId?: string; claimedRevision: string; operation: "sync" | "publish" | "withdraw" };
}): Promise<{ hasRecurringRecovery: boolean }> {
  const scopes = ebayListingPublicationScopes(input.identity);
  let recovered = await input.recovery.reconcile(scopes);
  if (recovered.busy) throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY",
    "Another stock update is still running. This saved listing update will continue automatically.");
  let hasRecurringRecovery = false;
  if (input.automaticRecovery && input.context?.jobId && input.context.operation !== "withdraw") {
    const resumed = await input.automaticRecovery.recover({ scopes,
      syncJobId: input.context.jobId, syncRevision: input.context.claimedRevision });
    if (resumed.busy) throw new EbayListingSyncError("PUBLICATION_SCOPE_BUSY",
      "Another stock update is still running. This saved listing update will continue automatically.");
    hasRecurringRecovery = resumed.watchId !== null;
    recovered = { busy: false, resolved: [...recovered.resolved, ...resumed.superseded], unresolved: resumed.unresolved };
  }
  if (recovered.unresolved.length) throw new EbayListingSyncError("EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
    `An earlier eBay request has no confirmed final response (attempts ${recovered.unresolved.join(", ")}). Echelon must determine that request's outcome before another listing write.`);
  return { hasRecurringRecovery };
}
