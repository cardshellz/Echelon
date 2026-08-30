import type { Pool, PoolClient } from "pg";

import { canonicalJson } from "@shared/utils/canonical-json";

import {
  HistoricalShipStationContentsAuditRepositoryError,
  loadHistoricalShipStationExpectedContents,
} from "./historical-shipstation-contents-audit.repository";
import type {
  HistoricalShipStationContentsRecoveryLabelStatus,
  HistoricalShipStationContentsSystemRecoveryEvent,
  HistoricalShipStationExpectedContentsEvidence,
} from "./historical-shipstation-contents-recovery.domain";

const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const MAX_RESOLVED_EVENTS = 500;

type QueryResult = Readonly<{ readonly rows: readonly Record<string, unknown>[] }>;
type QueryClient = Readonly<{
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}>;

export type HistoricalShipStationContentsSystemRecoveryRepositoryErrorCode =
  | "CONCURRENT_WRITE"
  | "DATABASE_ERROR"
  | "INVALID_DATABASE_EVIDENCE"
  | "RECOVERY_CONFLICT"
  | "TRANSACTION_CLEANUP_FAILED";

export class HistoricalShipStationContentsSystemRecoveryRepositoryError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsSystemRecoveryRepositoryErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = Object.freeze({}),
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HistoricalShipStationContentsSystemRecoveryRepositoryError";
  }
}

export interface HistoricalShipStationContentsSystemRecoveryCandidate {
  readonly shippingProviderLabelId: string;
  readonly providerShipmentId: number;
  readonly trackingNumber: string;
  readonly labelStatus: HistoricalShipStationContentsRecoveryLabelStatus;
  readonly expectedContents: HistoricalShipStationExpectedContentsEvidence;
}

export interface PersistedHistoricalShipStationContentsSystemRecovery {
  readonly kind: "created" | "already_persisted";
  readonly shippingProviderLabelId: string;
  readonly labelEventId: string;
  readonly eventHash: string;
}

export interface HistoricalShipStationContentsSystemRecoverySnapshot {
  readonly candidate: HistoricalShipStationContentsSystemRecoveryCandidate;
}

export interface HistoricalShipStationContentsSystemRecoveryTransaction {
  loadCandidateForUpdate(
    shippingProviderLabelId: string,
  ): Promise<HistoricalShipStationContentsSystemRecoveryCandidate | null>;
  loadResolvableLabelEventIds(shippingProviderLabelId: string): Promise<readonly number[]>;
  appendExactRecovery(
    shippingProviderLabelId: string,
    event: HistoricalShipStationContentsSystemRecoveryEvent,
  ): Promise<PersistedHistoricalShipStationContentsSystemRecovery>;
}

export interface HistoricalShipStationContentsSystemRecoveryRepository {
  loadSnapshot(
    shippingProviderLabelId: string,
  ): Promise<HistoricalShipStationContentsSystemRecoverySnapshot | null>;
  withSerializableTransaction<T>(
    work: (transaction: HistoricalShipStationContentsSystemRecoveryTransaction) => Promise<T>,
  ): Promise<T>;
}

function postgresMetadata(error: unknown): Readonly<{
  code: string | null;
  constraint: string | null;
}> {
  if (error === null || typeof error !== "object") {
    return { code: null, constraint: null };
  }
  const candidate = error as { readonly code?: unknown; readonly constraint?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : null,
    constraint: typeof candidate.constraint === "string" ? candidate.constraint : null,
  };
}

