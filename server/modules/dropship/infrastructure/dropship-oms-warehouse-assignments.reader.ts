import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type { DropshipOmsWarehouseAssignmentReader } from "../application/dropship-store-connection-service";
import { resolveDropshipOmsChannelIdWithClient } from "./dropship-order-intake.repository";

export type { DropshipOmsWarehouseAssignmentReader };

type Queryable = Pick<PoolClient, "query">;

export async function listEnabledWarehouseIdsForChannelWithClient(
  client: Queryable,
  channelId: number,
): Promise<number[]> {
  const result = await client.query<{ warehouse_id: number }>(
    `SELECT warehouse_id
     FROM channels.channel_warehouse_assignments
     WHERE channel_id = $1 AND enabled = true
     ORDER BY warehouse_id ASC`,
    [channelId],
  );
  return result.rows.map((row) => Number(row.warehouse_id));
}

export async function isWarehouseEnabledForChannelWithClient(
  client: Queryable,
  input: { channelId: number; warehouseId: number },
): Promise<boolean> {
  const result = await client.query<{ warehouse_id: number }>(
    `SELECT warehouse_id
     FROM channels.channel_warehouse_assignments
     WHERE channel_id = $1 AND warehouse_id = $2 AND enabled = true
     LIMIT 1`,
    [input.channelId, input.warehouseId],
  );
  return result.rows.length === 1;
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
