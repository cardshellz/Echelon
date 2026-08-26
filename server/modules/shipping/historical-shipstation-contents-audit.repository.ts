import type { PoolClient } from "pg";

import type { HistoricalShipStationExpectedContentsEvidence } from "./historical-shipstation-contents-recovery.domain";
import { assertShipmentLifecycleShadowRoleIsReadOnly } from "./shipment-lifecycle-shadow-audit.repository";

type QueryClient = Pick<PoolClient, "query">;

const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_LINKED_PACKAGE_LINES = 500;

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

export const HISTORICAL_SHIPSTATION_CONTENTS_LINEAGE_REQUIRED_RELATIONS = Object.freeze([
  "catalog.product_variants",
  "wms.order_items",
  "wms.outbound_shipment_items",
  "wms.physical_shipment_items",
  "wms.shipping_provider_label_links",
] as const);

const LINEAGE_REQUIRED_RELATIONS_SQL = HISTORICAL_SHIPSTATION_CONTENTS_LINEAGE_REQUIRED_RELATIONS
  .map((relation) => `('${relation}', '${relation.split(".")[0]}')`)
  .join(",\n      ");

export const HISTORICAL_SHIPSTATION_CONTENTS_LINEAGE_ROLE_ASSERTION_SQL = `
  WITH required_relations(qualified_name, schema_name) AS (
    VALUES
      ${LINEAGE_REQUIRED_RELATIONS_SQL}
  ),
  required_relation_state AS MATERIALIZED (
    SELECT
      qualified_name,
      schema_name,
      to_regclass(qualified_name) AS relation_oid
    FROM required_relations
  )
  SELECT
    COALESCE((
      SELECT COUNT(*)
      FROM required_relation_state
      WHERE relation_oid IS NULL
        OR NOT COALESCE(
          has_table_privilege(current_user, relation_oid, 'SELECT'),
          false
        )
    ), 0)::text AS missing_required_select_count,
    COALESCE((
      SELECT COUNT(*)
      FROM required_relation_state AS required
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = required.relation_oid
      WHERE relation.relrowsecurity
    ), 0)::text AS required_rls_count,
    COALESCE((
      SELECT COUNT(*)
      FROM (
        SELECT DISTINCT schema_name
        FROM required_relations
      ) AS required_schema
      WHERE NOT has_schema_privilege(current_user, schema_name, 'USAGE')
    ), 0)::text AS missing_required_schema_usage_count
`;

export const HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL = `
  SELECT
    label.id::text AS shipping_provider_label_id,
    label.provider_label_id
  FROM wms.shipping_provider_labels AS label
  WHERE label.provider = 'shipstation'
    AND label.label_direction = 'outbound'
    AND label.provider_label_id ~ '^[1-9][0-9]*$'
    AND ($1::bigint IS NULL OR label.id < $1::bigint)
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
  LIMIT $2
`;

export const HISTORICAL_SHIPSTATION_CONTENTS_LINKS_SQL = `
  SELECT
    link.shipping_provider_label_id::text AS shipping_provider_label_id,
    COUNT(DISTINCT link.physical_shipment_id) FILTER (
      WHERE link.physical_shipment_id IS NOT NULL
    )::text AS physical_shipment_count,
    COUNT(DISTINCT link.legacy_wms_shipment_id) FILTER (
      WHERE link.legacy_wms_shipment_id IS NOT NULL
    )::text AS legacy_wms_shipment_count
  FROM wms.shipping_provider_label_links AS link
  WHERE link.shipping_provider_label_id = ANY($1::bigint[])
  GROUP BY link.shipping_provider_label_id
  ORDER BY link.shipping_provider_label_id
`;

