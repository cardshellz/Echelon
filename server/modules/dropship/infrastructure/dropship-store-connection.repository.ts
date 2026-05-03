import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipAdminStoreConnectionListItem,
  DropshipAdminStoreConnectionListResult,
  DropshipStoreConnectionProfile,
  DropshipStoreConnectionRepository,
  DropshipStoreConnectionSetupCheck,
  DropshipStoreConnectionTokenRecord,
} from "../application/dropship-store-connection-service";
import type {
  DropshipStoreConnectionLifecycleStatus,
  DropshipSupportedStorePlatform,
} from "../domain/store-connection";
import { DropshipError } from "../domain/errors";
import { ensureDefaultListingConfigWithClient } from "./dropship-listing-config.repository";

interface StoreConnectionRow {
  id: number;
  vendor_id: number;
  platform: DropshipSupportedStorePlatform;
  external_account_id: string | null;
  external_display_name: string | null;
  shop_domain: string | null;
  access_token_ref: string | null;
  refresh_token_ref: string | null;
  token_expires_at: Date | null;
  status: DropshipStoreConnectionLifecycleStatus;
  setup_status: string;
  disconnect_reason: string | null;
  disconnected_at: Date | null;
  grace_ends_at: Date | null;
  last_sync_at: Date | null;
  last_order_sync_at: Date | null;
  last_inventory_sync_at: Date | null;
  config: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface AdminStoreConnectionRow extends StoreConnectionRow {
  vendor_member_id: string;
  vendor_business_name: string | null;
  vendor_email: string | null;
  vendor_status: string;
  vendor_entitlement_status: string;
  listing_config_id: number | null;
  listing_config_active: boolean | null;
  listing_config_listing_mode: DropshipAdminStoreConnectionListItem["listingConfig"]["listingMode"];
  listing_config_inventory_mode: DropshipAdminStoreConnectionListItem["listingConfig"]["inventoryMode"];
  listing_config_price_mode: DropshipAdminStoreConnectionListItem["listingConfig"]["priceMode"];
  listing_config_required_config_keys: unknown;
  listing_config_required_product_fields: unknown;
  listing_config_updated_at: Date | null;
  open_setup_check_count: string | number;
  error_setup_check_count: string | number;
  warning_setup_check_count: string | number;
  total_count: string | number;
}

interface SetupCheckRow {
  store_connection_id: number | null;
  check_key: string;
  status: string;
  severity: string;
  message: string | null;
  last_checked_at: Date | null;
  resolved_at: Date | null;
}

interface CountRow {
  count: string | number;
}

export class PgDropshipStoreConnectionRepository implements DropshipStoreConnectionRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listByVendorId(vendorId: number): Promise<DropshipStoreConnectionProfile[]> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<StoreConnectionRow>(
        `SELECT id, vendor_id, platform, external_account_id, external_display_name, shop_domain,
                access_token_ref, refresh_token_ref, token_expires_at, status, setup_status,
                disconnect_reason, disconnected_at, grace_ends_at, last_sync_at, last_order_sync_at,
                last_inventory_sync_at, config, created_at, updated_at
         FROM dropship.dropship_store_connections
         WHERE vendor_id = $1
         ORDER BY created_at DESC, id DESC`,
        [vendorId],
      );
      return result.rows.map(mapStoreConnectionRow);
    } finally {
      client.release();
    }
  }

  async listForAdmin(input: Parameters<DropshipStoreConnectionRepository["listForAdmin"]>[0]): Promise<DropshipAdminStoreConnectionListResult> {
    const filters = buildAdminStoreConnectionFilters(input);
    const offset = (input.page - 1) * input.limit;
    const result = await this.dbPool.query<AdminStoreConnectionRow>(
      `SELECT sc.id, sc.vendor_id, sc.platform, sc.external_account_id, sc.external_display_name,
              sc.shop_domain, sc.access_token_ref, sc.refresh_token_ref, sc.token_expires_at,
              sc.status, sc.setup_status, sc.disconnect_reason, sc.disconnected_at,
              sc.grace_ends_at, sc.last_sync_at, sc.last_order_sync_at, sc.last_inventory_sync_at,
              sc.config, sc.created_at, sc.updated_at,
              v.member_id AS vendor_member_id,
              v.business_name AS vendor_business_name,
              v.email AS vendor_email,
              v.status AS vendor_status,
              v.entitlement_status AS vendor_entitlement_status,
              slc.id AS listing_config_id,
              slc.is_active AS listing_config_active,
              slc.listing_mode AS listing_config_listing_mode,
              slc.inventory_mode AS listing_config_inventory_mode,
              slc.price_mode AS listing_config_price_mode,
              slc.required_config_keys AS listing_config_required_config_keys,
              slc.required_product_fields AS listing_config_required_product_fields,
              slc.updated_at AS listing_config_updated_at,
              COALESCE(check_counts.open_setup_check_count, 0) AS open_setup_check_count,
              COALESCE(check_counts.error_setup_check_count, 0) AS error_setup_check_count,
              COALESCE(check_counts.warning_setup_check_count, 0) AS warning_setup_check_count,
              COUNT(*) OVER() AS total_count
       FROM dropship.dropship_store_connections sc
       INNER JOIN dropship.dropship_vendors v ON v.id = sc.vendor_id
       LEFT JOIN dropship.dropship_store_listing_configs slc ON slc.store_connection_id = sc.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS open_setup_check_count,
                COUNT(*) FILTER (WHERE severity = 'error') AS error_setup_check_count,
                COUNT(*) FILTER (WHERE severity = 'warning') AS warning_setup_check_count
         FROM dropship.dropship_store_setup_checks ssc
         WHERE ssc.store_connection_id = sc.id
           AND ssc.resolved_at IS NULL
       ) check_counts ON true
       ${filters.whereSql}
       ORDER BY sc.updated_at DESC, sc.id DESC
       LIMIT $${filters.params.length + 1} OFFSET $${filters.params.length + 2}`,
      [...filters.params, input.limit, offset],
    );

    return {
      items: result.rows.map(mapAdminStoreConnectionRow),
      total: toSafeInteger(result.rows[0]?.total_count ?? 0, "store connection total count"),
      page: input.page,
      limit: input.limit,
    };
  }

  async countActiveByVendorId(vendorId: number): Promise<number> {
    const client = await this.dbPool.connect();
    try {
      return countActiveByVendorIdWithClient(client, vendorId);
    } finally {
      client.release();
    }
  }

  async connectStore(input: {
    vendorId: number;
    platform: DropshipSupportedStorePlatform;
    externalAccountId: string | null;
    externalDisplayName: string | null;
    shopDomain: string | null;
    accessTokenRef: string;
    refreshTokenRef: string | null;
    tokenExpiresAt: Date | null;
    tokenRecords: DropshipStoreConnectionTokenRecord[];
    config: Record<string, unknown>;
    connectedAt: Date;
  }): Promise<DropshipStoreConnectionProfile> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await lockVendorConnections(client, input.vendorId);

      const activeCount = await countActiveByVendorIdWithClient(client, input.vendorId);
      if (activeCount > 0) {
        throw new DropshipError(
          "DROPSHIP_STORE_CONNECTION_LIMIT_REACHED",
          "Dropship store connection limit has been reached.",
          { vendorId: input.vendorId, activeConnectionCount: activeCount },
        );
      }

      const existing = await findReusableConnection(client, input.vendorId, input.platform, input.shopDomain);
      const connection = existing
        ? await updateConnection(client, existing.id, input)
        : await insertConnection(client, input);

      await replaceTokenRecords(client, connection.storeConnectionId, input.tokenRecords);
      await ensureDefaultListingConfigWithClient(client, {
        vendorId: input.vendorId,
        storeConnectionId: connection.storeConnectionId,
        platform: input.platform,
        actor: { actorType: "vendor", actorId: String(input.vendorId) },
        now: input.connectedAt,
      });
      await recordAuditEvent(client, {
        vendorId: input.vendorId,
        storeConnectionId: connection.storeConnectionId,
        eventType: existing ? "store_connection_reconnected" : "store_connection_connected",
        payload: {
          platform: input.platform,
          externalAccountId: input.externalAccountId,
          shopDomain: input.shopDomain,
          hasRefreshToken: input.refreshTokenRef !== null,
        },
        occurredAt: input.connectedAt,
      });

      await client.query("COMMIT");
      return connection;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async disconnectStore(input: {
    vendorId: number;
    storeConnectionId: number;
    reason: string;
    disconnectedAt: Date;
    graceEndsAt: Date;
    idempotencyKey: string;
  }): Promise<DropshipStoreConnectionProfile> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await lockVendorConnections(client, input.vendorId);

      const existing = await findConnectionByIdForUpdate(client, input.vendorId, input.storeConnectionId);
      if (!existing) {
        throw new DropshipError("DROPSHIP_STORE_CONNECTION_NOT_FOUND", "Dropship store connection was not found.", {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
        });
      }

      if (existing.status === "disconnected" || existing.status === "grace_period") {
        await client.query("COMMIT");
        return mapStoreConnectionRow(existing);
      }

      const result = await client.query<StoreConnectionRow>(
        `UPDATE dropship.dropship_store_connections
         SET status = 'grace_period',
             setup_status = 'attention_required',
             access_token_ref = NULL,
             refresh_token_ref = NULL,
             token_expires_at = NULL,
             disconnect_reason = $3,
             disconnected_at = $4,
             grace_ends_at = $5,
             updated_at = $4
         WHERE id = $1 AND vendor_id = $2
         RETURNING id, vendor_id, platform, external_account_id, external_display_name, shop_domain,
                   access_token_ref, refresh_token_ref, token_expires_at, status, setup_status,
                   disconnect_reason, disconnected_at, grace_ends_at, last_sync_at, last_order_sync_at,
                   last_inventory_sync_at, config, created_at, updated_at`,
        [
          input.storeConnectionId,
          input.vendorId,
          input.reason,
          input.disconnectedAt,
          input.graceEndsAt,
        ],
      );
      await client.query(
        `DELETE FROM dropship.dropship_store_connection_tokens WHERE store_connection_id = $1`,
        [input.storeConnectionId],
      );
      await recordAuditEvent(client, {
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        eventType: "store_connection_disconnect_started",
        payload: {
          reason: input.reason,
          graceEndsAt: input.graceEndsAt.toISOString(),
          idempotencyKey: input.idempotencyKey,
        },
        occurredAt: input.disconnectedAt,
      });

      await client.query("COMMIT");
      return mapStoreConnectionRow(requiredRow(result.rows[0], "Dropship store disconnect did not return a row."));
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateOrderProcessingConfig(input: {
    storeConnectionId: number;
    defaultWarehouseId: number | null;
    actor: {
      actorType: "admin" | "system";
      actorId?: string;
    };
    idempotencyKey: string;
    updatedAt: Date;
  }): Promise<DropshipStoreConnectionProfile> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await findConnectionByIdAnyVendorForUpdate(client, input.storeConnectionId);
      if (!existing) {
        throw new DropshipError(
          "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
          "Dropship store connection was not found.",
          { storeConnectionId: input.storeConnectionId },
        );
      }

      const nextConfig = mergeOrderProcessingConfig(existing.config ?? {}, {
        defaultWarehouseId: input.defaultWarehouseId,
      });
      const result = await client.query<StoreConnectionRow>(
        `UPDATE dropship.dropship_store_connections
         SET config = $2::jsonb,
             updated_at = $3
         WHERE id = $1
         RETURNING id, vendor_id, platform, external_account_id, external_display_name, shop_domain,
                   access_token_ref, refresh_token_ref, token_expires_at, status, setup_status,
                   disconnect_reason, disconnected_at, grace_ends_at, last_sync_at, last_order_sync_at,
                   last_inventory_sync_at, config, created_at, updated_at`,
        [
          input.storeConnectionId,
          JSON.stringify(nextConfig),
          input.updatedAt,
        ],
      );
      const updated = requiredRow(
        result.rows[0],
        "Dropship store order processing config update did not return a row.",
      );
      await recordAuditEvent(client, {
        vendorId: updated.vendor_id,
        storeConnectionId: updated.id,
        eventType: "store_order_processing_config_updated",
        actor: input.actor,
        payload: {
          idempotencyKey: input.idempotencyKey,
          previousDefaultWarehouseId: readOrderProcessingDefaultWarehouseId(existing.config ?? {}),
          defaultWarehouseId: input.defaultWarehouseId,
        },
        occurredAt: input.updatedAt,
      });

      await client.query("COMMIT");
      return mapStoreConnectionRow(updated);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async listSetupChecks(vendorId: number): Promise<Record<number, DropshipStoreConnectionSetupCheck[]>> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<SetupCheckRow>(
        `SELECT store_connection_id, check_key, status, severity, message, last_checked_at, resolved_at
         FROM dropship.dropship_store_setup_checks
         WHERE vendor_id = $1 AND store_connection_id IS NOT NULL
         ORDER BY check_key ASC`,
        [vendorId],
      );
      const grouped: Record<number, DropshipStoreConnectionSetupCheck[]> = {};
      for (const row of result.rows) {
        if (row.store_connection_id === null) continue;
        grouped[row.store_connection_id] ??= [];
        grouped[row.store_connection_id].push({
          checkKey: row.check_key,
          status: row.status,
          severity: row.severity,
          message: row.message,
          lastCheckedAt: row.last_checked_at,
          resolvedAt: row.resolved_at,
        });
      }
      return grouped;
    } finally {
      client.release();
    }
  }
}

