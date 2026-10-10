import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  EbayListingSyncError,
  syncStageHash,
  type EbayListingSyncIdentity,
} from "../ebay-listing-sync.domain";
import { marketplaceObservedListingPublicationSchema, type MarketplaceObservedListingPublication } from "../../marketplace-listings";
import {
  findEbaySyncContentMismatch,
  inventoryItemSyncContent,
  itemGroupSyncContent,
  offerSyncContent,
} from "../ebay-listing-sync-content";
import type {
  BuiltInventoryItem,
  BuiltItemGroup,
  BuiltOffer,
} from "../adapters/ebay/ebay-listing-builder";
import type {
  EbayBulkPriceQuantityRequest,
  EbayBulkPriceQuantityResponse,
  EbayInventoryItem,
  EbayInventoryItemGroup,
  EbayOffer,
} from "../adapters/ebay/ebay-types";

export type EbayListingPublishMode = "stage" | "publish";

export interface EbayObservedOffer extends EbayOffer {
  offerId: string;
  status?: string;
  listingId?: string;
  listing?: {
    listingId?: string;
    listingStatus?: string;
  };
}

export interface EbayListingConnectorClient {
  getInventoryItem(sku: string): Promise<EbayInventoryItem | null>;
  createOrReplaceInventoryItem(
    sku: string,
    item: Omit<EbayInventoryItem, "sku">,
  ): Promise<void>;
  getOffers(
    sku: string,
    marketplaceId: string,
  ): Promise<{ offers: EbayObservedOffer[] }>;
  createOffer(offer: EbayOffer): Promise<string>;
  updateOffer(offerId: string, offer: EbayOffer): Promise<void>;
  createOrReplaceInventoryItemGroup(
    groupKey: string,
    group: Omit<EbayInventoryItemGroup, "inventoryItemGroupKey">,
  ): Promise<void>;
  publishOffer(offerId: string): Promise<{ listingId?: string }>;
  publishOfferByInventoryItemGroup(
    inventoryItemGroupKey: string,
    marketplaceId: string,
  ): Promise<{ listingId?: string }>;
}

/** Destructive operations used only by explicit rebuild execution. */
export interface EbayListingLifecycleClient extends EbayListingConnectorClient {
  getInventoryItemGroup(
    groupKey: string,
  ): Promise<(EbayInventoryItemGroup & { variantSKUs?: string[] }) | null>;
  withdrawOfferByInventoryItemGroup(
    groupKey: string,
    marketplaceId: string,
  ): Promise<void>;
  bulkUpdatePriceQuantity(
    request: EbayBulkPriceQuantityRequest,
  ): Promise<EbayBulkPriceQuantityResponse>;
  deleteInventoryItemGroup(groupKey: string): Promise<void>;
}

export interface EbayListingConnectorDraft {
  productId: number;
  marketplaceId: string;
  inventoryItems: BuiltInventoryItem[];
  offers: BuiltOffer[];
  itemGroup?: BuiltItemGroup | null;
  publishMode: EbayListingPublishMode;
  hasExistingExternalIds: boolean;
  existingExternalProductId?: string | null;
  existingOfferIdsByVariantId?: Record<number, string | null | undefined>;
  updateOfferAfterCreate?: boolean;
}

export interface EbayListingConnectorResult {
  productId: number;
  status: "created" | "updated";
  externalProductId?: string;
  externalVariantIds: Record<number, string>;
  externalOfferIds: Record<number, string>;
  published: boolean;
}

export interface EbayDiscoveredPublishedListing {
  readonly listingId: string;
  readonly members: ReadonlyArray<{ readonly variantId: number; readonly sku: string; readonly offerId: string }>;
}

export type EbayPublishedListingIdentityResolver = (
  discovered: EbayDiscoveredPublishedListing,
) => Promise<MarketplaceObservedListingPublication>;

export interface EbayExistingListingSyncResult {
  productId: number;
  updatedInventorySkus: string[];
  updatedOfferIds: Record<number, string>;
  missingOfferVariantIds: number[];
  policyChangedVariantIds: number[];
  itemGroupUpdated: boolean;
}

export interface EbayListingStatusInspection {
  inventoryItemExists: boolean;
  hasActiveOffer: boolean;
  availableQuantity: number | null;
}

export interface EbayListingRebuildPreview {
  productId: number;
  groupKey: string;
  currentExternalListingId: string;
  sourceState: "active" | "withdrawn";
  currentSkus: string[];
  activeSkus: string[];
  inactiveSkus: string[];
  desiredSkus: string[];
  addedSkus: string[];
  removedSkus: string[];
  rebuildRequired: boolean;
  confirmationToken: string;
}

export interface EbayListingRebuildResult extends EbayListingConnectorResult {
  previousExternalListingId: string;
  removedSkus: string[];
}

interface EbayMarketplaceListingConnectorOptions {
  delay?: (ms: number) => Promise<void>;
  inventoryDelayMs?: number;
  offerDelayMs?: number;
  groupPublishRetryDelaysMs?: readonly number[];
}

interface ResolvedPushOffer {
  offer: BuiltOffer;
  existingOfferId: string | null;
}

async function runSyncStage(
  stage:
    | ((key: string, hash: string, work: () => Promise<void>) => Promise<void>)
    | undefined,
  key: string,
  payload: unknown,
  work: () => Promise<void>,
): Promise<void> {
  if (stage) return stage(key, syncStageHash(payload), work);
  await work();
}
function readbackPending(resource: string, field: string): EbayListingSyncError {
  return new EbayListingSyncError(
    "EBAY_SYNC_READBACK_PENDING",
    `Waiting for eBay to expose the requested content and published identity of ${resource} (field ${field}).`,
  );
}

function publishedOffersForSyncMember(
  offers: readonly EbayObservedOffer[],
  member: EbayListingSyncIdentity["variants"][number],
  resolvedOfferId?: string,
): EbayObservedOffer[] {
  return offers.filter(
    (candidate) =>
      candidate.sku === member.sku &&
      (!member.offerId || candidate.offerId === member.offerId) &&
      (!resolvedOfferId || candidate.offerId === resolvedOfferId) &&
      (!member.listingId ||
        (candidate.listingId ?? candidate.listing?.listingId) === member.listingId) &&
      candidate.status === "PUBLISHED",
  );
}

function exactObservedOffer(
  offers: readonly EbayObservedOffer[],
  expected: { sku: string; marketplaceId: string; format: EbayOffer["format"]; offerId?: string | null },
): EbayObservedOffer | undefined {
  const matching = offers.filter(candidate => candidate.sku === expected.sku
    && candidate.marketplaceId === expected.marketplaceId && candidate.format === expected.format);
  if (offers.length !== matching.length || matching.length > 1
    || (expected.offerId != null && (matching.length !== 1 || matching[0].offerId !== expected.offerId))) {
    throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID",
      `Cannot identify one exact eBay offer for SKU ${expected.sku} in ${expected.marketplaceId}. Saved offer: ${expected.offerId ?? "none"}; observed offers: ${offers.map(candidate => candidate.offerId).join(", ") || "none"}. Review the listing mapping before publishing.`);
  }
  return matching[0];
}

export class EbayMarketplaceListingConnector {
  private readonly delay: (ms: number) => Promise<void>;
  private readonly inventoryDelayMs: number;
  private readonly offerDelayMs: number;
  private readonly groupPublishRetryDelaysMs: readonly number[];