export const HISTORICAL_SHIPSTATION_CONTENTS_LINKED_LINES_SQL = `
  WITH selected_labels(shipping_provider_label_id) AS (
    SELECT UNNEST($1::bigint[])
  ),
  linked_lines AS (
    SELECT
      link.shipping_provider_label_id::text AS shipping_provider_label_id,
      'physical_shipment'::text AS source_kind,
      link.physical_shipment_id::text AS linked_package_id,
      item.legacy_wms_shipment_item_id::text AS wms_shipment_item_id,
      item.sku,
      item.quantity_shipped::text AS quantity
    FROM selected_labels AS selected
    JOIN wms.shipping_provider_label_links AS link
      ON link.shipping_provider_label_id = selected.shipping_provider_label_id
    JOIN wms.physical_shipment_items AS item
      ON item.physical_shipment_id = link.physical_shipment_id
    WHERE link.physical_shipment_id IS NOT NULL

    UNION ALL

    SELECT
      link.shipping_provider_label_id::text AS shipping_provider_label_id,
      'legacy_wms_shipment'::text AS source_kind,
      link.legacy_wms_shipment_id::text AS linked_package_id,
      item.id::text AS wms_shipment_item_id,
      CASE item.shipment_item_purpose
        WHEN 'customer_fulfillment' THEN order_item.sku
        WHEN 'replacement' THEN replacement_order_item.sku
        WHEN 'concession' THEN variant.sku
        WHEN 'omission_correction' THEN variant.sku
        WHEN 'unclassified' THEN variant.sku
        ELSE NULL
      END AS sku,
      item.qty::text AS quantity
    FROM selected_labels AS selected
    JOIN wms.shipping_provider_label_links AS link
      ON link.shipping_provider_label_id = selected.shipping_provider_label_id
    JOIN wms.outbound_shipment_items AS item
      ON item.shipment_id = link.legacy_wms_shipment_id
    LEFT JOIN wms.order_items AS order_item
      ON order_item.id = item.order_item_id
    LEFT JOIN wms.order_items AS replacement_order_item
      ON replacement_order_item.id = item.replacement_for_order_item_id
    LEFT JOIN catalog.product_variants AS variant
      ON variant.id = item.product_variant_id
    WHERE link.legacy_wms_shipment_id IS NOT NULL
  ),
  ranked_lines AS (
    SELECT
      linked_lines.*,
      ROW_NUMBER() OVER (
        PARTITION BY shipping_provider_label_id, source_kind
        ORDER BY linked_package_id::bigint, wms_shipment_item_id::bigint
      ) AS source_row_number
    FROM linked_lines
  )
  SELECT
    shipping_provider_label_id,
    source_kind,
    linked_package_id,
    wms_shipment_item_id,
    sku,
    quantity
  FROM ranked_lines
  WHERE source_row_number <= $2::integer
  ORDER BY
    shipping_provider_label_id,
    source_kind,
    linked_package_id::bigint,
    wms_shipment_item_id::bigint
`;

export interface HistoricalShipStationContentsAuditRepositoryOptions {
  readonly candidateLimit?: number;
  readonly beforeLabelId?: string;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
}

export interface NormalizedHistoricalShipStationContentsAuditRepositoryOptions {
  readonly candidateLimit: number;
  readonly beforeLabelId: string | null;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
}

export interface HistoricalShipStationContentsCandidate {
  readonly shippingProviderLabelId: string;
  readonly providerShipmentId: number;
  readonly expectedContents: HistoricalShipStationExpectedContentsEvidence;
}

export interface HistoricalShipStationContentsCandidateBatch {
  readonly candidateLimit: number;
  readonly beforeLabelId: string | null;
  readonly nextBeforeLabelId: string | null;
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

function optionalPositiveBigintCursor(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > POSTGRES_BIGINT_MAX) {
    throw new RangeError("beforeLabelId must be a positive PostgreSQL bigint");
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
    beforeLabelId: optionalPositiveBigintCursor(options.beforeLabelId),
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

function safeCount(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new HistoricalShipStationContentsAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a nonnegative count`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HistoricalShipStationContentsAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} exceeds the JavaScript safe-integer range`,
    );
  }
  return parsed;
}

function positivePostgresInteger(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= POSTGRES_INTEGER_MAX
    ? parsed
    : null;
}

function exactSku(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 100
    || value.trim() !== value
  ) {
    return null;
  }
  return value;
}

function mapCandidateIdentity(row: Record<string, unknown>): Omit<
  HistoricalShipStationContentsCandidate,
  "expectedContents"
> {
  return Object.freeze({
    shippingProviderLabelId: positiveBigintString(
      row.shipping_provider_label_id,
      "shipping_provider_label_id",
    ),
    providerShipmentId: positiveProviderShipmentId(row.provider_label_id),
  });
}

interface LinkedPackageSummary {
  readonly physicalShipmentCount: number;
  readonly legacyWmsShipmentCount: number;
}

type LinkedLineSource = "physical_shipment" | "legacy_wms_shipment";

function unavailableExpectedContents(
  reason: Extract<HistoricalShipStationExpectedContentsEvidence, { kind: "unavailable" }>["reason"],
): HistoricalShipStationExpectedContentsEvidence {
  return Object.freeze({ kind: "unavailable" as const, reason });
}

function mapLinkedPackageSummaries(
  rows: readonly Record<string, unknown>[],
  selectedLabelIds: ReadonlySet<string>,
): ReadonlyMap<string, LinkedPackageSummary> {
  const summaries = new Map<string, LinkedPackageSummary>();
  for (const row of rows) {
    const labelId = positiveBigintString(
      row.shipping_provider_label_id,
      "shipping_provider_label_id",
    );
    if (!selectedLabelIds.has(labelId) || summaries.has(labelId)) {
      throw new HistoricalShipStationContentsAuditRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical ShipStation lineage query returned an unexpected or duplicate label",
      );
    }
    summaries.set(labelId, Object.freeze({
      physicalShipmentCount: safeCount(
        row.physical_shipment_count,
        "physical_shipment_count",
      ),
      legacyWmsShipmentCount: safeCount(
        row.legacy_wms_shipment_count,
        "legacy_wms_shipment_count",
      ),
    }));
  }
  return summaries;
}

