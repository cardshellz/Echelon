import { z } from "zod";
import type { ListingMemberRetirement } from "@shared/types/listing-member-lifecycle";
import {
  validateListingMemberObservation,
  ListingMemberLifecycleError,
  hasUnconfirmedMemberDispatch,
  hasUnconfirmedPriorMemberDispatch,
} from "../domain/listing-member-lifecycle";
import type {
  ListingMemberLifecycleAdapter,
  ListingMemberLifecycleDependencies,
  ListingMemberLifecycleSession,
} from "./listing-member-lifecycle.port";

export const RETIREMENT_VERIFICATION_LIMIT = 5;
const dispatchReceiptSchema = z.object({ finality: z.enum(["pending", "terminal"]) }).strict();

/** Keep the observed listing state separate from the final outcome of each
 * previously dispatched request. A later observation cannot exclude a late
 * provider write from an earlier request with no final receipt. */
export function saveUnconfirmedRetirementObservation(
  session: ListingMemberLifecycleSession,
  record: ListingMemberRetirement,
  now: Date,
  retryAfterMs?: number,
): Promise<ListingMemberRetirement> {
  return session.save(
    "failed",
    "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED",
    "The channel currently shows this member unpublished, but an earlier removal has no confirmed final response. The listing link is not yet safe to reuse.",
    now,
    {
      recoveryRequired: true,
      verificationAttempts: (record.verificationAttempts ?? 0) + 1,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  );
}

/** One shared dispatch/reconciliation owner. Only an exact observation proves
 * removal. A saved send marker can never authorize an automatic second send. */
export async function processListingMemberRetirement(
  session: ListingMemberLifecycleSession,
  dependencies: ListingMemberLifecycleDependencies,
  now: () => Date,
): Promise<ListingMemberRetirement> {
  let record = session.current;
  if (
    record.state === "retired" ||
    record.state === "superseded" ||
    record.code === "LISTING_MEMBER_IDENTITY_INVALID"
  )
    return record;
  const currentSource = await session.isCurrent();
  if (!currentSource && !hasUnconfirmedMemberDispatch(record))
    return session.save(
      "superseded",
      "LISTING_MEMBER_SOURCE_CHANGED",
      "The catalog or saved external identity changed. This old removal request will not touch the replacement.",
      now(),
    );

  // A previously claimed ID can arrive after another worker deferred this
  // same conflict. Keep the first failure visible without another audit/log.
  if (record.code === "LISTING_MEMBER_IDENTITY_CONFLICT" && session.retryDeferred)
    return record;

  const failure = (error: unknown, submitted: boolean) => {
    const code =
      error instanceof ListingMemberLifecycleError
        ? error.code
        : "LISTING_MEMBER_PROVIDER_FAILED";
    const detail =
      error instanceof ListingMemberLifecycleError
        ? error.message
        : "The sales channel could not confirm removal.";
    console.error(
      JSON.stringify({
        operation: "listing_member_retirement",
        operationId: record.operationId,
        provider: record.identity.provider,
        productVariantId: record.identity.productVariantId,
        code,
      }),
    );
    return session.save(
      submitted ? "retiring" : "failed",
      code,
      detail + (code === "LISTING_MEMBER_IDENTITY_CONFLICT"
        ? " This archived variant remains excluded. Correct the conflicting listing link to resume removal."
        : " This archived variant remains excluded; the listing lifecycle will retry verification."),
      now(),
    );
  };
  if (record.identity.identityConflict)
    return failure(
      new ListingMemberLifecycleError(
        "LISTING_MEMBER_IDENTITY_CONFLICT",
        "Conflicting saved identities exist for this archived variant. Repair its listing link before removal.",
      ),
      false,
    );

  if (dependencies.withPublicationFence) {
    let entered = false;
    try {
      return await dependencies.withPublicationFence(
        record.identity,
        (pending) => {
          entered = true;
          if (pending)
            return session.save(
              record.state === "retiring" ? "retiring" : "pending",
              "LISTING_MEMBER_EARLIER_PUBLICATION_PENDING",
              "Waiting for an earlier channel submission to finish before verifying removal. This archived variant remains excluded.",
              now(),
            );
          return processListingMemberRetirement(
            session,
            { ...dependencies, withPublicationFence: undefined },
            now,
          );
        },
      );
    } catch (error) {
      if (entered) throw error;
      return failure(error, record.state === "retiring");
    }
  }

  let adapter: ListingMemberLifecycleAdapter;
  const observe = async () => {
    return validateListingMemberObservation(
      await adapter.observe(record.identity),
      record.identity,
    );
  };
  let retired: boolean;
  try {
    adapter = await dependencies.adapter(record.identity);
    retired = (await observe()).retired;
  } catch (error) {
    return failure(error, record.state === "retiring");
  }
  if (retired && hasUnconfirmedPriorMemberDispatch(record))
    return saveUnconfirmedRetirementObservation(session, record, now());
  if (!currentSource) {
    // A changed owner cannot authorize another removal, but neither may it
    // erase a request that might already have reached the channel. Reconcile
    // only the exact previously submitted identity; never dispatch from here.
    return session.save(
      retired ? "retired" : "failed",
      retired ? null : "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED",
      retired
        ? "The sales channel confirmed that the member from the earlier removal is no longer published."
        : "An earlier removal may still reach the sales channel after this listing link changed. Check that listing before transferring or publishing it. No new removal was sent.",
      now(),
      retired ? undefined : { recoveryRequired: true, verificationAttempts: (record.verificationAttempts ?? 0) + 1 },
    );
  }
  if (!retired && (record.state === "retiring" || record.recoveryRequired)) {
    const checks = (record.verificationAttempts ?? 0) + 1;
    // Unknown includes the crash window between the durable marker and dispatch.
    // Observation of a still-live member cannot prove that an earlier send failed.
    if (
      record.dispatchStatus !== "accepted" ||
      checks >= RETIREMENT_VERIFICATION_LIMIT
    )
      return session.save(
        "failed",
        "LISTING_MEMBER_RECOVERY_REQUIRED",
        "The exact member is still published, but the previous removal is unconfirmed. Review removal recovery before authorizing another attempt.",
        now(),
        { verificationAttempts: checks, recoveryRequired: true },
      );
    return session.save(
      "retiring",
      record.code,
      "The channel accepted removal but has not confirmed it yet. Echelon will check this exact member again.",
      now(),
      { verificationAttempts: checks },
    );
  }
  if (!retired) {
    if (!(await session.isCurrent()))
      return session.save(
        "superseded",
        "LISTING_MEMBER_SOURCE_CHANGED",
        "The catalog or saved external identity changed before removal.",
        now(),
      );
    const dispatchKey = record.dispatchKey ?? record.operationId;
    // Commit before dispatch on the independent audit connection. A crash here
    // leaves uncertainty which only review or an exact retired observation clears.
    await session.save(
      "retiring",
      null,
      "Removing this archived variant from the sales channel.",
      now(),
      { dispatchStatus: "unknown", dispatchKey, verificationAttempts: 0 },
    );
    let receipt: z.infer<typeof dispatchReceiptSchema>;
    try {
      receipt = dispatchReceiptSchema.parse(await adapter.retire(record.identity, dispatchKey));
    } catch (error) {
      const unknown =
        !(error instanceof ListingMemberLifecycleError) ||
        error.outcome === "unknown";
      return failure(error, unknown);
    }
    // Keep persistence outside provider catches: a failed commit must retain
    // the previous unknown marker rather than classify a write as not sent.
    record = await session.save(
      "retiring",
      null,
      "The channel accepted removal. Verifying the exact member.",
      now(),
      { dispatchStatus: "accepted", dispatchFinality: receipt.finality },
    );
    try {
      retired = (await observe()).retired;
    } catch (error) {
      return failure(error, true);
    }
  }
  // A successful retry confirms only its own dispatch. It cannot settle an
  // older unknown request even when the member is now observed unpublished.
  if (retired && hasUnconfirmedPriorMemberDispatch(record))
    return saveUnconfirmedRetirementObservation(session, record, now());
  return session.save(
    retired ? "retired" : "retiring",
    retired ? null : record.code,
    retired
      ? "The sales channel confirmed this exact archived variant is no longer published."
      : "The channel has not yet confirmed removal. Echelon will check this exact variant again.",
    now(),
  );
}
