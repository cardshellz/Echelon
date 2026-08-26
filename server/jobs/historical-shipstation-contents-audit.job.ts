import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient, type PoolConfig } from "pg";

import { verifiedPostgresPoolConfig } from "../infrastructure/verified-postgres-pool-config";
import {
  createHistoricalShipStationContentsClient,
  type HistoricalShipStationContentsClient,
} from "../modules/shipping/historical-shipstation-contents-audit.client";
import {
  HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_LIMITS,
  HistoricalShipStationContentsAuditRepositoryError,
  loadHistoricalShipStationContentsCandidates,
  normalizeHistoricalShipStationContentsAuditRepositoryOptions,
  type HistoricalShipStationContentsAuditRepositoryOptions,
  type HistoricalShipStationContentsCandidateBatch,
  type NormalizedHistoricalShipStationContentsAuditRepositoryOptions,
} from "../modules/shipping/historical-shipstation-contents-audit.repository";
import {
  auditHistoricalShipStationContents,
  type HistoricalShipStationContentsAuditReport,
} from "../modules/shipping/historical-shipstation-contents-audit.service";

interface AuditPoolClient extends Pick<PoolClient, "query" | "release"> {}

interface BoundedAuditPoolConfig extends PoolConfig {
  readonly lock_timeout: number;
  readonly idle_in_transaction_session_timeout: number;
}

export interface HistoricalShipStationContentsAuditPool {
  connect(): Promise<AuditPoolClient>;
  end(): Promise<void>;
}

export type HistoricalShipStationContentsAuditPoolFactory = (
  config: PoolConfig,
) => HistoricalShipStationContentsAuditPool;

export interface HistoricalShipStationContentsAuditJobResult
  extends HistoricalShipStationContentsAuditReport {
  readonly setupDurationMs: number;
  readonly databaseReadDurationMs: number;
  readonly providerAuditDurationMs: number;
  readonly totalDurationMs: number;
}

export interface HistoricalShipStationContentsAuditRuntime {
  readonly nowMs: () => number;
}

const DEFAULT_RUNTIME: HistoricalShipStationContentsAuditRuntime = Object.freeze({
  nowMs: () => performance.now(),
});

const CONNECTION_TIMEOUT_MS = 10_000;
const SERVER_STATEMENT_TIMEOUT_GRACE_MS = 5_000;
const CLIENT_QUERY_TIMEOUT_GRACE_MS = 5_000;
const IDLE_TRANSACTION_TIMEOUT_GRACE_MS = 15_000;
const POOL_IDLE_TIMEOUT_MS = 10_000;
const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");

export type HistoricalShipStationContentsAuditJobErrorCode =
  | "HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_CLEANUP_FAILED"
  | "HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_EXECUTION_AND_CLEANUP_FAILED";

export class HistoricalShipStationContentsAuditJobError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsAuditJobErrorCode,
    message: string,
    failures: readonly unknown[],
  ) {
    super(message, { cause: new AggregateError([...failures], message) });
    this.name = "HistoricalShipStationContentsAuditJobError";
  }
}

export interface HistoricalShipStationContentsAuditCliOptions {
  readonly help: boolean;
  readonly candidateLimit: number;
  readonly beforeLabelId: string | null;
}

function positiveLimit(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("--limit must be a positive integer");
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed > HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_LIMITS.maxCandidateLimit
  ) {
    throw new Error(
      `--limit must not exceed ${HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_LIMITS.maxCandidateLimit}`,
    );
  }
  return parsed;
}

function positiveBigintCursor(value: string): string {
  if (
    !/^[1-9][0-9]*$/.test(value)
    || BigInt(value) > POSTGRES_BIGINT_MAX
  ) {
    throw new Error("--before-label-id must be a positive PostgreSQL bigint");
  }
  return value;
}

export function parseHistoricalShipStationContentsAuditCliOptions(
  argv: readonly string[],
): HistoricalShipStationContentsAuditCliOptions {
  let help = false;
  let candidateLimit: number = HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_LIMITS.defaultCandidateLimit;
  let beforeLabelId: string | null = null;
  let limitSeen = false;
  let beforeLabelIdSeen = false;
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument.startsWith("--before-label-id=")) {
      if (beforeLabelIdSeen) throw new Error("Duplicate flag: --before-label-id");
      beforeLabelIdSeen = true;
      beforeLabelId = positiveBigintCursor(argument.slice("--before-label-id=".length));
      continue;
    }
    if (!argument.startsWith("--limit=")) {
      throw new Error(`Unknown flag: ${argument.split("=")[0]}`);
    }
    if (limitSeen) throw new Error("Duplicate flag: --limit");
    limitSeen = true;
    candidateLimit = positiveLimit(argument.slice("--limit=".length));
  }
  return Object.freeze({ help, candidateLimit, beforeLabelId });
}

