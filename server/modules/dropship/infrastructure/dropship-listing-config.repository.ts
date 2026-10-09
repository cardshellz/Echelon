import type { Pool, PoolClient } from "pg";
import type { DropshipStoreConnectionStatus } from "../../../../shared/schema/dropship.schema";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import {
  assertStoreStatusAllowsListingConfigWrite,
  buildDefaultDropshipStoreListingConfig,
  listingConfigChangedFields,
  listingConfigContent,
  listingConfigContentEquals,
  type DropshipListingConfigKeyedRequestRecord,
  type DropshipListingConfigRepository,
  type DropshipListingConfigStoreConnectionContext,
  type DropshipStoreListingConfigRecord,
  type EnsureDropshipStoreListingConfigRepositoryInput,
  type ReplaceDropshipStoreListingConfigRepositoryInput,
  type ReplaceDropshipStoreListingConfigRepositoryResult,
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
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface KeyedRequestRow {
  store_connection_id: number;
  operation: DropshipListingConfigKeyedRequestRecord["operation"];
  request_hash: string;
  revision_before: number;
  revision_after: number;
  outcome: DropshipListingConfigKeyedRequestRecord["outcome"];
  created_at: Date;
}

const CONFIG_COLUMNS = `id, store_connection_id, platform, listing_mode, inventory_mode, price_mode,
  marketplace_config, required_config_keys, required_product_fields, is_active,
  revision, created_at, updated_at`;

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

  async findConfig(input: { storeConnectionId: number }): Promise<DropshipStoreListingConfigRecord | null> {
    const result = await this.dbPool.query<StoreListingConfigRow>(
      `SELECT ${CONFIG_COLUMNS}
       FROM dropship.dropship_store_listing_configs
       WHERE store_connection_id = $1
       LIMIT 1`,
      [input.storeConnectionId],
    );
    return result.rows[0] ? mapStoreListingConfigRow(result.rows[0]) : null;
  }

  async findKeyedRequest(input: {
    vendorId: number;
    idempotencyKey: string;
  }): Promise<DropshipListingConfigKeyedRequestRecord | null> {
    const result = await this.dbPool.query<KeyedRequestRow>(
      `SELECT store_connection_id, operation, request_hash, revision_before, revision_after, outcome, created_at
       FROM dropship.dropship_listing_config_requests
       WHERE vendor_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [input.vendorId, input.idempotencyKey],
    );
    return result.rows[0] ? mapKeyedRequestRow(result.rows[0]) : null;
  }

  /**
   * One transaction: lock, re-check, compare-and-set, audit, ledger.
   *
   * Lock order matches every other listing-settings writer and queue creation
   * (store-wide 'dropship_listing_push_job' lock, then the vendor and store
   * rows, then the listing-config lock), and connectStore (store row, then
   * the listing-config lock), so no two of them wait on each other in a cycle.
   * The vendor row is locked with the store row, before the audit and ledger
   * inserts take their foreign-key share lock on it: taking it only then would
   * deadlock with order acceptance, which locks the vendor row FOR UPDATE and
   * then the store row (FOR UPDATE OF v, sc).
   */
  async replaceConfig(
    input: ReplaceDropshipStoreListingConfigRepositoryInput,
  ): Promise<ReplaceDropshipStoreListingConfigRepositoryResult> {
    // The request ledger names who asked (migration 0728 actor_id NOT NULL).
    if (input.request && !input.actor.actorId?.trim()) {
      throw new DropshipError(
        "DROPSHIP_LISTING_CONFIG_REQUEST_ACTOR_REQUIRED",
        "A keyed listing settings request needs the id of who made it.",
        { storeConnectionId: input.storeConnectionId, actorType: input.actor.actorType, retryable: false },
      );
    }
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [
        input.storeConnectionId,
      ]);
      const storeResult = await client.query<{ status: DropshipStoreConnectionStatus }>(
        `SELECT sc.status
         FROM dropship.dropship_vendors v
         JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
         WHERE v.id = $2 AND sc.id = $1
         FOR SHARE OF v, sc`,
        [input.storeConnectionId, input.vendorId],
      );
      const store = storeResult.rows[0];
      if (!store) {
        throw new DropshipError(
          "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
          "Dropship store connection was not found.",
          { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId },
        );
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_config'), $1::integer)", [
        input.storeConnectionId,
      ]);

      // A request already applied is answered from the ledger before any
      // other check: its own save moved the revision, so the revision check
      // would refuse an honest retry.
      if (input.request) {
        const prior = await selectKeyedRequest(client, input.vendorId, input.request.idempotencyKey);
        if (prior) {
          if (prior.requestHash !== input.request.requestHash
            || prior.storeConnectionId !== input.storeConnectionId
            || prior.operation !== input.request.operation) {
            throw idempotencyConflict(input);
          }
          const current = await selectConfigForUpdate(client, input.storeConnectionId);
          if (!current) throw revisionConflict(input, null);
          await client.query("COMMIT");
          return { config: current, outcome: "replayed", revisionBefore: prior.revisionBefore, revisionAfter: prior.revisionAfter };
        }
      }

      assertStoreStatusAllowsListingConfigWrite({
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        status: store.status,
      }, input.allowedStoreStatuses);

      const current = await selectConfigForUpdate(client, input.storeConnectionId);
      if (!current || current.revision !== input.expectedRevision) {
        throw revisionConflict(input, current?.revision ?? null);
      }

      if (listingConfigContentEquals(current, input.config)) {
        await recordKeyedRequest(client, input, current.revision, current.revision, "unchanged");
        await client.query("COMMIT");
        return { config: current, outcome: "unchanged", revisionBefore: current.revision, revisionAfter: current.revision };
      }

      // The revision is set by the trigger (+1 for a changed config); the
      // WHERE clause is the compare-and-set itself.
      const updateResult = await client.query<StoreListingConfigRow>(
        `UPDATE dropship.dropship_store_listing_configs
         SET platform = $3,
             listing_mode = $4,
             inventory_mode = $5,
             price_mode = $6,
             marketplace_config = $7::jsonb,
             required_config_keys = $8::jsonb,
             required_product_fields = $9::jsonb,
             is_active = $10,
             updated_at = $11
         WHERE store_connection_id = $1 AND revision = $2
         RETURNING ${CONFIG_COLUMNS}`,
        [
          input.storeConnectionId,
          input.expectedRevision,
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
      const updatedRow = updateResult.rows[0];
      if (!updatedRow) throw revisionConflict(input, null);
      const config = mapStoreListingConfigRow(updatedRow);
      if (config.revision !== current.revision + 1) {
        throw new DropshipError(
          "DROPSHIP_LISTING_CONFIG_REVISION_INVARIANT_FAILED",
          "The listing config revision did not advance by exactly one.",
          {
            storeConnectionId: input.storeConnectionId,
            revisionBefore: current.revision,
            revisionAfter: config.revision,
            retryable: false,
          },
        );
      }

      await recordListingConfigAuditEvent(client, {
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        eventType: input.auditEventType,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        payload: {
          platform: input.platform,
          requestKey: input.request?.idempotencyKey ?? null,
          revisionBefore: current.revision,
          revisionAfter: config.revision,
          changedFields: listingConfigChangedFields(current, config),
          before: listingConfigContent(current),
          after: listingConfigContent(config),
        },
        occurredAt: input.now,
      });
      await recordKeyedRequest(client, input, current.revision, config.revision, "changed");
      await client.query("COMMIT");
      return { config, outcome: "changed", revisionBefore: current.revision, revisionAfter: config.revision };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapUniqueKeyViolation(error, input);
    } finally {
      client.release();
    }
  }
}

async function selectConfigForUpdate(
  client: PoolClient,
  storeConnectionId: number,
): Promise<DropshipStoreListingConfigRecord | null> {
  const result = await client.query<StoreListingConfigRow>(
    `SELECT ${CONFIG_COLUMNS}
     FROM dropship.dropship_store_listing_configs
     WHERE store_connection_id = $1
     FOR UPDATE`,
    [storeConnectionId],
  );
  return result.rows[0] ? mapStoreListingConfigRow(result.rows[0]) : null;
}

async function selectKeyedRequest(
  client: PoolClient,
  vendorId: number,
  idempotencyKey: string,
): Promise<DropshipListingConfigKeyedRequestRecord | null> {
  const result = await client.query<KeyedRequestRow>(
    `SELECT store_connection_id, operation, request_hash, revision_before, revision_after, outcome, created_at
     FROM dropship.dropship_listing_config_requests
     WHERE vendor_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [vendorId, idempotencyKey],
  );
  return result.rows[0] ? mapKeyedRequestRow(result.rows[0]) : null;
}

async function recordKeyedRequest(
  client: PoolClient,
  input: ReplaceDropshipStoreListingConfigRepositoryInput,
  revisionBefore: number,
  revisionAfter: number,
  outcome: "changed" | "unchanged",
): Promise<void> {
  if (!input.request) return;
  await client.query(
    `INSERT INTO dropship.dropship_listing_config_requests
      (vendor_id, store_connection_id, operation, idempotency_key, request_hash,
       actor_type, actor_id, revision_before, revision_after, outcome, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.vendorId,
      input.storeConnectionId,
      input.request.operation,
      input.request.idempotencyKey,
      input.request.requestHash,
      input.actor.actorType,
      input.actor.actorId,
      revisionBefore,
      revisionAfter,
      outcome,
      input.now,
    ],
  );
}

function revisionConflict(
  input: ReplaceDropshipStoreListingConfigRepositoryInput,
  currentRevision: number | null,
): DropshipError {
  return new DropshipError(
    "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
    "These store settings changed after they were loaded. Load the latest settings and save again.",
    {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      expectedRevision: input.expectedRevision,
      currentRevision,
      retryable: false,
    },
  );
}

function idempotencyConflict(input: ReplaceDropshipStoreListingConfigRepositoryInput): DropshipError {
  return new DropshipError(
    "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
    "This request key was already used for a different listing settings change.",
    {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      retryable: false,
    },
  );
}

/**
 * Two requests with one new key can both miss the ledger only if they ran for
 * different stores (the listing-config lock serializes one store); the
 * unique index then refuses the second, which is the same key misuse.
 */
function mapUniqueKeyViolation(
  error: unknown,
  input: ReplaceDropshipStoreListingConfigRepositoryInput,
): unknown {
  const pgError = error as { code?: unknown; constraint?: unknown } | null;
  if (pgError?.code === "23505" && pgError.constraint === "dropship_listing_config_requests_key_idx") {
    return idempotencyConflict(input);
  }
  return error;
}

function mapKeyedRequestRow(row: KeyedRequestRow): DropshipListingConfigKeyedRequestRecord {
  return {
    storeConnectionId: row.store_connection_id,
    operation: row.operation,
    requestHash: row.request_hash,
    revisionBefore: row.revision_before,
    revisionAfter: row.revision_after,
    outcome: row.outcome,
    createdAt: row.created_at,
  };
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
     RETURNING ${CONFIG_COLUMNS}`,
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
    `SELECT ${CONFIG_COLUMNS}
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
    revision: requiredRevision(row.revision, row.store_connection_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The column is NOT NULL with CHECK (> 0); anything else is a broken read, not a value to guess. */
function requiredRevision(value: unknown, storeConnectionId: number): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new DropshipError(
    "DROPSHIP_LISTING_CONFIG_REVISION_INVALID",
    "The stored listing config has no valid revision.",
    { storeConnectionId, revision: value, retryable: false },
  );
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
