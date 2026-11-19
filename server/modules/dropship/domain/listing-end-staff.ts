import type { ListingEndRequestState, ListingEndStaffAction } from "../../../../shared/dropship/listing-end-ops";
import { listingEndQuantityScope, listingEndResolvedIdentitySchema, type ListingEndResolvedIdentity } from "./listing-end-claims";

/**
 * The staff surface's rules (PR C, PLAN-C v4.1 §10; DC15, DC27, DC32). Pure: the service and the repository pass the
 * request row as read (and again as locked) and get one decision back.
 *
 * - Keys are scoped by action (TST-5): a key equal to the row's `staff_action_key` answers again only for the same
 *   action (200, the row as it is now); the same key with another action is refused. The key is stored with the action
 *   it answered (the migration's `dropship_end_staff_key_chk`).
 * - Only a `failed` request takes a staff action: `pending`/`ending` are the worker's, and every other state is final.
 * - Retry asks inventory planning's recovery about the SKU's open requests first (SAF-3 b): a withdraw Card Shellz
 *   sent whose result was never settled leaves an attempt that refuses every later quantity write on the SKU, so a
 *   retried withdraw could never be admitted. A request that never reached the claim's identity sent nothing, so
 *   nothing of its own can be open; one that recorded a withdraw but has no readable identity is refused (fail closed).
 */

export type ListingEndStaffDecision =
  | { outcome: "apply" }
  | { outcome: "replay" }
  | { outcome: "refused"; reason: "key_reused" | "state_invalid" };

export function decideListingEndStaffAction(
  row: { state: ListingEndRequestState; staffAction: ListingEndStaffAction | null; staffActionKey: string | null },
  request: { action: ListingEndStaffAction; idempotencyKey: string },
): ListingEndStaffDecision {
  if (row.staffActionKey !== null && row.staffActionKey === request.idempotencyKey) {
    return row.staffAction === request.action ? { outcome: "replay" } : { outcome: "refused", reason: "key_reused" };
  }
  if (row.state !== "failed") return { outcome: "refused", reason: "state_invalid" };
  return { outcome: "apply" };
}

export type ListingEndRecoveryScope = ReturnType<typeof listingEndQuantityScope>;

/** The inventory scope a Retry asks recovery about (the admission's own scope, §5.5 step 6), or why there is none. */
export type ListingEndStaffRecoveryCheck =
  | { kind: "scope"; scope: ListingEndRecoveryScope }
  | { kind: "nothing_sent" }
  | { kind: "identity_unreadable" };

export function listingEndStaffRecoveryCheck(row: {
  resolvedIdentity: unknown; withdrawCallCount: number; withdrawRequestedAt: Date | null;
}): ListingEndStaffRecoveryCheck {
  const sentSomething = row.withdrawCallCount > 0 || row.withdrawRequestedAt !== null;
  if (row.resolvedIdentity === null || row.resolvedIdentity === undefined) {
    return sentSomething ? { kind: "identity_unreadable" } : { kind: "nothing_sent" };
  }
  const parsed = listingEndResolvedIdentitySchema.safeParse(row.resolvedIdentity);
  if (!parsed.success) return { kind: "identity_unreadable" };
  return { kind: "scope", scope: listingEndQuantityScope(parsed.data as ListingEndResolvedIdentity) };
}

/** What recovery's answer means for a Retry: go on, wait (a gate or a scope lock was busy), or settle these first. */
export type ListingEndStaffRecoveryOutcome =
  | { outcome: "clear" }
  | { outcome: "busy" }
  | { outcome: "unresolved"; attemptIds: string[] };

export function decideListingEndStaffRecovery(result: { resolved: readonly string[]; unresolved: readonly string[]; busy: boolean }):
  ListingEndStaffRecoveryOutcome {
  // Recovery reads attempts in id order (quantity-provider-response-recovery.repository.ts); the order is kept.
  if (result.unresolved.length > 0) return { outcome: "unresolved", attemptIds: [...result.unresolved] };
  // A busy answer may have skipped an open attempt (a scope lock was held): never read it as clear.
  if (result.busy) return { outcome: "busy" };
  return { outcome: "clear" };
}
