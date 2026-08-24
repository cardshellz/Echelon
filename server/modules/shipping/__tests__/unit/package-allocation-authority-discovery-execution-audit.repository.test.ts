import { describe, expect, it } from "vitest";

import {
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL,
} from "../../package-allocation-authority-discovery.query";
import {
  PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL,
  PACKAGE_ALLOCATION_DISCOVERY_INDEX_CATALOG_SQL,
  PACKAGE_ALLOCATION_DISCOVERY_RELATION_ASSERTION_SQL,
} from "../../package-allocation-authority-discovery-plan-audit.repository";
import {
  PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_SOURCE_ASSERTION_SQL,
  PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_ANALYZE_SQL,
  PackageAllocationDiscoveryExecutionAuditRepositoryError,
  auditPackageAllocationAuthorityDiscoveryExecution,
  summarizePackageAllocationDiscoveryExecutionPlan,
} from "../../package-allocation-authority-discovery-execution-audit.repository";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function result(rows: readonly Record<string, unknown>[]) {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows: [...rows],
  };
}

function readOnlyRoleRow(): Record<string, unknown> {
  return {
    transaction_read_only: "on",
    missing_required_select_count: "0",
    required_rls_count: "0",
    missing_required_schema_usage_count: "0",
    mutable_table_count: "0",
    mutable_column_relation_count: "0",
    mutable_sequence_count: "0",
    sequence_usage_count: "0",
    mutable_schema_count: "0",
    mutable_database: false,
    database_temporary_privilege: false,
    other_role_membership_count: "0",
    elevated_role: false,
  };
}

function catalogRows(): Record<string, unknown>[] {
  return PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS.map((contract) => ({
    index_name: contract.indexName,
    expected_relation_name: contract.relationName,
    relation_schema: "wms",
    actual_relation_name: contract.relationName,
    access_method: "btree",
    indisvalid: true,
    indisready: true,
    indislive: true,
    indisunique: false,
    key_columns: [...contract.keyColumns],
    predicate: `(${contract.predicateColumn} IS NOT NULL)`,
  }));
}

function costPlan(): unknown {
  return [{
    Plan: {
      "Node Type": "Nested Loop",
      "Startup Cost": 0.42,
      "Total Cost": 19.75,
      "Plan Rows": 1,
      Plans: [{
        "Node Type": "Index Scan",
        "Index Name": PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS[0].indexName,
        "Relation Name": PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS[0].relationName,
      }],
    },
  }];
}

function executionPlan(): unknown {
  return [{
    Plan: {
      "Node Type": "Nested Loop",
      "Startup Cost": 0.42,
      "Total Cost": 19.75,
      "Plan Rows": 1,
      "Actual Rows": 1,
      "Actual Loops": 1,
      "Shared Hit Blocks": 12,
      "Shared Read Blocks": 3,
      "Shared Dirtied Blocks": 0,
      "Shared Written Blocks": 0,
      "Local Hit Blocks": 0,
      "Local Read Blocks": 0,
      "Local Dirtied Blocks": 0,
      "Local Written Blocks": 0,
      "Temp Read Blocks": 0,
      "Temp Written Blocks": 0,
      Plans: [
        {
          "Node Type": "Index Scan",
          "Index Name": PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS[0].indexName,
          "Relation Name": PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS[0].relationName,
          "Actual Loops": 1,
        },
        {
          "Node Type": "Seq Scan",
          "Relation Name": "shipping_engine_orders",
          "Actual Loops": 1,
        },
      ],
    },
    "Planning Time": 0.5,
    "Execution Time": 1.25,
  }];
}

function clientWithEvidence(options: {
  readonly executionPlan?: unknown;
  readonly hasRelationshipAnchor?: boolean;
  readonly rollbackFailure?: Error;
  readonly sourceCount?: string;
} = {}) {
  const queries: RecordedQuery[] = [];
  const client = {
    query: async (text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values: [...values] });
      if (text === "ROLLBACK" && options.rollbackFailure) throw options.rollbackFailure;
      if (text.includes("other_role_membership_count")) return result([readOnlyRoleRow()]);
      if (text === PACKAGE_ALLOCATION_DISCOVERY_RELATION_ASSERTION_SQL) {
        return result([{
          missing_required_select_count: "0",
          required_rls_count: "0",
          missing_required_schema_usage_count: "0",
        }]);
      }
      if (text === PACKAGE_ALLOCATION_DISCOVERY_INDEX_CATALOG_SQL) {
        return result(catalogRows());
      }
      if (text === PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL) {
        return result([{ "QUERY PLAN": costPlan() }]);
      }
      if (text === PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_SOURCE_ASSERTION_SQL) {
        return result([{
          source_count: options.sourceCount ?? "1",
          has_relationship_anchor: options.hasRelationshipAnchor ?? true,
        }]);
      }
      if (text === PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_ANALYZE_SQL) {
        return result([{ "QUERY PLAN": options.executionPlan ?? executionPlan() }]);
      }
      return result([]);
    },
  };
  return { client, queries };
}

