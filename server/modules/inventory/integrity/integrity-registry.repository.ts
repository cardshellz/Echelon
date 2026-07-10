import type { PoolClient } from "pg";
import {
  classifyIntegrityObservation,
  type ExistingIntegrityFindingState,
  type IntegrityObservationKind,
  type ObservedIntegrityFinding,
} from "./integrity-registry.domain";
import { enqueueContinuousIntegrityAlert } from "./integrity-monitor.repository";

const REGISTRY_LOCK_NAME = "wms_inventory_integrity_registry";
const STAGE_BATCH_SIZE = 500;

export interface IntegrityAuditRunCheckInput {
  checkId: string;
  category: string;
  severity: "blocker" | "warning";
  findingCount: number;
  elapsedMs: number;
}

export interface IntegrityAuditRegistryInput {
  runId: string;
  scope: "all" | "continuous" | "targeted";
  sourceVersion: string | null;
  startedAt: string;
  snapshotAt: string;
  completedAt: string;
  databaseName: string;
  databaseUser: string;
  serverVersion: string;
  recoveryMode: boolean;
  blockerCount: number;
  warningCount: number;
  checks: IntegrityAuditRunCheckInput[];
  findings: ObservedIntegrityFinding[];
}

export interface IntegrityLifecycleSummary {
  findings: number;
  new: number;
  unchanged: number;
  changed: number;
  worsened: number;
  improved: number;
  recurred: number;
  resolved: number;
}

interface ExistingFindingRow extends ExistingIntegrityFindingState {
  checkId: string;
  entityFingerprint: string;
}

function emptySummary(findings: number): IntegrityLifecycleSummary {
  return {
    findings,
    new: 0,
    unchanged: 0,
    changed: 0,
    worsened: 0,
    improved: 0,
    recurred: 0,
    resolved: 0,
  };
}

function assertRegistryInput(input: IntegrityAuditRegistryInput): void {
  if (input.checks.length === 0) throw new Error("Integrity audit registry input has no checks");
  if (new Set(input.checks.map((check) => check.checkId)).size !== input.checks.length) {
    throw new Error("Integrity audit registry input contains duplicate check ids");
  }
  const expectedFindings = input.blockerCount + input.warningCount;
  if (input.findings.length !== expectedFindings) {
    throw new Error(
      `Integrity audit registry finding count mismatch: observed=${input.findings.length} expected=${expectedFindings}`,
    );
  }
  const checkCount = input.checks.reduce((total, check) => total + check.findingCount, 0);
  if (checkCount !== expectedFindings) {
    throw new Error(
      `Integrity audit registry check count mismatch: checks=${checkCount} expected=${expectedFindings}`,
    );
  }
  const findingKeys = input.findings.map((finding) => `${finding.checkId}:${finding.entityFingerprint}`);
  if (new Set(findingKeys).size !== findingKeys.length) {
    throw new Error("Integrity audit registry input contains duplicate finding identities");
  }
  const executed = new Set(input.checks.map((check) => check.checkId));
  for (const finding of input.findings) {
    if (!executed.has(finding.checkId)) {
      throw new Error(`Integrity finding ${finding.checkId} was not part of the completed audit run`);
    }
  }
}

function incrementSummary(
  summary: IntegrityLifecycleSummary,
  kind: IntegrityObservationKind,
  amount = 1,
): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`Invalid integrity lifecycle count for ${kind}: ${amount}`);
  }
  summary[kind] += amount;
}

async function readExistingFindings(
  client: Pick<PoolClient, "query">,
  checkIds: string[],
): Promise<ExistingFindingRow[]> {
  const result = await client.query(
    `SELECT
       check_id,
       entity_fingerprint,
       status,
       current_evidence_hash,
       current_metric::text
     FROM inventory.integrity_findings
     WHERE check_id = ANY($1::text[])`,
    [checkIds],
  );
  return result.rows.map((row) => ({
    checkId: String(row.check_id),
    entityFingerprint: String(row.entity_fingerprint),
    status: row.status,
    evidenceHash: String(row.current_evidence_hash),
    metricValue: String(row.current_metric),
  }));
}

