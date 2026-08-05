import type {
  ListingReplacementExecutionContext,
  ListingReplacementExecutionMember,
  ListingReplacementStepSuccess,
  MarketplaceListingReplacementProvider,
} from "../../../application/execution-ports";
import type { ListingOwnerRef } from "../../../domain/listing-replacement-plan";
import { MarketplaceListingReplacementError } from "../../../domain/errors";

export interface EbayReplacementItemGroup {
  readonly variantSKUs?: readonly string[];
  readonly [key: string]: unknown;
}

export interface EbayReplacementOffer extends Record<string, unknown> {
  readonly offerId: string;
  readonly sku?: string;
  readonly listingId?: string;
  readonly status?: string;
}

export interface EbayListingReplacementClient {
  getInventoryItemGroup(
    groupKey: string,
  ): Promise<EbayReplacementItemGroup | null>;
  createOrReplaceInventoryItemGroup(
    groupKey: string,
    group: EbayReplacementItemGroup,
  ): Promise<void>;
  getOffers(
    sku: string,
    marketplaceId: string,
  ): Promise<readonly EbayReplacementOffer[]>;
  createOffer(offer: Readonly<Record<string, unknown>>): Promise<string>;
  publishOffer(offerId: string): Promise<{ readonly listingId?: string }>;
  publishOfferByInventoryItemGroup(
    groupKey: string,
    marketplaceId: string,
  ): Promise<{ readonly listingId?: string }>;
  withdrawOffer(offerId: string): Promise<void>;
  withdrawOfferByInventoryItemGroup(
    groupKey: string,
    marketplaceId: string,
  ): Promise<void>;
}

export interface EbayListingReplacementClientResolver {
  forOwner(owner: ListingOwnerRef): Promise<EbayListingReplacementClient>;
}

const ACTIVE_OFFER_STATUSES = new Set(["ACTIVE", "PUBLISHED"]);

export class EbayMarketplaceListingReplacementProvider implements MarketplaceListingReplacementProvider {
  constructor(private readonly clients: EbayListingReplacementClientResolver) {}

