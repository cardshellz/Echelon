import type { PoolClient } from "pg";

import {
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL,
} from "./package-allocation-authority-discovery.query";
import {
  PackageAllocationDiscoveryPlanAuditRepositoryError,
  loadPackageAllocationAuthorityDiscoveryPlanAuditInsideTransaction,
  normalizePackageAllocationDiscoveryPlanAuditOptions,
  type NormalizedPackageAllocationDiscoveryPlanAuditOptions,
  type PackageAllocationDiscoveryPlanAuditOptions,
} from "./package-allocation-authority-discovery-plan-audit.repository";

type QueryClient = Pick<PoolClient, "query">;

const MAX_EXPLAIN_JSON_BYTES = 1_024 * 1_024;
const MAX_EXPLAIN_PLAN_NODES = 4_096;
const MAX_EXPLAIN_PLAN_DEPTH = 64;

/**
 * The execution checkpoint accepts only a source that exists and participates
 * in at least one root relationship used by the production discovery query.
 * This avoids treating an empty, unrelated identifier as runtime evidence.
 */
export const PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_SOURCE_ASSERTION_SQL = `
  WITH selected_source AS MATERIALIZED (
    SELECT source.id, source.shipment_id
    FROM wms.outbound_shipment_items AS source
    WHERE source.id = $1::integer
  )
  SELECT
    COUNT(*)::text AS source_count,
    COALESCE(BOOL_OR(
      EXISTS (
        SELECT 1
        FROM wms.physical_shipment_items AS physical_item
        WHERE physical_item.legacy_wms_shipment_item_id = source.id
      )
      OR EXISTS (
        SELECT 1
        FROM wms.shipment_request_items AS request_item
        WHERE request_item.legacy_wms_shipment_item_id = source.id
      )
      OR (
        source.shipment_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM wms.shipment_requests AS request
          WHERE request.legacy_wms_shipment_id = source.shipment_id
        )
      )
    ), false) AS has_relationship_anchor
  FROM selected_source AS source
`;

export const PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_ANALYZE_SQL =
  `EXPLAIN (ANALYZE TRUE, VERBOSE FALSE, COSTS TRUE, BUFFERS TRUE, `
  + `TIMING FALSE, SUMMARY TRUE, FORMAT JSON) `
  + PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL;

export type PackageAllocationDiscoveryExecutionAuditErrorCode =
  | "INVALID_DATABASE_EVIDENCE"
  | "NON_REPRESENTATIVE_SOURCE"
  | "ROLLBACK_FAILED";

export class PackageAllocationDiscoveryExecutionAuditRepositoryError extends Error {
  readonly code: PackageAllocationDiscoveryExecutionAuditErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(
    code: PackageAllocationDiscoveryExecutionAuditErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PackageAllocationDiscoveryExecutionAuditRepositoryError";
    this.code = code;
    this.context = Object.freeze({ ...context });
    this.cause = cause;
  }
}

export interface PackageAllocationDiscoveryExecutionAuditOptions
  extends PackageAllocationDiscoveryPlanAuditOptions {}

export interface PackageAllocationDiscoveryExecutionAuditIndexEvidence {
  readonly indexName: string;
  readonly relationName: string;
  readonly selectedByCostedPlan: boolean;
  readonly executedByAnalyzedQuery: boolean;
}

export interface PackageAllocationDiscoveryExecutionBufferEvidence {
  readonly sharedHitBlocks: number;
  readonly sharedReadBlocks: number;
  readonly sharedDirtiedBlocks: number;
  readonly sharedWrittenBlocks: number;
  readonly localHitBlocks: number;
  readonly localReadBlocks: number;
  readonly localDirtiedBlocks: number;
  readonly localWrittenBlocks: number;
  readonly tempReadBlocks: number;
  readonly tempWrittenBlocks: number;
}

