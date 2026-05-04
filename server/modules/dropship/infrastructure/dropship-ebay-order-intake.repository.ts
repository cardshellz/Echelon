import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipEbayOrderIntakeRepository,
  DropshipEbayOrderIntakeStoreConnection,
} from "../application/dropship-ebay-order-intake-poll-service";

interface StoreConnectionRow {
  id: number;
  vendor_id: number;
  last_order_sync_at: Date | null;
}

export class PgDropshipEbayOrderIntakeRepository implements DropshipEbayOrderIntakeRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listPollableStoreConnections(input: {
    limit: number;
  }): Promise<DropshipEbayOrderIntakeStoreConnection[]> {
    const result = await this.dbPool.query<StoreConnectionRow>(
      `SELECT id, vendor_id, last_order_sync_at
       FROM dropship.dropship_store_connections
       WHERE platform = 'ebay'
         AND status = 'connected'
       ORDER BY last_order_sync_at ASC NULLS FIRST, id ASC
       LIMIT $1`,
      [input.limit],
    );
    return result.rows.map((row) => ({
      vendorId: row.vendor_id,
      storeConnectionId: row.id,
      lastOrderSyncAt: row.last_order_sync_at,
    }));
  }

  async markStorePollSucceeded(input: {
    storeConnectionId: number;
    syncedThrough: Date;
    now: Date;
  }): Promise<void> {
    await this.dbPool.query(
      `UPDATE dropship.dropship_store_connections
       SET last_order_sync_at = CASE
             WHEN last_order_sync_at IS NULL OR last_order_sync_at < $2 THEN $2
             ELSE last_order_sync_at
           END,
           last_sync_at = $3,
           updated_at = $3
       WHERE id = $1`,
      [input.storeConnectionId, input.syncedThrough, input.now],
    );
  }
}
