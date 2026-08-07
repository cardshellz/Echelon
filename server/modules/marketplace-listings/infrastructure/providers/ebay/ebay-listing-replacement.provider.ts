import type {
  ListingReplacementExecutionContext,
  ListingReplacementExecutionMember,
  ListingReplacementStepSuccess,
  MarketplaceListingReplacementProvider,
} from "../../../application/execution-ports";
import type { ListingOwnerRef } from "../../../domain/listing-replacement-plan";
import { MarketplaceListingReplacementError } from "../../../domain/errors";
import {
  canonicalJson,
  type CanonicalJsonValue,
} from "../../../domain/canonical-hash";

export interface EbayReplacementItemGroup {
  readonly variantSKUs?: readonly string[];
  readonly [key: string]: unknown;
}

export interface EbayReplacementInventoryItem {
  readonly product?: {
    readonly aspects?: Readonly<Record<string, readonly string[]>>;
  };
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
  deleteInventoryItemGroup(groupKey: string): Promise<void>;
  getInventoryItem(sku: string): Promise<EbayReplacementInventoryItem | null>;
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
    const targetMembers = included(context.targetMembers);
    const sourceMembers = included(context.sourceMembers);
    const sourceKey = context.sourcePublication.providerPublicationKey;
    let sourceProviderSnapshot: EbayReplacementItemGroup | null = null;
    if (sourceKey) {
      const group = await requireGroup(client, sourceKey, "source");
      sourceProviderSnapshot = group;
      assertGroupContains(group, sourceMembers, false);
    }
    await requireListingState({
      client,
      members: sourceMembers,
      marketplaceId: context.owner.marketplaceId,
      expectedListingId: context.sourcePublication.externalListingId,
      expectedActive: true,
      label: "source",
    });
    return {
      evidence: {
        sourceListingId: context.sourcePublication.externalListingId,
        sourcePublicationKey: sourceKey,
        sourceProviderSnapshot: toCanonicalSnapshot(sourceProviderSnapshot),
        targetPublicationKey: targetGroupKey(context),
        includedSkus: targetMembers.map((member) => member.skuSnapshot),
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
    const sourceMembers = included(context.sourceMembers);
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
      assertGroupContains(source, included(context.sourceMembers), false);
      const snapshot = requireSourceGroupSnapshot(context);
      const target = await buildTargetGroup(client, snapshot, members);
      await client.deleteInventoryItemGroup(sourceKey);
      await client.createOrReplaceInventoryItemGroup(targetKey, target);
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
      : await inspectActiveOffersAcrossListings(
          client,
          members,
          context.owner.marketplaceId,
        );
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
    const targetKey =
      context.targetProviderPublicationKey ?? targetGroupKey(context);
    if (
      context.sourcePublication.providerPublicationKey &&
      (await client.getInventoryItemGroup(targetKey))
    ) {
      await client.deleteInventoryItemGroup(targetKey);
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
    const members = included(context.sourceMembers);
    const activeSource = await inspectAnyActiveListing(
      client,
      members,
      context.owner.marketplaceId,
    );
    if (
      activeSource.listingId &&
      activeSource.offers.length === members.length
    ) {
      const observed = publicationResult(
        sourceKey,
        activeSource.listingId,
        members,
        activeSource.offers,
        true,
      );
      return {
        ...observed,
        evidence: {
          ...observed.evidence,
          sourceLive: true,
          alreadyLive: true,
          previousSourceListingId: context.sourcePublication.externalListingId,
          sourceListingId: activeSource.listingId,
        },
      };
    }
    if (sourceKey && !(await client.getInventoryItemGroup(sourceKey))) {
      await client.createOrReplaceInventoryItemGroup(
        sourceKey,
        requireSourceGroupSnapshot(context),
      );
    }
    let listingId = context.sourcePublication.externalListingId;
    let state = await inspectListingState(
      client,
      members,
      context.owner.marketplaceId,
      listingId,
    );
    const alreadyLive = state.activeOfferIds.length === members.length;
    if (!alreadyLive) {
      const restored = sourceKey
        ? await client.publishOfferByInventoryItemGroup(
            sourceKey,
            context.owner.marketplaceId,
          )
        : await client.publishOffer(
            requireSingleSourceOfferId(context.sourceMembers),
          );
      listingId = normalizedText(restored.listingId) ?? "";
      if (!listingId) {
        throw providerError(
          "SOURCE_LISTING_ID_MISSING",
          "eBay restored the source without returning a listing ID.",
        );
      }
      state = await requireListingState({
        client,
        members,
        marketplaceId: context.owner.marketplaceId,
        expectedListingId: listingId,
        expectedActive: true,
        label: "source",
      });
    }
    const restored = publicationResult(
      sourceKey,
      listingId,
      members,
      state.offers,
      alreadyLive,
    );
    return {
      ...restored,
      evidence: {
        ...restored.evidence,
        sourceLive: true,
        alreadyLive,
        previousSourceListingId: context.sourcePublication.externalListingId,
        sourceListingId: listingId,
      },
    };
  }
}

async function buildTargetGroup(
  client: EbayListingReplacementClient,
  source: EbayReplacementItemGroup,
  members: readonly ListingReplacementExecutionMember[],
): Promise<EbayReplacementItemGroup> {
  const names = variationSpecificationNames(source);
  const items = await Promise.all(
    members.map(async (member) => {
      const item = await client.getInventoryItem(member.skuSnapshot);
      if (!item) {
        throw providerError(
          "TARGET_INVENTORY_ITEM_MISSING",
          "A selected target inventory item is missing on eBay.",
          { sku: member.skuSnapshot },
        );
      }
      return { sku: member.skuSnapshot, item };
    }),
  );
  const specifications = names.map((name) => {
    const values = [
      ...new Set(
        items.flatMap(({ item }) => item.product?.aspects?.[name] ?? []),
      ),
    ];
    if (values.length !== members.length) {
      throw providerError(
        "TARGET_VARIATION_SPECIFICS_INVALID",
        "Every selected target item must provide one unique value for each variation specific.",
        { name, values, skus: items.map(({ sku }) => sku) },
      );
    }
    return { name, values };
  });
  return {
    ...source,
    variantSKUs: members.map((member) => member.skuSnapshot),
    variesBy: { specifications },
  };
}

function variationSpecificationNames(
  group: EbayReplacementItemGroup,
): string[] {
  const variesBy = group.variesBy;
  if (!variesBy || typeof variesBy !== "object" || Array.isArray(variesBy))
    return [];
  const specifications = (variesBy as { specifications?: unknown })
    .specifications;
  if (!Array.isArray(specifications)) return [];
  return specifications.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const name = normalizedText((value as { name?: unknown }).name);
    return name ? [name] : [];
  });
}

