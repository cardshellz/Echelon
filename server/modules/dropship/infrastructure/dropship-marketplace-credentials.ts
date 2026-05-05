import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";
import type { DropshipStoreConnectionTokenRecord } from "../application/dropship-store-connection-service";
import type { DropshipSupportedStorePlatform } from "../domain/store-connection";
import { DropshipError } from "../domain/errors";
import { AesGcmDropshipStoreTokenCipher } from "./dropship-token-cipher";
import type {
  DropshipLogger,
  DropshipNotificationSender,
} from "../application/dropship-ports";
import { sendDropshipNotificationSafely } from "../application/dropship-notification-dispatch";
import {
  makeDropshipStoreConnectionLogger,
} from "../application/dropship-store-connection-service";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";

export interface DropshipMarketplaceStoreCredentials {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  status: string;
  shopDomain: string | null;
  externalAccountId: string | null;
  externalDisplayName: string | null;
  config: Record<string, unknown>;
  accessToken: string;
  accessTokenRef: string;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenRef: string | null;
  refreshTokenExpiresAt: Date | null;
}

export interface DropshipMarketplaceStoreAuthFailureInput {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  status: "needs_reauth" | "refresh_failed";
  failureCode: string;
  message: string;
  retryable: boolean;
  statusCode?: number;
  now: Date;
}

export interface DropshipMarketplaceStoreAuthFailureRecord {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  previousStatus: string;
  status: "needs_reauth" | "refresh_failed";
  transitioned: boolean;
}

export interface DropshipMarketplaceCredentialRepository {
  loadForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSourcePlatform;
  }): Promise<DropshipMarketplaceStoreCredentials>;
  replaceTokens(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSourcePlatform;
    accessToken: string;
    refreshToken: string | null;
    accessTokenExpiresAt: Date | null;
    now: Date;
  }): Promise<DropshipMarketplaceStoreCredentials>;
  recordAuthFailure?(input: DropshipMarketplaceStoreAuthFailureInput): Promise<DropshipMarketplaceStoreAuthFailureRecord>;
}

interface DropshipMarketplaceTokenCipher {
  seal(input: Parameters<AesGcmDropshipStoreTokenCipher["seal"]>[0]): DropshipStoreConnectionTokenRecord;
  open(input: Parameters<AesGcmDropshipStoreTokenCipher["open"]>[0]): string;
}

interface StoreConnectionCredentialRow {
  id: number;
  vendor_id: number;
  platform: DropshipSourcePlatform;
  external_account_id: string | null;
  external_display_name: string | null;
  shop_domain: string | null;
  access_token_ref: string | null;
  refresh_token_ref: string | null;
  token_expires_at: Date | null;
  status: string;
  config: Record<string, unknown> | null;
}

interface TokenRow {
  token_kind: "access" | "refresh";
  token_ref: string;
  key_id: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  expires_at: Date | null;
}

interface DropshipMarketplaceCredentialRepositoryOptions {
  tokenCipher?: DropshipMarketplaceTokenCipher;
  notificationSender?: DropshipNotificationSender;
  logger?: DropshipLogger;
}

export class PgDropshipMarketplaceCredentialRepository implements DropshipMarketplaceCredentialRepository {
  private readonly tokenCipher: DropshipMarketplaceTokenCipher;
  private readonly notificationSender?: DropshipNotificationSender;
  private readonly logger: DropshipLogger;

  constructor(
    private readonly dbPool: Pool = defaultPool,
    options: DropshipMarketplaceCredentialRepositoryOptions = {},
  ) {
    this.tokenCipher = options.tokenCipher ?? new LazyEnvDropshipMarketplaceTokenCipher();
    this.notificationSender = options.notificationSender;
    this.logger = options.logger ?? makeDropshipStoreConnectionLogger();
  }

