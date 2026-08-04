import { z } from "zod";

import { listingRegistrationOwnerSnapshotSchema } from "../../../application/registration-dtos";
import type {
  MarketplaceListingRegistrationObserver,
  ObserveMarketplaceListingInput,
} from "../../../application/registration-ports";
import {
  compareCanonicalText,
  type CanonicalJsonValue,
} from "../../../domain/canonical-hash";
import {
  MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
  type ListingRegistrationOwnerSnapshot,
  type ListingRegistrationVariantCandidate,
  type MarketplaceObservedListingMember,
  type MarketplaceObservedListingPublication,
  type MarketplaceProviderAccountObservation,
} from "../../../domain/listing-registration-plan";
import { MarketplaceListingRegistrationError } from "../../../domain/registration-errors";
import type { ListingOwnerRef } from "../../../domain/listing-replacement-plan";
import {
  assertEbayRegistrationEnvironment,
  buildEbayProviderAccountEvidenceHash,
  parseEbayRegistrationMarketplaceId,
  buildEbayRegistrationIdentityNamespace,
  ebayProviderAccountNamespace,
  type EbayRegistrationCredentialProvider,
  type EbayRegistrationEnvironment,
  type EbayRegistrationReadCredential,
  type EbayRegistrationReadResponse,
  type EbayRegistrationReadTransport,
} from "./ebay-registration-contracts";

const EBAY_PROVIDER = "ebay" as const;
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 1_000;
const LIVE_LISTING_STATUSES = new Set(["ACTIVE", "OUT_OF_STOCK"]);

const identityResponseSchema = z
  .object({
    userId: z.string().trim().min(1).max(255),
    username: z.string().trim().min(1).max(255).nullable().optional(),
  })
  .passthrough();

const inventoryItemResponseSchema = z
  .object({
    sku: z.string().trim().min(1).max(100).optional(),
    groupIds: z
      .array(z.string().trim().min(1).max(255))
      .max(1_000)
      .optional(),
  })
  .passthrough();

