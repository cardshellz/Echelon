import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient, type PoolConfig } from "pg";

import { verifiedPostgresPoolConfig } from "../infrastructure/verified-postgres-pool-config";
import {
  PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_LIMITS,
  PackageAllocationDiscoveryPlanAuditRepositoryError,
  auditPackageAllocationAuthorityDiscoveryPlan,
  normalizePackageAllocationDiscoveryPlanAuditOptions,
  type NormalizedPackageAllocationDiscoveryPlanAuditOptions,
  type PackageAllocationDiscoveryPlanAuditReport,
} from "../modules/shipping/package-allocation-authority-discovery-plan-audit.repository";

interface PlanAuditPoolClient extends Pick<PoolClient, "query" | "release"> {}

interface BoundedPlanAuditPoolConfig extends PoolConfig {
  // pg supports these startup fields, but @types/pg omits them.
  readonly lock_timeout: number;
  readonly idle_in_transaction_session_timeout: number;
}

export interface PackageAllocationDiscoveryPlanAuditPool {
  connect(): Promise<PlanAuditPoolClient>;
  end(): Promise<void>;
}

export type PackageAllocationDiscoveryPlanAuditPoolFactory = (
  config: PoolConfig,
) => PackageAllocationDiscoveryPlanAuditPool;

export interface PackageAllocationDiscoveryPlanAuditJobResult
  extends PackageAllocationDiscoveryPlanAuditReport {
  readonly setupDurationMs: number;
  readonly connectDurationMs: number;
  readonly auditDurationMs: number;
  readonly cleanupDurationMs: number;
  readonly totalDurationMs: number;
}

export interface PackageAllocationDiscoveryPlanAuditRuntimeDependencies {
  readonly nowMs: () => number;
}

const DEFAULT_RUNTIME_DEPENDENCIES: PackageAllocationDiscoveryPlanAuditRuntimeDependencies =
  Object.freeze({ nowMs: () => performance.now() });

const CONNECTION_TIMEOUT_MS = 10_000;
const SERVER_STATEMENT_TIMEOUT_GRACE_MS = 5_000;
const CLIENT_QUERY_TIMEOUT_GRACE_MS = 5_000;
const IDLE_TRANSACTION_TIMEOUT_GRACE_MS = 15_000;
const POOL_IDLE_TIMEOUT_MS = 10_000;

export type PackageAllocationDiscoveryPlanAuditJobErrorCode =
  | "PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_CLEANUP_FAILED"
  | "PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_EXECUTION_AND_CLEANUP_FAILED";

export class PackageAllocationDiscoveryPlanAuditJobError extends Error {
  readonly code: PackageAllocationDiscoveryPlanAuditJobErrorCode;

  constructor(
    code: PackageAllocationDiscoveryPlanAuditJobErrorCode,
    message: string,
    failures: readonly unknown[],
  ) {
    super(message, { cause: new AggregateError([...failures], message) });
    this.name = "PackageAllocationDiscoveryPlanAuditJobError";
    this.code = code;
  }
}

export interface PackageAllocationDiscoveryPlanAuditCliOptions {
  readonly help: boolean;
  readonly sourceWmsShipmentItemId: number | null;
}

function positivePostgresInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${flag} must be a positive PostgreSQL integer`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed > 2_147_483_647) {
    throw new Error(`${flag} must be a positive PostgreSQL integer`);
  }
  return parsed;
}

export function parsePackageAllocationDiscoveryPlanAuditCliOptions(
  argv: readonly string[],
): PackageAllocationDiscoveryPlanAuditCliOptions {
  const help = argv.includes("--help") || argv.includes("-h");
  let sourceWmsShipmentItemId: number | null = null;
  let sourceSeen = false;
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") continue;
    if (!argument.startsWith("--source-id=")) {
      throw new Error(`Unknown flag: ${argument.split("=")[0]}`);
    }
    if (sourceSeen) throw new Error("Duplicate flag: --source-id");
    sourceSeen = true;
    sourceWmsShipmentItemId = positivePostgresInteger(
      argument.slice("--source-id=".length),
      "--source-id",
    );
  }
  if (!help && sourceWmsShipmentItemId === null) {
    throw new Error("--source-id is required");
  }
  return Object.freeze({ help, sourceWmsShipmentItemId });
}

export function assertPackageAllocationDiscoveryPlanAuditEnabled(
  environment: NodeJS.ProcessEnv,
): void {
  if (environment.PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_ENABLED !== "true") {
    throw new Error(
      "PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_ENABLED must be exactly 'true'",
    );
  }
}

export function packageAllocationDiscoveryPlanAuditConnectionString(
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

function defaultPoolFactory(config: PoolConfig): PackageAllocationDiscoveryPlanAuditPool {
  return new Pool(config);
}

export function packageAllocationDiscoveryPlanAuditPoolConfig(
  connectionString: string,
  repositoryOptions: Pick<
    NormalizedPackageAllocationDiscoveryPlanAuditOptions,
    "statementTimeoutMs" | "lockTimeoutMs" | "idleInTransactionTimeoutMs"
  >,
): PoolConfig {
  const serverStatementTimeoutMs = repositoryOptions.statementTimeoutMs
    + SERVER_STATEMENT_TIMEOUT_GRACE_MS;
  const config: BoundedPlanAuditPoolConfig = {
    ...verifiedPostgresPoolConfig({
      connectionString,
      applicationName: "package-allocation-discovery-plan-audit",
      max: 1,
    }),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: serverStatementTimeoutMs,
    query_timeout: serverStatementTimeoutMs + CLIENT_QUERY_TIMEOUT_GRACE_MS,
    lock_timeout: PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_LIMITS.maxLockTimeoutMs,
    idle_in_transaction_session_timeout:
      repositoryOptions.idleInTransactionTimeoutMs + IDLE_TRANSACTION_TIMEOUT_GRACE_MS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    allowExitOnIdle: true,
  };
  return config;
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

export async function runPackageAllocationDiscoveryPlanAuditJob(options: {
  readonly sourceWmsShipmentItemId: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly poolFactory?: PackageAllocationDiscoveryPlanAuditPoolFactory;
  readonly runtime?: PackageAllocationDiscoveryPlanAuditRuntimeDependencies;
  readonly auditPlan?: typeof auditPackageAllocationAuthorityDiscoveryPlan;
}): Promise<PackageAllocationDiscoveryPlanAuditJobResult> {
  const environment = options.environment ?? process.env;
  assertPackageAllocationDiscoveryPlanAuditEnabled(environment);
  const connectionString = packageAllocationDiscoveryPlanAuditConnectionString(environment);
  const repositoryOptions = normalizePackageAllocationDiscoveryPlanAuditOptions({
    sourceWmsShipmentItemId: options.sourceWmsShipmentItemId,
  });
  const runtime = options.runtime ?? DEFAULT_RUNTIME_DEPENDENCIES;
  const poolFactory = options.poolFactory ?? defaultPoolFactory;
  const auditPlan = options.auditPlan ?? auditPackageAllocationAuthorityDiscoveryPlan;
  const totalStartedAtMs = safeRuntimeValue(runtime.nowMs(), "audit start time");

  let pool: PackageAllocationDiscoveryPlanAuditPool | undefined;
  let client: PlanAuditPoolClient | null = null;
  let report: PackageAllocationDiscoveryPlanAuditReport | undefined;
  let setupStartedAtMs: number | undefined;
  let setupFinishedAtMs: number | undefined;
  let connectStartedAtMs: number | undefined;
  let connectFinishedAtMs: number | undefined;
  let auditStartedAtMs: number | undefined;
  let auditFinishedAtMs: number | undefined;
  let cleanupStartedAtMs: number | undefined;
  let cleanupFinishedAtMs: number | undefined;
  let primaryFailure: unknown;
  let primaryFailed = false;

  try {
    setupStartedAtMs = safeRuntimeValue(runtime.nowMs(), "setup start time");
    pool = poolFactory(packageAllocationDiscoveryPlanAuditPoolConfig(
      connectionString,
      repositoryOptions,
    ));
    setupFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "setup finish time");

    connectStartedAtMs = safeRuntimeValue(runtime.nowMs(), "connect start time");
    client = await pool.connect();
    connectFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "connect finish time");

    auditStartedAtMs = safeRuntimeValue(runtime.nowMs(), "plan audit start time");
    report = await auditPlan(client, repositoryOptions);
    auditFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "plan audit finish time");
  } catch (error) {
    primaryFailure = error;
    primaryFailed = true;
  }

  const cleanupFailures: unknown[] = [];
  if (pool !== undefined) {
    try {
      cleanupStartedAtMs = safeRuntimeValue(runtime.nowMs(), "cleanup start time");
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (client !== null) {
      try {
        client.release(primaryFailed ? new Error("discard failed plan-audit client") : undefined);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await pool.end();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      cleanupFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "cleanup finish time");
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (primaryFailed) {
    if (cleanupFailures.length > 0) {
      throw new PackageAllocationDiscoveryPlanAuditJobError(
        "PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_EXECUTION_AND_CLEANUP_FAILED",
        "Package-allocation discovery plan audit execution and cleanup both failed",
        [primaryFailure, ...cleanupFailures],
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new PackageAllocationDiscoveryPlanAuditJobError(
      "PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_CLEANUP_FAILED",
      "Package-allocation discovery plan audit cleanup failed",
      cleanupFailures,
    );
  }
  const totalFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "audit finish time");
  if (
    report === undefined
    || setupStartedAtMs === undefined
    || setupFinishedAtMs === undefined
    || connectStartedAtMs === undefined
    || connectFinishedAtMs === undefined
    || auditStartedAtMs === undefined
    || auditFinishedAtMs === undefined
    || cleanupStartedAtMs === undefined
    || cleanupFinishedAtMs === undefined
  ) {
    throw new Error("Package-allocation discovery plan audit completed without required evidence");
  }
  return Object.freeze({
    ...report,
    setupDurationMs: durationMs(setupStartedAtMs, setupFinishedAtMs, "setup duration"),
    connectDurationMs: durationMs(connectStartedAtMs, connectFinishedAtMs, "connect duration"),
    auditDurationMs: durationMs(auditStartedAtMs, auditFinishedAtMs, "audit duration"),
    cleanupDurationMs: durationMs(
      cleanupStartedAtMs,
      cleanupFinishedAtMs,
      "cleanup duration",
    ),
    totalDurationMs: durationMs(totalStartedAtMs, totalFinishedAtMs, "total duration"),
  });
}

function usage(): string {
  return [
    "Usage:",
    "  npm run wms:audit-package-allocation-discovery-plan -- --source-id=N",
    "",
    "Runs PostgreSQL EXPLAIN without ANALYZE under the dedicated read-only audit role.",
    "The source identifier is required for planning but is never emitted.",
  ].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parsePackageAllocationDiscoveryPlanAuditCliOptions(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runPackageAllocationDiscoveryPlanAuditJob({
    sourceWmsShipmentItemId: options.sourceWmsShipmentItemId!,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function isDirectExecution(metaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  return path.resolve(argvEntry) === fileURLToPath(metaUrl);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    const errorCode = error instanceof PackageAllocationDiscoveryPlanAuditRepositoryError
      ? error.code
      : error instanceof PackageAllocationDiscoveryPlanAuditJobError
        ? error.code
        : "PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_FAILED";
    process.stderr.write(JSON.stringify({ status: "failed", errorCode }) + "\n");
    process.exitCode = 1;
  });
}
