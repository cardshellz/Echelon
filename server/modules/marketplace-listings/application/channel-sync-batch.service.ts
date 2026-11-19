import { z } from "zod";
import { saveChannelSyncSelection, assertSyncSelection } from "./save-channel-sync-selection";
import {
  CHANNEL_SYNC_BATCH_LIMIT,
  startChannelSyncBatchSchema,
  type ChannelSyncBatch,
} from "@shared/types/channel-sync-batch";
import {
  ChannelSyncAdmissionRefused,
  ChannelSyncBatchError,
  projectSyncBatch,
  type SyncAdmissionRefusal,
  type SavedSyncBatch,
  type SyncCommandStatus,
  type SyncDestination,
  type SyncBatchMember,
} from "../domain/channel-sync-batch";

export interface ChannelSyncBatchAdapter {
  select(channelId: number, productIds?: number[]): Promise<{
    destination: SyncDestination;
    products: Omit<SyncBatchMember, "commandKey">[];
  }>;
  /** Reuse exact command keys and consult receipts before recapturing current intent. */
  admit(
    batch: SavedSyncBatch,
    members: readonly SyncBatchMember[],
  ): Promise<void>;
  read(batch: SavedSyncBatch): Promise<SyncCommandStatus[]>;
}
export interface ChannelSyncBatchStore {
  get(id: string): Promise<SavedSyncBatch | null>;
  create(batch: SavedSyncBatch): Promise<SavedSyncBatch>;
  list(channelId: number, offset: number): Promise<SavedSyncBatch[]>;
  claim(token: string, now: Date): Promise<SavedSyncBatch | null>;
  finish(
    id: string,
    token: string,
    now: Date,
    refusal?: SyncAdmissionRefusal,
  ): Promise<boolean>;
  defer(id: string, token: string, message: string, now: Date): Promise<void>;
}
const channelIdSchema = z.number().int().positive().max(2_147_483_647);

/** Owns batch membership and admission recovery only. Provider job owners remain
 * the sole authorities for execution, retry, recovery and verified completion. */
export class ChannelSyncBatchService {
  constructor(
    private readonly deps: {
      store: ChannelSyncBatchStore;
      adapter(channelId: number): ChannelSyncBatchAdapter;
      now(): Date;
      uuid(): string;
    },
  ) {}

  async start(
    channelId: number,
    actor: string,
    input: unknown,
  ): Promise<ChannelSyncBatch> {
    channelIdSchema.parse(channelId);
    actor = z.string().trim().min(1).max(200).parse(actor);
    const { commandKey, productIds } = startChannelSyncBatchSchema.parse(input);
    const prior = await this.deps.store.get(commandKey);
    if (prior) {
      assertSyncSelection(prior, channelId, actor, productIds);
      return this.project(prior);
    }
    const selection = await this.deps.adapter(channelId).select(channelId, productIds);
    if (selection.destination.channelId !== channelId)
      throw new ChannelSyncBatchError(
        "SYNC_DESTINATION_INVALID",
        "The selected account does not belong to this channel.",
      );
    if (selection.products.length > CHANNEL_SYNC_BATCH_LIMIT)
      throw new ChannelSyncBatchError(
        "SYNC_BATCH_TOO_LARGE",
        "This selection exceeds the maximum saved batch size. Contact an administrator before retrying.",
        422,
      );
    if (productIds && (selection.products.length !== productIds.length
      || selection.products.some(product => !productIds.includes(product.productId))))
      throw new ChannelSyncBatchError("SYNC_SELECTION_UNAVAILABLE", "A selected product no longer exists. Refresh the listing feed.", 422);
    const saved = await saveChannelSyncSelection({ commandKey, actor, destination: selection.destination,
      products: selection.products, requestedProductIds: productIds, now: this.deps.now(), uuid: this.deps.uuid }, this.deps.store);
    return this.project(saved);
  }

