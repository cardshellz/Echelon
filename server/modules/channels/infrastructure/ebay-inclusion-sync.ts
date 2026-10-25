import type { Pool, PoolClient } from "pg";
import { PostgresChannelSyncBatchRepository } from "../../marketplace-listings/infrastructure/pg-channel-sync-batch.repository";
import { saveChannelSyncSelection, assertSyncSelection } from "../../marketplace-listings/application/save-channel-sync-selection";
import type { SyncDestination } from "../../marketplace-listings/domain/channel-sync-batch";
import { EbaySyncSelectionReader } from "./ebay-sync-selection.reader";

export interface InclusionSyncCommand { productId: number; commandKey: string; actor: string; now: Date }
export interface InclusionSyncHandoff {
  save(client: PoolClient, command: InclusionSyncCommand): Promise<void>;
  read(client: Pick<PoolClient, "query">, command: Omit<InclusionSyncCommand, "now">): Promise<string | null>;
}
/** Translate the account and catalog identity only. The shared batch owner saves
 * the same durable request used by manual and bulk sync, inside inclusion's tx. */
export function createEbayInclusionSync(input: {
  pool: Pick<Pool, "connect" | "query">; channelId: number;
  destination(client: PoolClient): Promise<SyncDestination>; uuid(): string;
}): InclusionSyncHandoff {
  const store = new PostgresChannelSyncBatchRepository(input.pool);
  return {
    async save(client, command) {
      const { productId, name, sku } = await new EbaySyncSelectionReader(client, input.channelId).product(command.productId);
      await saveChannelSyncSelection({ commandKey: command.commandKey, actor: command.actor,
        destination: await input.destination(client), products: [{ productId, name, sku }], requestedProductIds: [command.productId], now: command.now, uuid: input.uuid },
        { create: batch => store.createInsideTransaction(client, batch) });
    },
    async read(client, command) {
      const batch = await store.getInsideTransaction(client, command.commandKey);
      if (!batch) return null; // Historical inclusion receipts predate sync handoff.
      assertSyncSelection(batch, input.channelId, command.actor, [command.productId]);
      return batch.id;
    },
  };
}
