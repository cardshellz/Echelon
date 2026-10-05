import type {
  ListingUpdateChanges,
  ListingUpdateObservation,
} from "@shared/types/channel-listing-update";
import type { StoredListingUpdate } from "../../application/listing-update-ports";
import { listingHash } from "../../domain/listing-publication";
import { fixedNow, testAccount, testId } from "./listing-publication.fixture";

export const updateSource: ListingUpdateObservation = {
  sku: "SKU-10",
  externalProductId: "WPID-10",
  identifier: { type: "GTIN", value: "00036000291452" },
  title: "Card sleeves, 100 count",
  productType: "Trading Card Sleeves & Holders",
  priceCents: 2499,
  lifecycleStatus: "ACTIVE",
  publishedStatus: "SYSTEM_PROBLEM",
};

export function listingUpdateRecord(
  id = 1,
  changes: ListingUpdateChanges = { priceCents: 2799 },
): StoredListingUpdate {
  const intent = {
    account: structuredClone(testAccount),
    source: structuredClone(updateSource),
    command: {
      sku: updateSource.sku,
      sourceHash: listingHash({ account: testAccount, current: updateSource }),
      productType: updateSource.productType,
      changes,
    },
    prepared: {
      payload: { changedPrice: changes.priceCents },
      schemaHash: "a".repeat(64),
      issues: [],
    },
  };
  return {
    view: {
      id: testId(id),
      sku: updateSource.sku,
      title: updateSource.title,
      state: "reviewed",
      reviewHash: listingHash(intent),
      productType: updateSource.productType,
      changes,
      issues: [],
      submissionId: null,
      message: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      expiresAt: new Date(fixedNow.getTime() + 900_000).toISOString(),
    },
    intent,
    version: 1,
    leaseToken: null,
    commandKey: null,
  };
}
