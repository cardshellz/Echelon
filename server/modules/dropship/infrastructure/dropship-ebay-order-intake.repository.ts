import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  DropshipEbayOrderIntakeImmutableConflictInput,
  DropshipEbayOrderIntakeRepository,
  DropshipEbayOrderIntakeStoreConnection,
} from "../application/dropship-ebay-order-intake-poll-service";

interface StoreConnectionRow {
  id: number;
  vendor_id: number;
  platform: "ebay";
  last_order_sync_at: Date | null;
  dropship_listing_ids: unknown;
}

const IMMUTABLE_CONFLICT_AUDIT_EVENT_TYPE = "order_intake_immutable_payload_conflict";
const IMMUTABLE_CONFLICT_LOCK_NAMESPACE = "dropship_ebay_order_intake_conflict";

export class PgDropshipEbayOrderIntakeRepository implements DropshipEbayOrderIntakeRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listPollableStoreConnections(input: {
    limit: number;
  }): Promise<DropshipEbayOrderIntakeStoreConnection[]> {
    // Only launch-ready stores: an order recorded for any other store is
    // rejected. Every listing the store ever published counts, whatever its
    // status now: an ended listing can still have a paid order waiting to ship.
    const result = await this.dbPool.query<StoreConnectionRow>(
      `SELECT sc.id, sc.vendor_id, sc.platform, sc.last_order_sync_at,
              ARRAY(
                SELECT DISTINCT dl.external_listing_id
                FROM dropship.dropship_vendor_listings dl
                WHERE dl.store_connection_id = sc.id
                  AND dl.vendor_id = sc.vendor_id
                  AND dl.external_listing_id IS NOT NULL
                  AND btrim(dl.external_listing_id) <> ''
                ORDER BY dl.external_listing_id
              )::text[] AS dropship_listing_ids
       FROM dropship.dropship_store_connections sc
       WHERE sc.platform = 'ebay'
         AND sc.status = 'connected'
         AND sc.setup_status = 'ready'
         AND sc.access_token_ref IS NOT NULL
         AND sc.refresh_token_ref IS NOT NULL
       ORDER BY sc.last_order_sync_at ASC NULLS FIRST, sc.id ASC
       LIMIT $1`,
      [input.limit],
    );
    return result.rows.map((row) => ({
      vendorId: row.vendor_id,
      storeConnectionId: row.id,
      platform: row.platform,
      lastOrderSyncAt: row.last_order_sync_at,
      dropshipListingIds: readListingIds(row),
    }));
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

function readListingIds(row: StoreConnectionRow): string[] {
  const value = row.dropship_listing_ids;
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) {
    throw new DropshipError(
      "DROPSHIP_EBAY_ORDER_INTAKE_LISTING_IDS_INVALID",
      "Dropship store connection returned invalid dropship listing ids.",
      { storeConnectionId: row.id, retryable: false },
    );
  }
  return value;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original database error.
  }
}
