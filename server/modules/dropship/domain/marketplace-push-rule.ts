/**
 * eBay sync-back's push-time rule (plan v4 §5, SB9): which job items may
 * relist a listing the vendor ended on eBay. Pure: the caller passes the
 * item's stored result.
 */

/** The job item result field the queue writes for an item the vendor's own press created (dropship-listing-preview.repository.ts). */
export const RELIST_ALLOWED_RESULT_FIELD = "relistAllowed";

/**
 * Only an item the vendor's own press (a push or a publish run they started)
 * queued may relist a listing they ended on eBay, and only on its first send:
 * any earlier outcome (every terminal write records `push`) or a stale
 * recovery (`staleRecovery`) means it was queued again by Card Shellz, and a
 * requeue never relists. A pause keeps it (it records neither).
 */
export function isVendorRelistAllowed(result: Record<string, unknown> | null): boolean {
  if (!result || result[RELIST_ALLOWED_RESULT_FIELD] !== true) return false;
  return result.push === undefined && result.staleRecovery === undefined;
}
