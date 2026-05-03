import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  DropshipStoreWebhookRepairCredentials,
  DropshipStoreWebhookRepairRepository,
} from "../application/dropship-store-webhook-repair-service";
import { PgDropshipMarketplaceCredentialRepository } from "./dropship-marketplace-credentials";

interface StoreConnectionLookupRow {
  id: number;
  vendor_id: number;
  platform: string;
  status: string;
  shop_domain: string | null;
}

interface CredentialLoader {
  loadForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: "shopify";
  }): Promise<{
    vendorId: number;
    storeConnectionId: number;
    platform: string;
    shopDomain: string | null;
    accessToken: string;
  }>;
}

export class PgDropshipStoreWebhookRepairRepository implements DropshipStoreWebhookRepairRepository {
  constructor(
    private readonly dbPool: Pool = defaultPool,
    private readonly credentialLoader: CredentialLoader = new PgDropshipMarketplaceCredentialRepository(dbPool),
  ) {}

  async loadShopifyStoreConnectionForWebhookRepair(input: {
    storeConnectionId: number;
  }): Promise<DropshipStoreWebhookRepairCredentials> {
    const result = await this.dbPool.query<StoreConnectionLookupRow>(
      `SELECT id, vendor_id, platform, status, shop_domain
       FROM dropship.dropship_store_connections
       WHERE id = $1`,
      [input.storeConnectionId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DropshipError(
        "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
        "Dropship store connection was not found.",
        { storeConnectionId: input.storeConnectionId, retryable: false },
      );
    }
    if (row.platform !== "shopify") {
      throw new DropshipError(
        "DROPSHIP_STORE_WEBHOOK_REPAIR_PLATFORM_UNSUPPORTED",
        "Dropship webhook repair only supports Shopify store connections.",
        {
          storeConnectionId: row.id,
          platform: row.platform,
          retryable: false,
        },
      );
    }
    if (!row.shop_domain?.trim()) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_SHOP_DOMAIN_REQUIRED",
        "Shopify shop domain is required for webhook repair.",
        { storeConnectionId: row.id, retryable: false },
      );
    }

    const credentials = await this.credentialLoader.loadForStoreConnection({
      vendorId: row.vendor_id,
      storeConnectionId: row.id,
      platform: "shopify",
    });
    if (credentials.platform !== "shopify") {
      throw new DropshipError(
        "DROPSHIP_STORE_WEBHOOK_REPAIR_CREDENTIAL_PLATFORM_MISMATCH",
        "Dropship webhook repair loaded credentials for the wrong platform.",
        {
          storeConnectionId: row.id,
          platform: credentials.platform,
          retryable: false,
        },
      );
    }
    if (!credentials.shopDomain?.trim()) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_SHOP_DOMAIN_REQUIRED",
        "Shopify shop domain is required for webhook repair.",
        { storeConnectionId: row.id, retryable: false },
      );
    }

    return {
      vendorId: credentials.vendorId,
      storeConnectionId: credentials.storeConnectionId,
      platform: "shopify",
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
    };
  }

  async recordShopifyWebhookRepair(input: {
    vendorId: number;
    storeConnectionId: number;
    shopDomain: string;
    idempotencyKey: string;
    actor: {
      actorType: "admin" | "system";
      actorId?: string;
    };
    repairedAt: Date;
  }): Promise<void> {
    await this.dbPool.query(
      `INSERT INTO dropship.dropship_audit_events
        (vendor_id, store_connection_id, entity_type, entity_id, event_type,
         actor_type, actor_id, severity, payload, created_at)
       VALUES ($1, $2, 'dropship_store_connection', $3, 'shopify_webhook_subscriptions_repaired',
               $4, $5, 'info', $6::jsonb, $7)`,
      [
        input.vendorId,
        input.storeConnectionId,
        String(input.storeConnectionId),
        input.actor.actorType,
        input.actor.actorId ?? null,
        JSON.stringify({
          shopDomain: input.shopDomain,
          idempotencyKey: input.idempotencyKey,
        }),
        input.repairedAt,
      ],
    );
  }
}