export function assertHistoricalShipStationContentsAuditEnabled(
  environment: NodeJS.ProcessEnv,
): void {
  if (environment.HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_ENABLED !== "true") {
    throw new Error(
      "HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_ENABLED must be exactly 'true'",
    );
  }
}

export function historicalShipStationContentsAuditConnectionString(
  environment: NodeJS.ProcessEnv,
): string {
  const value = environment.WMS_INTEGRITY_AUDIT_DATABASE_URL;
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error("WMS_INTEGRITY_AUDIT_DATABASE_URL is required without surrounding whitespace");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("WMS_INTEGRITY_AUDIT_DATABASE_URL must be a PostgreSQL URL");
  }
  return value;
}

export function historicalShipStationContentsAuditPoolConfig(
  connectionString: string,
  repositoryOptions: Pick<
    NormalizedHistoricalShipStationContentsAuditRepositoryOptions,
    "statementTimeoutMs" | "lockTimeoutMs" | "idleInTransactionTimeoutMs"
  >,
): PoolConfig {
  const serverStatementTimeoutMs = repositoryOptions.statementTimeoutMs
    + SERVER_STATEMENT_TIMEOUT_GRACE_MS;
  const config: BoundedAuditPoolConfig = {
    ...verifiedPostgresPoolConfig({
      connectionString,
      applicationName: "historical-shipstation-contents-read-only-audit",
      max: 1,
    }),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: serverStatementTimeoutMs,
    query_timeout: serverStatementTimeoutMs + CLIENT_QUERY_TIMEOUT_GRACE_MS,
    lock_timeout: HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_LIMITS.maxLockTimeoutMs,
    idle_in_transaction_session_timeout:
      repositoryOptions.idleInTransactionTimeoutMs + IDLE_TRANSACTION_TIMEOUT_GRACE_MS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    allowExitOnIdle: true,
  };
  return config;
}

function defaultPoolFactory(config: PoolConfig): HistoricalShipStationContentsAuditPool {
  return new Pool(config);
}

