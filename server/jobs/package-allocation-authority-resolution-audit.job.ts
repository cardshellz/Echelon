import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient, PoolConfig } from "pg";
import { z } from "zod";

import {
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_RELATIONSHIP_TYPES,
  type PackageAllocationAuthorityDiscoveryRelationshipType,
} from "../modules/shipping/package-allocation-authority-discovery.query";
import {
  auditPackageAllocationAuthorityDiscoveryPlan,
  type NormalizedPackageAllocationDiscoveryPlanAuditOptions,
  type PackageAllocationDiscoveryPlanAuditReport,
} from "../modules/shipping/package-allocation-authority-discovery-plan-audit.repository";
import {
  PackageAllocationAuthorityResolutionPreviewService,
  PackageAllocationAuthorityResolutionPreviewServiceError,
  type PackageAllocationAuthorityResolutionDiscoveryPreviewResultV1,
} from "../modules/shipping/package-allocation-authority-resolution.service";
import {
  PackageAllocationLedgerRepositoryError,
  PgPackageAllocationLedgerRepository,
} from "../modules/shipping/package-allocation-ledger.repository";
import {
  packageAllocationDiscoveryPlanAuditPoolConfig,
  parsePackageAllocationDiscoveryPlanAuditCliOptions,
  runPackageAllocationDiscoveryAuditJob,
  type PackageAllocationDiscoveryAuditJobTimingEvidence,
  type PackageAllocationDiscoveryPlanAuditPoolFactory,
  type PackageAllocationDiscoveryPlanAuditRuntimeDependencies,
} from "./package-allocation-authority-discovery-plan-audit.job";

const APPLICATION_NAME = "package-allocation-authority-resolution-audit";
const groupKeySchema = z.string().uuid().transform((value) => value.toLowerCase());

export interface PackageAllocationAuthorityResolutionAuditReport {
  readonly mode: "read_only_resolution_preview";
  readonly queryExecuted: true;
  readonly sourceCount: 1;
  readonly readOnlyRoleVerified: true;
  readonly databaseTemporaryPrivilege: boolean;
  readonly expectedIndexCount: number;
  readonly costSelectedExpectedIndexCount: number;
  readonly plannedSequentialScanCount: number;
  readonly selectionAuthority: "database_relationship_closure";
  readonly selectionCompleteness: "unproven_outside_persisted_relationships";
  readonly groupState: "absent" | "empty";
  readonly selectedPackageCount: number;
  readonly relationshipPathPackageCounts: Readonly<Record<
    PackageAllocationAuthorityDiscoveryRelationshipType,
    number
  >>;
  readonly projectedPackageCount: number;
  readonly rejectedPackageCount: number;
  readonly readinessReviewCodes: readonly string[];
  readonly resolutionOutcome: "proposed" | "review" | "unchanged" | "unavailable";
  readonly resolutionReviewCodes: readonly string[];
  readonly allocationCount: number;
  readonly desiredEffectIntentCount: number;
  readonly executableEffectIntentCount: 0;
}

export interface PackageAllocationAuthorityResolutionAuditJobResult
  extends PackageAllocationAuthorityResolutionAuditReport,
    PackageAllocationDiscoveryAuditJobTimingEvidence {}

export type PackageAllocationAuthorityResolutionAuditJobErrorCode =
  | "PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_CLEANUP_FAILED"
  | "PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_EXECUTION_AND_CLEANUP_FAILED";

export class PackageAllocationAuthorityResolutionAuditJobError extends Error {
  readonly code: PackageAllocationAuthorityResolutionAuditJobErrorCode;

  constructor(
    code: PackageAllocationAuthorityResolutionAuditJobErrorCode,
    message: string,
    failures: readonly unknown[],
  ) {
    super(message, { cause: new AggregateError([...failures], message) });
    this.name = "PackageAllocationAuthorityResolutionAuditJobError";
    this.code = code;
  }
}

export interface PackageAllocationAuthorityResolutionAuditCliOptions {
  readonly help: boolean;
  readonly sourceWmsShipmentItemId: number | null;
  readonly groupKey: string | null;
}

