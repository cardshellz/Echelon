import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipOrderIntakeHealthConnectionIdentity,
  DropshipOrderIntakeHealthRepository,
  DropshipOrderIntakeHealthRepositoryResult,
} from "../application/dropship-order-intake-health-service";
import {
  deriveDropshipOrderIntakePollFailed,
  deriveDropshipOrderIntakePollStale,
  deriveDropshipOrderIntakePollSucceeded,
  DROPSHIP_ORDER_INTAKE_HEALTH_STATUSES,
  DROPSHIP_ORDER_INTAKE_MODES,
  type DropshipOrderIntakeHealthPolicy,
  type DropshipOrderIntakeHealthRecord,
  type DropshipOrderIntakeHealthTransition,
  type DropshipOrderIntakeMode,
} from "../domain/dropship-order-intake-health";

interface StoreConnectionRow {
  id: number;
  vendor_id: number;
  platform: string;
  external_display_name: string | null;
  shop_domain: string | null;
  status: string;
  setup_status: string;
  access_token_ref: string | null;
  refresh_token_ref: string | null;
  updated_at: Date;
}

interface HealthRow {
  store_connection_id: number;
  mode: string;
  status: string;
  consecutive_failures: number;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_failure_code: string | null;
  last_failure_message: string | null;
  status_changed_at: Date;
  created_at: Date;
  updated_at: Date;
}

const HEALTH_LOCK_NAMESPACE = "dropship_order_intake_health";
const HEALTH_SETUP_CHECK_KEY = "order_intake_health";

export class PgDropshipOrderIntakeHealthRepository implements DropshipOrderIntakeHealthRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async recordPollSucceeded(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: string;
    mode: DropshipOrderIntakeMode;
    syncedThrough: Date;
    now: Date;
    policy: DropshipOrderIntakeHealthPolicy;
  }): Promise<DropshipOrderIntakeHealthRepositoryResult> {
    return this.withLockedHealth(input.storeConnectionId, async (client, connection, current) => {
      assertConnectionIdentity(connection, input);
      const transition = deriveDropshipOrderIntakePollSucceeded({
        current,
        vendorId: connection.vendor_id,
        storeConnectionId: connection.id,
        platform: connection.platform,
        mode: input.mode,
        now: input.now,
      });
      await client.query(
        `UPDATE dropship.dropship_store_connections
         SET last_order_sync_at = CASE
               WHEN last_order_sync_at IS NULL OR last_order_sync_at < $2 THEN $2
               ELSE last_order_sync_at
             END,
             last_sync_at = $3,
             updated_at = $3
         WHERE id = $1`,
        [connection.id, input.syncedThrough, input.now],
      );
      await persistTransition(client, transition);
      await projectSetupCheck(client, transition);
      await auditTransition(client, transition);
      return makeResult(connection, transition);
    });
  }

  async recordPollFailed(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: string;
    mode: DropshipOrderIntakeMode;
    failureCode: string;
    failureMessage: string;
    now: Date;
    policy: DropshipOrderIntakeHealthPolicy;
  }): Promise<DropshipOrderIntakeHealthRepositoryResult> {
    return this.withLockedHealth(input.storeConnectionId, async (client, connection, current) => {
      assertConnectionIdentity(connection, input);
      const transition = deriveDropshipOrderIntakePollFailed({
        current,
        vendorId: connection.vendor_id,
        storeConnectionId: connection.id,
        platform: connection.platform,
        mode: input.mode,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
        now: input.now,
        policy: input.policy,
      });
      await persistTransition(client, transition);
      await projectSetupCheck(client, transition);
      await auditTransition(client, transition);
      return makeResult(connection, transition);
    });
  }

  async recordStalePolls(input: {
    platform: string;
    mode: DropshipOrderIntakeMode;
    limit: number;
    now: Date;
    policy: DropshipOrderIntakeHealthPolicy;
  }): Promise<DropshipOrderIntakeHealthRepositoryResult[]> {
    const staleBefore = new Date(input.now.getTime() - input.policy.degradedAfterMs);
    const candidates = await this.dbPool.query<{ id: number }>(
      `SELECT sc.id
       FROM dropship.dropship_store_connections sc
       JOIN dropship.dropship_store_order_intake_health health
         ON health.store_connection_id = sc.id
       WHERE sc.platform = $1
         AND sc.status = 'connected'
         AND sc.setup_status = 'ready'
         AND sc.access_token_ref IS NOT NULL
         AND sc.refresh_token_ref IS NOT NULL
         AND health.last_attempt_at < $2
       ORDER BY health.last_attempt_at ASC, sc.id ASC
       LIMIT $3`,
      [input.platform, staleBefore, input.limit],
    );

    const results: DropshipOrderIntakeHealthRepositoryResult[] = [];
    for (const candidate of candidates.rows) {
      const result = await this.recordStaleCandidate(candidate.id, input);
      if (result) results.push(result);
    }
    return results;
  }

  private async recordStaleCandidate(
    storeConnectionId: number,
    input: {
      platform: string;
      mode: DropshipOrderIntakeMode;
      now: Date;
      policy: DropshipOrderIntakeHealthPolicy;
    },
  ): Promise<DropshipOrderIntakeHealthRepositoryResult | null> {
    return this.withLockedHealth(storeConnectionId, async (client, connection, current) => {
      if (
        connection.platform !== input.platform
        || connection.status !== "connected"
        || connection.setup_status !== "ready"
        || !connection.access_token_ref
        || !connection.refresh_token_ref
      ) {
        return null;
      }
      const transition = deriveDropshipOrderIntakePollStale({
        current,
        vendorId: connection.vendor_id,
        storeConnectionId: connection.id,
        platform: connection.platform,
        mode: input.mode,
        observedSince: connection.updated_at,
        now: input.now,
        policy: input.policy,
      });
      if (!transition) return null;
      await persistTransition(client, transition);
      await projectSetupCheck(client, transition);
      await auditTransition(client, transition);
      return makeResult(connection, transition);
    });
  }

  private async withLockedHealth<T>(
    storeConnectionId: number,
    operation: (
      client: PoolClient,
      connection: StoreConnectionRow,
      current: DropshipOrderIntakeHealthRecord | null,
    ) => Promise<T>,
  ): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), $2)",
        [HEALTH_LOCK_NAMESPACE, storeConnectionId],
      );
      const connectionResult = await client.query<StoreConnectionRow>(
        `SELECT id, vendor_id, platform, external_display_name, shop_domain,
                status, setup_status, access_token_ref, refresh_token_ref, updated_at
         FROM dropship.dropship_store_connections
         WHERE id = $1
         FOR UPDATE`,
        [storeConnectionId],
      );
      const connection = connectionResult.rows[0];
      if (!connection) {
        throw new Error(`Dropship store connection ${storeConnectionId} does not exist.`);
      }
      const healthResult = await client.query<HealthRow>(
        `SELECT store_connection_id, mode, status, consecutive_failures,
                last_attempt_at, last_success_at, last_failure_at,
                last_failure_code, last_failure_message, status_changed_at,
                created_at, updated_at
         FROM dropship.dropship_store_order_intake_health
         WHERE store_connection_id = $1
         FOR UPDATE`,
        [storeConnectionId],
      );
      const current = healthResult.rows[0]
        ? mapHealthRow(connection, healthResult.rows[0])
        : null;
      const result = await operation(client, connection, current);
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

