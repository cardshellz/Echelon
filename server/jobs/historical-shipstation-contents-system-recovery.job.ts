import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { Pool, type PoolConfig } from "pg";

import { canonicalJson } from "@shared/utils/canonical-json";

import { verifiedPostgresPoolConfig } from "../infrastructure/verified-postgres-pool-config";
import {
  createHistoricalShipStationContentsClient,
  type HistoricalShipStationContentsClient,
} from "../modules/shipping/historical-shipstation-contents-audit.client";
import {
  HistoricalShipStationContentsSystemRecoveryRepositoryError,
  PgHistoricalShipStationContentsSystemRecoveryRepository,
  type PersistedHistoricalShipStationContentsSystemRecovery,
} from "../modules/shipping/historical-shipstation-contents-system-recovery.repository";
import {
  HistoricalShipStationContentsSystemRecoveryService,
  HistoricalShipStationContentsSystemRecoveryServiceError,
} from "../modules/shipping/historical-shipstation-contents-system-recovery.service";
import {
  HistoricalShipStationContentsAuditJobError,
  runHistoricalShipStationContentsAuditJob,
  type HistoricalShipStationContentsAuditJobResult,
} from "./historical-shipstation-contents-audit.job";
import { HistoricalShipStationContentsAuditRepositoryError } from "../modules/shipping/historical-shipstation-contents-audit.repository";

const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const PREVIEW_CONTRACT_VERSION = 1 as const;
const CONNECTION_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 35_000;
const LOCK_TIMEOUT_MS = 2_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 45_000;
const POOL_IDLE_TIMEOUT_MS = 10_000;

export const HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_LIMITS = Object.freeze({
  defaultCandidateLimit: 10,
  maxCandidateLimit: 25,
});

export type HistoricalShipStationContentsSystemRecoveryJobMode = "preview" | "apply";

export interface HistoricalShipStationContentsSystemRecoveryCliOptions {
  readonly help: boolean;
  readonly mode: HistoricalShipStationContentsSystemRecoveryJobMode;
  readonly candidateLimit: number;
  readonly beforeLabelId: string | null;
  readonly previewToken: string | null;
}

export type HistoricalShipStationContentsSystemRecoveryJobErrorCode =
  | "HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_CLEANUP_FAILED"
  | "HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_EXECUTION_AND_CLEANUP_FAILED"
  | "INVALID_AUDIT_REPORT"
  | "PREVIEW_TOKEN_MISMATCH";

export class HistoricalShipStationContentsSystemRecoveryJobError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsSystemRecoveryJobErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = Object.freeze({}),
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HistoricalShipStationContentsSystemRecoveryJobError";
  }
}

export type HistoricalShipStationContentsSystemRecoveryOutcome =
  | Readonly<{
      readonly kind: "would_recover";
      readonly shippingProviderLabelId: string;
      readonly previewEvidenceHash: string;
    }>
  | Readonly<{
      readonly kind: "created" | "already_persisted";
      readonly shippingProviderLabelId: string;
      readonly previewEvidenceHash: string;
      readonly labelEventId: string;
      readonly eventHash: string;
    }>
  | Readonly<{
      readonly kind: "failed";
      readonly shippingProviderLabelId: string;
      readonly previewEvidenceHash: string;
      readonly errorCode: string;
    }>;

export interface HistoricalShipStationContentsSystemRecoveryJobResult {
  readonly mode:
    | "preview_historical_shipstation_contents_system_recovery"
    | "apply_historical_shipstation_contents_system_recovery";
  readonly previewContractVersion: typeof PREVIEW_CONTRACT_VERSION;
  readonly previewToken: string;
  readonly audit: HistoricalShipStationContentsAuditJobResult;
  readonly attemptedRecoveryCount: number;
  readonly createdRecoveryCount: number;
  readonly alreadyPersistedRecoveryCount: number;
  readonly failedRecoveryCount: number;
  readonly outcomes: readonly HistoricalShipStationContentsSystemRecoveryOutcome[];
  readonly auditDurationMs: number;
  readonly recoveryDurationMs: number;
  readonly totalDurationMs: number;
}

export interface HistoricalShipStationContentsSystemRecoveryJobRuntime {
  readonly nowMs: () => number;
}

interface BoundedRecoveryPoolConfig extends PoolConfig {
  readonly lock_timeout: number;
  readonly idle_in_transaction_session_timeout: number;
}

