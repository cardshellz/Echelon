import type { EbayListingInspection } from "../../marketplace-listings/domain/ebay-listing-inspection";
import { classifyInspectionIssue, LISTING_END_CODES, type ListingEndFailure } from "./listing-end-errors";

/**
 * What eBay shows of the listing an end is about (PR C, PLAN-C v4.1 §5.5 step 4; SAF-1, DC9): Dropship's own copy of
 * the Card Shellz channels' rule `resolveEbayPublicationTarget` (channels/ebay-publication-completion.domain.ts),
 * which the channels withdrawal uses to observe and verify (ebay-listing-withdrawal.service.ts). Dropship keeps its
 * own copy instead of importing the channels module (CLAUDE.md §2). Pure: the inspection comes from the shared
 * registration observer's `inspectExistingPublication`; "diagnostic reads are not publication proof"
 * (ebay-listing-inspection.ts), so only a verified `publication` proves a listing is for sale, and only the stored
 * offer, read as the SKU's one offer on the marketplace, can prove that nothing is.
 */

/** The identity the claim resolved, as the remote work reads it (a ListingMemberIdentity satisfies it). */
export interface ListingEndObservedIdentity {
  accountId: string | null;
  market: string;
  externalSku: string | null;
  /** The stored eBay listing (item) id, or null when none is stored. */
  externalProductId: string | null;
  /** The stored eBay offer id. */
  externalVariantId: string | null;
}

export type ListingEndObservation =
  | { kind: "published" }
  | { kind: "unpublished" }
  | { kind: "failure"; failure: ListingEndFailure };

function failure(failureValue: ListingEndFailure): ListingEndObservation {
  return { kind: "failure", failure: failureValue };
}

/**
 * The rules, in order (first match wins):
 * 1. Another eBay account answered → ACCOUNT_CHANGED.
 * 2. The SKU's own read issue → its class (classifyInspectionIssue: an offer of another marketplace or SKU is an
 *    identity mismatch; 401/403/429/5xx or none may pass; any other 4xx is refused).
 * 3. A group (inventory item group, or more than one SKU) → SHARED_LISTING: the worker never withdraws a group.
 * 4. Our offer must be there (SAF-1): exactly one offer of the SKU on the marketplace, with the stored offer id and
 *    the SKU (or none). An absent SKU (no offers), another offer or two offers → IDENTITY_MISMATCH, never "nothing
 *    published".
 * 5. Our offer PUBLISHED → a verified publication of exactly this SKU and offer on the marketplace, with the stored
 *    listing id when one is stored → published; another listing, member or marketplace → IDENTITY_MISMATCH; no
 *    verified publication → READ_FAILED ("not proven").
 * 6. Our offer UNPUBLISHED with no publication → unpublished; anything else → READ_FAILED.
 */
export function resolveListingEndObservation(identity: ListingEndObservedIdentity, inspection: EbayListingInspection): ListingEndObservation {
  const offerId = identity.externalVariantId;
  const sku = identity.externalSku;
  if (offerId === null || sku === null || identity.accountId === null) {
    // The claim never resolves an identity without them (§5.4 g); a row that has one is broken, not eBay.
    return failure({ code: LISTING_END_CODES.identityMissing, detail: { reason: "resolved_identity_incomplete" } });
  }
  if (inspection.providerAccount.provider !== "ebay" || inspection.providerAccount.externalAccountId !== identity.accountId) {
    return failure({ code: LISTING_END_CODES.accountChanged, detail: { reason: "observed_account_differs" } });
  }
  const read = inspection.skus.filter((entry) => entry.sku === sku);
  if (read.length !== 1) return failure({ code: LISTING_END_CODES.identityMismatch, detail: { reason: "sku_not_read" } });
  const entry = read[0]!;
  if (entry.issue) return failure(classifyInspectionIssue(entry.issue));
  if (inspection.groupKey !== null || (inspection.groupSkus !== null && inspection.groupSkus.length > 1)) {
    return failure({ code: LISTING_END_CODES.sharedListing, detail: { reason: "inventory_item_group" } });
  }
  if (entry.offers.length !== 1) {
    return failure({ code: LISTING_END_CODES.identityMismatch,
      detail: { reason: entry.offers.length === 0 ? "offer_absent" : "several_offers", offers: entry.offers.length } });
  }
  const offer = entry.offers[0]!;
  if (offer.offerId !== offerId || (offer.sku !== null && offer.sku !== sku)) {
    return failure({ code: LISTING_END_CODES.identityMismatch, detail: { reason: "another_offer" } });
  }
  const publication = inspection.publication;
  if (offer.status === "PUBLISHED") {
    if (publication === null) return failure({ code: LISTING_END_CODES.readFailed, detail: { reason: "publication_not_proven" } });
    const members = publication.members;
    const sameListing = identity.externalProductId === null || publication.listingIdentity.externalId === identity.externalProductId;
    const sameMember = members.length === 1 && members[0]!.sku === sku && members[0]!.offerIdentity?.externalId === offerId;
    if (!publication.isPublished || publication.marketplaceId !== identity.market || !sameListing || !sameMember) {
      return failure({ code: LISTING_END_CODES.identityMismatch, detail: { reason: "publication_differs" } });
    }
    return { kind: "published" };
  }
  if (offer.status === "UNPUBLISHED" && publication === null) return { kind: "unpublished" };
  return failure({ code: LISTING_END_CODES.readFailed, detail: { reason: "status_not_proven" } });
}