  async loadForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSourcePlatform;
  }): Promise<DropshipMarketplaceStoreCredentials> {
    const client = await this.dbPool.connect();
    try {
      const connection = await loadConnection(client, input);
      const tokens = await loadTokenRows(client, input.storeConnectionId);
      return mapCredentials({
        connection,
        tokens,
        tokenCipher: this.tokenCipher,
      });
    } finally {
      client.release();
    }
  }

  async replaceTokens(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSourcePlatform;
    accessToken: string;
    refreshToken: string | null;
    accessTokenExpiresAt: Date | null;
    now: Date;
  }): Promise<DropshipMarketplaceStoreCredentials> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const connection = await loadConnection(client, input, true);
      const accessRecord = this.tokenCipher.seal({
        tokenKind: "access",
        token: input.accessToken,
        vendorId: input.vendorId,
        platform: assertTokenCipherPlatform(input.platform),
        expiresAt: input.accessTokenExpiresAt,
      });
      const refreshRecord = input.refreshToken
        ? this.tokenCipher.seal({
            tokenKind: "refresh",
            token: input.refreshToken,
            vendorId: input.vendorId,
            platform: assertTokenCipherPlatform(input.platform),
            expiresAt: null,
          })
        : null;

      await client.query(
        `DELETE FROM dropship.dropship_store_connection_tokens
         WHERE store_connection_id = $1
           AND token_kind = ANY($2::varchar[])`,
        [
          input.storeConnectionId,
          refreshRecord ? ["access", "refresh"] : ["access"],
        ],
      );
      await insertTokenRecord(client, input.storeConnectionId, accessRecord);
      if (refreshRecord) {
        await insertTokenRecord(client, input.storeConnectionId, refreshRecord);
      }

      await client.query(
        `UPDATE dropship.dropship_store_connections
         SET access_token_ref = $2,
             refresh_token_ref = COALESCE($3, refresh_token_ref),
             token_expires_at = $4,
             updated_at = $5
         WHERE id = $1`,
        [
          input.storeConnectionId,
          accessRecord.tokenRef,
          refreshRecord?.tokenRef ?? null,
          input.accessTokenExpiresAt,
          input.now,
        ],
      );

      const updatedConnection = {
        ...connection,
        access_token_ref: accessRecord.tokenRef,
        refresh_token_ref: refreshRecord?.tokenRef ?? connection.refresh_token_ref,
        token_expires_at: input.accessTokenExpiresAt,
      };
      await resolveStoreAuthHealthCheck(client, input.storeConnectionId, input.now);
      const tokens = await loadTokenRows(client, input.storeConnectionId);
      await client.query("COMMIT");
      return mapCredentials({
        connection: updatedConnection,
        tokens,
        tokenCipher: this.tokenCipher,
      });
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAuthFailure(input: DropshipMarketplaceStoreAuthFailureInput): Promise<DropshipMarketplaceStoreAuthFailureRecord> {
    const client = await this.dbPool.connect();
    let record: DropshipMarketplaceStoreAuthFailureRecord;
    try {
      await client.query("BEGIN");
      const connection = await loadConnectionForHealthUpdate(client, input);
      const previousStatus = connection.status;
      const transitioned = previousStatus !== input.status
        && previousStatus !== "disconnected"
        && previousStatus !== "grace_period"
        && previousStatus !== "paused";

      if (transitioned) {
        await client.query(
          `UPDATE dropship.dropship_store_connections
           SET status = $4,
               setup_status = 'attention_required',
               access_token_ref = NULL,
               refresh_token_ref = NULL,
               token_expires_at = NULL,
               updated_at = $5
           WHERE id = $1
             AND vendor_id = $2
             AND platform = $3`,
          [
            input.storeConnectionId,
            input.vendorId,
            input.platform,
            input.status,
            input.now,
          ],
        );
        await client.query(
          `DELETE FROM dropship.dropship_store_connection_tokens
           WHERE store_connection_id = $1`,
          [input.storeConnectionId],
        );
      }

      await upsertStoreAuthHealthCheck(client, {
        ...input,
        previousStatus,
      });
      await recordStoreAuthHealthAuditEvent(client, {
        ...input,
        previousStatus,
        transitioned,
      });

      record = {
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        platform: input.platform,
        previousStatus,
        status: input.status,
        transitioned,
      };
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }

    if (record.transitioned) {
      await this.notifyStoreAuthFailure(input, record);
    }
    return record;
  }

  private async notifyStoreAuthFailure(
    input: DropshipMarketplaceStoreAuthFailureInput,
    record: DropshipMarketplaceStoreAuthFailureRecord,
  ): Promise<void> {
    await sendDropshipNotificationSafely({
      notificationSender: this.notificationSender,
      logger: this.logger,
    }, {
      vendorId: input.vendorId,
      eventType: "dropship_store_needs_reauth",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship store needs reauthorization",
      message: `Your ${input.platform} dropship store needs to be reauthorized before order intake, listing pushes, and tracking updates can continue.`,
      payload: {
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        platform: input.platform,
        previousStatus: record.previousStatus,
        status: input.status,
        failureCode: input.failureCode,
        retryable: input.retryable,
        statusCode: input.statusCode ?? null,
      },
      idempotencyKey: `store-auth-health:${input.storeConnectionId}:${input.status}:${input.now.toISOString()}`,
    }, {
      code: "DROPSHIP_STORE_AUTH_FAILURE_NOTIFICATION_FAILED",
      message: "Dropship store auth failure notification failed after the store was marked unhealthy.",
      context: {
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        platform: input.platform,
        status: input.status,
        failureCode: input.failureCode,
      },
    });
  }
}