export function parsePackageAllocationAuthorityResolutionAuditCliOptions(
  argv: readonly string[],
): PackageAllocationAuthorityResolutionAuditCliOptions {
  const groupArguments = argv.filter((argument) => argument.startsWith("--group-key="));
  if (groupArguments.length > 1) throw new Error("Duplicate flag: --group-key");
  const remaining = argv.filter((argument) => !argument.startsWith("--group-key="));
  const sourceOptions = parsePackageAllocationDiscoveryPlanAuditCliOptions(remaining);
  const rawGroupKey = groupArguments[0]?.slice("--group-key=".length) ?? null;
  if (sourceOptions.help) {
    return Object.freeze({
      ...sourceOptions,
      groupKey: rawGroupKey === null ? null : groupKeySchema.parse(rawGroupKey),
    });
  }
  if (rawGroupKey === null) throw new Error("--group-key is required");
  const parsedGroupKey = groupKeySchema.safeParse(rawGroupKey);
  if (!parsedGroupKey.success) throw new Error("--group-key must be a UUID");
  return Object.freeze({ ...sourceOptions, groupKey: parsedGroupKey.data });
}

export function assertPackageAllocationAuthorityResolutionAuditEnabled(
  environment: NodeJS.ProcessEnv,
): void {
  if (environment.PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_ENABLED !== "true") {
    throw new Error(
      "PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_ENABLED must be exactly 'true'",
    );
  }
}