  constructor(options: EbayMarketplaceListingConnectorOptions = {}) {
    this.delay = options.delay ?? (() => Promise.resolve());
    this.inventoryDelayMs = options.inventoryDelayMs ?? 0;
    this.offerDelayMs = options.offerDelayMs ?? 0;
    this.groupPublishRetryDelaysMs = options.groupPublishRetryDelaysMs ?? [
      250, 750, 1_500,
    ];
  }

  async pushListing(input: {
    client: EbayListingConnectorClient;
    draft: EbayListingConnectorDraft;
    resolvePublishedIdentity?: EbayPublishedListingIdentityResolver;
  }): Promise<EbayListingConnectorResult> {
    validateDraft(input.draft);

    const { resolvedOffers, firstListingId, hasPublishedOffer } = await this.resolvePushOffers(input.client, input.draft);
    const offerIdsByVariantId: Record<number, string> = {};
    let verifiedPublishedListingId: string | undefined;

    let draft = input.draft;
    if (hasPublishedOffer) {
      if (!input.resolvePublishedIdentity || !firstListingId || resolvedOffers.some(member => !member.existingOfferId)) {
        throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID", "Existing published eBay offers require a complete provider listing identity check before any further write. Use the listing's Sync or reviewed recovery action.");
      }
      const identity = marketplaceObservedListingPublicationSchema.parse(await input.resolvePublishedIdentity({
        listingId: firstListingId,
        members: resolvedOffers.map(member => ({ variantId: member.offer.variantId, sku: member.offer.sku, offerId: member.existingOfferId! })),
      }));
      const memberBySku = new Map(identity.members.map(member => [member.sku, member]));
      const groupKey = identity.publicationKeyIdentity?.externalId ?? null;
      if (identity.providerAccount.provider !== "ebay" || !identity.isPublished
        || identity.marketplaceId !== draft.marketplaceId || identity.listingIdentity.externalId !== firstListingId
        || identity.members.length !== resolvedOffers.length || memberBySku.size !== resolvedOffers.length
        || resolvedOffers.some(member => {
          const bound = memberBySku.get(member.offer.sku);
          return !bound || bound.inventoryItemIdentity?.externalId !== member.offer.sku || bound.offerIdentity?.externalId !== member.existingOfferId;
        }) || (groupKey === null) !== !draft.itemGroup) {
        throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The discovered eBay publication does not match this product's exact offers and listing shape. Review its complete mapping before publishing.");
      }
      // A previous publish may have completed before its local mapping commit.
      // Only the shared provider observer can bind the group to update on replay.
      draft = { ...draft, existingExternalProductId: firstListingId,
        itemGroup: draft.itemGroup ? { ...draft.itemGroup, groupKey: groupKey! } : null };
      verifiedPublishedListingId = firstListingId;
    }

    // eBay validates an inventory item against any offer already associated with
    // the SKU. Repair existing offer policies first so a deleted policy cannot
    // prevent the subsequent inventory replacement.
    for (const { offer, existingOfferId } of resolvedOffers) {
      if (!existingOfferId) continue;

      await input.client.updateOffer(
        existingOfferId,
        withOfferId(offer.payload, existingOfferId),
      );
      offerIdsByVariantId[offer.variantId] = existingOfferId;
      await this.delay(this.offerDelayMs);
    }

    for (const item of input.draft.inventoryItems) {
      await input.client.createOrReplaceInventoryItem(item.sku, item.payload);
      await this.delay(this.inventoryDelayMs);
    }

    // A genuinely new offer still requires its inventory item to exist first.
    for (const { offer, existingOfferId } of resolvedOffers) {
      if (existingOfferId) continue;

      const offerId = await input.client.createOffer(offer.payload);
      if (input.draft.updateOfferAfterCreate) {
        await input.client.updateOffer(
          offerId,
          withOfferId(offer.payload, offerId),
        );
      }
      offerIdsByVariantId[offer.variantId] = offerId;
      await this.delay(this.offerDelayMs);
    }

    const externalProductId = await this.resolveExternalProductId({
      client: input.client,
      draft,
      offerIdsByVariantId,
      firstListingId,
      verifiedPublishedListingId,
    });

    return {
      productId: input.draft.productId,
      status: input.draft.hasExistingExternalIds ? "updated" : "created",
      externalProductId,
      externalVariantIds: offerIdsByVariantId,
      externalOfferIds: offerIdsByVariantId,
      published: input.draft.publishMode === "publish",
    };
  }