describe("package-allocation authority discovery execution audit repository", () => {
  it("executes the exact discovery SELECT once and emits bounded aggregate evidence", async () => {
    const { client, queries } = clientWithEvidence();

    const report = await auditPackageAllocationAuthorityDiscoveryExecution(client, {
      sourceWmsShipmentItemId: 12_345,
    });

    expect(queries[0].text).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
    expect(PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_ANALYZE_SQL).toContain(
      PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL,
    );
    expect(PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_ANALYZE_SQL).toMatch(/ANALYZE TRUE/i);
    expect(PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_ANALYZE_SQL).toMatch(/BUFFERS TRUE/i);
    expect(PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_ANALYZE_SQL).toMatch(/TIMING FALSE/i);
    const executionQuery = queries.find(
      (query) => query.text === PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_ANALYZE_SQL,
    );
    expect(executionQuery?.values).toEqual([
      [12_345],
      PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES + 1,
    ]);
    expect(report).toMatchObject({
      mode: "read_only_explain_analyze",
      queryExecuted: true,
      sourceCount: 1,
      representativeSourceVerified: true,
      readOnlyRoleVerified: true,
      costSelectedExpectedIndexCount: 1,
      executedExpectedIndexCount: 1,
      costPlanNodeCount: 2,
      executionPlanNodeCount: 3,
      costRootNodeType: "Nested Loop",
      executionRootNodeType: "Nested Loop",
      actualRows: 1,
      actualLoops: 1,
      planningTimeMs: 0.5,
      executionTimeMs: 1.25,
      executionBuffers: {
        sharedHitBlocks: 12,
        sharedReadBlocks: 3,
        sharedDirtiedBlocks: 0,
        sharedWrittenBlocks: 0,
        localHitBlocks: 0,
        localReadBlocks: 0,
        localDirtiedBlocks: 0,
        localWrittenBlocks: 0,
        tempReadBlocks: 0,
        tempWrittenBlocks: 0,
      },
      executedSequentialScanRelations: ["shipping_engine_orders"],
    });
    expect(report.indexes[0]).toMatchObject({
      selectedByCostedPlan: true,
      executedByAnalyzedQuery: true,
    });
    expect(JSON.stringify(report)).not.toContain("12345");

    const sourceAssertionIndex = queries.findIndex(
      (query) => query.text === PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_SOURCE_ASSERTION_SQL,
    );
    const executionIndex = queries.findIndex(
      (query) => query.text === PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_ANALYZE_SQL,
    );
    expect(sourceAssertionIndex).toBeGreaterThan(0);
    expect(executionIndex).toBeGreaterThan(sourceAssertionIndex);
  });

  it("fails closed before execution for a missing or unrelated source", async () => {
    const { client, queries } = clientWithEvidence({ hasRelationshipAnchor: false });

    await expect(auditPackageAllocationAuthorityDiscoveryExecution(client, {
      sourceWmsShipmentItemId: 1,
    })).rejects.toMatchObject({
      code: "NON_REPRESENTATIVE_SOURCE",
      context: { sourceCount: 1, hasRelationshipAnchor: false },
    });
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
    expect(queries.some(
      (query) => query.text === PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_ANALYZE_SQL,
    )).toBe(false);
  });

  it("rejects malformed or oversized execution evidence", async () => {
    const { client, queries } = clientWithEvidence({
      executionPlan: [{ Plan: { "Node Type": "Result", Plans: "invalid" } }],
    });

    await expect(auditPackageAllocationAuthorityDiscoveryExecution(client, {
      sourceWmsShipmentItemId: 1,
    })).rejects.toMatchObject({ code: "INVALID_DATABASE_EVIDENCE" });
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
    expect(() => summarizePackageAllocationDiscoveryExecutionPlan("x".repeat(1_024 * 1_024 + 1)))
      .toThrowError(PackageAllocationDiscoveryExecutionAuditRepositoryError);
  });

  it("preserves both execution and rollback failures", async () => {
    const rollbackFailure = new Error("rollback failed");
    const { client } = clientWithEvidence({
      executionPlan: [{ Plan: { "Node Type": "Result", Plans: "invalid" } }],
      rollbackFailure,
    });

    let caught: unknown;
    try {
      await auditPackageAllocationAuthorityDiscoveryExecution(client, {
        sourceWmsShipmentItemId: 1,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PackageAllocationDiscoveryExecutionAuditRepositoryError);
    expect(caught).toMatchObject({ code: "ROLLBACK_FAILED" });
    const aggregate = (caught as Error).cause;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors).toContain(rollbackFailure);
  });
});