export interface PackageAllocationDiscoveryExecutionAuditReport {
  readonly mode: "read_only_explain_analyze";
  readonly queryExecuted: true;
  readonly sourceCount: 1;
  readonly representativeSourceVerified: true;
  readonly readOnlyRoleVerified: true;
  readonly databaseTemporaryPrivilege: boolean;
  readonly expectedIndexCount: number;
  readonly costSelectedExpectedIndexCount: number;
  readonly executedExpectedIndexCount: number;
  readonly indexes: readonly PackageAllocationDiscoveryExecutionAuditIndexEvidence[];
  readonly costPlanNodeCount: number;
  readonly executionPlanNodeCount: number;
  readonly costRootNodeType: string;
  readonly executionRootNodeType: string;
  readonly estimatedStartupCost: number;
  readonly estimatedTotalCost: number;
  readonly estimatedPlanRows: number;
  readonly actualRows: number;
  readonly actualLoops: number;
  readonly planningTimeMs: number;
  readonly executionTimeMs: number;
  readonly executionBuffers: PackageAllocationDiscoveryExecutionBufferEvidence;
  readonly plannedSequentialScanRelations: readonly string[];
  readonly executedSequentialScanRelations: readonly string[];
}

interface ExecutionPlanSummary {
  readonly executedIndexNames: ReadonlySet<string>;
  readonly executedSequentialScanRelations: readonly string[];
  readonly nodeCount: number;
  readonly rootNodeType: string;
  readonly estimatedStartupCost: number;
  readonly estimatedTotalCost: number;
  readonly estimatedPlanRows: number;
  readonly actualRows: number;
  readonly actualLoops: number;
  readonly planningTimeMs: number;
  readonly executionTimeMs: number;
  readonly buffers: PackageAllocationDiscoveryExecutionBufferEvidence;
}

function invalidDatabaseEvidence(message: string, cause?: unknown): never {
  throw new PackageAllocationDiscoveryExecutionAuditRepositoryError(
    "INVALID_DATABASE_EVIDENCE",
    message,
    {},
    cause,
  );
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidDatabaseEvidence(`PostgreSQL returned invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return invalidDatabaseEvidence(`PostgreSQL returned invalid ${field}`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (value !== true && value !== false) {
    return invalidDatabaseEvidence(`PostgreSQL returned invalid ${field}`);
  }
  return value;
}

function nonnegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return invalidDatabaseEvidence(`PostgreSQL returned invalid ${field}`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = nonnegativeNumber(value, field);
  if (!Number.isSafeInteger(parsed)) {
    return invalidDatabaseEvidence(`PostgreSQL returned invalid ${field}`);
  }
  return parsed;
}

function safeCount(value: unknown, field: string): number {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(text)) {
    return invalidDatabaseEvidence(`PostgreSQL returned invalid ${field}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    return invalidDatabaseEvidence(`PostgreSQL returned out-of-range ${field}`);
  }
  return parsed;
}

function parsedExplainDocument(raw: unknown): Record<string, unknown> {
  let parsed = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > MAX_EXPLAIN_JSON_BYTES) {
      return invalidDatabaseEvidence("PostgreSQL EXPLAIN JSON exceeded its byte bound");
    }
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return invalidDatabaseEvidence("PostgreSQL returned malformed EXPLAIN JSON", error);
    }
  } else {
    let serialized: string;
    try {
      serialized = JSON.stringify(raw);
    } catch (error) {
      return invalidDatabaseEvidence("PostgreSQL returned non-serializable EXPLAIN JSON", error);
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_EXPLAIN_JSON_BYTES) {
      return invalidDatabaseEvidence("PostgreSQL EXPLAIN JSON exceeded its byte bound");
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    return invalidDatabaseEvidence("PostgreSQL EXPLAIN did not return one plan document");
  }
  return recordValue(parsed[0], "EXPLAIN document");
}

function rootBufferEvidence(
  root: Record<string, unknown>,
): PackageAllocationDiscoveryExecutionBufferEvidence {
  return Object.freeze({
    sharedHitBlocks: nonnegativeInteger(root["Shared Hit Blocks"], "shared hit blocks"),
    sharedReadBlocks: nonnegativeInteger(root["Shared Read Blocks"], "shared read blocks"),
    sharedDirtiedBlocks: nonnegativeInteger(
      root["Shared Dirtied Blocks"],
      "shared dirtied blocks",
    ),
    sharedWrittenBlocks: nonnegativeInteger(
      root["Shared Written Blocks"],
      "shared written blocks",
    ),
    localHitBlocks: nonnegativeInteger(root["Local Hit Blocks"], "local hit blocks"),
    localReadBlocks: nonnegativeInteger(root["Local Read Blocks"], "local read blocks"),
    localDirtiedBlocks: nonnegativeInteger(
      root["Local Dirtied Blocks"],
      "local dirtied blocks",
    ),
    localWrittenBlocks: nonnegativeInteger(
      root["Local Written Blocks"],
      "local written blocks",
    ),
    tempReadBlocks: nonnegativeInteger(root["Temp Read Blocks"], "temp read blocks"),
    tempWrittenBlocks: nonnegativeInteger(
      root["Temp Written Blocks"],
      "temp written blocks",
    ),
  });
}

