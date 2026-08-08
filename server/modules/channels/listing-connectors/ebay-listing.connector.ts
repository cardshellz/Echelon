import { createHash } from "node:crypto";
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

export class EbayMarketplaceListingConnector {
  private readonly delay: (ms: number) => Promise<void>;
  private readonly inventoryDelayMs: number;
  private readonly offerDelayMs: number;
  private readonly groupPublishRetryDelaysMs: readonly number[];

  constructor(options: EbayMarketplaceListingConnectorOptions = {}) {
    this.delay = options.delay ?? (() => Promise.resolve());
    this.inventoryDelayMs = options.inventoryDelayMs ?? 0;
    this.offerDelayMs = options.offerDelayMs ?? 0;
    this.groupPublishRetryDelaysMs = options.groupPublishRetryDelaysMs ?? [250, 750, 1_500];
  }

  async pushListing(input: {
    client: EbayListingConnectorClient;
    draft: EbayListingConnectorDraft;
  }): Promise<EbayListingConnectorResult> {
    validateDraft(input.draft);

    const resolvedOffers: ResolvedPushOffer[] = [];
    const offerIdsByVariantId: Record<number, string> = {};
    let firstListingId: string | undefined;

    for (const offer of input.draft.offers) {
      let existingOfferId = input.draft.existingOfferIdsByVariantId?.[offer.variantId] ?? null;
      if (!existingOfferId) {
        const existingOffers = await input.client.getOffers(offer.sku, input.draft.marketplaceId);
        const existingOffer = existingOffers.offers[0];
        existingOfferId = existingOffer?.offerId ?? null;
        const existingListingId = existingOffer === undefined
          ? undefined
          : observedOfferListingId(existingOffer);
        if (existingListingId && !firstListingId) {
          firstListingId = existingListingId;
        }
      }

      resolvedOffers.push({ offer, existingOfferId });
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
        await input.client.updateOffer(offerId, withOfferId(offer.payload, offerId));
      }
      offerIdsByVariantId[offer.variantId] = offerId;
      await this.delay(this.offerDelayMs);
    }

    const externalProductId = await this.resolveExternalProductId({
      client: input.client,
      draft: input.draft,
      offerIdsByVariantId,
      firstListingId,
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
    const remoteGroup = await input.client.getInventoryItemGroup(itemGroup.groupKey);
    if (!remoteGroup) {
      throw new Error("The current eBay variation group could not be found.");
    }

    const currentSkus = normalizedSkus(remoteGroup.variantSKUs);
    const desiredSkus = normalizedSkus(itemGroup.payload.variantSKUs);
    if (currentSkus.length === 0 || desiredSkus.length === 0) {
      throw new Error("Current and desired eBay variation groups must contain at least one SKU.");
    }
    const currentPublication = await inspectListingPublication({
      client: input.client,
      skus: currentSkus,
      marketplaceId: input.draft.marketplaceId,
      expectedListingId: input.currentExternalListingId,
    });
    const activeSkus = currentPublication.state === "active"
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
      rebuildRequired: previewWithoutToken.removedSkus.length > 0 || previewWithoutToken.sourceState === "withdrawn",
      confirmationToken: rebuildConfirmationToken(previewWithoutToken),
    };
  }