function mapLinkedLineRows(
  rows: readonly Record<string, unknown>[],
  selectedLabelIds: ReadonlySet<string>,
): ReadonlyMap<
  string,
  ReadonlyMap<LinkedLineSource, ReadonlyMap<string, readonly Record<string, unknown>[]>>
> {
  const mutable = new Map<
    string,
    Map<LinkedLineSource, Map<string, Record<string, unknown>[]>>
  >();
  for (const row of rows) {
    const labelId = positiveBigintString(
      row.shipping_provider_label_id,
      "shipping_provider_label_id",
    );
    if (!selectedLabelIds.has(labelId)) {
      throw new HistoricalShipStationContentsAuditRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical ShipStation line query returned an unexpected label",
      );
    }
    const source = row.source_kind;
    if (source !== "physical_shipment" && source !== "legacy_wms_shipment") {
      throw new HistoricalShipStationContentsAuditRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical ShipStation line query returned an unknown source",
      );
    }
    const linkedPackageId = positiveBigintString(row.linked_package_id, "linked_package_id");
    const bySource = mutable.get(labelId)
      ?? new Map<LinkedLineSource, Map<string, Record<string, unknown>[]>>();
    const byPackage = bySource.get(source) ?? new Map<string, Record<string, unknown>[]>();
    const packageRows = byPackage.get(linkedPackageId) ?? [];
    packageRows.push(row);
    byPackage.set(linkedPackageId, packageRows);
    bySource.set(source, byPackage);
    mutable.set(labelId, bySource);
  }
  const frozen = new Map<
    string,
    ReadonlyMap<LinkedLineSource, ReadonlyMap<string, readonly Record<string, unknown>[]>>
  >();
  for (const [labelId, bySource] of mutable) {
    frozen.set(labelId, new Map(
      [...bySource].map(([source, byPackage]) => [source, new Map(
        [...byPackage].map(([packageId, packageRows]) => [
          packageId,
          Object.freeze([...packageRows]),
        ]),
      )]),
    ));
  }
  return frozen;
}

function availableExpectedContents(
  source: LinkedLineSource,
  rows: readonly Record<string, unknown>[],
): HistoricalShipStationExpectedContentsEvidence {
  if (rows.length === 0 || rows.length > MAX_LINKED_PACKAGE_LINES) {
    return unavailableExpectedContents("linked_package_contents_unavailable");
  }
  const seenIds = new Set<number>();
  const lines: Array<{ wmsShipmentItemId: number; sku: string; quantity: number }> = [];
  for (const row of rows) {
    const wmsShipmentItemId = positivePostgresInteger(row.wms_shipment_item_id);
    const quantity = positivePostgresInteger(row.quantity);
    const sku = exactSku(row.sku);
    if (
      wmsShipmentItemId === null
      || quantity === null
      || sku === null
      || seenIds.has(wmsShipmentItemId)
    ) {
      return unavailableExpectedContents("linked_package_contents_unavailable");
    }
    seenIds.add(wmsShipmentItemId);
    lines.push(Object.freeze({ wmsShipmentItemId, sku, quantity }));
  }
  lines.sort((left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId);
  return Object.freeze({ kind: "available" as const, source, lines: Object.freeze(lines) });
}

function expectedContentsForCandidate(
  labelId: string,
  summaries: ReadonlyMap<string, LinkedPackageSummary>,
  lineRows: ReadonlyMap<
    string,
    ReadonlyMap<LinkedLineSource, ReadonlyMap<string, readonly Record<string, unknown>[]>>
  >,
): HistoricalShipStationExpectedContentsEvidence {
  function contentsForLinkedSource(
    source: LinkedLineSource,
    linkedPackageCount: number,
  ): HistoricalShipStationExpectedContentsEvidence {
    const populatedPackages = lineRows.get(labelId)?.get(source) ?? new Map();
    if (populatedPackages.size > linkedPackageCount) {
      throw new HistoricalShipStationContentsAuditRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical ShipStation line query returned more populated packages than linked packages",
      );
    }
    if (linkedPackageCount === 1) {
      const rows = populatedPackages.values().next().value ?? [];
      return availableExpectedContents(source, rows);
    }
    if (populatedPackages.size !== 1) {
      return unavailableExpectedContents("ambiguous_linked_package");
    }
    return availableExpectedContents(source, populatedPackages.values().next().value ?? []);
  }

  const summary = summaries.get(labelId);
  if (!summary) return unavailableExpectedContents("no_linked_package");
  if (summary.physicalShipmentCount > 0) {
    return contentsForLinkedSource("physical_shipment", summary.physicalShipmentCount);
  }
  if (summary.legacyWmsShipmentCount > 0) {
    return contentsForLinkedSource("legacy_wms_shipment", summary.legacyWmsShipmentCount);
  }
  return unavailableExpectedContents("no_linked_package");
}


