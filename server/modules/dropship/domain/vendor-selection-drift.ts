import { createHash } from "node:crypto";
import { DropshipError } from "./errors";

/**
 * The form a step 1 save's effects are confirmed in (PLAN-B v4.1 §7.5, §7.6; PR C, PLAN-C v4.1 §4.5, §4.6): the
 * effect kinds, the entry tuples, the two-part effects hash and the drift rule. Pure, and imported only from
 * node:crypto and this domain's errors, so the step 1 browser stubs call these very functions (TST-10) where the
 * effects decision itself (vendor-selection-effects.ts) cannot be imported: it reaches the stock decision, whose
 * imports load Card Shellz's listing lifecycle repositories.
 */

export const SELECTION_EFFECTS = [
  "goesToZero", "startsSelling", "ends", "stillEnding", "endReview", "endedReAdd", "removedWithProduct",
] as const;
export type SelectionEffect = (typeof SELECTION_EFFECTS)[number];

/** `[storeConnectionId, listingId, productVariantId, effect]`; `[0, 0, size, "removedWithProduct"]` for a hidden pick. */
export type SelectionEffectEntry = readonly [number, number, number, SelectionEffect];

/** The two sets a save's ends are confirmed by (the page echoes them, §4.6), each unique and ascending. */
export interface SelectionEndSets {
  listingIds: readonly number[];
  hiddenRemovedIds: readonly number[];
}

/** sha256 of the canonical (sorted) entries, so it does not depend on read order and changes with any entry's bucket. */
export function selectionEffectsHash(entries: readonly SelectionEffectEntry[]): string {
  return createHash("sha256").update(JSON.stringify(sortEntries(entries))).digest("hex");
}

/** sha256 of the two end sets, each unique and ascending (§4.5, FID-11): what the vendor confirmed is ended. */
export function selectionEndsHash(ends: SelectionEndSets): string {
  return createHash("sha256").update(JSON.stringify({
    listingIds: uniqueAscending(ends.listingIds), hiddenRemovedIds: uniqueAscending(ends.hiddenRemovedIds),
  })).digest("hex");
}

/** The effects hash from its two parts: sha256(endsHash ":" otherEntriesHash). */
export function combineSelectionEffectsHash(endsHash: string, otherEntriesHash: string): string {
  return createHash("sha256").update(`${endsHash}:${otherEntriesHash}`).digest("hex");
}

/**
 * Whether a save's echo is the preview the vendor confirmed (§4.6, FID-11): the echoed end sets and other entries'
 * hash combine to the confirmed effects hash. A page bug or a forged body can therefore never widen what is ended.
 */
export function selectionEndsEchoMatches(input: {
  expectedEffectsHash: string; expectedEnds: SelectionEndSets; expectedOtherEntriesHash: string;
}): boolean {
  if (!SHA256_HEX.test(input.expectedOtherEntriesHash) || !SHA256_HEX.test(input.expectedEffectsHash)) return false;
  return combineSelectionEffectsHash(selectionEndsHash(input.expectedEnds), input.expectedOtherEntriesHash) === input.expectedEffectsHash;
}

export type SelectionEffectsComparison =
  | { outcome: "unchanged"; effectsHash: string }
  /** No adds: proceed; the result and audit carry the actual effects and both hashes. */
  | { outcome: "drifted"; expectedEffectsHash: string; actualEffectsHash: string }
  /** Anything else that differs: refuse (409 `DROPSHIP_SELECTION_EFFECTS_CHANGED`); the page re-confirms. */
  | { outcome: "changed"; expectedEffectsHash: string; actualEffectsHash: string };

/**
 * The drift rule (§7.5; PR C §4.6, D41). The save recomputes the effects;
 * when they differ from what the vendor confirmed, a change with no adds
 * proceeds, but only when it ends no listing and removes no hidden pick the
 * vendor did not confirm: the actual end sets must be subsets of the echoed
 * ones (`expectedEnds`, already proven against the confirmed hash). Fewer
 * proceeds and is reported; another one, even at the same count, is refused.
 * With no adds every touched size is unpicked after the change, so no
 * `startsSelling` entry can appear: drift (an eBay end, a store pause) can
 * only move entries between `goesToZero`, `ends` and nothing (V39).
 * `addIds` are the ids the request asked to add.
 */
export function compareSelectionEffects(input: {
  expectedEffectsHash: string;
  actualEffectsHash: string;
  addIds: readonly number[];
  expectedEnds: SelectionEndSets;
  actualEnds: SelectionEndSets;
}): SelectionEffectsComparison {
  for (const [field, value] of [["expectedEffectsHash", input.expectedEffectsHash], ["actualEffectsHash", input.actualEffectsHash]] as const) {
    if (!SHA256_HEX.test(value)) {
      throw new DropshipError(
        "DROPSHIP_SELECTION_CHANGE_INVALID_INPUT",
        // PROPOSED (Stage 3/5, step 1 plan S2-5)
        "The confirmed effects are not recognised. Check the numbers and save again.",
        { classification: "permanent", field },
      );
    }
  }
  if (input.expectedEffectsHash === input.actualEffectsHash) return { outcome: "unchanged", effectsHash: input.actualEffectsHash };
  const hashes = { expectedEffectsHash: input.expectedEffectsHash, actualEffectsHash: input.actualEffectsHash };
  if (input.addIds.length > 0) return { outcome: "changed", ...hashes };
  const confirmed = isSubset(input.actualEnds.listingIds, input.expectedEnds.listingIds)
    && isSubset(input.actualEnds.hiddenRemovedIds, input.expectedEnds.hiddenRemovedIds);
  return confirmed ? { outcome: "drifted", ...hashes } : { outcome: "changed", ...hashes };
}

function isSubset(actual: readonly number[], expected: readonly number[]): boolean {
  const allowed = new Set(expected);
  return actual.every((id) => allowed.has(id));
}

function uniqueAscending(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Ascending by store, then listing, then size, then kind. */
export function sortEntries(entries: readonly SelectionEffectEntry[]): SelectionEffectEntry[] {
  return [...entries].sort((left, right) =>
    left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || compareText(left[3], right[3]));
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