function classifyDatabaseError(
  error: unknown,
): HistoricalShipStationContentsSystemRecoveryRepositoryError {
  if (error instanceof HistoricalShipStationContentsSystemRecoveryRepositoryError) return error;
  if (error instanceof HistoricalShipStationContentsAuditRepositoryError) {
    return new HistoricalShipStationContentsSystemRecoveryRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents system recovery received invalid WMS lineage evidence",
      Object.freeze({ sourceCode: error.code }),
      { cause: error },
    );
  }
  const metadata = postgresMetadata(error);
  if (["40001", "40P01", "55P03"].includes(metadata.code ?? "")) {
    return new HistoricalShipStationContentsSystemRecoveryRepositoryError(
      "CONCURRENT_WRITE",
      "Historical contents system recovery encountered a concurrent database write",
      Object.freeze({ postgresCode: metadata.code }),
      { cause: error },
    );
  }
  if (metadata.code === "23505") {
    return new HistoricalShipStationContentsSystemRecoveryRepositoryError(
      "RECOVERY_CONFLICT",
      "A different system recovery already exists for this shipping label",
      Object.freeze({ constraint: metadata.constraint }),
      { cause: error },
    );
  }
  return new HistoricalShipStationContentsSystemRecoveryRepositoryError(
    "DATABASE_ERROR",
    "Historical contents system recovery database operation failed",
    Object.freeze({ postgresCode: metadata.code, constraint: metadata.constraint }),
    { cause: error },
  );
}

function positiveBigintText(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[1-9][0-9]*$/.test(value)
    || BigInt(value) > POSTGRES_BIGINT_MAX
  ) {
    throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents system recovery received invalid ${field}`,
    );
  }
  return value;
}

function positiveSafeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents system recovery received invalid ${field}`,
    );
  }
  return parsed;
}

