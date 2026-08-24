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
  PackageAllocationDiscoveryPlanAuditRepositoryError,
  auditPackageAllocationAuthorityDiscoveryPlan,
  normalizePackageAllocationDiscoveryPlanAuditOptions,
} from "../../package-allocation-authority-discovery-plan-audit.repository";

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

function explainValue(): unknown {
  return [{
    Plan: {
      "Node Type": "Nested Loop",
      "Startup Cost": 0.42,
      "Total Cost": 19.75,
      "Plan Rows": 1,
      Plans: [
        {
          "Node Type": "Index Scan",
          "Index Name": PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS[0].indexName,
          "Relation Name": PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS[0].relationName,
        },
        {
          "Node Type": "Seq Scan",
          "Relation Name": "shipping_engine_orders",
        },
      ],
    },
  }];
}

function clientWithEvidence(options: {
  readonly catalog?: readonly Record<string, unknown>[];
  readonly explain?: unknown;
  readonly rollbackFailure?: Error;
  readonly relationEvidence?: Record<string, unknown>;
} = {}) {
  const queries: RecordedQuery[] = [];
  const client = {
    query: async (text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values: [...values] });
      if (text === "ROLLBACK" && options.rollbackFailure) throw options.rollbackFailure;
      if (text.includes("other_role_membership_count")) return result([readOnlyRoleRow()]);
      if (text === PACKAGE_ALLOCATION_DISCOVERY_RELATION_ASSERTION_SQL) {
        return result([options.relationEvidence ?? {
          missing_required_select_count: "0",
          required_rls_count: "0",
          missing_required_schema_usage_count: "0",
        }]);
      }
      if (text === PACKAGE_ALLOCATION_DISCOVERY_INDEX_CATALOG_SQL) {
        return result(options.catalog ?? catalogRows());
      }
      if (text === PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL) {
        return result([{ "QUERY PLAN": options.explain ?? explainValue() }]);
      }
      return result([]);
    },
  };
  return { client, queries };
}

describe("package-allocation authority discovery plan audit repository", () => {
  it("plans the exact production query without ANALYZE and emits aggregate evidence only", async () => {
    const { client, queries } = clientWithEvidence();

    const report = await auditPackageAllocationAuthorityDiscoveryPlan(client, {
      sourceWmsShipmentItemId: 12_345,
    });

    expect(queries[0].text).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
    expect(PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL).toContain(
      PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL,
    );
    expect(PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL).toMatch(/ANALYZE FALSE/i);
    expect(PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL).not.toMatch(/ANALYZE TRUE/i);
    const explainQuery = queries.find(
      (query) => query.text === PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL,
    );
    expect(explainQuery?.values).toEqual([
      [12_345],
      PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES + 1,
    ]);
    expect(report).toMatchObject({
      mode: "read_only_explain",
      queryExecuted: false,
      sourceCount: 1,
      readOnlyRoleVerified: true,
      expectedIndexCount: PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS.length,
      costSelectedExpectedIndexCount: 1,
      planNodeCount: 3,
      rootNodeType: "Nested Loop",
      estimatedStartupCost: 0.42,
      estimatedTotalCost: 19.75,
      estimatedPlanRows: 1,
      sequentialScanRelations: ["shipping_engine_orders"],
    });
    expect(report.indexes[0]).toMatchObject({ selectedByCostedPlan: true });
    expect(JSON.stringify(report)).not.toContain("12345");

    const roleQueryIndex = queries.findIndex((query) =>
      query.text.includes("other_role_membership_count"),
    );
    const relationQueryIndex = queries.findIndex(
      (query) => query.text === PACKAGE_ALLOCATION_DISCOVERY_RELATION_ASSERTION_SQL,
    );
    const catalogQueryIndex = queries.findIndex(
      (query) => query.text === PACKAGE_ALLOCATION_DISCOVERY_INDEX_CATALOG_SQL,
    );
    const explainQueryIndex = queries.findIndex(
      (query) => query.text === PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL,
    );
    expect(roleQueryIndex).toBeGreaterThan(0);
    expect(relationQueryIndex).toBeGreaterThan(roleQueryIndex);
    expect(catalogQueryIndex).toBeGreaterThan(relationQueryIndex);
    expect(explainQueryIndex).toBeGreaterThan(catalogQueryIndex);
  });

  it("rejects invalid input before starting a transaction", () => {
    expect(() => normalizePackageAllocationDiscoveryPlanAuditOptions({
      sourceWmsShipmentItemId: 0,
    })).toThrow("positive PostgreSQL integer");
    expect(() => normalizePackageAllocationDiscoveryPlanAuditOptions({
      sourceWmsShipmentItemId: 1,
      statementTimeoutMs: 60_001,
    })).toThrow("statementTimeoutMs");
  });

  it("fails closed and rolls back when an expected index is absent", async () => {
    const rows = catalogRows();
    rows[0] = {
      index_name: PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS[0].indexName,
      expected_relation_name:
        PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS[0].relationName,
      relation_schema: null,
      actual_relation_name: null,
      access_method: null,
      indisvalid: null,
      indisready: null,
      indislive: null,
      indisunique: null,
      key_columns: [],
      predicate: null,
    };
    const { client, queries } = clientWithEvidence({ catalog: rows });

    await expect(auditPackageAllocationAuthorityDiscoveryPlan(client, {
      sourceWmsShipmentItemId: 1,
    })).rejects.toMatchObject({
      code: "DISCOVERY_INDEX_CONTRACT_MISMATCH",
      context: {
        mismatches: [
          `${PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS[0].indexName}:missing`,
        ],
      },
    });
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
    expect(queries.some((query) => query.text === PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL))
      .toBe(false);
  });

  it("stops before catalog access when a discovery relation grant is missing", async () => {
    const { client, queries } = clientWithEvidence({
      relationEvidence: {
        missing_required_select_count: "1",
        required_rls_count: "0",
        missing_required_schema_usage_count: "0",
      },
    });

    await expect(auditPackageAllocationAuthorityDiscoveryPlan(client, {
      sourceWmsShipmentItemId: 1,
    })).rejects.toMatchObject({
      code: "INVALID_DATABASE_EVIDENCE",
      context: {
        missingRequiredSelectCount: 1,
        requiredRlsCount: 0,
        missingRequiredSchemaUsageCount: 0,
      },
    });
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
    expect(queries.some(
      (query) => query.text === PACKAGE_ALLOCATION_DISCOVERY_INDEX_CATALOG_SQL,
    )).toBe(false);
  });

  it("rejects malformed EXPLAIN evidence and still rolls back", async () => {
    const { client, queries } = clientWithEvidence({
      explain: [{ Plan: { "Node Type": "Result", Plans: "invalid" } }],
    });

    await expect(auditPackageAllocationAuthorityDiscoveryPlan(client, {
      sourceWmsShipmentItemId: 1,
    })).rejects.toMatchObject({ code: "INVALID_DATABASE_EVIDENCE" });
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("preserves both the primary and rollback failures", async () => {
    const primaryFailure = new Error("malformed plan");
    const rollbackFailure = new Error("rollback failed");
    const { client } = clientWithEvidence({
      explain: {
        toString() {
          throw primaryFailure;
        },
      },
      rollbackFailure,
    });

    let caught: unknown;
    try {
      await auditPackageAllocationAuthorityDiscoveryPlan(client, {
        sourceWmsShipmentItemId: 1,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PackageAllocationDiscoveryPlanAuditRepositoryError);
    expect(caught).toMatchObject({ code: "ROLLBACK_FAILED" });
    const aggregate = (caught as Error).cause;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors).toContain(rollbackFailure);
  });
});
