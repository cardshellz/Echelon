import type { PoolClient } from "pg";

import { assertShipmentLifecycleShadowRoleIsReadOnly } from "./shipment-lifecycle-shadow-audit.repository";

type QueryClient = Pick<PoolClient, "query">;

const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");

export const HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_LIMITS = Object.freeze({
  defaultCandidateLimit: 25,
  maxCandidateLimit: 100,
  defaultStatementTimeoutMs: 30_000,
  maxStatementTimeoutMs: 120_000,
  defaultLockTimeoutMs: 2_000,
  maxLockTimeoutMs: 10_000,
  defaultIdleInTransactionTimeoutMs: 45_000,
  maxIdleInTransactionTimeoutMs: 300_000,
});

export const HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL = `
  SELECT
    label.id::text AS shipping_provider_label_id,
    label.provider_label_id
  FROM wms.shipping_provider_labels AS label
  WHERE label.provider = 'shipstation'
    AND label.label_direction = 'outbound'
    AND label.provider_label_id ~ '^[1-9][0-9]*$'
    AND EXISTS (
      SELECT 1
      FROM wms.shipping_provider_label_events AS historical_event
      WHERE historical_event.shipping_provider_label_id = label.id
        AND (
          NOT (historical_event.sanitized_payload ? 'payloadSchemaVersion')
          OR historical_event.sanitized_payload->>'payloadSchemaVersion' = '1'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM wms.shipping_provider_label_events AS current_event
      WHERE current_event.shipping_provider_label_id = label.id
        AND current_event.sanitized_payload->>'payloadSchemaVersion' = '2'
        AND current_event.sanitized_payload->'declaredContentsEvidence'->>'status'
          = 'authoritative'
    )
  ORDER BY label.id DESC
  LIMIT $1
`;

export interface HistoricalShipStationContentsAuditRepositoryOptions {
  readonly candidateLimit?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
}

export interface NormalizedHistoricalShipStationContentsAuditRepositoryOptions {
  readonly candidateLimit: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
}

export interface HistoricalShipStationContentsCandidate {
  readonly shippingProviderLabelId: string;
  readonly providerShipmentId: number;
}

export interface HistoricalShipStationContentsCandidateBatch {
  readonly candidateLimit: number;
  readonly batchLimitReached: boolean;
  readonly databaseTemporaryPrivilege: boolean;
  readonly candidates: readonly HistoricalShipStationContentsCandidate[];
}

export type HistoricalShipStationContentsAuditRepositoryErrorCode =
  | "INVALID_DATABASE_EVIDENCE"
  | "ROLLBACK_FAILED";

export class HistoricalShipStationContentsAuditRepositoryError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsAuditRepositoryErrorCode,
    message: string,
    readonly context: Readonly<Record<string, number | boolean>> = Object.freeze({}),
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HistoricalShipStationContentsAuditRepositoryError";
  }
}

function boundedPositiveInteger(
  value: number,
  field: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export function normalizeHistoricalShipStationContentsAuditRepositoryOptions(
  options: HistoricalShipStationContentsAuditRepositoryOptions = {},
): NormalizedHistoricalShipStationContentsAuditRepositoryOptions {
  const limits = HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_LIMITS;
  return Object.freeze({
    candidateLimit: boundedPositiveInteger(
      options.candidateLimit ?? limits.defaultCandidateLimit,
      "candidateLimit",
      limits.maxCandidateLimit,
    ),
    statementTimeoutMs: boundedPositiveInteger(
      options.statementTimeoutMs ?? limits.defaultStatementTimeoutMs,
      "statementTimeoutMs",
      limits.maxStatementTimeoutMs,
    ),
    lockTimeoutMs: boundedPositiveInteger(
      options.lockTimeoutMs ?? limits.defaultLockTimeoutMs,
      "lockTimeoutMs",
      limits.maxLockTimeoutMs,
    ),
    idleInTransactionTimeoutMs: boundedPositiveInteger(
      options.idleInTransactionTimeoutMs ?? limits.defaultIdleInTransactionTimeoutMs,
      "idleInTransactionTimeoutMs",
      limits.maxIdleInTransactionTimeoutMs,
    ),
  });
}

function positiveBigintString(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new HistoricalShipStationContentsAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a positive PostgreSQL bigint`,
    );
  }
  if (BigInt(value) > POSTGRES_BIGINT_MAX) {
    throw new HistoricalShipStationContentsAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} exceeds the PostgreSQL bigint range`,
    );
  }
  return value;
}

