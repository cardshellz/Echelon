import {
  compareCanonicalText,
  sha256Canonical,
  type CanonicalJsonValue,
} from "./canonical-hash";
import { MarketplaceListingRegistrationError } from "./registration-errors";
import type { ListingActor, ListingOwnerRef } from "./listing-replacement-plan";

export const MARKETPLACE_PROVIDER_IDENTITY_SCHEME = "provider_user_id" as const;
export const MARKETPLACE_LISTING_REGISTRATION_EXCLUSION_REASON =
  "not_in_observed_publication" as const;

export const MARKETPLACE_PROVIDER_IDENTITY_ROLES = [
  "publication_key",
  "listing_id",
  "variant_id",
  "offer_id",
  "inventory_item_id",
] as const;
export type MarketplaceProviderIdentityRole =
  (typeof MARKETPLACE_PROVIDER_IDENTITY_ROLES)[number];

export interface ListingRegistrationLocator {
  readonly providerPublicationKey: string | null;
  readonly externalListingId: string | null;
}

export interface ListingRegistrationVariantCandidate {
  readonly productVariantId: number;
  readonly sku: string;
  readonly isActive: boolean;
  readonly availableQuantity: number;
}

export interface ListingRegistrationOwnerSnapshot {
  readonly owner: ListingOwnerRef;
  readonly memberCandidates: readonly ListingRegistrationVariantCandidate[];
}

export interface MarketplaceProviderAccountObservation {
  readonly provider: string;
  readonly accountNamespace: string;
  readonly externalAccountId: string;
  readonly identityScheme: typeof MARKETPLACE_PROVIDER_IDENTITY_SCHEME;
  readonly externalDisplayNameSnapshot: string | null;
  readonly evidenceHash: string;
}

export interface MarketplaceObservedMemberIdentity {
  readonly externalId: string;
  readonly identityNamespace: string;
}

export interface MarketplaceObservedListingMember {
  readonly sku: string;
  readonly variantIdentity: MarketplaceObservedMemberIdentity | null;
  readonly offerIdentity: MarketplaceObservedMemberIdentity | null;
  readonly inventoryItemIdentity: MarketplaceObservedMemberIdentity | null;
}

export interface MarketplaceObservedListingPublication {
  readonly providerAccount: MarketplaceProviderAccountObservation;
  readonly marketplaceId: string;
  readonly publicationKeyIdentity: MarketplaceObservedMemberIdentity | null;
  readonly listingIdentity: MarketplaceObservedMemberIdentity;
  readonly externalUrl: string | null;
  readonly isPublished: boolean;
  readonly members: readonly MarketplaceObservedListingMember[];
  readonly evidence: Readonly<Record<string, CanonicalJsonValue>>;
  readonly observedAt: Date;
}

export interface PlannedListingRegistrationMember {
  readonly productVariantId: number;
  readonly skuSnapshot: string;
  readonly isActiveSnapshot: boolean;
  readonly availableQuantitySnapshot: number;
  readonly disposition: "included" | "excluded";
  readonly reasonCode:
    typeof MARKETPLACE_LISTING_REGISTRATION_EXCLUSION_REASON | null;
  readonly externalVariantId: string | null;
  readonly externalVariantIdentityNamespace: string | null;
  readonly externalOfferId: string | null;
  readonly externalOfferIdentityNamespace: string | null;
  readonly externalInventoryItemId: string | null;
  readonly externalInventoryItemIdentityNamespace: string | null;
}

export interface MarketplaceProviderIdentityClaimPlan {
  readonly role: MarketplaceProviderIdentityRole;
  readonly identityNamespace: string;
  readonly externalId: string;
  readonly productVariantId: number | null;
}

