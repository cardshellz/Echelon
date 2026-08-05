import type { MarketplaceListingRegistrationStatus } from "./marketplace-listing-registration-status";

export type MarketplaceListingReconciliation =
  | Readonly<{ kind: "normal" }>
  | Readonly<{ kind: "up_to_date" }>
  | Readonly<{ kind: "update_available"; addedVariantIds: readonly number[] }>
  | Readonly<{
      kind: "replacement_required";
      addedVariantIds: readonly number[];
      staleVariantIds: readonly number[];
    }>
  | Readonly<{ kind: "verification_required"; reason: "listing_changed" }>;

export function reconcileMarketplaceListing(input: {
  readonly externalListingId: string | null;
  readonly desiredVariantIds: readonly number[];
  readonly registration: MarketplaceListingRegistrationStatus | null;
}): MarketplaceListingReconciliation {
  if (!input.registration) return Object.freeze({ kind: "normal" });
  if (input.registration.externalListingId !== input.externalListingId) {
    return Object.freeze({ kind: "verification_required", reason: "listing_changed" });
  }

  const desired = distinctSortedIds(input.desiredVariantIds, "desiredVariantIds");
  const registered = distinctSortedIds(
    input.registration.registeredVariantIds,
    "registeredVariantIds",
  );
  const desiredSet = new Set(desired);
  const registeredSet = new Set(registered);
  const addedVariantIds = desired.filter((id) => !registeredSet.has(id));
  const staleVariantIds = registered.filter((id) => !desiredSet.has(id));

  if (staleVariantIds.length > 0) {
    return Object.freeze({
      kind: "replacement_required",
      addedVariantIds: Object.freeze(addedVariantIds),
      staleVariantIds: Object.freeze(staleVariantIds),
    });
  }
  if (addedVariantIds.length > 0) {
    return Object.freeze({
      kind: "update_available",
      addedVariantIds: Object.freeze(addedVariantIds),
    });
  }
  return Object.freeze({ kind: "up_to_date" });
}

function distinctSortedIds(values: readonly number[], field: string): number[] {
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${field} must contain positive safe integers.`);
  }
  const result = [...new Set(values)].sort((left, right) => left - right);
  if (result.length !== values.length) {
    throw new RangeError(`${field} must not contain duplicate variants.`);
  }
  return result;
}