async function lockVendorConnections(client: PoolClient, vendorId: number): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_store_connection'), $1)", [vendorId]);
}

async function countActiveByVendorIdWithClient(client: PoolClient, vendorId: number): Promise<number> {
  const result = await client.query<CountRow>(
    `SELECT COUNT(*) AS count
     FROM dropship.dropship_store_connections
     WHERE vendor_id = $1
       AND status IN ('connected','needs_reauth','refresh_failed','grace_period','paused')`,
    [vendorId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function buildAdminStoreConnectionFilters(input: Parameters<DropshipStoreConnectionRepository["listForAdmin"]>[0]): {
  whereSql: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (input.statuses?.length) {
    params.push(input.statuses);
    clauses.push(`sc.status = ANY($${params.length}::text[])`);
  }
  if (input.platform) {
    params.push(input.platform);
    clauses.push(`sc.platform = $${params.length}`);
  }
  if (input.vendorId) {
    params.push(input.vendorId);
    clauses.push(`sc.vendor_id = $${params.length}`);
  }
  if (input.search) {
    params.push(`%${input.search}%`);
    clauses.push(`(
      sc.external_account_id ILIKE $${params.length}
      OR sc.external_display_name ILIKE $${params.length}
      OR sc.shop_domain ILIKE $${params.length}
      OR v.business_name ILIKE $${params.length}
      OR v.email ILIKE $${params.length}
      OR v.member_id ILIKE $${params.length}
    )`);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

async function findReusableConnection(
  client: PoolClient,
  vendorId: number,
  platform: DropshipSupportedStorePlatform,
  shopDomain: string | null,
): Promise<StoreConnectionRow | null> {
  const result = await client.query<StoreConnectionRow>(
    `SELECT id, vendor_id, platform, external_account_id, external_display_name, shop_domain,
            access_token_ref, refresh_token_ref, token_expires_at, status, setup_status,
            disconnect_reason, disconnected_at, grace_ends_at, last_sync_at, last_order_sync_at,
            last_inventory_sync_at, config, created_at, updated_at
     FROM dropship.dropship_store_connections
     WHERE vendor_id = $1
       AND platform = $2
       AND COALESCE(shop_domain, '') = COALESCE($3, '')
       AND status = 'disconnected'
     ORDER BY updated_at DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [vendorId, platform, shopDomain],
  );
  return result.rows[0] ?? null;
}

async function findConnectionByIdForUpdate(
  client: PoolClient,
  vendorId: number,
  storeConnectionId: number,
): Promise<StoreConnectionRow | null> {
  const result = await client.query<StoreConnectionRow>(
    `SELECT id, vendor_id, platform, external_account_id, external_display_name, shop_domain,
            access_token_ref, refresh_token_ref, token_expires_at, status, setup_status,
            disconnect_reason, disconnected_at, grace_ends_at, last_sync_at, last_order_sync_at,
            last_inventory_sync_at, config, created_at, updated_at
     FROM dropship.dropship_store_connections
     WHERE vendor_id = $1 AND id = $2
     FOR UPDATE`,
    [vendorId, storeConnectionId],
  );
  return result.rows[0] ?? null;
}

async function findConnectionByIdAnyVendorForUpdate(
  client: PoolClient,
  storeConnectionId: number,
): Promise<StoreConnectionRow | null> {
  const result = await client.query<StoreConnectionRow>(
    `SELECT id, vendor_id, platform, external_account_id, external_display_name, shop_domain,
            access_token_ref, refresh_token_ref, token_expires_at, status, setup_status,
            disconnect_reason, disconnected_at, grace_ends_at, last_sync_at, last_order_sync_at,
            last_inventory_sync_at, config, created_at, updated_at
     FROM dropship.dropship_store_connections
     WHERE id = $1
     FOR UPDATE`,
    [storeConnectionId],
  );
  return result.rows[0] ?? null;
}

async function insertConnection(
  client: PoolClient,
  input: Parameters<DropshipStoreConnectionRepository["connectStore"]>[0],
): Promise<DropshipStoreConnectionProfile> {
  const result = await client.query<StoreConnectionRow>(
    `INSERT INTO dropship.dropship_store_connections
       (vendor_id, platform, external_account_id, external_display_name, shop_domain,
        access_token_ref, refresh_token_ref, token_expires_at, status, setup_status,
        disconnect_reason, disconnected_at, grace_ends_at, config, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'connected', 'pending',
             NULL, NULL, NULL, $9::jsonb, $10, $10)
     RETURNING id, vendor_id, platform, external_account_id, external_display_name, shop_domain,
               access_token_ref, refresh_token_ref, token_expires_at, status, setup_status,
               disconnect_reason, disconnected_at, grace_ends_at, last_sync_at, last_order_sync_at,
               last_inventory_sync_at, config, created_at, updated_at`,
    [
      input.vendorId,
      input.platform,
      input.externalAccountId,
      input.externalDisplayName,
      input.shopDomain,
      input.accessTokenRef,
      input.refreshTokenRef,
      input.tokenExpiresAt,
      JSON.stringify(input.config),
      input.connectedAt,
    ],
  );
  return mapStoreConnectionRow(requiredRow(result.rows[0], "Dropship store connection insert did not return a row."));
}

async function updateConnection(
  client: PoolClient,
  storeConnectionId: number,
  input: Parameters<DropshipStoreConnectionRepository["connectStore"]>[0],
): Promise<DropshipStoreConnectionProfile> {
  const result = await client.query<StoreConnectionRow>(
    `UPDATE dropship.dropship_store_connections
     SET external_account_id = $3,
         external_display_name = $4,
         access_token_ref = $5,
         refresh_token_ref = $6,
         token_expires_at = $7,
         status = 'connected',
         setup_status = 'pending',
         disconnect_reason = NULL,
         disconnected_at = NULL,
         grace_ends_at = NULL,
         config = $8::jsonb,
         updated_at = $9
     WHERE id = $1 AND vendor_id = $2
     RETURNING id, vendor_id, platform, external_account_id, external_display_name, shop_domain,
               access_token_ref, refresh_token_ref, token_expires_at, status, setup_status,
               disconnect_reason, disconnected_at, grace_ends_at, last_sync_at, last_order_sync_at,
               last_inventory_sync_at, config, created_at, updated_at`,
    [
      storeConnectionId,
      input.vendorId,
      input.externalAccountId,
      input.externalDisplayName,
      input.accessTokenRef,
      input.refreshTokenRef,
      input.tokenExpiresAt,
      JSON.stringify(input.config),
      input.connectedAt,
    ],
  );
  return mapStoreConnectionRow(requiredRow(result.rows[0], "Dropship store connection update did not return a row."));
}

async function replaceTokenRecords(
  client: PoolClient,
  storeConnectionId: number,
  tokenRecords: DropshipStoreConnectionTokenRecord[],
): Promise<void> {
  await client.query(
    `DELETE FROM dropship.dropship_store_connection_tokens WHERE store_connection_id = $1`,
    [storeConnectionId],
  );

  for (const tokenRecord of tokenRecords) {
    await client.query(
      `INSERT INTO dropship.dropship_store_connection_tokens
        (store_connection_id, token_kind, token_ref, key_id, ciphertext, iv, auth_tag, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        storeConnectionId,
        tokenRecord.tokenKind,
        tokenRecord.tokenRef,
        tokenRecord.keyId,
        tokenRecord.ciphertext,
        tokenRecord.iv,
        tokenRecord.authTag,
        tokenRecord.expiresAt,
      ],
    );
  }
}

async function recordAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    eventType: string;
    actor?: {
      actorType: "vendor" | "admin" | "system";
      actorId?: string;
    };
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_store_connection', $3, $4, $5, $6, 'info', $7::jsonb, $8)`,
    [
      input.vendorId,
      input.storeConnectionId,
      String(input.storeConnectionId),
      input.eventType,
      input.actor?.actorType ?? "vendor",
      input.actor?.actorId ?? String(input.vendorId),
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

function mapStoreConnectionRow(row: StoreConnectionRow): DropshipStoreConnectionProfile {
  return {
    storeConnectionId: row.id,
    vendorId: row.vendor_id,
    platform: row.platform,
    externalAccountId: row.external_account_id,
    externalDisplayName: row.external_display_name,
    shopDomain: row.shop_domain,
    status: row.status,
    setupStatus: row.setup_status,
    disconnectReason: row.disconnect_reason,
    disconnectedAt: row.disconnected_at,
    graceEndsAt: row.grace_ends_at,
    tokenExpiresAt: row.token_expires_at,
    hasAccessToken: row.access_token_ref !== null,
    hasRefreshToken: row.refresh_token_ref !== null,
    lastSyncAt: row.last_sync_at,
    lastOrderSyncAt: row.last_order_sync_at,
    lastInventorySyncAt: row.last_inventory_sync_at,
    orderProcessingConfig: {
      defaultWarehouseId: readOrderProcessingDefaultWarehouseId(row.config ?? {}),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAdminStoreConnectionRow(row: AdminStoreConnectionRow): DropshipAdminStoreConnectionListItem {
  return {
    ...mapStoreConnectionRow(row),
    vendor: {
      vendorId: row.vendor_id,
      memberId: row.vendor_member_id,
      businessName: row.vendor_business_name,
      email: row.vendor_email,
      status: row.vendor_status,
      entitlementStatus: row.vendor_entitlement_status,
    },
    listingConfig: {
      isConfigured: row.listing_config_id !== null,
      isActive: row.listing_config_active === true,
      listingMode: row.listing_config_listing_mode,
      inventoryMode: row.listing_config_inventory_mode,
      priceMode: row.listing_config_price_mode,
      requiredConfigKeys: stringArrayFromJson(row.listing_config_required_config_keys),
      requiredProductFields: stringArrayFromJson(row.listing_config_required_product_fields),
      updatedAt: row.listing_config_updated_at,
    },
    setupCheckSummary: {
      openCount: toSafeInteger(row.open_setup_check_count, "open setup check count"),
      errorCount: toSafeInteger(row.error_setup_check_count, "error setup check count"),
      warningCount: toSafeInteger(row.warning_setup_check_count, "warning setup check count"),
    },
  };
}

function mergeOrderProcessingConfig(
  config: Record<string, unknown>,
  input: { defaultWarehouseId: number | null },
): Record<string, unknown> {
  const orderProcessing = isRecord(config.orderProcessing)
    ? { ...config.orderProcessing }
    : {};
  orderProcessing.defaultWarehouseId = input.defaultWarehouseId;
  return {
    ...config,
    orderProcessing,
  };
}

function readOrderProcessingDefaultWarehouseId(config: Record<string, unknown>): number | null {
  const value = isRecord(config.orderProcessing)
    ? config.orderProcessing.defaultWarehouseId
    : undefined;
  if (value === null || typeof value === "undefined" || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function toSafeInteger(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Dropship ${label} is outside the safe integer range.`);
  }
  return parsed;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