async function persistTransition(
  client: PoolClient,
  transition: DropshipOrderIntakeHealthTransition,
): Promise<void> {
  const current = transition.current;
  await client.query(
    `INSERT INTO dropship.dropship_store_order_intake_health
      (store_connection_id, mode, status, consecutive_failures,
       last_attempt_at, last_success_at, last_failure_at,
       last_failure_code, last_failure_message, status_changed_at,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (store_connection_id)
     DO UPDATE SET mode = EXCLUDED.mode,
                   status = EXCLUDED.status,
                   consecutive_failures = EXCLUDED.consecutive_failures,
                   last_attempt_at = EXCLUDED.last_attempt_at,
                   last_success_at = EXCLUDED.last_success_at,
                   last_failure_at = EXCLUDED.last_failure_at,
                   last_failure_code = EXCLUDED.last_failure_code,
                   last_failure_message = EXCLUDED.last_failure_message,
                   status_changed_at = EXCLUDED.status_changed_at,
                   updated_at = EXCLUDED.updated_at`,
    [
      current.storeConnectionId,
      current.mode,
      current.status,
      current.consecutiveFailures,
      current.lastAttemptAt,
      current.lastSuccessAt,
      current.lastFailureAt,
      current.lastFailureCode,
      current.lastFailureMessage,
      current.statusChangedAt,
      current.createdAt,
      current.updatedAt,
    ],
  );
}

async function projectSetupCheck(
  client: PoolClient,
  transition: DropshipOrderIntakeHealthTransition,
): Promise<void> {
  const current = transition.current;
  const presentation = healthPresentation(current);
  await client.query(
    `INSERT INTO dropship.dropship_store_setup_checks
      (vendor_id, store_connection_id, check_key, status, severity, message, details,
       last_checked_at, resolved_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $8, $8)
     ON CONFLICT (store_connection_id, check_key) WHERE store_connection_id IS NOT NULL
     DO UPDATE SET status = EXCLUDED.status,
                   severity = EXCLUDED.severity,
                   message = EXCLUDED.message,
                   details = EXCLUDED.details,
                   last_checked_at = EXCLUDED.last_checked_at,
                   resolved_at = EXCLUDED.resolved_at,
                   updated_at = EXCLUDED.updated_at`,
    [
      current.vendorId,
      current.storeConnectionId,
      HEALTH_SETUP_CHECK_KEY,
      presentation.status,
      presentation.severity,
      presentation.message,
      JSON.stringify({
        mode: current.mode,
        healthStatus: current.status,
        consecutiveFailures: current.consecutiveFailures,
        lastAttemptAt: current.lastAttemptAt?.toISOString() ?? null,
        lastSuccessAt: current.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: current.lastFailureAt?.toISOString() ?? null,
        lastFailureCode: current.lastFailureCode,
        statusChangedAt: current.statusChangedAt.toISOString(),
      }),
      current.updatedAt,
      current.status === "healthy" ? current.updatedAt : null,
    ],
  );
}

