import { buildObservedIntegrityFindings } from "../../../../scripts/audit-wms-inventory-integrity";
import type { WmsAuditResult } from "../../../../scripts/audit-wms-inventory-integrity";
import type { IntegrityAuditRegistryInput } from "./integrity-registry.repository";

export function buildIntegrityAuditRegistryInput(params: {
  runId: string;
  scope: "all" | "continuous" | "targeted";
  sourceVersion: string | null;
  startedAt: string;
  completedAt: string;
  audit: WmsAuditResult;
}): IntegrityAuditRegistryInput {
  return {
    runId: params.runId,
    scope: params.scope,
    sourceVersion: params.sourceVersion,
    startedAt: params.startedAt,
    snapshotAt: params.audit.snapshot.snapshotAt,
    completedAt: params.completedAt,
    databaseName: params.audit.snapshot.databaseName,
    databaseUser: params.audit.snapshot.databaseUser,
    serverVersion: params.audit.snapshot.serverVersion,
    recoveryMode: params.audit.snapshot.recoveryMode,
    blockerCount: params.audit.summary.blockers,
    warningCount: params.audit.summary.warnings,
    checks: params.audit.results.map((result) => ({
      checkId: result.check.id,
      category: result.check.category,
      severity: result.check.severity,
      findingCount: result.count,
      elapsedMs: result.elapsedMs,
    })),
    findings: buildObservedIntegrityFindings(params.audit),
  };
}
