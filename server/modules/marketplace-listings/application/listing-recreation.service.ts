import {
  listingCatalogItemSchema,
  listingRecreationRequestSchema,
  listingRecreationSchema,
  type ListingAccount,
  type ListingCatalogItem,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { ChannelProviderError } from "../../channels/channel-provider.error";
import { ListingPublicationError } from "../domain/listing-publication";
import {
  assertRecreationEvidence,
  recreationDraft,
  recreationSource,
  type ListingRecreationEvidence,
} from "../domain/listing-recreation";
import type { ListingPublicationDependencies } from "./listing-publication.service";

/** Read-only recovery preparation; the normal reviewed publication command owns every write. */
export class ListingRecreationService {
  constructor(private readonly dependencies: ListingPublicationDependencies) {}

  async context(channelId: number, input: unknown) {
    const request = listingRecreationRequestSchema.parse(input);
    const provider = await this.dependencies.provider(channelId);
    const account = await provider.account(channelId);
    const source = await this.dependencies.store.operation(
      channelId,
      request.operationId,
    );
    const prior = recreationSource(source, account, request.sku);
    const page = await this.dependencies.catalog.catalog(channelId, {
      variantIds: String(prior.item.variantId),
    });
    const current = page.items.find(
      (item) => item.variantId === prior.item.variantId,
    );
    if (!current)
      throw new ListingPublicationError(
        "LISTING_VARIANT_MISSING",
        "This selling variant is no longer available in the Echelon catalog.",
      );
    const catalog = listingCatalogItemSchema.parse(current);
    const evidence = await this.verify(
      account,
      recreationDraft(prior.draft, source.id, null),
      catalog,
    );
    const maintenance = evidence.previousExternalProductId
      ? ((await this.dependencies.listingUpdates?.lastSubmitted?.(
          account,
          request.sku,
          evidence.previousExternalProductId,
          { includeInitial: false },
        )) ?? null)
      : null;
    const item = recreationDraft(prior.draft, source.id, maintenance);
    return listingRecreationSchema.parse({
      account,
      item,
      catalog,
      checkedAt: evidence.checkedAt,
    });
  }

  async verify(
    account: ListingAccount,
    draft: ListingDraftItem,
    catalog: ListingCatalogItem,
    expected?: ListingRecreationEvidence,
    successorId?: string,
  ): Promise<ListingRecreationEvidence> {
    if (!draft.recreateFromOperationId || draft.method !== "create")
      throw new ListingPublicationError(
        "LISTING_RECREATION_INVALID",
        "Recreation requires a full new-item submission.",
      );
    const source = await this.dependencies.store.operation(
      account.channelId,
      draft.recreateFromOperationId,
    );
    const prior = recreationSource(source, account, catalog.sku, successorId);
    if (
      draft.variantId !== prior.item.variantId ||
      catalog.variantId !== draft.variantId ||
      !catalog.eligible
    )
      throw new ListingPublicationError(
        "LISTING_RECREATION_IDENTITY_CHANGED",
        "The catalog SKU or selling variant changed. Prepare the listing again.",
      );
    if (expected)
      assertRecreationEvidence(expected, source, account, successorId);
    const provider = await this.dependencies.provider(account.channelId);
    if (!provider.assertCanRecreate)
      throw new ListingPublicationError(
        "LISTING_RECREATION_UNSUPPORTED",
        "This channel does not support recreating deleted listings.",
      );
    await provider.assertCanRecreate(account, catalog.sku);
    const identity = await (
      await this.dependencies.identities(account.channelId)
    ).checkRecreationMapping(account, {
      sku: catalog.sku,
      productVariantId: catalog.variantId,
      previousExternalProductId: prior.item.externalProductId,
    });
    if (
      expected &&
      identity.externalProductId !== expected.previousExternalProductId
    )
      throw new ListingPublicationError(
        "LISTING_RECREATION_STALE",
        "The saved Walmart identity changed. Prepare the recreation again.",
      );
    try {
      await provider.observe(account, catalog.sku);
    } catch (error) {
      // Auth, rate limits, timeouts and malformed responses are never absence evidence.
      if (!(error instanceof ChannelProviderError) || error.status !== 404)
        throw error;
      return {
        operationId: source.id,
        variantId: catalog.variantId,
        sku: catalog.sku,
        previousExternalProductId: identity.externalProductId,
        sourceHash: prior.sourceHash,
        checkedAt: this.dependencies.now().toISOString(),
      };
    }
    throw new ListingPublicationError(
      "LISTING_RECREATION_ITEM_EXISTS",
      "Walmart still has this SKU. Refresh or edit that listing; it cannot be recreated while it exists, including when retired.",
    );
  }
}