function toCanonicalSnapshot(
  group: EbayReplacementItemGroup | null,
): CanonicalJsonValue {
  if (group === null) return null;
  const snapshot = JSON.parse(JSON.stringify(group)) as CanonicalJsonValue;
  canonicalJson(snapshot);
  return snapshot;
}
function requireSourceGroupSnapshot(
  context: ListingReplacementExecutionContext,
): EbayReplacementItemGroup {
  const snapshot = context.sourceProviderSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw providerError(
      "SOURCE_SNAPSHOT_MISSING",
      "The durable eBay source-group snapshot is unavailable; automatic recovery cannot proceed safely.",
    );
  }
  const group = snapshot as EbayReplacementItemGroup;
  assertGroupContains(group, included(context.sourceMembers), false);
  return group;
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

async function inspectActiveOffersAcrossListings(
  client: EbayListingReplacementClient,
  members: readonly ListingReplacementExecutionMember[],
  marketplaceId: string,
): Promise<{ offers: EbayReplacementOffer[]; activeOfferIds: string[] }> {
  const offers = (
    await Promise.all(
      members.map((member) =>
        client.getOffers(member.skuSnapshot, marketplaceId),
      ),
    )
  ).flat();
  return {
    offers,
    activeOfferIds: offers.filter(isActive).map((offer) => offer.offerId),
  };
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