export function summarizePackageAllocationDiscoveryExecutionPlan(
  raw: unknown,
): ExecutionPlanSummary {
  const document = parsedExplainDocument(raw);
  const root = recordValue(document.Plan, "EXPLAIN root plan");
  const expectedRelationNames = new Set(
    PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS.map(
      (relation) => relation.split(".")[1],
    ),
  );
  const executedIndexNames = new Set<string>();
  const executedSequentialScanRelations = new Set<string>();
  const pending: Array<{ node: Record<string, unknown>; depth: number }> = [
    { node: root, depth: 1 },
  ];
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodeCount += 1;
    if (nodeCount > MAX_EXPLAIN_PLAN_NODES || current.depth > MAX_EXPLAIN_PLAN_DEPTH) {
      return invalidDatabaseEvidence("PostgreSQL EXPLAIN plan exceeded its structural bound");
    }
    const nodeType = requiredText(current.node["Node Type"], "EXPLAIN node type");
    const actualLoops = nonnegativeNumber(
      current.node["Actual Loops"],
      "EXPLAIN actual loops",
    );
    const indexName = current.node["Index Name"];
    if (typeof indexName === "string" && actualLoops > 0) {
      executedIndexNames.add(indexName);
    }
    const relationName = current.node["Relation Name"];
    if (
      nodeType.includes("Seq Scan")
      && actualLoops > 0
      && typeof relationName === "string"
      && expectedRelationNames.has(relationName)
    ) {
      executedSequentialScanRelations.add(relationName);
    }
    const children = current.node.Plans;
    if (children !== undefined) {
      if (!Array.isArray(children)) {
        return invalidDatabaseEvidence("PostgreSQL EXPLAIN returned invalid child plans");
      }
      for (const child of children) {
        pending.push({
          node: recordValue(child, "EXPLAIN child plan"),
          depth: current.depth + 1,
        });
      }
    }
  }

  return Object.freeze({
    executedIndexNames,
    executedSequentialScanRelations: Object.freeze(
      [...executedSequentialScanRelations].sort(),
    ),
    nodeCount,
    rootNodeType: requiredText(root["Node Type"], "EXPLAIN root node type"),
    estimatedStartupCost: nonnegativeNumber(root["Startup Cost"], "EXPLAIN startup cost"),
    estimatedTotalCost: nonnegativeNumber(root["Total Cost"], "EXPLAIN total cost"),
    estimatedPlanRows: nonnegativeNumber(root["Plan Rows"], "EXPLAIN plan rows"),
    actualRows: nonnegativeNumber(root["Actual Rows"], "EXPLAIN actual rows"),
    actualLoops: nonnegativeNumber(root["Actual Loops"], "EXPLAIN actual loops"),
    planningTimeMs: nonnegativeNumber(document["Planning Time"], "EXPLAIN planning time"),
    executionTimeMs: nonnegativeNumber(document["Execution Time"], "EXPLAIN execution time"),
    buffers: rootBufferEvidence(root),
  });
}

