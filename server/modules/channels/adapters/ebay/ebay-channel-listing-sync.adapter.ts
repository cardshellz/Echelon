import type { ChannelListingSyncAdapter } from "../../../marketplace-listings/application/channel-listing-sync.service";
import type { ChannelListingSyncCommand, ChannelListingSyncState, ChannelListingSyncBlocker } from "../../../marketplace-listings/domain/channel-listing-sync";
import { ebayProductSyncResultSchema, type EbayListingSyncJob, type EbayProductSyncResult } from "@shared/types/ebay-listing-sync";
import type { StoredEbayListingSyncJob } from "../../ebay-listing-sync.domain";
import type { EbayListingPushResult } from "../../ebay-listing-push.service";

export function syncResultForJob(job: EbayListingSyncJob | StoredEbayListingSyncJob): EbayProductSyncResult {
  const result = ebayProductSyncResultSchema.parse({ synced: 0, priceChanges: 0, qtyChanges: 0, policyChanges: 0, errors: 0, details: [], jobs: [job] });
  if ("result" in job && job.state === "completed" && job.result) return { ...job.result, jobs: result.jobs };
  if (job.state === "needs_attention" || job.state === "awaiting_evidence") {
    result.errors = 1;
    result.details.push({ success: false, productId: job.productId, code: job.code ?? undefined, error: job.message ?? "Open this saved request to resolve its blocker." });
  } else result.pending = 1;
  return result;
}
/** Translation and durable handoff only. The shared owner decides create versus
 * update; existing execution owners retain remote observation and write guards. */
export class EbayChannelListingSyncAdapter implements ChannelListingSyncAdapter<EbayProductSyncResult> {
  constructor(private readonly deps: {
    receipt(command: ChannelListingSyncCommand): Promise<EbayListingSyncJob | StoredEbayListingSyncJob | null>;
    state(productId: number): Promise<ChannelListingSyncState>;
    update(command: ChannelListingSyncCommand): Promise<EbayProductSyncResult>;
    publish(command: ChannelListingSyncCommand): Promise<EbayListingPushResult>;
    block(command: ChannelListingSyncCommand, blocker: ChannelListingSyncBlocker): Promise<EbayListingSyncJob>;
  }) {}
  async receipt(command: ChannelListingSyncCommand) {
    const saved = await this.deps.receipt(command);
    return saved ? syncResultForJob(saved) : null;
  }
  state(command: ChannelListingSyncCommand) { return this.deps.state(command.productId); }
  async admit(command: ChannelListingSyncCommand, operation: "create_or_adopt" | "update") {
    const saved = await this.receipt(command);
    if (saved) return saved;
    if (operation === "update") return this.deps.update(command);
    const result = await this.deps.publish(command);
    if (result.success && result.status === "success" && result.job?.state === "completed" && result.listingId)
      return ebayProductSyncResultSchema.parse({ synced: result.variantCount, priceChanges: 0, qtyChanges: 0, policyChanges: 0,
        errors: 0, pending: 0, jobs: [result.job], details: [] });
    if (result.job) return syncResultForJob(result.job);
    // No durable receipt is not completion, even after a lost acknowledgement.
    return ebayProductSyncResultSchema.parse({ synced: 0, priceChanges: 0, qtyChanges: 0, policyChanges: 0,
      errors: 1, details: [{ success: false, productId: command.productId, code: result.code,
        error: result.error ?? "The request could not be confirmed. Retry the same saved request.", issue: result.issue }] });
  }
  async block(command: ChannelListingSyncCommand, blocker: ChannelListingSyncBlocker) {
    return syncResultForJob(await this.deps.block(command, blocker));
  }
}
