import { describe, expect, it } from "vitest";

import type {
  PackageAllocationAuthorityResolutionDiscoveryPreviewResultV1,
} from "../../../modules/shipping/package-allocation-authority-resolution.service";
import type {
  PackageAllocationDiscoveryPlanAuditReport,
} from "../../../modules/shipping/package-allocation-authority-discovery-plan-audit.repository";
import {
  PackageAllocationAuthorityResolutionAuditJobError,
  assertPackageAllocationAuthorityResolutionAuditEnabled,
  packageAllocationAuthorityResolutionAuditPoolConfig,
  parsePackageAllocationAuthorityResolutionAuditCliOptions,
  runPackageAllocationAuthorityResolutionAuditJob,
  summarizePackageAllocationAuthorityResolutionAudit,
  type PackageAllocationAuthorityResolutionAuditReport,
} from "../../package-allocation-authority-resolution-audit.job";
import type {
  PackageAllocationDiscoveryPlanAuditPool,
} from "../../package-allocation-authority-discovery-plan-audit.job";

const LOCAL_URL = "postgresql://audit:test-password@localhost:5432/echelon";
const GROUP_KEY = "86e1be0d-c7d8-4c91-919f-04f5eb547f79";

function planReport(): PackageAllocationDiscoveryPlanAuditReport {
  return Object.freeze({
    mode: "read_only_explain",
    queryExecuted: false,
    sourceCount: 1,
    readOnlyRoleVerified: true,
    databaseTemporaryPrivilege: false,
    expectedIndexCount: 8,
    costSelectedExpectedIndexCount: 8,
    indexes: Object.freeze([]),
    planNodeCount: 10,
    rootNodeType: "Sort",
    estimatedStartupCost: 0,
    estimatedTotalCost: 10,
    estimatedPlanRows: 2,
    sequentialScanRelations: Object.freeze([]),
  });
}

function previewResult(
  executable = false,
): PackageAllocationAuthorityResolutionDiscoveryPreviewResultV1 {
  return {
    contractVersion: 1,
    authority: "none",
    outcome: "review",
    previewMode: "bootstrap_relationship_discovery",
    selectionAuthority: "database_relationship_closure",
    selectionCompleteness: "unproven_outside_persisted_relationships",
    selectedShippingProviderLabelIds: [42, 43],
    groupState: "absent",
    readiness: {
      packageAssessments: [
        { lifecycleStatus: "projected" },
        { lifecycleStatus: "rejected" },
      ],
      reviews: [
        { code: "package_membership_policy_unresolved" },
        { code: "package_membership_policy_unresolved" },
      ],
    },
    resolution: {
      outcome: "review",
      reviews: [{ code: "package_contents_unavailable" }],
      plannerResult: {
        state: {
          allocations: [{}, {}],
          desiredEffectIntents: [
            { executable },
            { executable: false },
          ],
        },
      },
    },
  } as unknown as PackageAllocationAuthorityResolutionDiscoveryPreviewResultV1;
}

function aggregateReport(): PackageAllocationAuthorityResolutionAuditReport {
  return summarizePackageAllocationAuthorityResolutionAudit(
    planReport(),
    previewResult(),
  );
}

function runtime() {
  let value = 0;
  return { nowMs: () => value++ };
}

