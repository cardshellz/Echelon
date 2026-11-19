/**
 * What PR A's selection save knows about PR B's release (step 1 plan S2-5
 * §4.9 item 2, D39, CHK10), so the old code already answers B's changes
 * correctly while old and new dynos overlap.
 */

/**
 * B's migration writes one backfill revision per vendor under the key
 * `legacy-picks-backfill:<vendor_id>` into the revisions table, whose
 * `(vendor_id, idempotency_key)` index is unique (0091:14-15). A vendor key
 * with this prefix would make that migration fail and pin production (Risk
 * 17), so from A on the rules save refuses it.
 */
export const LEGACY_PICKS_IDEMPOTENCY_KEY_PREFIX = "legacy-picks-";

export function isReservedSelectionIdempotencyKey(key: string): boolean {
  return key.trim().startsWith(LEGACY_PICKS_IDEMPOTENCY_KEY_PREFIX);
}