function positiveProviderShipmentId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new HistoricalShipStationContentsAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "provider_label_id must be a positive decimal ShipStation shipment id",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HistoricalShipStationContentsAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "provider_label_id exceeds the JavaScript safe-integer range",
    );
  }
  return parsed;
}

function mapCandidate(row: Record<string, unknown>): HistoricalShipStationContentsCandidate {
  return Object.freeze({
    shippingProviderLabelId: positiveBigintString(
      row.shipping_provider_label_id,
      "shipping_provider_label_id",
    ),
    providerShipmentId: positiveProviderShipmentId(row.provider_label_id),
  });
}

async function loadInsideTransaction(
  client: QueryClient,
  input: NormalizedHistoricalShipStationContentsAuditRepositoryOptions,
): Promise<HistoricalShipStationContentsCandidateBatch> {
  await client.query("SELECT set_config('statement_timeout', $1, true)", [
    `${input.statementTimeoutMs}ms`,
  ]);
  await client.query("SELECT set_config('lock_timeout', $1, true)", [
    `${input.lockTimeoutMs}ms`,
  ]);
  await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
    `${input.idleInTransactionTimeoutMs}ms`,
  ]);
  const roleEvidence = await assertShipmentLifecycleShadowRoleIsReadOnly(client);
  const result = await client.query(
    HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL,
    [input.candidateLimit + 1],
  );
  const mapped = (result.rows as Record<string, unknown>[]).map(mapCandidate);
  const seenLabelIds = new Set<string>();
  const seenProviderIds = new Set<number>();
  for (const candidate of mapped) {
    if (
      seenLabelIds.has(candidate.shippingProviderLabelId)
      || seenProviderIds.has(candidate.providerShipmentId)
    ) {
      throw new HistoricalShipStationContentsAuditRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical ShipStation contents audit received duplicate candidate identity",
      );
    }
    seenLabelIds.add(candidate.shippingProviderLabelId);
    seenProviderIds.add(candidate.providerShipmentId);
  }
  return Object.freeze({
    candidateLimit: input.candidateLimit,
    batchLimitReached: mapped.length > input.candidateLimit,
    databaseTemporaryPrivilege: roleEvidence.databaseTemporaryPrivilege,
    candidates: Object.freeze(mapped.slice(0, input.candidateLimit)),
  });
}

export async function loadHistoricalShipStationContentsCandidates(
  client: QueryClient,
  options: HistoricalShipStationContentsAuditRepositoryOptions = {},
): Promise<HistoricalShipStationContentsCandidateBatch> {
  const input = normalizeHistoricalShipStationContentsAuditRepositoryOptions(options);
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

  let batch: HistoricalShipStationContentsCandidateBatch | undefined;
  let primaryFailure: unknown;
  try {
    batch = await loadInsideTransaction(client, input);
  } catch (error) {
    primaryFailure = error;
  }

  let rollbackFailure: unknown;
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    rollbackFailure = error;
  }

  if (primaryFailure !== undefined && rollbackFailure !== undefined) {
    throw new HistoricalShipStationContentsAuditRepositoryError(
      "ROLLBACK_FAILED",
      "Historical ShipStation contents read and rollback both failed",
      Object.freeze({}),
      { cause: new AggregateError([primaryFailure, rollbackFailure]) },
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (rollbackFailure !== undefined) {
    throw new HistoricalShipStationContentsAuditRepositoryError(
      "ROLLBACK_FAILED",
      "Historical ShipStation contents rollback failed",
      Object.freeze({}),
      { cause: rollbackFailure },
    );
  }
  if (!batch) {
    throw new HistoricalShipStationContentsAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical ShipStation contents candidate read completed without a result",
    );
  }
  return batch;
}