const offerSchema = z
  .object({
    offerId: z.string().trim().min(1).max(255),
    sku: z.string().trim().min(1).max(100).optional(),
    marketplaceId: z.string().trim().min(1).max(100).optional(),
    status: z.enum(["PUBLISHED", "UNPUBLISHED"]),
    listing: z
      .object({
        listingId: z.string().trim().min(1).max(255),
        listingStatus: z.string().trim().min(1).max(100),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const offersPageSchema = z
  .object({
    offers: z.array(offerSchema).max(10_000),
    total: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .passthrough();

const inventoryItemGroupResponseSchema = z
  .object({
    inventoryItemGroupKey: z.string().trim().min(1).max(255).optional(),
    variantSKUs: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(10_000),
  })
  .passthrough();

type ParsedOffer = z.infer<typeof offerSchema>;

interface ObservedInventoryItem {
  readonly sku: string;
  readonly groupIds: readonly string[];
}

interface ObservedSku {
  readonly sku: string;
  readonly inventoryItem: ObservedInventoryItem | null;
  readonly offers: readonly ParsedOffer[];
}

interface SelectedMember {
  readonly sku: string;
  readonly offerId: string;
  readonly listingId: string;
  readonly listingStatus: string;
  readonly groupIds: readonly string[];
}

interface SelectedPublication {
  readonly listingId: string;
  readonly groupKey: string | null;
  readonly groupVariantSkus: readonly string[];
  readonly members: readonly SelectedMember[];
}

export interface EbayMarketplaceRegistrationObserverConfig {
  readonly now?: () => Date;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

/**
 * Single provider-owned eBay observation algorithm shared by Channel and
 * Dropship owners. It has no provider write port and can therefore only read
 * and describe an already-published listing.
 */
export class EbayMarketplaceRegistrationObserver
  implements MarketplaceListingRegistrationObserver
{
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(
    private readonly credentials: EbayRegistrationCredentialProvider,
    private readonly transport: EbayRegistrationReadTransport,
    config: EbayMarketplaceRegistrationObserverConfig = {},
  ) {
    this.now = config.now ?? (() => new Date());
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
    if (
      !Number.isSafeInteger(this.pageSize)
      || this.pageSize <= 0
      || this.pageSize > 200
    ) {
      throw observationError(
        "EBAY_REGISTRATION_PAGE_SIZE_INVALID",
        "eBay registration offer page size must be between 1 and 200.",
      );
    }
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages <= 0) {
      throw observationError(
        "EBAY_REGISTRATION_MAX_PAGES_INVALID",
        "eBay registration maximum pages must be a positive integer.",
      );
    }
  }

  async observeExistingPublication(
    input: ObserveMarketplaceListingInput,
  ): Promise<MarketplaceObservedListingPublication> {
    const snapshot = parseObservationSnapshot({
      owner: { ...input.owner },
      memberCandidates: input.memberCandidates,
    });
    const owner = assertEbayOwner(snapshot.owner);
    // Complete local member validation must precede access to any credential.
    const credential = parseReadCredential(
      await this.credentials.loadFreshCredential(owner),
    );
    const providerAccount = await this.observeProviderAccount(credential);

    const selected = input.locator.providerPublicationKey !== null
      ? await this.observeGroupPublication(
          credential,
          owner.marketplaceId,
          input.locator.providerPublicationKey,
          input.locator.externalListingId,
        )
      : await this.discoverPublicationByListing(
          credential,
          owner.marketplaceId,
          requireListingLocator(input.locator.externalListingId),
          snapshot.memberCandidates,
        );
    assertDistinctMemberIdentities(selected.members);

    const observedAt = this.now();
    if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
      throw observationError(
        "EBAY_REGISTRATION_CLOCK_INVALID",
        "The eBay registration observer clock returned an invalid timestamp.",
      );
    }

    const members: MarketplaceObservedListingMember[] = selected.members
      .map((member) => ({
        sku: member.sku,
        variantIdentity: null,
        offerIdentity: {
          externalId: member.offerId,
          identityNamespace: buildEbayRegistrationIdentityNamespace({
            environment: credential.environment,
            marketplaceId: owner.marketplaceId,
            role: "offer",
          }),
        },
        inventoryItemIdentity: {
          externalId: member.sku,
          identityNamespace: buildEbayRegistrationIdentityNamespace({
            environment: credential.environment,
            marketplaceId: owner.marketplaceId,
            role: "inventory_item",
          }),
        },
      }))
      .sort((left, right) => compareCanonicalText(left.sku, right.sku));

    return {
      providerAccount,
      marketplaceId: owner.marketplaceId,
      publicationKeyIdentity: selected.groupKey === null
        ? null
        : {
            externalId: selected.groupKey,
            identityNamespace: buildEbayRegistrationIdentityNamespace({
              environment: credential.environment,
              marketplaceId: owner.marketplaceId,
              role: "inventory_item_group",
            }),
          },
      listingIdentity: {
        externalId: selected.listingId,
        identityNamespace: buildEbayRegistrationIdentityNamespace({
          environment: credential.environment,
          marketplaceId: owner.marketplaceId,
          role: "listing",
        }),
      },
      externalUrl: null,
      isPublished: true,
      members,
      evidence: buildPublicationEvidence(
        credential.environment,
        owner.marketplaceId,
        selected,
      ),
      observedAt: new Date(observedAt.getTime()),
    };
  }

  private async observeProviderAccount(
    credential: EbayRegistrationReadCredential,
  ): Promise<MarketplaceProviderAccountObservation> {
    const response = await this.transport.get({
      environment: credential.environment,
      path: "/commerce/identity/v1/user/",
      accessToken: credential.accessToken,
      marketplaceId: null,
    });
    assertSuccessfulRead(response, "identity");
    const parsed = parseProviderResponse(
      identityResponseSchema,
      response.body,
      "identity",
    );
    return {
      provider: EBAY_PROVIDER,
      accountNamespace: ebayProviderAccountNamespace(credential.environment),
      externalAccountId: parsed.userId,
      identityScheme: MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
      externalDisplayNameSnapshot: parsed.username ?? null,
      evidenceHash: buildEbayProviderAccountEvidenceHash(
        credential.environment,
        parsed.userId,
      ),
    };
  }

  private async observeGroupPublication(
    credential: EbayRegistrationReadCredential,
    marketplaceId: string,
    groupKey: string,
    expectedListingId: string | null,
  ): Promise<SelectedPublication> {
    const normalizedGroupKey = normalizeProviderText(
      groupKey,
      "groupKey",
      255,
    );
    const group = await this.getInventoryItemGroup(
      credential,
      marketplaceId,
      normalizedGroupKey,
    );
    if (
      group.inventoryItemGroupKey !== undefined
      && group.inventoryItemGroupKey !== normalizedGroupKey
    ) {
      throw observationError(
        "EBAY_REGISTRATION_GROUP_KEY_MISMATCH",
        "eBay returned a different inventory item group than requested.",
        { requestedGroupKey: normalizedGroupKey },
      );
    }

    const variantSkus = normalizeUniqueTexts(
      group.variantSKUs,
      "variantSKUs",
      100,
    );
    const observedSkus: ObservedSku[] = [];
    for (const sku of variantSkus) {
      const observed = await this.observeSku(
        credential,
        marketplaceId,
        sku,
      );
      if (observed.inventoryItem === null) {
        throw observationError(
          "EBAY_REGISTRATION_GROUP_INVENTORY_ITEM_MISSING",
          "An eBay inventory item group member could not be read.",
          { sku, groupKey: normalizedGroupKey },
        );
      }
      if (!observed.inventoryItem.groupIds.includes(normalizedGroupKey)) {
        throw observationError(
          "EBAY_REGISTRATION_GROUP_MEMBERSHIP_INCONSISTENT",
          "An eBay group member does not point back to the observed group.",
          { sku, groupKey: normalizedGroupKey },
        );
      }
      observedSkus.push(observed);
    }

    const listingId = resolveCoherentListingId(
      observedSkus,
      expectedListingId,
    );
    return {
      listingId,
      groupKey: normalizedGroupKey,
      groupVariantSkus: variantSkus,
      members: observedSkus.map((observed) =>
        selectSinglePublishedOffer(observed, listingId)
      ),
    };
  }

  private async discoverPublicationByListing(
    credential: EbayRegistrationReadCredential,
    marketplaceId: string,
    listingId: string,
    candidates: readonly ListingRegistrationVariantCandidate[],
  ): Promise<SelectedPublication> {
    const matched: Array<{ observed: ObservedSku; member: SelectedMember }> = [];
    for (const candidate of candidates) {
      const observed = await this.observeSku(
        credential,
        marketplaceId,
        candidate.sku,
      );
      const matchingOffers = publishedOffersForListing(
        observed.offers,
        listingId,
      );
      if (matchingOffers.length > 1) {
        throw observationError(
          "EBAY_REGISTRATION_OFFER_AMBIGUOUS",
          "A SKU has multiple published offers for the requested listing.",
          { sku: candidate.sku, listingId },
        );
      }
      if (matchingOffers.length === 0) continue;
      if (observed.inventoryItem === null) {
        throw observationError(
          "EBAY_REGISTRATION_INVENTORY_ITEM_MISSING",
          "A published offer exists without a readable inventory item.",
          { sku: candidate.sku, listingId },
        );
      }
      matched.push({
        observed,
        member: selectedMember(observed, matchingOffers[0], listingId),
      });
    }

    if (matched.length === 0) {
      throw observationError(
        "EBAY_REGISTRATION_LISTING_NOT_FOUND",
        "No local SKU has a published offer for the requested eBay listing.",
        { listingId },
      );
    }
    const groupKeys = normalizeDistinctTexts(
      matched.flatMap(({ observed }) =>
        observed.inventoryItem?.groupIds ?? []
      ),
      "discoveredGroupIds",
      255,
    );
    if (groupKeys.length > 1) {
      throw observationError(
        "EBAY_REGISTRATION_GROUP_AMBIGUOUS",
        "The requested listing maps to more than one eBay inventory item group.",
        { listingId, groupKeys },
      );
    }
    if (groupKeys.length === 1) {
      return this.observeGroupPublication(
        credential,
        marketplaceId,
        groupKeys[0],
        listingId,
      );
    }
    if (matched.length !== 1) {
      throw observationError(
        "EBAY_REGISTRATION_GROUP_REQUIRED",
        "A multi-SKU eBay listing must have exactly one coherent inventory item group.",
        { listingId, matchedSkus: matched.map(({ member }) => member.sku) },
      );
    }
    return {
      listingId,
      groupKey: null,
      groupVariantSkus: [],
      members: [matched[0].member],
    };
  }

  private async observeSku(
    credential: EbayRegistrationReadCredential,
    marketplaceId: string,
    sku: string,
  ): Promise<ObservedSku> {
    const normalizedSku = normalizeProviderText(sku, "sku", 100);
    const [inventoryItem, offers] = await Promise.all([
      this.getInventoryItem(credential, marketplaceId, normalizedSku),
      this.getAllOffers(credential, marketplaceId, normalizedSku),
    ]);
    return { sku: normalizedSku, inventoryItem, offers };
  }

  private async getInventoryItem(
    credential: EbayRegistrationReadCredential,
    marketplaceId: string,
    sku: string,
  ): Promise<ObservedInventoryItem | null> {
    const response = await this.transport.get({
      environment: credential.environment,
      path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      accessToken: credential.accessToken,
      marketplaceId,
    });
    if (response.status === 404) return null;
    assertSuccessfulRead(response, "inventory_item");
    const parsed = parseProviderResponse(
      inventoryItemResponseSchema,
      response.body,
      "inventory_item",
    );
    if (parsed.sku !== undefined && parsed.sku !== sku) {
      throw observationError(
        "EBAY_REGISTRATION_INVENTORY_SKU_MISMATCH",
        "eBay returned a different inventory item SKU than requested.",
        { requestedSku: sku, returnedSku: parsed.sku },
      );
    }
    return {
      sku,
      groupIds: normalizeUniqueTexts(
        parsed.groupIds ?? [],
        "groupIds",
        255,
      ),
    };
  }

  private async getInventoryItemGroup(
    credential: EbayRegistrationReadCredential,
    marketplaceId: string,
    groupKey: string,
  ): Promise<z.infer<typeof inventoryItemGroupResponseSchema>> {
    const response = await this.transport.get({
      environment: credential.environment,
      path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
      accessToken: credential.accessToken,
      marketplaceId,
    });
    assertSuccessfulRead(response, "inventory_item_group");
    return parseProviderResponse(
      inventoryItemGroupResponseSchema,
      response.body,
      "inventory_item_group",
    );
  }

  private async getAllOffers(
    credential: EbayRegistrationReadCredential,
    marketplaceId: string,
    sku: string,
  ): Promise<readonly ParsedOffer[]> {
    const offers: ParsedOffer[] = [];
    const seenOfferIds = new Set<string>();
    let expectedTotal: number | null = null;
    let offset = 0;

    for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber += 1) {
      const query = new URLSearchParams({
        sku,
        marketplace_id: marketplaceId,
        limit: String(this.pageSize),
        offset: String(offset),
      });
      const response = await this.transport.get({
        environment: credential.environment,
        path: `/sell/inventory/v1/offer?${query.toString()}`,
        accessToken: credential.accessToken,
        marketplaceId,
      });
      assertSuccessfulRead(response, "offers");
      const page = parseProviderResponse(
        offersPageSchema,
        response.body,
        "offers",
      );
      if (page.total !== undefined) {
        if (expectedTotal !== null && expectedTotal !== page.total) {
          throw observationError(
            "EBAY_REGISTRATION_OFFER_TOTAL_CHANGED",
            "eBay offer pagination total changed during observation.",
            { sku, previousTotal: expectedTotal, currentTotal: page.total },
          );
        }
        expectedTotal = page.total;
      }
      for (const offer of page.offers) {
        if (offer.sku !== undefined && offer.sku !== sku) {
          throw observationError(
            "EBAY_REGISTRATION_OFFER_SKU_MISMATCH",
            "eBay returned an offer for a different SKU.",
            { requestedSku: sku, returnedSku: offer.sku },
          );
        }
        if (
          offer.marketplaceId !== undefined
          && offer.marketplaceId !== marketplaceId
        ) {
          throw observationError(
            "EBAY_REGISTRATION_OFFER_MARKETPLACE_MISMATCH",
            "eBay returned an offer for a different marketplace.",
            {
              requestedMarketplaceId: marketplaceId,
              returnedMarketplaceId: offer.marketplaceId,
              offerId: offer.offerId,
            },
          );
        }
        if (seenOfferIds.has(offer.offerId)) {
          throw observationError(
            "EBAY_REGISTRATION_OFFER_PAGINATION_DUPLICATE",
            "eBay returned the same offer more than once across pages.",
            { sku, offerId: offer.offerId },
          );
        }
        seenOfferIds.add(offer.offerId);
        offers.push(offer);
      }

      if (expectedTotal !== null && offers.length >= expectedTotal) {
        if (offers.length !== expectedTotal) {
          throw observationError(
            "EBAY_REGISTRATION_OFFER_TOTAL_INCONSISTENT",
            "eBay returned more offers than its reported pagination total.",
            { sku, expectedTotal, returnedCount: offers.length },
          );
        }
        return offers;
      }
      if (page.offers.length === 0) {
        if (expectedTotal !== null && offers.length < expectedTotal) {
          throw observationError(
            "EBAY_REGISTRATION_OFFER_PAGE_INCOMPLETE",
            "eBay offer pagination ended before the reported total was read.",
            { sku, expectedTotal, returnedCount: offers.length },
          );
        }
        return offers;
      }
      if (page.offers.length < this.pageSize && expectedTotal === null) {
        return offers;
      }
      offset += page.offers.length;
    }
    throw observationError(
      "EBAY_REGISTRATION_OFFER_PAGE_LIMIT_EXCEEDED",
      "eBay offer pagination exceeded the configured safety limit.",
      { sku, maxPages: this.maxPages },
    );
  }
}

function parseObservationSnapshot(value: unknown): ListingRegistrationOwnerSnapshot {
  const parsed = listingRegistrationOwnerSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw observationError(
      "EBAY_REGISTRATION_OBSERVATION_INPUT_INVALID",
      "The eBay registration observation input is invalid.",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  const variantIds = new Set<number>();
  const skus = new Set<string>();
  for (const candidate of parsed.data.memberCandidates) {
    if (variantIds.has(candidate.productVariantId)) {
      throw observationError(
        "EBAY_REGISTRATION_CANDIDATE_VARIANT_DUPLICATE",
        "The eBay registration observation contains a duplicate product variant.",
        { productVariantId: candidate.productVariantId },
      );
    }
    if (skus.has(candidate.sku)) {
      throw observationError(
        "EBAY_REGISTRATION_CANDIDATE_SKU_DUPLICATE",
        "The eBay registration observation contains a duplicate SKU.",
        { sku: candidate.sku },
      );
    }
    variantIds.add(candidate.productVariantId);
    skus.add(candidate.sku);
  }
  return parsed.data;
}

function assertEbayOwner(owner: ListingOwnerRef): ListingOwnerRef {
  if (owner.provider !== EBAY_PROVIDER) {
    throw observationError(
      "EBAY_REGISTRATION_OWNER_INVALID",
      "The shared eBay registration observer only accepts eBay owners.",
      { ownerKind: owner.kind, provider: owner.provider },
    );
  }
  parseEbayRegistrationMarketplaceId(owner.marketplaceId);
  return owner;
}

function parseReadCredential(value: unknown): EbayRegistrationReadCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw observationError(
      "EBAY_REGISTRATION_CREDENTIAL_INVALID",
      "The owner credential provider returned an invalid eBay credential.",
    );
  }
  const candidate = value as Partial<EbayRegistrationReadCredential>;
  const environment = assertEbayRegistrationEnvironment(candidate.environment);
  const accessToken = normalizeProviderText(
    candidate.accessToken as string,
    "accessToken",
    16_384,
  );
  return { accessToken, environment };
}

function requireListingLocator(value: string | null): string {
  if (value === null) {
    throw observationError(
      "EBAY_REGISTRATION_LISTING_LOCATOR_REQUIRED",
      "An external listing ID is required when no inventory item group key is supplied.",
    );
  }
  return normalizeProviderText(value, "externalListingId", 255);
}

function resolveCoherentListingId(
  observedSkus: readonly ObservedSku[],
  expectedListingId: string | null,
): string {
  if (expectedListingId !== null) {
    return normalizeProviderText(
      expectedListingId,
      "externalListingId",
      255,
    );
  }
  const listingIds = normalizeUniqueTexts(
    observedSkus.flatMap(({ offers }) =>
      offers
        .filter((offer) => offer.status === "PUBLISHED" && offer.listing)
        .map((offer) => offer.listing!.listingId)
    ),
    "listingIds",
    255,
  );
  if (listingIds.length !== 1) {
    throw observationError(
      "EBAY_REGISTRATION_LISTING_AMBIGUOUS",
      "The inventory item group does not resolve to exactly one published listing.",
      { listingIds },
    );
  }
  return listingIds[0];
}

function selectSinglePublishedOffer(
  observed: ObservedSku,
  listingId: string,
): SelectedMember {
  const offers = publishedOffersForListing(observed.offers, listingId);
  if (offers.length !== 1) {
    throw observationError(
      offers.length === 0
        ? "EBAY_REGISTRATION_GROUP_MEMBER_NOT_PUBLISHED"
        : "EBAY_REGISTRATION_OFFER_AMBIGUOUS",
      "Every observed eBay group member must have exactly one published offer for the listing.",
      { sku: observed.sku, listingId, matchingOfferCount: offers.length },
    );
  }
  return selectedMember(observed, offers[0], listingId);
}

function selectedMember(
  observed: ObservedSku,
  offer: ParsedOffer,
  listingId: string,
): SelectedMember {
  if (
    offer.listing === undefined
    || !LIVE_LISTING_STATUSES.has(offer.listing.listingStatus)
  ) {
    throw observationError(
      "EBAY_REGISTRATION_LISTING_NOT_LIVE",
      "A published eBay offer is not associated with a live listing.",
      {
        sku: observed.sku,
        listingId,
        listingStatus: offer.listing?.listingStatus ?? null,
      },
    );
  }
  return {
    sku: observed.sku,
    offerId: offer.offerId,
    listingId,
    listingStatus: offer.listing.listingStatus,
    groupIds: observed.inventoryItem?.groupIds ?? [],
  };
}

function publishedOffersForListing(
  offers: readonly ParsedOffer[],
  listingId: string,
): readonly ParsedOffer[] {
  return offers.filter(
    (offer) =>
      offer.status === "PUBLISHED"
      && offer.listing?.listingId === listingId,
  );
}

function assertDistinctMemberIdentities(
  members: readonly SelectedMember[],
): void {
  const skus = new Set<string>();
  const offerIds = new Set<string>();
  for (const member of members) {
    if (skus.has(member.sku) || offerIds.has(member.offerId)) {
      throw observationError(
        "EBAY_REGISTRATION_MEMBER_IDENTITY_DUPLICATE",
        "Observed eBay member inventory and offer identities must be distinct.",
        { sku: member.sku, offerId: member.offerId },
      );
    }
    skus.add(member.sku);
    offerIds.add(member.offerId);
  }
}

function assertSuccessfulRead(
  response: EbayRegistrationReadResponse,
  resource: string,
): void {
  if (
    !Number.isInteger(response.status)
    || response.status < 200
    || response.status >= 300
  ) {
    throw observationError(
      "EBAY_REGISTRATION_PROVIDER_READ_FAILED",
      "An eBay read required for registration failed.",
      { resource, status: response.status },
    );
  }
}

function parseProviderResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  resource: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw observationError(
      "EBAY_REGISTRATION_PROVIDER_RESPONSE_INVALID",
      "eBay returned an invalid registration observation response.",
      {
        resource,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  return parsed.data;
}

function normalizeDistinctTexts(
  values: readonly string[],
  field: string,
  maxLength: number,
): string[] {
  return [...new Set(
    values.map((value) => normalizeProviderText(value, field, maxLength)),
  )].sort(compareCanonicalText);
}

function normalizeUniqueTexts(
  values: readonly string[],
  field: string,
  maxLength: number,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeProviderText(value, field, maxLength);
    if (seen.has(normalized)) {
      throw observationError(
        "EBAY_REGISTRATION_PROVIDER_IDENTITY_DUPLICATE",
        "eBay returned a duplicate identity in a set that must be unique.",
        { field, value: normalized },
      );
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result.sort(compareCanonicalText);
}

function normalizeProviderText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw observationError(
      "EBAY_REGISTRATION_PROVIDER_TEXT_INVALID",
      "An eBay registration identity must be text.",
      { field },
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw observationError(
      "EBAY_REGISTRATION_PROVIDER_TEXT_INVALID",
      "An eBay registration identity is empty or too long.",
      { field, maxLength },
    );
  }
  return normalized;
}

function buildPublicationEvidence(
  environment: EbayRegistrationEnvironment,
  marketplaceId: string,
  selected: SelectedPublication,
): Readonly<Record<string, CanonicalJsonValue>> {
  return {
    observationContractVersion: 1,
    provider: EBAY_PROVIDER,
    environment,
    marketplaceId,
    listingId: selected.listingId,
    inventoryItemGroupKey: selected.groupKey,
    groupVariantSkus: [...selected.groupVariantSkus],
    members: selected.members
      .map((member) => ({
        sku: member.sku,
        offerId: member.offerId,
        listingStatus: member.listingStatus,
        groupIds: [...member.groupIds],
      }))
      .sort((left, right) => compareCanonicalText(left.sku, right.sku)),
  };
}

function observationError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(code, message, context);
}
