import type { PoolClient } from "pg";

import {
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL,
  type PackageAllocationAuthorityDiscoveryIndexContract,
} from "./package-allocation-authority-discovery.query";
import {
  assertShipmentLifecycleShadowRoleIsReadOnly,
} from "./shipment-lifecycle-shadow-audit.repository";

type QueryClient = Pick<PoolClient, "query">;

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_EXPLAIN_JSON_BYTES = 1_024 * 1_024;
const MAX_EXPLAIN_PLAN_NODES = 4_096;
const MAX_EXPLAIN_PLAN_DEPTH = 64;

export const PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_LIMITS = Object.freeze({
  defaultStatementTimeoutMs: 15_000,
  maxStatementTimeoutMs: 60_000,
  defaultLockTimeoutMs: 2_000,
  maxLockTimeoutMs: 10_000,
  defaultIdleInTransactionTimeoutMs: 30_000,
  maxIdleInTransactionTimeoutMs: 120_000,
});

const REQUIRED_RELATION_VALUES_SQL = PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS
  .map((relation) => `('${relation}', '${relation.split(".")[0]}')`)
  .join(",\n      ");

export const PACKAGE_ALLOCATION_DISCOVERY_RELATION_ASSERTION_SQL = `
  WITH required_relations(qualified_name, schema_name) AS (
    VALUES
      ${REQUIRED_RELATION_VALUES_SQL}
  ),
  required_relation_state AS MATERIALIZED (
    SELECT
      qualified_name,
      schema_name,
      to_regclass(qualified_name) AS relation_oid
    FROM required_relations
  ),
  required_schemas AS (
    SELECT DISTINCT schema_name
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
      FROM required_schemas
      WHERE NOT has_schema_privilege(current_user, schema_name, 'USAGE')
    ), 0)::text AS missing_required_schema_usage_count
`;

const EXPECTED_INDEX_VALUES_SQL = PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS
  .map((contract) => `('${contract.indexName}', '${contract.relationName}')`)
  .join(",\n      ");

export const PACKAGE_ALLOCATION_DISCOVERY_INDEX_CATALOG_SQL = `
  WITH expected(index_name, relation_name) AS (
    VALUES
      ${EXPECTED_INDEX_VALUES_SQL}
  )
  SELECT
    expected.index_name,
    expected.relation_name AS expected_relation_name,
    relation_namespace.nspname AS relation_schema,
    relation.relname AS actual_relation_name,
    access_method.amname AS access_method,
    index_state.indisvalid,
    index_state.indisready,
    index_state.indislive,
    index_state.indisunique,
    ARRAY(
      SELECT pg_get_indexdef(index_state.indexrelid, key_number, true)
      FROM generate_series(1, index_state.indnkeyatts) AS key_number
      ORDER BY key_number
    ) AS key_columns,
    pg_get_expr(index_state.indpred, index_state.indrelid) AS predicate
  FROM expected
  LEFT JOIN pg_catalog.pg_namespace AS index_namespace
    ON index_namespace.nspname = 'wms'
  LEFT JOIN pg_catalog.pg_class AS index_relation
    ON index_relation.relnamespace = index_namespace.oid
   AND index_relation.relname = expected.index_name
  LEFT JOIN pg_catalog.pg_index AS index_state
    ON index_state.indexrelid = index_relation.oid
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.oid = index_state.indrelid
  LEFT JOIN pg_catalog.pg_namespace AS relation_namespace
    ON relation_namespace.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_am AS access_method
    ON access_method.oid = index_relation.relam
  ORDER BY expected.index_name
`;

export const PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL =
  `EXPLAIN (ANALYZE FALSE, VERBOSE FALSE, COSTS TRUE, BUFFERS FALSE, FORMAT JSON) `
  + PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL;

export type PackageAllocationDiscoveryPlanAuditErrorCode =
  | "DISCOVERY_INDEX_CONTRACT_MISMATCH"
  | "INVALID_DATABASE_EVIDENCE"
  | "ROLLBACK_FAILED";

export class PackageAllocationDiscoveryPlanAuditRepositoryError extends Error {
  readonly code: PackageAllocationDiscoveryPlanAuditErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(
    code: PackageAllocationDiscoveryPlanAuditErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PackageAllocationDiscoveryPlanAuditRepositoryError";
    this.code = code;
    this.context = Object.freeze({ ...context });
    this.cause = cause;
  }
}

export interface PackageAllocationDiscoveryPlanAuditOptions {
  readonly sourceWmsShipmentItemId: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
}