function safeRuntimeValue(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

function durationMs(start: number, end: number, field: string): number {
  const safeStart = safeRuntimeValue(start, `${field} start`);
  const safeEnd = safeRuntimeValue(end, `${field} end`);
  if (safeEnd < safeStart) throw new Error(`${field} clock moved backwards`);
  return safeEnd - safeStart;
}

async function loadCandidateBatch(options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly repositoryOptions: NormalizedHistoricalShipStationContentsAuditRepositoryOptions;
  readonly poolFactory: HistoricalShipStationContentsAuditPoolFactory;
  readonly loadCandidates: typeof loadHistoricalShipStationContentsCandidates;
}): Promise<HistoricalShipStationContentsCandidateBatch> {
  const connectionString = historicalShipStationContentsAuditConnectionString(options.environment);
  let pool: HistoricalShipStationContentsAuditPool | undefined;
  let client: AuditPoolClient | null = null;
  let batch: HistoricalShipStationContentsCandidateBatch | undefined;
  let primaryFailure: unknown;
  try {
    pool = options.poolFactory(historicalShipStationContentsAuditPoolConfig(
      connectionString,
      options.repositoryOptions,
    ));
    client = await pool.connect();
    batch = await options.loadCandidates(client, {
      ...options.repositoryOptions,
      beforeLabelId: options.repositoryOptions.beforeLabelId ?? undefined,
    });
  } catch (error) {
    primaryFailure = error;
  }

  const cleanupFailures: unknown[] = [];
  if (client !== null) {
    try {
      client.release(
        primaryFailure === undefined
          ? undefined
          : new Error("discard failed historical ShipStation contents audit client"),
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (pool !== undefined) {
    try {
      await pool.end();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (primaryFailure !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new HistoricalShipStationContentsAuditJobError(
        "HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_EXECUTION_AND_CLEANUP_FAILED",
        "Historical ShipStation contents database read and cleanup both failed",
        [primaryFailure, ...cleanupFailures],
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new HistoricalShipStationContentsAuditJobError(
      "HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_CLEANUP_FAILED",
      "Historical ShipStation contents database cleanup failed",
      cleanupFailures,
    );
  }
  if (batch === undefined) {
    throw new Error("Historical ShipStation contents database read completed without a result");
  }
  return batch;
}

export async function runHistoricalShipStationContentsAuditJob(options: {
  readonly candidateLimit?: number;
  readonly beforeLabelId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly repositoryOptions?: Omit<
    HistoricalShipStationContentsAuditRepositoryOptions,
    "candidateLimit" | "beforeLabelId"
  >;
  readonly poolFactory?: HistoricalShipStationContentsAuditPoolFactory;
  readonly providerClient?: HistoricalShipStationContentsClient;
  readonly loadCandidates?: typeof loadHistoricalShipStationContentsCandidates;
  readonly audit?: typeof auditHistoricalShipStationContents;
  readonly runtime?: HistoricalShipStationContentsAuditRuntime;
} = {}): Promise<HistoricalShipStationContentsAuditJobResult> {
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const totalStartedAtMs = safeRuntimeValue(runtime.nowMs(), "audit start time");
  const setupStartedAtMs = safeRuntimeValue(runtime.nowMs(), "setup start time");
  const environment = options.environment ?? process.env;
  assertHistoricalShipStationContentsAuditEnabled(environment);
  const repositoryOptions = normalizeHistoricalShipStationContentsAuditRepositoryOptions({
    ...options.repositoryOptions,
    candidateLimit: options.candidateLimit,
    beforeLabelId: options.beforeLabelId,
  });
  const providerClient = options.providerClient ?? createHistoricalShipStationContentsClient({
    apiKey: environment.SHIPSTATION_API_KEY,
    apiSecret: environment.SHIPSTATION_API_SECRET,
  });
  const poolFactory = options.poolFactory ?? defaultPoolFactory;
  const loadCandidates = options.loadCandidates ?? loadHistoricalShipStationContentsCandidates;
  const audit = options.audit ?? auditHistoricalShipStationContents;
  const setupFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "setup finish time");
  const databaseReadStartedAtMs = safeRuntimeValue(runtime.nowMs(), "database read start time");
  const batch = await loadCandidateBatch({
    environment,
    repositoryOptions,
    poolFactory,
    loadCandidates,
  });
  const databaseReadFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "database read finish time");
  const providerAuditStartedAtMs = safeRuntimeValue(runtime.nowMs(), "provider audit start time");
  const report = await audit(batch, providerClient);
  const providerAuditFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "provider audit finish time");
  const totalFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "audit finish time");

  return Object.freeze({
    ...report,
    setupDurationMs: durationMs(setupStartedAtMs, setupFinishedAtMs, "setup duration"),
    databaseReadDurationMs: durationMs(
      databaseReadStartedAtMs,
      databaseReadFinishedAtMs,
      "database read duration",
    ),
    providerAuditDurationMs: durationMs(
      providerAuditStartedAtMs,
      providerAuditFinishedAtMs,
      "provider audit duration",
    ),
    totalDurationMs: durationMs(totalStartedAtMs, totalFinishedAtMs, "total duration"),
  });
}

function usage(): string {
  return [
    "Usage:",
    "  npm run wms:audit-historical-shipstation-contents -- [--limit=N] [--before-label-id=ID]",
    "",
    "Reads a bounded historical V1 candidate page with the dedicated audit role,",
    "performs bounded ShipStation detail GETs, and prints aggregate counts plus bounded",
    "internal recoverable/review label IDs and cryptographic evidence hashes.",
    "It never prints provider shipment IDs, tracking numbers, SKUs, quantities, or raw payloads.",
    "It never writes evidence and never resolves historical omissions automatically.",
  ].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cli = parseHistoricalShipStationContentsAuditCliOptions(argv);
  if (cli.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runHistoricalShipStationContentsAuditJob({
    candidateLimit: cli.candidateLimit,
    beforeLabelId: cli.beforeLabelId ?? undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function isDirectExecution(metaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  return path.resolve(argvEntry) === fileURLToPath(metaUrl);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    const errorCode = error instanceof HistoricalShipStationContentsAuditRepositoryError
      ? error.code
      : error instanceof HistoricalShipStationContentsAuditJobError
        ? error.code
        : "HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "failed", errorCode })}\n`);
    process.exitCode = 1;
  });
}
