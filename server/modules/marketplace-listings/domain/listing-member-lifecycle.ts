import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { ListingMemberIdentity, ListingMemberRetirement } from "@shared/types/listing-member-lifecycle";
import type { StockPublicationSelection } from "@shared/types/stock-publication-selection";

export function listingMemberIdentityKey(identity: ListingMemberIdentity): string {
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

/** Local connection IDs must not split the lock for the same remote member. */
export function listingMemberRemoteKey(identity: ListingMemberIdentity): string {
  return createHash("sha256").update(canonicalJson([identity.provider,identity.environment,identity.accountId,identity.market,
    identity.externalVariantId ?? identity.externalSku])).digest("hex");
}

export function isArchivedCatalogMember(input: { productActive: boolean | null; variantActive: boolean | null; productStatus?: string | null }): boolean {
  return input.productActive === false || input.variantActive === false || input.productStatus === "archived";
}

/** Catalog owns archival. Listings owns remote retirement. Stock must never
 * recreate a mapping or publish quantities for an archived catalog member. */
export function archivedListingMemberSelection(input: {
  productVariantId: number;
  archived: boolean;
  retirement?: ListingMemberRetirement | null;
}): StockPublicationSelection["variants"][number] | null {
  if (!input.archived) return null;
  const retirement = input.retirement;
  return {
    productVariantId: input.productVariantId, action: "none", blockers: [], catalogArchived: true, listingSelected: false,
    reason: retirement?.state === "retired"
      ? "This archived variant's exact external listing was verified unpublished."
      : "This variant is archived. The listing lifecycle owns its external removal separately from active stock updates.",
    ...(retirement?.state === "retired" && retirement.verifiedAt && retirement.identity.accountId && retirement.identity.externalSku ? { retirementEvidence: {
      operationId: retirement.operationId, externalAccountId: retirement.identity.accountId,
      externalSku: retirement.identity.externalSku, externalOfferId: retirement.identity.externalVariantId,
      externalListingId: retirement.identity.externalProductId,
      externalInventoryItemId: retirement.identity.externalInventoryItemId ?? retirement.identity.externalSku,
    } } : {}),
  };
}

export class ListingMemberLifecycleError extends Error {
  constructor(readonly code: string, message: string, readonly outcome: "not_submitted" | "unknown" = "not_submitted") {
    super(message); this.name = "ListingMemberLifecycleError";
  }
}
