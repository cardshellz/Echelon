import { describe, expect, it } from "vitest";

import type {
  PackageAllocationDiscoveryExecutionAuditReport,
} from "../../../modules/shipping/package-allocation-authority-discovery-execution-audit.repository";
import {
  PackageAllocationDiscoveryExecutionAuditJobError,
  assertPackageAllocationDiscoveryExecutionAuditEnabled,
  packageAllocationDiscoveryExecutionAuditPoolConfig,
  runPackageAllocationDiscoveryExecutionAuditJob,
} from "../../package-allocation-authority-discovery-execution-audit.job";
import type {
  PackageAllocationDiscoveryPlanAuditPool,
} from "../../package-allocation-authority-discovery-plan-audit.job";

const LOCAL_URL = "postgresql://audit:test-password@localhost:5432/echelon";

function report(): PackageAllocationDiscoveryExecutionAuditReport {
  return Object.freeze({
    mode: "read_only_explain_analyze",
    queryExecuted: true,
    sourceCount: 1,
    representativeSourceVerified: true,
    readOnlyRoleVerified: true,
    databaseTemporaryPrivilege: false,
    expectedIndexCount: 8,
    costSelectedExpectedIndexCount: 1,
    executedExpectedIndexCount: 1,
    indexes: Object.freeze([Object.freeze({
      indexName: "idx_example",
      relationName: "example",
      selectedByCostedPlan: true,
      executedByAnalyzedQuery: true,
    })]),
    costPlanNodeCount: 2,
    executionPlanNodeCount: 2,
    costRootNodeType: "Nested Loop",
    executionRootNodeType: "Nested Loop",
    estimatedStartupCost: 0,
    estimatedTotalCost: 10,
    estimatedPlanRows: 1,
    actualRows: 1,
    actualLoops: 1,
    planningTimeMs: 0.5,
    executionTimeMs: 1.25,
    executionBuffers: Object.freeze({
      sharedHitBlocks: 1,
      sharedReadBlocks: 0,
      sharedDirtiedBlocks: 0,
      sharedWrittenBlocks: 0,
      localHitBlocks: 0,
      localReadBlocks: 0,
      localDirtiedBlocks: 0,
      localWrittenBlocks: 0,
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
    }),
    plannedSequentialScanRelations: Object.freeze([]),
    executedSequentialScanRelations: Object.freeze([]),
  });
}

function runtime() {
  let value = 0;
  return { nowMs: () => value++ };
}

describe("package-allocation authority discovery execution audit job", () => {
  it("requires its own exact enable flag", () => {
    expect(() => assertPackageAllocationDiscoveryExecutionAuditEnabled({}))
      .toThrow("must be exactly 'true'");
    expect(() => assertPackageAllocationDiscoveryExecutionAuditEnabled({
      PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_ENABLED: "TRUE",
    })).toThrow("must be exactly 'true'");
    expect(() => assertPackageAllocationDiscoveryExecutionAuditEnabled({
      PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_ENABLED: "true",
    })).not.toThrow();
  });

  it("uses the dedicated application name and the existing bounded deadlines", () => {
    expect(packageAllocationDiscoveryExecutionAuditPoolConfig(LOCAL_URL, {
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 2_000,
      idleInTransactionTimeoutMs: 30_000,
    })).toMatchObject({
      application_name: "package-allocation-discovery-execution-audit",
      host: "localhost",
      port: 5_432,
      user: "audit",
      password: "test-password",
      database: "echelon",
      ssl: false,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 20_000,
      query_timeout: 25_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 45_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
  });

  it("returns aggregate evidence and always releases and closes resources", async () => {
    const releaseArguments: unknown[] = [];
    let poolEnded = false;
    let observedSourceId: number | undefined;
    const pool: PackageAllocationDiscoveryPlanAuditPool = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: (error?: Error | boolean) => releaseArguments.push(error),
      }),
      end: async () => { poolEnded = true; },
    };

    const result = await runPackageAllocationDiscoveryExecutionAuditJob({
      sourceWmsShipmentItemId: 42,
      environment: {
        PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_ENABLED: "true",
        WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
      },
      poolFactory: () => pool,
      runtime: runtime(),
      auditExecution: async (_client, options) => {
        observedSourceId = options.sourceWmsShipmentItemId;
        return report();
      },
    });

    expect(observedSourceId).toBe(42);
    expect(releaseArguments).toEqual([undefined]);
    expect(poolEnded).toBe(true);
    expect(result).toMatchObject({
      mode: "read_only_explain_analyze",
      queryExecuted: true,
      sourceCount: 1,
      setupDurationMs: 1,
      connectDurationMs: 1,
      auditDurationMs: 1,
      cleanupDurationMs: 1,
      totalDurationMs: 9,
    });
    expect(JSON.stringify(result)).not.toContain("42");
  });

  it("preserves execution, release, and pool-end failures", async () => {
    const executionFailure = new Error("audit failed");
    const releaseFailure = new Error("release failed");
    const endFailure = new Error("end failed");
    const pool: PackageAllocationDiscoveryPlanAuditPool = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => { throw releaseFailure; },
      }),
      end: async () => { throw endFailure; },
    };

    let caught: unknown;
    try {
      await runPackageAllocationDiscoveryExecutionAuditJob({
        sourceWmsShipmentItemId: 1,
        environment: {
          PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_ENABLED: "true",
          WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
        },
        poolFactory: () => pool,
        runtime: runtime(),
        auditExecution: async () => { throw executionFailure; },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PackageAllocationDiscoveryExecutionAuditJobError);
    expect(caught).toMatchObject({
      code: "PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_EXECUTION_AND_CLEANUP_FAILED",
    });
    expect(((caught as Error).cause as AggregateError).errors).toEqual([
      executionFailure,
      releaseFailure,
      endFailure,
    ]);
  });
});