interface RecoveryService {
  recover(
    shippingProviderLabelId: string,
    expectedPreviewEvidenceHash: string,
  ): Promise<PersistedHistoricalShipStationContentsSystemRecovery>;
}

type RecoveryPoolFactory = (config: PoolConfig) => Pool;
type RecoveryServiceFactory = (
  pool: Pool,
  providerClient: HistoricalShipStationContentsClient,
) => RecoveryService;

const DEFAULT_RUNTIME: HistoricalShipStationContentsSystemRecoveryJobRuntime = Object.freeze({
  nowMs: () => performance.now(),
});

function positiveLimit(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("--limit must be a positive integer");
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed > HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_LIMITS.maxCandidateLimit
  ) {
    throw new Error(
      `--limit must not exceed ${HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_LIMITS.maxCandidateLimit}`,
    );
  }
  return parsed;
}

function positiveBigintCursor(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > POSTGRES_BIGINT_MAX) {
    throw new Error("--before-label-id must be a positive PostgreSQL bigint");
  }
  return value;
}

function exactPreviewToken(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("--preview-token must be a lowercase SHA-256 hash");
  }
  return value;
}

export function parseHistoricalShipStationContentsSystemRecoveryCliOptions(
  argv: readonly string[],
): HistoricalShipStationContentsSystemRecoveryCliOptions {
  let help = false;
  let mode: HistoricalShipStationContentsSystemRecoveryJobMode = "preview";
  let candidateLimit: number =
    HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_LIMITS.defaultCandidateLimit;
  let beforeLabelId: string | null = null;
  let previewToken: string | null = null;
  let applySeen = false;
  let limitSeen = false;
  let beforeLabelIdSeen = false;
  let previewTokenSeen = false;

  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--apply") {
      if (applySeen) throw new Error("Duplicate flag: --apply");
      applySeen = true;
      mode = "apply";
      continue;
    }
    if (argument.startsWith("--limit=")) {
      if (limitSeen) throw new Error("Duplicate flag: --limit");
      limitSeen = true;
      candidateLimit = positiveLimit(argument.slice("--limit=".length));
      continue;
    }
    if (argument.startsWith("--before-label-id=")) {
      if (beforeLabelIdSeen) throw new Error("Duplicate flag: --before-label-id");
      beforeLabelIdSeen = true;
      beforeLabelId = positiveBigintCursor(argument.slice("--before-label-id=".length));
      continue;
    }
    if (argument.startsWith("--preview-token=")) {
      if (previewTokenSeen) throw new Error("Duplicate flag: --preview-token");
      previewTokenSeen = true;
      previewToken = exactPreviewToken(argument.slice("--preview-token=".length));
      continue;
    }
    throw new Error(`Unknown flag: ${argument.split("=")[0]}`);
  }

  if (mode === "apply" && previewToken === null) {
    throw new Error("--apply requires --preview-token from the exact preview batch");
  }
  if (mode === "preview" && previewToken !== null) {
    throw new Error("--preview-token is valid only with --apply");
  }
  return Object.freeze({ help, mode, candidateLimit, beforeLabelId, previewToken });
}

export function assertHistoricalShipStationContentsSystemRecoveryEnabled(
  environment: NodeJS.ProcessEnv,
): void {
  if (environment.HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_ENABLED !== "true") {
    throw new Error(
      "HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_ENABLED must be exactly 'true' for apply",
    );
  }
}

export function historicalShipStationContentsSystemRecoveryConnectionString(
  environment: NodeJS.ProcessEnv,
): string {
  const value = environment.HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_DATABASE_URL;
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(
      "HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_DATABASE_URL is required without surrounding whitespace",
    );
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      "HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_DATABASE_URL must be a PostgreSQL URL",
    );
  }
  return value;
}