function exactBoundedText(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
  ) {
    throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents system recovery received invalid ${field}`,
    );
  }
  return value;
}

function labelStatus(value: unknown): HistoricalShipStationContentsRecoveryLabelStatus {
  if (value !== "active" && value !== "voided" && value !== "superseded" && value !== "unknown") {
    throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents system recovery received an invalid label status",
    );
  }
  return value;
}

function canonicalEquals(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function loadCandidate(
  client: QueryClient,
  shippingProviderLabelId: string,
  lockRow: boolean,
): Promise<HistoricalShipStationContentsSystemRecoveryCandidate | null> {
  const validatedLabelId = positiveBigintText(
    shippingProviderLabelId,
    "shipping_provider_label_id",
  );
  let result: QueryResult;
  try {
    result = await client.query(
      `SELECT
         label.id::text AS shipping_provider_label_id,
         label.provider_label_id,
         label.tracking_number,
         label.label_status
       FROM wms.shipping_provider_labels AS label
       WHERE label.id = $1::bigint
         AND label.provider = 'shipstation'
         AND label.label_direction = 'outbound'
         AND label.provider_label_id ~ '^[1-9][0-9]*$'
         AND EXISTS (
           SELECT 1
           FROM wms.shipping_provider_label_events AS historical_event
           WHERE historical_event.shipping_provider_label_id = label.id
             AND historical_event.event_type IN ('label_observed', 'label_voided')
             AND (
               NOT (historical_event.sanitized_payload ? 'payloadSchemaVersion')
               OR historical_event.sanitized_payload->>'payloadSchemaVersion' = '1'
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM wms.shipping_provider_label_events AS current_event
           WHERE current_event.shipping_provider_label_id = label.id
             AND current_event.event_type <> 'contents_recovered'
             AND current_event.sanitized_payload->>'payloadSchemaVersion' = '2'
             AND current_event.sanitized_payload->'declaredContentsEvidence'->>'status'
               = 'authoritative'
         )
       ${lockRow ? "FOR UPDATE" : ""}`,
      [validatedLabelId],
    );
  } catch (error) {
    throw classifyDatabaseError(error);
  }
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents system recovery candidate identity is duplicated",
    );
  }
  const row = result.rows[0];
  const labelId = positiveBigintText(row.shipping_provider_label_id, "shipping_provider_label_id");
  const providerLabelId = exactBoundedText(row.provider_label_id, "provider_label_id", 200);
  if (!/^[1-9][0-9]*$/.test(providerLabelId)) {
    throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents system recovery provider shipment identity is invalid",
    );
  }
  const providerShipmentId = positiveSafeInteger(providerLabelId, "provider_shipment_id");
  let expectedContents: HistoricalShipStationExpectedContentsEvidence;
  try {
    expectedContents = await loadHistoricalShipStationExpectedContents(
      client as unknown as Pick<PoolClient, "query">,
      labelId,
    );
  } catch (error) {
    throw classifyDatabaseError(error);
  }
  return Object.freeze({
    shippingProviderLabelId: labelId,
    providerShipmentId,
    trackingNumber: exactBoundedText(row.tracking_number, "tracking_number", 200),
    labelStatus: labelStatus(row.label_status),
    expectedContents,
  });
}

class PgHistoricalShipStationContentsSystemRecoveryTransaction
implements HistoricalShipStationContentsSystemRecoveryTransaction {
  constructor(private readonly client: QueryClient) {}

  private async query(text: string, values: unknown[] = []): Promise<QueryResult> {
    try {
      return await this.client.query(text, values);
    } catch (error) {
      throw classifyDatabaseError(error);
    }
  }

  loadCandidateForUpdate(
    shippingProviderLabelId: string,
  ): Promise<HistoricalShipStationContentsSystemRecoveryCandidate | null> {
    return loadCandidate(this.client, shippingProviderLabelId, true);
  }

  async loadResolvableLabelEventIds(
    shippingProviderLabelId: string,
  ): Promise<readonly number[]> {
    const result = await this.query(
      `SELECT event.id::text AS label_event_id
       FROM wms.shipping_provider_label_events AS event
       WHERE event.shipping_provider_label_id = $1::bigint
         AND event.event_type IN ('label_observed', 'label_voided')
         AND (
           NOT (event.sanitized_payload ? 'payloadSchemaVersion')
           OR event.sanitized_payload->>'payloadSchemaVersion' = '1'
           OR (
             event.sanitized_payload->>'payloadSchemaVersion' = '2'
             AND event.sanitized_payload->'declaredContentsEvidence'->>'status'
               IS DISTINCT FROM 'authoritative'
           )
         )
       ORDER BY event.id
       LIMIT $2::integer
       FOR KEY SHARE`,
      [shippingProviderLabelId, MAX_RESOLVED_EVENTS + 1],
    );
    if (result.rows.length > MAX_RESOLVED_EVENTS) {
      throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical contents system recovery resolution set exceeds its safety bound",
        Object.freeze({ maxResolvedEvents: MAX_RESOLVED_EVENTS }),
      );
    }
    const ids = result.rows.map((row) => positiveSafeInteger(
      positiveBigintText(row.label_event_id, "label_event_id"),
      "label_event_id",
    ));
    if (new Set(ids).size !== ids.length) {
      throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical contents system recovery received duplicate resolution evidence",
      );
    }
    return Object.freeze(ids);
  }

  async appendExactRecovery(
    shippingProviderLabelId: string,
    event: HistoricalShipStationContentsSystemRecoveryEvent,
  ): Promise<PersistedHistoricalShipStationContentsSystemRecovery> {
    const inserted = await this.query(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id,
         event_hash,
         event_type,
         label_status,
         tracking_number,
         provider_occurred_at,
         sanitized_payload,
         received_at
       ) VALUES ($1::bigint, $2, $3, $4, $5, $6, $7::jsonb, transaction_timestamp())
       ON CONFLICT (shipping_provider_label_id, event_hash) DO NOTHING
       RETURNING id::text AS label_event_id`,
      [
        shippingProviderLabelId,
        event.eventHash,
        event.eventType,
        event.labelStatus,
        event.trackingNumber,
        event.providerOccurredAt,
        JSON.stringify(event.sanitizedPayload),
      ],
    );
    if (inserted.rows.length === 1) {
      return Object.freeze({
        kind: "created",
        shippingProviderLabelId,
        labelEventId: positiveBigintText(inserted.rows[0].label_event_id, "label_event_id"),
        eventHash: event.eventHash,
      });
    }
    if (inserted.rows.length !== 0) {
      throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical contents system recovery insert returned an invalid row count",
      );
    }

    const existing = await this.query(
      `SELECT
         id::text AS label_event_id,
         event_type,
         label_status,
         tracking_number,
         provider_occurred_at,
         sanitized_payload
       FROM wms.shipping_provider_label_events
       WHERE shipping_provider_label_id = $1::bigint
         AND event_hash = $2
       FOR KEY SHARE`,
      [shippingProviderLabelId, event.eventHash],
    );
    if (existing.rows.length !== 1) {
      throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical contents system recovery replay row is missing or duplicated",
      );
    }
    const row = existing.rows[0];
    if (
      row.event_type !== event.eventType
      || row.label_status !== event.labelStatus
      || row.tracking_number !== event.trackingNumber
      || row.provider_occurred_at !== event.providerOccurredAt
      || !canonicalEquals(row.sanitized_payload, event.sanitizedPayload)
    ) {
      throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
        "RECOVERY_CONFLICT",
        "Historical contents system recovery hash is attached to different evidence",
      );
    }
    return Object.freeze({
      kind: "already_persisted",
      shippingProviderLabelId,
      labelEventId: positiveBigintText(row.label_event_id, "label_event_id"),
      eventHash: event.eventHash,
    });
  }
}