export function packageAllocationAuthorityResolutionAuditPoolConfig(
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

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function relationshipPathPackageCounts(
  preview: PackageAllocationAuthorityResolutionDiscoveryPreviewResultV1,
): Readonly<Record<PackageAllocationAuthorityDiscoveryRelationshipType, number>> {
  const counts = Object.fromEntries(
    PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_RELATIONSHIP_TYPES.map(
      (relationshipType) => [relationshipType, 0],
    ),
  ) as Record<PackageAllocationAuthorityDiscoveryRelationshipType, number>;
  for (const pkg of preview.relationshipSelectionEvidence.packages) {
    for (const relationshipType of pkg.relationshipTypes) {
      counts[relationshipType] += 1;
    }
  }
  return Object.freeze(counts);
}

export function summarizePackageAllocationAuthorityResolutionAudit(
  plan: PackageAllocationDiscoveryPlanAuditReport,
  preview: PackageAllocationAuthorityResolutionDiscoveryPreviewResultV1,
): PackageAllocationAuthorityResolutionAuditReport {
  const intents = preview.resolution?.plannerResult.state.desiredEffectIntents ?? [];
  const executableEffectIntentCount = intents.filter((intent) => intent.executable).length;
  if (executableEffectIntentCount !== 0) {
    throw new Error("Authority resolution audit observed an executable effect intent");
  }
  const projectedPackageCount = preview.readiness.packageAssessments.filter(
    (assessment) => assessment.lifecycleStatus === "projected",
  ).length;
  return Object.freeze({
    mode: "read_only_resolution_preview",
    queryExecuted: true,
    sourceCount: 1,
    readOnlyRoleVerified: plan.readOnlyRoleVerified,
    databaseTemporaryPrivilege: plan.databaseTemporaryPrivilege,
    expectedIndexCount: plan.expectedIndexCount,
    costSelectedExpectedIndexCount: plan.costSelectedExpectedIndexCount,
    plannedSequentialScanCount: plan.sequentialScanRelations.length,
    selectionAuthority: preview.selectionAuthority,
    selectionCompleteness: preview.selectionCompleteness,
    groupState: preview.groupState,
    selectedPackageCount: preview.selectedShippingProviderLabelIds.length,
    relationshipPathPackageCounts: relationshipPathPackageCounts(preview),
    projectedPackageCount,
    rejectedPackageCount: preview.readiness.packageAssessments.length - projectedPackageCount,
    readinessReviewCodes: sortedUnique(
      preview.readiness.reviews.map((review) => review.code),
    ),
    resolutionOutcome: preview.resolution?.outcome ?? "unavailable",
    resolutionReviewCodes: sortedUnique(
      preview.resolution?.reviews.map((review) => review.code) ?? [],
    ),
    allocationCount: preview.resolution?.plannerResult.state.allocations.length ?? 0,
    desiredEffectIntentCount: intents.length,
    executableEffectIntentCount: 0,
  });
}

export async function auditPackageAllocationAuthorityResolutionPreview(
  client: Pick<PoolClient, "query" | "release">,
  repositoryOptions: NormalizedPackageAllocationDiscoveryPlanAuditOptions,
  groupKey: string,
  auditPlan: typeof auditPackageAllocationAuthorityDiscoveryPlan =
    auditPackageAllocationAuthorityDiscoveryPlan,
): Promise<PackageAllocationAuthorityResolutionAuditReport> {
  const plan = await auditPlan(client, repositoryOptions);
  const scopedPool = {
    connect: async () => ({
      query: client.query.bind(client),
      release: () => undefined,
    } as unknown as PoolClient),
  } as Pick<Pool, "connect">;
  const preview = await new PackageAllocationAuthorityResolutionPreviewService(
    new PgPackageAllocationLedgerRepository(scopedPool, {
      statementTimeoutMs: repositoryOptions.statementTimeoutMs,
      lockTimeoutMs: repositoryOptions.lockTimeoutMs,
      idleTransactionTimeoutMs: repositoryOptions.idleInTransactionTimeoutMs,
    }),
  ).previewDiscovered({
    contractVersion: 1,
    authorityMode: "shadow_only",
    previewMode: "bootstrap_relationship_discovery",
    groupKey,
    sourceWmsShipmentItemIds: [repositoryOptions.sourceWmsShipmentItemId],
  });
  return summarizePackageAllocationAuthorityResolutionAudit(plan, preview);
}

export async function runPackageAllocationAuthorityResolutionAuditJob(options: {
  readonly sourceWmsShipmentItemId: number;
  readonly groupKey: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly poolFactory?: PackageAllocationDiscoveryPlanAuditPoolFactory;
  readonly runtime?: PackageAllocationDiscoveryPlanAuditRuntimeDependencies;
  readonly auditResolution?: typeof auditPackageAllocationAuthorityResolutionPreview;
}): Promise<PackageAllocationAuthorityResolutionAuditJobResult> {
  const parsedGroupKey = groupKeySchema.safeParse(options.groupKey);
  if (!parsedGroupKey.success) throw new Error("groupKey must be a UUID");
  const auditResolution = options.auditResolution
    ?? auditPackageAllocationAuthorityResolutionPreview;
  return runPackageAllocationDiscoveryAuditJob({
    sourceWmsShipmentItemId: options.sourceWmsShipmentItemId,
    environment: options.environment,
    poolFactory: options.poolFactory,
    runtime: options.runtime,
    assertEnabled: assertPackageAllocationAuthorityResolutionAuditEnabled,
    applicationName: APPLICATION_NAME,
    audit: (client, repositoryOptions) => auditResolution(
      client,
      repositoryOptions,
      parsedGroupKey.data,
    ),
    auditLabel: "package-allocation authority resolution audit",
    createCleanupError: (kind, failures) => (
      new PackageAllocationAuthorityResolutionAuditJobError(
        kind === "cleanup"
          ? "PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_CLEANUP_FAILED"
          : "PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_EXECUTION_AND_CLEANUP_FAILED",
        kind === "cleanup"
          ? "Package-allocation authority resolution audit cleanup failed"
          : "Package-allocation authority resolution audit execution and cleanup both failed",
        failures,
      )
    ),
  });
}

function usage(): string {
  return [
    "Usage:",
    "  npm run wms:audit-package-allocation-resolution -- --source-id=N --group-key=UUID",
    "",
    "Runs a cost-plan preflight and one full relationship-discovery resolution",
    "preview under the dedicated read-only audit role. Result JSON omits identifiers.",
  ].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parsePackageAllocationAuthorityResolutionAuditCliOptions(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runPackageAllocationAuthorityResolutionAuditJob({
    sourceWmsShipmentItemId: options.sourceWmsShipmentItemId!,
    groupKey: options.groupKey!,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function isDirectExecution(metaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  return path.resolve(argvEntry) === fileURLToPath(metaUrl);
}

function classifiedErrorCode(error: unknown): string {
  if (error instanceof PackageAllocationAuthorityResolutionPreviewServiceError) {
    return error.code;
  }
  if (error instanceof PackageAllocationLedgerRepositoryError) return error.code;
  if (error instanceof PackageAllocationAuthorityResolutionAuditJobError) return error.code;
  return "PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_FAILED";
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(JSON.stringify({
      status: "failed",
      errorCode: classifiedErrorCode(error),
    }) + "\n");
    process.exitCode = 1;
  });
}