  async get(channelId: number, id: string): Promise<ChannelSyncBatch> {
    channelIdSchema.parse(channelId);
    z.string().uuid().parse(id);
    const batch = await this.deps.store.get(id);
    if (!batch || batch.destination.channelId !== channelId)
      throw new ChannelSyncBatchError(
        "SYNC_BATCH_NOT_FOUND",
        "This saved sync was not found for this channel.",
        404,
      );
    return this.project(batch);
  }

  async list(
    channelId: number,
    offset = 0,
  ): Promise<{ batches: ChannelSyncBatch[] }> {
    channelIdSchema.parse(channelId);
    z.number().int().min(0).max(1_000_000).parse(offset);
    const batches = await this.deps.store.list(channelId, offset);
    return {
      batches: await Promise.all(batches.map((batch) => this.project(batch))),
    };
  }

  async processDue(limit = 5): Promise<{ processed: number; failed: number }> {
    z.number().int().min(1).max(20).parse(limit);
    const result = { processed: 0, failed: 0 };
    for (let index = 0; index < limit; index++) {
      const token = this.deps.uuid();
      const batch = await this.deps.store.claim(token, this.deps.now());
      if (!batch) break;
      try {
        const adapter = this.deps.adapter(batch.destination.channelId);
        const before = await adapter.read(batch);
        projectSyncBatch(batch, before, this.deps.now());
        const accepted = new Set(before.map((status) => status.commandKey));
        const missing = batch.members.filter(
          (member) => !accepted.has(member.commandKey),
        );
        if (missing.length) await adapter.admit(batch, missing);
        const after = await adapter.read(batch);
        projectSyncBatch(batch, after, this.deps.now());
        if (
          after.length !== batch.members.length ||
          after.some((status) => status.state === "unavailable")
        )
          throw new ChannelSyncBatchError(
            "SYNC_ADMISSION_UNCONFIRMED",
            "Some saved requests have not been acknowledged.",
          );
        if (!(await this.deps.store.finish(batch.id, token, this.deps.now())))
          throw new ChannelSyncBatchError(
            "SYNC_BATCH_LEASE_LOST",
            "Another worker resumed this saved batch.",
          );
        result.processed++;
      } catch (error) {
        if (error instanceof ChannelSyncAdmissionRefused) {
          // Only a typed, confirmed no-handoff refusal may end admission.
          // Accepted products still report their real outstanding channel work.
          await this.deps.store.finish(
            batch.id,
            token,
            this.deps.now(),
            error.refusal,
          );
          console.error(
            JSON.stringify({
              event: "channel_sync_batch_admission_refused",
              batchId: batch.id,
              code: error.refusal.code,
            }),
          );
          result.failed++;
          continue;
        }
        const code =
          error instanceof ChannelSyncBatchError
            ? error.code
            : "SYNC_BATCH_ADMISSION_RETRY";
        console.error(
          JSON.stringify({
            event: "channel_sync_batch_deferred",
            batchId: batch.id,
            code,
          }),
        );
        await this.deps.store.defer(
          batch.id,
          token,
          "Some updates have not reached the listing queue. Saved requests will retry automatically; check the channel connection if this persists.",
          this.deps.now(),
        );
        result.failed++;
      }
    }
    return result;
  }

  private async project(batch: SavedSyncBatch): Promise<ChannelSyncBatch> {
    try {
      const statuses = await this.deps
        .adapter(batch.destination.channelId)
        .read(batch);
      return projectSyncBatch(batch, statuses, this.deps.now());
    } catch {
      console.error(
        JSON.stringify({
          event: "channel_sync_batch_status_unavailable",
          batchId: batch.id,
        }),
      );
      return projectSyncBatch(
        batch,
        batch.members.map((member) => ({
          commandKey: member.commandKey,
          operationId: null,
          state: "unavailable",
          code: "SYNC_STATUS_UNAVAILABLE",
          message:
            "Saved progress could not be checked. Refresh status; do not submit another sync.",
          updatedAt: batch.createdAt,
          nextAttemptAt: null,
        })),
        this.deps.now(),
      );
    }
  }
}
