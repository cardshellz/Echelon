import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";

export interface DropshipOrderIntakeSourceStoreConnection {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  shopDomain: string | null;
  status: string;
}

export interface DropshipOrderIntakeSourceRepository {
  findShopifyStoreConnectionByShopDomain(
    shopDomain: string,
  ): Promise<DropshipOrderIntakeSourceStoreConnection | null>;
}

interface StoreConnectionRow {
  id: number;
  vendor_id: number;
  platform: DropshipSourcePlatform;
  shop_domain: string | null;
  status: string;
}

const ACTIVE_OR_RECOVERABLE_STORE_STATUSES = [
  "connected",
  "needs_reauth",
  "refresh_failed",
  "grace_period",
  "paused",
] as const;

export class PgDropshipOrderIntakeSourceRepository implements DropshipOrderIntakeSourceRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async findShopifyStoreConnectionByShopDomain(
    shopDomain: string,
  ): Promise<DropshipOrderIntakeSourceStoreConnection | null> {
    const result = await this.dbPool.query<StoreConnectionRow>(
      `SELECT id, vendor_id, platform, shop_domain, status
       FROM dropship.dropship_store_connections
       WHERE platform = 'shopify'
         AND LOWER(shop_domain) = LOWER($1)
         AND status = ANY($2::text[])
       ORDER BY
         CASE WHEN status = 'connected' THEN 0 ELSE 1 END,
         updated_at DESC,
         id DESC
       LIMIT 2`,
      [shopDomain, ACTIVE_OR_RECOVERABLE_STORE_STATUSES],
    );
    if (result.rows.length > 1) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_STORE_CONNECTION_AMBIGUOUS",
        "More than one active or recoverable dropship Shopify store connection matches this shop domain.",
        {
          shopDomain,
          storeConnectionIds: result.rows.map((row) => row.id),
          retryable: false,
        },
      );
    }
    const row = result.rows[0];
    return row
      ? {
          vendorId: row.vendor_id,
          storeConnectionId: row.id,
          platform: row.platform,
          shopDomain: row.shop_domain,
          status: row.status,
        }
      : null;
  }
}
