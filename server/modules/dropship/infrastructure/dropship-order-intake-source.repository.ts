import type { Pool, PoolClient } from "pg";
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

export interface DropshipShopifyStoreUninstallResult {
  matched: boolean;
  changed: boolean;
  vendorId: number | null;
  storeConnectionId: number | null;
  previousStatus: string | null;
}

export interface DropshipOrderIntakeSourceRepository {
  findShopifyStoreConnectionByShopDomain(
    shopDomain: string,
  ): Promise<DropshipOrderIntakeSourceStoreConnection | null>;

  markShopifyStoreUninstalled(input: {
    shopDomain: string;
    occurredAt: Date;
    webhookId: string | null;
  }): Promise<DropshipShopifyStoreUninstallResult>;
}

interface StoreConnectionRow {
  id: number;
  vendor_id: number;
  platform: DropshipSourcePlatform;
  shop_domain: string | null;
  status: string;
  config?: Record<string, unknown> | null;
}

const ACTIVE_OR_RECOVERABLE_STORE_STATUSES = [
  "connected",
  "needs_reauth",
  "refresh_failed",
  "grace_period",
  "paused",
] as const;
const SHOPIFY_UNINSTALL_REASON = "Shopify app uninstalled.";

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

  async markShopifyStoreUninstalled(input: {
    shopDomain: string;
    occurredAt: Date;
    webhookId: string | null;
  }): Promise<DropshipShopifyStoreUninstallResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<StoreConnectionRow>(
        `SELECT id, vendor_id, platform, shop_domain, status, config
         FROM dropship.dropship_store_connections
         WHERE platform = 'shopify'
           AND LOWER(shop_domain) = LOWER($1)
           AND status = ANY($2::text[])
         ORDER BY
           CASE WHEN status = 'connected' THEN 0 ELSE 1 END,
           updated_at DESC,
           id DESC
         LIMIT 2
         FOR UPDATE`,
        [input.shopDomain, ACTIVE_OR_RECOVERABLE_STORE_STATUSES],
      );
      if (result.rows.length > 1) {
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_STORE_CONNECTION_AMBIGUOUS",
          "More than one active or recoverable dropship Shopify store connection matches this shop domain.",
          {
            shopDomain: input.shopDomain,
            storeConnectionIds: result.rows.map((row) => row.id),
            retryable: false,
          },
        );
      }

      const existing = result.rows[0];
      if (!existing) {
        await client.query("COMMIT");
        return {
          matched: false,
          changed: false,
          vendorId: null,
          storeConnectionId: null,
          previousStatus: null,
        };
      }

      await client.query(
        `UPDATE dropship.dropship_store_connections
         SET status = 'disconnected',
             setup_status = 'attention_required',
             access_token_ref = NULL,
             refresh_token_ref = NULL,
             token_expires_at = NULL,
             disconnect_reason = $2,
             disconnected_at = $3,
             grace_ends_at = NULL,
             config = COALESCE(config, '{}'::jsonb) || $4::jsonb,
             updated_at = $3
         WHERE id = $1`,
        [
          existing.id,
          SHOPIFY_UNINSTALL_REASON,
          input.occurredAt,
          JSON.stringify({
            shopifyUninstalledAt: input.occurredAt.toISOString(),
            shopifyUninstallWebhookId: input.webhookId,
          }),
        ],
      );
      await client.query(
        `DELETE FROM dropship.dropship_store_connection_tokens
         WHERE store_connection_id = $1`,
        [existing.id],
      );
      await recordShopifyStoreUninstallAuditEvent(client, {
        vendorId: existing.vendor_id,
        storeConnectionId: existing.id,
        shopDomain: input.shopDomain,
        previousStatus: existing.status,
        webhookId: input.webhookId,
        occurredAt: input.occurredAt,
      });
      await client.query("COMMIT");
      return {
        matched: true,
        changed: true,
        vendorId: existing.vendor_id,
        storeConnectionId: existing.id,
        previousStatus: existing.status,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function recordShopifyStoreUninstallAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    shopDomain: string;
    previousStatus: string;
    webhookId: string | null;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_store_connection', $3, 'shopify_app_uninstalled',
             'system', 'shopify_webhook', 'warning', $4::jsonb, $5)`,
    [
      input.vendorId,
      input.storeConnectionId,
      String(input.storeConnectionId),
      JSON.stringify({
        shopDomain: input.shopDomain,
        previousStatus: input.previousStatus,
        status: "disconnected",
        webhookId: input.webhookId,
      }),
      input.occurredAt,
    ],
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
