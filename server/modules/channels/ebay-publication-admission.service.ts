import { z } from "zod";
import { ebayListingSyncJobSchema } from "@shared/types/ebay-listing-sync";
import type { EbayListingSyncIdentity, StoredEbayListingSyncJob } from "./ebay-listing-sync.domain";
import { EbayListingSyncError } from "./ebay-listing-sync.domain";
import type { EbayListingSyncService } from "./ebay-listing-sync.service";
import { EbayListingPushSkipped, ebayListingPushFailure, type EbayListingPushResult } from "./ebay-listing-push.service";

export interface EbayPublicationAdmissionDependencies {
  channelId: number;
  jobs: Pick<EbayListingSyncService, "getByCommand" | "getAdmission" | "enqueue" | "recordAdmissionFailure">;
  readSource(productId: number): Promise<EbayListingSyncIdentity>;
}

/** Admission owns no provider writes. All publication work belongs to the same
 * saved listing worker, including initial Publish and reviewed continuation. */
export async function admitEbayPublication(
  input: { productId: number; commandKey: string; actor: string },
  dependencies: EbayPublicationAdmissionDependencies,
): Promise<EbayListingPushResult> {
  const command = z.object({ productId: z.number().int().positive().max(2147483647), commandKey: z.string().uuid(),
    actor: z.string().trim().min(1).max(200) }).strict().parse(input);
  let source: EbayListingSyncIdentity | undefined;
  let admissionAttempted = false;
  try {
    // A previous execution may already have populated the listing IDs. Recover
    // its exact command before rereading inputs that legitimately changed.
    const replay = await dependencies.jobs.getByCommand(command.commandKey, dependencies.channelId);
    if (replay) {
      if (replay.productId !== command.productId || replay.operation !== "publish")
        throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This publication request belongs to another product or operation. Check its saved result before starting another request.");
      // The enqueue owner checks both the immutable identity and actor; reading
      // a receipt alone is not authority to reuse another requester's command.
      admissionAttempted = true;
      return publicationResult(await dependencies.jobs.enqueue(replay.identity, command.actor, command.commandKey, "publish"));
    }
    const rejected = await dependencies.jobs.getAdmission(command.commandKey, dependencies.channelId);
    if (rejected) {
      if (rejected.productId !== command.productId || rejected.operation !== "publish")
        throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This publication request belongs to another product.");
      return { ...ebayListingPushFailure(command.productId, new EbayListingSyncError(rejected.code ?? "EBAY_LISTING_PREFLIGHT_FAILED",
        rejected.message ?? "This saved publication request was rejected. Correct its issue and start a new request.")), job: rejected };
    }
    source = await dependencies.readSource(command.productId);
    if (source.productId !== command.productId || source.channelId !== dependencies.channelId)
      throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "Publication inputs do not belong to this product and channel.");
    admissionAttempted = true;
    return publicationResult(await dependencies.jobs.enqueue(source, command.actor, command.commandKey, "publish"));
  } catch (error) {
    const failure = ebayListingPushFailure(command.productId, error);
    // A conflict or uncertain commit must retain its command. Do not journal a
    // false refusal over a request that might already have been accepted.
    if (["EBAY_SYNC_REPLAY_CONFLICT", "EBAY_SYNC_PERSISTENCE_FAILED", "EBAY_MAPPING_PERSISTENCE_FAILED"].includes(failure.code ?? "")) return failure;
    // These explicit repository refusals return only after rollback succeeded.
    // Preserve the actual blocker and its saved-job reference, rather than
    // reporting an unknown commit for a request that was never admitted.
    if (error instanceof EbayListingSyncError && ["EBAY_PUBLICATION_PRIOR_WORK_REQUIRED", "PUBLICATION_SCOPE_BUSY",
      "EBAY_SYNC_IDENTITY_CHANGED", "EBAY_SYNC_OPERATION_INVALID"].includes(error.code)) return failure;
    if (admissionAttempted) return ebayListingPushFailure(command.productId, new EbayListingSyncError("EBAY_SYNC_ADMISSION_UNSAVED",
      "The publication request's result could not be confirmed. Retry this same saved request to retrieve its result."));
    if (!(error instanceof EbayListingSyncError) && !(error instanceof EbayListingPushSkipped)) {
      console.error(JSON.stringify({ event: "ebay_publication_admission_read_unconfirmed", productId: command.productId,
        commandKey: command.commandKey, errorName: error instanceof Error ? error.name : "UnknownError" }));
      return ebayListingPushFailure(command.productId, new EbayListingSyncError("EBAY_SYNC_ADMISSION_UNSAVED",
        "The publication inputs could not be read reliably. Retry the same saved request; no refusal has been recorded."));
    }
    try {
      const job = await dependencies.jobs.recordAdmissionFailure({ channelId: dependencies.channelId, productId: command.productId,
        operation: "publish",
        commandKey: command.commandKey, actor: command.actor, variantIds: source?.variants.map(member => member.variantId) ?? [],
        code: failure.code ?? "EBAY_LISTING_PREFLIGHT_FAILED", message: failure.error ?? "The publication request could not be saved." });
      return { ...failure, job };
    } catch {
      return ebayListingPushFailure(command.productId, new EbayListingSyncError("EBAY_SYNC_ADMISSION_UNSAVED",
        "The publication request's result could not be confirmed. Retry this same saved request to check whether it was accepted."));
    }
  }
}

function publicationResult(stored: StoredEbayListingSyncJob): EbayListingPushResult {
  const job = ebayListingSyncJobSchema.parse(stored);
  const productName = stored.result?.details.find(detail => detail.productName)?.productName ?? `Product ${stored.productId}`;
  const base = { productId: stored.productId, productName, variantCount: stored.identity.variants.length, job };
  if (stored.state === "completed" && stored.result && stored.result.errors === 0) {
    const listingId = stored.providerIdentity?.variants[0]?.listingId;
    if (!listingId) return { ...base, ...ebayListingPushFailure(stored.productId,
      new EbayListingSyncError("EBAY_SYNC_PERSISTENCE_FAILED", "The saved completed publication is missing its verified listing identity. Check this request's saved details."), productName) };
    return { ...base, success: true, status: "success", listingId };
  }
  if (["needs_attention", "awaiting_evidence"].includes(stored.state)) return {
    ...base, ...ebayListingPushFailure(stored.productId, new EbayListingSyncError(stored.code ?? "EBAY_LISTING_OPERATION_FAILED",
      stored.message ?? "The saved publication needs attention."), productName), variantCount: base.variantCount,
  };
  return { ...base, success: false, status: "queued" };
}
