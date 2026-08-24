import { describe, expect, it } from "vitest";

import {
  PackageAllocationDiscoveryPlanAuditJobError,
  assertPackageAllocationDiscoveryPlanAuditEnabled,
  packageAllocationDiscoveryPlanAuditConnectionString,
  packageAllocationDiscoveryPlanAuditPoolConfig,
  parsePackageAllocationDiscoveryPlanAuditCliOptions,
  runPackageAllocationDiscoveryPlanAuditJob,
  type PackageAllocationDiscoveryPlanAuditPool,
} from "../../package-allocation-authority-discovery-plan-audit.job";
import type {
  PackageAllocationDiscoveryPlanAuditReport,
} from "../../../modules/shipping/package-allocation-authority-discovery-plan-audit.repository";

const LOCAL_URL = "postgresql://audit:test-password@localhost:5432/echelon";

function report(): PackageAllocationDiscoveryPlanAuditReport {
  return Object.freeze({
    mode: "read_only_explain",
    queryExecuted: false,
    sourceCount: 1,
    readOnlyRoleVerified: true,
    databaseTemporaryPrivilege: false,
    expectedIndexCount: 8,
    costSelectedExpectedIndexCount: 1,
    indexes: Object.freeze([Object.freeze({
      indexName: "idx_example",
      relationName: "example",
      selectedByCostedPlan: true,
    })]),
    planNodeCount: 2,
    rootNodeType: "Nested Loop",
    estimatedStartupCost: 0,
    estimatedTotalCost: 10,
    estimatedPlanRows: 1,
    sequentialScanRelations: Object.freeze([]),
  });
}

function runtime() {
  let value = 0;
  return { nowMs: () => value++ };
}

describe("package-allocation authority discovery plan audit job", () => {
  it("requires one bounded source identifier and rejects unknown or duplicate flags", () => {
    expect(parsePackageAllocationDiscoveryPlanAuditCliOptions(["--source-id=42"]))
      .toEqual({ help: false, sourceWmsShipmentItemId: 42 });
    expect(parsePackageAllocationDiscoveryPlanAuditCliOptions(["--help"]))
      .toEqual({ help: true, sourceWmsShipmentItemId: null });
    expect(() => parsePackageAllocationDiscoveryPlanAuditCliOptions([]))
      .toThrow("--source-id is required");
    expect(() => parsePackageAllocationDiscoveryPlanAuditCliOptions([
      "--source-id=1",
      "--source-id=2",
    ])).toThrow("Duplicate flag");
    expect(() => parsePackageAllocationDiscoveryPlanAuditCliOptions(["--source-id=2147483648"]))
      .toThrow("positive PostgreSQL integer");
    expect(() => parsePackageAllocationDiscoveryPlanAuditCliOptions(["--execute"]))
      .toThrow("Unknown flag");
  });

  it("requires the exact enable flag and dedicated audit URL", () => {
    expect(() => assertPackageAllocationDiscoveryPlanAuditEnabled({}))
      .toThrow("must be exactly 'true'");
    expect(() => assertPackageAllocationDiscoveryPlanAuditEnabled({
      PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_ENABLED: "TRUE",
    })).toThrow("must be exactly 'true'");
    expect(() => assertPackageAllocationDiscoveryPlanAuditEnabled({
      PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_ENABLED: "true",
    })).not.toThrow();
    expect(packageAllocationDiscoveryPlanAuditConnectionString({
      WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
      DATABASE_URL: "postgresql://do-not-use:secret@production.example.com/echelon",
    })).toBe(LOCAL_URL);
    expect(() => packageAllocationDiscoveryPlanAuditConnectionString({
      DATABASE_URL: LOCAL_URL,
    })).toThrow("WMS_INTEGRITY_AUDIT_DATABASE_URL is required");
  });

  it("pins client/server deadlines and explicit PostgreSQL startup fields", () => {
    expect(packageAllocationDiscoveryPlanAuditPoolConfig(LOCAL_URL, {
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 2_000,
      idleInTransactionTimeoutMs: 30_000,
    })).toMatchObject({
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

  it("returns aggregate evidence, releases the client, and closes the pool", async () => {
    const releaseArguments: unknown[] = [];
    let poolEnded = false;
    let observedSourceId: number | undefined;
    const client = {
      query: async () => ({ rows: [] }),
      release: (error?: Error | boolean) => releaseArguments.push(error),
    };
    const pool: PackageAllocationDiscoveryPlanAuditPool = {
      connect: async () => client,
      end: async () => { poolEnded = true; },
    };

    const result = await runPackageAllocationDiscoveryPlanAuditJob({
      sourceWmsShipmentItemId: 42,
      environment: {
        PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_ENABLED: "true",
        WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
      },
      poolFactory: () => pool,
      runtime: runtime(),
      auditPlan: async (_client, options) => {
        observedSourceId = options.sourceWmsShipmentItemId;
        return report();
      },
    });

    expect(observedSourceId).toBe(42);
    expect(releaseArguments).toEqual([undefined]);
    expect(poolEnded).toBe(true);
    expect(result).toMatchObject({
      mode: "read_only_explain",
      queryExecuted: false,
      sourceCount: 1,
      setupDurationMs: 1,
      connectDurationMs: 1,
      auditDurationMs: 1,
      cleanupDurationMs: 1,
      totalDurationMs: 9,
    });
    expect(JSON.stringify(result)).not.toContain("42");
  });

  it("preserves execution, release, and pool-end failures and discards the client", async () => {
    const executionFailure = new Error("audit failed");
    const releaseFailure = new Error("release failed");
    const endFailure = new Error("end failed");
    let releaseArgument: unknown;
    const pool: PackageAllocationDiscoveryPlanAuditPool = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: (error?: Error | boolean) => {
          releaseArgument = error;
          throw releaseFailure;
        },
      }),
      end: async () => { throw endFailure; },
    };

    let caught: unknown;
    try {
      await runPackageAllocationDiscoveryPlanAuditJob({
        sourceWmsShipmentItemId: 1,
        environment: {
          PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_ENABLED: "true",
          WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
        },
        poolFactory: () => pool,
        runtime: runtime(),
        auditPlan: async () => { throw executionFailure; },
      });
    } catch (error) {
      caught = error;
    }

    expect(releaseArgument).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(PackageAllocationDiscoveryPlanAuditJobError);
    expect(caught).toMatchObject({
      code: "PACKAGE_ALLOCATION_DISCOVERY_PLAN_AUDIT_EXECUTION_AND_CLEANUP_FAILED",
    });
    const aggregate = (caught as Error).cause;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors).toEqual([
      executionFailure,
      releaseFailure,
      endFailure,
    ]);
  });
});
