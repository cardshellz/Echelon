import type { PoolClient } from "pg";
import {
  boundedIntegrityError,
  hasActionableIntegrityAlert,
  integrityAlertRetryAt,
  integrityAlertSignature,
  type IntegrityAlertPayload,
  type IntegrityAlertSample,
  type IntegrityAlertTriggerCounts,
} from "./integrity-monitor.domain";

type QueryClient = Pick<PoolClient, "query">;

const ACTIVATION_LOCK_NAME = "wms_inventory_integrity_monitor_activation";
const ALERT_SAMPLE_LIMIT = 20;

export interface IntegrityMonitorActivationPreview {
  baselineRunId: string;
  baselineSnapshotAt: string;
  baselineBlockerCount: number;
  baselineWarningCount: number;
  existingBaselineRunId: string | null;
  alreadyActivated: boolean;
}

export interface ClaimedIntegrityAlert {
  id: number;
  runId: string;
  payload: IntegrityAlertPayload;
  attemptCount: number;
  leaseOwner: string;
}

function safeCount(value: unknown, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return count;
}

function normalizeActor(actor: string): string {
  const value = actor.trim();
  if (value.length === 0 || value.length > 120) {
    throw new Error("Integrity monitor activation actor must contain 1 to 120 characters");
  }
  return value;
}

export async function assertIntegrityAuditRoleIsReadOnly(client: QueryClient): Promise<string> {
  const result = await client.query(`
    SELECT
      current_user AS database_user,
      COUNT(*) FILTER (
        WHERE has_table_privilege(
          current_user,
          quote_ident(table_schema) || '.' || quote_ident(table_name),
          'INSERT'
        )
        OR has_table_privilege(
          current_user,
          quote_ident(table_schema) || '.' || quote_ident(table_name),
          'UPDATE'
        )
        OR has_table_privilege(
          current_user,
          quote_ident(table_schema) || '.' || quote_ident(table_name),
          'DELETE'
        )
        OR has_table_privilege(
          current_user,
          quote_ident(table_schema) || '.' || quote_ident(table_name),
          'TRUNCATE'
        )
        OR has_any_column_privilege(
          current_user,
          quote_ident(table_schema) || '.' || quote_ident(table_name),
          'INSERT'
        )
        OR has_any_column_privilege(
          current_user,
          quote_ident(table_schema) || '.' || quote_ident(table_name),
          'UPDATE'
        )
      )::integer AS mutable_table_count,
      (
        SELECT COUNT(*)::integer
        FROM unnest($1::text[]) AS audited_schema(schema_name)
        WHERE has_schema_privilege(current_user, audited_schema.schema_name, 'CREATE')
      ) AS mutable_schema_count
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema = ANY($1::text[])
  `, [["inventory", "wms", "warehouse", "procurement", "orders", "oms"]]);
  const row = result.rows[0];
  if (!row) throw new Error("Could not verify the WMS integrity audit database role");
  const mutableTableCount = safeCount(row.mutable_table_count, "audit role mutable table count");
  const mutableSchemaCount = safeCount(row.mutable_schema_count, "audit role mutable schema count");
  if (mutableTableCount !== 0 || mutableSchemaCount !== 0) {
    throw new Error(
      `WMS_INTEGRITY_AUDIT_DATABASE_URL user ${String(row.database_user)} can mutate `
        + `${mutableTableCount} operational table(s) and create in ${mutableSchemaCount} `
        + "operational schema(s); a read-only credential is required",
    );
  }
  return String(row.database_user);
}

async function loadActivationPreview(
  client: QueryClient,
  baselineRunId: string,
): Promise<IntegrityMonitorActivationPreview> {
  const baselineResult = await client.query(`
    SELECT id, scope, status, snapshot_at, blocker_count, warning_count
    FROM inventory.integrity_audit_runs
    WHERE id = $1
  `, [baselineRunId]);
  const baseline = baselineResult.rows[0];
  if (!baseline) throw new Error(`Integrity baseline audit run ${baselineRunId} does not exist`);
  if (baseline.scope !== "all" || baseline.status !== "completed") {
    throw new Error(
      `Integrity baseline audit run ${baselineRunId} must be a completed all-check run`,
    );
  }

  const stateResult = await client.query(`
    SELECT baseline_run_id
    FROM inventory.integrity_monitor_state
    WHERE singleton_key = TRUE
  `);
  const existingBaselineRunId = stateResult.rows[0]?.baseline_run_id == null
    ? null
    : String(stateResult.rows[0].baseline_run_id);

  return {
    baselineRunId: String(baseline.id),
    baselineSnapshotAt: new Date(baseline.snapshot_at).toISOString(),
    baselineBlockerCount: safeCount(baseline.blocker_count, "baseline blocker count"),
    baselineWarningCount: safeCount(baseline.warning_count, "baseline warning count"),
    existingBaselineRunId,
    alreadyActivated: existingBaselineRunId === String(baseline.id),
  };
}