  async previewListingRebuild(input: {
    client: EbayListingLifecycleClient;
    draft: EbayListingConnectorDraft;
    currentExternalListingId: string;
  }): Promise<EbayListingRebuildPreview> {
    validateRebuildInput(input.draft, input.currentExternalListingId);
    const itemGroup = input.draft.itemGroup!;
    const remoteGroup = await input.client.getInventoryItemGroup(
      itemGroup.groupKey,
    );
    if (!remoteGroup) {
      throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID", "The current eBay variation group could not be found. Review its saved group and listing identity before updating it.");
    }

    const currentSkus = normalizedSkus(remoteGroup.variantSKUs);
    const desiredSkus = normalizedSkus(itemGroup.payload.variantSKUs);
    if (currentSkus.length === 0 || desiredSkus.length === 0) {
      throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED",
        "Current and desired eBay variation groups must contain at least one SKU.",
      );
    }
    const currentPublication = await inspectListingPublication({
      client: input.client,
      skus: currentSkus,
      marketplaceId: input.draft.marketplaceId,
      expectedListingId: input.currentExternalListingId,
    });
    const activeSkus =
      currentPublication.state === "active"
        ? normalizedSkus([...currentPublication.offerIdsBySku.keys()])
        : [];
    const active = new Set(activeSkus);
    const inactiveSkus = currentSkus.filter((sku) => !active.has(sku));
    const desired = new Set(desiredSkus);
    const previewWithoutToken = {
      productId: input.draft.productId,
      groupKey: itemGroup.groupKey,
      currentExternalListingId: input.currentExternalListingId.trim(),
      sourceState: currentPublication.state,
      currentSkus,
      activeSkus,
      inactiveSkus,
      desiredSkus,
      addedSkus: desiredSkus.filter((sku) => !active.has(sku)),
      removedSkus: activeSkus.filter((sku) => !desired.has(sku)),
    };
    return {
      ...previewWithoutToken,
      rebuildRequired:
        previewWithoutToken.removedSkus.length > 0 ||
        previewWithoutToken.sourceState === "withdrawn",
      confirmationToken: rebuildConfirmationToken(previewWithoutToken),
    };
  }

  async executeListingRebuild(input: {
    client: EbayListingLifecycleClient;
    draft: EbayListingConnectorDraft;
    preview: EbayListingRebuildPreview;
    resolvePublishedIdentity?: EbayPublishedListingIdentityResolver;
  }): Promise<EbayListingRebuildResult> {
    validateRebuildInput(input.draft, input.preview.currentExternalListingId);
    validateConfirmedPreview(input.draft, input.preview);
    if (!input.preview.rebuildRequired) {
      throw new EbayListingSyncError("EBAY_LISTING_REVIEW_CHANGED", "The confirmed eBay listing does not require a rebuild. Analyze it again and use the current available update action.");
    }

    const itemGroup = input.draft.itemGroup!;
    const remoteGroup = await input.client.getInventoryItemGroup(
      itemGroup.groupKey,
    );
    if (remoteGroup) {
      const observedSkus = normalizedSkus(remoteGroup.variantSKUs);
      if (sameStrings(observedSkus, input.preview.currentSkus)) {
        const sourcePublication = await inspectListingPublication({
          client: input.client,
          skus: observedSkus,
          marketplaceId: input.draft.marketplaceId,
          expectedListingId: input.preview.currentExternalListingId,
        });
        if (sourcePublication.state === "active") {
          await input.client.withdrawOfferByInventoryItemGroup(
            itemGroup.groupKey,
            input.draft.marketplaceId,
          );
        }
        await input.client.deleteInventoryItemGroup(itemGroup.groupKey);
      } else if (sameStrings(observedSkus, input.preview.desiredSkus)) {
        const targetPublication = await inspectListingPublication({
          client: input.client,
          skus: observedSkus,
          marketplaceId: input.draft.marketplaceId,
        });
        if (targetPublication.state === "active") {
          if (
            targetPublication.listingId ===
            input.preview.currentExternalListingId
          ) {
            throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED",
              "eBay still associates the desired variation group with the old listing identity.",
            );
          }
          const externalOfferIds: Record<number, string> = {};
          for (const offer of input.draft.offers) {
            const offerId = targetPublication.offerIdsBySku.get(offer.sku);
            if (!offerId) {
              throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID",
                `The published replacement is missing an offer for ${offer.sku}.`,
              );
            }
            externalOfferIds[offer.variantId] = offerId;
          }
          return {
            productId: input.draft.productId,
            status: "created",
            externalProductId: targetPublication.listingId,
            externalVariantIds: externalOfferIds,
            externalOfferIds,
            published: true,
            previousExternalListingId: input.preview.currentExternalListingId,
            removedSkus: [...input.preview.removedSkus],
          };
        }
      } else {
        throw new EbayListingSyncError("EBAY_LISTING_REVIEW_CHANGED",
          "The eBay variation group changed after rebuild confirmation. Preview it again.",
        );
      }
    }

    const result = await this.pushListing({
      client: input.client,
      resolvePublishedIdentity: input.resolvePublishedIdentity ? async discovered => {
        if (discovered.listingId === input.preview.currentExternalListingId)
          throw readbackPending(discovered.listingId, "withdrawn source publication");
        const observed = await input.resolvePublishedIdentity!(discovered);
        if (observed.publicationKeyIdentity?.externalId !== input.preview.groupKey)
          throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The replacement eBay group differs from the reviewed rebuild. Review its mapping before another write.");
        return observed;
      } : undefined,
      draft: {
        ...input.draft,
        publishMode: "publish",
        hasExistingExternalIds: false,
        existingExternalProductId: null,
      },
    });
    if (
      !result.externalProductId ||
      result.externalProductId === input.preview.currentExternalListingId
    ) {
      throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_RESPONSE_INVALID",
        "eBay did not return a new listing identity after rebuilding the listing.",
      );
    }
    return {
      ...result,
      previousExternalListingId: input.preview.currentExternalListingId,
      removedSkus: [...input.preview.removedSkus],
    };
  }
  async updateExistingListing(input: {
    client: EbayListingLifecycleClient;
    draft: EbayListingConnectorDraft;
    preview: EbayListingRebuildPreview;
  }): Promise<EbayListingConnectorResult & { removedSkus: string[]; previousExternalListingId: string }> {
    validateRebuildInput(input.draft, input.preview.currentExternalListingId);

    const currentPreview = await this.previewListingRebuild({
      client: input.client,
      draft: input.draft,
      currentExternalListingId: input.preview.currentExternalListingId,
    });
    if (currentPreview.confirmationToken !== input.preview.confirmationToken) {
      throw new EbayListingSyncError("EBAY_LISTING_REVIEW_CHANGED",
        "The live eBay listing changed after review. Read eBay again before updating it.",
      );
    }
    if (currentPreview.sourceState !== "active") {
      throw new EbayListingSyncError("EBAY_LISTING_REVIEW_CHANGED",
        "The current eBay listing is no longer active and cannot be updated in place.",
      );
    }

    const liveGroup = await input.client.getInventoryItemGroup(
      currentPreview.groupKey,
    );
    if (!liveGroup) {
      throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID",
        "The current eBay variation group could not be found after review.",
      );
    }
    const alignedDraft = alignDraftVariationSchemaToLiveGroup({
      draft: {
        ...input.draft,
        itemGroup: input.draft.itemGroup!,
        hasExistingExternalIds: true,
        existingExternalProductId: currentPreview.currentExternalListingId,
      },
      liveGroup,
    });
    const result = await this.updateExistingVariationGroup({
      client: input.client,
      draft: alignedDraft,
      currentGroup: liveGroup,
      addedSkus: currentPreview.addedSkus,
      removedSkus: currentPreview.removedSkus,
    });
    if (result.externalProductId !== currentPreview.currentExternalListingId) {
      throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED",
        "eBay did not preserve the reviewed listing id during the in-place update.",
      );
    }
    return { ...result, previousExternalListingId: currentPreview.currentExternalListingId };
  }
  /**
   * Update an active variation listing in eBay's required dependency order:
   * inventory items, group membership, offers, then publication. The generic
   * push path intentionally repairs offers first and is not valid when the
   * set of variation specifics is changing.
   */
  private async updateExistingVariationGroup(input: {
    client: EbayListingLifecycleClient;
    draft: EbayListingConnectorDraft & { itemGroup: BuiltItemGroup };
    currentGroup: EbayInventoryItemGroup & { variantSKUs?: string[] };
    addedSkus: readonly string[];
    removedSkus: readonly string[];
  }): Promise<EbayListingConnectorResult & { removedSkus: string[] }> {
    const { resolvedOffers } = await this.resolvePushOffers(
      input.client,
      input.draft,
    );
    const offerIdsByVariantId: Record<number, string> = {};
    const removedOfferIds = new Map<string, string>();
    const expectedListingId = input.draft.existingExternalProductId!;
    for (const sku of normalizedSkus(input.removedSkus)) {
      const observed = exactObservedOffer((await input.client.getOffers(sku, input.draft.marketplaceId)).offers,
        { sku, marketplaceId: input.draft.marketplaceId, format: "FIXED_PRICE" });
      if (!observed || !isPublishedObservedOffer(observed) || observedOfferListingId(observed) !== expectedListingId)
        throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID", `Removed variation ${sku} no longer identifies the reviewed listing. Analyze it again before changing membership.`);
      removedOfferIds.set(sku, observed.offerId);
    }
    const originalGroup = toWritableGroupPayload(input.currentGroup);
    let workingGroup = input.currentGroup;
    let temporaryTransitionApplied = false;
    let targetGroupApplied = false;
    let retainedRemovedSkus: string[] = [];
    const addedSkus = new Set(normalizedSkus(input.addedSkus));
    const inventoryItemsToPrepare = input.draft.inventoryItems.filter((item) =>
      addedSkus.has(item.sku),
    );

    try {
      for (const item of inventoryItemsToPrepare) {
        try {
          await input.client.createOrReplaceInventoryItem(
            item.sku,
            item.payload,
          );
        } catch (error) {
          const currentMembers = normalizedSkus(workingGroup.variantSKUs);
          if (
            !isVariationSpecificsMismatchError(error) ||
            !currentMembers.includes(item.sku)
          ) {
            throw error;
          }

          const transitionGroup = buildGroupWithoutVariation({
            currentGroup: workingGroup,
            item,
          });
          await input.client.createOrReplaceInventoryItemGroup(
            input.draft.itemGroup.groupKey,
            transitionGroup,
          );
          temporaryTransitionApplied = true;
          workingGroup = {
            ...transitionGroup,
            inventoryItemGroupKey: input.draft.itemGroup.groupKey,
          };
          await input.client.createOrReplaceInventoryItem(
            item.sku,
            item.payload,
          );
        }
        await this.delay(this.inventoryDelayMs);
      }

      try {
        await input.client.createOrReplaceInventoryItemGroup(
          input.draft.itemGroup.groupKey,
          input.draft.itemGroup.payload,
        );
        targetGroupApplied = true;
      } catch (error) {
        if (
          input.removedSkus.length === 0 ||
          !isInvalidInventoryItemGroupError(error)
        ) {
          throw error;
        }
        const currentGroup = await input.client.getInventoryItemGroup(
          input.draft.itemGroup.groupKey,
        );
        if (!currentGroup) throw error;

        retainedRemovedSkus = normalizedSkus(input.removedSkus);
        await input.client.createOrReplaceInventoryItemGroup(
          input.draft.itemGroup.groupKey,
          buildRetainedVariationGroupPayload({
            desiredGroup: input.draft.itemGroup.payload,
            currentGroup,
            retainedSkus: retainedRemovedSkus,
          }),
        );
        targetGroupApplied = true;
      }

      for (const { offer, existingOfferId } of resolvedOffers) {
        const offerId = existingOfferId
          ? existingOfferId
          : await input.client.createOffer(offer.payload);
        if (existingOfferId || input.draft.updateOfferAfterCreate) {
          await input.client.updateOffer(
            offerId,
            withOfferId(offer.payload, offerId),
          );
        }
        offerIdsByVariantId[offer.variantId] = offerId;
        await this.delay(this.offerDelayMs);
      }

      for (const sku of retainedRemovedSkus) {
        await this.disableRetainedVariation(
          input.client,
          sku,
          input.draft.marketplaceId,
          expectedListingId,
          removedOfferIds.get(sku)!,
        );
      }
    } catch (error) {
      if (temporaryTransitionApplied && !targetGroupApplied) {
        try {
          await input.client.createOrReplaceInventoryItemGroup(
            input.draft.itemGroup.groupKey,
            originalGroup,
          );
        } catch (recoveryError) {
          throw new EbayListingSyncError("EBAY_LISTING_RESTORE_FAILED",
            "The eBay variation update failed and Echelon could not restore the original group. Review the current listing before authorizing another membership change.",
            { cause: new AggregateError([error, recoveryError], "Variation update and restoration failed") },
          );
        }
      }
      throw error;
    }

    const publishResult = await this.publishGroupWithConsistencyRetry({
      client: input.client,
      groupKey: input.draft.itemGroup.groupKey,
      marketplaceId: input.draft.marketplaceId,
    });
    return {
      productId: input.draft.productId,
      status: "updated",
      externalProductId:
        publishResult.listingId ??
        input.draft.existingExternalProductId ??
        undefined,
      externalVariantIds: offerIdsByVariantId,
      externalOfferIds: offerIdsByVariantId,
      published: true,
      removedSkus: normalizedSkus(input.removedSkus).filter(sku => !retainedRemovedSkus.includes(sku)),
    };
  }

  private async resolvePushOffers(
    client: EbayListingConnectorClient,
    draft: EbayListingConnectorDraft,
  ): Promise<{ resolvedOffers: ResolvedPushOffer[]; firstListingId: string | undefined; hasPublishedOffer: boolean }> {
    const resolvedOffers: ResolvedPushOffer[] = [];
    let firstListingId: string | undefined;
    let hasPublishedOffer = false;
    // Both publication replay and reviewed membership changes require a fresh
    // exact read. Saved offer IDs constrain discovery; they never bypass it.
    for (const offer of draft.offers) {
      const savedOfferId = draft.existingOfferIdsByVariantId?.[offer.variantId] ?? null;
      const observed = await client.getOffers(offer.sku, draft.marketplaceId);
      const existingOffer = exactObservedOffer(observed.offers,
        { sku: offer.sku, marketplaceId: draft.marketplaceId, format: offer.payload.format, offerId: savedOfferId });
      const listingId = existingOffer ? observedOfferListingId(existingOffer) : undefined;
      if (existingOffer && (isPublishedObservedOffer(existingOffer)
        || (listingId && existingOffer.status?.trim().toUpperCase() !== "UNPUBLISHED"))) {
        hasPublishedOffer = true;
        if (!listingId) throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID", `Published eBay offer ${existingOffer.offerId} has no listing ID. Review its identity before publishing.`);
      }
      if (listingId && ((firstListingId && listingId !== firstListingId)
        || (draft.existingExternalProductId && listingId !== draft.existingExternalProductId))) {
        throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID", `SKU ${offer.sku} belongs to eBay listing ${listingId}, which differs from this product's other saved or observed listing. Review the mapping before publishing.`);
      }
      if (listingId) firstListingId = listingId;
      resolvedOffers.push({ offer, existingOfferId: existingOffer?.offerId ?? null });
    }
    return { resolvedOffers, firstListingId, hasPublishedOffer };
  }

  private async disableRetainedVariation(
    client: EbayListingLifecycleClient,
    sku: string,
    marketplaceId: string,
    listingId: string,
    offerId: string,
  ): Promise<void> {
    const inventoryItem = await client.getInventoryItem(sku);
    if (!inventoryItem || inventoryItem.sku !== sku) {
      throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID",
        `Cannot retain removed eBay variation ${sku} because its exact inventory item was not found.`,
      );
    }
    const response = await client.getOffers(sku, marketplaceId);
    const observed = exactObservedOffer(response.offers, { sku, marketplaceId, format: "FIXED_PRICE", offerId });
    if (!observed || !isPublishedObservedOffer(observed) || observedOfferListingId(observed) !== listingId)
      throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID", `Retained variation ${sku} no longer identifies the reviewed offer and listing. Review its current mapping before reducing quantity.`);
    const inventoryQuantity =
      inventoryItem.availability.shipToLocationAvailability.quantity;
    const offersAlreadyZero = observed.availableQuantity === 0;
    if (inventoryQuantity === 0 && offersAlreadyZero) return;

    const result = await client.bulkUpdatePriceQuantity({
      requests: [
        {
          sku,
          shipToLocationAvailability: { quantity: 0 },
          offers: [{
            offerId: observed.offerId,
            availableQuantity: 0,
          }],
        },
      ],
    });
    assertBulkQuantityUpdateSucceeded(result, sku);
  }

  private validateExistingListingSyncDraft(input: {
    draft: Pick<
      EbayListingConnectorDraft,
      "productId" | "marketplaceId" | "inventoryItems" | "offers" | "itemGroup"
    >;
    identity?: EbayListingSyncIdentity;
  }): void {
    if (input.identity) {
      const identity = input.identity,
        skus = new Set(identity.variants.map((member) => member.sku));
      const writableMembers = identity.variants.filter(member => member.contentSyncEnabled !== false);
      const writableSkus = new Set(writableMembers.map(member => member.sku));
      if (
        input.draft.productId !== identity.productId ||
        input.draft.marketplaceId !== identity.marketplaceId ||
        input.draft.inventoryItems.length !== writableSkus.size ||
        new Set(input.draft.inventoryItems.map((item) => item.sku)).size !==
          writableSkus.size ||
        input.draft.inventoryItems.some((item) => !writableSkus.has(item.sku)) ||
        input.draft.offers.length !== writableMembers.length ||
        new Set(input.draft.offers.map((offer) => offer.variantId)).size !==
          writableMembers.length ||
        input.draft.offers.some(
          (offer) =>
            !writableMembers.some(
              (member) =>
                member.variantId === offer.variantId &&
                member.sku === offer.sku,
            ),
        ) ||
        (identity.groupKey !== null && !input.draft.itemGroup) ||
        (identity.variants.length > 1 && !input.draft.itemGroup) ||
        (input.draft.itemGroup &&
          (input.draft.itemGroup.groupKey !== identity.groupKey ||
            !Array.isArray(input.draft.itemGroup.payload.variantSKUs) ||
            input.draft.itemGroup.payload.variantSKUs.length !== skus.size ||
            new Set(input.draft.itemGroup.payload.variantSKUs).size !==
              skus.size ||
            input.draft.itemGroup.payload.variantSKUs.some(
              (sku) => !skus.has(sku),
            )))
      ) {
        throw new EbayListingSyncError(
          "EBAY_SYNC_DRAFT_SCOPE_INVALID",
          "The prepared update contains a different listing, group or SKU identity.",
        );
      }
    }
    validateMaintenanceDraft(input.draft);
  }

  /** Keep excluded/sold members' provider content and variation values intact. */
  async prepareExistingListingSyncDraft(input: {
    client: EbayListingLifecycleClient;
    identity: EbayListingSyncIdentity;
    draft: Pick<EbayListingConnectorDraft, "productId" | "marketplaceId" | "inventoryItems" | "offers" | "itemGroup">;
  }): Promise<typeof input.draft> {
    this.validateExistingListingSyncDraft(input);
    const retained = input.identity.variants.filter(member => member.contentSyncEnabled === false);
    if (!retained.length || !input.draft.itemGroup) return input.draft;
    const current = await input.client.getInventoryItemGroup(input.draft.itemGroup.groupKey);
    if (!current || (current.inventoryItemGroupKey !== undefined && current.inventoryItemGroupKey !== input.identity.groupKey)
      || !sameStrings(normalizedSkus(current.variantSKUs), normalizedSkus(input.identity.variants.map(member => member.sku)))) {
      throw new EbayListingSyncError("EBAY_SYNC_MEMBERSHIP_CHANGED", "The existing eBay group changed while preparing retained variation content.");
    }
    const aligned = alignDraftVariationSchemaToLiveGroup({ draft: { ...input.draft, itemGroup: input.draft.itemGroup,
      publishMode: "stage", hasExistingExternalIds: true }, liveGroup: current });
    const desiredGroup = aligned.itemGroup.payload;
    // Only included inventory items contribute new variation values. Existing
    // values remain sourced from eBay through the shared retention primitive.
    const enabledSpecifications = desiredGroup.variesBy.specifications.map(specification => ({
      ...specification,
      values: [...new Set(aligned.inventoryItems.flatMap(item => item.payload.product.aspects?.[specification.name] ?? []))],
    }));
    return { ...input.draft, inventoryItems: aligned.inventoryItems,
      itemGroup: { ...aligned.itemGroup, payload: buildRetainedVariationGroupPayload({
        desiredGroup: { ...desiredGroup, variesBy: { ...desiredGroup.variesBy, specifications: enabledSpecifications } },
        currentGroup: current, retainedSkus: retained.map(member => member.sku),
      }) } };
  }

  private async verifyRetainedSyncMembers(input: {
    client: EbayListingConnectorClient;
    identity?: EbayListingSyncIdentity;
    draft: Pick<EbayListingConnectorDraft, "marketplaceId">;
  }): Promise<void> {
    for (const member of input.identity?.variants.filter(value => value.contentSyncEnabled === false) ?? []) {
      const current = await input.client.getInventoryItem(member.sku);
      const offers = await input.client.getOffers(member.sku, input.draft.marketplaceId);
      if (!current || current.sku !== member.sku || publishedOffersForSyncMember(offers.offers, member).length !== 1) {
        throw new EbayListingSyncError("EBAY_SYNC_RETAINED_IDENTITY_CHANGED", `Retained eBay SKU ${member.sku} no longer matches its saved inventory item, offer and listing.`);
      }
    }
  }

  async syncExistingListing(input: {
    client: EbayListingConnectorClient;
    draft: Pick<
      EbayListingConnectorDraft,
      "productId" | "marketplaceId" | "inventoryItems" | "offers" | "itemGroup"
    >;
    identity?: EbayListingSyncIdentity;
    stage?: (
      key: string,
      hash: string,
      work: () => Promise<void>,
    ) => Promise<void>;
  }): Promise<EbayExistingListingSyncResult> {
    this.validateExistingListingSyncDraft(input);
    await this.verifyRetainedSyncMembers(input);

    const updatedInventorySkus: string[] = [];
    const updatedOfferIds: Record<number, string> = {};
    const missingOfferVariantIds: number[] = [];
    const policyChangedVariantIds: number[] = [];
    let itemGroupUpdated = false;

    for (const offer of input.draft.offers) {
      const existingOffers = await input.client.getOffers(
        offer.sku,
        input.draft.marketplaceId,
      );
      const expected = input.identity?.variants.find(
        (member) =>
          member.variantId === offer.variantId && member.sku === offer.sku,
      );
      const matches = expected
        ? publishedOffersForSyncMember(existingOffers.offers, expected)
        : existingOffers.offers;
      if (input.identity && (!expected || matches.length !== 1))
        throw new EbayListingSyncError(
          "EBAY_SYNC_OFFER_IDENTITY_CHANGED",
          "The published offer no longer matches this saved SKU and listing identity.",
        );
      const existingOffer = matches[0];
      if (!existingOffer?.offerId) {
        missingOfferVariantIds.push(offer.variantId);
        continue;
      }

      if (
        listingPoliciesChanged(
          existingOffer.listingPolicies,
          offer.payload.listingPolicies,
        )
      ) {
        policyChangedVariantIds.push(offer.variantId);
      }
      const payload = withOfferId(offer.payload, existingOffer.offerId);
      await runSyncStage(
        input.stage,
        `offer:${existingOffer.offerId}`,
        payload,
        () => input.client.updateOffer(existingOffer.offerId, payload),
      );
      updatedOfferIds[offer.variantId] = existingOffer.offerId;
      await this.delay(this.offerDelayMs);
    }

    for (const item of input.draft.inventoryItems) {
      await runSyncStage(input.stage, `item:${item.sku}`, item.payload, () =>
        input.client.createOrReplaceInventoryItem(item.sku, item.payload),
      );
      updatedInventorySkus.push(item.sku);
      await this.delay(this.inventoryDelayMs);
    }

    // eBay requires the inventory item and offer for a newly-added variation
    // to exist before that SKU is added to an active inventory item group.
    // Do not replace group membership when any sellable offer is missing;
    // doing so can partially rewrite an active multi-variation listing.
    if (input.draft.itemGroup && missingOfferVariantIds.length === 0) {
      const group = input.draft.itemGroup;
      await runSyncStage(
        input.stage,
        `group:${group.groupKey}`,
        group.payload,
        () =>
          input.client.createOrReplaceInventoryItemGroup(
            group.groupKey,
            group.payload,
          ),
      );
      itemGroupUpdated = true;
    }

    return {
      productId: input.draft.productId,
      updatedInventorySkus,
      updatedOfferIds,
      missingOfferVariantIds,
      policyChangedVariantIds,
      itemGroupUpdated,
    };
  }

  /** Current resource content plus the exact PUBLISHED offer/listing identity,
   * not just a successful PUT. Quantity is intentionally omitted: its admission
   * owner may have refreshed canonical ATP since the draft was prepared. */
  async verifyExistingListing(input: {
    client: EbayListingConnectorClient &
      Pick<EbayListingLifecycleClient, "getInventoryItemGroup">;
    draft: Pick<
      EbayListingConnectorDraft,
      "productId" | "inventoryItems" | "offers" | "itemGroup" | "marketplaceId"
    >;
    identity: EbayListingSyncIdentity;
    offerIds: Record<number, string>;
  }): Promise<void> {
    this.validateExistingListingSyncDraft(input);
    await this.verifyRetainedSyncMembers(input);
    for (const item of input.draft.inventoryItems) {
      const current = await input.client.getInventoryItem(item.sku);
      if (!current) throw readbackPending(`inventory item ${item.sku}`, "resource");
      if (current.sku !== item.sku) throw readbackPending(`inventory item ${item.sku}`, "sku");
      const mismatch = findEbaySyncContentMismatch(current, inventoryItemSyncContent(item.payload));
      if (mismatch) throw readbackPending(`inventory item ${item.sku}`, mismatch);
    }
    for (const offer of input.draft.offers) {
      const offers = await input.client.getOffers(
        offer.sku,
        input.draft.marketplaceId,
      );
      const expectedIdentity = input.identity.variants.find(
        (row) => row.variantId === offer.variantId,
      );
      // A saved offer ID is optional in the existing identity contract. Both
      // writing and readback require one exact published match; never choose
      // arbitrarily when two offers claim that same SKU/listing identity.
      const matches = expectedIdentity
        ? publishedOffersForSyncMember(
            offers.offers,
            expectedIdentity,
            input.offerIds[offer.variantId],
          )
        : [];
      if (matches.length !== 1) {
        throw readbackPending(`offer for ${offer.sku}`, "publishedIdentity");
      }
      const current = matches[0];
      const mismatch = findEbaySyncContentMismatch(current, offerSyncContent(offer.payload));
      if (mismatch) throw readbackPending(`offer for ${offer.sku}`, mismatch);
    }
    if (input.draft.itemGroup) {
      const group = input.draft.itemGroup;
      const current = await input.client.getInventoryItemGroup(group.groupKey);
      // The exact group was requested by path. eBay does not echo its key in the
      // GET body; still reject a conflicting key from a legacy client if present.
      if (!current) throw readbackPending(`group ${group.groupKey}`, "resource");
      if (current.inventoryItemGroupKey !== undefined && current.inventoryItemGroupKey !== group.groupKey) {
        throw readbackPending(`group ${group.groupKey}`, "inventoryItemGroupKey");
      }
      const mismatch = findEbaySyncContentMismatch(current, itemGroupSyncContent(group.payload));
      if (mismatch) throw readbackPending(`group ${group.groupKey}`, mismatch);
    }
  }

  async getExistingInventoryImageUrls(input: {
    client: EbayListingConnectorClient;
    sku: string;
  }): Promise<string[]> {
    const inventoryItem = await input.client.getInventoryItem(input.sku);
    return inventoryItem?.product?.imageUrls ?? [];
  }

  async inspectListingStatus(input: {
    client: EbayListingConnectorClient;
    sku: string;
    marketplaceId: string;
  }): Promise<EbayListingStatusInspection> {
    const inventoryItem = await input.client.getInventoryItem(input.sku);
    if (!inventoryItem) {
      return {
        inventoryItemExists: false,
        hasActiveOffer: false,
        availableQuantity: null,
      };
    }

    const offers = await input.client.getOffers(input.sku, input.marketplaceId);
    const activeOffers = offers.offers.filter(isPublishedObservedOffer);
    const quantities = activeOffers
      .map((offer) => offer.availableQuantity)
      .filter(
        (quantity): quantity is number =>
          Number.isSafeInteger(quantity) && quantity >= 0,
      );
    const availableQuantity =
      quantities.length > 0 ? Math.max(...quantities) : 0;
    return {
      inventoryItemExists: true,
      hasActiveOffer: activeOffers.length > 0,
      availableQuantity,
    };
  }

  private async resolveExternalProductId(input: {
    client: EbayListingConnectorClient;
    draft: EbayListingConnectorDraft;
    offerIdsByVariantId: Record<number, string>;
    firstListingId?: string;
    verifiedPublishedListingId?: string;
  }): Promise<string | undefined> {
    if (input.draft.publishMode === "stage") {
      return (
        input.draft.existingExternalProductId ??
        input.firstListingId ??
        firstValue(input.offerIdsByVariantId)
      );
    }

    if (input.draft.itemGroup) {
      await input.client.createOrReplaceInventoryItemGroup(
        input.draft.itemGroup.groupKey,
        input.draft.itemGroup.payload,
      );
      if (input.verifiedPublishedListingId) return input.verifiedPublishedListingId;
      const publishResult = await this.publishGroupWithConsistencyRetry({
        client: input.client,
        groupKey: input.draft.itemGroup.groupKey,
        marketplaceId: input.draft.marketplaceId,
      });
      return (
        publishResult.listingId ??
        input.draft.existingExternalProductId ??
        input.firstListingId
      );
    }

    if (input.verifiedPublishedListingId) return input.verifiedPublishedListingId;
    const offerId = firstValue(input.offerIdsByVariantId);
    if (!offerId) {
      throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_RESPONSE_INVALID", "Cannot publish eBay listing without an offer id. Review the existing provider offers before another publication attempt.");
    }
    const publishResult = await input.client.publishOffer(offerId);
    return (
      publishResult.listingId ??
      input.draft.existingExternalProductId ??
      input.firstListingId
    );
  }

  private async publishGroupWithConsistencyRetry(input: {
    client: EbayListingConnectorClient;
    groupKey: string;
    marketplaceId: string;
  }): Promise<{ listingId?: string }> {
    let attempt = 0;
    for (;;) {
      try {
        return await input.client.publishOfferByInventoryItemGroup(
          input.groupKey,
          input.marketplaceId,
        );
      } catch (error) {
        const delayMs = this.groupPublishRetryDelaysMs[attempt];
        if (
          delayMs === undefined ||
          !isRetryableGroupPublishConsistencyError(error)
        ) {
          throw error;
        }
        attempt += 1;
        await this.delay(delayMs);
      }
    }
  }
}

