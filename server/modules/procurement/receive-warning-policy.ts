/** These classifications compared other metadata with the receipt's accepted
 * count unit. They remain readable as history, never as current exceptions.
 * Actual count/source validation belongs to the receiving command owner. */
export const RETIRED_RECEIVE_WARNING_KINDS = [
  "uom_disagreement",
  "base_unit_pack_conflict",
  "variant_base_unit_misconfig",
  "variant_missing_parent",
] as const;

export const RETIRED_RECEIVE_EXCEPTION_KINDS: readonly string[] =
  RETIRED_RECEIVE_WARNING_KINDS.map(kind => `receive_${kind}`);

const retiredExceptions: ReadonlySet<string> = new Set(RETIRED_RECEIVE_EXCEPTION_KINDS);

export function isRetiredReceiveExceptionKind(kind: string): boolean {
  return retiredExceptions.has(kind);
}