export interface ListingRegistrationPlan {
  readonly registrationVersion: 1;
  readonly owner: ListingOwnerRef;
  readonly locator: ListingRegistrationLocator;
  readonly providerAccount: MarketplaceProviderAccountObservation;
  readonly providerPublicationKey: string | null;
  readonly providerPublicationKeyIdentityNamespace: string | null;
  readonly externalListingId: string;
  readonly externalListingIdentityNamespace: string;
  readonly externalUrl: string | null;
  readonly members: readonly PlannedListingRegistrationMember[];
  readonly identityClaims: readonly MarketplaceProviderIdentityClaimPlan[];
  readonly requestHash: string;
  readonly observationHash: string;
  readonly desiredStateHash: string;
  readonly idempotencyKey: string;
  readonly requestedBy: ListingActor;
  readonly correlationId: string | null;
  readonly observedAt: Date;
  readonly evidence: Readonly<Record<string, CanonicalJsonValue>>;
}

export interface BuildListingRegistrationRequestHashInput {
  readonly owner: ListingOwnerRef;
  readonly locator: ListingRegistrationLocator;
  readonly requestedBy: ListingActor;
}

export interface BuildListingRegistrationPlanInput extends BuildListingRegistrationRequestHashInput {
  readonly snapshot: ListingRegistrationOwnerSnapshot;
  readonly observation: MarketplaceObservedListingPublication;
  readonly idempotencyKey: string;
  readonly correlationId: string | null;
}

export function buildListingRegistrationRequestHash(
  input: BuildListingRegistrationRequestHashInput,
): string {
  return sha256Canonical({
    registrationContractVersion: 1,
    owner: canonicalOwner(input.owner),
    locator: canonicalLocator(input.locator),
    requestedBy: canonicalActor(input.requestedBy),
  });
}

export function buildListingRegistrationPlan(
  input: BuildListingRegistrationPlanInput,
): ListingRegistrationPlan {
  assertValidDate(input.observation.observedAt, "observation.observedAt");
  assertOwnerMatches(input.owner, input.snapshot.owner);
  assertObservationMatchesOwner(input.owner, input.observation);
  if (!input.observation.isPublished) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_PUBLICATION_NOT_LIVE",
      "The observed marketplace publication is not currently published.",
    );
  }

  const locator = normalizeLocator(input.locator);
  assertLocatorMatchesObservation(locator, input.observation);
  const members = buildRegistrationMembers(
    input.snapshot.memberCandidates,
    input.observation.members,
  );
  const providerAccount = normalizeProviderAccount(
    input.observation.providerAccount,
  );
  const publicationKeyIdentity = normalizeOptionalIdentity(
    input.observation.publicationKeyIdentity,
    "publicationKeyIdentity",
  );
  const listingIdentity = normalizeIdentity(
    input.observation.listingIdentity,
    "listingIdentity",
  );
  const identityClaims = buildIdentityClaims(
    publicationKeyIdentity,
    listingIdentity,
    members,
  );

  const requestHash = buildListingRegistrationRequestHash({
    owner: input.owner,
    locator,
    requestedBy: input.requestedBy,
  });
  const observationHash = sha256Canonical({
    observationContractVersion: 1,
    providerAccount: canonicalProviderAccount(providerAccount),
    marketplaceId: normalizeText(
      input.observation.marketplaceId,
      "observation.marketplaceId",
      100,
    ),
    publicationKeyIdentity: canonicalIdentity(publicationKeyIdentity),
    listingIdentity: canonicalIdentity(listingIdentity),
    members: input.observation.members
      .map(canonicalMarketplaceObservedMember)
      .sort(compareCanonicalObservedMembers),
  });
  const desiredStateHash = sha256Canonical({
    desiredStateContractVersion: 1,
    owner: canonicalOwner(input.owner),
    members: members.map((member) => ({
      productVariantId: member.productVariantId,
      skuSnapshot: member.skuSnapshot,
      disposition: member.disposition,
      reasonCode: member.reasonCode,
    })),
  });

  return {
    registrationVersion: 1,
    owner: cloneOwner(input.owner),
    locator,
    providerAccount,
    providerPublicationKey: publicationKeyIdentity?.externalId ?? null,
    providerPublicationKeyIdentityNamespace:
      publicationKeyIdentity?.identityNamespace ?? null,
    externalListingId: listingIdentity.externalId,
    externalListingIdentityNamespace: listingIdentity.identityNamespace,
    externalUrl: normalizeNullableText(
      input.observation.externalUrl,
      "observation.externalUrl",
      2_000,
    ),
    members,
    identityClaims,
    requestHash,
    observationHash,
    desiredStateHash,
    idempotencyKey: normalizeText(input.idempotencyKey, "idempotencyKey", 200),
    requestedBy: { ...input.requestedBy },
    correlationId: normalizeNullableText(
      input.correlationId,
      "correlationId",
      100,
    ),
    observedAt: new Date(input.observation.observedAt.getTime()),
    evidence: { ...input.observation.evidence },
  };
}

