import type { ChannelSyncBatchAdapter } from "../../../marketplace-listings/application/channel-sync-batch.service";
import {
  ChannelSyncAdmissionRefused,
  ChannelSyncBatchError,
  type SavedSyncBatch,
  type SyncBatchMember,
  type SyncCommandStatus,
  type SyncAdmissionRefusal,
} from "../../../marketplace-listings/domain/channel-sync-batch";
import type {
  selectActiveEbaySyncProducts,
  syncActiveListings,
} from "../../infrastructure/ebay-active-listing-sync";
import type { PostgresEbayListingSyncRepository } from "../../infrastructure/ebay-listing-sync.repository";
import { z } from "zod";

function admissionRefusal(error: unknown): SyncAdmissionRefusal | null {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : null;
  if (code === "EBAY_SYNC_IDENTITY_CHANGED")
    return {
      code: "SYNC_DESTINATION_CHANGED",
      message:
        "The connected account changed after this sync was saved. These products were not queued. Review the channel connection, then start a new sync for the intended account.",
    };
  if (
    code === "EBAY_SYNC_ACCOUNT_UNVERIFIED" ||
    code === "EBAY_SYNC_AUTH_REQUIRED"
  )
    return {
      code: "SYNC_CONNECTION_REQUIRED",
      message:
        "The channel connection could not be verified before these products were queued. Reconnect or verify the account in Store Setup, then start a new sync.",
    };
  return null;
}
/** Translation only: eligibility, durable commands and provider state still
 * belong to the existing eBay listing owner. No provider calls live here. */
export class EbaySyncBatchAdapter implements ChannelSyncBatchAdapter {
  constructor(
    private readonly deps: {
      channelId: number;
      select: typeof selectActiveEbaySyncProducts;
      sync: typeof syncActiveListings;
      status: Pick<PostgresEbayListingSyncRepository, "readCommandStatuses">;
    },
  ) {}
  async select(channelId: number) {
    if (channelId !== this.deps.channelId)
      throw new ChannelSyncBatchError(
        "SYNC_CHANNEL_MISMATCH",
        "This adapter belongs to another channel.",
      );
    try {
      return await this.deps.select();
    } catch (error) {
      const refusal = admissionRefusal(error);
      if (refusal)
        throw new ChannelSyncBatchError(refusal.code, refusal.message, 422);
      throw error;
    }
  }
  async admit(
    batch: SavedSyncBatch,
    members: readonly SyncBatchMember[],
  ): Promise<void> {
    this.assertDestination(batch);
    if (!members.length) return;
    // The existing admission API bounds each request to 500 products. The
    // shared batch retains one exact selection across these handoff chunks.
    const ADMISSION_CHUNK_SIZE = 500;
    for (
      let offset = 0;
      offset < members.length;
      offset += ADMISSION_CHUNK_SIZE
    ) {
      const chunk = members.slice(offset, offset + ADMISSION_CHUNK_SIZE);
      try {
        await this.deps.sync(
          { productIds: chunk.map((member) => member.productId) },
          batch.actor,
          undefined,
          {
            connectionId: batch.destination.connectionId,
            accountId: batch.destination.accountId,
            environment: z
              .enum(["production", "sandbox"])
              .parse(batch.destination.environment),
            marketplaceId: z
              .string()
              .min(1)
              .parse(batch.destination.marketplaceId),
          },
          new Map(chunk.map((member) => [member.productId, member.commandKey])),
        );
      } catch (error) {
        const refusal = admissionRefusal(error);
        if (refusal) throw new ChannelSyncAdmissionRefused(refusal);
        throw error;
      }
    }
  }
  async read(batch: SavedSyncBatch): Promise<SyncCommandStatus[]> {
    this.assertDestination(batch);
    const receipts = await this.deps.status.readCommandStatuses(
      batch.members.map((member) => member.commandKey),
    );
    const members = new Map(
      batch.members.map((member) => [member.commandKey, member]),
    );
    return receipts.map((receipt) => {
      const member = members.get(receipt.commandKey);
      const { job } = receipt;
      if (
        !member ||
        member.productId !== job.productId ||
        receipt.channelId !== batch.destination.channelId ||
        receipt.actor !== batch.actor ||
        job.operation === "withdraw" ||
        (job.kind === "sync" &&
          (receipt.connectionId !== batch.destination.connectionId ||
            receipt.accountId !== batch.destination.accountId ||
            receipt.marketplaceId !== batch.destination.marketplaceId))
      )
        throw new ChannelSyncBatchError(
          "SYNC_COMMAND_SCOPE_MISMATCH",
          "A saved update receipt belongs to a different request.",
        );
      return {
        commandKey: receipt.commandKey,
        operationId: job.id,
        state:
          job.state === "recovering"
            ? "retrying"
            : job.state === "awaiting_evidence"
              ? "verifying"
              : job.state,
        code: job.code,
        message: job.message,
        updatedAt: job.updatedAt,
        nextAttemptAt: ["recovering", "awaiting_evidence", "queued"].includes(
          job.state,
        )
          ? job.nextAttemptAt
          : null,
      };
    });
  }
  private assertDestination(batch: SavedSyncBatch): void {
    if (
      batch.destination.provider !== "ebay" ||
      batch.destination.channelId !== this.deps.channelId
    )
      throw new ChannelSyncBatchError(
        "SYNC_CHANNEL_MISMATCH",
        "This saved batch belongs to another channel.",
      );
  }
}
