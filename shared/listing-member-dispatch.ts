import type { ListingMemberRetirement } from "./types/listing-member-lifecycle";

/** A terminal superseded status is not evidence that an earlier send failed.
 * Older records can also carry this evidence only in their immutable events. */
export function hasUnconfirmedMemberDispatch(record: ListingMemberRetirement): boolean {
  if (record.unconfirmedPriorDispatch === true) return true;
  if (record.state === "retired") return false;
  return record.dispatchStatus === "unknown" || record.dispatchStatus === "accepted"
    || record.dispatchStatus === "authorized" || record.recoveryRequired === true
    || record.state === "retiring";
}