export function createDropshipMarketplaceCredentialRepositoryFromEnv(): DropshipMarketplaceCredentialRepository {
  return new PgDropshipMarketplaceCredentialRepository(defaultPool, {
    notificationSender: createDropshipNotificationServiceFromEnv(),
    logger: makeDropshipStoreConnectionLogger(),
  });
}

class LazyEnvDropshipMarketplaceTokenCipher implements DropshipMarketplaceTokenCipher {
  seal(input: Parameters<AesGcmDropshipStoreTokenCipher["seal"]>[0]): DropshipStoreConnectionTokenRecord {
    return AesGcmDropshipStoreTokenCipher.fromEnv().seal(input);
  }

  open(input: Parameters<AesGcmDropshipStoreTokenCipher["open"]>[0]): string {
    return AesGcmDropshipStoreTokenCipher.fromEnv().open(input);
  }
}

async function loadConnection(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSourcePlatform;
  },
  forUpdate = false,
): Promise<StoreConnectionCredentialRow> {
  const result = await client.query<StoreConnectionCredentialRow>(
    `SELECT id, vendor_id, platform, external_account_id, external_display_name,
            shop_domain, access_token_ref, refresh_token_ref, token_expires_at,
            status, config
     FROM dropship.dropship_store_connections
     WHERE id = $1
       AND vendor_id = $2
       AND platform = $3
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [input.storeConnectionId, input.vendorId, input.platform],
  );
  const connection = result.rows[0];
  if (!connection) {
    throw new DropshipError("DROPSHIP_STORE_CONNECTION_NOT_FOUND", "Dropship store connection was not found.", {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: input.platform,
      retryable: false,
    });
  }
  if (connection.status !== "connected") {
    throw new DropshipError("DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", "Dropship store connection is not connected.", {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      status: connection.status,
      retryable: false,
    });
  }
  return connection;
}

async function loadConnectionForHealthUpdate(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSourcePlatform;
  },
): Promise<StoreConnectionCredentialRow> {
  const result = await client.query<StoreConnectionCredentialRow>(
    `SELECT id, vendor_id, platform, external_account_id, external_display_name,
            shop_domain, access_token_ref, refresh_token_ref, token_expires_at,
            status, config
     FROM dropship.dropship_store_connections
     WHERE id = $1
       AND vendor_id = $2
       AND platform = $3
     FOR UPDATE`,
    [input.storeConnectionId, input.vendorId, input.platform],
  );
  const connection = result.rows[0];
  if (!connection) {
    throw new DropshipError("DROPSHIP_STORE_CONNECTION_NOT_FOUND", "Dropship store connection was not found.", {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: input.platform,
      retryable: false,
    });
  }
  return connection;
}

async function loadTokenRows(client: PoolClient, storeConnectionId: number): Promise<TokenRow[]> {
  const result = await client.query<TokenRow>(
    `SELECT token_kind, token_ref, key_id, ciphertext, iv, auth_tag, expires_at
     FROM dropship.dropship_store_connection_tokens
     WHERE store_connection_id = $1`,
    [storeConnectionId],
  );
  return result.rows;
}

async function insertTokenRecord(
  client: PoolClient,
  storeConnectionId: number,
  record: DropshipStoreConnectionTokenRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_store_connection_tokens
      (store_connection_id, token_kind, token_ref, key_id, ciphertext, iv, auth_tag, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      storeConnectionId,
      record.tokenKind,
      record.tokenRef,
      record.keyId,
      record.ciphertext,
      record.iv,
      record.authTag,
      record.expiresAt,
    ],
  );
}

async function upsertStoreAuthHealthCheck(
  client: PoolClient,
  input: DropshipMarketplaceStoreAuthFailureInput & { previousStatus: string },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_store_setup_checks
      (vendor_id, store_connection_id, check_key, status, severity, message, details,
       last_checked_at, resolved_at, created_at, updated_at)
     VALUES ($1, $2, 'store_auth_health', 'failed', 'blocker', $3, $4::jsonb, $5, NULL, $5, $5)
     ON CONFLICT (store_connection_id, check_key) WHERE store_connection_id IS NOT NULL
     DO UPDATE SET status = 'failed',
                   severity = 'blocker',
                   message = EXCLUDED.message,
                   details = EXCLUDED.details,
                   last_checked_at = EXCLUDED.last_checked_at,
                   resolved_at = NULL,
                   updated_at = EXCLUDED.updated_at`,
    [
      input.vendorId,
      input.storeConnectionId,
      input.message,
      JSON.stringify({
        platform: input.platform,
        previousStatus: input.previousStatus,
        nextStatus: input.status,
        failureCode: input.failureCode,
        retryable: input.retryable,
        statusCode: input.statusCode ?? null,
      }),
      input.now,
    ],
  );
}

