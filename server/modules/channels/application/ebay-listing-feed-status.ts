import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const stateSchema = z.object({
  variantId: id,
  listingRecordId: id.nullable(),
  externalListingId: z.string().trim().min(1).nullable(),
  syncStatus: z.string().nullable(),
  syncError: z.string().nullable(),
});
export type EbayFeedVariantListingState = z.infer<typeof stateSchema>;

/** The feed describes current content intent. Retained excluded members keep
 * their saved history, but cannot supply a current included product's error.
 * The caller passes membership from the existing eligibility resolver. */
export function resolveEbayFeedListingState(
  states: readonly EbayFeedVariantListingState[],
  includedVariantIds: readonly number[],
): { syncStatus: string | null; syncError: string | null; isListed: boolean; isEnded: boolean; needsPublicationCheck: boolean; unlinkedVariantIds: number[] } {
  const included = new Set(z.array(id).parse(includedVariantIds));
  const candidates = z.array(stateSchema).parse(states)
    .filter(state => included.has(state.variantId) && state.listingRecordId !== null);
  const hasError = (state: EbayFeedVariantListingState) => state.syncStatus === "error" || Boolean(state.syncError);
  candidates.sort((left, right) => Number(hasError(right)) - Number(hasError(left)) || right.listingRecordId! - left.listingRecordId!);
  const current = candidates[0];
  // A quantity acknowledgement can mark a local row synced before publication.
  // A newly selected catalog variant with no channel row is separate from an
  // incomplete publication attempt. It must not block updates to a saved listing.
  // Existing offer-only, pending, conflicting or duplicate rows still need review.
  const mappedIds = new Set(candidates.map(state => state.variantId));
  const hasCompletePublication = candidates.length > 0 && mappedIds.size === candidates.length &&
    candidates.every(state => state.externalListingId !== null) &&
    new Set(candidates.map(state => state.externalListingId)).size === 1;
  const coversSelection = mappedIds.size === included.size;
  const hasCurrentListing = candidates.every(state => ["synced", "error"].includes(state.syncStatus ?? ""));
  const isEnded = included.size > 0 && coversSelection && mappedIds.size === candidates.length
    && candidates.every(state => ["ended", "deleted"].includes(state.syncStatus ?? ""));
  return {
    syncStatus: current?.syncStatus ?? null,
    syncError: current?.syncError ?? null,
    isListed: hasCompletePublication && candidates.every(state => state.syncStatus === "synced" && !hasError(state)),
    isEnded,
    needsPublicationCheck: candidates.length > 0 && (!hasCompletePublication || (!hasCurrentListing && !isEnded)),
    unlinkedVariantIds: [...included].filter(variantId => !mappedIds.has(variantId)),
  };
}
