import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  FulfillmentProviderCatalogConnectionStore,
  FulfillmentProviderConnectionCatalogState,
  FulfillmentProviderCredentialRecord,
} from "../application/connected-fulfillment-method-catalog.service";
import {
  FulfillmentProviderConnectionError,
  type AppendFulfillmentProviderConnectionEventInput,
  type CreateFulfillmentProviderConnectionRecordInput,
  type FulfillmentProviderConnectionCommand,
  type FulfillmentProviderConnectionState,
  type FulfillmentProviderConnectionStore,
  type FulfillmentProviderConnectionTransaction,
  type FulfillmentProviderRoutedMethodIdentity,
  type UpdateFulfillmentProviderConnectionRecordInput,
} from "../application/fulfillment-provider-connections.service";

interface ConnectionRow {
  id: string | number;
  provider: string;
  name: string;
  status: "active" | "disabled" | "error";
  credential_source: "environment" | "vault";
  credential_ref: string | null;
  credential_present: boolean;
  system_managed: boolean;
  revision: number;
  routed_method_count: string | number;
  last_verified_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_by: string;
  created_at: Date;
  updated_by: string;
  updated_at: Date;
}

interface CredentialRow {
  connection_id: string | number;
  key_id: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
}

interface CommandRow {
  connection_id: string | number;
  request_hash: string;
}

const CONNECTION_SELECT = `
  SELECT connection.id,
         connection.provider,
         connection.name,
         connection.status,
         connection.credential_source,
         connection.credential_ref,
         EXISTS (
           SELECT 1
           FROM shipping.fulfillment_provider_credentials AS credential
           WHERE credential.connection_id = connection.id
         ) AS credential_present,
         connection.system_managed,
         connection.revision,
         (
           SELECT count(*)
           FROM shipping.service_level_methods AS method
           WHERE method.provider_connection_id = connection.id
             AND method.is_active = TRUE
         ) AS routed_method_count,
         connection.last_verified_at,
         connection.last_error_code,
         connection.last_error_message,
         connection.created_by,
         connection.created_at,
         connection.updated_by,
         connection.updated_at
  FROM shipping.fulfillment_provider_connections AS connection`;

