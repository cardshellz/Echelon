import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient, type PoolConfig } from "pg";
import { verifiedPostgresPoolConfig } from "../infrastructure/verified-postgres-pool-config";

import {
  summarizePersistedDeclaredPackageLifecycleShadow,
  type DeclaredPackageLifecycleShadowSummary,
  type PersistedConfirmedCarrierEvidenceRow,
  type PersistedDeclaredPackageEvidence,
  type PersistedShippingProviderLabelEventRow,
} from "../modules/shipping/declared-package-lifecycle-shadow.domain";
import {
  SHIPMENT_LIFECYCLE_SHADOW_AUDIT_LIMITS,
  ShipmentLifecycleShadowAuditRepositoryError,
  loadShipmentLifecycleShadowAuditBatch,
  normalizeShipmentLifecycleShadowAuditRepositoryOptions,
  type NormalizedShipmentLifecycleShadowAuditRepositoryOptions,
  type ShipmentLifecycleShadowAuditBatch,
  type ShipmentLifecycleShadowAuditRepositoryOptions,
} from "../modules/shipping/shipment-lifecycle-shadow-audit.repository";

interface ShadowAuditPoolClient extends Pick<PoolClient, "query" | "release"> {}

interface BoundedShadowAuditPoolConfig extends PoolConfig {
  // pg supports this startup field at runtime, but @types/pg omits it.
  readonly lock_timeout: number;
}

export interface ShadowAuditPool {
  connect(): Promise<ShadowAuditPoolClient>;
  end(): Promise<void>;
}

export type ShadowAuditPoolFactory = (config: PoolConfig) => ShadowAuditPool;

export interface ShipmentLifecycleShadowAuditAggregate
  extends DeclaredPackageLifecycleShadowSummary {
  readonly mode: "read_only_shadow";
  readonly snapshotAt: string;
  readonly labelLimit: number;
  readonly batchLimitReached: boolean;
  readonly nextPageAvailable: boolean;
  readonly labelEventCount: number;
  readonly selectedEventPayloadBytes: number;
  readonly maxEventPayloadBytes: number;
  readonly databaseTemporaryPrivilege: boolean;
  readonly currentConfirmedCarrierEvidenceCount: number;
}

export interface ShipmentLifecycleShadowAuditRuntimeMetrics {
  readonly setupDurationMs: number;
  readonly connectDurationMs: number;
  readonly repositoryDurationMs: number;
  readonly projectionDurationMs: number;
  readonly cleanupDurationMs: number;
  readonly totalDurationMs: number;
  readonly rssBeforeBytes: number;
  readonly rssAfterLoadBytes: number;
  readonly rssAfterProjectionBytes: number;
  readonly rssAfterCleanupBytes: number;
  readonly observedMaxRssBytes: number;
}

export interface VerifiedShipmentLifecycleShadowAuditAggregate
  extends ShipmentLifecycleShadowAuditAggregate,
    ShipmentLifecycleShadowAuditRuntimeMetrics {
  readonly readOnlyRoleVerified: true;
}

export interface ShipmentLifecycleShadowAuditRuntimeDependencies {
  readonly nowMs: () => number;
  readonly rssBytes: () => number;
}

const DEFAULT_RUNTIME_DEPENDENCIES: ShipmentLifecycleShadowAuditRuntimeDependencies = Object.freeze({
  nowMs: () => performance.now(),
  rssBytes: () => process.memoryUsage().rss,
});

const SERVER_STATEMENT_TIMEOUT_GRACE_MS = 5_000;
const CLIENT_QUERY_TIMEOUT_GRACE_MS = 5_000;
const IDLE_IN_TRANSACTION_TIMEOUT_GRACE_MS = 15_000;
const POOL_IDLE_TIMEOUT_MS = 10_000;

export type ShipmentLifecycleShadowAuditJobErrorCode =
  | "SHIPMENT_LIFECYCLE_SHADOW_CLEANUP_FAILED"
  | "SHIPMENT_LIFECYCLE_SHADOW_EXECUTION_AND_CLEANUP_FAILED";

export class ShipmentLifecycleShadowAuditJobError extends Error {
  readonly code: ShipmentLifecycleShadowAuditJobErrorCode;

