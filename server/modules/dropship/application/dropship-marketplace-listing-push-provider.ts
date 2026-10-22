import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";
import type { DropshipMarketplaceListingIntent } from "./dropship-marketplace-listing-provider";

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
}

export interface DropshipMarketplaceListingPushResult {
  status: "created" | "updated" | "skipped";
  externalListingId: string;
  externalOfferId: string | null;
  rawResult: Record<string, unknown>;
}

export interface DropshipMarketplaceListingPushProvider {
  pushListing(input: DropshipMarketplaceListingPushRequest): Promise<DropshipMarketplaceListingPushResult>;
}
