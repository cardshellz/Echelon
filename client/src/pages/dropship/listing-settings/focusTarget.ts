/**
 * Where focus goes when the element that had it leaves the page (Listing
 * settings 11.2, PLAN10 3.4, CUX#11): the first of `candidates` still on the
 * page, in order (the opener, else the Category settings card's heading, else
 * the step's heading); null when none is. One rule for every surface that
 * hands focus on: the older-rules sheet when it closes, and the one-time
 * notice's line after [Got it] takes it away.
 */
export function firstConnected(candidates: readonly (HTMLElement | null | undefined)[]): HTMLElement | null {
  return candidates.find((element): element is HTMLElement => element !== null && element !== undefined && element.isConnected) ?? null;
}