async function resolveStoreAuthHealthCheck(
  client: PoolClient,
  storeConnectionId: number,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE dropship.dropship_store_setup_checks
     SET status = 'passed',
         severity = 'info',
         message = 'Store authorization is healthy.',
         resolved_at = $2,
         last_checked_at = $2,
         updated_at = $2
     WHERE store_connection_id = $1
       AND check_key = 'store_auth_health'
       AND resolved_at IS NULL`,
    [storeConnectionId, now],
  );
}

async function recordStoreAuthHealthAuditEvent(
  client: PoolClient,
  input: DropshipMarketplaceStoreAuthFailureInput & {
    previousStatus: string;
    transitioned: boolean;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_store_connection', $3, 'store_auth_failure_recorded',
             'system', 'dropship_marketplace_credentials', 'warning', $4::jsonb, $5)`,
    [
      input.vendorId,
      input.storeConnectionId,
      String(input.storeConnectionId),
      JSON.stringify({
        platform: input.platform,
        previousStatus: input.previousStatus,
        nextStatus: input.status,
        transitioned: input.transitioned,
        failureCode: input.failureCode,
        retryable: input.retryable,
        statusCode: input.statusCode ?? null,
      }),
      input.now,
    ],
  );
}

function mapCredentials(input: {
  connection: StoreConnectionCredentialRow;
  tokens: TokenRow[];
  tokenCipher: DropshipMarketplaceTokenCipher;
}): DropshipMarketplaceStoreCredentials {
  const accessTokenRow = input.tokens.find((row) => {
    return row.token_kind === "access" && row.token_ref === input.connection.access_token_ref;
  });
  if (!input.connection.access_token_ref || !accessTokenRow) {
    throw new DropshipError("DROPSHIP_STORE_ACCESS_TOKEN_REQUIRED", "Dropship store access token is required.", {
      storeConnectionId: input.connection.id,
      retryable: false,
    });
  }
  const refreshTokenRow = input.connection.refresh_token_ref
    ? input.tokens.find((row) => {
        return row.token_kind === "refresh" && row.token_ref === input.connection.refresh_token_ref;
      }) ?? null
    : null;
  if (input.connection.refresh_token_ref && !refreshTokenRow) {
    throw new DropshipError("DROPSHIP_STORE_REFRESH_TOKEN_REQUIRED", "Dropship store refresh token is required.", {
      storeConnectionId: input.connection.id,
      retryable: false,
    });
  }
  const accessToken = input.tokenCipher.open({
    tokenRecord: mapTokenRow(accessTokenRow),
    vendorId: input.connection.vendor_id,
    platform: assertTokenCipherPlatform(input.connection.platform),
  });
  const refreshToken = refreshTokenRow
    ? input.tokenCipher.open({
        tokenRecord: mapTokenRow(refreshTokenRow),
        vendorId: input.connection.vendor_id,
        platform: assertTokenCipherPlatform(input.connection.platform),
      })
    : null;

  return {
    vendorId: input.connection.vendor_id,
    storeConnectionId: input.connection.id,
    platform: input.connection.platform,
    status: input.connection.status,
    shopDomain: input.connection.shop_domain,
    externalAccountId: input.connection.external_account_id,
    externalDisplayName: input.connection.external_display_name,
    config: input.connection.config ?? {},
    accessToken,
    accessTokenRef: accessTokenRow.token_ref,
    accessTokenExpiresAt: input.connection.token_expires_at ?? accessTokenRow.expires_at,
    refreshToken,
    refreshTokenRef: refreshTokenRow?.token_ref ?? null,
    refreshTokenExpiresAt: refreshTokenRow?.expires_at ?? null,
  };
}

function assertTokenCipherPlatform(platform: DropshipSourcePlatform): DropshipSupportedStorePlatform {
  if (platform === "ebay" || platform === "shopify") {
    return platform;
  }
  throw new DropshipError("DROPSHIP_TOKEN_PLATFORM_UNSUPPORTED", "Dropship token platform is not supported.", {
    platform,
    retryable: false,
  });
}

function mapTokenRow(row: TokenRow): DropshipStoreConnectionTokenRecord {
  return {
    tokenKind: row.token_kind,
    tokenRef: row.token_ref,
    keyId: row.key_id,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    expiresAt: row.expires_at,
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