function buildRegistrationMembers(
  candidates: readonly ListingRegistrationVariantCandidate[],
  observedMembers: readonly MarketplaceObservedListingMember[],
): readonly PlannedListingRegistrationMember[] {
  if (candidates.length === 0) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_OWNER_SNAPSHOT_EMPTY",
      "The owner snapshot must contain every local product variant.",
    );
  }
  const candidateBySku = new Map<string, ListingRegistrationVariantCandidate>();
  const candidateIds = new Set<number>();
  for (const candidate of candidates) {
    assertPositiveInteger(candidate.productVariantId, "productVariantId");
    if (candidateIds.has(candidate.productVariantId)) {
      throw registrationError(
        "MARKETPLACE_LISTING_REGISTRATION_OWNER_DUPLICATE_VARIANT",
        "The owner snapshot contains a duplicate product variant.",
        { productVariantId: candidate.productVariantId },
      );
    }
    candidateIds.add(candidate.productVariantId);
    if (!Number.isSafeInteger(candidate.availableQuantity)) {
      throw registrationError(
        "MARKETPLACE_LISTING_REGISTRATION_OWNER_QUANTITY_INVALID",
        "Owner snapshot quantities must be safe integers.",
        { productVariantId: candidate.productVariantId },
      );
    }
    const sku = normalizeText(candidate.sku, "candidate.sku", 100);
    const existing = candidateBySku.get(sku);
    if (existing) {
      throw registrationError(
        "MARKETPLACE_LISTING_REGISTRATION_OWNER_DUPLICATE_SKU",
        "The owner snapshot contains duplicate SKUs after normalization.",
        {
          sku,
          productVariantIds: [
            existing.productVariantId,
            candidate.productVariantId,
          ].sort((left, right) => left - right),
        },
      );
    }
    candidateBySku.set(sku, { ...candidate, sku });
  }

  const observedBySku = new Map<string, MarketplaceObservedListingMember>();
  for (const rawMember of observedMembers) {
    const sku = normalizeText(rawMember.sku, "observation.members.sku", 100);
    if (observedBySku.has(sku)) {
      throw registrationError(
        "MARKETPLACE_LISTING_REGISTRATION_REMOTE_DUPLICATE_SKU",
        "The observed publication contains a duplicate SKU.",
        { sku },
      );
    }
    // Remote-only members are audited as observed source evidence, but cannot
    // become local publication members without a catalog variant foreign key.
    if (candidateBySku.has(sku)) observedBySku.set(sku, rawMember);
  }
  if (observedBySku.size === 0) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_INCLUDED_MEMBER_REQUIRED",
      "The observed publication must contain at least one local product variant.",
    );
  }

  return [...candidateBySku.values()]
    .sort((left, right) => left.productVariantId - right.productVariantId)
    .map((candidate) => {
      const observed = observedBySku.get(candidate.sku);
      if (!observed) {
        return {
          productVariantId: candidate.productVariantId,
          skuSnapshot: candidate.sku,
          isActiveSnapshot: candidate.isActive,
          availableQuantitySnapshot: candidate.availableQuantity,
          disposition: "excluded" as const,
          reasonCode: MARKETPLACE_LISTING_REGISTRATION_EXCLUSION_REASON,
          externalVariantId: null,
          externalVariantIdentityNamespace: null,
          externalOfferId: null,
          externalOfferIdentityNamespace: null,
          externalInventoryItemId: null,
          externalInventoryItemIdentityNamespace: null,
        };
      }
      const variant = normalizeOptionalIdentity(
        observed.variantIdentity,
        `members.${candidate.sku}.variantIdentity`,
      );
      const offer = normalizeOptionalIdentity(
        observed.offerIdentity,
        `members.${candidate.sku}.offerIdentity`,
      );
      const inventory = normalizeOptionalIdentity(
        observed.inventoryItemIdentity,
        `members.${candidate.sku}.inventoryItemIdentity`,
      );
      return {
        productVariantId: candidate.productVariantId,
        skuSnapshot: candidate.sku,
        isActiveSnapshot: candidate.isActive,
        availableQuantitySnapshot: candidate.availableQuantity,
        disposition: "included" as const,
        reasonCode: null,
        externalVariantId: variant?.externalId ?? null,
        externalVariantIdentityNamespace: variant?.identityNamespace ?? null,
        externalOfferId: offer?.externalId ?? null,
        externalOfferIdentityNamespace: offer?.identityNamespace ?? null,
        externalInventoryItemId: inventory?.externalId ?? null,
        externalInventoryItemIdentityNamespace:
          inventory?.identityNamespace ?? null,
      };
    });
}

