import type { FlowWaterfall } from "../oms/flow-waterfall.service";
import { getFlowWaterfall } from "../oms/flow-waterfall.service";
import type { QueryClient } from "./control-tower-v2.domain";

const SNAPSHOT_KEY = "order-flow-30d";
const WINDOW_DAYS = 30;
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const MIN_REFRESH_INTERVAL_MS = 60_000;
const MAX_REFRESH_INTERVAL_MS = 60 * 60_000;
const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

interface FlowWaterfallDatabase {
  transaction: FlowWaterfallTransaction;
}

type FlowWaterfallTransaction = <T>(callback: (transaction: unknown) => Promise<T>) => Promise<T>;

interface SnapshotRow {
  snapshot_key: string;
  window_days: number;
  status: "running" | "succeeded" | "failed";
  payload: FlowWaterfall | null;
  started_at: Date | string | null;
  generated_at: Date | string | null;
  completed_at: Date | string | null;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  updated_at: Date | string;
}

export interface ControlTowerFlowSnapshotRefreshResult {
  outcome: "refreshed" | "not_due" | "failed";
  snapshotKey: string;
  durationMs: number | null;
  generatedAt: string | null;
  errorCode?: string;
  errorMessage?: string;
}

function boundedIntervalFromEnv(name: string, fallback: number, min: number, max: number): number {
  const configured = Number(process.env[name]);
  return Number.isInteger(configured) && configured >= min && configured <= max
    ? configured
    : fallback;
}

function refreshIntervalMs(): number {
  return boundedIntervalFromEnv(
    "CONTROL_TOWER_FLOW_REFRESH_INTERVAL_MS",
    DEFAULT_REFRESH_INTERVAL_MS,
    MIN_REFRESH_INTERVAL_MS,
    MAX_REFRESH_INTERVAL_MS,
  );
}

function staleAfterMs(): number {
  return boundedIntervalFromEnv(
    "CONTROL_TOWER_FLOW_STALE_AFTER_MS",
    DEFAULT_STALE_AFTER_MS,
    MIN_REFRESH_INTERVAL_MS,
    24 * 60 * 60_000,
  );
}

function asIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function errorDetails(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown };
  const message = String(candidate?.message ?? error ?? "Unknown flow snapshot failure")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4_000);
  const code = String(candidate?.code ?? "FLOW_SNAPSHOT_REFRESH_FAILED")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 100);
  return { code, message };
}

async function latestSnapshot(client: QueryClient): Promise<SnapshotRow | null> {
  const result = await client.query<SnapshotRow>(`
    SELECT
      snapshot_key,
      window_days,
      status,
      payload,
      started_at,
      generated_at,
      completed_at,
      duration_ms,
      error_code,
      error_message,
      updated_at
    FROM operations.control_tower_flow_snapshots
    WHERE snapshot_key = $1
  `, [SNAPSHOT_KEY]);
  return result.rows[0] ?? null;
}

function snapshotIsDue(row: SnapshotRow | null, now: Date): boolean {
  if (!row?.generated_at) return true;
  const generatedAt = new Date(row.generated_at).getTime();
  return Number.isNaN(generatedAt) || now.getTime() - generatedAt >= refreshIntervalMs();
}

export async function refreshControlTowerFlowSnapshotIfDue(params: {
  client: QueryClient;
  db: FlowWaterfallDatabase;
  clock?: () => Date;
  monotonicNowMs?: () => number;
}): Promise<ControlTowerFlowSnapshotRefreshResult> {
  const clock = params.clock ?? (() => new Date());
  const monotonicNowMs = params.monotonicNowMs ?? (() => Date.now());
  const now = clock();
  const existing = await latestSnapshot(params.client);
  if (!snapshotIsDue(existing, now)) {
    return {
      outcome: "not_due",
      snapshotKey: SNAPSHOT_KEY,
      durationMs: existing?.duration_ms ?? null,
      generatedAt: asIso(existing?.generated_at ?? null),
    };
  }

  await params.client.query(`
    INSERT INTO operations.control_tower_flow_snapshots (
      snapshot_key,
      window_days,
      status,
      started_at,
      completed_at,
      duration_ms,
      error_code,
      error_message,
      created_at,
      updated_at
    ) VALUES ($1, $2, 'running', $3, NULL, NULL, NULL, NULL, $3, $3)
    ON CONFLICT (snapshot_key) DO UPDATE SET
      window_days = EXCLUDED.window_days,
      status = 'running',
      started_at = EXCLUDED.started_at,
      completed_at = NULL,
      duration_ms = NULL,
      error_code = NULL,
      error_message = NULL,
      updated_at = EXCLUDED.updated_at
  `, [SNAPSHOT_KEY, WINDOW_DAYS, now]);

  const startedAtMs = monotonicNowMs();
  try {
    const payload = await getFlowWaterfall(params.db, { windowDays: WINDOW_DAYS });
    const completedAt = clock();
    const durationMs = Math.max(0, monotonicNowMs() - startedAtMs);
    await params.client.query(`
      UPDATE operations.control_tower_flow_snapshots
      SET
        status = 'succeeded',
        payload = $2::JSONB,
        generated_at = $3,
        completed_at = $4,
        duration_ms = $5,
        error_code = NULL,
        error_message = NULL,
        updated_at = $4
      WHERE snapshot_key = $1
    `, [SNAPSHOT_KEY, JSON.stringify(payload), payload.generatedAt, completedAt, durationMs]);
    return {
      outcome: "refreshed",
      snapshotKey: SNAPSHOT_KEY,
      durationMs,
      generatedAt: payload.generatedAt,
    };
  } catch (error) {
    const completedAt = clock();
    const durationMs = Math.max(0, monotonicNowMs() - startedAtMs);
    const details = errorDetails(error);
    await params.client.query(`
      UPDATE operations.control_tower_flow_snapshots
      SET
        status = 'failed',
        completed_at = $2,
        duration_ms = $3,
        error_code = $4,
        error_message = $5,
        updated_at = $2
      WHERE snapshot_key = $1
    `, [SNAPSHOT_KEY, completedAt, durationMs, details.code, details.message]);
    return {
      outcome: "failed",
      snapshotKey: SNAPSHOT_KEY,
      durationMs,
      generatedAt: asIso(existing?.generated_at ?? null),
      errorCode: details.code,
      errorMessage: details.message,
    };
  }
}

export async function getControlTowerFlowOverview(client: QueryClient, now = new Date()) {
  const row = await latestSnapshot(client);
  if (!row) {
    return {
      status: "pending" as const,
      stale: true,
      staleAfterMinutes: Math.round(staleAfterMs() / 60_000),
      snapshot: null,
      lastAttempt: null,
    };
  }

  const generatedAt = asIso(row.generated_at);
  const ageMs = generatedAt ? Math.max(0, now.getTime() - new Date(generatedAt).getTime()) : null;
  const stale = ageMs === null || ageMs > staleAfterMs();
  const status = row.status === "running"
    ? "refreshing"
    : row.status === "failed" && row.payload
      ? "degraded"
      : row.status === "failed"
        ? "failed"
        : stale
          ? "stale"
          : "current";

  return {
    status,
    stale,
    staleAfterMinutes: Math.round(staleAfterMs() / 60_000),
    snapshot: row.payload,
    lastAttempt: {
      status: row.status,
      startedAt: asIso(row.started_at),
      completedAt: asIso(row.completed_at),
      durationMs: row.duration_ms,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      updatedAt: asIso(row.updated_at),
    },
  };
}
