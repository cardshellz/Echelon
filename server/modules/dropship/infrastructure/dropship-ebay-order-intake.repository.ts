import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipEbayOrderIntakeImmutableConflictInput,
  DropshipEbayOrderIntakeRepository,
  DropshipEbayOrderIntakeStoreConnection,
} from "../application/dropship-ebay-order-intake-poll-service";

interface StoreConnectionRow {
  id: number;
  vendor_id: number;
  last_order_sync_at: Date | null;
}

const IMMUTABLE_CONFLICT_AUDIT_EVENT_TYPE = "order_intake_immutable_payload_conflict";
const IMMUTABLE_CONFLICT_LOCK_NAMESPACE = "dropship_ebay_order_intake_conflict";

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
         AND setup_status = 'ready'
         AND access_token_ref IS NOT NULL
         AND refresh_token_ref IS NOT NULL
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

  async recordImmutableOrderConflict(
    input: DropshipEbayOrderIntakeImmutableConflictInput,
  ): Promise<{ created: boolean }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [IMMUTABLE_CONFLICT_LOCK_NAMESPACE, String(input.intakeId)],
      );
      const result = await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         SELECT $1, $2, 'dropship_order_intake', $3, $4,
                'system', NULL, 'error', $5::jsonb, $6
         WHERE NOT EXISTS (
           SELECT 1
           FROM dropship.dropship_audit_events
           WHERE entity_type = 'dropship_order_intake'
             AND entity_id = $3
             AND event_type = $4
         )`,
        [
          input.vendorId,
          input.storeConnectionId,
          String(input.intakeId),
          IMMUTABLE_CONFLICT_AUDIT_EVENT_TYPE,
          JSON.stringify({
            failureCode: input.failureCode,
            message: input.message,
            intakeId: input.intakeId,
            externalOrderId: input.externalOrderId,
          }),
          input.now,
        ],
      );
      await client.query("COMMIT");
      return { created: result.rowCount === 1 };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original database error.
  }
}