function buildIdentityClaims(
  publicationKey: MarketplaceObservedMemberIdentity | null,
  listing: MarketplaceObservedMemberIdentity,
  members: readonly PlannedListingRegistrationMember[],
): readonly MarketplaceProviderIdentityClaimPlan[] {
  const claims: MarketplaceProviderIdentityClaimPlan[] = [];
  if (publicationKey) {
    claims.push({
      role: "publication_key",
      identityNamespace: publicationKey.identityNamespace,
      externalId: publicationKey.externalId,
      productVariantId: null,
    });
  }
  claims.push({
    role: "listing_id",
    identityNamespace: listing.identityNamespace,
    externalId: listing.externalId,
    productVariantId: null,
  });
  for (const member of members) {
    if (member.disposition === "excluded") continue;
    const memberClaims: readonly [
      MarketplaceProviderIdentityRole,
      string | null,
      string | null,
    ][] = [
      [
        "variant_id",
        member.externalVariantIdentityNamespace,
        member.externalVariantId,
      ],
      [
        "offer_id",
        member.externalOfferIdentityNamespace,
        member.externalOfferId,
      ],
      [
        "inventory_item_id",
        member.externalInventoryItemIdentityNamespace,
        member.externalInventoryItemId,
      ],
    ];
    for (const [role, identityNamespace, externalId] of memberClaims) {
      if (identityNamespace && externalId) {
        claims.push({
          role,
          identityNamespace,
          externalId,
          productVariantId: member.productVariantId,
        });
      }
    }
  }
  const sorted = claims.sort(compareClaims);
  const seen = new Set<string>();
  for (const claim of sorted) {
    const key = `${claim.identityNamespace}\u0000${claim.externalId}`;
    if (seen.has(key)) {
      throw registrationError(
        "MARKETPLACE_LISTING_REGISTRATION_REMOTE_IDENTITY_DUPLICATE",
        "The observation assigns one account-qualified provider identity more than once.",
        {
          identityNamespace: claim.identityNamespace,
          externalId: claim.externalId,
        },
      );
    }
    seen.add(key);
  }
  return sorted;
}

function compareClaims(
  left: MarketplaceProviderIdentityClaimPlan,
  right: MarketplaceProviderIdentityClaimPlan,
): number {
  const leftVariant = left.productVariantId ?? 0;
  const rightVariant = right.productVariantId ?? 0;
  if (leftVariant !== rightVariant) return leftVariant - rightVariant;
  const byRole = compareCanonicalText(left.role, right.role);
  if (byRole !== 0) return byRole;
  const byNamespace = compareCanonicalText(
    left.identityNamespace,
    right.identityNamespace,
  );
  return byNamespace !== 0
    ? byNamespace
    : compareCanonicalText(left.externalId, right.externalId);
}

function canonicalObservedMember(
  member: PlannedListingRegistrationMember,
): CanonicalJsonValue {
  return {
    productVariantId: member.productVariantId,
    skuSnapshot: member.skuSnapshot,
    variantIdentity: canonicalIdentityFromParts(
      member.externalVariantId,
      member.externalVariantIdentityNamespace,
    ),
    offerIdentity: canonicalIdentityFromParts(
      member.externalOfferId,
      member.externalOfferIdentityNamespace,
    ),
    inventoryItemIdentity: canonicalIdentityFromParts(
      member.externalInventoryItemId,
      member.externalInventoryItemIdentityNamespace,
    ),
  };
}