export async function previewIntegrityAuditRegistry(
  client: Pick<PoolClient, "query">,
  input: IntegrityAuditRegistryInput,
): Promise<IntegrityLifecycleSummary> {
  assertRegistryInput(input);
  const checkIds = input.checks.map((check) => check.checkId);
  const existingRows = await readExistingFindings(client, checkIds);
  const existing = new Map(
    existingRows.map((row) => [`${row.checkId}:${row.entityFingerprint}`, row]),
  );
  const observedKeys = new Set<string>();
  const summary = emptySummary(input.findings.length);

  for (const finding of input.findings) {
    const key = `${finding.checkId}:${finding.entityFingerprint}`;
    observedKeys.add(key);
    incrementSummary(summary, classifyIntegrityObservation(existing.get(key) ?? null, finding));
  }
  for (const row of existingRows) {
    const key = `${row.checkId}:${row.entityFingerprint}`;
    if (row.status !== "resolved" && !observedKeys.has(key)) summary.resolved += 1;
  }
  return summary;
}

async function createStageTables(client: Pick<PoolClient, "query">): Promise<void> {
  await client.query(`
    CREATE TEMP TABLE integrity_observed_stage (
      check_id text NOT NULL,
      category text NOT NULL,
      severity text NOT NULL,
      entity_fingerprint text NOT NULL,
      entity_key jsonb NOT NULL,
      evidence jsonb NOT NULL,
      evidence_hash text NOT NULL,
      metric_value numeric(38, 0) NOT NULL,
      prior_status text,
      observation_kind text NOT NULL DEFAULT 'new',
      PRIMARY KEY (check_id, entity_fingerprint)
    ) ON COMMIT DROP
  `);
}

async function rejectStaleAuditRun(
  client: Pick<PoolClient, "query">,
  input: IntegrityAuditRegistryInput,
): Promise<void> {
  const result = await client.query(
    `SELECT
       run_check.check_id,
       audit_run.id AS newer_run_id,
       audit_run.snapshot_at
     FROM inventory.integrity_audit_run_checks run_check
     JOIN inventory.integrity_audit_runs audit_run ON audit_run.id = run_check.run_id
     WHERE run_check.check_id = ANY($1::text[])
       AND audit_run.snapshot_at >= $2::timestamptz
     ORDER BY audit_run.snapshot_at DESC
     LIMIT 1`,
    [input.checks.map((check) => check.checkId), input.snapshotAt],
  );
  const newer = result.rows[0];
  if (newer) {
    throw new Error(
      `Refusing stale integrity audit run ${input.runId}: check ${String(newer.check_id)} `
        + `was already recorded by run ${String(newer.newer_run_id)} `
        + `at snapshot ${new Date(newer.snapshot_at).toISOString()}`,
    );
  }
}

async function stageObservedFindings(
  client: Pick<PoolClient, "query">,
  findings: ObservedIntegrityFinding[],
): Promise<void> {
  for (let offset = 0; offset < findings.length; offset += STAGE_BATCH_SIZE) {
    const batch = findings.slice(offset, offset + STAGE_BATCH_SIZE).map((finding) => ({
      check_id: finding.checkId,
      category: finding.category,
      severity: finding.severity,
      entity_fingerprint: finding.entityFingerprint,
      entity_key: finding.entityKey,
      evidence: finding.evidence,
      evidence_hash: finding.evidenceHash,
      metric_value: finding.metricValue,
    }));
    await client.query(
      `INSERT INTO integrity_observed_stage (
         check_id,
         category,
         severity,
         entity_fingerprint,
         entity_key,
         evidence,
         evidence_hash,
         metric_value
       )
       SELECT
         input.check_id,
         input.category,
         input.severity,
         input.entity_fingerprint,
         input.entity_key,
         input.evidence,
         input.evidence_hash,
         input.metric_value::numeric(38, 0)
       FROM jsonb_to_recordset($1::jsonb) AS input(
         check_id text,
         category text,
         severity text,
         entity_fingerprint text,
         entity_key jsonb,
         evidence jsonb,
         evidence_hash text,
         metric_value text
       )`,
      [JSON.stringify(batch)],
    );
  }
}

async function classifyStage(client: Pick<PoolClient, "query">): Promise<void> {
  await client.query(`
    UPDATE integrity_observed_stage observed
    SET
      prior_status = existing.status,
      observation_kind = CASE
        WHEN existing.status = 'resolved' THEN 'recurred'
        WHEN observed.metric_value > existing.current_metric THEN 'worsened'
        WHEN observed.metric_value < existing.current_metric THEN 'improved'
        WHEN observed.evidence_hash <> existing.current_evidence_hash THEN 'changed'
        ELSE 'unchanged'
      END
    FROM inventory.integrity_findings existing
    WHERE existing.check_id = observed.check_id
      AND existing.entity_fingerprint = observed.entity_fingerprint
  `);
}

