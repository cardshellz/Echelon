import { z } from "zod";
import type { ListingMemberIdentity } from "@shared/types/listing-member-lifecycle";
import type { ListingMemberLifecycleAdapter } from "../../../application/listing-member-lifecycle.port";
import { ListingMemberLifecycleError } from "../../../domain/listing-member-lifecycle";
import { EbayApiRequestError } from "../../../../channels/adapters/ebay/ebay-api-error";

export interface EbayListingMemberClient {
  getOffer(offerId: string): Promise<unknown | null>;
  clearOffer(offerId: string, sku: string): Promise<void>;
  deleteOffer(offerId: string): Promise<void>;
}
const offerSchema = z.object({ offerId: z.string().min(1), sku: z.string().min(1), marketplaceId: z.string().min(1),
  status: z.enum(["PUBLISHED", "UNPUBLISHED"]), listing: z.object({ listingId: z.string().min(1).optional() }).passthrough().optional() }).passthrough();

/** One implementation for direct and Dropship eBay accounts. deleteOffer removes
 * only this variation; withdrawing the inventory group would remove siblings.
 * https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/deleteOffer */
export class EbayListingMemberAdapter implements ListingMemberLifecycleAdapter {
  constructor(private readonly client: (identity: ListingMemberIdentity) => Promise<EbayListingMemberClient>) {}
  async observe(identity: ListingMemberIdentity) {
    if (!identity.externalVariantId || !identity.externalSku)
      throw new ListingMemberLifecycleError("LISTING_MEMBER_IDENTITY_INCOMPLETE", "The saved eBay offer ID and SKU are required. Repair this archived variant's listing link.");
    const value = await (await this.client(identity)).getOffer(identity.externalVariantId);
    if (value === null) return { identity, retired: true };
    const offer = offerSchema.parse(value);
    if (offer.offerId !== identity.externalVariantId || offer.sku !== identity.externalSku || offer.marketplaceId !== identity.market
      || (offer.status === "PUBLISHED" && identity.externalProductId !== null && offer.listing?.listingId !== identity.externalProductId))
      throw new ListingMemberLifecycleError("LISTING_MEMBER_IDENTITY_CHANGED", "The saved eBay offer now belongs to a different SKU, marketplace, or listing. Repair its link before removal.");
    return { identity, retired: offer.status === "UNPUBLISHED" };
  }
  async retire(identity: ListingMemberIdentity): Promise<void> {
    // Revalidate at the provider boundary. A missing/already unpublished offer is
    // a successful replay, never permission to delete another SKU or the group.
    if ((await this.observe(identity)).retired) return;
    const client = await this.client(identity);
    await client.clearOffer(identity.externalVariantId!, identity.externalSku!);
    try {
      await client.deleteOffer(identity.externalVariantId!);
    } catch (error) {
      const rejected = error instanceof EbayApiRequestError && error.statusCode !== undefined
        && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408;
      throw new ListingMemberLifecycleError(rejected ? "LISTING_MEMBER_REMOVAL_REJECTED" : "LISTING_MEMBER_REMOVAL_UNCERTAIN",
        rejected ? "eBay rejected removal of this exact variant. Check its listing permissions and restrictions."
          : "The eBay removal response was not confirmed. Echelon will check this exact offer before any further action.",
        rejected ? "not_submitted" : "unknown");
    }
  }
}