function canonicalMarketplaceObservedMember(
  member: MarketplaceObservedListingMember,
): CanonicalJsonValue {
  return {
    sku: normalizeText(member.sku, "observation.members.sku", 100),
    variantIdentity: canonicalIdentity(
      normalizeOptionalIdentity(member.variantIdentity, "observation.members.variantIdentity"),
    ),
    offerIdentity: canonicalIdentity(
      normalizeOptionalIdentity(member.offerIdentity, "observation.members.offerIdentity"),
    ),
    inventoryItemIdentity: canonicalIdentity(
      normalizeOptionalIdentity(
        member.inventoryItemIdentity,
        "observation.members.inventoryItemIdentity",
      ),
    ),
  };
}

function compareCanonicalObservedMembers(
  left: CanonicalJsonValue,
  right: CanonicalJsonValue,
): number {
  const leftValue = left as Readonly<Record<string, CanonicalJsonValue>>;
  const rightValue = right as Readonly<Record<string, CanonicalJsonValue>>;
  return compareCanonicalText(String(leftValue.sku), String(rightValue.sku));
}

function canonicalProviderAccount(
  account: MarketplaceProviderAccountObservation,
): CanonicalJsonValue {
  return {
    provider: account.provider,
    accountNamespace: account.accountNamespace,
    externalAccountId: account.externalAccountId,
    identityScheme: account.identityScheme,
  };
}

function canonicalLocator(
  locator: ListingRegistrationLocator,
): CanonicalJsonValue {
  const normalized = normalizeLocator(locator);
  return {
    providerPublicationKey: normalized.providerPublicationKey,
    externalListingId: normalized.externalListingId,
  };
}

function canonicalOwner(owner: ListingOwnerRef): CanonicalJsonValue {
  return owner.kind === "channel"
    ? {
        kind: owner.kind,
        channelId: owner.channelId,
        productId: owner.productId,
        provider: owner.provider,
        marketplaceId: owner.marketplaceId,
      }
    : {
        kind: owner.kind,
        storeConnectionId: owner.storeConnectionId,
        productId: owner.productId,
        provider: owner.provider,
        marketplaceId: owner.marketplaceId,
      };
}

function canonicalActor(actor: ListingActor): CanonicalJsonValue {
  return { type: actor.type, id: actor.id };
}

function canonicalIdentity(
  identity: MarketplaceObservedMemberIdentity | null,
): CanonicalJsonValue {
  return identity
    ? {
        identityNamespace: identity.identityNamespace,
        externalId: identity.externalId,
      }
    : null;
}

function canonicalIdentityFromParts(
  externalId: string | null,
  identityNamespace: string | null,
): CanonicalJsonValue {
  return externalId && identityNamespace
    ? { identityNamespace, externalId }
    : null;
}

function normalizeProviderAccount(
  account: MarketplaceProviderAccountObservation,
): MarketplaceProviderAccountObservation {
  if (account.identityScheme !== MARKETPLACE_PROVIDER_IDENTITY_SCHEME) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_ACCOUNT_IDENTITY_UNSTABLE",
      "Registration requires the provider's stable provider_user_id identity.",
      { identityScheme: account.identityScheme },
    );
  }
  return {
    provider: normalizeProvider(account.provider),
    accountNamespace: normalizeText(
      account.accountNamespace,
      "providerAccount.accountNamespace",
      100,
    ),
    externalAccountId: normalizeText(
      account.externalAccountId,
      "providerAccount.externalAccountId",
      255,
    ),
    identityScheme: MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
    externalDisplayNameSnapshot: normalizeNullableText(
      account.externalDisplayNameSnapshot,
      "providerAccount.externalDisplayNameSnapshot",
      255,
    ),
    evidenceHash: normalizeSha256(
      account.evidenceHash,
      "providerAccount.evidenceHash",
    ),
  };
}

