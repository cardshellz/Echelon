import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type { DropshipOmsWarehouseAssignmentReader } from "../application/dropship-store-connection-service";
import { resolveDropshipOmsChannelIdWithClient } from "./dropship-order-intake.repository";
import { readChannelFulfillmentWarehouses } from "../../channels/channel-fulfillment-warehouses.reader";
import { z } from "zod";

export type { DropshipOmsWarehouseAssignmentReader };

type Queryable = Pick<PoolClient, "query">;

export async function listEnabledWarehouseIdsForChannelWithClient(
  client: Queryable,
  channelId: number,
): Promise<number[]> {
  const rows = await readChannelFulfillmentWarehouses(client, { channelId });
  return rows.map(row => row.warehouseId);
}

export async function isWarehouseEnabledForChannelWithClient(
  client: Queryable,
  input: { channelId: number; warehouseId: number; lock?: boolean },
): Promise<boolean> {
  const warehouseId = z.number().int().positive().max(2_147_483_647).parse(input.warehouseId);
  const rows = await readChannelFulfillmentWarehouses(client, { channelId: input.channelId, lock: input.lock });
  return rows.some(row => row.warehouseId === warehouseId);
}

/**
 * Resolves the Dropship OMS channel on a dedicated client, for callers that
 * hold only a connect-capable pool (the service registry, diagnostics). The
 * client is always released, including when resolution throws.
 */
export function createDropshipOmsChannelResolver(
  connectionPool: Pick<Pool, "connect">,
): { resolveChannelId(): Promise<number> } {
  return {
    async resolveChannelId(): Promise<number> {
      const client = await connectionPool.connect();
      try {
        return await resolveDropshipOmsChannelIdWithClient(client);
      } finally {
        client.release();
      }
    },
  };
}

export class PgDropshipOmsWarehouseAssignmentReader implements DropshipOmsWarehouseAssignmentReader {
  constructor(private readonly dbPool: Pick<Pool, "query"> = defaultPool) {}

  async listEnabledWarehouseIds(): Promise<number[]> {
    const channelId = await resolveDropshipOmsChannelIdWithClient(this.dbPool);
    return listEnabledWarehouseIdsForChannelWithClient(this.dbPool, channelId);
  }
}