function validateDraft(draft: EbayListingConnectorDraft): void {
  if (!draft.marketplaceId.trim()) {
    throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED", "eBay marketplace id is required.");
  }
  if (draft.inventoryItems.length === 0) {
    throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED", "At least one eBay inventory item is required.");
  }
  if (draft.offers.length === 0) {
    throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED", "At least one eBay offer is required.");
  }
}

function toWritableGroupPayload(
  group: EbayInventoryItemGroup & { variantSKUs?: string[] },
): Omit<EbayInventoryItemGroup, "inventoryItemGroupKey"> {
  return {
    aspects: Object.fromEntries(
      Object.entries(group.aspects).map(([name, values]) => [
        name,
        [...values],
      ]),
    ),
    description: group.description,
    imageUrls: [...group.imageUrls],
    title: group.title,
    variantSKUs: normalizedSkus(group.variantSKUs),
    variesBy: {
      ...(group.variesBy.aspectsImageVariesBy
        ? { aspectsImageVariesBy: [...group.variesBy.aspectsImageVariesBy] }
        : {}),
      specifications: group.variesBy.specifications.map((specification) => ({
        name: specification.name,
        values: [...specification.values],
      })),
    },
  };
}

function buildGroupWithoutVariation(input: {
  currentGroup: EbayInventoryItemGroup & { variantSKUs?: string[] };
  item: BuiltInventoryItem;
}): Omit<EbayInventoryItemGroup, "inventoryItemGroupKey"> {
  const currentMembers = normalizedSkus(input.currentGroup.variantSKUs);
  const remainingMembers = currentMembers.filter(
    (sku) => sku !== input.item.sku,
  );
  if (remainingMembers.length < 2) {
    throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED",
      `Cannot transition eBay variation ${input.item.sku} because temporarily detaching it would leave fewer than two group members.`,
    );
  }

  const itemAspects = input.item.payload.product.aspects ?? {};
  const specifications = input.currentGroup.variesBy.specifications.map(
    (specification) => {
      const itemValues = normalizedSkus(itemAspects[specification.name]);
      if (itemValues.length !== 1) {
        throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED",
          `Cannot transition eBay variation ${input.item.sku} because it does not define exactly one ${specification.name} value.`,
        );
      }
      const values = specification.values.filter(
        (value) => value !== itemValues[0],
      );
      if (values.length === 0) {
        throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED",
          `Cannot transition eBay variation ${input.item.sku} because removing its ${specification.name} value would empty the group schema.`,
        );
      }
      return { ...specification, values };
    },
  );

  const writableGroup = toWritableGroupPayload(input.currentGroup);
  return {
    ...writableGroup,
    variantSKUs: remainingMembers,
    variesBy: {
      ...writableGroup.variesBy,
      specifications,
    },
  };
}

