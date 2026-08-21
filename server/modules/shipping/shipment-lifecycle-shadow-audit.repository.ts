import type { PoolClient } from "pg";

type QueryClient = Pick<PoolClient, "query">;

const DEFAULT_LABEL_LIMIT = 1_000;
const MAX_LABEL_LIMIT = 5_000;
const DEFAULT_MAX_EVENTS_PER_LABEL = 50;
const MAX_EVENTS_PER_LABEL = 500;
const DEFAULT_MAX_CURRENT_MATCHES = 50_000;
const MAX_CURRENT_MATCHES = 100_000;
/**
 * Application relations requiring explicit SELECT grants. The role assertion's
 * pg_catalog reads use PostgreSQL's built-in catalog visibility and are not grant targets.
 */

export const SHIPMENT_LIFECYCLE_SHADOW_REQUIRED_RELATIONS: readonly string[] = Object.freeze([
  "wms.carrier_tracking_event_matches",
  "wms.carrier_tracking_events",
  "wms.carrier_tracking_reconciliation_state",
  "wms.shipping_provider_label_events",
  "wms.shipping_provider_labels",
]);
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 45_000;

export const SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL = `
  WITH user_tables AS (
    SELECT format('%I.%I', namespace.nspname, relation.relname) AS qualified_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE relation.relkind IN ('r', 'p')
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
  ),
  user_sequences AS (
    SELECT format('%I.%I', namespace.nspname, relation.relname) AS qualified_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE relation.relkind = 'S'
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
  ),
  user_schemas AS (
    SELECT namespace.nspname AS schema_name
    FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
  )
  SELECT
    current_setting('transaction_read_only') AS transaction_read_only,
    COALESCE((
      SELECT COUNT(*)
      FROM user_tables
      WHERE has_table_privilege(
        current_user,
        qualified_name,
        'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'
      )
    ), 0)::text AS mutable_table_count,
    COALESCE((
      SELECT COUNT(*)
      FROM user_sequences
      WHERE has_sequence_privilege(current_user, qualified_name, 'UPDATE')
    ), 0)::text AS mutable_sequence_count,
    COALESCE((
      SELECT COUNT(*)
      FROM user_sequences
      WHERE has_sequence_privilege(current_user, qualified_name, 'USAGE')
    ), 0)::text AS sequence_usage_count,
    COALESCE((
      SELECT COUNT(*)
      FROM user_schemas
      WHERE has_schema_privilege(current_user, schema_name, 'CREATE')
    ), 0)::text AS mutable_schema_count,
    has_database_privilege(current_user, current_database(), 'CREATE') AS mutable_database,
    role.rolsuper
      OR role.rolcreaterole
      OR role.rolcreatedb
      OR role.rolreplication
      OR role.rolbypassrls AS elevated_role
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = current_user
`;

export const SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL = `
  SELECT
    label.id::text AS shipping_provider_label_id,
    label.provider,
    label.provider_label_id,
    label.tracking_number,
    label.label_status,
    label.label_direction,
    label.first_observed_at,
    label.last_observed_at,
    COUNT(event.id)::text AS label_event_count
  FROM wms.shipping_provider_labels AS label
  LEFT JOIN wms.shipping_provider_label_events AS event
    ON event.shipping_provider_label_id = label.id
  WHERE label.provider = 'shipstation'
  GROUP BY
    label.id,
    label.provider,
    label.provider_label_id,
    label.tracking_number,
    label.label_status,
    label.label_direction,
    label.first_observed_at,
    label.last_observed_at
  ORDER BY label.last_observed_at DESC, label.id DESC
  LIMIT $1
`;

export const SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL = `
  SELECT
    event.id::text AS label_event_id,
    event.shipping_provider_label_id::text AS shipping_provider_label_id,
    event.event_hash,
    event.event_type,
    event.label_status,
    event.tracking_number,
    event.provider_occurred_at,
    event.received_at,
    event.sanitized_payload
  FROM wms.shipping_provider_label_events AS event
  WHERE event.shipping_provider_label_id = ANY($1::bigint[])
  ORDER BY
    event.shipping_provider_label_id,
    event.received_at,
    event.id
  LIMIT $2
`;

