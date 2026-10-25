import { savedSyncBatchSchema, type SavedSyncBatch, type SyncDestination, type SyncBatchMember, ChannelSyncBatchError } from "../domain/channel-sync-batch";

/** Shared durable admission boundary. A caller can supply a transaction-bound
 * store so changed inclusion and the exact requested sync commit atomically. */
export async function saveChannelSyncSelection(input: {
  commandKey: string; actor: string; destination: SyncDestination;
  products: Omit<SyncBatchMember, "commandKey">[]; requestedProductIds?: number[]; now: Date; uuid(): string;
}, store: { create(batch: SavedSyncBatch): Promise<SavedSyncBatch> }): Promise<SavedSyncBatch> {
  const batch = savedSyncBatchSchema.parse({
    id: input.commandKey, destination: input.destination, actor: input.actor,
    createdAt: input.now.toISOString(), admissionCompletedAt: null, admissionError: null,
    members: input.products.map(product => ({ ...product, commandKey: input.uuid() })),
  });
  const saved = await store.create(batch);
  // Sync All captures its selection once. Concurrent retries must return that
  // winner even if catalog inclusion changed while the second request read it.
  assertSyncSelection(saved, input.destination.channelId, input.actor, input.requestedProductIds);
  if (JSON.stringify(saved.destination) !== JSON.stringify(batch.destination))
    throw new ChannelSyncBatchError("SYNC_BATCH_REPLAY_CONFLICT", "This saved sync belongs to another account.");
  return saved;
}
export function assertSyncSelection(batch: SavedSyncBatch, channelId: number, actor: string, productIds?: number[]): void {
  if (batch.destination.channelId !== channelId || batch.actor !== actor
    || productIds && (new Set(productIds).size !== productIds.length || batch.members.length !== productIds.length
      || batch.members.some(member => !productIds.includes(member.productId))))
    throw new ChannelSyncBatchError("SYNC_BATCH_REPLAY_CONFLICT", "This request belongs to another channel, requester or selection.");
}
