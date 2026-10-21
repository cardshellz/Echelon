import type { Pool } from "pg";
import { PublicationRecoveryService } from "../../inventory-planning/application/publication-recovery.service";
import { PostgresPublicationRecoveryRepository } from "../../inventory-planning/infrastructure/publication-recovery.repository";
import type { EbayListingRecoveryContinuation } from "../ebay-listing-recovery.service";
import type { PostgresEbayListingSyncRepository } from "./ebay-listing-sync.repository";

/** Thin transaction adapter: Inventory retains the decision, Channels queues the
 * saved operation. Neither owner sends HTTP or invents an old request outcome. */
export class PostgresEbayListingRecoveryContinuation implements EbayListingRecoveryContinuation {
  constructor(private readonly pool: Pick<Pool, "connect">,
    private readonly jobs: Pick<PostgresEbayListingSyncRepository, "enqueueInsideTransaction" | "authorizePublicationRetryInsideTransaction">,
    private readonly now: () => Date = () => new Date()) {}

  async resume(input: Parameters<EbayListingRecoveryContinuation["resume"]>[0]) {
    const repository = new PostgresPublicationRecoveryRepository(this.pool);
    const { publicationRetryHash, ...confirmation } = input.confirmation;
    let next: Awaited<ReturnType<PostgresEbayListingSyncRepository["enqueueInsideTransaction"]>> | undefined;
    const recovery = new PublicationRecoveryService({
      preview: scopes => repository.preview(scopes),
      resume: async command => {
        const result = await repository.resumeWithContinuation(command, async client => {
          if (publicationRetryHash) {
            const authorized = await this.jobs.authorizePublicationRetryInsideTransaction(client, {
              jobId: input.job.id, channelId: input.job.identity.channelId, actor: command.actor,
              commandKey: command.idempotencyKey, expectedRevision: input.job.revision, reviewHash: publicationRetryHash,
            }, command.now);
            return authorized.job;
          }
          return this.jobs.enqueueInsideTransaction(client, input.job.identity, command.idempotencyKey,
            command.actor, command.now, undefined, input.job.operation,
            input.job.operation === "publish" ? input.job.publicationTarget ?? undefined : undefined);
        }, { allowEmptyReview: publicationRetryHash !== undefined });
        next = result.continuation;
        return result.recovery;
      },
    }, this.now);
    const result = await recovery.resume({ ...confirmation, actor: input.actor, scopes: input.scopes });
    if (!next) throw new Error("Recovery committed without a listing continuation.");
    return { ...result, job: next, ...(publicationRetryHash ? { publicationRetryAuthorized: true } : {}) };
  }
}
