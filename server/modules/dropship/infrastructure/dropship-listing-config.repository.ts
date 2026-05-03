import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  buildDefaultDropshipStoreListingConfig,
  type DropshipListingConfigRepository,
  type DropshipListingConfigStoreConnectionContext,
  type DropshipStoreListingConfigRecord,
  type EnsureDropshipStoreListingConfigRepositoryInput,
  type ReplaceDropshipStoreListingConfigRepositoryInput,
} from "../application/dropship-listing-config-service";
import type { DropshipStoreListingConfig } from "../application/dropship-marketplace-listing-provider";

interface StoreConnectionContextRow {
  vendor_id: number;
  store_connection_id: number;
  platform: DropshipListingConfigStoreConnectionContext["platform"];
  status: DropshipListingConfigStoreConnectionContext["status"];
  setup_status: string;
}

interface StoreListingConfigRow {
  id: number;
  store_connection_id: number;
  platform: DropshipStoreListingConfig["platform"];
  listing_mode: DropshipStoreListingConfig["listingMode"];
  inventory_mode: DropshipStoreListingConfig["inventoryMode"];
  price_mode: DropshipStoreListingConfig["priceMode"];
  marketplace_config: Record<string, unknown> | null;
  required_config_keys: unknown;
  required_product_fields: unknown;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export class PgDropshipListingConfigRepository implements DropshipListingConfigRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async loadStoreConnectionContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipListingConfigStoreConnectionContext | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<StoreConnectionContextRow>(
        `SELECT vendor_id, id AS store_connection_id, platform, status, setup_status
         FROM dropship.dropship_store_connections
         WHERE vendor_id = $1
           AND id = $2
         LIMIT 1`,
        [input.vendorId, input.storeConnectionId],
      );
      return result.rows[0] ? mapStoreConnectionContextRow(result.rows[0]) : null;
    } finally {
      client.release();
    }
  }

  async loadStoreConnectionContextById(input: {
    storeConnectionId: number;
  }): Promise<DropshipListingConfigStoreConnectionContext | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<StoreConnectionContextRow>(
        `SELECT vendor_id, id AS store_connection_id, platform, status, setup_status
         FROM dropship.dropship_store_connections
         WHERE id = $1
         LIMIT 1`,
        [input.storeConnectionId],
      );
      return result.rows[0] ? mapStoreConnectionContextRow(result.rows[0]) : null;
    } finally {
      client.release();
    }
  }

  async ensureDefaultConfig(
    input: EnsureDropshipStoreListingConfigRepositoryInput,
  ): Promise<DropshipStoreListingConfigRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const config = await ensureDefaultListingConfigWithClient(client, input);
      await client.query("COMMIT");
      return config;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceConfig(
    input: ReplaceDropshipStoreListingConfigRepositoryInput,
  ): Promise<DropshipStoreListingConfigRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_config'), $1::integer)", [
        input.storeConnectionId,
      ]);
      const result = await client.query<StoreListingConfigRow>(
        `INSERT INTO dropship.dropship_store_listing_configs
          (store_connection_id, platform, listing_mode, inventory_mode, price_mode,
           marketplace_config, required_config_keys, required_product_fields, is_active,
           created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $10)
         ON CONFLICT (store_connection_id)
         DO UPDATE SET
           platform = EXCLUDED.platform,
           listing_mode = EXCLUDED.listing_mode,
           inventory_mode = EXCLUDED.inventory_mode,
           price_mode = EXCLUDED.price_mode,
           marketplace_config = EXCLUDED.marketplace_config,
           required_config_keys = EXCLUDED.required_config_keys,
           required_product_fields = EXCLUDED.required_product_fields,
           is_active = EXCLUDED.is_active,
           updated_at = EXCLUDED.updated_at
         RETURNING id, store_connection_id, platform, listing_mode, inventory_mode, price_mode,
                   marketplace_config, required_config_keys, required_product_fields, is_active,
                   created_at, updated_at`,
        [
          input.storeConnectionId,
          input.platform,
          input.config.listingMode,
          input.config.inventoryMode,
          input.config.priceMode,
          JSON.stringify(input.config.marketplaceConfig),
          JSON.stringify(input.config.requiredConfigKeys),
          JSON.stringify(input.config.requiredProductFields),
          input.config.isActive,
          input.now,
        ],
      );
      const config = mapStoreListingConfigRow(requiredRow(
        result.rows[0],
        "Dropship listing config replacement did not return a row.",
      ));
      await recordListingConfigAuditEvent(client, {
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        eventType: "listing_config_replaced",
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        payload: {
          platform: input.platform,
          listingMode: config.listingMode,
          inventoryMode: config.inventoryMode,
          priceMode: config.priceMode,
          requiredConfigKeys: config.requiredConfigKeys,
          requiredProductFields: config.requiredProductFields,
          isActive: config.isActive,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return config;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function ensureDefaultListingConfigWithClient(
  client: PoolClient,
  input: EnsureDropshipStoreListingConfigRepositoryInput,
): Promise<DropshipStoreListingConfigRecord> {
  const defaults = buildDefaultDropshipStoreListingConfig(input.platform);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_config'), $1::integer)", [
    input.storeConnectionId,
  ]);
  const insertResult = await client.query<StoreListingConfigRow>(
    `INSERT INTO dropship.dropship_store_listing_configs
      (store_connection_id, platform, listing_mode, inventory_mode, price_mode,
       marketplace_config, required_config_keys, required_product_fields, is_active,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $10)
     ON CONFLICT (store_connection_id) DO NOTHING
     RETURNING id, store_connection_id, platform, listing_mode, inventory_mode, price_mode,
               marketplace_config, required_config_keys, required_product_fields, is_active,
               created_at, updated_at`,
    [
      input.storeConnectionId,
      defaults.platform,
      defaults.listingMode,
      defaults.inventoryMode,
      defaults.priceMode,
      JSON.stringify(defaults.marketplaceConfig),
      JSON.stringify(defaults.requiredConfigKeys),
      JSON.stringify(defaults.requiredProductFields),
      defaults.isActive,
      input.now,
    ],
  );
  if (insertResult.rows[0]) {
    await recordListingConfigAuditEvent(client, {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      eventType: "listing_config_created",
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      payload: {
        platform: defaults.platform,
        listingMode: defaults.listingMode,
        inventoryMode: defaults.inventoryMode,
        priceMode: defaults.priceMode,
      },
      occurredAt: input.now,
    });
    return mapStoreListingConfigRow(insertResult.rows[0]);
  }

  const existingResult = await client.query<StoreListingConfigRow>(
    `SELECT id, store_connection_id, platform, listing_mode, inventory_mode, price_mode,
            marketplace_config, required_config_keys, required_product_fields, is_active,
            created_at, updated_at
     FROM dropship.dropship_store_listing_configs
     WHERE store_connection_id = $1
     LIMIT 1`,
    [input.storeConnectionId],
  );
  return mapStoreListingConfigRow(requiredRow(
    existingResult.rows[0],
    "Dropship listing config ensure did not return a row.",
  ));
}

function mapStoreConnectionContextRow(row: StoreConnectionContextRow): DropshipListingConfigStoreConnectionContext {
  return {
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    status: row.status,
    setupStatus: row.setup_status,
  };
}

function mapStoreListingConfigRow(row: StoreListingConfigRow): DropshipStoreListingConfigRecord {
  return {
    id: row.id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    listingMode: row.listing_mode,
    inventoryMode: row.inventory_mode,
    priceMode: row.price_mode,
    marketplaceConfig: row.marketplace_config ?? {},
    requiredConfigKeys: stringArrayFromJson(row.required_config_keys),
    requiredProductFields: stringArrayFromJson(row.required_product_fields),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function recordListingConfigAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    eventType: string;
    actorType: string;
    actorId: string | null;
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_store_listing_config', $3, $4,
             $5, $6, 'info', $7::jsonb, $8)`,
    [
      input.vendorId,
      input.storeConnectionId,
      String(input.storeConnectionId),
      input.eventType,
      input.actorType,
      input.actorId,
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

function stringArrayFromJson(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