export function historicalShipStationContentsSystemRecoveryPoolConfig(
  connectionString: string,
): PoolConfig {
  const config: BoundedRecoveryPoolConfig = {
    ...verifiedPostgresPoolConfig({
      connectionString,
      applicationName: "historical-shipstation-contents-system-recovery",
      max: 1,
    }),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
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

function validPositiveBigint(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value) && BigInt(value) <= POSTGRES_BIGINT_MAX;
}

function assertAuditReportMatchesRequest(
  audit: HistoricalShipStationContentsAuditJobResult,
  candidateLimit: number,
  beforeLabelId: string | null,
): void {
  const recoverableIds = new Set<string>();
  const reviewIds = new Set<string>();
  const recoverableEvidenceIsValid = audit.recoverableCases.every((candidate) => {
    if (recoverableIds.has(candidate.shippingProviderLabelId)) return false;
    recoverableIds.add(candidate.shippingProviderLabelId);
    return validPositiveBigint(candidate.shippingProviderLabelId)
      && /^[0-9a-f]{64}$/.test(candidate.evidenceHash);
  });
  const reviewEvidenceIsValid = audit.reviewCases.every((candidate) => {
    if (
      recoverableIds.has(candidate.shippingProviderLabelId)
      || reviewIds.has(candidate.shippingProviderLabelId)
    ) {
      return false;
    }
    reviewIds.add(candidate.shippingProviderLabelId);
    return validPositiveBigint(candidate.shippingProviderLabelId);
  });
  if (
    audit.mode !== "read_only_historical_shipstation_contents_audit"
    || audit.candidateLimit !== candidateLimit
    || audit.beforeLabelId !== beforeLabelId
    || audit.selectedCandidateCount > candidateLimit
    || audit.providerRequestCount !== audit.selectedCandidateCount
    || audit.providerShipmentFoundCount
      + audit.providerShipmentNotFoundCount
      + audit.providerRequestFailureCount !== audit.selectedCandidateCount
    || audit.recoverableProviderEvidenceCount !== audit.recoverableCases.length
    || audit.safeToAutoResolveCount !== audit.recoverableCases.length
    || audit.reviewRequiredByCurrentEvidenceCount !== audit.reviewCases.length
    || audit.requiresLeadAttestationCount !== 0
    || recoverableIds.size + reviewIds.size !== audit.selectedCandidateCount
    || !recoverableEvidenceIsValid
    || !reviewEvidenceIsValid
  ) {
    throw new HistoricalShipStationContentsSystemRecoveryJobError(
      "INVALID_AUDIT_REPORT",
      "Historical contents system recovery received an inconsistent audit report",
    );
  }
}

export function historicalShipStationContentsSystemRecoveryPreviewToken(
  audit: HistoricalShipStationContentsAuditJobResult,
): string {
  const tokenEvidence = Object.freeze({
    previewContractVersion: PREVIEW_CONTRACT_VERSION,
    candidateLimit: audit.candidateLimit,
    beforeLabelId: audit.beforeLabelId,
    nextBeforeLabelId: audit.nextBeforeLabelId,
    batchLimitReached: audit.batchLimitReached,
    selectedCandidateCount: audit.selectedCandidateCount,
    recoverableCases: audit.recoverableCases,
    reviewCases: audit.reviewCases,
  });
  return createHash("sha256").update(canonicalJson(tokenEvidence)).digest("hex");
}

function defaultPoolFactory(config: PoolConfig): Pool {
  return new Pool(config);
}

function defaultRecoveryServiceFactory(
  pool: Pool,
  providerClient: HistoricalShipStationContentsClient,
): RecoveryService {
  return new HistoricalShipStationContentsSystemRecoveryService(
    new PgHistoricalShipStationContentsSystemRecoveryRepository(pool),
    providerClient,
  );
}

function recoveryErrorCode(error: unknown): string {
  if (
    error instanceof HistoricalShipStationContentsSystemRecoveryServiceError
    || error instanceof HistoricalShipStationContentsSystemRecoveryRepositoryError
  ) {
    return error.code;
  }
  return "UNEXPECTED_RECOVERY_FAILURE";
}

async function applyRecoverableCases(options: {
  readonly audit: HistoricalShipStationContentsAuditJobResult;
  readonly poolConfig: PoolConfig;
  readonly providerClient: HistoricalShipStationContentsClient;
  readonly poolFactory: RecoveryPoolFactory;
  readonly serviceFactory: RecoveryServiceFactory;
}): Promise<readonly HistoricalShipStationContentsSystemRecoveryOutcome[]> {
  if (options.audit.recoverableCases.length === 0) return Object.freeze([]);

  let pool: Pool | undefined;
  let outcomes: readonly HistoricalShipStationContentsSystemRecoveryOutcome[] | undefined;
  let primaryFailure: unknown;
  try {
    pool = options.poolFactory(options.poolConfig);
    const service = options.serviceFactory(pool, options.providerClient);
    const mutableOutcomes: HistoricalShipStationContentsSystemRecoveryOutcome[] = [];
    for (const candidate of options.audit.recoverableCases) {
      try {
        const persisted = await service.recover(
          candidate.shippingProviderLabelId,
          candidate.evidenceHash,
        );
        mutableOutcomes.push(Object.freeze({
          kind: persisted.kind,
          shippingProviderLabelId: persisted.shippingProviderLabelId,
          previewEvidenceHash: candidate.evidenceHash,
          labelEventId: persisted.labelEventId,
          eventHash: persisted.eventHash,
        }));
      } catch (error) {
        mutableOutcomes.push(Object.freeze({
          kind: "failed",
          shippingProviderLabelId: candidate.shippingProviderLabelId,
          previewEvidenceHash: candidate.evidenceHash,
          errorCode: recoveryErrorCode(error),
        }));
      }
    }
    outcomes = Object.freeze(mutableOutcomes);
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupFailure: unknown;
  if (pool !== undefined) {
    try {
      await pool.end();
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new HistoricalShipStationContentsSystemRecoveryJobError(
      "HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_EXECUTION_AND_CLEANUP_FAILED",
      "Historical contents system recovery execution and cleanup both failed",
      Object.freeze({}),
      { cause: new AggregateError([primaryFailure, cleanupFailure]) },
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) {
    throw new HistoricalShipStationContentsSystemRecoveryJobError(
      "HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_CLEANUP_FAILED",
      "Historical contents system recovery cleanup failed",
      Object.freeze({}),
      { cause: cleanupFailure },
    );
  }
  if (outcomes === undefined) {
    throw new Error("Historical contents system recovery completed without outcomes");
  }
  return outcomes;
}

export async function runHistoricalShipStationContentsSystemRecoveryJob(options: {
  readonly mode?: HistoricalShipStationContentsSystemRecoveryJobMode;
  readonly candidateLimit?: number;
  readonly beforeLabelId?: string;
  readonly previewToken?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly providerClient?: HistoricalShipStationContentsClient;
  readonly auditJob?: typeof runHistoricalShipStationContentsAuditJob;
  readonly poolFactory?: RecoveryPoolFactory;
  readonly serviceFactory?: RecoveryServiceFactory;
  readonly runtime?: HistoricalShipStationContentsSystemRecoveryJobRuntime;
} = {}): Promise<HistoricalShipStationContentsSystemRecoveryJobResult> {
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const totalStartedAtMs = safeRuntimeValue(runtime.nowMs(), "recovery job start time");
  const environment = options.environment ?? process.env;
  const mode = options.mode ?? "preview";
  const candidateLimit = options.candidateLimit
    ?? HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_LIMITS.defaultCandidateLimit;
  const beforeLabelId = options.beforeLabelId ?? null;
  positiveLimit(String(candidateLimit));
  if (beforeLabelId !== null) positiveBigintCursor(beforeLabelId);

  let poolConfig: PoolConfig | null = null;
  let expectedPreviewToken: string | null = null;
  if (mode === "apply") {
    assertHistoricalShipStationContentsSystemRecoveryEnabled(environment);
    expectedPreviewToken = exactPreviewToken(options.previewToken ?? "");
    poolConfig = historicalShipStationContentsSystemRecoveryPoolConfig(
      historicalShipStationContentsSystemRecoveryConnectionString(environment),
    );
  } else if (mode !== "preview") {
    throw new Error("Historical contents system recovery mode is invalid");
  } else if (options.previewToken !== undefined) {
    throw new Error("Historical contents system recovery preview mode cannot accept a preview token");
  }

  const providerClient = options.providerClient ?? createHistoricalShipStationContentsClient({
    apiKey: environment.SHIPSTATION_API_KEY,
    apiSecret: environment.SHIPSTATION_API_SECRET,
  });
  const auditStartedAtMs = safeRuntimeValue(runtime.nowMs(), "recovery audit start time");
  const audit = await (options.auditJob ?? runHistoricalShipStationContentsAuditJob)({
    candidateLimit,
    beforeLabelId: beforeLabelId ?? undefined,
    environment,
    providerClient,
  });
  const auditFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "recovery audit finish time");
  assertAuditReportMatchesRequest(audit, candidateLimit, beforeLabelId);
  const currentPreviewToken = historicalShipStationContentsSystemRecoveryPreviewToken(audit);

  if (mode === "apply" && currentPreviewToken !== expectedPreviewToken) {
    throw new HistoricalShipStationContentsSystemRecoveryJobError(
      "PREVIEW_TOKEN_MISMATCH",
      "Historical contents changed after preview; no recovery writes were attempted",
      Object.freeze({ currentPreviewToken }),
    );
  }

  const recoveryStartedAtMs = safeRuntimeValue(runtime.nowMs(), "recovery apply start time");
  const outcomes = mode === "preview"
    ? Object.freeze(audit.recoverableCases.map((candidate) => Object.freeze({
        kind: "would_recover" as const,
        shippingProviderLabelId: candidate.shippingProviderLabelId,
        previewEvidenceHash: candidate.evidenceHash,
      })))
    : await applyRecoverableCases({
        audit,
        poolConfig: poolConfig!,
        providerClient,
        poolFactory: options.poolFactory ?? defaultPoolFactory,
        serviceFactory: options.serviceFactory ?? defaultRecoveryServiceFactory,
      });
  const recoveryFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "recovery apply finish time");
  const totalFinishedAtMs = safeRuntimeValue(runtime.nowMs(), "recovery job finish time");
  const createdRecoveryCount = outcomes.filter((outcome) => outcome.kind === "created").length;
  const alreadyPersistedRecoveryCount = outcomes.filter(
    (outcome) => outcome.kind === "already_persisted",
  ).length;
  const failedRecoveryCount = outcomes.filter((outcome) => outcome.kind === "failed").length;

  return Object.freeze({
    mode: mode === "preview"
      ? "preview_historical_shipstation_contents_system_recovery"
      : "apply_historical_shipstation_contents_system_recovery",
    previewContractVersion: PREVIEW_CONTRACT_VERSION,
    previewToken: currentPreviewToken,
    audit,
    attemptedRecoveryCount: mode === "apply" ? outcomes.length : 0,
    createdRecoveryCount,
    alreadyPersistedRecoveryCount,
    failedRecoveryCount,
    outcomes,
    auditDurationMs: durationMs(auditStartedAtMs, auditFinishedAtMs, "audit duration"),
    recoveryDurationMs: durationMs(
      recoveryStartedAtMs,
      recoveryFinishedAtMs,
      "recovery duration",
    ),
    totalDurationMs: durationMs(totalStartedAtMs, totalFinishedAtMs, "total duration"),
  });
}

function usage(): string {
  return [
    "Usage:",
    "  npm run wms:recover-historical-shipstation-contents -- [--limit=N] [--before-label-id=ID]",
    "  npm run wms:recover-historical-shipstation-contents -- --apply --preview-token=HASH [--limit=N] [--before-label-id=ID]",
    "",
    "Default mode is a bounded read-only preview. Apply re-runs the exact page and refuses",
    "all writes unless its cryptographic preview token still matches. Apply also requires",
    "HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_ENABLED=true and the dedicated",
    "HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_DATABASE_URL.",
    "",
    "The command prints bounded internal label/event IDs and evidence hashes only. It never",
    "prints provider shipment IDs, tracking numbers, SKUs, quantities, or raw payloads.",
  ].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cli = parseHistoricalShipStationContentsSystemRecoveryCliOptions(argv);
  if (cli.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runHistoricalShipStationContentsSystemRecoveryJob({
    mode: cli.mode,
    candidateLimit: cli.candidateLimit,
    beforeLabelId: cli.beforeLabelId ?? undefined,
    previewToken: cli.previewToken ?? undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failedRecoveryCount > 0) process.exitCode = 1;
}

function isDirectExecution(metaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  return path.resolve(argvEntry) === fileURLToPath(metaUrl);
}

function topLevelErrorCode(error: unknown): string {
  if (
    error instanceof HistoricalShipStationContentsSystemRecoveryJobError
    || error instanceof HistoricalShipStationContentsSystemRecoveryServiceError
    || error instanceof HistoricalShipStationContentsSystemRecoveryRepositoryError
    || error instanceof HistoricalShipStationContentsAuditJobError
    || error instanceof HistoricalShipStationContentsAuditRepositoryError
  ) {
    return error.code;
  }
  return "HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_FAILED";
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(JSON.stringify({
      status: "failed",
      errorCode: topLevelErrorCode(error),
    }) + "\n");
    process.exitCode = 1;
  });
}
