import { z } from "zod";
import {
  marketplaceObservedListingPublicationSchema,
  type MarketplaceListingRegistrationObserver,
  type ListingRegistrationVariantCandidate,
} from "../marketplace-listings";
import {
  EbayListingSyncError,
  ebayListingSyncIdentitySchema,
  type EbayListingSyncIdentity,
} from "./ebay-listing-sync.domain";

const id = z.number().int().positive().max(2_147_483_647);
const sku = z.string().trim().min(1).max(100);
const existingListingRowSchema = z.object({
  product_id: id,
  variant_id: id,
  variant_sku: sku,
  external_sku: sku.nullable(),
  external_variant_id: z.string().trim().min(1).max(255).nullable(),
  external_product_id: z.string().trim().min(1).max(255).nullable(),
  content_sync_enabled: z.boolean().optional(),
});
export type ExistingEbayListingIdentityRow = z.infer<typeof existingListingRowSchema>;
export interface ExistingEbayListingIdentityContext {
  readonly channelId: number;
  readonly connectionId: number;
  readonly accountId: string;
  readonly marketplaceId: string;
}

/** Captures the mapping we actually saved. Catalog renames do not rename eBay resources. */
export function captureExistingEbayListingIdentity(
  input: readonly unknown[],
  context: ExistingEbayListingIdentityContext,
): EbayListingSyncIdentity {
  const parsed = z.array(existingListingRowSchema).min(1).max(250).safeParse(input);
  if (!parsed.success) {
    throw identityError("EBAY_SYNC_MAPPING_INVALID", "The saved eBay listing has an incomplete variant mapping. Review its catalog variant and saved eBay identifiers.");
  }
  const rows = parsed.data;
  const productId = rows[0].product_id;
  if (rows.some(row => row.product_id !== productId)) {
    throw identityError("EBAY_SYNC_MAPPING_INVALID", "The saved eBay listing contains variants from different products.");
  }
  const identity = ebayListingSyncIdentitySchema.safeParse({
    ...context,
    productId,
    // Only the provider observation can establish the existing group's key.
    groupKey: null,
    variants: rows.map(row => ({
      variantId: row.variant_id,
      catalogSku: row.variant_sku,
      contentSyncEnabled: row.content_sync_enabled ?? true,
      sku: row.external_sku ?? row.variant_sku,
      externalSku: row.external_sku,
      offerId: row.external_variant_id,
      listingId: row.external_product_id,
    })),
  });
  if (!identity.success) {
    throw identityError("EBAY_SYNC_MAPPING_INVALID", `Product ${productId} has duplicate or invalid saved eBay identities. Review its variant mappings.`);
  }
  return identity.data;
}

/** An old job's catalog-derived group hint is not provider identity evidence. */
export function assertEbayListingSourceIdentityUnchanged(
  expected: EbayListingSyncIdentity,
  current: EbayListingSyncIdentity,
): void {
  const memberById = new Map(current.variants.map(member => [member.variantId, member]));
  if (expected.channelId !== current.channelId
    || expected.connectionId !== current.connectionId
    || expected.accountId !== current.accountId
    || expected.marketplaceId !== current.marketplaceId
    || expected.productId !== current.productId
    || expected.variants.length !== current.variants.length
    || expected.variants.some(member => {
      const observed = memberById.get(member.variantId);
      return !observed || member.sku !== observed.sku
        || member.externalSku !== observed.externalSku
        || member.offerId !== observed.offerId
        || member.listingId !== observed.listingId
        || (member.catalogSku !== undefined && member.catalogSku !== observed.catalogSku)
        || (member.contentSyncEnabled !== undefined && member.contentSyncEnabled !== observed.contentSyncEnabled);
    })) {
    throw identityError("EBAY_SYNC_IDENTITY_CHANGED", `Product ${expected.productId}'s saved eBay mapping changed after this sync was requested. Review the mapping and request a new sync.`);
  }
}

/**
 * Reuses marketplace-listings' provider-owned observation algorithm. This binds
 * existing saved local variant mappings to a complete, published eBay listing;
 * it neither registers a listing nor guesses that a catalog SKU is its group.
 */
