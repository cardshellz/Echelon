import type { Pool, PoolClient, QueryConfig } from "pg";
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
import { DROPSHIP_NOTIFICATION_EVENTS } from "../application/dropship-notification-events";
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
  providerEnvironment: string | null;
  externalAccountIdentityScheme: string | null;
  externalAccountVerifiedAt: Date | null;
  externalDisplayName: string | null;
  config: Record<string, unknown>;
  accessToken: string;
  accessTokenRef: string;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenRef: string | null;
  refreshTokenExpiresAt: Date | null;
}

/** Opaque vault references identify the exact credential generation used by a request. */
export interface ExpectedDropshipCredential {
  accessTokenRef: string;
  refreshTokenRef: string | null;
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
  providerErrorCode?: string | null;
  providerErrorDescription?: string | null;
  invalidateAccessToken?: boolean;
  expectedCredential?: ExpectedDropshipCredential;
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
    expectedCredential?: ExpectedDropshipCredential;
    now: Date;
  }): Promise<DropshipMarketplaceStoreCredentials>;
  recordAuthFailure?(input: DropshipMarketplaceStoreAuthFailureInput): Promise<DropshipMarketplaceStoreAuthFailureRecord>;
  withEbayTokenRefreshLock?<T>(
    input: { vendorId: number; storeConnectionId: number },
    operation: (scopedRepository: DropshipMarketplaceCredentialRepository) => Promise<T>,
  ): Promise<T>;
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
  provider_environment: string | null;
  external_account_identity_scheme: string | null;
  external_account_verified_at: Date | null;
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
  ebayRefreshLockTimeoutMs?: number;
}

// Separate advisory namespace; store IDs are globally unique PostgreSQL integers.
const EBAY_REFRESH_LOCK_NAMESPACE = 0x44534542;
const DEFAULT_EBAY_REFRESH_LOCK_TIMEOUT_MS = 10_000;
const LOCK_CLEANUP_TIMEOUT_MS = 5_000;

export class PgDropshipMarketplaceCredentialRepository implements DropshipMarketplaceCredentialRepository {
  private readonly tokenCipher: DropshipMarketplaceTokenCipher;
  private readonly notificationSender?: DropshipNotificationSender;
  private readonly logger: DropshipLogger;
  private readonly ebayRefreshLockTimeoutMs: number;