async function insertRun(
  client: Pick<PoolClient, "query">,
  input: IntegrityAuditRegistryInput,
): Promise<void> {
  await client.query(
    `INSERT INTO inventory.integrity_audit_runs (
       id,
       scope,
       status,
       source_version,
       started_at,
       snapshot_at,
       completed_at,
       database_name,
       database_user,
       server_version,
       recovery_mode,
       check_count,
       blocker_count,
       warning_count,
       finding_count
     ) VALUES (
       $1, $2, 'completed', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
     )`,
    [
      input.runId,
      input.scope,
      input.sourceVersion,
      input.startedAt,
      input.snapshotAt,
      input.completedAt,
      input.databaseName,
      input.databaseUser,
      input.serverVersion,
      input.recoveryMode,
      input.checks.length,
      input.blockerCount,
      input.warningCount,
      input.findings.length,
    ],
  );

  await client.query(
    `INSERT INTO inventory.integrity_audit_run_checks (
       run_id,
       check_id,
       category,
       severity,
       finding_count,
       elapsed_ms
     )
     SELECT
       $1,
       input.check_id,
       input.category,
       input.severity,
       input.finding_count,
       input.elapsed_ms
     FROM jsonb_to_recordset($2::jsonb) AS input(
       check_id text,
       category text,
       severity text,
       finding_count bigint,
       elapsed_ms integer
     )`,
    [
      input.runId,
      JSON.stringify(input.checks.map((check) => ({
        check_id: check.checkId,
        category: check.category,
        severity: check.severity,
        finding_count: check.findingCount,
        elapsed_ms: check.elapsedMs,
      }))),
    ],
  );
}

async function upsertFindings(
  client: Pick<PoolClient, "query">,
  input: IntegrityAuditRegistryInput,
): Promise<void> {
  await client.query(
    `INSERT INTO inventory.integrity_findings AS existing (
       check_id,
       entity_fingerprint,
       category,
       severity,
       status,
       entity_key,
       current_evidence,
       current_evidence_hash,
       current_metric,
       first_seen_at,
       last_seen_at,
       last_changed_at,
       first_seen_run_id,
       last_seen_run_id,
       occurrence_count,
       recurrence_count,
       worsened_count,
       last_observation_kind
     )
     SELECT
       observed.check_id,
       observed.entity_fingerprint,
       observed.category,
       observed.severity,
       'open',
       observed.entity_key,
       observed.evidence,
       observed.evidence_hash,
       observed.metric_value,
       $1::timestamptz,
       $1::timestamptz,
       $1::timestamptz,
       $2,
       $2,
       1,
       0,
       0,
       observed.observation_kind
     FROM integrity_observed_stage observed
     ON CONFLICT (check_id, entity_fingerprint) DO UPDATE
     SET
       category = EXCLUDED.category,
       severity = EXCLUDED.severity,
       status = CASE WHEN existing.status = 'resolved' THEN 'open' ELSE existing.status END,
       entity_key = EXCLUDED.entity_key,
       current_evidence = EXCLUDED.current_evidence,
       current_evidence_hash = EXCLUDED.current_evidence_hash,
       current_metric = EXCLUDED.current_metric,
       last_seen_at = EXCLUDED.last_seen_at,
       last_changed_at = CASE
         WHEN EXCLUDED.last_observation_kind = 'unchanged' THEN existing.last_changed_at
         ELSE EXCLUDED.last_changed_at
       END,
       last_seen_run_id = EXCLUDED.last_seen_run_id,
       occurrence_count = existing.occurrence_count + 1,
       recurrence_count = existing.recurrence_count
         + CASE WHEN EXCLUDED.last_observation_kind = 'recurred' THEN 1 ELSE 0 END,
       worsened_count = existing.worsened_count
         + CASE WHEN EXCLUDED.last_observation_kind = 'worsened' THEN 1 ELSE 0 END,
       last_observation_kind = EXCLUDED.last_observation_kind,
       acknowledged_at = CASE WHEN existing.status = 'resolved' THEN NULL ELSE existing.acknowledged_at END,
       acknowledged_by = CASE WHEN existing.status = 'resolved' THEN NULL ELSE existing.acknowledged_by END,
       resolved_at = CASE WHEN existing.status = 'resolved' THEN NULL ELSE existing.resolved_at END,
       resolved_by = CASE WHEN existing.status = 'resolved' THEN NULL ELSE existing.resolved_by END,
       resolution = CASE WHEN existing.status = 'resolved' THEN NULL ELSE existing.resolution END,
       updated_at = NOW()`,
    [input.snapshotAt, input.runId],
  );

  await client.query(
    `INSERT INTO inventory.integrity_finding_observations (
       finding_id,
       run_id,
       observation_kind,
       prior_status,
       observed_metric,
       evidence_hash,
       evidence,
       observed_at
     )
     SELECT
       finding.id,
       $1,
       observed.observation_kind,
       observed.prior_status,
       observed.metric_value,
       observed.evidence_hash,
       observed.evidence,
       $2::timestamptz
     FROM integrity_observed_stage observed
     JOIN inventory.integrity_findings finding
       ON finding.check_id = observed.check_id
      AND finding.entity_fingerprint = observed.entity_fingerprint
     WHERE observed.observation_kind <> 'unchanged'`,
    [input.runId, input.snapshotAt],
  );
}