describe("package-allocation authority resolution audit job", () => {
  it("requires its own exact flag and strict one-source CLI scope", () => {
    expect(() => assertPackageAllocationAuthorityResolutionAuditEnabled({}))
      .toThrow("must be exactly 'true'");
    expect(() => assertPackageAllocationAuthorityResolutionAuditEnabled({
      PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_ENABLED: "TRUE",
    })).toThrow("must be exactly 'true'");
    expect(() => assertPackageAllocationAuthorityResolutionAuditEnabled({
      PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_ENABLED: "true",
    })).not.toThrow();

    expect(parsePackageAllocationAuthorityResolutionAuditCliOptions([
      "--source-id=42",
      `--group-key=${GROUP_KEY.toUpperCase()}`,
    ])).toEqual({
      help: false,
      sourceWmsShipmentItemId: 42,
      groupKey: GROUP_KEY,
    });
    expect(() => parsePackageAllocationAuthorityResolutionAuditCliOptions([
      "--source-id=42",
    ])).toThrow("--group-key is required");
    expect(() => parsePackageAllocationAuthorityResolutionAuditCliOptions([
      "--source-id=42",
      "--group-key=not-a-uuid",
    ])).toThrow("--group-key must be a UUID");
  });

  it("uses the dedicated application name and bounded audit deadlines", () => {
    expect(packageAllocationAuthorityResolutionAuditPoolConfig(LOCAL_URL, {
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 2_000,
      idleInTransactionTimeoutMs: 30_000,
    })).toMatchObject({
      application_name: "package-allocation-authority-resolution-audit",
      host: "localhost",
      user: "audit",
      password: "test-password",
      database: "echelon",
      ssl: false,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 20_000,
      query_timeout: 25_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 45_000,
      allowExitOnIdle: true,
    });
  });

  it("emits only aggregate shadow evidence and rejects executable intents", () => {
    const report = aggregateReport();

    expect(report).toEqual({
      mode: "read_only_resolution_preview",
      queryExecuted: true,
      sourceCount: 1,
      readOnlyRoleVerified: true,
      databaseTemporaryPrivilege: false,
      expectedIndexCount: 8,
      costSelectedExpectedIndexCount: 8,
      plannedSequentialScanCount: 0,
      selectionAuthority: "database_relationship_closure",
      selectionCompleteness: "unproven_outside_persisted_relationships",
      groupState: "absent",
      selectedPackageCount: 2,
      projectedPackageCount: 1,
      rejectedPackageCount: 1,
      readinessReviewCodes: ["package_membership_policy_unresolved"],
      resolutionOutcome: "review",
      resolutionReviewCodes: ["package_contents_unavailable"],
      allocationCount: 2,
      desiredEffectIntentCount: 2,
      executableEffectIntentCount: 0,
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(() => summarizePackageAllocationAuthorityResolutionAudit(
      planReport(),
      previewResult(true),
    )).toThrow("executable effect intent");
  });

  it("returns aggregate evidence and always releases and closes resources", async () => {
    const releaseArguments: unknown[] = [];
    let poolEnded = false;
    let observedSourceId: number | undefined;
    let observedGroupKey: string | undefined;
    const pool: PackageAllocationDiscoveryPlanAuditPool = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: (error?: Error | boolean) => releaseArguments.push(error),
      }),
      end: async () => { poolEnded = true; },
    };

    const result = await runPackageAllocationAuthorityResolutionAuditJob({
      sourceWmsShipmentItemId: 42,
      groupKey: GROUP_KEY,
      environment: {
        PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_ENABLED: "true",
        WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
      },
      poolFactory: () => pool,
      runtime: runtime(),
      auditResolution: async (_client, options, groupKey) => {
        observedSourceId = options.sourceWmsShipmentItemId;
        observedGroupKey = groupKey;
        return aggregateReport();
      },
    });

    expect(observedSourceId).toBe(42);
    expect(observedGroupKey).toBe(GROUP_KEY);
    expect(releaseArguments).toEqual([undefined]);
    expect(poolEnded).toBe(true);
    expect(result).toMatchObject({
      mode: "read_only_resolution_preview",
      selectedPackageCount: 2,
      executableEffectIntentCount: 0,
      setupDurationMs: 1,
      connectDurationMs: 1,
      auditDurationMs: 1,
      cleanupDurationMs: 1,
      totalDurationMs: 9,
    });
    expect(JSON.stringify(result)).not.toContain(GROUP_KEY);
    expect(JSON.stringify(result)).not.toContain("shipping-provider-label");
  });

  it("preserves resolution, release, and pool-end failures", async () => {
    const resolutionFailure = new Error("resolution failed");
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
      await runPackageAllocationAuthorityResolutionAuditJob({
        sourceWmsShipmentItemId: 1,
        groupKey: GROUP_KEY,
        environment: {
          PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_ENABLED: "true",
          WMS_INTEGRITY_AUDIT_DATABASE_URL: LOCAL_URL,
        },
        poolFactory: () => pool,
        runtime: runtime(),
        auditResolution: async () => { throw resolutionFailure; },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PackageAllocationAuthorityResolutionAuditJobError);
    expect(caught).toMatchObject({
      code: "PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_EXECUTION_AND_CLEANUP_FAILED",
    });
    expect(((caught as Error).cause as AggregateError).errors).toEqual([
      resolutionFailure,
      releaseFailure,
      endFailure,
    ]);
  });
});