function alignDraftVariationSchemaToLiveGroup(input: {
  draft: EbayListingConnectorDraft & { itemGroup: BuiltItemGroup };
  liveGroup: EbayInventoryItemGroup & { variantSKUs?: string[] };
}): EbayListingConnectorDraft & { itemGroup: BuiltItemGroup } {
  const desiredSpecifications =
    input.draft.itemGroup.payload.variesBy.specifications;
  const liveSpecifications = input.liveGroup.variesBy.specifications;
  const desiredNames = desiredSpecifications.map(
    (specification) => specification.name,
  );
  const liveNames = liveSpecifications.map(
    (specification) => specification.name,
  );
  if (sameStrings([...desiredNames].sort(), [...liveNames].sort())) {
    return input.draft;
  }
  if (desiredSpecifications.length !== 1 || liveSpecifications.length !== 1) {
    throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED",
      "The live and desired eBay listings use different multi-aspect variation schemas and cannot be aligned automatically.",
    );
  }

  const desiredName = desiredSpecifications[0].name;
  const liveName = liveSpecifications[0].name;
  const alignedValues: string[] = [];
  const inventoryItems = input.draft.inventoryItems.map((item) => {
    const desiredValues = item.payload.product.aspects?.[desiredName];
    if (
      !desiredValues ||
      desiredValues.length !== 1 ||
      !desiredValues[0]?.trim()
    ) {
      throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED",
        `The desired eBay inventory item ${item.sku} does not define exactly one ${desiredName} variation value.`,
      );
    }
    const value = desiredValues[0];
    if (!alignedValues.includes(value)) alignedValues.push(value);
    const aspects = Object.fromEntries(
      Object.entries(item.payload.product.aspects ?? {}).filter(
        ([name]) => name !== desiredName && name !== liveName,
      ),
    );
    return {
      ...item,
      payload: {
        ...item.payload,
        product: {
          ...item.payload.product,
          aspects: { ...aspects, [liveName]: [value] },
        },
      },
    };
  });
  const groupAspects = Object.fromEntries(
    Object.entries(input.draft.itemGroup.payload.aspects).filter(
      ([name]) => name !== desiredName && name !== liveName,
    ),
  );

  return {
    ...input.draft,
    inventoryItems,
    itemGroup: {
      ...input.draft.itemGroup,
      payload: {
        ...input.draft.itemGroup.payload,
        aspects: groupAspects,
        variesBy: {
          ...input.draft.itemGroup.payload.variesBy,
          aspectsImageVariesBy:
            input.draft.itemGroup.payload.variesBy.aspectsImageVariesBy?.map(
              (name) => (name === desiredName ? liveName : name),
            ),
          specifications: [{ name: liveName, values: alignedValues }],
        },
      },
    },
  };
}