export class PgHistoricalShipStationContentsSystemRecoveryRepository
implements HistoricalShipStationContentsSystemRecoveryRepository {
  constructor(private readonly pool: Pool) {}

  async loadSnapshot(
    shippingProviderLabelId: string,
  ): Promise<HistoricalShipStationContentsSystemRecoverySnapshot | null> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw classifyDatabaseError(error);
    }
    let snapshot: HistoricalShipStationContentsSystemRecoverySnapshot | null = null;
    let primaryFailure: unknown;
    let rollbackFailure: unknown;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const queryClient = client as unknown as QueryClient;
      const candidate = await loadCandidate(queryClient, shippingProviderLabelId, false);
      snapshot = candidate === null
        ? null
        : Object.freeze({ candidate });
      await client.query("COMMIT");
    } catch (error) {
      primaryFailure = error;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        rollbackFailure = rollbackError;
      }
    }
    const releaseFailure = releaseClient(client, rollbackFailure ?? primaryFailure);
    throwCleanupFailureIfPresent(
      "Historical contents system recovery snapshot cleanup failed",
      primaryFailure,
      rollbackFailure,
      releaseFailure,
    );
    if (primaryFailure !== undefined) throw classifyDatabaseError(primaryFailure);
    return snapshot;
  }

  async withSerializableTransaction<T>(
    work: (transaction: HistoricalShipStationContentsSystemRecoveryTransaction) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw classifyDatabaseError(error);
    }
    let value: T | undefined;
    let primaryFailure: unknown;
    let rollbackFailure: unknown;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      value = await work(new PgHistoricalShipStationContentsSystemRecoveryTransaction(
        client as unknown as QueryClient,
      ));
      await client.query("COMMIT");
    } catch (error) {
      primaryFailure = error;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        rollbackFailure = rollbackError;
      }
    }
    const releaseFailure = releaseClient(client, rollbackFailure ?? primaryFailure);
    throwCleanupFailureIfPresent(
      "Historical contents system recovery transaction cleanup failed",
      primaryFailure,
      rollbackFailure,
      releaseFailure,
    );
    if (primaryFailure !== undefined) {
      if (primaryFailure instanceof HistoricalShipStationContentsSystemRecoveryRepositoryError) {
        throw primaryFailure;
      }
      if (postgresMetadata(primaryFailure).code !== null) {
        throw classifyDatabaseError(primaryFailure);
      }
      throw primaryFailure;
    }
    if (value === undefined) {
      throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical contents system recovery transaction completed without a result",
      );
    }
    return value;
  }
}

function releaseClient(client: PoolClient, failure: unknown): unknown {
  try {
    client.release(failure instanceof Error ? failure : undefined);
    return undefined;
  } catch (error) {
    return error;
  }
}

function throwCleanupFailureIfPresent(
  message: string,
  primaryFailure: unknown,
  rollbackFailure: unknown,
  releaseFailure: unknown,
): void {
  const cleanupFailures = [rollbackFailure, releaseFailure]
    .filter((failure): failure is {} => failure !== undefined);
  if (cleanupFailures.length === 0) return;
  const failures = [primaryFailure, ...cleanupFailures]
    .filter((failure): failure is {} => failure !== undefined);
  throw new HistoricalShipStationContentsSystemRecoveryRepositoryError(
    "TRANSACTION_CLEANUP_FAILED",
    message,
    Object.freeze({}),
    { cause: failures.length === 1 ? failures[0] : new AggregateError(failures) },
  );
}
