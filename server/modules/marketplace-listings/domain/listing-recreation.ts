import type {
  ListingAccount,
  ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { listingDraftItemSchema } from "@shared/types/channel-listing-publication";
import type { ListingUpdateChanges } from "@shared/types/channel-listing-update";
import {
  ListingPublicationError,
  listingHash,
  type ListingSnapshot,
  type StoredListingOperation,
} from "./listing-publication";

export type ListingRecreationEvidence = NonNullable<
  ListingSnapshot["recreations"]
>[number];

/** A completed feed is essential: a not-found read alone cannot settle an in-flight write. */
export function recreationSource(
  operation: StoredListingOperation,
  account: ListingAccount,
  sku: string,
  successorId?: string,
) {
  const expected = {
    ...operation.snapshot.account,
    revision: account.revision,
  };
  if (
    account.provider !== "walmart" ||
    listingHash(expected) !== listingHash(account)
  )
    throw new ListingPublicationError(
      "LISTING_RECREATION_ACCOUNT_CHANGED",
      "This submission belongs to a different Walmart account or fulfillment center.",
    );
  const item = operation.progress.items.find((entry) => entry.sku === sku);
  const batch = operation.progress.batches.find(
    (entry) => item && entry.variantIds.includes(item.variantId),
  );
  const draft = operation.snapshot.draft.items.find(
    (entry) => entry.variantId === item?.variantId,
  );
  const catalog = operation.snapshot.catalog.find(
    (entry) => entry.variantId === item?.variantId,
  );
  const settled =
    item &&
    (["accepted", "verified"].includes(item.state) ||
      (item.state === "needs_attention" && item.canRetry) ||
      (item.state === "superseded" &&
        successorId === item.recreatedByOperationId));
  if (
    !settled ||
    !batch ||
    batch.state !== "processed" ||
    (!batch.submissionId &&
      !(item?.state === "needs_attention" && item.canRetry) &&
      !(
        item?.state === "superseded" &&
        successorId === item.recreatedByOperationId
      )) ||
    !draft ||
    catalog?.sku !== sku
  )
    throw new ListingPublicationError(
      "LISTING_RECREATION_NOT_SETTLED",
      "The previous submission must finish before this listing can be recreated. Check its Walmart status first.",
    );
  return { item, draft, sourceHash: listingHash(operation.snapshot) };
}

/** Retain explicit listing overrides, apply accepted maintenance edits, and leave
 * inherited fields null so they resolve from today's catalog during the new review. */
export function recreationDraft(
  previous: ListingDraftItem,
  operationId: string,
  maintenance: { productType: string; changes: ListingUpdateChanges } | null,
): ListingDraftItem {
  const changes = maintenance?.changes;
  const prior = previous.attributes as {
    Orderable?: Record<string, unknown>;
    Visible?: Record<string, unknown>;
  };
  return listingDraftItemSchema.parse({
    ...previous,
    method: "create",
    recreateFromOperationId: operationId,
    productType: maintenance?.productType || previous.productType,
    title: changes?.title ?? previous.title,
    description: changes?.description ?? previous.description,
    brand: changes?.brand ?? previous.brand,
    images: changes?.images ?? previous.images,
    priceOverrideCents: changes?.priceCents ?? previous.priceOverrideCents,
    attributes: changes
      ? {
          Orderable: { ...prior.Orderable, ...changes.attributes?.Orderable },
          Visible: {
            ...(maintenance?.productType === previous.productType
              ? prior.Visible
              : {}),
            ...changes.attributes?.Visible,
          },
        }
      : previous.attributes,
  });
}

export function assertRecreationEvidence(
  evidence: ListingRecreationEvidence,
  source: StoredListingOperation,
  account: ListingAccount,
  successorId?: string,
): void {
  const { item, sourceHash } = recreationSource(
    source,
    account,
    evidence.sku,
    successorId,
  );
  if (
    source.id !== evidence.operationId ||
    item.variantId !== evidence.variantId ||
    (item.externalProductId !== null &&
      item.externalProductId !== evidence.previousExternalProductId) ||
    sourceHash !== evidence.sourceHash
  )
    throw new ListingPublicationError(
      "LISTING_RECREATION_STALE",
      "The previous listing changed. Prepare its recreation again.",
    );
}