function buildRetainedVariationGroupPayload(input: {
  desiredGroup: Omit<EbayInventoryItemGroup, "inventoryItemGroupKey">;
  currentGroup: EbayInventoryItemGroup & { variantSKUs?: string[] };
  retainedSkus: readonly string[];
}): Omit<EbayInventoryItemGroup, "inventoryItemGroupKey"> {
  const desiredSpecifications = input.desiredGroup.variesBy.specifications;
  const currentSpecifications = input.currentGroup.variesBy.specifications;
  const currentByName = new Map(
    currentSpecifications.map((specification) => [
      specification.name,
      specification.values,
    ]),
  );
  const desiredNames = new Set(
    desiredSpecifications.map((specification) => specification.name),
  );
  const currentNames = new Set(
    currentSpecifications.map((specification) => specification.name),
  );
  if (!sameStrings([...desiredNames].sort(), [...currentNames].sort())) {
    throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED",
      "The live and desired eBay listings use different variation aspect names and cannot be updated in place.",
    );
  }

  return {
    ...input.desiredGroup,
    variantSKUs: normalizedSkus([
      ...normalizedSkus(input.desiredGroup.variantSKUs),
      ...normalizedSkus(input.retainedSkus),
    ]),
    variesBy: {
      ...input.desiredGroup.variesBy,
      specifications: desiredSpecifications.map((specification) => ({
        ...specification,
        values: [
          ...new Set([
            ...specification.values,
            ...(currentByName.get(specification.name) ?? []),
          ]),
        ],
      })),
    },
  };
}

