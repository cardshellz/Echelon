import { createHash } from "node:crypto";
import type {
  BuiltInventoryItem,
  BuiltItemGroup,
  BuiltOffer,
} from "../adapters/ebay/ebay-listing-builder";
import type {
  EbayInventoryItem,
  EbayInventoryItemGroup,
  EbayOffer,
} from "../adapters/ebay/ebay-types";

export type EbayListingPublishMode = "stage" | "publish";

export interface EbayListingConnectorClient {
  getInventoryItem(sku: string): Promise<EbayInventoryItem | null>;
  createOrReplaceInventoryItem(
    sku: string,
    item: Omit<EbayInventoryItem, "sku">,
  ): Promise<void>;
  getOffers(
    sku: string,
    marketplaceId: string,
  ): Promise<{ offers: Array<EbayOffer & { offerId: string; listingId?: string }> }>;
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
        if (existingOffer?.listingId && !firstListingId) {
          firstListingId = existingOffer.listingId;
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
    const current = new Set(currentSkus);
    const desired = new Set(desiredSkus);
    const previewWithoutToken = {
      productId: input.draft.productId,
      groupKey: itemGroup.groupKey,
      currentExternalListingId: input.currentExternalListingId.trim(),
      sourceState: currentPublication.state,
      currentSkus,
      desiredSkus,
      addedSkus: desiredSkus.filter((sku) => !current.has(sku)),
      removedSkus: currentSkus.filter((sku) => !desired.has(sku)),
    };
    return {
      ...previewWithoutToken,
      rebuildRequired: previewWithoutToken.removedSkus.length > 0,
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
    if (!input.preview.rebuildRequired || input.preview.removedSkus.length === 0) {
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
    const activeOffers = offers.offers.filter((offer) => {
      const status = (offer as EbayOffer & { status?: string }).status;
      return status === "PUBLISHED" || status === "ACTIVE";
    });
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
  const desiredSkus = normalizedSkus(draft.itemGroup?.payload.variantSKUs);
  const current = new Set(currentSkus);
  const desired = new Set(desiredSkus);
  const expectedAddedSkus = desiredSkus.filter((sku) => !current.has(sku));
  const expectedRemovedSkus = currentSkus.filter((sku) => !desired.has(sku));
  const expectedRebuildRequired = expectedRemovedSkus.length > 0;
  const expectedToken = rebuildConfirmationToken({
    productId: draft.productId,
    groupKey: draft.itemGroup!.groupKey,
    currentExternalListingId: preview.currentExternalListingId.trim(),
    sourceState: preview.sourceState,
    currentSkus,
    desiredSkus,
    addedSkus: expectedAddedSkus,
    removedSkus: expectedRemovedSkus,
  });
  if (
    preview.productId !== draft.productId
    || preview.groupKey !== draft.itemGroup!.groupKey
    || (preview.sourceState !== "active" && preview.sourceState !== "withdrawn")
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
  const activeListingIds = new Set<string>();
  const offerIdsBySku = new Map<string, string>();
  let activeMemberCount = 0;
  let withdrawnMemberCount = 0;

  for (const sku of input.skus) {
    const response = await input.client.getOffers(sku, input.marketplaceId);
    const activeOffers = response.offers.filter((offer) => {
      const status = String((offer as EbayOffer & { status?: string }).status ?? "").toUpperCase();
      return status === "PUBLISHED" || status === "ACTIVE";
    });
    if (activeOffers.length === 0) {
      withdrawnMemberCount += 1;
      continue;
    }
    const [activeOffer] = activeOffers;
    if (activeOffers.length !== 1 || !activeOffer?.listingId) {
      throw new Error(`The eBay variation ${sku} does not have exactly one identifiable active offer.`);
    }
    if (input.expectedListingId && activeOffer.listingId !== input.expectedListingId.trim()) {
      throw new Error("The active eBay listing identity changed. Preview the rebuild again.");
    }
    activeMemberCount += 1;
    activeListingIds.add(activeOffer.listingId);
    offerIdsBySku.set(sku, activeOffer.offerId);
  }

  if (activeMemberCount === input.skus.length && activeListingIds.size === 1) {
    return {
      state: "active",
      listingId: [...activeListingIds][0],
      offerIdsBySku,
    };
  }
  if (withdrawnMemberCount === input.skus.length) {
    return { state: "withdrawn" };
  }
  throw new Error("The eBay variation group is only partially published. Resolve its remote state before rebuilding.");
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