export async function loadHistoricalShipStationExpectedContents(
  client: QueryClient,
  rawShippingProviderLabelId: string,
): Promise<HistoricalShipStationExpectedContentsEvidence> {
  const shippingProviderLabelId = positiveBigintString(
    rawShippingProviderLabelId,
    "shipping_provider_label_id",
  );
  const labelIds = Object.freeze([shippingProviderLabelId]);
  const selectedLabelIds = new Set(labelIds);
  const linksResult = await client.query(HISTORICAL_SHIPSTATION_CONTENTS_LINKS_SQL, [labelIds]);
  const linesResult = await client.query(HISTORICAL_SHIPSTATION_CONTENTS_LINKED_LINES_SQL, [
    labelIds,
    MAX_LINKED_PACKAGE_LINES + 1,
  ]);
  return expectedContentsForCandidate(
    shippingProviderLabelId,
    mapLinkedPackageSummaries(
      linksResult.rows as Record<string, unknown>[],
      selectedLabelIds,
    ),
    mapLinkedLineRows(
      linesResult.rows as Record<string, unknown>[],
      selectedLabelIds,
    ),
  );
}

async function assertLineageRoleEvidence(client: QueryClient): Promise<void> {
  const result = await client.query(HISTORICAL_SHIPSTATION_CONTENTS_LINEAGE_ROLE_ASSERTION_SQL);
  const row = (result.rows as Record<string, unknown>[])[0];
  if (!row) {
    throw new HistoricalShipStationContentsAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Could not verify the historical ShipStation lineage read privileges",
    );
  }
  const missingRequiredSelectCount = safeCount(
    row.missing_required_select_count,
    "missing_required_select_count",
  );
  const requiredRlsCount = safeCount(row.required_rls_count, "required_rls_count");
  const missingRequiredSchemaUsageCount = safeCount(
    row.missing_required_schema_usage_count,
    "missing_required_schema_usage_count",
  );
  if (
    missingRequiredSelectCount !== 0
    || requiredRlsCount !== 0
    || missingRequiredSchemaUsageCount !== 0
  ) {
    throw new HistoricalShipStationContentsAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "The historical ShipStation audit role cannot read all required lineage relations",
      Object.freeze({
        missingRequiredSelectCount,
        requiredRlsCount,
        missingRequiredSchemaUsageCount,
      }),
    );
  }
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
  await assertLineageRoleEvidence(client);
  const result = await client.query(
    HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL,
    [input.beforeLabelId, input.candidateLimit + 1],
  );
  const mapped = (result.rows as Record<string, unknown>[]).map(mapCandidateIdentity);
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

  const selected = mapped.slice(0, input.candidateLimit);
  const batchLimitReached = mapped.length > input.candidateLimit;
  const nextBeforeLabelId = batchLimitReached
    ? selected.at(-1)?.shippingProviderLabelId ?? null
    : null;
  const selectedLabelIds = Object.freeze(selected.map((candidate) => candidate.shippingProviderLabelId));
  const selectedLabelIdSet = new Set(selectedLabelIds);
  const linksResult = selectedLabelIds.length === 0
    ? { rows: [] }
    : await client.query(HISTORICAL_SHIPSTATION_CONTENTS_LINKS_SQL, [selectedLabelIds]);
  const linesResult = selectedLabelIds.length === 0
    ? { rows: [] }
    : await client.query(HISTORICAL_SHIPSTATION_CONTENTS_LINKED_LINES_SQL, [
        selectedLabelIds,
        MAX_LINKED_PACKAGE_LINES + 1,
      ]);
  const summaries = mapLinkedPackageSummaries(
    linksResult.rows as Record<string, unknown>[],
    selectedLabelIdSet,
  );
  const lineRows = mapLinkedLineRows(
    linesResult.rows as Record<string, unknown>[],
    selectedLabelIdSet,
  );
  const candidates = Object.freeze(selected.map((candidate) => Object.freeze({
    ...candidate,
    expectedContents: expectedContentsForCandidate(
      candidate.shippingProviderLabelId,
      summaries,
      lineRows,
    ),
  })));
  return Object.freeze({
    candidateLimit: input.candidateLimit,
    beforeLabelId: input.beforeLabelId,
    nextBeforeLabelId,
    batchLimitReached,
    databaseTemporaryPrivilege: roleEvidence.databaseTemporaryPrivilege,
    candidates,
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