  constructor(
    private readonly dbPool: Pool = defaultPool,
    options: DropshipMarketplaceCredentialRepositoryOptions = {},
  ) {
    this.tokenCipher = options.tokenCipher ?? new LazyEnvDropshipMarketplaceTokenCipher();
    this.notificationSender = options.notificationSender;
    this.logger = options.logger ?? makeDropshipStoreConnectionLogger();
    this.ebayRefreshLockTimeoutMs = options.ebayRefreshLockTimeoutMs ?? DEFAULT_EBAY_REFRESH_LOCK_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.ebayRefreshLockTimeoutMs) || this.ebayRefreshLockTimeoutMs < 1
      || this.ebayRefreshLockTimeoutMs > 60_000) {
      throw new DropshipError("DROPSHIP_EBAY_REFRESH_LOCK_CONFIG_INVALID", "Invalid eBay refresh coordination timeout.");
    }
  }

  async withEbayTokenRefreshLock<T>(
    input: { vendorId: number; storeConnectionId: number },
    operation: (scopedRepository: DropshipMarketplaceCredentialRepository) => Promise<T>,
  ): Promise<T> {
    assertLockIdentity(input);
    const client = await this.dbPool.connect().catch(() => {
      throw new DropshipError("DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", "eBay authorization refresh coordination is temporarily unavailable.", {
        vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, retryable: true,
      });
    });
    let acquired = false;
    let destroyConnection = false;
    let leaseLost = false;
    const onLeaseError = () => { leaseLost = true; destroyConnection = true; };
    // pg-pool removes its idle error listener at checkout. HTTP leaves this
    // leased client idle, so a lost backend must not become an unhandled event.
    client.on("error", onLeaseError);
    const postReleaseNotifications: Array<() => Promise<void>> = [];
    try {
      // A session lock coordinates workers without retaining a transaction across HTTP.
      // Both server lock_timeout and the client query deadline bound acquisition.
      await client.query(boundedQuery("SELECT set_config('lock_timeout', $1, false)",
        [`${this.ebayRefreshLockTimeoutMs}ms`], LOCK_CLEANUP_TIMEOUT_MS));
      await client.query(boundedQuery("SELECT pg_advisory_lock($1::integer, $2::integer)",
        [EBAY_REFRESH_LOCK_NAMESPACE, input.storeConnectionId], this.ebayRefreshLockTimeoutMs + LOCK_CLEANUP_TIMEOUT_MS));
      acquired = true;
      const scope = this.createLockScopedRepository(client, input, () => { destroyConnection = true; },
        (notification) => { postReleaseNotifications.push(notification); }, () => !leaseLost);
      try {
        const result = await operation(scope.repository);
        if (leaseLost) throw new DropshipError("DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", "eBay refresh coordination was interrupted.", {
          vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, retryable: true,
        });
        return result;
      } finally {
        await scope.close();
      }
    } catch (error) {
      if (!acquired) {
        // An uncertain acquisition must never return a potentially locked session to the pool.
        destroyConnection = true;
        throw new DropshipError("DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", "eBay authorization refresh coordination is temporarily unavailable.", {
          vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, retryable: true,
        });
      }
      throw error;
    } finally {
      try {
        if (acquired && !leaseLost) {
          try {
            const result = await client.query<{ unlocked: boolean }>(boundedQuery(
              "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
              [EBAY_REFRESH_LOCK_NAMESPACE, input.storeConnectionId], LOCK_CLEANUP_TIMEOUT_MS));
            if (result.rows[0]?.unlocked !== true) throw new Error("Refresh coordination lock was not owned.");
            await client.query(boundedQuery("RESET lock_timeout", [], LOCK_CLEANUP_TIMEOUT_MS));
          } catch {
            destroyConnection = true;
            this.logger.error({ code: "DROPSHIP_EBAY_REFRESH_LOCK_CLEANUP_FAILED",
              message: "Discarded an eBay refresh coordination session after lock cleanup failed.",
              context: { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId } });
          }
        }
      } finally {
        // Release must happen even if an injected diagnostic sink throws.
        client.removeListener("error", onLeaseError);
        client.release(destroyConnection);
        // Notification delivery has its own DB work, so it must not retain a pool
        // slot needed by that work. A committed failure still notifies if refresh throws.
        for (const notify of postReleaseNotifications) await notify();
      }
    }
  }

  private createLockScopedRepository(
    client: PoolClient,
    identity: { vendorId: number; storeConnectionId: number },
    discard: () => void,
    deferNotification: (notification: () => Promise<void>) => void,
    leaseUsable: () => boolean,
  ): {
    repository: DropshipMarketplaceCredentialRepository;
    close: () => Promise<void>;
  } {
    let open = true;
    let usable = true;
    let pending = Promise.resolve();
    const assertUsable = () => {
      if (!leaseUsable()) throw new DropshipError("DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", "eBay refresh coordination was interrupted.", { retryable: true });
      if (!open || !usable) throw new DropshipError("DROPSHIP_EBAY_REFRESH_SCOPE_CLOSED", "eBay refresh credential scope is no longer available.", { retryable: true });
    };
    const assertScopedIdentity = (input: { vendorId: number; storeConnectionId: number; platform: DropshipSourcePlatform }) => {
      if (input.vendorId !== identity.vendorId || input.storeConnectionId !== identity.storeConnectionId || input.platform !== "ebay") {
        throw new DropshipError("DROPSHIP_EBAY_REFRESH_SCOPE_MISMATCH", "Credential operation does not match the coordinated eBay store.", { retryable: false });
      }
    };
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = pending.then(() => { assertUsable(); return operation(); });
      pending = result.then(() => undefined, () => undefined);
      return result;
    };
    // Refresh callbacks must not need another pool checkout: one connection per store
    // also works with a one-connection pool or when all pool slots are refreshing.
    const boundPool = { connect: async () => {
      assertUsable();
      return { query: client.query.bind(client), release: (destroy?: boolean) => {
        if (destroy) { usable = false; discard(); }
      } };
    } } as unknown as Pool;
    const bound = new PgDropshipMarketplaceCredentialRepository(boundPool, {
      tokenCipher: this.tokenCipher, logger: this.logger,
      ebayRefreshLockTimeoutMs: this.ebayRefreshLockTimeoutMs,
    });
    return {
      repository: {
        loadForStoreConnection: (input) => serialize(() => { assertScopedIdentity(input); return bound.loadForStoreConnection(input); }),
        replaceTokens: (input) => serialize(() => { assertScopedIdentity(input); return bound.replaceTokens(input); }),
        recordAuthFailure: (input) => serialize(async () => {
          assertScopedIdentity(input);
          const record = await bound.recordAuthFailure(input);
          if (record.transitioned && record.status === "needs_reauth") {
            deferNotification(() => this.notifyStoreAuthFailure(input, record));
          }
          return record;
        }),
      },
      close: async () => { open = false; await pending; },
    };
  }

  async loadForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSourcePlatform;
  }): Promise<DropshipMarketplaceStoreCredentials> {
    const client = await this.dbPool.connect();
    let destroyConnection = false;
    try {
      // References and ciphertexts must come from one snapshot during concurrent OAuth/refresh writes.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const connection = await loadConnection(client, input);
      const tokens = await loadTokenRows(client, input.storeConnectionId);
      const credentials = mapCredentials({
        connection,
        tokens,
        tokenCipher: this.tokenCipher,
      });
      await client.query("COMMIT");
      return credentials;
    } catch (error) {
      destroyConnection = !(await rollbackQuietly(client));
      throw error;
    } finally {
      client.release(destroyConnection);
    }
  }

  async replaceTokens(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSourcePlatform;
    accessToken: string;
    refreshToken: string | null;
    accessTokenExpiresAt: Date | null;
    expectedCredential?: ExpectedDropshipCredential;
    now: Date;
  }): Promise<DropshipMarketplaceStoreCredentials> {
    const client = await this.dbPool.connect();
    let destroyConnection = false;
    try {
      await client.query("BEGIN");
      const connection = await loadConnectionForHealthUpdate(client, input);
      assertExpectedCredential(connection, input.expectedCredential);
      assertRefreshAllowed(connection);
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

      await resolveStoreAuthHealthCheck(client, input.storeConnectionId, input.now);
      const hasOpenBlockers = await hasOpenStoreSetupBlockers(client, input.storeConnectionId);
      await client.query(
        `UPDATE dropship.dropship_store_connections
         SET access_token_ref = $2,
             refresh_token_ref = COALESCE($3, refresh_token_ref),
             token_expires_at = $4,
             status = 'connected',
             setup_status = $5,
             updated_at = $6
         WHERE id = $1`,
        [
          input.storeConnectionId,
          accessRecord.tokenRef,
          refreshRecord?.tokenRef ?? null,
          input.accessTokenExpiresAt,
          hasOpenBlockers ? "attention_required" : "ready",
          input.now,
        ],
      );

      const updatedConnection = {
        ...connection,
        access_token_ref: accessRecord.tokenRef,
        refresh_token_ref: refreshRecord?.tokenRef ?? connection.refresh_token_ref,
        token_expires_at: input.accessTokenExpiresAt,
        status: "connected",
      };
      const tokens = await loadTokenRows(client, input.storeConnectionId);
      const credentials = mapCredentials({
        connection: updatedConnection,
        tokens,
        tokenCipher: this.tokenCipher,
      });
      await client.query("COMMIT");
      return credentials;
    } catch (error) {
      destroyConnection = !(await rollbackQuietly(client));
      throw error;
    } finally {
      client.release(destroyConnection);
    }
  }

  async recordAuthFailure(input: DropshipMarketplaceStoreAuthFailureInput): Promise<DropshipMarketplaceStoreAuthFailureRecord> {
    const client = await this.dbPool.connect();
    let destroyConnection = false;
    let record: DropshipMarketplaceStoreAuthFailureRecord;
    try {
      await client.query("BEGIN");
      const connection = await loadConnectionForHealthUpdate(client, input);
      assertExpectedCredential(connection, input.expectedCredential);
      if (input.expectedCredential || connection.status !== "needs_reauth") assertRefreshAllowed(connection);
      const previousStatus = connection.status;
      const effectiveStatus = previousStatus === "needs_reauth"
        ? "needs_reauth"
        : input.status;
      const effectiveInput = { ...input, status: effectiveStatus };
      const transitioned = previousStatus !== effectiveStatus
        && previousStatus !== "disconnected"
        && previousStatus !== "grace_period"
        && previousStatus !== "paused";

      if (transitioned || (effectiveStatus === "refresh_failed" && input.invalidateAccessToken === true)) {
        await client.query(
          `UPDATE dropship.dropship_store_connections
           SET status = $4,
               setup_status = 'attention_required',
               access_token_ref = CASE WHEN $4 = 'needs_reauth' THEN NULL ELSE access_token_ref END,
               refresh_token_ref = CASE WHEN $4 = 'needs_reauth' THEN NULL ELSE refresh_token_ref END,
               token_expires_at = CASE
                 WHEN $4 = 'needs_reauth' THEN NULL
                 WHEN $6::boolean THEN to_timestamp(0)
                 ELSE token_expires_at
               END,
               updated_at = $5
           WHERE id = $1
             AND vendor_id = $2
             AND platform = $3`,
          [
            input.storeConnectionId,
            input.vendorId,
            input.platform,
            effectiveStatus,
            input.now,
            effectiveStatus === "refresh_failed" && input.invalidateAccessToken === true,
          ],
        );
        if (effectiveStatus === "needs_reauth") {
          await client.query(
            `DELETE FROM dropship.dropship_store_connection_tokens
             WHERE store_connection_id = $1`,
            [input.storeConnectionId],
          );
        }
      }

      // A legacy unguarded repeat for an already revoked grant must remain a no-op.
      if (previousStatus !== "needs_reauth") {
        await upsertStoreAuthHealthCheck(client, {
          ...effectiveInput,
          previousStatus,
        });
        await recordStoreAuthHealthAuditEvent(client, {
          ...effectiveInput,
          previousStatus,
          transitioned,
        });
      }

      record = {
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        platform: input.platform,
        previousStatus,
        status: effectiveStatus,
        transitioned,
      };
      await client.query("COMMIT");
    } catch (error) {
      destroyConnection = !(await rollbackQuietly(client));
      throw error;
    } finally {
      client.release(destroyConnection);
    }

    if (record.transitioned && record.status === "needs_reauth") {
      await this.notifyStoreAuthFailure({ ...input, status: record.status }, record);
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
      eventType: DROPSHIP_NOTIFICATION_EVENTS.STORE_NEEDS_REAUTH,
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
        providerErrorCode: input.providerErrorCode ?? null,
        providerErrorDescription: input.providerErrorDescription ?? null,
        invalidateAccessToken: input.invalidateAccessToken === true,
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

function assertLockIdentity(input: { vendorId: number; storeConnectionId: number }): void {
  if (![input.vendorId, input.storeConnectionId].every((value) => (
    Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
  ))) {
    throw new DropshipError("DROPSHIP_EBAY_REFRESH_LOCK_IDENTITY_INVALID", "Invalid eBay refresh coordination identity.", {
      retryable: false,
    });
  }
}

// pg supports per-query query_timeout at runtime; its QueryConfig declarations omit it.
function boundedQuery(text: string, values: unknown[], timeoutMs: number): QueryConfig & { query_timeout: number } {
  return { text, values, query_timeout: timeoutMs };
}

function assertExpectedCredential(connection: StoreConnectionCredentialRow, expected?: ExpectedDropshipCredential): void {
  if (expected && (connection.access_token_ref !== expected.accessTokenRef
    || connection.refresh_token_ref !== expected.refreshTokenRef)) {
    throw new DropshipError("DROPSHIP_CREDENTIAL_CHANGED", "Store authorization changed while the request was in flight.", {
      vendorId: connection.vendor_id, storeConnectionId: connection.id, retryable: true,
    });
  }
}

function assertRefreshAllowed(connection: StoreConnectionCredentialRow): void {
  if (connection.status !== "connected" && connection.status !== "refresh_failed") {
    throw new DropshipError("DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", "Dropship store connection is not connected.", {
      vendorId: connection.vendor_id, storeConnectionId: connection.id, status: connection.status, retryable: false,
    });
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
    `SELECT id, vendor_id, platform, external_account_id, provider_environment,
            external_account_identity_scheme, external_account_verified_at,
            external_display_name, shop_domain, access_token_ref, refresh_token_ref, token_expires_at,
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
  assertRefreshAllowed(connection);
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
    `SELECT id, vendor_id, platform, external_account_id, provider_environment,
            external_account_identity_scheme, external_account_verified_at,
            external_display_name, shop_domain, access_token_ref, refresh_token_ref, token_expires_at,
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
        providerErrorCode: input.providerErrorCode ?? null,
        providerErrorDescription: input.providerErrorDescription ?? null,
        invalidateAccessToken: input.invalidateAccessToken === true,
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

async function hasOpenStoreSetupBlockers(
  client: PoolClient,
  storeConnectionId: number,
): Promise<boolean> {
  const result = await client.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count
     FROM dropship.dropship_store_setup_checks
     WHERE store_connection_id = $1
       AND resolved_at IS NULL
       AND status <> 'passed'
       AND severity IN ('blocker','error')`,
    [storeConnectionId],
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
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
        providerErrorCode: input.providerErrorCode ?? null,
        providerErrorDescription: input.providerErrorDescription ?? null,
        invalidateAccessToken: input.invalidateAccessToken === true,
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
    providerEnvironment: input.connection.provider_environment,
    externalAccountIdentityScheme: input.connection.external_account_identity_scheme,
    externalAccountVerifiedAt: input.connection.external_account_verified_at,
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

async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    // Preserve the original error but do not recycle a session of uncertain transaction state.
    return false;
  }
}
