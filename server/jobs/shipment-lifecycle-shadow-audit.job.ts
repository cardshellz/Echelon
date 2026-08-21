import path from "node:path";
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
  ShipmentLifecycleShadowAuditRepositoryError,
  loadShipmentLifecycleShadowAuditBatch,
  type ShipmentLifecycleShadowAuditBatch,
  type ShipmentLifecycleShadowAuditRepositoryOptions,
} from "../modules/shipping/shipment-lifecycle-shadow-audit.repository";

interface ShadowAuditPoolClient extends Pick<PoolClient, "query" | "release"> {}

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
  readonly labelEventCount: number;
  readonly currentConfirmedCarrierEvidenceCount: number;
}

export interface VerifiedShipmentLifecycleShadowAuditAggregate
  extends ShipmentLifecycleShadowAuditAggregate {
  readonly readOnlyRoleVerified: true;
}

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
    labelEventCount: batch.labelEvents.length,
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
): PoolConfig {
  return verifiedPostgresPoolConfig({
    connectionString,
    applicationName: "shipment-lifecycle-read-only-shadow",
    max: 1,
  });
}

export async function runShipmentLifecycleShadowAuditJob(options: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly repositoryOptions?: ShipmentLifecycleShadowAuditRepositoryOptions;
  readonly poolFactory?: ShadowAuditPoolFactory;
} = {}): Promise<VerifiedShipmentLifecycleShadowAuditAggregate> {
  const environment = options.environment ?? process.env;
  assertShipmentLifecycleShadowEnabled(environment);
  const connectionString = shipmentLifecycleShadowAuditConnectionString(environment);
  const poolFactory = options.poolFactory ?? defaultPoolFactory;
  const pool = poolFactory(shipmentLifecycleShadowAuditPoolConfig(connectionString));

  let client: ShadowAuditPoolClient | null = null;
  try {
    client = await pool.connect();
    const batch = await loadShipmentLifecycleShadowAuditBatch(
      client as Pick<PoolClient, "query">,
      options.repositoryOptions,
    );
    return Object.freeze({
      ...summarizeShipmentLifecycleShadowAuditBatch(batch),
      // loadShipmentLifecycleShadowAuditBatch returns only after its
      // transaction-level role assertion succeeds.
      readOnlyRoleVerified: true,
    });
  } finally {
    try {
      client?.release();
    } finally {
      await pool.end();
    }
  }
}

export async function main(): Promise<void> {
  const aggregate = await runShipmentLifecycleShadowAuditJob();
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
      : "SHIPMENT_LIFECYCLE_SHADOW_AUDIT_FAILED";
    process.stderr.write(JSON.stringify({ status: "failed", errorCode }) + "\n");
    process.exitCode = 1;
  });
}