export class PostgresFulfillmentProviderConnectionStore
implements FulfillmentProviderConnectionStore, FulfillmentProviderCatalogConnectionStore {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listConnections(): Promise<FulfillmentProviderConnectionState[]> {
    const result = await this.dbPool.query<ConnectionRow>(
      `${CONNECTION_SELECT}
       ORDER BY connection.name ASC, connection.id ASC`,
    );
    return result.rows.map(mapConnection);
  }

  async listCatalogConnections(): Promise<FulfillmentProviderConnectionCatalogState[]> {
    return (await this.listConnections()).map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      name: connection.name,
      status: connection.status,
      credentialSource: connection.credentialSource,
      credentialRef: connection.credentialRef,
      revision: connection.revision,
    }));
  }

  async getConnection(connectionId: number): Promise<FulfillmentProviderConnectionState | null> {
    const result = await this.dbPool.query<ConnectionRow>(
      `${CONNECTION_SELECT}
       WHERE connection.id = $1
       LIMIT 1`,
      [connectionId],
    );
    return result.rows[0] ? mapConnection(result.rows[0]) : null;
  }

  async getCredential(connectionId: number): Promise<FulfillmentProviderCredentialRecord | null> {
    return loadCredential(this.dbPool, connectionId);
  }

  async findCommand(idempotencyKey: string): Promise<FulfillmentProviderConnectionCommand | null> {
    return findCommand(this.dbPool, idempotencyKey);
  }

  async transaction<T>(
    work: (tx: FulfillmentProviderConnectionTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PostgresFulfillmentProviderConnectionTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresFulfillmentProviderConnectionTransaction
implements FulfillmentProviderConnectionTransaction {
  constructor(private readonly client: PoolClient) {}

  async lockIdempotencyKey(idempotencyKey: string): Promise<void> {
    await this.client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [idempotencyKey],
    );
  }

  findCommand(idempotencyKey: string): Promise<FulfillmentProviderConnectionCommand | null> {
    return findCommand(this.client, idempotencyKey);
  }

  async createConnection(input: CreateFulfillmentProviderConnectionRecordInput): Promise<number> {
    const result = await this.client.query<{ id: string | number }>(
      `INSERT INTO shipping.fulfillment_provider_connections
        (provider, name, status, credential_source, credential_ref,
         system_managed, revision, last_verified_at, last_error_code,
         last_error_message, created_by, created_at, updated_by, updated_at)
       VALUES ($1, $2, 'active', 'vault', NULL, FALSE, 1, $4, NULL, NULL,
               $3, $4, $3, $4)
       RETURNING id`,
      [input.provider, input.name, input.actorUserId, input.now],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw dataIntegrityError("Provider connection insert did not return an id.");
    return safeId(id, "fulfillment provider connection id");
  }

  async getConnectionForUpdate(
    connectionId: number,
  ): Promise<FulfillmentProviderConnectionState | null> {
    const locked = await this.client.query<{ id: string | number }>(
      `SELECT id
       FROM shipping.fulfillment_provider_connections
       WHERE id = $1
       FOR UPDATE`,
      [connectionId],
    );
    if (!locked.rows[0]) return null;
    const result = await this.client.query<ConnectionRow>(
      `${CONNECTION_SELECT}
       WHERE connection.id = $1
       LIMIT 1`,
      [connectionId],
    );
    return result.rows[0] ? mapConnection(result.rows[0]) : null;
  }

  async listActiveRouteMethods(
    connectionId: number,
  ): Promise<FulfillmentProviderRoutedMethodIdentity[]> {
    const result = await this.client.query<{
      provider: string;
      provider_account_id: string;
      service_code: string;
      domestic: boolean;
      international: boolean;
    }>(
      `SELECT provider, provider_account_id, service_code, domestic, international
       FROM shipping.service_level_methods
       WHERE provider_connection_id = $1
         AND is_active = TRUE
       ORDER BY provider_account_id, service_code, domestic DESC, international DESC`,
      [connectionId],
    );
    return result.rows.map((row) => ({
      provider: row.provider,
      providerAccountId: row.provider_account_id,
      serviceCode: row.service_code,
      domestic: row.domestic,
      international: row.international,
    }));
  }

  async saveCredential(input: {
    credential: FulfillmentProviderCredentialRecord;
    actorUserId: string;
    now: Date;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO shipping.fulfillment_provider_credentials
        (connection_id, key_id, ciphertext, iv, auth_tag, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (connection_id) DO UPDATE
       SET key_id = EXCLUDED.key_id,
           ciphertext = EXCLUDED.ciphertext,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           updated_by = EXCLUDED.updated_by,
           updated_at = EXCLUDED.updated_at`,
      [
        input.credential.connectionId,
        input.credential.keyId,
        input.credential.ciphertext,
        input.credential.iv,
        input.credential.authTag,
        input.actorUserId,
        input.now,
      ],
    );
  }

  async updateConnection(input: UpdateFulfillmentProviderConnectionRecordInput): Promise<void> {
    const result = await this.client.query(
      `UPDATE shipping.fulfillment_provider_connections
       SET status = $3,
           revision = revision + 1,
           last_verified_at = $4,
           last_error_code = $5,
           last_error_message = $6,
           updated_by = $7,
           updated_at = $8
       WHERE id = $1 AND revision = $2`,
      [
        input.connectionId,
        input.expectedRevision,
        input.status,
        input.lastVerifiedAt,
        input.lastErrorCode,
        input.lastErrorMessage,
        input.actorUserId,
        input.now,
      ],
    );
    if (result.rowCount !== 1) {
      throw new FulfillmentProviderConnectionError(
        409,
        "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_REVISION_CONFLICT",
        "The provider connection changed. Refresh it before trying again.",
      );
    }
  }

  async appendEvent(input: AppendFulfillmentProviderConnectionEventInput): Promise<void> {
    await this.client.query(
      `INSERT INTO shipping.fulfillment_provider_connection_events
        (connection_id, action, connection_revision, idempotency_key,
         request_hash, before_snapshot, after_snapshot, actor_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
      [
        input.connectionId,
        input.action,
        input.connectionRevision,
        input.idempotencyKey,
        input.requestHash,
        input.beforeSnapshot === null ? null : JSON.stringify(input.beforeSnapshot),
        JSON.stringify(input.afterSnapshot),
        input.actorUserId,
        input.now,
      ],
    );
  }
}

async function findCommand(
  queryable: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  idempotencyKey: string,
): Promise<FulfillmentProviderConnectionCommand | null> {
  const result = await queryable.query<CommandRow>(
    `SELECT connection_id, request_hash
     FROM shipping.fulfillment_provider_connection_events
     WHERE idempotency_key = $1
     LIMIT 1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  return row ? {
    connectionId: safeId(row.connection_id, "fulfillment provider connection id"),
    requestHash: row.request_hash,
  } : null;
}

async function loadCredential(
  queryable: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  connectionId: number,
): Promise<FulfillmentProviderCredentialRecord | null> {
  const result = await queryable.query<CredentialRow>(
    `SELECT connection_id, key_id, ciphertext, iv, auth_tag
     FROM shipping.fulfillment_provider_credentials
     WHERE connection_id = $1
     LIMIT 1`,
    [connectionId],
  );
  const row = result.rows[0];
  return row ? {
    connectionId: safeId(row.connection_id, "fulfillment provider credential connection id"),
    keyId: row.key_id,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
  } : null;
}

function mapConnection(row: ConnectionRow): FulfillmentProviderConnectionState {
  return {
    id: safeId(row.id, "fulfillment provider connection id"),
    provider: row.provider,
    name: row.name,
    status: row.status,
    credentialSource: row.credential_source,
    credentialRef: row.credential_ref,
    credentialPresent: row.credential_present,
    systemManaged: row.system_managed,
    revision: row.revision,
    routedMethodCount: safeCount(row.routed_method_count, "routed method count"),
    lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at) : null,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at),
  };
}

function safeId(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw dataIntegrityError(`${field} is outside the supported integer range.`);
  }
  return parsed;
}

function safeCount(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw dataIntegrityError(`${field} is outside the supported integer range.`);
  }
  return parsed;
}

function dataIntegrityError(detail: string): FulfillmentProviderConnectionError {
  return new FulfillmentProviderConnectionError(
    500,
    "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_DATA_INTEGRITY_ERROR",
    "Fulfillment provider connection data is inconsistent.",
    [detail],
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}
