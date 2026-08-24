import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PoolConfig } from "pg";

import {
  PackageAllocationDiscoveryExecutionAuditRepositoryError,
  auditPackageAllocationAuthorityDiscoveryExecution,
  isPackageAllocationDiscoveryAuditRepositoryError,
  type PackageAllocationDiscoveryExecutionAuditReport,
} from "../modules/shipping/package-allocation-authority-discovery-execution-audit.repository";
import type {
  NormalizedPackageAllocationDiscoveryPlanAuditOptions,
} from "../modules/shipping/package-allocation-authority-discovery-plan-audit.repository";
import {
  packageAllocationDiscoveryPlanAuditPoolConfig,
  parsePackageAllocationDiscoveryPlanAuditCliOptions,
  runPackageAllocationDiscoveryAuditJob,
  type PackageAllocationDiscoveryAuditJobTimingEvidence,
  type PackageAllocationDiscoveryPlanAuditPoolFactory,
  type PackageAllocationDiscoveryPlanAuditRuntimeDependencies,
} from "./package-allocation-authority-discovery-plan-audit.job";

const APPLICATION_NAME = "package-allocation-discovery-execution-audit";

export interface PackageAllocationDiscoveryExecutionAuditJobResult
  extends PackageAllocationDiscoveryExecutionAuditReport,
    PackageAllocationDiscoveryAuditJobTimingEvidence {}

export type PackageAllocationDiscoveryExecutionAuditJobErrorCode =
  | "PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_CLEANUP_FAILED"
  | "PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_EXECUTION_AND_CLEANUP_FAILED";

export class PackageAllocationDiscoveryExecutionAuditJobError extends Error {
  readonly code: PackageAllocationDiscoveryExecutionAuditJobErrorCode;

  constructor(
    code: PackageAllocationDiscoveryExecutionAuditJobErrorCode,
    message: string,
    failures: readonly unknown[],
  ) {
    super(message, { cause: new AggregateError([...failures], message) });
    this.name = "PackageAllocationDiscoveryExecutionAuditJobError";
    this.code = code;
  }
}

export function assertPackageAllocationDiscoveryExecutionAuditEnabled(
  environment: NodeJS.ProcessEnv,
): void {
  if (environment.PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_ENABLED !== "true") {
    throw new Error(
      "PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_ENABLED must be exactly 'true'",
    );
  }
}

export function packageAllocationDiscoveryExecutionAuditPoolConfig(
  connectionString: string,
  repositoryOptions: Pick<
    NormalizedPackageAllocationDiscoveryPlanAuditOptions,
    "statementTimeoutMs" | "lockTimeoutMs" | "idleInTransactionTimeoutMs"
  >,
): PoolConfig {
  return packageAllocationDiscoveryPlanAuditPoolConfig(
    connectionString,
    repositoryOptions,
    APPLICATION_NAME,
  );
}

export async function runPackageAllocationDiscoveryExecutionAuditJob(options: {
  readonly sourceWmsShipmentItemId: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly poolFactory?: PackageAllocationDiscoveryPlanAuditPoolFactory;
  readonly runtime?: PackageAllocationDiscoveryPlanAuditRuntimeDependencies;
  readonly auditExecution?: typeof auditPackageAllocationAuthorityDiscoveryExecution;
}): Promise<PackageAllocationDiscoveryExecutionAuditJobResult> {
  return runPackageAllocationDiscoveryAuditJob({
    sourceWmsShipmentItemId: options.sourceWmsShipmentItemId,
    environment: options.environment,
    poolFactory: options.poolFactory,
    runtime: options.runtime,
    assertEnabled: assertPackageAllocationDiscoveryExecutionAuditEnabled,
    applicationName: APPLICATION_NAME,
    audit: options.auditExecution ?? auditPackageAllocationAuthorityDiscoveryExecution,
    auditLabel: "package-allocation discovery execution audit",
    createCleanupError: (kind, failures) => (
      new PackageAllocationDiscoveryExecutionAuditJobError(
        kind === "cleanup"
          ? "PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_CLEANUP_FAILED"
          : "PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_EXECUTION_AND_CLEANUP_FAILED",
        kind === "cleanup"
          ? "Package-allocation discovery execution audit cleanup failed"
          : "Package-allocation discovery execution audit execution and cleanup both failed",
        failures,
      )
    ),
  });
}

function usage(): string {
  return [
    "Usage:",
    "  npm run wms:audit-package-allocation-discovery-execution -- --source-id=N",
    "",
    "Executes one bounded PostgreSQL SELECT through EXPLAIN ANALYZE under the",
    "dedicated read-only audit role. The source identifier is never emitted.",
  ].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parsePackageAllocationDiscoveryPlanAuditCliOptions(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runPackageAllocationDiscoveryExecutionAuditJob({
    sourceWmsShipmentItemId: options.sourceWmsShipmentItemId!,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function isDirectExecution(metaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  return path.resolve(argvEntry) === fileURLToPath(metaUrl);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    const errorCode = isPackageAllocationDiscoveryAuditRepositoryError(error)
      ? error.code
      : error instanceof PackageAllocationDiscoveryExecutionAuditJobError
        ? error.code
        : "PACKAGE_ALLOCATION_DISCOVERY_EXECUTION_AUDIT_FAILED";
    process.stderr.write(JSON.stringify({ status: "failed", errorCode }) + "\n");
    process.exitCode = 1;
  });
}

export { PackageAllocationDiscoveryExecutionAuditRepositoryError };
