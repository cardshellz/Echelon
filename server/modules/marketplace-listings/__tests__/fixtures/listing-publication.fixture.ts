import {
  listingCatalogItemSchema,
  listingDraftItemSchema,
  type ListingAccount,
} from "@shared/types/channel-listing-publication";
import {
  listingHash,
  listingProgressSchema,
  listingSnapshotSchema,
  type ListingProgress,
  type ListingSnapshot,
  type StoredListingOperation,
} from "../../domain/listing-publication";

export const fixedNow = new Date("2026-09-27T15:00:00.000Z");
export const testId = (value: number) =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
export const testAccount: ListingAccount = {
  channelId: 104,
  connectionId: 5,
  provider: "walmart",
  market: "US",
  environment: "sandbox",
  accountId: "seller-123",
  scopeId: "node-123",
  revision: 1,
};

export function publicationSnapshot(
  ids = [10],
  account = testAccount,
  reviewId = testId(1),
  revision = 1,
): ListingSnapshot {
  const catalog = ids.map((variantId) =>
    listingCatalogItemSchema.parse({
      variantId,
      productId: 20,
      sku: `SKU-${variantId}`,
      name: "Card sleeves",
      variantName: "100 count",
      unitLabel: "100 count",
      productType: "Trading Card Sleeves & Holders",
      title: `Card sleeves ${variantId}`,
      description: "Card sleeves",
      brand: "Card Shellz",
      images: ["https://example.com/sleeves.jpg"],
      identifier: { type: "UPC", value: "036000291452" },
      priceCents: 1299,
      basePriceCents: 999,
      priceSource: "channel_rule",
      appliedRule: { type: "fixed", value: "3.00" },
      appliedRuleScope: "channel",
      eligible: true,
      alreadyLinked: false,
      sourceHash: listingHash({ variantId, priceCents: 1299 }),
    }),
  );
  const draft = {
    channelId: account.channelId,
    revision,
    updatedAt: fixedNow.toISOString(),
    items: catalog.map((item) =>
      listingDraftItemSchema.parse({
        variantId: item.variantId,
        productType: item.productType,
        identifier: item.identifier,
      }),
    ),
  };
  const prepared = catalog.map((item) => ({
    variantId: item.variantId,
    sku: item.sku,
    feedType: "MP_ITEM",
    schemaVersion: "fixture-version",
    schemaHash: "a".repeat(64),
    payload: {
      Orderable: {
        sku: item.sku,
        price: 12.99,
        inventory: [{ quantity: 0, fulfillmentCenterID: account.scopeId }],
      },
    },
    issues: [],
  }));
  const inventory = {
    ready: true,
    message: "Ready",
    targetId: "7",
    targetRevision: "2",
  };
  const review = {
    id: reviewId,
    draftRevision: revision,
    reviewHash: listingHash({ account, draft, catalog, prepared, inventory }),
    account,
    items: catalog.map((item) => ({
      variantId: item.variantId,
      productId: item.productId,
      sku: item.sku,
      title: item.title,
      unitLabel: item.unitLabel,
      method: "create",
      productType: item.productType,
      priceCents: item.priceCents,
      priceSource: item.priceSource,
      issues: [],
      schemaVersion: "fixture-version",
    })),
    issues: [],
    canSubmit: true,
    createdAt: fixedNow.toISOString(),
    expiresAt: new Date(fixedNow.getTime() + 900_000).toISOString(),
    inventory,
  };
  return listingSnapshotSchema.parse({
    account,
    draft,
    catalog,
    prepared,
    review,
  });
}

export function publicationProgress(
  snapshot: ListingSnapshot,
): ListingProgress {
  return listingProgressSchema.parse({
    error: null,
    batches: [
      {
        key: "fixture-batch",
        correlationId: testId(2),
        variantIds: snapshot.catalog.map((item) => item.variantId),
        submissionId: null,
        state: "queued",
      },
    ],
    items: snapshot.catalog.map((item) => ({
      variantId: item.variantId,
      sku: item.sku,
      priceCents: item.priceCents,
      state: "queued",
      externalProductId: null,
      error: null,
      stockState: "waiting_for_item",
      canRetry: false,
    })),
  });
}

export function publicationOperation(
  snapshot = publicationSnapshot(),
): StoredListingOperation {
  return {
    id: testId(3),
    channelId: snapshot.account.channelId,
    version: 2,
    leaseToken: testId(4),
    state: "queued",
    snapshot,
    progress: publicationProgress(snapshot),
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  };
}