export interface NormalizedPackageAllocationDiscoveryPlanAuditOptions {
  readonly sourceWmsShipmentItemId: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
}

export interface PackageAllocationDiscoveryPlanAuditIndexEvidence {
  readonly indexName: string;
  readonly relationName: string;
  readonly selectedByCostedPlan: boolean;
}

export interface PackageAllocationDiscoveryPlanAuditReport {
  readonly mode: "read_only_explain";
  readonly queryExecuted: false;
  readonly sourceCount: 1;
  readonly readOnlyRoleVerified: true;
  readonly databaseTemporaryPrivilege: boolean;
  readonly expectedIndexCount: number;
  readonly costSelectedExpectedIndexCount: number;
  readonly indexes: readonly PackageAllocationDiscoveryPlanAuditIndexEvidence[];
  readonly planNodeCount: number;
  readonly rootNodeType: string;
  readonly estimatedStartupCost: number;
  readonly estimatedTotalCost: number;
  readonly estimatedPlanRows: number;
  readonly sequentialScanRelations: readonly string[];
}

function boundedInteger(
  value: unknown,
  field: string,
  defaultValue: number,
  maximum: number,
): number {
  const candidate = value === undefined ? defaultValue : value;
  if (!Number.isSafeInteger(candidate) || Number(candidate) <= 0 || Number(candidate) > maximum) {
    throw new Error(`${field} must be a positive integer no greater than ${maximum}`);
  }
  return Number(candidate);
}

export function normalizePackageAllocationDiscoveryPlanAuditOptions(
  options: PackageAllocationDiscoveryPlanAuditOptions,
): NormalizedPackageAllocationDiscoveryPlanAuditOptions {
  if (
    !Number.isInteger(options.sourceWmsShipmentItemId)
    || options.sourceWmsShipmentItemId <= 0
    || options.sourceWmsShipmentItemId > POSTGRES_INTEGER_MAX
  ) {
    throw new Error("sourceWmsShipmentItemId must be a positive PostgreSQL integer");
  }
  return Object.freeze({
    sourceWmsShipmentItemId: options.sourceWmsShipmentItemId,
    statementTimeoutMs: boundedInteger(
      options.statementTimeoutMs,
      "statementTimeoutMs",
      PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_LIMITS.defaultStatementTimeoutMs,
      PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_LIMITS.maxStatementTimeoutMs,
    ),
    lockTimeoutMs: boundedInteger(
      options.lockTimeoutMs,
      "lockTimeoutMs",
      PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_LIMITS.defaultLockTimeoutMs,
      PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_LIMITS.maxLockTimeoutMs,
    ),
    idleInTransactionTimeoutMs: boundedInteger(
      options.idleInTransactionTimeoutMs,
      "idleInTransactionTimeoutMs",
      PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_LIMITS.defaultIdleInTransactionTimeoutMs,
      PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_LIMITS.maxIdleInTransactionTimeoutMs,
    ),
  });
}

function safeCount(value: unknown, field: string): number {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(text)) {
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `PostgreSQL returned invalid ${field}`,
    );
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `PostgreSQL returned out-of-range ${field}`,
    );
  }
  return parsed;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (value === true || value === false) return value;
  throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
    "INVALID_DATABASE_EVIDENCE",
    `PostgreSQL returned invalid ${field}`,
  );
}

function requiredText(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
    "INVALID_DATABASE_EVIDENCE",
    `PostgreSQL returned invalid ${field}`,
  );
}

function requiredTextArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `PostgreSQL returned invalid ${field}`,
    );
  }
  return Object.freeze([...value]);
}

function normalizedPredicate(value: string): string {
  let normalized = value
    .replaceAll('"', "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

async function assertDiscoveryRelationsAreReadable(client: QueryClient): Promise<void> {
  const result = await client.query(PACKAGE_ALLOCATION_DISCOVERY_RELATION_ASSERTION_SQL);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Could not verify the package-allocation discovery relation grants",
    );
  }
  const missingRequiredSelectCount = safeCount(
    row.missing_required_select_count,
    "missing required SELECT count",
  );
  const requiredRlsCount = safeCount(row.required_rls_count, "required RLS count");
  const missingRequiredSchemaUsageCount = safeCount(
    row.missing_required_schema_usage_count,
    "missing required schema USAGE count",
  );
  if (
    missingRequiredSelectCount !== 0
    || requiredRlsCount !== 0
    || missingRequiredSchemaUsageCount !== 0
  ) {
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "The audit role cannot safely read every package-allocation discovery relation",
      {
        missingRequiredSelectCount,
        requiredRlsCount,
        missingRequiredSchemaUsageCount,
      },
    );
  }
}

