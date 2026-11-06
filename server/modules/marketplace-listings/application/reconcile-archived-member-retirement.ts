import type { ListingMemberRetirement } from "@shared/types/listing-member-lifecycle";
import { hasUnconfirmedPriorMemberDispatch, ListingMemberLifecycleError, validateListingMemberObservation } from "../domain/listing-member-lifecycle";
import type { ListingMemberLifecycleDependencies, ListingMemberLifecycleSession } from "./listing-member-lifecycle.port";
import { processListingMemberRetirement, saveUnconfirmedRetirementObservation } from "./process-listing-member-retirement";

// A still-live result cannot settle an earlier unknown send. Periodic readback
// remains available without polling the same unresolved listing every minute.
const RECONCILIATION_RETRY_MS = 15 * 60_000;

/** Archive is a local catalog decision. Previously recorded automatic removals
 * are superseded only when their complete audit history proves no send; all
 * other old effects are observed without another provider mutation. */
export async function reconcileArchivedMemberRetirement(
  session: ListingMemberLifecycleSession,
  dependencies: ListingMemberLifecycleDependencies,
  now: () => Date,
): Promise<ListingMemberRetirement> {
  const record = session.current;
  if (record.state === "retired" || record.state === "superseded" || record.code === "LISTING_MEMBER_IDENTITY_INVALID") return record;
  if (await session.hasProvenNoDispatch?.()) {
    return session.save("superseded", "LISTING_MEMBER_ARCHIVE_NO_REMOVAL",
      "Archiving stops local updates. This unsent automatic removal was cancelled; the channel listing may still be live.", now());
  }
  // A saved recovery authorization is a separate, explicit operator command.
  // The existing owner rechecks its original scope before dispatch.
  if (record.dispatchStatus === "authorized") return processListingMemberRetirement(session, dependencies, now);
  if (record.identity.identityConflict && session.retryDeferred) return record;

  const failed = (error: unknown): Promise<ListingMemberRetirement> => {
    const code = error instanceof ListingMemberLifecycleError ? error.code : "LISTING_MEMBER_PROVIDER_FAILED";
    console.error(JSON.stringify({ operation: "listing_member_reconciliation", operationId: record.operationId,
      provider: record.identity.provider, productVariantId: record.identity.productVariantId, code }));
    return session.save("failed", code,
      "The channel could not confirm the earlier removal. The saved request remains unresolved; no new removal was sent.",
      now(), { recoveryRequired: true, retryAfterMs: RECONCILIATION_RETRY_MS });
  };
  const observe = async (pending: boolean): Promise<ListingMemberRetirement> => {
    if (pending) return session.save("retiring", "LISTING_MEMBER_EARLIER_PUBLICATION_PENDING",
      "An earlier channel submission is still pending. Echelon will check the saved removal after it finishes.", now());
    if (record.identity.identityConflict) return session.save("failed", "LISTING_MEMBER_IDENTITY_CONFLICT",
      "The saved channel identity is ambiguous. Review the link and earlier removal before changing this listing.", now());
    try {
      const adapter = await dependencies.adapter(record.identity);
      const observation = validateListingMemberObservation(await adapter.observe(record.identity), record.identity);
      if (observation.retired && hasUnconfirmedPriorMemberDispatch(record))
        return saveUnconfirmedRetirementObservation(session, record, now(), RECONCILIATION_RETRY_MS);
      if (observation.retired) return session.save("retired", null,
        "The channel confirmed the exact member from the earlier removal is no longer published.", now());
      return session.save("failed", "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED",
        "An earlier removal may still reach the channel. Check this listing before transferring or publishing it. No new removal was sent.",
        now(), { recoveryRequired: true, verificationAttempts: (record.verificationAttempts ?? 0) + 1,
          retryAfterMs: RECONCILIATION_RETRY_MS });
    } catch (error) {
      return failed(error);
    }
  };
  if (!dependencies.withPublicationFence) return observe(false);
  let entered = false;
  try {
    return await dependencies.withPublicationFence(record.identity, pending => {
      entered = true;
      return observe(pending);
    });
  } catch (error) {
    if (entered) throw error;
    return failed(error);
  }
}