  constructor(
    code: ShipmentLifecycleShadowAuditJobErrorCode,
    message: string,
    failures: readonly unknown[],
  ) {
    super(message, {
      cause: new AggregateError([...failures], message),
    });
    this.name = "ShipmentLifecycleShadowAuditJobError";
    this.code = code;
  }
}

export interface ShipmentLifecycleShadowAuditCliOptions {
  readonly help: boolean;
  readonly repositoryOptions: NormalizedShipmentLifecycleShadowAuditRepositoryOptions;
}

const CLI_REPOSITORY_FIELDS = Object.freeze({
  "--label-limit": "labelLimit",
  "--max-event-payload-bytes": "maxEventPayloadBytes",
  "--max-page-payload-bytes": "maxPagePayloadBytes",
} as const);

function safeNumericDatabaseId(value: string, field: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${field} is not a positive decimal database identifier`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds JavaScript's safe integer range`);
  }
  return Number(parsed);
}

function currentLabelStatus(
  value: string,
): PersistedDeclaredPackageEvidence["currentLabelStatus"] {
  if (
    value === "active"
    || value === "voided"
    || value === "superseded"
    || value === "unknown"
  ) {
    return value;
  }
  throw new Error("shipping provider label status is unsupported");
}

function groupLabelEvents(
  batch: ShipmentLifecycleShadowAuditBatch,
): ReadonlyMap<string, readonly PersistedShippingProviderLabelEventRow[]> {
  const grouped = new Map<string, PersistedShippingProviderLabelEventRow[]>();
  for (const event of batch.labelEvents) {
    const rows = grouped.get(event.shippingProviderLabelId) ?? [];
    rows.push(Object.freeze({
      id: safeNumericDatabaseId(event.labelEventId, "label event id"),
      shippingProviderLabelId: safeNumericDatabaseId(
        event.shippingProviderLabelId,
        "shipping provider label id",
      ),
      eventHash: event.eventHash,
      eventType: event.eventType,
      labelStatus: event.labelStatus,
      trackingNumber: event.trackingNumber,
      providerOccurredAt: event.providerOccurredAt,
      sanitizedPayload: event.sanitizedPayload,
      receivedAt: event.receivedAt,
    }));
    grouped.set(event.shippingProviderLabelId, rows);
  }
  return grouped;
}

function groupCurrentCarrierEvidence(
  batch: ShipmentLifecycleShadowAuditBatch,
): ReadonlyMap<string, readonly PersistedConfirmedCarrierEvidenceRow[]> {
  const grouped = new Map<string, PersistedConfirmedCarrierEvidenceRow[]>();
  for (const event of batch.currentCarrierMatches) {
    const rows = grouped.get(event.shippingProviderLabelId) ?? [];
    rows.push(Object.freeze({
      id: safeNumericDatabaseId(event.carrierTrackingEventId, "carrier tracking event id"),
      shippingProviderLabelId: safeNumericDatabaseId(
        event.shippingProviderLabelId,
        "shipping provider label id",
      ),
      dispatchEvidence: event.dispatchEvidence,
      currentMatchStatus: event.matchStatus,
      eventOccurredAt: event.eventOccurredAt,
      receivedAt: event.receivedAt,
    }));
    grouped.set(event.shippingProviderLabelId, rows);
  }
  return grouped;
}

function persistedPackagesFromBatch(
  batch: ShipmentLifecycleShadowAuditBatch,
): readonly PersistedDeclaredPackageEvidence[] {
  const labelEvents = groupLabelEvents(batch);
  const currentCarrierEvidence = groupCurrentCarrierEvidence(batch);
  return Object.freeze(batch.labels.map((label) => Object.freeze({
    shippingProviderLabelId: safeNumericDatabaseId(
      label.shippingProviderLabelId,
      "shipping provider label id",
    ),
    provider: label.provider,
    providerPhysicalShipmentId: label.providerLabelId,
    currentTrackingNumber: label.trackingNumber,
    currentLabelStatus: currentLabelStatus(label.labelStatus),
    firstObservedAt: label.firstObservedAt,
    lastObservedAt: label.lastObservedAt,
    labelDirection: label.labelDirection,
    labelEvents: Object.freeze([...(labelEvents.get(label.shippingProviderLabelId) ?? [])]),
    confirmedCarrierEvents: Object.freeze([
      ...(currentCarrierEvidence.get(label.shippingProviderLabelId) ?? []),
    ]),
  })));
}