  async executeListingRebuild(input: {
    client: EbayListingLifecycleClient;
    draft: EbayListingConnectorDraft;
    preview: EbayListingRebuildPreview;
  }): Promise<EbayListingRebuildResult> {
    validateRebuildInput(input.draft, input.preview.currentExternalListingId);
    validateConfirmedPreview(input.draft, input.preview);
    if (!input.preview.rebuildRequired) {
      throw new Error("The confirmed eBay listing does not require a rebuild.");
    }

    const itemGroup = input.draft.itemGroup!;
    const remoteGroup = await input.client.getInventoryItemGroup(itemGroup.groupKey);
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
          if (targetPublication.listingId === input.preview.currentExternalListingId) {
            throw new Error("eBay still associates the desired variation group with the old listing identity.");
          }
          const externalOfferIds: Record<number, string> = {};
          for (const offer of input.draft.offers) {
            const offerId = targetPublication.offerIdsBySku.get(offer.sku);
            if (!offerId) {
              throw new Error(`The published replacement is missing an offer for ${offer.sku}.`);
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
        throw new Error("The eBay variation group changed after rebuild confirmation. Preview it again.");
      }
    }

    const result = await this.pushListing({
      client: input.client,
      draft: {
        ...input.draft,
        publishMode: "publish",
        hasExistingExternalIds: false,
        existingExternalProductId: null,
      },
    });
    if (!result.externalProductId || result.externalProductId === input.preview.currentExternalListingId) {
      throw new Error("eBay did not return a new listing identity after rebuilding the listing.");
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
  }): Promise<EbayListingConnectorResult & { removedSkus: string[] }> {
    validateRebuildInput(input.draft, input.preview.currentExternalListingId);

    const currentPreview = await this.previewListingRebuild({
      client: input.client,
      draft: input.draft,
      currentExternalListingId: input.preview.currentExternalListingId,
    });
    if (currentPreview.confirmationToken !== input.preview.confirmationToken) {
      throw new Error("The live eBay listing changed after review. Read eBay again before updating it.");
    }
    if (currentPreview.sourceState !== "active") {
      throw new Error("The current eBay listing is no longer active and cannot be updated in place.");
    }

    const liveGroup = await input.client.getInventoryItemGroup(currentPreview.groupKey);
    if (!liveGroup) {
      throw new Error("The current eBay variation group could not be found after review.");
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
      removedSkus: currentPreview.removedSkus,
    });
    if (result.externalProductId !== currentPreview.currentExternalListingId) {
      throw new Error("eBay did not preserve the reviewed listing id during the in-place update.");
    }
    return { ...result, removedSkus: [...currentPreview.removedSkus] };
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
    removedSkus: readonly string[];
  }): Promise<EbayListingConnectorResult> {
    const resolvedOffers = await this.resolvePushOffers(input.client, input.draft);
    const offerIdsByVariantId: Record<number, string> = {};

    for (const item of input.draft.inventoryItems) {
      await input.client.createOrReplaceInventoryItem(item.sku, item.payload);
      await this.delay(this.inventoryDelayMs);
    }

    let retainedRemovedSkus: string[] = [];
    try {
      await input.client.createOrReplaceInventoryItemGroup(
        input.draft.itemGroup.groupKey,
        input.draft.itemGroup.payload,
      );
    } catch (error) {
      if (input.removedSkus.length === 0 || !isInvalidInventoryItemGroupError(error)) {
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
    }

    for (const { offer, existingOfferId } of resolvedOffers) {
      const offerId = existingOfferId
        ? existingOfferId
        : await input.client.createOffer(offer.payload);
      if (existingOfferId || input.draft.updateOfferAfterCreate) {
        await input.client.updateOffer(offerId, withOfferId(offer.payload, offerId));
      }
      offerIdsByVariantId[offer.variantId] = offerId;
      await this.delay(this.offerDelayMs);
    }

    for (const sku of retainedRemovedSkus) {
      await this.disableRetainedVariation(input.client, sku, input.draft.marketplaceId);
    }

    const publishResult = await this.publishGroupWithConsistencyRetry({
      client: input.client,
      groupKey: input.draft.itemGroup.groupKey,
      marketplaceId: input.draft.marketplaceId,
    });
    return {
      productId: input.draft.productId,
      status: "updated",
      externalProductId: publishResult.listingId ?? input.draft.existingExternalProductId ?? undefined,
      externalVariantIds: offerIdsByVariantId,
      externalOfferIds: offerIdsByVariantId,
      published: true,
    };
  }

  private async resolvePushOffers(
    client: EbayListingConnectorClient,
    draft: EbayListingConnectorDraft,
  ): Promise<ResolvedPushOffer[]> {
    const resolved: ResolvedPushOffer[] = [];
    const expectedListingId = draft.existingExternalProductId?.trim();
    for (const offer of draft.offers) {
      let existingOfferId = draft.existingOfferIdsByVariantId?.[offer.variantId] ?? null;
      if (!existingOfferId) {
        const response = await client.getOffers(offer.sku, draft.marketplaceId);
        const conflictingPublishedOffer = response.offers.find((candidate) => {
          const listingId = observedOfferListingId(candidate);
          return isPublishedObservedOffer(candidate)
            && listingId !== undefined
            && listingId !== expectedListingId;
        });
        if (conflictingPublishedOffer) {
          throw new Error(`The eBay variation ${offer.sku} belongs to a different active listing.`);
        }

        const candidates = response.offers.filter((candidate) => {
          const listingId = observedOfferListingId(candidate);
          return listingId === expectedListingId || !isPublishedObservedOffer(candidate);
        });
        if (candidates.length > 1) {
          throw new Error(`The eBay variation ${offer.sku} has multiple offers that could be updated.`);
        }
        existingOfferId = candidates[0]?.offerId ?? null;
      }
      resolved.push({ offer, existingOfferId });
    }
    return resolved;
  }

  private async disableRetainedVariation(
    client: EbayListingLifecycleClient,
    sku: string,
    marketplaceId: string,
  ): Promise<void> {
    const inventoryItem = await client.getInventoryItem(sku);
    if (!inventoryItem) {
      throw new Error(`Cannot retain removed eBay variation ${sku} because its inventory item was not found.`);
    }
    const response = await client.getOffers(sku, marketplaceId);
    const inventoryQuantity = inventoryItem.availability.shipToLocationAvailability.quantity;
    const offersAlreadyZero = response.offers.every((offer) => offer.availableQuantity === 0);
    if (inventoryQuantity === 0 && offersAlreadyZero) return;

    const result = await client.bulkUpdatePriceQuantity({
      requests: [{
        sku,
        shipToLocationAvailability: { quantity: 0 },
        offers: response.offers.map((offer) => ({
          offerId: offer.offerId,
          availableQuantity: 0,
        })),
      }],
    });
    assertBulkQuantityUpdateSucceeded(result, sku);
  }

  async syncExistingListing(input: {
    client: EbayListingConnectorClient;
    draft: Pick<EbayListingConnectorDraft, "productId" | "marketplaceId" | "inventoryItems" | "offers" | "itemGroup">;
  }): Promise<EbayExistingListingSyncResult> {
    validateMaintenanceDraft(input.draft);

    const updatedInventorySkus: string[] = [];
    const updatedOfferIds: Record<number, string> = {};
    const missingOfferVariantIds: number[] = [];
    const policyChangedVariantIds: number[] = [];
    let itemGroupUpdated = false;

    for (const offer of input.draft.offers) {
      const existingOffers = await input.client.getOffers(offer.sku, input.draft.marketplaceId);
      const existingOffer = existingOffers.offers[0];
      if (!existingOffer?.offerId) {
        missingOfferVariantIds.push(offer.variantId);
        continue;
      }

      if (listingPoliciesChanged(existingOffer.listingPolicies, offer.payload.listingPolicies)) {
        policyChangedVariantIds.push(offer.variantId);
      }
      await input.client.updateOffer(
        existingOffer.offerId,
        withOfferId(offer.payload, existingOffer.offerId),
      );
      updatedOfferIds[offer.variantId] = existingOffer.offerId;
      await this.delay(this.offerDelayMs);
    }

    for (const item of input.draft.inventoryItems) {
      await input.client.createOrReplaceInventoryItem(item.sku, item.payload);
      updatedInventorySkus.push(item.sku);
      await this.delay(this.inventoryDelayMs);
    }

    // eBay requires the inventory item and offer for a newly-added variation
    // to exist before that SKU is added to an active inventory item group.
    // Do not replace group membership when any sellable offer is missing;
    // doing so can partially rewrite an active multi-variation listing.
    if (input.draft.itemGroup && missingOfferVariantIds.length === 0) {
      await input.client.createOrReplaceInventoryItemGroup(
        input.draft.itemGroup.groupKey,
        input.draft.itemGroup.payload,
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
      return { inventoryItemExists: false, hasActiveOffer: false, availableQuantity: null };
    }

    const offers = await input.client.getOffers(input.sku, input.marketplaceId);
    const activeOffers = offers.offers.filter(isPublishedObservedOffer);
    const quantities = activeOffers
      .map((offer) => offer.availableQuantity)
      .filter((quantity): quantity is number => Number.isSafeInteger(quantity) && quantity >= 0);
    const availableQuantity = quantities.length > 0 ? Math.max(...quantities) : 0;
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
  }): Promise<string | undefined> {
    if (input.draft.publishMode === "stage") {
      return input.draft.existingExternalProductId
        ?? input.firstListingId
        ?? firstValue(input.offerIdsByVariantId);
    }

    if (input.draft.itemGroup) {
      await input.client.createOrReplaceInventoryItemGroup(
        input.draft.itemGroup.groupKey,
        input.draft.itemGroup.payload,
      );
      const publishResult = await this.publishGroupWithConsistencyRetry({
        client: input.client,
        groupKey: input.draft.itemGroup.groupKey,
        marketplaceId: input.draft.marketplaceId,
      });
      return publishResult.listingId ?? input.draft.existingExternalProductId ?? input.firstListingId;
    }

    const offerId = firstValue(input.offerIdsByVariantId);
    if (!offerId) {
      throw new Error("Cannot publish eBay listing without an offer id.");
    }
    const publishResult = await input.client.publishOffer(offerId);
    return publishResult.listingId ?? input.draft.existingExternalProductId ?? input.firstListingId;
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
        if (delayMs === undefined || !isRetryableGroupPublishConsistencyError(error)) {
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
    throw new Error("eBay marketplace id is required.");
  }
  if (draft.inventoryItems.length === 0) {
    throw new Error("At least one eBay inventory item is required.");
  }
  if (draft.offers.length === 0) {
    throw new Error("At least one eBay offer is required.");
  }
}

function alignDraftVariationSchemaToLiveGroup(input: {
  draft: EbayListingConnectorDraft & { itemGroup: BuiltItemGroup };
  liveGroup: EbayInventoryItemGroup & { variantSKUs?: string[] };
}): EbayListingConnectorDraft & { itemGroup: BuiltItemGroup } {
  const desiredSpecifications = input.draft.itemGroup.payload.variesBy.specifications;
  const liveSpecifications = input.liveGroup.variesBy.specifications;
  const desiredNames = desiredSpecifications.map((specification) => specification.name);
  const liveNames = liveSpecifications.map((specification) => specification.name);
  if (sameStrings([...desiredNames].sort(), [...liveNames].sort())) {
    return input.draft;
  }
  if (desiredSpecifications.length !== 1 || liveSpecifications.length !== 1) {
    throw new Error(
      "The live and desired eBay listings use different multi-aspect variation schemas and cannot be aligned automatically.",
    );
  }

  const desiredName = desiredSpecifications[0].name;
  const liveName = liveSpecifications[0].name;
  const alignedValues: string[] = [];
  const inventoryItems = input.draft.inventoryItems.map((item) => {
    const desiredValues = item.payload.product.aspects?.[desiredName];
    if (!desiredValues || desiredValues.length !== 1 || !desiredValues[0]?.trim()) {
      throw new Error(
        `The desired eBay inventory item ${item.sku} does not define exactly one ${desiredName} variation value.`,
      );
    }
    const value = desiredValues[0];
    if (!alignedValues.includes(value)) alignedValues.push(value);
    const aspects = Object.fromEntries(
      Object.entries(item.payload.product.aspects ?? {})
        .filter(([name]) => name !== desiredName && name !== liveName),
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
    Object.entries(input.draft.itemGroup.payload.aspects)
      .filter(([name]) => name !== desiredName && name !== liveName),
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
          aspectsImageVariesBy: input.draft.itemGroup.payload.variesBy.aspectsImageVariesBy
            ?.map((name) => name === desiredName ? liveName : name),
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
    currentSpecifications.map((specification) => [specification.name, specification.values]),
  );
  const desiredNames = new Set(desiredSpecifications.map((specification) => specification.name));
  const currentNames = new Set(currentSpecifications.map((specification) => specification.name));
  if (!sameStrings([...desiredNames].sort(), [...currentNames].sort())) {
    throw new Error(
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
        values: [...new Set([
          ...specification.values,
          ...(currentByName.get(specification.name) ?? []),
        ])],
      })),
    },
  };
}