  async preflight(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess> {
    validateContext(context, idempotencyKey);
    const client = await this.clients.forOwner(context.owner);
    const members = included(context.targetMembers);
    const sourceKey = context.sourcePublication.providerPublicationKey;
    if (sourceKey) {
      const group = await requireGroup(client, sourceKey, "source");
      assertGroupContains(group, members, false);
    }
    await requireListingState({
      client,
      members: sourceKey ? members : included(context.sourceMembers),
      marketplaceId: context.owner.marketplaceId,
      expectedListingId: context.sourcePublication.externalListingId,
      expectedActive: true,
      label: "source",
    });
    return {
      evidence: {
        sourceListingId: context.sourcePublication.externalListingId,
        sourcePublicationKey: sourceKey,
        targetPublicationKey: targetGroupKey(context),
        includedSkus: members.map((member) => member.skuSnapshot),
      },
    };
  }

  async quiesceSource(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess> {
    validateContext(context, idempotencyKey);
    const client = await this.clients.forOwner(context.owner);
    const sourceKey = context.sourcePublication.providerPublicationKey;
    const sourceMembers = sourceKey
      ? included(context.targetMembers)
      : included(context.sourceMembers);
    const state = await inspectListingState(
      client,
      sourceMembers,
      context.owner.marketplaceId,
      context.sourcePublication.externalListingId,
    );
    if (state.activeOfferIds.length > 0) {
      if (sourceKey) {
        await client.withdrawOfferByInventoryItemGroup(
          sourceKey,
          context.owner.marketplaceId,
        );
      } else {
        for (const offerId of state.activeOfferIds) {
          await client.withdrawOffer(offerId);
        }
      }
    }
    return {
      evidence: {
        sourceQuiesced: true,
        alreadyQuiesced: state.activeOfferIds.length === 0,
        withdrawnOfferIds: state.activeOfferIds,
      },
    };
  }

  async createTarget(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess> {
    validateContext(context, idempotencyKey);
    const client = await this.clients.forOwner(context.owner);
    const members = included(context.targetMembers);
    const sourceKey = context.sourcePublication.providerPublicationKey;
    if (sourceKey) {
      const targetKey = targetGroupKey(context);
      const existing = await client.getInventoryItemGroup(targetKey);
      if (existing) {
        assertGroupContains(existing, members, true);
        const existingState = await inspectAnyActiveListing(
          client,
          members,
          context.owner.marketplaceId,
        );
        if (existingState.listingId) {
          return publicationResult(
            targetKey,
            existingState.listingId,
            members,
            existingState.offers,
            true,
          );
        }
      }
      const source = await requireGroup(client, sourceKey, "source");
      assertGroupContains(source, members, false);
      await client.createOrReplaceInventoryItemGroup(targetKey, {
        ...source,
        variantSKUs: members.map((member) => member.skuSnapshot),
      });
      const published = await client.publishOfferByInventoryItemGroup(
        targetKey,
        context.owner.marketplaceId,
      );
      const state = await inspectAnyActiveListing(
        client,
        members,
        context.owner.marketplaceId,
      );
      const listingId = normalizedText(published.listingId) ?? state.listingId;
      if (!listingId)
        throw providerError(
          "TARGET_LISTING_ID_MISSING",
          "eBay did not return or expose the target listing ID.",
        );
      return publicationResult(
        targetKey,
        listingId,
        members,
        state.offers,
        false,
      );
    }

    if (members.length !== 1) {
      throw providerError(
        "SINGLE_LISTING_MEMBER_INVALID",
        "A replacement without an eBay inventory group must contain exactly one included variant.",
      );
    }
    const sourceMember = requireSingleSourceMember(context.sourceMembers);
    const sourceOffer = await requireOfferById(
      client,
      sourceMember,
      context.owner.marketplaceId,
    );
    const offerId = await client.createOffer(cloneOfferForCreate(sourceOffer));
    const published = await client.publishOffer(offerId);
    const listingId = normalizedText(published.listingId);
    if (!listingId)
      throw providerError(
        "TARGET_LISTING_ID_MISSING",
        "eBay did not return the target listing ID.",
      );
    return publicationResult(
      null,
      listingId,
      members,
      [{ ...sourceOffer, offerId, listingId }],
      false,
    );
  }

  async verifyTarget(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess> {
    validateContext(context, idempotencyKey);
    const listingId = normalizedText(context.targetExternalListingId);
    if (!listingId)
      throw providerError(
        "TARGET_IDENTITY_MISSING",
        "The staged target listing ID is missing.",
      );
    const client = await this.clients.forOwner(context.owner);
    const members = included(context.targetMembers);
    if (context.targetProviderPublicationKey) {
      const group = await requireGroup(
        client,
        context.targetProviderPublicationKey,
        "target",
      );
      assertGroupContains(group, members, true);
    }
    const state = await requireListingState({
      client,
      members,
      marketplaceId: context.owner.marketplaceId,
      expectedListingId: listingId,
      expectedActive: true,
      label: "target",
    });
    return publicationResult(
      context.targetProviderPublicationKey,
      listingId,
      members,
      state.offers,
      true,
    );
  }

  async ensureTargetNotSellable(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess> {
    validateContext(context, idempotencyKey);
    const client = await this.clients.forOwner(context.owner);
    const members = included(context.targetMembers);
    const listingId = normalizedText(context.targetExternalListingId);
    const state = listingId
      ? await inspectListingState(
          client,
          members,
          context.owner.marketplaceId,
          listingId,
        )
      : { activeOfferIds: [], offers: [] };
    if (state.activeOfferIds.length > 0) {
      const targetKey =
        context.targetProviderPublicationKey ?? targetGroupKey(context);
      if (context.sourcePublication.providerPublicationKey) {
        await client.withdrawOfferByInventoryItemGroup(
          targetKey,
          context.owner.marketplaceId,
        );
      } else {
        for (const offerId of state.activeOfferIds)
          await client.withdrawOffer(offerId);
      }
    }
    return {
      evidence: {
        targetNotSellable: true,
        alreadyNotSellable: state.activeOfferIds.length === 0,
        withdrawnOfferIds: state.activeOfferIds,
      },
    };
  }

  async ensureSourceLive(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess> {
    validateContext(context, idempotencyKey);
    const client = await this.clients.forOwner(context.owner);
    const sourceKey = context.sourcePublication.providerPublicationKey;
    const members = sourceKey
      ? included(context.targetMembers)
      : included(context.sourceMembers);
    const state = await inspectListingState(
      client,
      members,
      context.owner.marketplaceId,
      context.sourcePublication.externalListingId,
    );
    if (state.activeOfferIds.length === 0) {
      const restored = sourceKey
        ? await client.publishOfferByInventoryItemGroup(
            sourceKey,
            context.owner.marketplaceId,
          )
        : await client.publishOffer(
            requireSingleSourceOfferId(context.sourceMembers),
          );
      const restoredListingId = normalizedText(restored.listingId);
      if (
        restoredListingId &&
        restoredListingId !== context.sourcePublication.externalListingId
      ) {
        throw providerError(
          "SOURCE_IDENTITY_CHANGED",
          "eBay restored the source under a different listing ID; manual recovery is required.",
          {
            expectedListingId: context.sourcePublication.externalListingId,
            restoredListingId,
          },
        );
      }
    }
    return {
      evidence: {
        sourceLive: true,
        alreadyLive: state.activeOfferIds.length > 0,
        sourceListingId: context.sourcePublication.externalListingId,
      },
    };
  }
}

function validateContext(
  context: ListingReplacementExecutionContext,
  idempotencyKey: string,
): void {
  if (
    context.owner.provider !== "ebay" ||
    !context.owner.marketplaceId.trim() ||
    !idempotencyKey.trim() ||
    included(context.targetMembers).length === 0
  ) {
    throw providerError(
      "INPUT_INVALID",
      "eBay replacement execution context is invalid.",
    );
  }
}

function included(
  members: readonly ListingReplacementExecutionMember[],
): readonly ListingReplacementExecutionMember[] {
  return members.filter((member) => member.disposition === "included");
}

function targetGroupKey(context: ListingReplacementExecutionContext): string {
  if (context.targetProviderPublicationKey)
    return context.targetProviderPublicationKey;
  const source = context.sourcePublication.providerPublicationKey;
  if (!source) return "";
  const suffix = `-R${context.targetPublicationId}`;
  return source.slice(0, Math.max(1, 100 - suffix.length)) + suffix;
}

async function requireGroup(
  client: EbayListingReplacementClient,
  groupKey: string,
  label: string,
): Promise<EbayReplacementItemGroup> {
  const group = await client.getInventoryItemGroup(groupKey);
  if (!group)
    throw providerError(
      `${label.toUpperCase()}_GROUP_MISSING`,
      `The eBay ${label} inventory group is missing.`,
      { groupKey },
    );
  return group;
}

function assertGroupContains(
  group: EbayReplacementItemGroup,
  members: readonly ListingReplacementExecutionMember[],
  exact: boolean,
): void {
  const remote = [...(group.variantSKUs ?? [])]
    .map((sku) => sku.trim())
    .filter(Boolean)
    .sort();
  const expected = members.map((member) => member.skuSnapshot).sort();
  const missing = expected.filter((sku) => !remote.includes(sku));
  const unexpected = exact
    ? remote.filter((sku) => !expected.includes(sku))
    : [];
  if (missing.length > 0 || unexpected.length > 0) {
    throw providerError(
      "GROUP_MEMBERSHIP_MISMATCH",
      "eBay inventory-group membership does not match the replacement plan.",
      { missing, unexpected },
    );
  }
}

async function requireListingState(input: {
  client: EbayListingReplacementClient;
  members: readonly ListingReplacementExecutionMember[];
  marketplaceId: string;
  expectedListingId: string;
  expectedActive: boolean;
  label: string;
}) {
  const state = await inspectListingState(
    input.client,
    input.members,
    input.marketplaceId,
    input.expectedListingId,
  );
  const valid = input.expectedActive
    ? state.activeOfferIds.length === input.members.length
    : state.activeOfferIds.length === 0;
  if (!valid) {
    throw providerError(
      `${input.label.toUpperCase()}_LISTING_STATE_INVALID`,
      `The eBay ${input.label} listing does not have the required sellable state.`,
      {
        expectedActive: input.expectedActive,
        activeOfferIds: state.activeOfferIds,
      },
    );
  }
  return state;
}

async function inspectListingState(
  client: EbayListingReplacementClient,
  members: readonly ListingReplacementExecutionMember[],
  marketplaceId: string,
  listingId: string,
) {
  const offers: EbayReplacementOffer[] = [];
  const activeOfferIds: string[] = [];
  for (const member of members) {
    const memberOffers = await client.getOffers(
      member.skuSnapshot,
      marketplaceId,
    );
    const matching = memberOffers.find(
      (offer) => normalizedText(offer.listingId) === listingId,
    );
    if (matching) {
      offers.push(matching);
      if (isActive(matching)) activeOfferIds.push(matching.offerId);
    }
  }
  return { offers, activeOfferIds };
}

async function inspectAnyActiveListing(
  client: EbayListingReplacementClient,
  members: readonly ListingReplacementExecutionMember[],
  marketplaceId: string,
) {
  const offers: EbayReplacementOffer[] = [];
  let listingId: string | null = null;
  for (const member of members) {
    const offer = (
      await client.getOffers(member.skuSnapshot, marketplaceId)
    ).find(isActive);
    if (!offer) continue;
    const currentListingId = normalizedText(offer.listingId);
    if (!currentListingId) continue;
    if (listingId && currentListingId !== listingId) {
      throw providerError(
        "TARGET_LISTING_SPLIT",
        "Target variants are active under different eBay listing IDs.",
      );
    }
    listingId = currentListingId;
    offers.push(offer);
  }
  return { offers, listingId };
}

function publicationResult(
  providerPublicationKey: string | null,
  listingId: string,
  members: readonly ListingReplacementExecutionMember[],
  offers: readonly EbayReplacementOffer[],
  replay: boolean,
): ListingReplacementStepSuccess {
  const offerBySku = new Map(
    offers.map((offer) => [normalizedText(offer.sku), offer]),
  );
  const identities = members.map((member) => {
    const offer =
      offerBySku.get(member.skuSnapshot) ??
      offers.find((candidate) => candidate.offerId === member.externalOfferId);
    if (!offer)
      throw providerError(
        "TARGET_OFFER_MISSING",
        "An included target variant has no eBay offer identity.",
        { sku: member.skuSnapshot },
      );
    return {
      productVariantId: member.productVariantId,
      externalVariantId: offer.offerId,
      externalOfferId: offer.offerId,
      externalInventoryItemId: member.skuSnapshot,
    };
  });
  return {
    evidence: {
      listingId,
      providerPublicationKey,
      replay,
      offerIds: identities.map((identity) => identity.externalOfferId),
    },
    externalListingId: listingId,
    providerPublicationKey,
    memberIdentities: identities,
    externalUrl: `https://www.ebay.com/itm/${encodeURIComponent(listingId)}`,
  };
}

function requireSingleSourceMember(
  members: readonly ListingReplacementExecutionMember[],
): ListingReplacementExecutionMember {
  const includedMembers = included(members);
  if (includedMembers.length !== 1)
    throw providerError(
      "SOURCE_MEMBER_INVALID",
      "Single-variation source membership is invalid.",
    );
  return includedMembers[0];
}

function requireSingleSourceOfferId(
  members: readonly ListingReplacementExecutionMember[],
): string {
  const offerId = normalizedText(
    requireSingleSourceMember(members).externalOfferId,
  );
  if (!offerId)
    throw providerError(
      "SOURCE_OFFER_ID_MISSING",
      "Single-variation source offer identity is missing.",
    );
  return offerId;
}

async function requireOfferById(
  client: EbayListingReplacementClient,
  member: ListingReplacementExecutionMember,
  marketplaceId: string,
): Promise<EbayReplacementOffer> {
  const offerId = normalizedText(member.externalOfferId);
  const offer = (
    await client.getOffers(member.skuSnapshot, marketplaceId)
  ).find((candidate) => candidate.offerId === offerId);
  if (!offer)
    throw providerError(
      "SOURCE_OFFER_MISSING",
      "The source eBay offer could not be read.",
    );
  return offer;
}

function cloneOfferForCreate(
  offer: EbayReplacementOffer,
): Record<string, unknown> {
  const {
    offerId: _offerId,
    listingId: _listingId,
    status: _status,
    ...payload
  } = offer;
  return payload;
}

function isActive(offer: EbayReplacementOffer): boolean {
  return ACTIVE_OFFER_STATUSES.has(String(offer.status ?? "").toUpperCase());
}

function normalizedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerError(
  suffix: string,
  message: string,
  context: Record<string, unknown> = {},
): MarketplaceListingReplacementError {
  return new MarketplaceListingReplacementError(
    `MARKETPLACE_LISTING_REPLACEMENT_EBAY_${suffix}`,
    message,
    context,
  );
}