export async function resolveExistingEbayListingIdentity(
  source: EbayListingSyncIdentity,
  observer: MarketplaceListingRegistrationObserver,
  candidates: readonly ListingRegistrationVariantCandidate[],
): Promise<EbayListingSyncIdentity> {
  const listingIds = [...new Set(source.variants.map(member => member.listingId).filter((value): value is string => value !== null))];
  if (listingIds.length !== 1) {
    throw identityError("EBAY_SYNC_LISTING_IDENTITY_REQUIRED", `Product ${source.productId} must map to one existing eBay listing; ${listingIds.length} saved listing IDs were found.`);
  }
  const candidateById = new Map(candidates.map(candidate => [candidate.productVariantId, candidate]));
  if (candidateById.size !== source.variants.length || candidates.length !== source.variants.length
    || source.variants.some(member => candidateById.get(member.variantId)?.sku !== member.sku)) {
    throw identityError("EBAY_SYNC_MAPPING_INVALID", "The provider observation does not cover the exact saved eBay variant mappings.");
  }
  const observation = await observeExistingEbayPublication({
    owner: { kind: "channel", channelId: source.channelId, productId: source.productId, provider: "ebay", marketplaceId: source.marketplaceId },
    locator: { providerPublicationKey: null, externalListingId: listingIds[0] },
    memberCandidates: candidates,
  }, observer, source.accountId);
  const observedBySku = new Map(observation.members.map(member => [member.sku, member]));
  if (observedBySku.size !== observation.members.length || observation.members.length !== source.variants.length
    || source.variants.some(member => !observedBySku.has(member.sku))) {
    throw identityError("EBAY_SYNC_MEMBERSHIP_CHANGED", `Product ${source.productId}'s eBay listing membership differs from its saved variant mappings. Review the complete listing before syncing.`);
  }
  const groupKey = observation.publicationKeyIdentity?.externalId ?? null;
  if (source.variants.length > 1 && groupKey === null) {
    throw identityError("EBAY_SYNC_GROUP_IDENTITY_REQUIRED", `Product ${source.productId}'s multi-variant eBay listing has no verified inventory group.`);
  }
  const variants = source.variants.map(member => {
    const observed = observedBySku.get(member.sku)!;
    if (observed.inventoryItemIdentity?.externalId !== member.sku
      || observed.offerIdentity === null
      || (member.offerId !== null && member.offerId !== observed.offerIdentity.externalId)) {
      throw identityError("EBAY_SYNC_IDENTITY_CHANGED", `Saved eBay SKU ${member.sku} no longer matches its exact inventory item and offer. Review variant ${member.variantId}.`);
    }
    return { ...member, offerId: observed.offerIdentity.externalId, listingId: observation.listingIdentity.externalId };
  });
  return ebayListingSyncIdentitySchema.parse({ ...source, groupKey, variants });
}

/** Shared read boundary for maintenance and interrupted first-publication replay.
 * The provider-owned observer supplies group membership, never a catalog hint. */
export async function observeExistingEbayPublication(
  input: Parameters<MarketplaceListingRegistrationObserver["observeExistingPublication"]>[0],
  observer: MarketplaceListingRegistrationObserver,
  expectedAccountId: string,
) {
  const raw = await observer.observeExistingPublication(input).catch(rethrowObservationFailure);
  const parsed = marketplaceObservedListingPublicationSchema.safeParse(raw);
  if (!parsed.success) throw identityError("EBAY_SYNC_PROVIDER_IDENTITY_INVALID", "eBay did not return a complete, valid listing identity observation.");
  const observation = parsed.data;
  if (observation.providerAccount.provider !== "ebay"
    || observation.providerAccount.externalAccountId !== expectedAccountId
    || observation.marketplaceId !== input.owner.marketplaceId
    || !observation.isPublished
    || observation.listingIdentity.externalId !== input.locator.externalListingId) {
    throw identityError("EBAY_SYNC_IDENTITY_CHANGED", "The observed eBay account or published listing does not match the authorized listing identity.");
  }
  return observation;
}

function identityError(code: string, message: string): EbayListingSyncError {
  return new EbayListingSyncError(code, message);
}

/** Translate the shared observation port's read failures into listing recovery
 * policy. Provider identity validation remains owned by the shared observer. */
function rethrowObservationFailure(error: unknown): never {
  if (!(error instanceof Error) || !("code" in error)) throw error;
  if (error.code === "EBAY_REGISTRATION_PROVIDER_READ_TIMEOUT")
    throw new EbayListingSyncError("EBAY_REGISTRATION_READ_TIMEOUT", "The eBay listing identity check timed out before a complete response arrived.", { cause: error });
  if (error.code === "EBAY_REGISTRATION_PROVIDER_READ_UNAVAILABLE")
    throw new EbayListingSyncError("EBAY_REGISTRATION_READ_FAILED", "The eBay listing identity check could not reach eBay.", { cause: error });
  if (error.code !== "EBAY_REGISTRATION_PROVIDER_READ_FAILED") throw error;
  const status = "context" in error && error.context && typeof error.context === "object" && "status" in error.context
    ? error.context.status : undefined;
  if (status === 401) throw new EbayListingSyncError("EBAY_AUTH_REQUIRED", "eBay rejected the authorization used to verify this listing. Review the connection settings.", { cause: error });
  if (status === 403) throw new EbayListingSyncError("EBAY_PROVIDER_ACCESS_DENIED", "eBay denied access while verifying this listing. Review the account's permission to access the listing.", { cause: error });
  if (status === 429) throw new EbayListingSyncError("EBAY_PROVIDER_RATE_LIMITED", "eBay is limiting listing identity checks. Wait before checking again.", { cause: error });
  if (status === 408 || (typeof status === "number" && status >= 500))
    throw new EbayListingSyncError("EBAY_REGISTRATION_READ_FAILED", "eBay could not finish the listing identity check.", { cause: error });
  throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_INVALID", "eBay refused a required listing identity lookup. Review the saved account, SKU, offer and listing mappings.", { cause: error });
}