function assertBulkQuantityUpdateSucceeded(
  response: EbayBulkPriceQuantityResponse,
  sku: string,
): void {
  const failures = response.responses.filter((result) =>
    result.statusCode < 200
    || result.statusCode >= 300
    || (result.errors?.length ?? 0) > 0
    || (result.offers?.some((offer) =>
      offer.statusCode < 200
      || offer.statusCode >= 300
      || (offer.errors?.length ?? 0) > 0
    ) ?? false),
  );
  if (response.responses.length > 0 && failures.length === 0) return;

  const messages = failures.flatMap((result) => [
    ...(result.errors ?? []).map((error) => error.message),
    ...(result.offers ?? []).flatMap((offer) =>
      (offer.errors ?? []).map((error) => error.message),
    ),
  ]).filter(Boolean);
  const detail = messages.length > 0
    ? messages.join("; ")
    : "eBay returned no successful quantity result";
  throw new Error(`eBay could not set retained variation ${sku} to zero: ${detail}.`);
}

function isInvalidInventoryItemGroupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:errorId["']?\s*:\s*25013|\b25013\b|invalid data in the inventory item group)/i.test(message);
}

function validateMaintenanceDraft(
  draft: Pick<EbayListingConnectorDraft, "marketplaceId" | "inventoryItems" | "offers">,
): void {
  if (!draft.marketplaceId.trim()) {
    throw new Error("eBay marketplace id is required.");
  }
  if (draft.inventoryItems.length === 0) {
    throw new Error("At least one eBay inventory item is required.");
  }
  if (draft.offers.length === 0) {
    throw new Error("At least one eBay offer is required.");
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
  return existing?.fulfillmentPolicyId !== next.fulfillmentPolicyId
    || existing?.returnPolicyId !== next.returnPolicyId
    || existing?.paymentPolicyId !== next.paymentPolicyId;
}

function validateRebuildInput(
  draft: EbayListingConnectorDraft,
  currentExternalListingId: string,
): void {
  validateDraft(draft);
  if (draft.publishMode !== "publish" || !draft.itemGroup) {
    throw new Error("Only published eBay variation groups can be rebuilt.");
  }
  if (!currentExternalListingId.trim()) {
    throw new Error("The current eBay listing id is required for rebuild confirmation.");
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
  const expectedRebuildRequired = expectedRemovedSkus.length > 0 || preview.sourceState === "withdrawn";
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
    preview.productId !== draft.productId
    || preview.groupKey !== draft.itemGroup!.groupKey
    || (preview.sourceState !== "active" && preview.sourceState !== "withdrawn")
    || activeSkus.some((sku) => !current.has(sku) || inactive.has(sku))
    || inactiveSkus.some((sku) => !current.has(sku))
    || currentSkus.some((sku) => !active.has(sku) && !inactive.has(sku))
    || !sameStrings(normalizedSkus(preview.desiredSkus), desiredSkus)
    || !sameStrings(normalizedSkus(preview.addedSkus), expectedAddedSkus)
    || !sameStrings(normalizedSkus(preview.removedSkus), expectedRemovedSkus)
    || preview.rebuildRequired !== expectedRebuildRequired
    || preview.confirmationToken !== expectedToken
  ) {
    throw new Error("The eBay listing rebuild confirmation is stale or invalid.");
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
      ? identifiableActiveOffers.filter(({ listingId }) => listingId === expectedListingId)
      : identifiableActiveOffers;
    const conflictingOffers = expectedListingId
      ? identifiableActiveOffers.filter(({ listingId }) => listingId !== expectedListingId)
      : [];
    if (conflictingOffers.length > 0) {
      throw new Error(`The active eBay variation ${sku} belongs to a different listing.`);
    }
    if (matchingOffers.length > 1) {
      throw new Error(`The eBay variation ${sku} has multiple active offers for the same listing.`);
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
  throw new Error("The eBay variation group resolves to multiple active listings.");
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
  return [...new Set(value
    .filter((sku): sku is string => typeof sku === "string")
    .map((sku) => sku.trim())
    .filter(Boolean))]
    .sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