export async function previewIntegrityMonitoringActivation(
  client: QueryClient,
  baselineRunId: string,
): Promise<IntegrityMonitorActivationPreview> {
  return loadActivationPreview(client, baselineRunId);
}

export async function activateIntegrityMonitoring(
  client: QueryClient,
  input: { baselineRunId: string; actor: string; now: Date },
): Promise<IntegrityMonitorActivationPreview> {
  const actor = normalizeActor(input.actor);
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ACTIVATION_LOCK_NAME]);
    const preview = await loadActivationPreview(client, input.baselineRunId);
    if (preview.existingBaselineRunId !== null && !preview.alreadyActivated) {
      throw new Error(
        `Integrity monitoring is already activated with baseline ${preview.existingBaselineRunId}; `
          + "changing the stabilization watermark requires an audited migration",
      );
    }
    if (!preview.alreadyActivated) {
      await client.query(`
        INSERT INTO inventory.integrity_monitor_state (
          singleton_key,
          baseline_run_id,
          stabilization_started_at,
          activated_at,
          activated_by
        ) VALUES (TRUE, $1, $2::timestamptz, $3::timestamptz, $4)
      `, [preview.baselineRunId, preview.baselineSnapshotAt, input.now.toISOString(), actor]);
    }
    await client.query("COMMIT");
    return preview;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function enqueueContinuousIntegrityAlert(
  client: QueryClient,
  input: {
    runId: string;
    snapshotAt: string;
    sourceVersion: string | null;
    blockerCount: number;
    warningCount: number;
  },
): Promise<boolean> {
  const stateResult = await client.query(`
    SELECT baseline_run_id
    FROM inventory.integrity_monitor_state
    WHERE singleton_key = TRUE
    FOR UPDATE
  `);
  if (!stateResult.rows[0]) {
    throw new Error("WMS inventory integrity monitoring has not been activated");
  }

  const previousResult = await client.query(`
    SELECT blocker_count
    FROM inventory.integrity_audit_runs
    WHERE id <> $1
      AND scope IN ('all', 'continuous')
    ORDER BY snapshot_at DESC
    LIMIT 1
  `, [input.runId]);
  const previousBlockerCount = safeCount(
    previousResult.rows[0]?.blocker_count ?? 0,
    "previous blocker count",
  );

  const triggerResult = await client.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE severity = 'blocker' AND observation_kind = 'new'
      )::integer AS new_blockers,
      COUNT(*) FILTER (WHERE observation_kind = 'worsened')::integer AS worsened,
      COUNT(*) FILTER (WHERE observation_kind = 'recurred')::integer AS recurred
    FROM integrity_observed_stage
  `);
  const triggerRow = triggerResult.rows[0] ?? {};
  const triggerCounts: IntegrityAlertTriggerCounts = {
    newBlockers: safeCount(triggerRow.new_blockers ?? 0, "new blocker count"),
    worsened: safeCount(triggerRow.worsened ?? 0, "worsened finding count"),
    recurred: safeCount(triggerRow.recurred ?? 0, "recurred finding count"),
    blockerCountGrowth: Math.max(0, input.blockerCount - previousBlockerCount),
  };

  let samples: IntegrityAlertSample[] = [];
  if (hasActionableIntegrityAlert(triggerCounts)) {
    const sampleResult = await client.query(`
      SELECT
        check_id,
        severity,
        observation_kind,
        entity_fingerprint,
        entity_key,
        metric_value::text
      FROM integrity_observed_stage
      WHERE (severity = 'blocker' AND observation_kind = 'new')
         OR observation_kind IN ('worsened', 'recurred')
      ORDER BY
        CASE severity WHEN 'blocker' THEN 0 ELSE 1 END,
        observation_kind,
        check_id,
        entity_fingerprint
      LIMIT $1
    `, [ALERT_SAMPLE_LIMIT]);
    samples = sampleResult.rows.map((row) => ({
      checkId: String(row.check_id),
      severity: row.severity,
      observationKind: row.observation_kind,
      entityFingerprint: String(row.entity_fingerprint),
      entityKey: row.entity_key,
      metricValue: String(row.metric_value),
    }));
  }

  const payload: IntegrityAlertPayload = {
    runId: input.runId,
    snapshotAt: input.snapshotAt,
    sourceVersion: input.sourceVersion,
    blockerCount: input.blockerCount,
    warningCount: input.warningCount,
    previousBlockerCount,
    triggerCounts,
    samples,
  };

  if (hasActionableIntegrityAlert(triggerCounts)) {
    await client.query(`
      INSERT INTO inventory.integrity_alert_outbox (
        run_id,
        signature,
        trigger_counts,
        payload
      ) VALUES ($1, $2, $3::jsonb, $4::jsonb)
      ON CONFLICT (run_id) DO NOTHING
    `, [
      input.runId,
      integrityAlertSignature(input.runId),
      JSON.stringify(triggerCounts),
      JSON.stringify(payload),
    ]);
  }

  await client.query(`
    UPDATE inventory.integrity_monitor_state
    SET
      last_successful_run_id = $1,
      last_successful_at = $2::timestamptz,
      last_failure_at = NULL,
      last_failure_code = NULL,
      last_failure_message = NULL,
      updated_at = NOW()
    WHERE singleton_key = TRUE
  `, [input.runId, input.snapshotAt]);

  return hasActionableIntegrityAlert(triggerCounts);
}

export async function recordIntegrityMonitorFailure(
  client: QueryClient,
  input: { code: string; error: unknown; occurredAt: Date },
): Promise<void> {
  const code = input.code.trim().slice(0, 100);
  if (code.length === 0) throw new Error("Integrity monitor failure code cannot be blank");
  await client.query(`
    UPDATE inventory.integrity_monitor_state
    SET
      last_failure_at = $1::timestamptz,
      last_failure_code = $2,
      last_failure_message = $3,
      updated_at = NOW()
    WHERE singleton_key = TRUE
  `, [input.occurredAt.toISOString(), code, boundedIntegrityError(input.error)]);
}

export async function claimNextIntegrityAlert(
  client: QueryClient,
  input: {
    workerId: string;
    now: Date;
    leaseMs: number;
    maxAttempts: number;
  },
): Promise<ClaimedIntegrityAlert | null> {
  if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1_000) {
    throw new Error("Integrity alert lease must be at least 1000ms");
  }
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error("Integrity alert max attempts must be a positive integer");
  }
  const workerId = normalizeActor(input.workerId);
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  const result = await client.query(`
    WITH exhausted AS (
      UPDATE inventory.integrity_alert_outbox
      SET
        status = 'dead',
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = COALESCE(last_error, 'alert delivery lease expired after maximum attempts'),
        updated_at = NOW()
      WHERE attempt_count >= $1
        AND (
          (status = 'pending' AND next_attempt_at <= $2::timestamptz)
          OR (status = 'sending' AND lease_expires_at <= $2::timestamptz)
        )
      RETURNING id
    ), candidate AS (
      SELECT id
      FROM inventory.integrity_alert_outbox
      WHERE attempt_count < $1
        AND (
          (status = 'pending' AND next_attempt_at <= $2::timestamptz)
          OR (status = 'sending' AND lease_expires_at <= $2::timestamptz)
        )
      ORDER BY next_attempt_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE inventory.integrity_alert_outbox alert
    SET
      status = 'sending',
      attempt_count = alert.attempt_count + 1,
      lease_owner = $3,
      lease_expires_at = $4::timestamptz,
      updated_at = NOW()
    FROM candidate
    WHERE alert.id = candidate.id
    RETURNING alert.id, alert.run_id, alert.payload, alert.attempt_count, alert.lease_owner
  `, [input.maxAttempts, input.now.toISOString(), workerId, leaseExpiresAt.toISOString()]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    payload: row.payload,
    attemptCount: Number(row.attempt_count),
    leaseOwner: String(row.lease_owner),
  };
}

export async function markIntegrityAlertSent(
  client: QueryClient,
  input: { alertId: number; workerId: string; sentAt: Date },
): Promise<void> {
  const result = await client.query(`
    UPDATE inventory.integrity_alert_outbox
    SET
      status = 'sent',
      sent_at = $3::timestamptz,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = NULL,
      updated_at = NOW()
    WHERE id = $1
      AND status = 'sending'
      AND lease_owner = $2
    RETURNING id
  `, [input.alertId, input.workerId, input.sentAt.toISOString()]);
  if (!result.rows[0]) {
    throw new Error(`Integrity alert ${input.alertId} is not leased by ${input.workerId}`);
  }
}

export async function markIntegrityAlertFailed(
  client: QueryClient,
  input: {
    alert: ClaimedIntegrityAlert;
    error: unknown;
    failedAt: Date;
    maxAttempts: number;
  },
): Promise<"pending" | "dead"> {
  const terminal = input.alert.attemptCount >= input.maxAttempts;
  const status = terminal ? "dead" : "pending";
  const nextAttemptAt = terminal
    ? input.failedAt
    : integrityAlertRetryAt(input.failedAt, input.alert.attemptCount);
  const result = await client.query(`
    UPDATE inventory.integrity_alert_outbox
    SET
      status = $3,
      next_attempt_at = $4::timestamptz,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = $5,
      updated_at = NOW()
    WHERE id = $1
      AND status = 'sending'
      AND lease_owner = $2
    RETURNING id
  `, [
    input.alert.id,
    input.alert.leaseOwner,
    status,
    nextAttemptAt.toISOString(),
    boundedIntegrityError(input.error),
  ]);
  if (!result.rows[0]) {
    throw new Error(
      `Integrity alert ${input.alert.id} failure could not be recorded for ${input.alert.leaseOwner}`,
    );
  }
  return status;
}