interface CatalogIndexEvidence {
  readonly contract: PackageAllocationAuthorityDiscoveryIndexContract;
}

function assertIndexCatalogRows(
  rows: readonly Record<string, unknown>[],
): readonly CatalogIndexEvidence[] {
  const byName = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const indexName = requiredText(row.index_name, "index name");
    if (byName.has(indexName)) {
      throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "PostgreSQL returned duplicate discovery-index catalog evidence",
      );
    }
    byName.set(indexName, row);
  }

  const mismatches: string[] = [];
  const evidence = PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS.map((contract) => {
    const row = byName.get(contract.indexName);
    if (!row) {
      mismatches.push(`${contract.indexName}:missing_row`);
      return Object.freeze({ contract });
    }
    const relationSchema = row.relation_schema;
    const actualRelationName = row.actual_relation_name;
    const accessMethod = row.access_method;
    const predicate = row.predicate;
    if (
      relationSchema === null
      && actualRelationName === null
      && accessMethod === null
      && row.indisvalid === null
      && row.indisready === null
      && row.indislive === null
    ) {
      mismatches.push(`${contract.indexName}:missing`);
      return Object.freeze({ contract });
    }
    const keyColumns = requiredTextArray(row.key_columns, "index key columns");
    if (relationSchema !== "wms" || actualRelationName !== contract.relationName) {
      mismatches.push(`${contract.indexName}:wrong_relation`);
    }
    if (accessMethod !== "btree") mismatches.push(`${contract.indexName}:wrong_access_method`);
    if (!requiredBoolean(row.indisvalid, "index validity")) {
      mismatches.push(`${contract.indexName}:invalid`);
    }
    if (!requiredBoolean(row.indisready, "index readiness")) {
      mismatches.push(`${contract.indexName}:not_ready`);
    }
    if (!requiredBoolean(row.indislive, "index live state")) {
      mismatches.push(`${contract.indexName}:not_live`);
    }
    if (requiredBoolean(row.indisunique, "index uniqueness")) {
      mismatches.push(`${contract.indexName}:unexpected_unique`);
    }
    if (JSON.stringify(keyColumns) !== JSON.stringify(contract.keyColumns)) {
      mismatches.push(`${contract.indexName}:wrong_columns`);
    }
    if (
      typeof predicate !== "string"
      || normalizedPredicate(predicate) !== `${contract.predicateColumn} is not null`
    ) {
      mismatches.push(`${contract.indexName}:wrong_predicate`);
    }
    return Object.freeze({ contract });
  });
  if (byName.size !== PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS.length) {
    mismatches.push("unexpected_catalog_row_count");
  }
  if (mismatches.length > 0) {
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "DISCOVERY_INDEX_CONTRACT_MISMATCH",
      "The deployed package-allocation discovery indexes do not match the required contract",
      { mismatches: Object.freeze([...mismatches].sort()) },
    );
  }
  return Object.freeze(evidence);
}

function planRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `PostgreSQL returned invalid ${field}`,
    );
  }
  return value as Record<string, unknown>;
}

function nonnegativePlanNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `PostgreSQL returned invalid ${field}`,
    );
  }
  return value;
}

interface ExplainPlanSummary {
  readonly usedIndexNames: ReadonlySet<string>;
  readonly sequentialScanRelations: readonly string[];
  readonly nodeCount: number;
  readonly rootNodeType: string;
  readonly estimatedStartupCost: number;
  readonly estimatedTotalCost: number;
  readonly estimatedPlanRows: number;
}

