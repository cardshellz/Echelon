import type { CatalogPublicationMediaPlan } from "@shared/types/catalog-publication-media";
import { parseDollarPriceToCents, type ChannelPriceResolution } from "./channel-pricing-resolver";
import type { EbayListingConnectorDraft } from "./listing-connectors/ebay-listing.connector";
import type { EbayListingSyncIdentity } from "./ebay-listing-sync.domain";
import { EbayListingSyncError } from "./ebay-listing-sync.domain";
import { EBAY_LISTING_MAX_PHOTOS } from "./ebay-listing-photos.domain";
import { ebayPreparedContentHash } from "./ebay-listing-sync-content";
import { prepareChannelIntent, assertPreparedChannelIntent, preparedChannelIntentHash,
  type ChannelIntentAccount, type ChannelPreparedIntent } from "../marketplace-listings/prepared-channel-intent";

export const EBAY_PREPARED_INTENT_CAPABILITY = "ebay-inventory-resource-steps-v1";
type Draft = Pick<EbayListingConnectorDraft, "productId" | "marketplaceId" | "inventoryItems" | "offers" | "itemGroup">;

export function ebayIntentAccount(input: { channelId: number; connectionId: number; accountId: string;
  environment: "production" | "sandbox"; marketplaceId: string; merchantLocationKey: string }): ChannelIntentAccount {
  return { owner: { kind: "channel", channelId: input.channelId }, connectionId: input.connectionId,
    provider: "ebay", accountId: input.accountId, environment: input.environment, marketplaceId: input.marketplaceId,
    inventoryScope: { kind: "account" }, configurationRevision: preparedChannelIntentHash({
      marketplaceId: input.marketplaceId, merchantLocationKey: input.merchantLocationKey,
    }) };
}

export function prepareEbayChannelIntent(input: { account: ChannelIntentAccount; draft: Draft;
  operation: "publication" | "maintenance"; mediaPlan?: CatalogPublicationMediaPlan;
  prices: ReadonlyMap<number, ChannelPriceResolution>; settings: unknown }): ChannelPreparedIntent {
  const draft = input.draft;
  if (input.account.provider !== "ebay" || input.account.marketplaceId !== draft.marketplaceId
    || input.account.inventoryScope.kind !== "account")
    throw new EbayListingSyncError("EBAY_SYNC_DRAFT_SCOPE_INVALID", "The prepared eBay account does not match the listing scope.");
  if (input.mediaPlan) {
    for (const item of draft.inventoryItems) {
      const member = draft.offers.find(offer => offer.sku === item.sku);
      const gallery = input.mediaPlan.variants.find(variant => variant.variantId === member?.variantId)?.gallery;
      if (!gallery || preparedChannelIntentHash(gallery.selected.map(photo => photo.url)) !== preparedChannelIntentHash(item.payload.product.imageUrls ?? []))
        throw new EbayListingSyncError("EBAY_SYNC_DRAFT_SCOPE_INVALID", "The prepared eBay images differ from the selected Catalog media plan.");
    }
    if (draft.itemGroup && preparedChannelIntentHash(input.mediaPlan.group.selected.map(photo => photo.url)) !== preparedChannelIntentHash(draft.itemGroup.payload.imageUrls))
      throw new EbayListingSyncError("EBAY_SYNC_DRAFT_SCOPE_INVALID", "The prepared eBay group gallery differs from the selected Catalog media plan.");
  }
  return prepareChannelIntent({ schemaVersion: 1, account: input.account, operation: input.operation,
    capability: { revision: EBAY_PREPARED_INTENT_CAPABILITY, protocol: "resource_steps",
      aggregate: draft.itemGroup ? "variation_group" : "item", quantityAdmission: "inventory_owner_required", mediaVerification: "resource_content" },
    members: draft.offers.map(offer => ({ productId: draft.productId, variantId: offer.variantId, sku: offer.sku })),
    contentHash: ebayPreparedContentHash(draft), mediaAction: "replace", mediaPlan: input.mediaPlan ?? null,
    prices: draft.offers.map(offer => {
      const resolution = input.prices.get(offer.variantId);
      if (!resolution || resolution.priceCents === null || parseDollarPriceToCents(offer.payload.pricingSummary.price.value) !== resolution.priceCents)
        throw new EbayListingSyncError("EBAY_LISTING_PREFLIGHT_FAILED", "The prepared listing is missing its resolved price source.");
      return { variantId: offer.variantId, cents: resolution.priceCents, currency: offer.payload.pricingSummary.price.currency,
        provenance: resolution.provenance, resolutionRevision: preparedChannelIntentHash(resolution) };
    }),
    settings: { owner: "channels.ebay_listing_settings", sourceRevision: preparedChannelIntentHash({
      resolved: input.settings, photoLimit: EBAY_LISTING_MAX_PHOTOS,
    }) },
  });
}

/** Legacy drafts have no envelope. New prepared drafts must retain their exact
 * account and source contract at both sending and readback boundaries. */
export function assertEbayPreparedIntent(draft: Draft & { preparedIntent?: ChannelPreparedIntent }, identity?: EbayListingSyncIdentity): void {
  if (!draft.preparedIntent) return;
  const account = draft.preparedIntent.input.account;
  try {
    if (account.provider !== "ebay" || account.marketplaceId !== draft.marketplaceId
      || account.inventoryScope.kind !== "account" || account.owner.kind !== "channel"
      || (identity && (account.owner.channelId !== identity.channelId || account.connectionId !== identity.connectionId
        || account.accountId !== identity.accountId || account.marketplaceId !== identity.marketplaceId))) throw new Error("Scope changed");
    assertPreparedChannelIntent(draft.preparedIntent, { account, capabilityRevision: EBAY_PREPARED_INTENT_CAPABILITY,
      contentHash: ebayPreparedContentHash(draft),
      members: draft.offers.map(offer => ({ productId: draft.productId, variantId: offer.variantId, sku: offer.sku })) });
  } catch (cause) {
    throw new EbayListingSyncError("EBAY_SYNC_DRAFT_SCOPE_INVALID", "The prepared eBay listing account, content or source selection changed. Prepare it again before sending.", { cause });
  }
}