function assertBulkQuantityUpdateSucceeded(
  response: EbayBulkPriceQuantityResponse,
  sku: string,
): void {
  const failures = response.responses.filter(
    (result) =>
      result.statusCode < 200 ||
      result.statusCode >= 300 ||
      (result.errors?.length ?? 0) > 0 ||
      (result.offers?.some(
        (offer) =>
          offer.statusCode < 200 ||
          offer.statusCode >= 300 ||
          (offer.errors?.length ?? 0) > 0,
      ) ??
        false),
  );
  if (response.responses.length > 0 && failures.length === 0) return;

  const messages = failures
    .flatMap((result) => [
      ...(result.errors ?? []).map((error) => error.message),
      ...(result.offers ?? []).flatMap((offer) =>
        (offer.errors ?? []).map((error) => error.message),
      ),
    ])
    .filter(Boolean);
  const detail =
    messages.length > 0
      ? messages.join("; ")
      : "eBay returned no successful quantity result";
  throw new EbayListingSyncError("EBAY_QUANTITY_REJECTED",
    `eBay could not set retained variation ${sku} to zero: ${detail}.`,
  );
}

function isInvalidInventoryItemGroupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:errorId["']?\s*:\s*25013|\b25013\b|invalid data in the inventory item group)/i.test(
    message,
  );
}