export const SHIPMENT_LIFECYCLE_SHADOW_CURRENT_MATCHES_SQL = `
  SELECT
    match.id::text AS match_attempt_id,
    match.shipping_provider_label_id::text AS shipping_provider_label_id,
    carrier_event.id::text AS carrier_tracking_event_id,
    match.match_status,
    carrier_event.dispatch_evidence,
    carrier_event.event_occurred_at,
    carrier_event.received_at
  FROM wms.carrier_tracking_reconciliation_state AS reconciliation_state
  JOIN wms.carrier_tracking_event_matches AS match
    ON match.id = reconciliation_state.last_match_attempt_id
   AND match.carrier_tracking_event_id = reconciliation_state.carrier_tracking_event_id
   AND match.attempt_hash = reconciliation_state.last_match_attempt_hash
   AND match.match_status = reconciliation_state.last_match_status
  JOIN wms.carrier_tracking_events AS carrier_event
    ON carrier_event.id = reconciliation_state.carrier_tracking_event_id
  WHERE match.shipping_provider_label_id = ANY($1::bigint[])
    AND carrier_event.dispatch_evidence = 'confirmed'
    AND match.match_status IN ('matched', 'voided_label')
  ORDER BY
    match.shipping_provider_label_id,
    carrier_event.received_at,
    carrier_event.id
  LIMIT $2
`;

const SNAPSHOT_SQL = `
  SELECT transaction_timestamp() AS snapshot_at
`;

export interface ShipmentLifecycleShadowLabelRow {
  readonly shippingProviderLabelId: string;
  readonly provider: string;
  readonly providerLabelId: string;
  readonly trackingNumber: string;
  readonly labelStatus: string;
  readonly labelDirection: string;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly labelEventCount: number;
}

export interface ShipmentLifecycleShadowLabelEventRow {
  readonly labelEventId: string;
  readonly shippingProviderLabelId: string;
  readonly eventHash: string;
  readonly eventType: string;
  readonly labelStatus: string;
  readonly trackingNumber: string;
  readonly providerOccurredAt: string | null;
  readonly receivedAt: string;
  readonly sanitizedPayload: unknown;
}

export interface ShipmentLifecycleShadowCurrentCarrierMatchRow {
  readonly matchAttemptId: string;
  readonly shippingProviderLabelId: string;
  readonly carrierTrackingEventId: string;
  readonly matchStatus: "matched" | "voided_label";
  readonly dispatchEvidence: "confirmed";
  readonly eventOccurredAt: string | null;
  readonly receivedAt: string;
}

export interface ShipmentLifecycleShadowAuditBatch {
  readonly snapshotAt: string;
  readonly labelLimit: number;
  readonly batchLimitReached: boolean;
  readonly labels: readonly ShipmentLifecycleShadowLabelRow[];
  readonly labelEvents: readonly ShipmentLifecycleShadowLabelEventRow[];
  readonly currentCarrierMatches: readonly ShipmentLifecycleShadowCurrentCarrierMatchRow[];
}

export interface ShipmentLifecycleShadowAuditRepositoryOptions {
  readonly labelLimit?: number;
  readonly maxEventsPerLabel?: number;
  readonly maxCurrentMatches?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
}

export type ShipmentLifecycleShadowAuditErrorCode =
  | "HISTORY_BOUND_EXCEEDED"
  | "INVALID_DATABASE_EVIDENCE"
  | "READ_ONLY_ROLE_REQUIRED"
  | "ROLLBACK_FAILED";

export class ShipmentLifecycleShadowAuditRepositoryError extends Error {
  readonly code: ShipmentLifecycleShadowAuditErrorCode;
  readonly context: Readonly<Record<string, number | boolean>>;

