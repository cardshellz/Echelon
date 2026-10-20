import type { CatalogPublicationMediaPlan } from "@shared/types/catalog-publication-media";
import type { ListingAccount } from "@shared/types/channel-listing-publication";
import type { ListingPublicationInput, PreparedListingItem } from "../../../marketplace-listings/application/listing-publication-provider.port";
import { prepareChannelIntent, assertPreparedChannelIntent, preparedChannelIntentHash,
  type ChannelIntentAccount } from "../../../marketplace-listings/prepared-channel-intent";
import { jsonObject } from "./walmart-listing-schema";

export const WALMART_PREPARED_INTENT_CAPABILITY = "walmart-item-feed-v1";
export function walmartIntentAccount(account: ListingAccount): ChannelIntentAccount {
  return { owner: { kind: "channel", channelId: account.channelId }, connectionId: account.connectionId,
    provider: "walmart", accountId: account.accountId, environment: account.environment, marketplaceId: account.market,
    inventoryScope: { kind: "location", locationId: account.scopeId }, configurationRevision: String(account.revision) };
}
/** Quantity is admitted immediately before sending and does not invalidate content reviews. */
export function walmartPreparedContentHash(item: Pick<PreparedListingItem, "feedType" | "schemaVersion" | "schemaHash" | "payload">): string {
  const payload = structuredClone(item.payload);
  const key = item.feedType === "MP_ITEM" ? "Orderable" : "Item";
  const { inventory: _quantity, ...content } = jsonObject(payload[key]);
  payload[key] = content;
  return preparedChannelIntentHash({ feedType: item.feedType, schemaVersion: item.schemaVersion, schemaHash: item.schemaHash, payload });
}
export function prepareWalmartChannelIntent(account: ListingAccount, input: ListingPublicationInput, item: PreparedListingItem, media: { mediaPlan: CatalogPublicationMediaPlan | null; mediaAction: "replace" | "preserve" }) {
  return prepareChannelIntent({ schemaVersion: 1, account: walmartIntentAccount(account), operation: "publication",
    capability: { revision: WALMART_PREPARED_INTENT_CAPABILITY, protocol: "feed", aggregate: "item", quantityAdmission: "inventory_owner_required", mediaVerification: "unavailable" },
    members: [{ productId: input.catalog.productId, variantId: item.variantId, sku: item.sku }],
    contentHash: walmartPreparedContentHash(item), ...media,
    prices: [{ variantId: item.variantId, cents: input.priceCents, currency: "USD",
      provenance: input.draft.priceOverrideCents === null ? input.catalog.priceProvenance ?? null : { kind: "reviewed_draft", variantId: item.variantId },
      resolutionRevision: preparedChannelIntentHash({ source: input.catalog.priceSource, rule: input.catalog.appliedRule,
        scope: input.catalog.appliedRuleScope, priceOverrideCents: input.draft.priceOverrideCents, basePriceCents: input.catalog.basePriceCents }) }],
    settings: { owner: "marketplace-listings.reviewed_draft", sourceRevision: preparedChannelIntentHash(input.draft) },
  });
}
export function assertWalmartPreparedIntent(account: ListingAccount, item: PreparedListingItem): void {
  if (!item.preparedIntent) return; // Immutable pre-contract reviews retain their original execution contract.
  const member = item.preparedIntent.input.members[0];
  assertPreparedChannelIntent(item.preparedIntent, { account: walmartIntentAccount(account),
    capabilityRevision: WALMART_PREPARED_INTENT_CAPABILITY, contentHash: walmartPreparedContentHash(item),
    members: [{ productId: member.productId, variantId: item.variantId, sku: item.sku }] });
}
