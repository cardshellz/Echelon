import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";
import type { MarketplacePushGuard, MarketplacePushPassthrough } from "../domain/marketplace-sync-decision";
import type { DropshipMarketplaceListingIntent } from "./dropship-marketplace-listing-provider";

/** What a push writes to eBay for its listing, as the provider resolved it (eBay sync-back SB3). */
export interface DropshipMarketplaceListingPushSent {
  priceCents: number;
  currency: string;
  sku: string;
  fulfillmentPolicyId: string;
  returnPolicyId: string;
  paymentPolicyId: string;
  /**
   * Fingerprints (sha256Hex) of the title and description this push writes:
   * Card Shellz's text as sent, or, for a field passed through, Card Shellz's
   * own last fingerprint carried forward (review OR-1). Never the text.
   */
  titleHash: string;
  descriptionHash: string;
}

/**
 * eBay sync-back's push-time rule (plan v4 §5) for one push of a listing
 * already on eBay: what the connector re-checks just before its first write
 * (`guard`), what it carries unchanged (`passthrough`), the shipping policy
 * live on the listing now (the live-policy rule), and the call that records
 * the attempt just before that first write.
 */
export interface DropshipMarketplaceListingPushSync {
  guard: MarketplacePushGuard;
  passthrough: MarketplacePushPassthrough;
  liveFulfillmentPolicyId: string | null;
  beforeFirstWrite(sent: DropshipMarketplaceListingPushSent): Promise<void>;
}

export interface DropshipMarketplaceListingPushRequest {
  vendorId: number;
  storeConnectionId: number;
  jobId: number;
  jobItemId: number;
  listingId: number;
  productVariantId: number;
  platform: DropshipSourcePlatform;
  listingIntent: DropshipMarketplaceListingIntent;
  existingExternalListingId: string | null;
  existingExternalOfferId: string | null;
  idempotencyKey: string;
  /**
   * This run was queued by the push sweep's automatic stock link re-queue (plan F2
   * 2.10, owner Q4), not by the vendor or an admin. Such a run never adopts a
   * published eBay listing the vendor listing did not record (review TW-1); see
   * domain/listing-push-automatic-requeue isAutomaticStockLinkRequeueRun.
   */
  automaticRetry?: boolean;
  /** Present for an eBay listing Card Shellz pushed before (it has a saved offer id); absent for a first push. */
  marketplaceSync?: DropshipMarketplaceListingPushSync;
}

export interface DropshipMarketplaceListingPushResult {
  status: "created" | "updated" | "skipped";
  externalListingId: string;
  externalOfferId: string | null;
  rawResult: Record<string, unknown>;
  /** What the push wrote (eBay only): the completed push records it as Card Shellz's baseline (SB3). */
  sent?: DropshipMarketplaceListingPushSent;
}

export interface DropshipMarketplaceListingPushProvider {
  pushListing(input: DropshipMarketplaceListingPushRequest): Promise<DropshipMarketplaceListingPushResult>;
}
