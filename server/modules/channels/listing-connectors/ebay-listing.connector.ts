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
}

interface EbayMarketplaceListingConnectorOptions {
  delay?: (ms: number) => Promise<void>;
  inventoryDelayMs?: number;
  offerDelayMs?: number;
}

export class EbayMarketplaceListingConnector {
  private readonly delay: (ms: number) => Promise<void>;
  private readonly inventoryDelayMs: number;
  private readonly offerDelayMs: number;

  constructor(options: EbayMarketplaceListingConnectorOptions = {}) {
    this.delay = options.delay ?? (() => Promise.resolve());
    this.inventoryDelayMs = options.inventoryDelayMs ?? 0;
    this.offerDelayMs = options.offerDelayMs ?? 0;
  }

  async pushListing(input: {
    client: EbayListingConnectorClient;
    draft: EbayListingConnectorDraft;
  }): Promise<EbayListingConnectorResult> {
    validateDraft(input.draft);

    for (const item of input.draft.inventoryItems) {
      await input.client.createOrReplaceInventoryItem(item.sku, item.payload);
      await this.delay(this.inventoryDelayMs);
    }

    const offerIdsByVariantId: Record<number, string> = {};
    let firstListingId: string | undefined;

    for (const offer of input.draft.offers) {
      let offerId = input.draft.existingOfferIdsByVariantId?.[offer.variantId] ?? null;
      if (!offerId) {
        const existingOffers = await input.client.getOffers(offer.sku, input.draft.marketplaceId);
        const existingOffer = existingOffers.offers[0];
        offerId = existingOffer?.offerId ?? null;
        if (existingOffer?.listingId && !firstListingId) {
          firstListingId = existingOffer.listingId;
        }
      }

      if (offerId) {
        offer.payload.offerId = offerId;
        await input.client.updateOffer(offerId, offer.payload);
      } else {
        offerId = await input.client.createOffer(offer.payload);
        if (input.draft.updateOfferAfterCreate) {
          offer.payload.offerId = offerId;
          await input.client.updateOffer(offerId, offer.payload);
        }
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

    if (input.draft.itemGroup) {
      await input.client.createOrReplaceInventoryItemGroup(
        input.draft.itemGroup.groupKey,
        input.draft.itemGroup.payload,
      );
      itemGroupUpdated = true;
    }

    for (const item of input.draft.inventoryItems) {
      await input.client.createOrReplaceInventoryItem(item.sku, item.payload);
      updatedInventorySkus.push(item.sku);
      await this.delay(this.inventoryDelayMs);
    }

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
      offer.payload.offerId = existingOffer.offerId;
      await input.client.updateOffer(existingOffer.offerId, offer.payload);
      updatedOfferIds[offer.variantId] = existingOffer.offerId;
      await this.delay(this.offerDelayMs);
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
      return { inventoryItemExists: false, hasActiveOffer: false };
    }

    const offers = await input.client.getOffers(input.sku, input.marketplaceId);
    const hasActiveOffer = offers.offers.some((offer) => {
      const status = (offer as EbayOffer & { status?: string }).status;
      return status === "PUBLISHED" || status === "ACTIVE";
    });
    return { inventoryItemExists: true, hasActiveOffer };
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
      const publishResult = await input.client.publishOfferByInventoryItemGroup(
        input.draft.itemGroup.groupKey,
        input.draft.marketplaceId,
      );
      return publishResult.listingId ?? input.draft.existingExternalProductId ?? input.firstListingId;
    }

    const offerId = firstValue(input.offerIdsByVariantId);
    if (!offerId) {
      throw new Error("Cannot publish eBay listing without an offer id.");
    }
    const publishResult = await input.client.publishOffer(offerId);
    return publishResult.listingId ?? input.draft.existingExternalProductId ?? input.firstListingId;
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

function listingPoliciesChanged(
  existing: EbayOffer["listingPolicies"] | undefined,
  next: EbayOffer["listingPolicies"],
): boolean {
  return existing?.fulfillmentPolicyId !== next.fulfillmentPolicyId
    || existing?.returnPolicyId !== next.returnPolicyId
    || existing?.paymentPolicyId !== next.paymentPolicyId;
}