function summarizeExplainPlan(raw: unknown): ExplainPlanSummary {
  let parsed = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > MAX_EXPLAIN_JSON_BYTES) {
      throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "PostgreSQL EXPLAIN JSON exceeded its byte bound",
      );
    }
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "PostgreSQL returned malformed EXPLAIN JSON",
        {},
        error,
      );
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "PostgreSQL EXPLAIN did not return one plan document",
    );
  }
  const document = planRecord(parsed[0], "EXPLAIN document");
  const root = planRecord(document.Plan, "EXPLAIN root plan");
  const expectedRelationNames = new Set(
    PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS.map(
      (relation) => relation.split(".")[1],
    ),
  );
  const usedIndexNames = new Set<string>();
  const sequentialScanRelations = new Set<string>();
  const pending: Array<{ node: Record<string, unknown>; depth: number }> = [
    { node: root, depth: 1 },
  ];
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodeCount += 1;
    if (nodeCount > MAX_EXPLAIN_PLAN_NODES || current.depth > MAX_EXPLAIN_PLAN_DEPTH) {
      throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "PostgreSQL EXPLAIN plan exceeded its structural bound",
      );
    }
    const nodeType = requiredText(current.node["Node Type"], "EXPLAIN node type");
    const indexName = current.node["Index Name"];
    if (typeof indexName === "string") usedIndexNames.add(indexName);
    const relationName = current.node["Relation Name"];
    if (
      nodeType.includes("Seq Scan")
      && typeof relationName === "string"
      && expectedRelationNames.has(relationName)
    ) {
      sequentialScanRelations.add(relationName);
    }
    const children = current.node.Plans;
    if (children !== undefined) {
      if (!Array.isArray(children)) {
        throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "PostgreSQL EXPLAIN returned invalid child plans",
        );
      }
      for (const child of children) {
        pending.push({
          node: planRecord(child, "EXPLAIN child plan"),
          depth: current.depth + 1,
        });
      }
    }
  }

  return Object.freeze({
    usedIndexNames,
    sequentialScanRelations: Object.freeze([...sequentialScanRelations].sort()),
    nodeCount,
    rootNodeType: requiredText(root["Node Type"], "EXPLAIN root node type"),
    estimatedStartupCost: nonnegativePlanNumber(
      root["Startup Cost"],
      "EXPLAIN startup cost",
    ),
    estimatedTotalCost: nonnegativePlanNumber(root["Total Cost"], "EXPLAIN total cost"),
    estimatedPlanRows: nonnegativePlanNumber(root["Plan Rows"], "EXPLAIN plan rows"),
  });
}

async function loadAuditInsideTransaction(
  client: QueryClient,
  input: NormalizedPackageAllocationDiscoveryPlanAuditOptions,
): Promise<PackageAllocationDiscoveryPlanAuditReport> {
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
  await assertDiscoveryRelationsAreReadable(client);

  const catalogResult = await client.query(PACKAGE_ALLOCATION_DISCOVERY_INDEX_CATALOG_SQL);
  const catalogEvidence = assertIndexCatalogRows(
    catalogResult.rows as Record<string, unknown>[],
  );
  const explainResult = await client.query(
    PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL,
    [[input.sourceWmsShipmentItemId], PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES + 1],
  );
  const plan = summarizeExplainPlan(
    (explainResult.rows[0] as Record<string, unknown> | undefined)?.["QUERY PLAN"],
  );
  const indexes = catalogEvidence.map(({ contract }) => Object.freeze({
    indexName: contract.indexName,
    relationName: contract.relationName,
    selectedByCostedPlan: plan.usedIndexNames.has(contract.indexName),
  }));
  return Object.freeze({
    mode: "read_only_explain",
    queryExecuted: false,
    sourceCount: 1,
    readOnlyRoleVerified: true,
    databaseTemporaryPrivilege: roleEvidence.databaseTemporaryPrivilege,
    expectedIndexCount: indexes.length,
    costSelectedExpectedIndexCount: indexes.filter(
      (index) => index.selectedByCostedPlan,
    ).length,
    indexes: Object.freeze(indexes),
    planNodeCount: plan.nodeCount,
    rootNodeType: plan.rootNodeType,
    estimatedStartupCost: plan.estimatedStartupCost,
    estimatedTotalCost: plan.estimatedTotalCost,
    estimatedPlanRows: plan.estimatedPlanRows,
    sequentialScanRelations: plan.sequentialScanRelations,
  });
}

export async function auditPackageAllocationAuthorityDiscoveryPlan(
  client: QueryClient,
  options: PackageAllocationDiscoveryPlanAuditOptions,
): Promise<PackageAllocationDiscoveryPlanAuditReport> {
  const input = normalizePackageAllocationDiscoveryPlanAuditOptions(options);
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let report: PackageAllocationDiscoveryPlanAuditReport | undefined;
  let primaryFailure: unknown;
  try {
    report = await loadAuditInsideTransaction(client, input);
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
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "ROLLBACK_FAILED",
      "Package-allocation discovery plan audit and rollback both failed",
      {},
      new AggregateError([primaryFailure, rollbackFailure]),
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (rollbackFailure !== undefined) {
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "ROLLBACK_FAILED",
      "Package-allocation discovery plan audit rollback failed",
      {},
      rollbackFailure,
    );
  }
  if (!report) {
    throw new PackageAllocationDiscoveryPlanAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Package-allocation discovery plan audit completed without a report",
    );
  }
  return report;
}
