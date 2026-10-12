import { pool } from "../../../db";
import { reviewEbayPublicationReadiness } from "../../inventory-planning/quantity-publication";
import { EbayListingSyncError } from "../ebay-listing-sync.domain";
import { EbayPublicationStockService } from "../ebay-publication-stock.service";
import { EBAY_CHANNEL_ID } from "./ebay-api-runtime";
import { prepareEbayPublicationCompletion, readEbayPublicationSource } from "./ebay-listing-push";
import { assertEbayPublicationCompatibility } from "./ebay-publication-compatibility";
import { PostgresEbayPublicationStockRepository } from "./ebay-publication-stock.repository";

const store = new PostgresEbayPublicationStockRepository(pool, EBAY_CHANNEL_ID, readEbayPublicationSource);
export const ebayPublicationStockService = new EbayPublicationStockService({
  channelId: EBAY_CHANNEL_ID,
  prepare: async productId => {
    const source = await readEbayPublicationSource(productId);
    const prepared = await prepareEbayPublicationCompletion(source, await store.readPreparationTarget(source));
    await assertEbayPublicationCompatibility(source, prepared.inspection, prepared.identity);
    const environment = prepared.inspection.providerAccount.accountNamespace;
    if (environment !== "production" && environment !== "sandbox")
      throw new EbayListingSyncError("EBAY_SYNC_ACCOUNT_UNVERIFIED", "The observed eBay account environment is invalid. Reconnect the intended seller account.");
    return { sourceIdentity: prepared.sourceIdentity, targetIdentity: prepared.identity, inspection: prepared.inspection,
      productName: prepared.variants[0]?.productName ?? `Product ${productId}`,
      inventorySource: { channelId: source.channelId, connectionId: source.connectionId, accountId: source.accountId,
        environment, productId, variants: prepared.identity.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku })) } };
  },
  reviewInventory: source => reviewEbayPublicationReadiness(pool, source),
  findApplied: input => store.findApplied(input),
  commit: input => store.commit(input),
  reject: input => store.reject(input),
  now: () => new Date(),
});