async function auditTransition(
  client: PoolClient,
  transition: DropshipOrderIntakeHealthTransition,
): Promise<void> {
  if (!transition.transitioned) return;
  const current = transition.current;
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'store_order_intake_health', $3, $4,
             'system', NULL, $5, $6::jsonb, $7)`,
    [
      current.vendorId,
      current.storeConnectionId,
      String(current.storeConnectionId),
      `order_intake_health_${current.status}`,
      current.status === "healthy" ? "info" : current.status === "warning" ? "warning" : "error",
      JSON.stringify({
        previousStatus: transition.previousStatus,
        status: current.status,
        reason: transition.reason,
        consecutiveFailures: current.consecutiveFailures,
        lastAttemptAt: current.lastAttemptAt?.toISOString() ?? null,
        lastSuccessAt: current.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: current.lastFailureAt?.toISOString() ?? null,
        failureCode: current.lastFailureCode,
        failureMessage: current.lastFailureMessage,
      }),
      current.updatedAt,
    ],
  );
}

function healthPresentation(current: DropshipOrderIntakeHealthRecord): {
  status: "passed" | "failed";
  severity: "info" | "warning" | "error" | "blocker";
  message: string;
} {
  if (current.status === "healthy") {
    return {
      status: "passed",
      severity: "info",
      message: "Order intake is healthy.",
    };
  }
  if (current.status === "warning") {
    return {
      status: "failed",
      severity: "warning",
      message: "Order intake failed once. Echelon will retry automatically.",
    };
  }
  if (current.status === "degraded") {
    return {
      status: "failed",
      severity: "error",
      message: current.lastFailureCode === "DROPSHIP_ORDER_INTAKE_STALE"
        ? "Order intake heartbeat is overdue. Automatic monitoring and retries are continuing."
        : `Order intake is degraded after ${current.consecutiveFailures} consecutive failures. Automatic retries are continuing.`,
    };
  }
  return {
    status: "failed",
    severity: "blocker",
    message: current.lastFailureCode === "DROPSHIP_ORDER_INTAKE_STALE"
      ? "Order intake has stopped reporting a heartbeat. Marketplace orders may be delayed."
      : `Order intake has stopped after ${current.consecutiveFailures} consecutive failures. Marketplace orders may be delayed.`,
  };
}

function assertConnectionIdentity(
  connection: StoreConnectionRow,
  expected: { vendorId: number; platform: string },
): void {
  if (connection.vendor_id !== expected.vendorId || connection.platform !== expected.platform) {
    throw new Error("Dropship order-intake health identity does not match the store connection.");
  }
}

function makeResult(
  connection: StoreConnectionRow,
  transition: DropshipOrderIntakeHealthTransition,
): DropshipOrderIntakeHealthRepositoryResult {
  const identity: DropshipOrderIntakeHealthConnectionIdentity = {
    vendorId: connection.vendor_id,
    storeConnectionId: connection.id,
    platform: connection.platform,
    externalDisplayName: connection.external_display_name,
    shopDomain: connection.shop_domain,
  };
  return { connection: identity, transition };
}

function mapHealthRow(
  connection: StoreConnectionRow,
  row: HealthRow,
): DropshipOrderIntakeHealthRecord {
  const mode = requireKnownValue(row.mode, DROPSHIP_ORDER_INTAKE_MODES, "mode");
  const status = requireKnownValue(row.status, DROPSHIP_ORDER_INTAKE_HEALTH_STATUSES, "status");
  if (!Number.isSafeInteger(row.consecutive_failures) || row.consecutive_failures < 0) {
    throw new Error("Dropship order-intake health contains an invalid failure count.");
  }
  return {
    vendorId: connection.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: connection.platform,
    mode,
    status,
    consecutiveFailures: row.consecutive_failures,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastFailureCode: row.last_failure_code,
    lastFailureMessage: row.last_failure_message,
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireKnownValue<const T extends readonly string[]>(
  value: string,
  allowed: T,
  field: string,
): T[number] {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Dropship order-intake health contains an invalid ${field}.`);
  }
  return value as T[number];
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original database error.
  }
}
