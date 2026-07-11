import { randomUUID } from "node:crypto";

import {
  projectSourceRows,
  type ControlTowerSourceAdapter,
  type ProjectionPreview,
  type QueryClient,
} from "./control-tower-v2.domain";

const PROJECTOR_LOCK_PREFIX = "operations_control_tower_projector:";

export interface ProjectionPersistenceSummary {
  runId: string;
  sourceName: string;
  status: "succeeded" | "partial" | "failed" | "skipped";
  completeScan: boolean;
  rowsScanned: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsResolved: number;
  rowsFailed: number;
  sourceWatermark: string | null;
  durationMs: number;
  errors: ProjectionPreview["errors"];
}

function elapsedMilliseconds(startedAt: Date, completedAt: Date): number {
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 2_000) || "Unknown projection failure";
}

async function createSourceRun(params: {
  client: QueryClient;
  runId: string;
  sourceName: string;
  projectionVersion: number;
  startedAt: Date;
}): Promise<void> {
  await params.client.query(`
    INSERT INTO operations.control_tower_source_runs (
      id,
      source_name,
      projector_version,
      status,
      complete_scan,
      started_at
    )
    VALUES ($1, $2, $3, 'running', FALSE, $4)
  `, [params.runId, params.sourceName, params.projectionVersion, params.startedAt.toISOString()]);
}

