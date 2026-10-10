import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const stateSchema = z.object({
  variantId: id,
  listingId: id.nullable(),
  syncStatus: z.string().nullable(),
  syncError: z.string().nullable(),
});
export type EbayFeedVariantListingState = z.infer<typeof stateSchema>;

/** The feed describes current content intent. Retained excluded members keep
 * their saved history, but cannot supply a current included product's error.
 * The caller passes membership from the existing eligibility resolver. */
export function selectEbayFeedListingState(
  states: readonly EbayFeedVariantListingState[],
  includedVariantIds: readonly number[],
): EbayFeedVariantListingState | null {
  const included = new Set(z.array(id).parse(includedVariantIds));
  const candidates = z.array(stateSchema).parse(states)
    .filter(state => included.has(state.variantId) && state.listingId !== null);
  const hasError = (state: EbayFeedVariantListingState) => state.syncStatus === "error" || Boolean(state.syncError);
  candidates.sort((left, right) => Number(hasError(right)) - Number(hasError(left)) || right.listingId! - left.listingId!);
  return candidates[0] ?? null;
}
