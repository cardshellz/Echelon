import type { ListingMemberRetirement } from "@shared/types/listing-member-lifecycle";
import { listingMemberIdentityKey, ListingMemberLifecycleError } from "../domain/listing-member-lifecycle";
import type { ListingMemberLifecycleAdapter, ListingMemberLifecycleDependencies, ListingMemberLifecycleSession } from "./listing-member-lifecycle.port";

/** All providers use this state machine. A write receipt never proves removal;
 * only a subsequent observation of the exact saved identity can complete it. */
export async function processListingMemberRetirement(
  session: ListingMemberLifecycleSession,
  dependencies: ListingMemberLifecycleDependencies,
  now: () => Date,
): Promise<ListingMemberRetirement> {
  const record = session.current;
  if (record.state === "retired" || record.state === "superseded" || record.code === "LISTING_MEMBER_IDENTITY_INVALID") return record;
  if (!await session.isCurrent()) return session.save("superseded", "LISTING_MEMBER_SOURCE_CHANGED",
    "The catalog or saved external identity changed. This old removal request will not touch the replacement.", now());

  const failure = (error: unknown, submitted: boolean) => {
    const code = error instanceof ListingMemberLifecycleError ? error.code : "LISTING_MEMBER_PROVIDER_FAILED";
    const detail = error instanceof ListingMemberLifecycleError ? error.message : "The sales channel could not confirm removal.";
    console.error(JSON.stringify({ operation: "listing_member_retirement", operationId: record.operationId,
      provider: record.identity.provider, productVariantId: record.identity.productVariantId, code }));
    // Keep accepted asynchronous work in observation-only recovery even if a
    // read fails. Persistence failures propagate, retaining the last committed
    // intent/evidence instead of erasing a possibly dispatched removal.
    return session.save(submitted ? "retiring" : "failed", code,
      `${detail} This archived variant remains excluded; the listing lifecycle will retry verification.`, now());
  };
  if (record.identity.identityConflict) return failure(new ListingMemberLifecycleError("LISTING_MEMBER_IDENTITY_CONFLICT",
    "Conflicting saved identities exist for this archived variant. Repair its listing link before removal."), false);

  if (dependencies.withPublicationFence) {
    let entered = false;
    try {
      return await dependencies.withPublicationFence(record.identity, pending => {
        entered = true;
        if (pending) return session.save(record.state === "retiring" ? "retiring" : "pending",
          "LISTING_MEMBER_EARLIER_PUBLICATION_PENDING",
          "Waiting for an earlier channel submission to finish before verifying removal. This archived variant remains excluded.", now());
        return processListingMemberRetirement(session, { ...dependencies, withPublicationFence: undefined }, now);
      });
    } catch (error) {
      // Persistence failures inside the protected work must propagate. An
      // account/lock failure before entry is actionable provider admission data.
      if (entered) throw error;
      return failure(error, record.state === "retiring");
    }
  }

  let adapter: ListingMemberLifecycleAdapter;
  const observe = async () => {
    const result = await adapter.observe(record.identity);
    if (listingMemberIdentityKey(result.identity) !== listingMemberIdentityKey(record.identity)) {
      throw new ListingMemberLifecycleError("LISTING_MEMBER_IDENTITY_CHANGED", "The provider returned a different listing identity.");
    }
    return result;
  };
  let retired: boolean;
  try {
    adapter = await dependencies.adapter(record.identity);
    retired = (await observe()).retired;
  } catch (error) {
    return failure(error, record.state === "retiring");
  }
  if (!retired && record.state !== "retiring") {
    if (!await session.isCurrent()) return session.save("superseded", "LISTING_MEMBER_SOURCE_CHANGED",
      "The catalog or saved external identity changed before removal.", now());
    // An audit failure must prevent the external write, not be misclassified as
    // a provider failure. Keep persistence outside the provider catch boundary.
    await session.save("retiring", null, "Removing this archived variant from the sales channel.", now());
    let submitted = false;
    try {
      await adapter.retire(record.identity, record.operationId);
      submitted = true;
      retired = (await observe()).retired;
    } catch (error) {
      return failure(error, submitted || (error instanceof ListingMemberLifecycleError && error.outcome === "unknown"));
    }
  }
  return session.save(retired ? "retired" : "retiring", retired ? null : record.code,
    retired ? "The sales channel confirmed this exact archived variant is no longer published."
      : "The channel has not yet confirmed removal. Echelon will check this exact variant again.", now());
}
