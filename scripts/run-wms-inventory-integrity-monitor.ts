import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  parseFlags as parseAuditFlags,
  runAuditWithClient,
} from "./audit-wms-inventory-integrity";
import { buildIntegrityAuditRegistryInput } from "../server/modules/inventory/integrity/integrity-audit-run.domain";
import { deliverPendingIntegrityAlerts } from "../server/modules/inventory/integrity/integrity-alert-delivery.service";
import { runInventoryIntegrityMonitorJob } from "../server/modules/inventory/integrity/integrity-monitor.job";
import { previewIntegrityAuditRegistry } from "../server/modules/inventory/integrity/integrity-registry.repository";
import {
  assertIntegrityAuditRoleIsReadOnly,
  recordIntegrityMonitorFailure,
} from "../server/modules/inventory/integrity/integrity-monitor.repository";

const MONITOR_LOCK_NAME = "wms_inventory_integrity_continuous_monitor";

interface MonitorFlags {
  help: boolean;
  execute: boolean;
  statementTimeoutMs: number;
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/run-wms-inventory-integrity-monitor.ts --dry-run",
    "  npx tsx scripts/run-wms-inventory-integrity-monitor.ts --execute",
    "",
    "Required environment:",
    "  WMS_INTEGRITY_AUDIT_DATABASE_URL     Read-only database credential.",
    "  WMS_INTEGRITY_ALERT_WEBHOOK_URL      Discord-compatible alert webhook.",
    "",
    "Registry writes use WMS_INTEGRITY_REGISTRY_DATABASE_URL when set, otherwise the app database URL.",
  ].join("\n");
}

export function parseMonitorFlags(argv: string[]): MonitorFlags {
  const allowedBare = new Set(["--help", "-h", "--dry-run", "--execute"]);
  for (const arg of argv) {
    if (allowedBare.has(arg)) continue;
    if (arg.startsWith("--statement-timeout-ms=")) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }
  const timeoutArg = argv.find((arg) => arg.startsWith("--statement-timeout-ms="));
  const statementTimeoutMs = timeoutArg == null
    ? 120_000
    : Number(timeoutArg.slice("--statement-timeout-ms=".length));
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 1_000 || statementTimeoutMs > 900_000) {
    throw new Error("--statement-timeout-ms must be an integer between 1000 and 900000");
  }
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    execute: argv.includes("--execute"),
    statementTimeoutMs,
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function registryConnectionString(): string {
  const value = process.env.WMS_INTEGRITY_REGISTRY_DATABASE_URL
    || process.env.DATABASE_URL;
  if (!value) throw new Error("WMS_INTEGRITY_REGISTRY_DATABASE_URL or the app database URL is required");
  return value;
}

function sourceVersion(): string | null {
  return process.env.HEROKU_SLUG_COMMIT
    ?? process.env.SOURCE_VERSION
    ?? process.env.GIT_COMMIT
    ?? null;
}

function createPool(connectionString: string, applicationName: string): Pool {
  return new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
    max: 1,
    application_name: applicationName,
  });
}

export async function main(): Promise<void> {
  const flags = parseMonitorFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const auditPool = createPool(
    requiredEnvironment("WMS_INTEGRITY_AUDIT_DATABASE_URL"),
    "wms-integrity-continuous-audit",
  );
  const registryPool = createPool(
    registryConnectionString(),
    "wms-integrity-continuous-registry",
  );
  const webhookUrl = flags.execute
    ? process.env.WMS_INTEGRITY_ALERT_WEBHOOK_URL
      || process.env.OMS_OPS_ALERT_WEBHOOK_URL
      || process.env.DISCORD_WEBHOOK_URL
      || null
    : null;
  if (flags.execute && !webhookUrl) {
    throw new Error(
      "WMS_INTEGRITY_ALERT_WEBHOOK_URL, OMS_OPS_ALERT_WEBHOOK_URL, or DISCORD_WEBHOOK_URL is required",
    );
  }
  let auditClient: PoolClient | null = null;
  let registryClient: PoolClient | null = null;
  let lockAcquired = false;
  try {
    auditClient = await auditPool.connect();
    registryClient = await registryPool.connect();
    const lockResult = await registryClient.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [MONITOR_LOCK_NAME],
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) {
      console.log("[WMS inventory integrity monitor] another monitor owns the advisory lock; skipping");
      return;
    }

    if (!flags.execute) {
      const auditDatabaseUser = await assertIntegrityAuditRoleIsReadOnly(auditClient);
      const startedAt = new Date().toISOString();
      const audit = await runAuditWithClient(auditClient, parseAuditFlags([
        "--limit=all",
        `--statement-timeout-ms=${flags.statementTimeoutMs}`,
      ]));
      const input = buildIntegrityAuditRegistryInput({
        runId: randomUUID(),
        scope: "continuous",
        sourceVersion: sourceVersion(),
        startedAt,
        completedAt: new Date().toISOString(),
        audit,
      });
      const lifecycle = await previewIntegrityAuditRegistry(registryClient, input);
      console.log(JSON.stringify({
        mode: "dry-run",
        auditDatabaseUser,
        runId: input.runId,
        snapshotAt: input.snapshotAt,
        blockers: input.blockerCount,
        warnings: input.warningCount,
        lifecycle,
      }, null, 2));
      return;
    }

    const result = await runInventoryIntegrityMonitorJob({
      auditClient,
      registryClient,
      statementTimeoutMs: flags.statementTimeoutMs,
      sourceVersion: sourceVersion(),
      clock: () => new Date(),
      idGenerator: randomUUID,
    });
    const delivery = await deliverPendingIntegrityAlerts({
      client: registryClient,
      webhookUrl: webhookUrl!,
      workerId: `wms-integrity-monitor:${process.pid}`,
      clock: () => new Date(),
    });
    console.log(JSON.stringify({ mode: "execute", ...result, alertDelivery: delivery }, null, 2));
    if (delivery.failed > 0) {
      const error = new Error(`WMS inventory integrity alert delivery failed for ${delivery.failed} alert(s)`);
      await recordIntegrityMonitorFailure(registryClient, {
        code: "ALERT_DELIVERY_FAILED",
        error,
        occurredAt: new Date(),
      });
      throw error;
    }
  } finally {
    if (lockAcquired && registryClient) {
      await registryClient.query("SELECT pg_advisory_unlock(hashtext($1))", [MONITOR_LOCK_NAME])
        .catch((error) => console.error("[WMS inventory integrity monitor] advisory unlock failed", error));
    }
    auditClient?.release();
    registryClient?.release();
    await Promise.allSettled([auditPool.end(), registryPool.end()]);
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[WMS inventory integrity monitor] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