async function resolveMissingFindings(
  client: Pick<PoolClient, "query">,
  input: IntegrityAuditRegistryInput,
): Promise<number> {
  const result = await client.query(
    `WITH candidates AS (
       SELECT
         finding.id,
         finding.status AS prior_status,
         finding.current_metric,
         finding.current_evidence_hash,
         finding.current_evidence
       FROM inventory.integrity_findings finding
       WHERE finding.check_id = ANY($1::text[])
         AND finding.status <> 'resolved'
         AND NOT EXISTS (
           SELECT 1
           FROM integrity_observed_stage observed
           WHERE observed.check_id = finding.check_id
             AND observed.entity_fingerprint = finding.entity_fingerprint
         )
       FOR UPDATE
     ), resolved AS (
       UPDATE inventory.integrity_findings finding
       SET
         status = 'resolved',
         last_changed_at = $2::timestamptz,
         last_observation_kind = 'resolved',
         resolved_at = $2::timestamptz,
         resolved_by = 'system:inventory-integrity-audit',
         resolution = 'not observed by completed audit run',
         updated_at = NOW()
       FROM candidates candidate
       WHERE finding.id = candidate.id
       RETURNING
         finding.id,
         candidate.prior_status,
         candidate.current_metric,
         candidate.current_evidence_hash,
         candidate.current_evidence
     ), observations AS (
       INSERT INTO inventory.integrity_finding_observations (
         finding_id,
         run_id,
         observation_kind,
         prior_status,
         observed_metric,
         evidence_hash,
         evidence,
         observed_at
       )
       SELECT
         resolved.id,
         $3,
         'resolved',
         resolved.prior_status,
         resolved.current_metric,
         resolved.current_evidence_hash,
         resolved.current_evidence,
         $2::timestamptz
       FROM resolved
       RETURNING id
     )
     SELECT COUNT(*)::integer AS resolved_count FROM observations`,
    [input.checks.map((check) => check.checkId), input.snapshotAt, input.runId],
  );
  return Number(result.rows[0]?.resolved_count ?? 0);
}

async function readStageSummary(
  client: Pick<PoolClient, "query">,
  findings: number,
  resolved: number,
): Promise<IntegrityLifecycleSummary> {
  const result = await client.query(`
    SELECT observation_kind, COUNT(*)::integer AS count
    FROM integrity_observed_stage
    GROUP BY observation_kind
  `);
  const summary = emptySummary(findings);
  for (const row of result.rows) {
    const kind = String(row.observation_kind) as IntegrityObservationKind;
    incrementSummary(summary, kind, Number(row.count));
  }
  summary.resolved = resolved;
  return summary;
}

export async function persistIntegrityAuditRegistry(
  client: Pick<PoolClient, "query">,
  input: IntegrityAuditRegistryInput,
): Promise<IntegrityLifecycleSummary> {
  assertRegistryInput(input);
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [REGISTRY_LOCK_NAME]);
    await rejectStaleAuditRun(client, input);
    await insertRun(client, input);
    await createStageTables(client);
    await stageObservedFindings(client, input.findings);
    await classifyStage(client);
    await upsertFindings(client, input);
    const resolved = await resolveMissingFindings(client, input);
    if (input.scope === "continuous") {
      await enqueueContinuousIntegrityAlert(client, {
        runId: input.runId,
        snapshotAt: input.snapshotAt,
        sourceVersion: input.sourceVersion,
        blockerCount: input.blockerCount,
        warningCount: input.warningCount,
      });
    }
    const summary = await readStageSummary(client, input.findings.length, resolved);
    await client.query("COMMIT");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