function isVariationSpecificsMismatchError(error: unknown): boolean {
  if (!isInvalidInventoryItemGroupError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /variation specifics.+does not match/i.test(message);
}

function validateMaintenanceDraft(
  draft: Pick<
    EbayListingConnectorDraft,
    "marketplaceId" | "inventoryItems" | "offers"
  >,
): void {
  if (!draft.marketplaceId.trim()) {
    throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED", "eBay marketplace id is required.");
  }
  if (draft.inventoryItems.length === 0) {
    throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED", "At least one eBay inventory item is required.");
  }
  if (draft.offers.length === 0) {
    throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED", "At least one eBay offer is required.");
  }
}

function firstValue(record: Record<number, string>): string | undefined {
  return Object.values(record)[0];
}

function withOfferId(offer: EbayOffer, offerId: string): EbayOffer {
  return { ...offer, offerId };
}

function listingPoliciesChanged(
  existing: EbayOffer["listingPolicies"] | undefined,
  next: EbayOffer["listingPolicies"],
): boolean {
  return (
    existing?.fulfillmentPolicyId !== next.fulfillmentPolicyId ||
    existing?.returnPolicyId !== next.returnPolicyId ||
    existing?.paymentPolicyId !== next.paymentPolicyId
  );
}

function validateRebuildInput(
  draft: EbayListingConnectorDraft,
  currentExternalListingId: string,
): void {
  validateDraft(draft);
  if (draft.publishMode !== "publish" || !draft.itemGroup) {
    throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED", "Only published eBay variation groups can be rebuilt.");
  }
  if (!currentExternalListingId.trim()) {
    throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED",
      "The current eBay listing id is required for rebuild confirmation.",
    );
  }
}

function validateConfirmedPreview(
  draft: EbayListingConnectorDraft,
  preview: EbayListingRebuildPreview,
): void {
  const currentSkus = normalizedSkus(preview.currentSkus);
  const activeSkus = normalizedSkus(preview.activeSkus);
  const inactiveSkus = normalizedSkus(preview.inactiveSkus);
  const desiredSkus = normalizedSkus(draft.itemGroup?.payload.variantSKUs);
  const current = new Set(currentSkus);
  const active = new Set(activeSkus);
  const inactive = new Set(inactiveSkus);
  const desired = new Set(desiredSkus);
  const expectedAddedSkus = desiredSkus.filter((sku) => !active.has(sku));
  const expectedRemovedSkus = activeSkus.filter((sku) => !desired.has(sku));
  const expectedRebuildRequired =
    expectedRemovedSkus.length > 0 || preview.sourceState === "withdrawn";
  const expectedToken = rebuildConfirmationToken({
    productId: draft.productId,
    groupKey: draft.itemGroup!.groupKey,
    currentExternalListingId: preview.currentExternalListingId.trim(),
    sourceState: preview.sourceState,
    currentSkus,
    activeSkus,
    inactiveSkus,
    desiredSkus,
    addedSkus: expectedAddedSkus,
    removedSkus: expectedRemovedSkus,
  });
  if (
    preview.productId !== draft.productId ||
    preview.groupKey !== draft.itemGroup!.groupKey ||
    (preview.sourceState !== "active" && preview.sourceState !== "withdrawn") ||
    activeSkus.some((sku) => !current.has(sku) || inactive.has(sku)) ||
    inactiveSkus.some((sku) => !current.has(sku)) ||
    currentSkus.some((sku) => !active.has(sku) && !inactive.has(sku)) ||
    !sameStrings(normalizedSkus(preview.desiredSkus), desiredSkus) ||
    !sameStrings(normalizedSkus(preview.addedSkus), expectedAddedSkus) ||
    !sameStrings(normalizedSkus(preview.removedSkus), expectedRemovedSkus) ||
    preview.rebuildRequired !== expectedRebuildRequired ||
    preview.confirmationToken !== expectedToken
  ) {
    throw new EbayListingSyncError("EBAY_LISTING_REVIEW_CHANGED",
      "The eBay listing rebuild confirmation is stale or invalid.",
    );
  }
}

type ListingPublicationInspection =
  | Readonly<{
      state: "active";
      listingId: string;
      offerIdsBySku: ReadonlyMap<string, string>;
    }>
  | Readonly<{ state: "withdrawn" }>;

async function inspectListingPublication(input: {
  client: EbayListingLifecycleClient;
  skus: readonly string[];
  marketplaceId: string;
  expectedListingId?: string;
}): Promise<ListingPublicationInspection> {
  const expectedListingId = input.expectedListingId?.trim();
  const activeListingIds = new Set<string>();
  const offerIdsBySku = new Map<string, string>();
  let activeMemberCount = 0;

  for (const sku of input.skus) {
    const response = await input.client.getOffers(sku, input.marketplaceId);
    const activeOffers = response.offers.filter(isPublishedObservedOffer);
    const identifiableActiveOffers = activeOffers.flatMap((offer) => {
      const listingId = observedOfferListingId(offer);
      return listingId === undefined ? [] : [{ offer, listingId }];
    });
    const matchingOffers = expectedListingId
      ? identifiableActiveOffers.filter(
          ({ listingId }) => listingId === expectedListingId,
        )
      : identifiableActiveOffers;
    const conflictingOffers = expectedListingId
      ? identifiableActiveOffers.filter(
          ({ listingId }) => listingId !== expectedListingId,
        )
      : [];
    if (conflictingOffers.length > 0) {
      throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID",
        `The active eBay variation ${sku} belongs to a different listing.`,
      );
    }
    if (matchingOffers.length > 1) {
      throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID",
        `The eBay variation ${sku} has multiple active offers for the same listing.`,
      );
    }
    const [activeOffer] = matchingOffers;
    if (!activeOffer) {
      // An item group can legitimately retain an unpublished or zero-quantity
      // historical variation. Group membership remains observable even when the
      // variation does not identify the active listing.
      continue;
    }
    activeMemberCount += 1;
    activeListingIds.add(activeOffer.listingId);
    offerIdsBySku.set(sku, activeOffer.offer.offerId);
  }

  if (activeMemberCount > 0 && activeListingIds.size === 1) {
    return {
      state: "active",
      listingId: [...activeListingIds][0],
      offerIdsBySku,
    };
  }
  if (activeMemberCount === 0) {
    return { state: "withdrawn" };
  }
  throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID",
    "The eBay variation group resolves to multiple active listings.",
  );
}
function isPublishedObservedOffer(offer: EbayObservedOffer): boolean {
  return offer.status?.trim().toUpperCase() === "PUBLISHED";
}

function observedOfferListingId(offer: EbayObservedOffer): string | undefined {
  const listingId = offer.listingId ?? offer.listing?.listingId;
  if (typeof listingId !== "string") return undefined;
  const normalized = listingId.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizedSkus(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((sku): sku is string => typeof sku === "string")
        .map((sku) => sku.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function rebuildConfirmationToken(input: {
  productId: number;
  groupKey: string;
  currentExternalListingId: string;
  sourceState: "active" | "withdrawn";
  currentSkus: readonly string[];
  activeSkus: readonly string[];
  inactiveSkus: readonly string[];
  desiredSkus: readonly string[];
  addedSkus: readonly string[];
  removedSkus: readonly string[];
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
function isRetryableGroupPublishConsistencyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:25604|25703|offer\s+not\s+found)/i.test(message);
}