async function finishSourceRun(params: {
  client: QueryClient;
  runId: string;
  status: ProjectionPersistenceSummary["status"];
  completeScan: boolean;
  completedAt: Date;
  durationMs: number;
  rowsScanned: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsResolved: number;
  rowsFailed: number;
  sourceWatermark: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  await params.client.query(`
    UPDATE operations.control_tower_source_runs
    SET status = $2,
        complete_scan = $3,
        completed_at = $4,
        duration_ms = $5,
        rows_scanned = $6,
        rows_created = $7,
        rows_updated = $8,
        rows_resolved = $9,
        rows_failed = $10,
        source_watermark = $11,
        error_code = $12,
        error_message = $13
    WHERE id = $1
  `, [
    params.runId,
    params.status,
    params.completeScan,
    params.completedAt.toISOString(),
    params.durationMs,
    params.rowsScanned,
    params.rowsCreated,
    params.rowsUpdated,
    params.rowsResolved,
    params.rowsFailed,
    params.sourceWatermark,
    params.errorCode ?? null,
    params.errorMessage ?? null,
  ]);
}

async function createProjectionStage(client: QueryClient, preview: ProjectionPreview): Promise<void> {
  await client.query(`
    CREATE TEMP TABLE control_tower_projection_stage (
      source_key VARCHAR(200) PRIMARY KEY,
      data JSONB NOT NULL
    ) ON COMMIT DROP
  `);
  if (preview.items.length === 0) return;
  await client.query(`
    INSERT INTO control_tower_projection_stage (source_key, data)
    SELECT item->>'sourceKey', item
    FROM jsonb_array_elements($1::JSONB) AS staged(item)
  `, [JSON.stringify(preview.items)]);
}

async function persistProjectionStage(params: {
  client: QueryClient;
  preview: ProjectionPreview;
  runId: string;
  now: Date;
}): Promise<{ created: number; updated: number; resolved: number }> {
  const { client, preview, runId, now } = params;
  await createProjectionStage(client, preview);

  await client.query(`
    CREATE TEMP TABLE control_tower_projection_existing ON COMMIT DROP AS
    SELECT work_item.*
    FROM operations.control_tower_work_items AS work_item
    JOIN control_tower_projection_stage AS stage
      ON stage.source_key = work_item.source_key
    WHERE work_item.source_namespace = $1
      AND work_item.source_type = $2
  `, [preview.sourceNamespace, preview.sourceType]);

  const countsResult = await client.query<{
    created: string;
    updated: string;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE existing.id IS NULL)::TEXT AS created,
      COUNT(*) FILTER (
        WHERE existing.id IS NOT NULL
          AND (
            existing.source_fingerprint <> stage.data->>'sourceFingerprint'
            OR existing.source_status IN ('resolved', 'ignored')
            OR existing.projection_version <> (stage.data->>'projectionVersion')::INTEGER
          )
          AND (
            (stage.data->>'sourceUpdatedAt')::TIMESTAMPTZ >= existing.source_updated_at
            OR existing.source_status IN ('resolved', 'ignored')
            OR existing.projection_version <> (stage.data->>'projectionVersion')::INTEGER
          )
      )::TEXT AS updated
    FROM control_tower_projection_stage AS stage
    LEFT JOIN control_tower_projection_existing AS existing
      ON existing.source_key = stage.source_key
  `);
  const created = Number(countsResult.rows[0]?.created ?? 0);
  const updated = Number(countsResult.rows[0]?.updated ?? 0);

  await client.query(`
    INSERT INTO operations.control_tower_observations (
      work_item_id,
      source_run_id,
      observation_kind,
      prior_source_status,
      current_source_status,
      prior_triage_status,
      current_triage_status,
      changed_fields,
      evidence_summary,
      observed_metric,
      source_observed_at,
      created_at
    )
    SELECT
      existing.id,
      $1,
      CASE
        WHEN existing.source_status IN ('resolved', 'ignored') THEN 'reopened'
        ELSE 'changed'
      END,
      existing.source_status,
      stage.data->>'sourceStatus',
      existing.triage_status,
      CASE
        WHEN existing.source_status IN ('resolved', 'ignored') THEN 'needs_attention'
        ELSE existing.triage_status
      END,
      jsonb_build_object(
        'priorFingerprint', existing.source_fingerprint,
        'currentFingerprint', stage.data->>'sourceFingerprint',
        'priorSeverity', existing.severity,
        'currentSeverity', stage.data->>'severity',
        'priorProjectionVersion', existing.projection_version,
        'currentProjectionVersion', (stage.data->>'projectionVersion')::INTEGER
      ),
      stage.data->'evidenceSummary',
      NULLIF(stage.data->>'observedMetric', '')::NUMERIC,
      (stage.data->>'sourceUpdatedAt')::TIMESTAMPTZ,
      $2
    FROM control_tower_projection_existing AS existing
    JOIN control_tower_projection_stage AS stage
      ON stage.source_key = existing.source_key
    WHERE (
      existing.source_fingerprint <> stage.data->>'sourceFingerprint'
      OR existing.source_status IN ('resolved', 'ignored')
      OR existing.projection_version <> (stage.data->>'projectionVersion')::INTEGER
    )
      AND (
        (stage.data->>'sourceUpdatedAt')::TIMESTAMPTZ >= existing.source_updated_at
        OR existing.source_status IN ('resolved', 'ignored')
        OR existing.projection_version <> (stage.data->>'projectionVersion')::INTEGER
      )
  `, [runId, now.toISOString()]);

  await client.query(`
    INSERT INTO operations.control_tower_work_items (
      source_namespace,
      source_type,
      source_key,
      source_fingerprint,
      projection_version,
      domain,
      code,
      entity_type,
      entity_id,
      entity_ref,
      correlation_id,
      root_cause_group_key,
      title,
      summary,
      expected_state,
      actual_state,
      severity,
      urgency,
      impact_tags,
      actionability,
      source_status,
      triage_status,
      owner_team,
      recommended_action,
      response_due_at,
      first_seen_at,
      last_seen_at,
      last_changed_at,
      occurrence_count,
      recurrence_count,
      worsened_count,
      evidence_summary,
      detail_locator,
      available_actions,
      source_updated_at,
      last_source_run_id,
      created_at,
      updated_at
    )
    SELECT
      stage.data->>'sourceNamespace',
      stage.data->>'sourceType',
      stage.data->>'sourceKey',
      stage.data->>'sourceFingerprint',
      (stage.data->>'projectionVersion')::INTEGER,
      stage.data->>'domain',
      stage.data->>'code',
      stage.data->>'entityType',
      stage.data->>'entityId',
      NULLIF(stage.data->>'entityRef', ''),
      NULLIF(stage.data->>'correlationId', ''),
      NULLIF(stage.data->>'rootCauseGroupKey', ''),
      stage.data->>'title',
      stage.data->>'summary',
      stage.data->>'expectedState',
      stage.data->>'actualState',
      stage.data->>'severity',
      stage.data->>'urgency',
      ARRAY(
        SELECT jsonb_array_elements_text(stage.data->'impactTags')
      )::VARCHAR(30)[],
      stage.data->>'actionability',
      stage.data->>'sourceStatus',
      'needs_attention',
      NULLIF(stage.data->>'ownerTeam', ''),
      stage.data->>'recommendedAction',
      NULLIF(stage.data->>'responseDueAt', '')::TIMESTAMPTZ,
      (stage.data->>'firstSeenAt')::TIMESTAMPTZ,
      (stage.data->>'lastSeenAt')::TIMESTAMPTZ,
      (stage.data->>'lastChangedAt')::TIMESTAMPTZ,
      (stage.data->>'occurrenceCount')::BIGINT,
      (stage.data->>'recurrenceCount')::INTEGER,
      (stage.data->>'worsenedCount')::INTEGER,
      stage.data->'evidenceSummary',
      stage.data->'detailLocator',
      stage.data->'availableActions',
      (stage.data->>'sourceUpdatedAt')::TIMESTAMPTZ,
      $1,
      $2,
      $2
    FROM control_tower_projection_stage AS stage
    ON CONFLICT (source_namespace, source_type, source_key) DO UPDATE
    SET source_fingerprint = EXCLUDED.source_fingerprint,
        projection_version = EXCLUDED.projection_version,
        domain = EXCLUDED.domain,
        code = EXCLUDED.code,
        entity_type = EXCLUDED.entity_type,
        entity_id = EXCLUDED.entity_id,
        entity_ref = EXCLUDED.entity_ref,
        correlation_id = EXCLUDED.correlation_id,
        root_cause_group_key = EXCLUDED.root_cause_group_key,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        expected_state = EXCLUDED.expected_state,
        actual_state = EXCLUDED.actual_state,
        severity = EXCLUDED.severity,
        urgency = EXCLUDED.urgency,
        impact_tags = EXCLUDED.impact_tags,
        actionability = EXCLUDED.actionability,
        source_status = EXCLUDED.source_status,
        triage_status = CASE
          WHEN control_tower_work_items.source_status IN ('resolved', 'ignored') THEN 'needs_attention'
          ELSE control_tower_work_items.triage_status
        END,
        owner_team = COALESCE(control_tower_work_items.owner_team, EXCLUDED.owner_team),
        recommended_action = EXCLUDED.recommended_action,
        response_due_at = EXCLUDED.response_due_at,
        next_review_at = CASE
          WHEN control_tower_work_items.source_status IN ('resolved', 'ignored') THEN NULL
          ELSE control_tower_work_items.next_review_at
        END,
        first_seen_at = LEAST(control_tower_work_items.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(control_tower_work_items.last_seen_at, EXCLUDED.last_seen_at),
        last_changed_at = CASE
          WHEN control_tower_work_items.source_fingerprint <> EXCLUDED.source_fingerprint
            OR control_tower_work_items.source_status IN ('resolved', 'ignored')
            OR control_tower_work_items.projection_version <> EXCLUDED.projection_version
          THEN EXCLUDED.last_changed_at
          ELSE control_tower_work_items.last_changed_at
        END,
        resolved_at = NULL,
        occurrence_count = GREATEST(control_tower_work_items.occurrence_count, EXCLUDED.occurrence_count),
        recurrence_count = GREATEST(control_tower_work_items.recurrence_count, EXCLUDED.recurrence_count)
          + CASE WHEN control_tower_work_items.source_status IN ('resolved', 'ignored') THEN 1 ELSE 0 END,
        worsened_count = GREATEST(control_tower_work_items.worsened_count, EXCLUDED.worsened_count),
        evidence_summary = EXCLUDED.evidence_summary,
        detail_locator = EXCLUDED.detail_locator,
        available_actions = EXCLUDED.available_actions,
        source_updated_at = EXCLUDED.source_updated_at,
        last_source_run_id = EXCLUDED.last_source_run_id,
        row_version = control_tower_work_items.row_version + CASE
          WHEN control_tower_work_items.source_fingerprint <> EXCLUDED.source_fingerprint
            OR control_tower_work_items.source_status IN ('resolved', 'ignored')
            OR control_tower_work_items.projection_version <> EXCLUDED.projection_version
          THEN 1
          ELSE 0
        END,
        updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.source_updated_at >= control_tower_work_items.source_updated_at
       OR control_tower_work_items.source_status IN ('resolved', 'ignored')
       OR EXCLUDED.projection_version <> control_tower_work_items.projection_version
  `, [runId, now.toISOString()]);

  await client.query(`
    INSERT INTO operations.control_tower_observations (
      work_item_id,
      source_run_id,
      observation_kind,
      current_source_status,
      current_triage_status,
      changed_fields,
      evidence_summary,
      observed_metric,
      source_observed_at,
      created_at
    )
    SELECT
      work_item.id,
      $1,
      'new',
      work_item.source_status,
      work_item.triage_status,
      jsonb_build_object('projectionVersion', work_item.projection_version),
      stage.data->'evidenceSummary',
      NULLIF(stage.data->>'observedMetric', '')::NUMERIC,
      (stage.data->>'sourceUpdatedAt')::TIMESTAMPTZ,
      $2
    FROM control_tower_projection_stage AS stage
    JOIN operations.control_tower_work_items AS work_item
      ON work_item.source_namespace = $3
     AND work_item.source_type = $4
     AND work_item.source_key = stage.source_key
    LEFT JOIN control_tower_projection_existing AS existing
      ON existing.source_key = stage.source_key
    WHERE existing.id IS NULL
  `, [runId, now.toISOString(), preview.sourceNamespace, preview.sourceType]);

  let resolved = 0;
  if (preview.completeScan) {
    await client.query(`
      CREATE TEMP TABLE control_tower_projection_resolved ON COMMIT DROP AS
      SELECT work_item.*
      FROM operations.control_tower_work_items AS work_item
      WHERE work_item.source_namespace = $1
        AND work_item.source_type = $2
        AND work_item.source_status IN ('open', 'acknowledged')
        AND NOT EXISTS (
          SELECT 1
          FROM control_tower_projection_stage AS stage
          WHERE stage.source_key = work_item.source_key
        )
    `, [preview.sourceNamespace, preview.sourceType]);
    const resolvedResult = await client.query<{ count: string }>(`
      SELECT COUNT(*)::TEXT AS count
      FROM control_tower_projection_resolved
    `);
    resolved = Number(resolvedResult.rows[0]?.count ?? 0);

    await client.query(`
      INSERT INTO operations.control_tower_observations (
        work_item_id,
        source_run_id,
        observation_kind,
        prior_source_status,
        current_source_status,
        prior_triage_status,
        current_triage_status,
        changed_fields,
        evidence_summary,
        source_observed_at,
        created_at
      )
      SELECT
        resolved_item.id,
        $1,
        'resolved',
        resolved_item.source_status,
        'resolved',
        resolved_item.triage_status,
        'resolved',
        jsonb_build_object('reason', 'absent_from_complete_source_scan'),
        resolved_item.evidence_summary,
        $2,
        $2
      FROM control_tower_projection_resolved AS resolved_item
    `, [runId, now.toISOString()]);

    await client.query(`
      UPDATE operations.control_tower_work_items AS work_item
      SET source_status = 'resolved',
          triage_status = 'resolved',
          next_review_at = NULL,
          resolved_at = $2,
          last_changed_at = $2,
          last_source_run_id = $1,
          row_version = work_item.row_version + 1,
          updated_at = $2
      FROM control_tower_projection_resolved AS resolved_item
      WHERE resolved_item.id = work_item.id
    `, [runId, now.toISOString()]);
  }

  return { created, updated, resolved };
}

export async function previewControlTowerSource<Row>(params: {
  client: QueryClient;
  adapter: ControlTowerSourceAdapter<Row>;
  now?: Date;
}): Promise<ProjectionPreview> {
  const now = params.now ?? new Date();
  const rows = await params.adapter.loadRows(params.client, now);
  return projectSourceRows({ adapter: params.adapter, rows, now });
}

export async function runControlTowerSourceProjection<Row>(params: {
  client: QueryClient;
  adapter: ControlTowerSourceAdapter<Row>;
  clock?: () => Date;
  idGenerator?: () => string;
}): Promise<ProjectionPersistenceSummary> {
  const clock = params.clock ?? (() => new Date());
  const runId = (params.idGenerator ?? randomUUID)();
  const startedAt = clock();
  await createSourceRun({
    client: params.client,
    runId,
    sourceName: params.adapter.name,
    projectionVersion: params.adapter.projectionVersion,
    startedAt,
  });

  let transactionOpen = false;
  try {
    await params.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    transactionOpen = true;
    const lockResult = await params.client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
      [`${PROJECTOR_LOCK_PREFIX}${params.adapter.name}`],
    );
    if (lockResult.rows[0]?.acquired !== true) {
      await params.client.query("ROLLBACK");
      transactionOpen = false;
      const completedAt = clock();
      const durationMs = elapsedMilliseconds(startedAt, completedAt);
      await finishSourceRun({
        client: params.client,
        runId,
        status: "skipped",
        completeScan: false,
        completedAt,
        durationMs,
        rowsScanned: 0,
        rowsCreated: 0,
        rowsUpdated: 0,
        rowsResolved: 0,
        rowsFailed: 0,
        sourceWatermark: null,
        errorCode: "SOURCE_LOCK_HELD",
        errorMessage: "Another projector run owns the source advisory lock",
      });
      return {
        runId,
        sourceName: params.adapter.name,
        status: "skipped",
        completeScan: false,
        rowsScanned: 0,
        rowsCreated: 0,
        rowsUpdated: 0,
        rowsResolved: 0,
        rowsFailed: 0,
        sourceWatermark: null,
        durationMs,
        errors: [],
      };
    }

    const now = clock();
    const rows = await params.adapter.loadRows(params.client, now);
    const preview = projectSourceRows({ adapter: params.adapter, rows, now });
    const persisted = await persistProjectionStage({
      client: params.client,
      preview,
      runId,
      now,
    });
    const completedAt = clock();
    const durationMs = elapsedMilliseconds(startedAt, completedAt);
    const status = preview.completeScan ? "succeeded" : "partial";
    await finishSourceRun({
      client: params.client,
      runId,
      status,
      completeScan: preview.completeScan,
      completedAt,
      durationMs,
      rowsScanned: preview.rowsScanned,
      rowsCreated: persisted.created,
      rowsUpdated: persisted.updated,
      rowsResolved: persisted.resolved,
      rowsFailed: preview.rowsFailed,
      sourceWatermark: preview.sourceWatermark,
      errorCode: preview.completeScan ? null : "INVALID_SOURCE_ROWS",
      errorMessage: preview.completeScan ? null : JSON.stringify(preview.errors.slice(0, 10)),
    });
    await params.client.query("COMMIT");
    transactionOpen = false;
    return {
      runId,
      sourceName: params.adapter.name,
      status,
      completeScan: preview.completeScan,
      rowsScanned: preview.rowsScanned,
      rowsCreated: persisted.created,
      rowsUpdated: persisted.updated,
      rowsResolved: persisted.resolved,
      rowsFailed: preview.rowsFailed,
      sourceWatermark: preview.sourceWatermark,
      durationMs,
      errors: preview.errors,
    };
  } catch (error) {
    if (transactionOpen) {
      await params.client.query("ROLLBACK").catch(() => undefined);
    }
    const completedAt = clock();
    const durationMs = elapsedMilliseconds(startedAt, completedAt);
    await finishSourceRun({
      client: params.client,
      runId,
      status: "failed",
      completeScan: false,
      completedAt,
      durationMs,
      rowsScanned: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsResolved: 0,
      rowsFailed: 1,
      sourceWatermark: null,
      errorCode: "PROJECTION_FAILED",
      errorMessage: sanitizedError(error),
    }).catch((runError) => {
      console.error("[Operations Control Tower] failed to persist source-run failure", {
        runId,
        sourceName: params.adapter.name,
        error: sanitizedError(runError),
      });
    });
    throw error;
  }
}
