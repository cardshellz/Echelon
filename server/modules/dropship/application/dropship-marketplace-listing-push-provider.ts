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
