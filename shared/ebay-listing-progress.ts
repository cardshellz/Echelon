import type { EbayListingSyncJob, EbayListingSyncPhase } from "./types/ebay-listing-sync";
import { resolveEbayListingIssue } from "./ebay-listing-issue";

const phaseDescriptions: Record<EbayListingSyncPhase, { started: string; completed: string }> = {
  prepare_listing: { started: "Checking the existing listing and preparing current content", completed: "Listing identity and current content prepared" },
  recover_prior_requests: { started: "Checking earlier eBay request outcomes", completed: "Earlier eBay request outcomes checked" },
  inspect_content: { started: "Comparing the current listing and pictures", completed: "Current listing and pictures compared" },
  prepare_inventory: { started: "Preparing the listing's inventory connection", completed: "Inventory connection prepared" },
  update_offer: { started: "Updating the listing's offer details", completed: "Offer update recorded" },
  update_item: { started: "Updating variant content and pictures", completed: "Variant content update recorded" },
  update_group: { started: "Updating listing variations and shared pictures", completed: "Listing variations update recorded" },
  publish: { started: "Sending the publication to eBay", completed: "Publication response recorded" },
  publication_readback: { started: "Checking the published listing on eBay", completed: "Published listing checked" },
  verify: { started: "Verifying the listing and pictures on eBay", completed: "Verification recorded; saving the result" },
  withdraw: { started: "Removing the listing from eBay", completed: "Removal response recorded" },
};

export interface EbayListingJobPresentation {
  summary: string;
  phase: string | null;
  verification: string | null;
  activity: string | null;
  times: Array<{ label: string; at: string }>;
}

/** Presentation only: the saved job owns state, retry eligibility and completion.
 * Event completion is an intermediate checkpoint, never overall success. */
export function presentEbayListingJob(job: EbayListingSyncJob): EbayListingJobPresentation {
  const progress = job.progress;
  const operation = job.operation === "withdraw" ? "Removal" : job.operation === "publish" ? "Publishing" : "Listing update";
  const issue = job.issue ?? (job.code ? resolveEbayListingIssue({ code: job.code, message: job.message,
    productId: job.productId, jobId: job.id, state: job.state }) : null);
  const phase = progress?.phase && progress.phaseState
    ? progress.phase === "verify" && job.operation === "withdraw"
      ? progress.phaseState === "started" ? "Verifying removal on eBay" : "Removal verification recorded; saving the result"
      : phaseDescriptions[progress.phase][progress.phaseState] : null;
  let summary: string;
  switch (job.state) {
    case "queued": summary = progress?.queuedAhead != null && progress.queuedAhead > 0
      ? `Waiting for ${progress.queuedAhead} earlier update${progress.queuedAhead === 1 ? "" : "s"}` : "Queued for eBay"; break;
    case "running": summary = phase ?? `${operation} in progress`; break;
    case "recovering": summary = issue?.title ?? "Waiting for an automatic check"; break;
    case "awaiting_evidence": summary = issue?.title ?? "Checking an earlier response"; break;
    case "needs_attention": summary = issue?.title ?? "Update stopped"; break;
    case "completed": summary = job.operation === "withdraw"
      ? "Removed from eBay. The provider's listing state is verified."
      : job.operation === "publish" ? "Published. Listing and pictures verified." : "Listing update and pictures verified.";
  }
  if (job.state === "completed") return { summary, phase: null, verification: null, activity: null, times: [] };

  const times: EbayListingJobPresentation["times"] = [];
  if (progress) {
    times.push({ label: "Requested", at: progress.requestedAt });
    times.push({ label: "Last recorded activity", at: progress.lastActivityAt });
    if (job.state === "queued" && progress.lastWorkerActivityAt) {
      times.push({ label: "Latest queue activity", at: progress.lastWorkerActivityAt });
    }
  }
  if (job.state === "recovering" || job.state === "awaiting_evidence") {
    times.push({ label: "Next automatic check eligible at", at: job.nextAttemptAt });
  }
  return {
    summary,
    phase: job.state === "queued" || job.state === "running" ? null : phase,
    // A request can stop after a partial write. Only completion confirms the
    // whole result; pending copy must not claim that nothing has changed.
    verification: job.operation === "withdraw" ? "Removal from eBay has not yet been verified."
      : job.operation === "publish" ? "This request has not yet confirmed publication and current pictures."
        : "This request has not yet confirmed that the listing and pictures are current.",
    activity: job.state === "queued" && progress && progress.lastWorkerActivityAt === null
      ? "No recent queue activity is available." : null,
    times,
  };
}