async function assertRepresentativeSource(
  client: QueryClient,
  sourceWmsShipmentItemId: number,
): Promise<void> {
  const result = await client.query(
    PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_SOURCE_ASSERTION_SQL,
    [sourceWmsShipmentItemId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return invalidDatabaseEvidence(
      "PostgreSQL returned no package-allocation source preflight evidence",
    );
  }
  const sourceCount = safeCount(row.source_count, "source count");
  const hasRelationshipAnchor = requiredBoolean(
    row.has_relationship_anchor,
    "relationship-anchor evidence",
  );
  if (sourceCount !== 1 || !hasRelationshipAnchor) {
    throw new PackageAllocationDiscoveryExecutionAuditRepositoryError(
      "NON_REPRESENTATIVE_SOURCE",
      "The approved source is not a representative discovery-query input",
      { sourceCount, hasRelationshipAnchor },
    );
  }
}

async function loadExecutionAuditInsideTransaction(
  client: QueryClient,
  input: NormalizedPackageAllocationDiscoveryPlanAuditOptions,
): Promise<PackageAllocationDiscoveryExecutionAuditReport> {
  const costPlan = await loadPackageAllocationAuthorityDiscoveryPlanAuditInsideTransaction(
    client,
    input,
  );
  await assertRepresentativeSource(client, input.sourceWmsShipmentItemId);
  const explainResult = await client.query(
    PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_ANALYZE_SQL,
    [[input.sourceWmsShipmentItemId], PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES + 1],
  );
  const executionPlan = summarizePackageAllocationDiscoveryExecutionPlan(
    (explainResult.rows[0] as Record<string, unknown> | undefined)?.["QUERY PLAN"],
  );
  const indexes = costPlan.indexes.map((index) => Object.freeze({
    ...index,
    executedByAnalyzedQuery: executionPlan.executedIndexNames.has(index.indexName),
  }));

  return Object.freeze({
    mode: "read_only_explain_analyze",
    queryExecuted: true,
    sourceCount: 1,
    representativeSourceVerified: true,
    readOnlyRoleVerified: true,
    databaseTemporaryPrivilege: costPlan.databaseTemporaryPrivilege,
    expectedIndexCount: PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS.length,
    costSelectedExpectedIndexCount: costPlan.costSelectedExpectedIndexCount,
    executedExpectedIndexCount: indexes.filter(
      (index) => index.executedByAnalyzedQuery,
    ).length,
    indexes: Object.freeze(indexes),
    costPlanNodeCount: costPlan.planNodeCount,
    executionPlanNodeCount: executionPlan.nodeCount,
    costRootNodeType: costPlan.rootNodeType,
    executionRootNodeType: executionPlan.rootNodeType,
    estimatedStartupCost: executionPlan.estimatedStartupCost,
    estimatedTotalCost: executionPlan.estimatedTotalCost,
    estimatedPlanRows: executionPlan.estimatedPlanRows,
    actualRows: executionPlan.actualRows,
    actualLoops: executionPlan.actualLoops,
    planningTimeMs: executionPlan.planningTimeMs,
    executionTimeMs: executionPlan.executionTimeMs,
    executionBuffers: executionPlan.buffers,
    plannedSequentialScanRelations: costPlan.sequentialScanRelations,
    executedSequentialScanRelations: executionPlan.executedSequentialScanRelations,
  });
}

export async function auditPackageAllocationAuthorityDiscoveryExecution(
  client: QueryClient,
  options: PackageAllocationDiscoveryExecutionAuditOptions,
): Promise<PackageAllocationDiscoveryExecutionAuditReport> {
  const input = normalizePackageAllocationDiscoveryPlanAuditOptions(options);
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let report: PackageAllocationDiscoveryExecutionAuditReport | undefined;
  let primaryFailure: unknown;
  try {
    report = await loadExecutionAuditInsideTransaction(client, input);
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
    throw new PackageAllocationDiscoveryExecutionAuditRepositoryError(
      "ROLLBACK_FAILED",
      "Package-allocation discovery execution audit and rollback both failed",
      {},
      new AggregateError([primaryFailure, rollbackFailure]),
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (rollbackFailure !== undefined) {
    throw new PackageAllocationDiscoveryExecutionAuditRepositoryError(
      "ROLLBACK_FAILED",
      "Package-allocation discovery execution audit rollback failed",
      {},
      rollbackFailure,
    );
  }
  if (!report) {
    throw new PackageAllocationDiscoveryExecutionAuditRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Package-allocation discovery execution audit completed without a report",
    );
  }
  return report;
}

export function isPackageAllocationDiscoveryAuditRepositoryError(
  error: unknown,
): error is PackageAllocationDiscoveryPlanAuditRepositoryError
  | PackageAllocationDiscoveryExecutionAuditRepositoryError {
  return error instanceof PackageAllocationDiscoveryPlanAuditRepositoryError
    || error instanceof PackageAllocationDiscoveryExecutionAuditRepositoryError;
}
