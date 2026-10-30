import { z } from "zod";
import { ChannelProviderReadError } from "@shared/channel-provider-read";
import { EbayListingSyncError } from "../../ebay-listing-sync.domain";
import type { EbayObservedOffer } from "../../listing-connectors/ebay-listing.connector";

const offerSchema = z.object({
  sku: z.string().min(1).max(100).refine(value => value.trim().length > 0),
  offerId: z.string().trim().min(1).max(255),
  status: z.enum(["PUBLISHED", "UNPUBLISHED"]),
  availableQuantity: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  listingId: z.string().trim().min(1).max(255).optional(),
  listing: z.object({ listingId: z.string().trim().min(1).max(255) }).passthrough().optional(),
}).passthrough().superRefine((offer, context) => {
  if (offer.listingId && offer.listing?.listingId && offer.listingId !== offer.listing.listingId)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["listingId"], message: "Conflicting listing identifiers." });
});
const responseSchema = z.object({ offers: z.array(offerSchema).max(10_000) }).passthrough();

/** One observation contract for every eBay listing client. Malformed responses
 * are failed reads, never authoritative absence or permission to create. */
export function normalizeEbayObservedOffers(response: unknown): EbayObservedOffer[] {
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_RESPONSE_INVALID",
    "eBay returned an invalid offer response. Retry Sync to check the current listing identity.",
    { cause: new ChannelProviderReadError({ provider: "ebay", resource: "offers", method: "GET", kind: "invalid_response" }) });
  return parsed.data.offers.map(offer => {
    const listingId = offer.listingId ?? offer.listing?.listingId;
    return { ...offer, ...(listingId === undefined ? {} : { listingId }) } as unknown as EbayObservedOffer;
  });
}
