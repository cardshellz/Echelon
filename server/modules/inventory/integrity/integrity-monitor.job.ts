import type { PoolClient } from "pg";
import {
  parseFlags as parseAuditFlags,
  runAuditWithClient,
} from "../../../../scripts/audit-wms-inventory-integrity";
import { buildIntegrityAuditRegistryInput } from "./integrity-audit-run.domain";
import {
  persistIntegrityAuditRegistry,
  type IntegrityLifecycleSummary,
} from "./integrity-registry.repository";
import {
  assertIntegrityAuditRoleIsReadOnly,
  recordIntegrityMonitorFailure,
} from "./integrity-monitor.repository";

type QueryClient = Pick<PoolClient, "query">;

export interface IntegrityMonitorJobResult {
  runId: string;
  snapshotAt: string;
  auditDatabaseUser: string;
  blockerCount: number;
  warningCount: number;
  lifecycle: IntegrityLifecycleSummary;
}

export interface IntegrityMonitorJobDependencies {
  assertAuditRoleIsReadOnly: typeof assertIntegrityAuditRoleIsReadOnly;
  runAudit: typeof runAuditWithClient;
  persistRegistry: typeof persistIntegrityAuditRegistry;
  recordFailure: typeof recordIntegrityMonitorFailure;
}

const defaultDependencies: IntegrityMonitorJobDependencies = {
  assertAuditRoleIsReadOnly: assertIntegrityAuditRoleIsReadOnly,
  runAudit: runAuditWithClient,
  persistRegistry: persistIntegrityAuditRegistry,
  recordFailure: recordIntegrityMonitorFailure,
};

export async function runInventoryIntegrityMonitorJob(input: {
  auditClient: QueryClient;
  registryClient: QueryClient;
  statementTimeoutMs: number;
  sourceVersion: string | null;
  clock: () => Date;
  idGenerator: () => string;
}, dependencies: IntegrityMonitorJobDependencies = defaultDependencies): Promise<IntegrityMonitorJobResult> {
  let auditDatabaseUser: string;
  try {
    auditDatabaseUser = await dependencies.assertAuditRoleIsReadOnly(input.auditClient);
  } catch (error) {
    await dependencies.recordFailure(input.registryClient, {
      code: "AUDIT_ROLE_NOT_READ_ONLY",
      error,
      occurredAt: input.clock(),
    }).catch(() => undefined);
    throw error;
  }

  const runId = input.idGenerator();
  const startedAt = input.clock().toISOString();
  try {
    const flags = parseAuditFlags([
      "--limit=all",
      `--statement-timeout-ms=${input.statementTimeoutMs}`,
    ]);
    const audit = await dependencies.runAudit(input.auditClient, flags);
    const completedAt = input.clock().toISOString();
    const registryInput = buildIntegrityAuditRegistryInput({
      runId,
      scope: "continuous",
      sourceVersion: input.sourceVersion,
      startedAt,
      completedAt,
      audit,
    });
    const lifecycle = await dependencies.persistRegistry(input.registryClient, registryInput);
    return {
      runId,
      snapshotAt: registryInput.snapshotAt,
      auditDatabaseUser,
      blockerCount: registryInput.blockerCount,
      warningCount: registryInput.warningCount,
      lifecycle,
    };
  } catch (error) {
    await dependencies.recordFailure(input.registryClient, {
      code: "MONITOR_RUN_FAILED",
      error,
      occurredAt: input.clock(),
    }).catch(() => undefined);
    throw error;
  }
}