  constructor(
    code: ShipmentLifecycleShadowAuditErrorCode,
    message: string,
    context: Record<string, number | boolean> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ShipmentLifecycleShadowAuditRepositoryError";
    this.code = code;
    this.context = Object.freeze({ ...context });
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

function safeCount(value: unknown, field: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} is not a non-negative safe integer`,
    );
  }
  return count;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (value !== true && value !== false) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} is not a boolean`,
    );
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} is not a non-empty string`,
    );
  }
  return value;
}

function positiveIdString(value: unknown, field: string): string {
  const id = requiredString(value, field);
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} is not a positive decimal identifier`,
    );
  }
  return id;
}

function timestamp(value: unknown, field: string): string {
  const parsed = value instanceof Date ? value : new Date(requiredString(value, field));
  if (Number.isNaN(parsed.getTime())) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} is not a valid timestamp`,
    );
  }
  return parsed.toISOString();
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : timestamp(value, field);
}

function assertReadOnlyEvidenceSql(sql: string): void {
  const normalized = sql.trim();
  if (!/^(SELECT|WITH)\b/i.test(normalized)) {
    throw new Error("Shipment lifecycle shadow evidence queries must start with SELECT or WITH");
  }
  if (/\b(?:INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|MERGE\s+INTO|CREATE\s+(?:TABLE|VIEW|SCHEMA)|ALTER\s+|DROP\s+|TRUNCATE\s+)\b/i.test(normalized)) {
    throw new Error("Shipment lifecycle shadow evidence queries must not contain DML or DDL");
  }
}

async function evidenceQuery(
  client: QueryClient,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> {
  assertReadOnlyEvidenceSql(sql);
  const result = await client.query(sql, [...parameters]);
  return result.rows as Record<string, unknown>[];
}

export async function assertShipmentLifecycleShadowRoleIsReadOnly(
  client: QueryClient,
): Promise<void> {
  const rows = await evidenceQuery(client, SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL);
  const row = rows[0];
  if (!row) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "READ_ONLY_ROLE_REQUIRED",
      "Could not verify the shipment lifecycle shadow database role",
    );
  }
  const transactionReadOnly = row.transaction_read_only === "on";
  const mutableTableCount = safeCount(row.mutable_table_count, "mutable table count");
  const mutableSequenceCount = safeCount(row.mutable_sequence_count, "mutable sequence count");
  const sequenceUsageCount = safeCount(row.sequence_usage_count, "sequence usage count");
  const mutableSchemaCount = safeCount(row.mutable_schema_count, "mutable schema count");
  const mutableDatabase = requiredBoolean(row.mutable_database, "mutable database privilege");
  const elevatedRole = requiredBoolean(row.elevated_role, "elevated role status");
  if (
    !transactionReadOnly
    || mutableTableCount !== 0
    || mutableSequenceCount !== 0
    || sequenceUsageCount !== 0
    || mutableSchemaCount !== 0
    || mutableDatabase
    || elevatedRole
  ) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "READ_ONLY_ROLE_REQUIRED",
      "WMS_INTEGRITY_AUDIT_DATABASE_URL must identify a non-elevated read-only role",
      {
        transactionReadOnly,
        mutableTableCount,
        mutableSequenceCount,
        sequenceUsageCount,
        mutableSchemaCount,
        mutableDatabase,
        elevatedRole,
      },
    );
  }
}

function mapLabel(row: Record<string, unknown>): ShipmentLifecycleShadowLabelRow {
  return Object.freeze({
    shippingProviderLabelId: positiveIdString(
      row.shipping_provider_label_id,
      "shipping_provider_label_id",
    ),
    provider: requiredString(row.provider, "provider"),
    providerLabelId: requiredString(row.provider_label_id, "provider_label_id"),
    trackingNumber: requiredString(row.tracking_number, "tracking_number"),
    labelStatus: requiredString(row.label_status, "label_status"),
    labelDirection: requiredString(row.label_direction, "label_direction"),
    firstObservedAt: timestamp(row.first_observed_at, "first_observed_at"),
    lastObservedAt: timestamp(row.last_observed_at, "last_observed_at"),
    labelEventCount: safeCount(row.label_event_count, "label_event_count"),
  });
}

function mapLabelEvent(row: Record<string, unknown>): ShipmentLifecycleShadowLabelEventRow {
  return Object.freeze({
    labelEventId: positiveIdString(row.label_event_id, "label_event_id"),
    shippingProviderLabelId: positiveIdString(
      row.shipping_provider_label_id,
      "shipping_provider_label_id",
    ),
    eventHash: requiredString(row.event_hash, "event_hash"),
    eventType: requiredString(row.event_type, "event_type"),
    labelStatus: requiredString(row.label_status, "label_status"),
    trackingNumber: requiredString(row.tracking_number, "tracking_number"),
    providerOccurredAt: nullableTimestamp(row.provider_occurred_at, "provider_occurred_at"),
    receivedAt: timestamp(row.received_at, "received_at"),
    sanitizedPayload: row.sanitized_payload,
  });
}

function mapCurrentCarrierMatch(
  row: Record<string, unknown>,
): ShipmentLifecycleShadowCurrentCarrierMatchRow {
  const matchStatus = requiredString(row.match_status, "match_status");
  if (matchStatus !== "matched" && matchStatus !== "voided_label") {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Current carrier match returned a non-authoritative status",
    );
  }
  const dispatchEvidence = requiredString(row.dispatch_evidence, "dispatch_evidence");
  if (dispatchEvidence !== "confirmed") {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Current carrier match returned unconfirmed dispatch evidence",
    );
  }
  return Object.freeze({
    matchAttemptId: positiveIdString(row.match_attempt_id, "match_attempt_id"),
    shippingProviderLabelId: positiveIdString(
      row.shipping_provider_label_id,
      "shipping_provider_label_id",
    ),
    carrierTrackingEventId: positiveIdString(
      row.carrier_tracking_event_id,
      "carrier_tracking_event_id",
    ),
    matchStatus,
    dispatchEvidence,
    eventOccurredAt: nullableTimestamp(row.event_occurred_at, "event_occurred_at"),
    receivedAt: timestamp(row.received_at, "received_at"),
  });
}

async function loadBatchInsideTransaction(
  client: QueryClient,
  input: Required<ShipmentLifecycleShadowAuditRepositoryOptions>,
): Promise<ShipmentLifecycleShadowAuditBatch> {
  await client.query("SELECT set_config('statement_timeout', $1, true)", [
    `${input.statementTimeoutMs}ms`,
  ]);
  await client.query("SELECT set_config('lock_timeout', $1, true)", [
    `${input.lockTimeoutMs}ms`,
  ]);
  await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
    `${input.idleInTransactionTimeoutMs}ms`,
  ]);
  await assertShipmentLifecycleShadowRoleIsReadOnly(client);

  const snapshotRows = await evidenceQuery(client, SNAPSHOT_SQL);
  const snapshot = snapshotRows[0];
  if (!snapshot) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Could not read shipment lifecycle shadow snapshot time",
    );
  }

  const rawLabelRows = await evidenceQuery(
    client,
    SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL,
    [input.labelLimit + 1],
  );
  const batchLimitReached = rawLabelRows.length > input.labelLimit;
  const labels = rawLabelRows.slice(0, input.labelLimit).map(mapLabel);
  const labelIds = labels.map((label) => label.shippingProviderLabelId);
  const selectedLabelIds = new Set(labelIds);
  if (selectedLabelIds.size !== labelIds.length) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Shipment lifecycle shadow label selection returned duplicate labels",
    );
  }

  const expectedEventCount = labels.reduce((sum, label) => {
    if (label.labelEventCount > input.maxEventsPerLabel) {
      throw new ShipmentLifecycleShadowAuditRepositoryError(
        "HISTORY_BOUND_EXCEEDED",
        "A selected label exceeds the complete-history safety bound",
        {
          observedEventCount: label.labelEventCount,
          maxEventsPerLabel: input.maxEventsPerLabel,
        },
      );
    }
    return sum + label.labelEventCount;
  }, 0);

  const labelEvents = expectedEventCount === 0
    ? []
    : (await evidenceQuery(
      client,
      SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL,
      [labelIds, expectedEventCount + 1],
    )).map(mapLabelEvent);
  if (labelEvents.length !== expectedEventCount) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Shipment lifecycle shadow did not receive one complete label-event history",
      { expectedEventCount, observedEventCount: labelEvents.length },
    );
  }
  if (labelEvents.some((event) => !selectedLabelIds.has(event.shippingProviderLabelId))) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Shipment lifecycle shadow received an event outside the selected label batch",
    );
  }

  const currentCarrierMatches = labels.length === 0
    ? []
    : (await evidenceQuery(
      client,
      SHIPMENT_LIFECYCLE_SHADOW_CURRENT_MATCHES_SQL,
      [labelIds, input.maxCurrentMatches + 1],
    )).map(mapCurrentCarrierMatch);
  if (currentCarrierMatches.length > input.maxCurrentMatches) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "HISTORY_BOUND_EXCEEDED",
      "Current confirmed carrier matches exceed the batch safety bound",
      {
        observedCurrentMatchCount: currentCarrierMatches.length,
        maxCurrentMatches: input.maxCurrentMatches,
      },
    );
  }
  if (currentCarrierMatches.some(
    (match) => !selectedLabelIds.has(match.shippingProviderLabelId),
  )) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Shipment lifecycle shadow received a carrier match outside the selected label batch",
    );
  }

  return Object.freeze({
    snapshotAt: timestamp(snapshot.snapshot_at, "snapshot_at"),
    labelLimit: input.labelLimit,
    batchLimitReached,
    labels: Object.freeze(labels),
    labelEvents: Object.freeze(labelEvents),
    currentCarrierMatches: Object.freeze(currentCarrierMatches),
  });
}

export async function loadShipmentLifecycleShadowAuditBatch(
  client: QueryClient,
  options: ShipmentLifecycleShadowAuditRepositoryOptions = {},
): Promise<ShipmentLifecycleShadowAuditBatch> {
  const input: Required<ShipmentLifecycleShadowAuditRepositoryOptions> = {
    labelLimit: boundedPositiveInteger(
      options.labelLimit ?? DEFAULT_LABEL_LIMIT,
      "labelLimit",
      MAX_LABEL_LIMIT,
    ),
    maxEventsPerLabel: boundedPositiveInteger(
      options.maxEventsPerLabel ?? DEFAULT_MAX_EVENTS_PER_LABEL,
      "maxEventsPerLabel",
      MAX_EVENTS_PER_LABEL,
    ),
    maxCurrentMatches: boundedPositiveInteger(
      options.maxCurrentMatches ?? DEFAULT_MAX_CURRENT_MATCHES,
      "maxCurrentMatches",
      MAX_CURRENT_MATCHES,
    ),
    statementTimeoutMs: boundedPositiveInteger(
      options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      "statementTimeoutMs",
      120_000,
    ),
    lockTimeoutMs: boundedPositiveInteger(
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      "lockTimeoutMs",
      10_000,
    ),
    idleInTransactionTimeoutMs: boundedPositiveInteger(
      options.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      "idleInTransactionTimeoutMs",
      300_000,
    ),
  };

  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let batch: ShipmentLifecycleShadowAuditBatch | undefined;
  let primaryFailure: unknown;
  try {
    batch = await loadBatchInsideTransaction(client, input);
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
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "ROLLBACK_FAILED",
      "Shipment lifecycle shadow evidence read and rollback both failed",
      {},
      { cause: new AggregateError([primaryFailure, rollbackFailure]) },
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (rollbackFailure !== undefined) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "ROLLBACK_FAILED",
      "Shipment lifecycle shadow rollback failed",
      {},
      { cause: rollbackFailure },
    );
  }
  if (!batch) {
    throw new ShipmentLifecycleShadowAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Shipment lifecycle shadow batch completed without a result",
    );
  }
  return batch;
}