/**
 * Converts the repository's string-form bigint identities only after proving
 * they fit JavaScript's safe integer range. The pure shadow summary then
 * discards every package, tracking, event, and line identity.
 */
export function summarizeShipmentLifecycleShadowAuditBatch(
  batch: ShipmentLifecycleShadowAuditBatch,
): ShipmentLifecycleShadowAuditAggregate {
  const lifecycleSummary = summarizePersistedDeclaredPackageLifecycleShadow(
    persistedPackagesFromBatch(batch),
  );
  return Object.freeze({
    ...lifecycleSummary,
    mode: "read_only_shadow",
    snapshotAt: batch.snapshotAt,
    labelLimit: batch.labelLimit,
    batchLimitReached: batch.batchLimitReached,
    nextPageAvailable: batch.nextCursor !== null,
    labelEventCount: batch.labelEvents.length,
    selectedEventPayloadBytes: batch.selectedEventPayloadBytes,
    maxEventPayloadBytes: batch.maxEventPayloadBytes,
    databaseTemporaryPrivilege: batch.databaseTemporaryPrivilege,
    currentConfirmedCarrierEvidenceCount: batch.currentCarrierMatches.length,
  });
}

export function assertShipmentLifecycleShadowEnabled(
  environment: NodeJS.ProcessEnv,
): void {
  if (environment.SHIPMENT_LIFECYCLE_SHADOW_ENABLED !== "true") {
    throw new Error(
      "SHIPMENT_LIFECYCLE_SHADOW_ENABLED must be exactly 'true' for the read-only shadow audit",
    );
  }
}

export function shipmentLifecycleShadowAuditConnectionString(
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

function defaultPoolFactory(config: PoolConfig): ShadowAuditPool {
  return new Pool(config);
}

export function shipmentLifecycleShadowAuditPoolConfig(
  connectionString: string,
  repositoryOptions: Pick<
    NormalizedShipmentLifecycleShadowAuditRepositoryOptions,
    "statementTimeoutMs" | "lockTimeoutMs" | "idleInTransactionTimeoutMs"
  > = normalizeShipmentLifecycleShadowAuditRepositoryOptions(),
): PoolConfig {
  const statementTimeoutMs = repositoryOptions.statementTimeoutMs
    + SERVER_STATEMENT_TIMEOUT_GRACE_MS;
  const config: BoundedShadowAuditPoolConfig = {
    ...verifiedPostgresPoolConfig({
      connectionString,
      applicationName: "shipment-lifecycle-read-only-shadow",
      max: 1,
    }),
    connectionTimeoutMillis: 10_000,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs + CLIENT_QUERY_TIMEOUT_GRACE_MS,
    lock_timeout: SHIPMENT_LIFECYCLE_SHADOW_AUDIT_LIMITS.maxLockTimeoutMs,
    idle_in_transaction_session_timeout:
      repositoryOptions.idleInTransactionTimeoutMs + IDLE_IN_TRANSACTION_TIMEOUT_GRACE_MS,
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

function safeRssBytes(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function durationMs(start: number, end: number, field: string): number {
  const safeStart = safeRuntimeValue(start, `${field} start`);
  const safeEnd = safeRuntimeValue(end, `${field} end`);
  if (safeEnd < safeStart) throw new Error(`${field} clock moved backwards`);
  return safeEnd - safeStart;
}

function positiveCliInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${flag} must be a positive decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} exceeds JavaScript's safe integer range`);
  }
  return parsed;
}

export function parseShipmentLifecycleShadowAuditCliOptions(
  argv: readonly string[],
): ShipmentLifecycleShadowAuditCliOptions {
  const help = argv.includes("--help") || argv.includes("-h");
  const seen = new Set<string>();
  const partial: ShipmentLifecycleShadowAuditRepositoryOptions = {};

  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") continue;
    const separator = argument.indexOf("=");
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    const value = separator < 0 ? "" : argument.slice(separator + 1);
    const field = CLI_REPOSITORY_FIELDS[flag as keyof typeof CLI_REPOSITORY_FIELDS];
    if (field === undefined) throw new Error(`Unknown flag: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate flag: ${flag}`);
    seen.add(flag);
    Object.assign(partial, { [field]: positiveCliInteger(value, flag) });
  }

  return Object.freeze({
    help,
    repositoryOptions: normalizeShipmentLifecycleShadowAuditRepositoryOptions(partial),
  });
}