function normalizeLocator(
  locator: ListingRegistrationLocator,
): ListingRegistrationLocator {
  const normalized = {
    providerPublicationKey: normalizeNullableText(
      locator.providerPublicationKey,
      "locator.providerPublicationKey",
      255,
    ),
    externalListingId: normalizeNullableText(
      locator.externalListingId,
      "locator.externalListingId",
      255,
    ),
  };
  if (!normalized.providerPublicationKey && !normalized.externalListingId) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_LOCATOR_REQUIRED",
      "Registration requires a provider publication key or external listing ID.",
    );
  }
  return normalized;
}

function normalizeOptionalIdentity(
  value: MarketplaceObservedMemberIdentity | null,
  field: string,
): MarketplaceObservedMemberIdentity | null {
  return value === null ? null : normalizeIdentity(value, field);
}

function normalizeIdentity(
  value: MarketplaceObservedMemberIdentity,
  field: string,
): MarketplaceObservedMemberIdentity {
  return {
    identityNamespace: normalizeText(
      value.identityNamespace,
      `${field}.identityNamespace`,
      160,
    ),
    externalId: normalizeText(value.externalId, `${field}.externalId`, 255),
  };
}

function assertLocatorMatchesObservation(
  locator: ListingRegistrationLocator,
  observation: MarketplaceObservedListingPublication,
): void {
  const publicationKey = observation.publicationKeyIdentity?.externalId ?? null;
  if (
    (locator.providerPublicationKey !== null &&
      locator.providerPublicationKey !== publicationKey) ||
    (locator.externalListingId !== null &&
      locator.externalListingId !== observation.listingIdentity.externalId)
  ) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_LOCATOR_MISMATCH",
      "The provider observation does not match the requested listing locator.",
    );
  }
}

function assertObservationMatchesOwner(
  owner: ListingOwnerRef,
  observation: MarketplaceObservedListingPublication,
): void {
  if (
    normalizeProvider(observation.providerAccount.provider) !==
      owner.provider ||
    normalizeText(
      observation.marketplaceId,
      "observation.marketplaceId",
      100,
    ) !== owner.marketplaceId
  ) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_OBSERVATION_OWNER_MISMATCH",
      "The provider observation does not match the requested owner provider and marketplace.",
    );
  }
}

function assertOwnerMatches(
  expected: ListingOwnerRef,
  actual: ListingOwnerRef,
): void {
  if (
    JSON.stringify(canonicalOwner(expected)) !==
    JSON.stringify(canonicalOwner(actual))
  ) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_OWNER_SNAPSHOT_MISMATCH",
      "The owner reader returned a snapshot for a different listing owner.",
    );
  }
}

function normalizeProvider(value: string): string {
  const normalized = normalizeText(value, "provider", 40).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(normalized)) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_PROVIDER_INVALID",
      "Marketplace provider is invalid.",
    );
  }
  return normalized;
}

function normalizeText(
  value: string,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_TEXT_INVALID",
      "Marketplace listing registration text fields must be strings.",
      { field },
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_TEXT_INVALID",
      "Marketplace listing registration text is empty or too long.",
      { field, maxLength },
    );
  }
  return normalized;
}

function normalizeNullableText(
  value: string | null,
  field: string,
  maxLength: number,
): string | null {
  return value === null ? null : normalizeText(value, field, maxLength);
}

function normalizeSha256(value: string, field: string): string {
  const normalized = normalizeText(value, field, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_HASH_INVALID",
      "Marketplace listing registration hashes must be lowercase SHA-256 values.",
      { field },
    );
  }
  return normalized;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_INTEGER_INVALID",
      "Marketplace listing registration identifiers must be positive safe integers.",
      { field },
    );
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw registrationError(
      "MARKETPLACE_LISTING_REGISTRATION_TIMESTAMP_INVALID",
      "Marketplace listing registration timestamps must be valid dates.",
      { field },
    );
  }
}

function cloneOwner(owner: ListingOwnerRef): ListingOwnerRef {
  return owner.kind === "channel" ? { ...owner } : { ...owner };
}

function registrationError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(code, message, context);
}