function usage(): string {
  return [
    "Usage:",
    "  npm run wms:audit-shipment-lifecycle-shadow -- [options]",
    "",
    "Options:",
    "  --label-limit=N",
    "  --max-event-payload-bytes=N",
    "  --max-page-payload-bytes=N",
    "  --help, -h",
    "",
    "The command is one read-only page. It never emits the next-page cursor or record identities.",
  ].join("\n");
}

export async function runShipmentLifecycleShadowAuditJob(options: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly repositoryOptions?: ShipmentLifecycleShadowAuditRepositoryOptions;
  readonly poolFactory?: ShadowAuditPoolFactory;
  readonly runtime?: ShipmentLifecycleShadowAuditRuntimeDependencies;
} = {}): Promise<VerifiedShipmentLifecycleShadowAuditAggregate> {
  const environment = options.environment ?? process.env;
  assertShipmentLifecycleShadowEnabled(environment);
  const connectionString = shipmentLifecycleShadowAuditConnectionString(environment);
  const repositoryOptions = normalizeShipmentLifecycleShadowAuditRepositoryOptions(
    options.repositoryOptions,
  );
  const runtime = options.runtime ?? DEFAULT_RUNTIME_DEPENDENCIES;
  const totalStartedAtMs = safeRuntimeValue(runtime.nowMs(), "audit start time");
  const rssBeforeBytes = safeRssBytes(runtime.rssBytes(), "rss before audit");
  const poolFactory = options.poolFactory ?? defaultPoolFactory;

  let pool: ShadowAuditPool | undefined;
  let client: ShadowAuditPoolClient | null = null;
  let projected: ShipmentLifecycleShadowAuditAggregate | undefined;
  let setupStartedAtMs: number | undefined;
  let setupFinishedAtMs: number | undefined;
  let connectStartedAtMs: number | undefined;
  let connectFinishedAtMs: number | undefined;
  let repositoryStartedAtMs: number | undefined;
  let repositoryFinishedAtMs: number | undefined;
  let projectionStartedAtMs: number | undefined;
  let projectionFinishedAtMs: number | undefined;
  let cleanupStartedAtMs: number | undefined;
  let cleanupFinishedAtMs: number | undefined;
  let rssAfterLoadBytes: number | undefined;
  let rssAfterProjectionBytes: number | undefined;
  let primaryFailure: unknown;
  let primaryFailed = false;

  try {
    setupStartedAtMs = safeRuntimeValue(runtime.nowMs(), "setup start time");
    pool = poolFactory(shipmentLifecycleShadowAuditPoolConfig(
      connectionString,
      repositoryOptions,
    ));
    setupFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "setup finish time");

    connectStartedAtMs = safeRuntimeValue(runtime.nowMs(), "connect start time");
    client = await pool.connect();
    connectFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "connect finish time");

    repositoryStartedAtMs = safeRuntimeValue(runtime.nowMs(), "repository start time");
    const batch = await loadShipmentLifecycleShadowAuditBatch(
      client as Pick<PoolClient, "query">,
      repositoryOptions,
    );
    repositoryFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "repository finish time");
    rssAfterLoadBytes = safeRssBytes(runtime.rssBytes(), "rss after repository load");

    projectionStartedAtMs = safeRuntimeValue(runtime.nowMs(), "projection start time");
    projected = summarizeShipmentLifecycleShadowAuditBatch(batch);
    projectionFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "projection finish time");
    rssAfterProjectionBytes = safeRssBytes(
      runtime.rssBytes(),
      "rss after lifecycle projection",
    );
  } catch (error: unknown) {
    primaryFailure = error;
    primaryFailed = true;
  }

  const cleanupFailures: unknown[] = [];
  if (pool !== undefined) {
    try {
      cleanupStartedAtMs = safeRuntimeValue(runtime.nowMs(), "cleanup start time");
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
    if (client !== null) {
      try {
        client.release();
      } catch (error: unknown) {
        cleanupFailures.push(error);
      }
    }
    try {
      await pool.end();
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
    try {
      cleanupFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "cleanup finish time");
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
  }

  if (primaryFailed) {
    if (cleanupFailures.length > 0) {
      throw new ShipmentLifecycleShadowAuditJobError(
        "SHIPMENT_LIFECYCLE_SHADOW_EXECUTION_AND_CLEANUP_FAILED",
        "Shipment lifecycle shadow audit execution and cleanup both failed",
        [primaryFailure, ...cleanupFailures],
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new ShipmentLifecycleShadowAuditJobError(
      "SHIPMENT_LIFECYCLE_SHADOW_CLEANUP_FAILED",
      "Shipment lifecycle shadow audit cleanup failed",
      cleanupFailures,
    );
  }

  const rssAfterCleanupBytes = safeRssBytes(runtime.rssBytes(), "rss after cleanup");
  const totalFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "audit finish time");
  if (
    projected === undefined
    || setupStartedAtMs === undefined
    || setupFinishedAtMs === undefined
    || connectStartedAtMs === undefined
    || connectFinishedAtMs === undefined
    || repositoryStartedAtMs === undefined
    || repositoryFinishedAtMs === undefined
    || projectionStartedAtMs === undefined
    || projectionFinishedAtMs === undefined
    || cleanupStartedAtMs === undefined
    || cleanupFinishedAtMs === undefined
    || rssAfterLoadBytes === undefined
    || rssAfterProjectionBytes === undefined
  ) {
    throw new Error("Shipment lifecycle shadow audit completed without required evidence");
  }

  return Object.freeze({
    ...projected,
    // loadShipmentLifecycleShadowAuditBatch returns only after its
    // transaction-level role assertion succeeds.
    readOnlyRoleVerified: true,
    setupDurationMs: durationMs(setupStartedAtMs, setupFinishedAtMs, "setup duration"),
    connectDurationMs: durationMs(
      connectStartedAtMs,
      connectFinishedAtMs,
      "connect duration",
    ),
    repositoryDurationMs: durationMs(
      repositoryStartedAtMs,
      repositoryFinishedAtMs,
      "repository duration",
    ),
    projectionDurationMs: durationMs(
      projectionStartedAtMs,
      projectionFinishedAtMs,
      "projection duration",
    ),
    cleanupDurationMs: durationMs(
      cleanupStartedAtMs,
      cleanupFinishedAtMs,
      "cleanup duration",
    ),
    totalDurationMs: durationMs(totalStartedAtMs, totalFinishedAtMs, "total duration"),
    rssBeforeBytes,
    rssAfterLoadBytes,
    rssAfterProjectionBytes,
    rssAfterCleanupBytes,
    observedMaxRssBytes: Math.max(
      rssBeforeBytes,
      rssAfterLoadBytes,
      rssAfterProjectionBytes,
      rssAfterCleanupBytes,
    ),
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseShipmentLifecycleShadowAuditCliOptions(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const aggregate = await runShipmentLifecycleShadowAuditJob({
    repositoryOptions: options.repositoryOptions,
  });
  process.stdout.write(`${JSON.stringify(aggregate)}\n`);
}

function isDirectExecution(metaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  return path.resolve(argvEntry) === fileURLToPath(metaUrl);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    const errorCode = error instanceof ShipmentLifecycleShadowAuditRepositoryError
      ? error.code
      : error instanceof ShipmentLifecycleShadowAuditJobError
        ? error.code
        : "SHIPMENT_LIFECYCLE_SHADOW_AUDIT_FAILED";
    process.stderr.write(JSON.stringify({ status: "failed", errorCode }) + "\n");
    process.exitCode = 1;
  });
}
